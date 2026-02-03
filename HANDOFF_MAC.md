# Handoff Summary: iOS WKWebView Async Execute Issue

## Problem Statement

When using `browser.execute(async () => "result")` on iOS WKWebView via Appium XCUITest, the Promise is not awaited and returns `{}` instead of the resolved value. This breaks wdi5 (WebDriver.io service for SAP OpenUI5) on Cordova iOS apps.

**Works:** Android, Safari browser, Desktop browsers
**Broken:** iOS WKWebView via Appium (uses `appium-remote-debugger`)

## Root Cause

The `execute()` function in `lib/mixins/execute.ts` uses `Runtime.evaluate` which returns immediately. When an async function is executed, it returns a Promise object that WebKit serializes as `{}` without awaiting it.

Safari WebDriver fixed this in 2020 (WebKit Bug #204151), but that fix only applies to Safari WebDriver, not the Remote Debugger Protocol path used by Appium.

## Files Created (on Windows)

| File | Description |
|------|-------------|
| `test/unit/mixins/async-execute-issue-specs.ts` | Unit tests with mocks - documents the bug (20 tests, all pass) |
| `test/functional/async-execute-issue-specs.ts` | E2E tests for iOS Simulator - **will FAIL** to prove the bug |
| `ISSUE_ASYNC_EXECUTE.md` | Ready-to-file GitHub issue for appium/appium |
| `PROPOSED_FIX.md` | Detailed proposed fix with complete modified `execute.ts` |
| `ios_wkwebview_async_issue.md` | Original analysis doc, updated with links to new files |

## Verified on Windows

```bash
npm test                                    # 64 passing (includes 20 new tests)
npm test -- --grep "Async Execute Issue"   # 20 passing
npm run lint                               # 0 errors
```

## TODO on Mac

1. **Run E2E tests against real iOS Simulator:**
   ```bash
   npm run e2e-test -- --grep "Async Execute Issue"
   ```
   These tests **should FAIL** - that proves the bug exists on real iOS.

2. **Capture the failure output** - this is evidence for the GitHub issue.

3. **Optionally apply the fix** from `PROPOSED_FIX.md` to `lib/mixins/execute.ts` and verify:
   - E2E tests now PASS
   - Existing tests still pass

4. **File the issue** at https://github.com/appium/appium/issues/new using content from `ISSUE_ASYNC_EXECUTE.md`

## Key Test Cases in E2E Tests

The functional tests cover:
- Sync execute (should pass - baseline)
- Async function `async () => "value"` (should fail with `{}`)
- `Promise.resolve()` (should fail with `{}`)
- Async with `await` (should fail with `{}`)
- wdi5's `sap.ui.require()` pattern (should fail with `{}`)
- `executeAsync` with callback (should pass - workaround)

## Branch

`fix/xcuitestAsyncScript` - contains all the new files

## References

- Safari WebDriver fix: https://bugs.webkit.org/show_bug.cgi?id=204151
- WebKit changeset: https://trac.webkit.org/changeset/254329/webkit
- W3C WebDriver spec discussion: https://github.com/w3c/webdriver/issues/1436
