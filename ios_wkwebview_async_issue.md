# iOS WKWebView Async Execute Issue

## Problem Summary

When running wdi5 tests on iOS Cordova apps via Appium XCUITest, JavaScript `execute()` calls that use `async` functions return an empty object `{}` instead of the actual result.

```javascript
// Works on Android and Desktop browsers:
const result = await browser.execute(async () => {
    return "hello";
});
// result = "hello" ✓

// On iOS WKWebView:
const result = await browser.execute(async () => {
    return "hello";
});
// result = {} ✗ (empty object!)
```

This breaks wdi5's control interaction because wdi5 internally uses async functions with `sap.ui.require()` callbacks wrapped in Promises.

---

## Verified Behavior (Tested February 2026)

| Pattern | iOS WKWebView | Android/Desktop |
|---------|---------------|-----------------|
| `execute(() => 42)` | ✓ Works | ✓ Works |
| `execute(() => "string")` | ✓ Works | ✓ Works |
| `execute(async () => "result")` | ✗ Returns `{}` | ✓ Works |
| `execute(async () => { await Promise.resolve(); return "result"; })` | ✗ Returns `{}` | ✓ Works |
| `executeAsync((done) => done("result"))` | ✓ Works | ✓ Works |
| `executeAsync((done) => setTimeout(() => done("result"), 100))` | ✓ Works* | ✓ Works |

*Requires script timeout to be set (defaults to 0ms on iOS!)

---

## Root Cause Analysis

### The W3C WebDriver Specification Gap

The [W3C WebDriver specification](https://www.w3.org/TR/webdriver/) for "Execute Script" does not natively handle:
- `async` functions
- Promise return values

When you call `execute(async () => "result")`, the browser:
1. Executes the async function
2. The function returns a Promise object
3. WebDriver serializes that Promise as `{}` (empty object)
4. WebDriver does NOT wait for the Promise to resolve

This is a known limitation discussed in [W3C WebDriver Issue #1436](https://github.com/w3c/webdriver/issues/1436): "Supporting `await` in Execute Script".

### Safari vs. iOS WebViews: Different Code Paths

**Safari WebDriver (standalone browser automation):**
- WebKit fixed this in January 2020: [WebKit Bug #204151](https://bugs.webkit.org/show_bug.cgi?id=204151)
- The fix wraps user scripts in `async function` automatically
- Uses `Promise.race()` for timeout handling
- This is why testing on Safari desktop/mobile browser works

**iOS WebViews via Appium (hybrid apps like Cordova):**
- Uses `appium-remote-debugger` package
- Connects via WebKit Remote Debugger Protocol (different from Safari WebDriver)
- Does NOT have the async handling fix
- Uses Selenium Atoms for script execution
- This is why testing Cordova apps on iOS is broken

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Test Runner (Node.js)                        │
│                    WebdriverIO + wdi5 Service                       │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         Appium Server                               │
└──────────────┬────────────────────────────────────┬─────────────────┘
               │                                    │
    ┌──────────▼──────────┐              ┌──────────▼──────────┐
    │  Android (UIAutomator2)           │  iOS (XCUITest Driver) │
    │                     │              │                      │
    │  ChromeDriver       │              │  appium-remote-      │
    │  (WebView)          │              │  debugger (WebView)  │
    │                     │              │                      │
    │  ✓ Async works!     │              │  ✗ Async broken!     │
    └─────────────────────┘              └──────────────────────┘
```

---

## Why wdi5 Breaks on iOS

wdi5 uses patterns like this internally:

```javascript
// wdi5's _asControl implementation (simplified)
await browser.execute(async (selector) => {
    return new Promise((resolve) => {
        sap.ui.require(["sap/ui/test/RecordReplay"], (RecordReplay) => {
            const control = RecordReplay.findControlBySelector(selector);
            resolve(control);
        });
    });
}, selector);
```

On iOS:
1. `execute()` receives an async function
2. The function returns a Promise
3. iOS WKWebView returns `{}` immediately
4. The Promise never gets awaited
5. wdi5 receives `{}` instead of the control
6. All subsequent operations fail

---

## Implemented Solution (Working!)

### Central `browser.execute()` Override for iOS

**Approach:** Detect async functions passed to `browser.execute()` and transparently convert them to `executeAsync()` with callback pattern. This fix is applied early in the service initialization, before any wdi5 code runs.

**Implementation in `wdi5-cordova/src/service.ts`:**

```typescript
private overrideExecuteForIOS(browserInstance: WebdriverIO.Browser): void {
    // Use WebdriverIO's overwriteCommand to safely override execute
    browserInstance.overwriteCommand("execute", async function(
        this: WebdriverIO.Browser,
        origExecuteFn: Function,
        script: string | Function,
        ...args: any[]
    ) {
        // If it's a string script, use original execute
        if (typeof script === "string") {
            return origExecuteFn(script, ...args)
        }
        
        // Check if the function is async (constructor name is "AsyncFunction")
        const isAsyncFunction = script.constructor.name === "AsyncFunction"
        
        if (!isAsyncFunction) {
            // Sync function - use original execute
            return origExecuteFn(script, ...args)
        }
        
        // ASYNC FUNCTION DETECTED - convert to executeAsync pattern
        const fnSource = script.toString()
        
        // Wrapper that receives: (asyncFnSource, ...userArgs, done)
        const wrapperFn = function(asyncFnSource: string, ...rest: any[]) {
            const done = rest.pop() as (result: any) => void
            const userArgs = rest
            
            try {
                // Reconstruct and call the async function in browser context
                const asyncFn = eval("(" + asyncFnSource + ")")
                const resultPromise = asyncFn.apply(null, userArgs)
                
                Promise.resolve(resultPromise)
                    .then((result) => done(result))
                    .catch((error) => done({ 
                        __wdi5CordovaError: true, 
                        message: error.message || String(error) 
                    }))
            } catch (e) {
                done({ 
                    __wdi5CordovaError: true, 
                    message: "Failed to execute: " + e.message 
                })
            }
        }
        
        const result = await this.executeAsync(wrapperFn, fnSource, ...args)
        
        // Check if result is an error
        if (result && typeof result === "object" && result.__wdi5CordovaError) {
            throw new Error(`iOS execute() async error: ${result.message}`)
        }
        
        return result
    })
}
```

**Key Components:**

1. **Early Application:** The override is applied in the `before()` hook BEFORE wdi5 initializes
2. **Script Timeout:** Set to 60 seconds (iOS defaults to 0ms!)
3. **Function Detection:** Uses `constructor.name === "AsyncFunction"` to detect async functions
4. **Source Serialization:** Converts function to string, passes to browser, reconstructs with `eval()`
5. **Promise Handling:** Wraps in `Promise.resolve()` to handle both sync and async returns
6. **Error Propagation:** Errors are serialized and re-thrown on the Node.js side

**Status:** ✅ **WORKING** - Full wdi5 test suite passes on iOS (February 2026)

### Additional Fixes Required

#### 1. Script Timeout Configuration

iOS WKWebView has a default script timeout of **0 milliseconds** for `executeAsync`. This must be set before any async operations:

```javascript
await browser.setTimeout({ script: 60000 }); // 60 seconds
```

#### 2. Context ID Handling

Appium's `getContexts()` now returns objects instead of strings. Added helper to handle both formats:

```typescript
function getContextId(ctx: unknown): string {
    if (typeof ctx === "string") return ctx
    if (ctx && typeof ctx === "object" && "id" in ctx) {
        return (ctx as { id: string }).id
    }
    return String(ctx)
}
```

#### 3. Optional `getUI5Version()` Override

For extra reliability, `getUI5Version()` is overridden to use the simpler `sap.ui.version` property:

```javascript
browserInstance.overwriteCommand("getUI5Version", async function() {
    return this.executeAsync((done) => {
        done(window.sap?.ui?.version || "");
    });
});
```

---

## Previous Workaround Attempts (Historical)

Before finding the working solution above, several approaches were tried:

| Approach | Description | Outcome |
|----------|-------------|---------|
| Pre-inject wdi5 bridge | Inject before wdi5 loads | Didn't help - wdi5 re-injects |
| Override individual commands | Override `_asControl`, etc. | Too many commands to override |
| Patch wdi5 source | Modify wdi5 package | Not maintainable |
| Use `mobile: executeScript` | Appium mobile command | Not supported for async |

The breakthrough was realizing that overriding `browser.execute()` itself at the WebdriverIO level provides a **central fix** that makes ALL async operations work, including wdi5's internal calls.

---

## Related Issues and References

### WebDriver Specification
- [W3C WebDriver Issue #1436](https://github.com/w3c/webdriver/issues/1436) - "Supporting `await` in Execute Script"

### WebKit
- [WebKit Bug #204151](https://bugs.webkit.org/show_bug.cgi?id=204151) - "Automation: evaluateJavaScriptFunction should use Promises" (FIXED for Safari WebDriver, January 2020)
- [WebKit Changeset 254329](https://trac.webkit.org/changeset/254329/webkit) - The actual fix implementation

### WebdriverIO
- [WebdriverIO Issue #1708](https://github.com/webdriverio/webdriverio/issues/1708) - "executeAsync does not work in Safari"

### Appium
- [appium-remote-debugger](https://github.com/appium/appium-remote-debugger) - The package Appium uses for iOS WebView automation

### Apple Documentation
- [WKWebView.evaluateJavaScript](https://developer.apple.com/documentation/webkit/wkwebview/evaluatejavascript(_:completionhandler:)) - Does not natively support Promise resolution
- [WKWebView.callAsyncJavaScript](https://developer.apple.com/documentation/webkit/wkwebview/callasyncjavascript(_:arguments:in:in:completionhandler:)) - iOS 14+ alternative with better async support

---

## Potential Long-Term Solutions

### 1. Fix in Appium XCUITest Driver
The proper fix would be in `appium-remote-debugger` to handle async functions similarly to how WebKit fixed Safari WebDriver:
- Detect async function scripts
- Wrap in proper Promise handling
- Use `callAsyncJavaScript` API on iOS 14+

### 2. Fix in wdi5
wdi5 could detect iOS and use `executeAsync` with callbacks instead of `execute` with async functions:
```javascript
// Instead of:
execute(async () => { ... })

// Use:
executeAsync((done) => {
    (async () => { ... })().then(done).catch(err => done({ error: err }));
})
```

### 3. Use Native iOS APIs Directly
For iOS 14+, use `mobile: executeScript` with proper async handling if Appium exposes it.

---

## Current Status (February 2026)

- **Problem:** ✅ Identified and documented
- **Root Cause:** ✅ Understood (WebDriver spec gap + Appium iOS implementation)
- **Workaround:** ✅ **WORKING** - Implemented in `wdi5-cordova` service
- **Testing:** ✅ Full wdi5 test suite passes on iOS via BrowserStack
- **Next Steps:** 
  - Consider contributing proper fix to `appium-remote-debugger`
  - Consider contributing iOS-specific detection to wdi5
  - Remove workaround once upstream is fixed

---

## Testing the Issue

To reproduce the issue:

```javascript
// test/e2e/ios-async-test.spec.ts
describe("iOS Async Verification", () => {
    it("sync execute works", async () => {
        const result = await browser.execute(() => 42);
        expect(result).toBe(42); // ✓ PASS
    });

    it("async execute is broken", async () => {
        const result = await browser.execute(async () => "hello");
        console.log("Result:", result, typeof result);
        // On iOS: result = {}, typeof = "object"
        // Expected: result = "hello", typeof = "string"
        expect(result).toBe("hello"); // ✗ FAIL on iOS
    });

    it("executeAsync with callback works", async () => {
        const result = await browser.executeAsync((done) => {
            setTimeout(() => done("hello"), 100);
        });
        expect(result).toBe("hello"); // ✓ PASS (with proper script timeout)
    });
});
```

Run on iOS:
```bash
npm run test:bs:ios
```

---

## Contributing Upstream to appium-remote-debugger

### Goal

Fix the `browser.execute(async function)` issue at its source in Appium's iOS WebView automation layer, so all consumers (not just wdi5-cordova) benefit automatically.

### Repository Information

- **Repository:** https://github.com/appium/appium-remote-debugger
- **Language:** TypeScript
- **Build:** npm/TypeScript compilation
- **Test:** Mocha tests

### Key Files to Investigate

| File | Purpose | Relevance |
|------|---------|-----------|
| `lib/remote-debugger.ts` | Main debugger class | Entry point for script execution |
| `lib/mixins/execute.ts` | Execute script mixin | **Primary target** - handles `execute()` calls |
| `lib/mixins/` | Various mixins | Context switching, page navigation, etc. |
| `lib/webkit-rpc-client.ts` | WebKit Remote Debugger Protocol client | Low-level RPC to WebKit |
| `lib/protocol/` | Protocol definitions | Message formats for WebKit communication |
| `atoms/` | Selenium atoms (JS) | Browser-side script execution wrappers |

### The Execute Flow (Current Broken Behavior)

When `browser.execute(async () => "result")` is called on iOS:

```
1. WebdriverIO → Appium Server
2. Appium XCUITest Driver → appium-remote-debugger
3. remote-debugger/lib/mixins/execute.ts:
   - Receives the script (serialized function string)
   - Wraps with Selenium atoms
   - Sends via WebKit Remote Debugger Protocol
4. WebKit evaluates the script
5. Script returns a Promise object (not awaited!)
6. WebKit serializes Promise as {} 
7. {} is returned to Node.js test
```

### The Safari WebDriver Fix (Reference Implementation)

WebKit fixed this for Safari WebDriver in January 2020. The key changes were:

**File:** `WebKit/Source/WebKit/UIProcess/Automation/WebAutomationSession.cpp`
**Changeset:** [254329](https://trac.webkit.org/changeset/254329/webkit)

The fix:
1. Wraps user script in `async function`
2. Uses `await` on the script result
3. Uses `Promise.race()` with timeout for async script timeout

```javascript
// Conceptual fix (Safari WebDriver approach)
async function evaluateWithAsyncSupport(userScript, args, timeout) {
    const wrappedScript = `
        (async function() {
            return await (${userScript}).apply(null, arguments);
        })(...arguments)
    `;
    
    const result = await Promise.race([
        webkit.evaluateJavaScript(wrappedScript, args),
        new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Script timeout')), timeout)
        )
    ]);
    
    return result;
}
```

### Proposed Fix for appium-remote-debugger

#### Option A: Detect and Wrap Async Functions (Recommended)

Modify `lib/mixins/execute.ts` to detect async functions and wrap them:

```typescript
// In execute.ts or similar

async executeScript(script: string, args: unknown[]): Promise<unknown> {
    // Detect if script contains async function
    const isAsyncScript = this.isAsyncFunction(script);
    
    if (isAsyncScript) {
        // Wrap in Promise handling
        const wrappedScript = `
            (function() {
                var userFn = ${script};
                var args = arguments;
                return new Promise(function(resolve, reject) {
                    try {
                        Promise.resolve(userFn.apply(null, args))
                            .then(resolve)
                            .catch(reject);
                    } catch (e) {
                        reject(e);
                    }
                });
            })
        `;
        // Use executeAsyncScript internally with done callback
        return this.executeAsyncScriptInternal(wrappedScript, args);
    }
    
    // Original sync execution path
    return this.executeScriptSync(script, args);
}

private isAsyncFunction(script: string): boolean {
    // Check for async function patterns
    return /^\s*async\s+function/.test(script) || 
           /^\s*async\s*\(/.test(script) ||
           /^\s*async\s+\w+\s*=>/.test(script);
}
```

#### Option B: Use WKWebView.callAsyncJavaScript (iOS 14+)

Apple introduced `callAsyncJavaScript` in iOS 14 which natively supports Promise resolution:

```swift
// In the iOS native layer (XCUITest driver would need this)
webView.callAsyncJavaScript(script, arguments: args) { result in
    switch result {
    case .success(let value):
        // Value is already the resolved Promise result
        callback(value)
    case .failure(let error):
        callback(error)
    }
}
```

This would require changes in:
- `appium-xcuitest-driver` - to use the new API
- Or `appium-remote-debugger` - if it can access this API via WebKit protocol

### Minimal Reproduction Test for appium-remote-debugger

Create a test file to reproduce the issue:

```typescript
// test/async-execute.test.ts
describe('Async Execute Script', function() {
    let debugger: RemoteDebugger;
    
    before(async function() {
        // Setup debugger connection to iOS WebView
        debugger = new RemoteDebugger({ /* config */ });
        await debugger.connect();
    });
    
    it('should handle sync function', async function() {
        const result = await debugger.executeScript('function() { return 42; }', []);
        expect(result).to.equal(42);
    });
    
    it('should handle async function (CURRENTLY FAILS)', async function() {
        const result = await debugger.executeScript(
            'async function() { return "hello"; }', 
            []
        );
        // Current behavior: result = {}
        // Expected behavior: result = "hello"
        expect(result).to.equal("hello");
    });
    
    it('should handle async function with await', async function() {
        const result = await debugger.executeScript(
            'async function() { await Promise.resolve(); return "delayed"; }',
            []
        );
        expect(result).to.equal("delayed");
    });
});
```

### GitHub Issue Template

When opening an issue on appium-remote-debugger:

```markdown
## Title
Execute Script does not await async functions / Promises

## Description
When executing a script that is an `async function` or returns a Promise, the Promise is not awaited and an empty object `{}` is returned instead of the resolved value.

## Environment
- iOS version: 17.x
- appium-remote-debugger version: X.X.X
- Appium version: 2.x
- appium-xcuitest-driver version: X.X.X

## Steps to Reproduce
1. Connect to an iOS WKWebView
2. Execute: `await debugger.executeScript('async function() { return "hello"; }', [])`
3. Observe result is `{}` instead of `"hello"`

## Expected Behavior
The async function should be awaited and the resolved value returned.

## Actual Behavior
The Promise object is serialized as `{}` and returned immediately without awaiting.

## Root Cause Analysis
The script execution path does not detect async functions or handle Promise return values. Safari WebDriver fixed this in WebKit Bug #204151 (January 2020) by wrapping scripts in async functions and awaiting the result.

## Proposed Solution
1. Detect async function scripts by checking for `async` keyword
2. Wrap execution in Promise handling similar to Safari WebDriver fix
3. Alternatively, use `WKWebView.callAsyncJavaScript()` on iOS 14+

## References
- Safari WebDriver fix: https://bugs.webkit.org/show_bug.cgi?id=204151
- WebKit changeset: https://trac.webkit.org/changeset/254329/webkit
- W3C WebDriver spec discussion: https://github.com/w3c/webdriver/issues/1436
- Working workaround in wdi5-cordova: [link to this doc]
```

### Pull Request Approach

1. **Fork** appium-remote-debugger
2. **Create branch:** `fix/async-execute-script`
3. **Add test** that demonstrates the failing behavior
4. **Implement fix** in `lib/mixins/execute.ts` (or appropriate location)
5. **Ensure backward compatibility** - sync scripts should work exactly as before
6. **Update documentation** if needed
7. **Submit PR** with clear description referencing the WebKit fix

### Testing the Fix

Before submitting:
1. Run existing appium-remote-debugger tests
2. Test with a real iOS WebView:
   - Sync function: `() => 42` → `42`
   - Async function: `async () => "hello"` → `"hello"`
   - Async with await: `async () => { await delay(100); return "delayed"; }` → `"delayed"`
   - Error handling: `async () => { throw new Error("test"); }` → Error thrown

---

## Debugging Tips

### Enable Verbose Logging

In your test config:
```javascript
capabilities: {
    // ...
    'appium:showXcodeLog': true,
    'appium:webkitResponseTimeout': 30000,
}
```

### Inspect WebKit Messages

Set environment variable before running tests:
```bash
DEBUG=appium:remote-debugger* npm run test
```

### Manual WebKit Debugger Testing

You can test script execution directly using Safari's Web Inspector:
1. Enable Web Inspector on iOS device (Settings > Safari > Advanced)
2. Open Safari on Mac, go to Develop menu
3. Select your device/app
4. Use Console to test execute behavior

---

## Summary for New AI Sessions

**THE PROBLEM:**
- `browser.execute(async () => "result")` returns `{}` on iOS WKWebView via Appium
- Cause: Appium's appium-remote-debugger doesn't await Promises
- Safari WebDriver has this fix, but Appium's WebView path does not

**THE WORKAROUND (implemented in wdi5-cordova):**
- Override `browser.execute()` to detect async functions
- Convert them to `executeAsync()` with callback pattern
- Works transparently with wdi5 and all other code

**THE UPSTREAM FIX (goal):**
- Fix in appium-remote-debugger to handle async functions natively
- Either wrap in Promise handling (like Safari WebDriver)
- Or use iOS 14+ `callAsyncJavaScript` API

**KEY RESOURCES:**
- This document: full technical analysis
- WebKit Bug #204151: Reference implementation
- appium-remote-debugger: Target repository
- wdi5-cordova service.ts: Working workaround code

---

## Contributors

- Investigation and documentation: wdi5-cordova team
- Original WebKit Safari fix: Carlos Garcia Campos (WebKit, 2020)

---

## Minimal Reproduction Files (Added to this Repository)

The following files have been added to this repository to enable minimal reproduction and filing an upstream issue:

### Test Files

| File | Description |
|------|-------------|
| `test/functional/async-execute-issue-specs.ts` | Functional E2E tests demonstrating the issue on iOS Simulator |
| `test/unit/mixins/async-execute-issue-specs.ts` | Unit tests demonstrating the bug at the RPC level |

### Documentation Files

| File | Description |
|------|-------------|
| `ISSUE_ASYNC_EXECUTE.md` | Ready-to-file GitHub issue template for appium/appium repository |
| `PROPOSED_FIX.md` | Detailed proposed fix with complete modified `execute.ts` |
| `ios_wkwebview_async_issue.md` | This file - comprehensive technical analysis |

### Running the Tests

```bash
# Unit tests (no device required)
npm test -- --grep "Async Execute Issue"

# Functional tests (requires iOS Simulator)
npm run e2e-test -- --grep "Async Execute Issue"
```

### Filing the Issue

1. Go to https://github.com/appium/appium/issues/new
2. Copy the content from `ISSUE_ASYNC_EXECUTE.md`
3. Paste and submit

### Contributing the Fix

1. Fork `appium-remote-debugger`
2. Create branch: `git checkout -b fix/async-execute-script`
3. Apply the changes from `PROPOSED_FIX.md` to `lib/mixins/execute.ts`
4. Run tests: `npm test && npm run e2e-test`
5. Submit PR with reference to the issue
