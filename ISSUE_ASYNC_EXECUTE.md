# Issue: Execute Script does not await async functions on iOS WKWebView

**Suggested title for GitHub:**  
`[Bug] appium-remote-debugger: execute() returns {} for async/Promise scripts on iOS WKWebView`

---

## Problem

On iOS WKWebView (e.g. Cordova/hybrid apps via Appium XCUITest), `browser.execute()` does **not** wait for async functions or Promises. The call returns an empty object `{}` instead of the resolved value. The same code works on Android WebView and Safari.

**Example:**

```javascript
const result = await browser.execute(async () => "hello");
// Expected: result === "hello"
// Actual on iOS WKWebView: result === {}
```

Sync scripts work; only async/Promise-returning scripts are affected.

**Context (WebdriverIO + Appium):** With WebdriverIO and Appium, `browser.execute()` is the usual way to run scripts. That call goes through Appium’s XCUITest driver into **appium-remote-debugger** for iOS WKWebView. The callback-based `browser.executeAsync()` still works on iOS WKWebView today, but the standard, promise-returning path is `browser.execute()`. Fixing async/Promise handling in `execute()` is what makes `browser.execute(async () => …)` reliable and keeps iOS WKWebView tests future-proof (e.g. for wdi5 and other frameworks that use `execute()` with async functions).

---

## Root cause

In `lib/mixins/execute.ts`, `execute()` uses `Runtime.evaluate` with `returnByValue: true`. That API returns immediately and does not wait for Promises. WebKit then serializes the Promise as `{}`. Safari WebDriver fixed this (WebKit [#204151](https://bugs.webkit.org/show_bug.cgi?id=204151)), but the Remote Debugger path used by Appium does not use that fix.

---

## Proposed fix (summary)

1. **Detect** scripts that may return a Promise (e.g. `async`, `Promise.resolve`, `.then(`).
2. For those, run with `returnByValue: false`, then if the result has `subtype === 'promise'` or `className === 'Promise'`, call **`Runtime.awaitPromise`** (already used in `executeAtomAsync`) and return the resolved value.
3. For **execute_script** atom: when the user script may return a Promise and there are no frames, run the user script directly (wrapped in a function) so the Promise is visible to the above logic instead of being serialized by the atom’s `Q()`.

Sync scripts stay on the current code path; no API changes.

---

## Workaround

Use `executeAsync` with a callback instead of `execute(async () => ...)` until the fix is available.

---

## Impact

- **wdi5** and any stack using `browser.execute(async () => ...)` on iOS WebView.
- **Repro in this repo:** `npm run e2e-test -- --grep "Async Execute Issue"` (tests in `test/functional/async-execute-issue-specs.ts`).

---

## References

- WebKit fix (Safari WebDriver): https://bugs.webkit.org/show_bug.cgi?id=204151  
- W3C discussion: https://github.com/w3c/webdriver/issues/1436  
