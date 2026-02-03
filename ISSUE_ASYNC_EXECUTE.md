# GitHub Issue: Execute Script does not await async functions / Promises

> **File this issue at:** https://github.com/appium/appium/issues/new
> 
> This document contains all the information needed to file the issue.

---

## Title

**[Bug] appium-remote-debugger: Execute Script does not await async functions / Promises on iOS WKWebView**

---

## Description

When executing a script that is an `async` function or returns a Promise via `browser.execute()` on iOS WKWebView (Cordova/hybrid apps), the Promise is **not awaited** and an empty object `{}` is returned instead of the resolved value.

This affects all users of Appium XCUITest driver who need to execute async JavaScript in WebViews, including:
- **wdi5** (WebDriver.io service for SAP OpenUI5)
- Any test framework using `browser.execute(async () => ...)` patterns
- Hybrid app testing with Cordova/Capacitor

### Impact

This issue makes async JavaScript patterns completely unusable on iOS WebViews via Appium, while the same code works correctly on:
- Safari WebDriver (standalone browser automation)
- Android ChromeDriver (WebView automation)
- Desktop browsers

---

## Environment

- **iOS version:** 17.x+ (tested on iOS 17, iOS 18)
- **appium-remote-debugger version:** 15.3.2 (and earlier)
- **Appium version:** 2.x
- **appium-xcuitest-driver version:** latest
- **App type:** Cordova/Capacitor hybrid apps using WKWebView

---

## Steps to Reproduce

### Minimal Code Example

```javascript
// This works on Android and Safari, but returns {} on iOS WKWebView
const result = await browser.execute(async () => {
    return "hello";
});
console.log(result); // iOS: {} | Android/Safari: "hello"
```

### Detailed Reproduction

```javascript
// 1. Sync function - WORKS on all platforms
const syncResult = await browser.execute(() => 42);
// syncResult = 42 ✓

// 2. Async function - BROKEN on iOS WKWebView
const asyncResult = await browser.execute(async () => "hello");
// iOS WKWebView: asyncResult = {} ✗
// Android/Safari: asyncResult = "hello" ✓

// 3. Promise.resolve - BROKEN on iOS WKWebView
const promiseResult = await browser.execute(() => Promise.resolve("promised"));
// iOS WKWebView: promiseResult = {} ✗
// Android/Safari: promiseResult = "promised" ✓

// 4. Async with await - BROKEN on iOS WKWebView
const awaitResult = await browser.execute(async () => {
    await Promise.resolve();
    return "after await";
});
// iOS WKWebView: awaitResult = {} ✗
// Android/Safari: awaitResult = "after await" ✓
```

### Pattern Comparison Table

| Pattern | iOS WKWebView | Android/Desktop |
|---------|---------------|-----------------|
| `execute(() => 42)` | ✓ Works | ✓ Works |
| `execute(() => "string")` | ✓ Works | ✓ Works |
| `execute(async () => "result")` | ✗ Returns `{}` | ✓ Works |
| `execute(() => Promise.resolve("x"))` | ✗ Returns `{}` | ✓ Works |
| `executeAsync((done) => done("result"))` | ✓ Works | ✓ Works |

---

## Expected Behavior

The async function should be awaited and the resolved value returned:

```javascript
const result = await browser.execute(async () => "hello");
// Expected: result === "hello"
```

---

## Actual Behavior

The Promise object is serialized as `{}` (empty object) and returned immediately without awaiting:

```javascript
const result = await browser.execute(async () => "hello");
// Actual: result === {} (empty object)
```

---

## Root Cause Analysis

### The Problem

The `execute()` function in `appium-remote-debugger/lib/mixins/execute.ts` uses `Runtime.evaluate` via the WebKit Remote Debugger Protocol:

```typescript
// lib/mixins/execute.ts line 173
const res = await rpcClient.send('Runtime.evaluate', {
    expression: command,
    returnByValue: true,
    appIdKey,
    pageIdKey,
});
```

When an async function is evaluated:
1. The script executes and returns a `Promise` object
2. `Runtime.evaluate` returns immediately (does not await)
3. The Promise is serialized to `{}` by the WebKit protocol
4. The empty object is returned to the test code

### Why Safari WebDriver Works

WebKit fixed this issue for Safari WebDriver in January 2020:
- **Bug:** https://bugs.webkit.org/show_bug.cgi?id=204151
- **Changeset:** https://trac.webkit.org/changeset/254329/webkit

The fix wraps user scripts in `async function` and uses `await` on the result. However, **this fix only applies to Safari WebDriver**, not to the Remote Debugger Protocol path used by Appium.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Test Runner (Node.js)                        │
│                    WebdriverIO / Appium Client                      │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         Appium Server                               │
└──────────────┬────────────────────────────────────┬─────────────────┘
               │                                    │
    ┌──────────▼──────────┐              ┌──────────▼──────────┐
    │  Android (UiAutomator2)            │  iOS (XCUITest Driver)│
    │                     │              │                      │
    │  ChromeDriver       │              │  appium-remote-      │
    │  (WebView)          │              │  debugger (WebView)  │
    │                     │              │                      │
    │  ✓ Async works!     │              │  ✗ Async broken!     │
    └─────────────────────┘              └──────────────────────┘
```

---

## Proposed Solution

### Option A: Detect and Wrap Async Functions (Recommended)

Modify `lib/mixins/execute.ts` to detect async function scripts and use the existing `Runtime.awaitPromise` capability (already used in `executeAtomAsync`):

```typescript
export async function execute(this: RemoteDebugger, command: string, override?: boolean): Promise<any> {
    const { appIdKey, pageIdKey } = checkParams({
        appIdKey: getAppIdKey(this),
        pageIdKey: getPageIdKey(this),
    });

    if (getGarbageCollectOnExecute(this)) {
        await this.garbageCollect();
    }

    const rpcClient = this.requireRpcClient(true);
    await rpcClient.waitForPage(appIdKey as AppIdKey, pageIdKey as PageIdKey);

    // Check if the script might return a Promise (async function or explicit Promise)
    const mightBeAsync = isAsyncScript(command);

    if (mightBeAsync) {
        // Wrap in Promise handling and use awaitPromise
        return await this.executeWithAsyncSupport(command, appIdKey, pageIdKey);
    }

    // Original sync execution path
    this.log.debug(`Sending javascript command: '${_.truncate(command, { length: 50 })}'`);
    const res = await rpcClient.send('Runtime.evaluate', {
        expression: command,
        returnByValue: true,
        appIdKey,
        pageIdKey,
    });
    return convertJavascriptEvaluationResult(res);
}

function isAsyncScript(script: string): boolean {
    // Detect async function patterns
    return /\basync\s+(function|\()/.test(script) ||
           /\basync\s+\w+\s*=>/.test(script) ||
           /Promise\s*\.\s*(resolve|reject|all|race|any)/.test(script) ||
           /new\s+Promise\s*\(/.test(script);
}

async function executeWithAsyncSupport(
    this: RemoteDebugger,
    command: string,
    appIdKey: AppIdKey,
    pageIdKey: PageIdKey
): Promise<any> {
    const evaluate = async (method: string, opts: any) =>
        await this.requireRpcClient(true).send(method, Object.assign({
            appIdKey,
            pageIdKey,
            returnByValue: false,
        }, opts));

    // Wrap the script to always return a Promise
    const wrappedScript = `
        (async function() {
            return await (${command});
        })()
    `;

    const obj = await evaluate('Runtime.evaluate', {
        expression: wrappedScript,
    });

    // Use Runtime.awaitPromise to wait for the result
    const res = await evaluate('Runtime.awaitPromise', {
        promiseObjectId: obj.result.objectId,
        returnByValue: true,
        generatePreview: true,
        saveResult: true,
    });

    return convertJavascriptEvaluationResult(res);
}
```

### Option B: Use WKWebView.callAsyncJavaScript (iOS 14+)

Apple introduced `callAsyncJavaScript` in iOS 14 which natively supports Promise resolution. This would require changes in the XCUITest driver to expose this API.

---

## Workaround

Until this is fixed upstream, the workaround is to detect async functions and convert them to `executeAsync` with callback pattern:

```javascript
// Workaround: Convert async execute to executeAsync with callback
async function executeWithAsyncSupport(browser, script, ...args) {
    const isAsyncFunction = script.constructor?.name === "AsyncFunction" ||
                           /\basync\s/.test(script.toString());

    if (!isAsyncFunction) {
        return browser.execute(script, ...args);
    }

    // Convert to executeAsync pattern
    const fnSource = script.toString();
    const wrapper = function(asyncFnSource, ...rest) {
        const done = rest.pop();
        const userArgs = rest;
        try {
            const asyncFn = eval("(" + asyncFnSource + ")");
            Promise.resolve(asyncFn.apply(null, userArgs))
                .then(done)
                .catch(err => done({ __error: err.message }));
        } catch (e) {
            done({ __error: e.message });
        }
    };

    return browser.executeAsync(wrapper, fnSource, ...args);
}
```

This workaround has been successfully implemented in the **wdi5-cordova** service.

---

## References

- **Safari WebDriver fix:** https://bugs.webkit.org/show_bug.cgi?id=204151
- **WebKit changeset:** https://trac.webkit.org/changeset/254329/webkit
- **W3C WebDriver spec discussion:** https://github.com/w3c/webdriver/issues/1436
- **Apple callAsyncJavaScript docs:** https://developer.apple.com/documentation/webkit/wkwebview/callasyncjavascript(_:arguments:in:in:completionhandler:)

---

## Minimal Reproduction Repository

A minimal reproduction test has been added to appium-remote-debugger:
- **File:** `test/functional/async-execute-issue-specs.ts`
- **Run with:** `npm run e2e-test -- --grep "Async Execute Issue"`

---

## Labels

- `bug`
- `xcuitest`
- `remote-debugger`
- `webview`

---

## Additional Context

This issue severely impacts the **wdi5** testing framework (WebDriver.io service for SAP OpenUI5/SAPUI5 testing) when running tests on iOS Cordova apps. wdi5 internally uses async functions with `sap.ui.require()` callbacks wrapped in Promises, which all return `{}` on iOS, breaking all control interactions.

The workaround has been implemented in the wdi5-cordova service, but a proper upstream fix would benefit all Appium users.
