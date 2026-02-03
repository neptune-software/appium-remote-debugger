/**
 * Minimal reproduction test for the async execute issue on iOS WKWebView.
 *
 * ISSUE: When executing a script that is an `async` function or returns a Promise,
 * the Promise is not awaited and an empty object `{}` is returned instead of the
 * resolved value.
 *
 * This works correctly on:
 * - Safari WebDriver (desktop/mobile browser automation)
 * - Android ChromeDriver (WebView automation)
 *
 * This is BROKEN on:
 * - iOS WKWebView via Appium XCUITest (uses appium-remote-debugger)
 *
 * Root Cause:
 * The `execute()` function in lib/mixins/execute.ts uses `Runtime.evaluate` which
 * immediately returns the result. When an async function is passed, it returns a
 * Promise object which gets serialized as `{}` (empty object) by the WebKit protocol.
 *
 * Safari WebDriver fixed this in WebKit Bug #204151 (January 2020) by wrapping
 * scripts in async functions and awaiting the result. However, that fix only applies
 * to Safari WebDriver, not to the Remote Debugger Protocol path used by Appium.
 *
 * References:
 * - Safari WebDriver fix: https://bugs.webkit.org/show_bug.cgi?id=204151
 * - WebKit changeset: https://trac.webkit.org/changeset/254329/webkit
 * - W3C WebDriver spec discussion: https://github.com/w3c/webdriver/issues/1436
 */

import { Simctl } from 'node-simctl';
import { getSimulator, Simulator } from 'appium-ios-simulator';
import { retryInterval, retry } from 'asyncbox';
import { util } from '@appium/support';
import _ from 'lodash';
import { createRemoteDebugger } from '../../index';
import { startHttpServer, stopHttpServer } from './http-server';
import { RemoteDebugger } from '../../lib/remote-debugger';
import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';

use(chaiAsPromised);

const SIM_NAME = process.env.SIM_DEVICE_NAME || `appium-async-test-${util.uuidV4()}`;
const DEVICE_NAME = process.env.DEVICE_NAME || 'iPhone 16';
const PLATFORM_VERSION = process.env.PLATFORM_VERSION || '18.2';

const PAGE_TITLE = 'Remote debugger test page';

async function getExistingSim(deviceName: string, platformVersion: string): Promise<Simulator | null> {
  const devices = await new Simctl().getDevices(platformVersion);

  for (const device of _.values(devices)) {
    if (device.name === deviceName) {
      return await getSimulator(device.udid);
    }
  }

  return null;
}

async function deleteDeviceWithRetry(udid: string): Promise<void> {
  const simctl = new Simctl({ udid });
  try {
    await retryInterval(10, 1000, simctl.deleteDevice.bind(simctl));
  } catch { }
}

/**
 * Test suite demonstrating the async execute issue.
 *
 * Run with: npm run e2e-test -- --grep "Async Execute Issue"
 */
describe('Async Execute Issue - Minimal Reproduction', function () {
  this.timeout(610000);
  this.retries(2);

  let sim: Simulator;
  let simCreated = false;
  let address: string;

  before(async function () {
    const portPromise = startHttpServer();

    sim = await getExistingSim(DEVICE_NAME, PLATFORM_VERSION) as Simulator;
    if (!sim) {
      const udid = await new Simctl().createDevice(SIM_NAME, DEVICE_NAME, PLATFORM_VERSION);
      sim = await getSimulator(udid);
      simCreated = true;
    }
    await sim.run({
      startupTimeout: process.env.CI ? 600000 : 120000,
    });
    address = `http://127.0.0.1:${await portPromise}`;
  });

  after(async function () {
    if (sim) {
      await sim.shutdown();
      if (simCreated) {
        await deleteDeviceWithRetry(sim.udid);
      }
    }
    stopHttpServer();
  });

  let rd: RemoteDebugger;

  beforeEach(async function () {
    const socketPath = await sim.getWebInspectorSocket();
    rd = createRemoteDebugger({
      bundleId: 'com.apple.mobilesafari',
      isSafari: true,
      platformVersion: PLATFORM_VERSION,
      socketPath: socketPath || undefined,
      garbageCollectOnExecute: false,
      logAllCommunication: true,
      logAllCommunicationHexDump: false,
      pageReadyTimeout: 30000,
      targetCreationTimeoutMs: process.env.CI ? 10 * 1000 * 60 : 60000,
    }, false);

    const maxRetries = process.env.CI ? 10 : 5;
    await retry(maxRetries, async () => await sim.openUrl(address));
    await retry(maxRetries, async () => {
      if (_.isEmpty(await rd.connect(60000))) {
        await rd.disconnect();
        throw new Error('The remote debugger did not return any connected applications');
      }
    });
  });

  afterEach(async function () {
    await rd?.disconnect();
    rd = null as any;
  });

  async function selectTestPage(): Promise<void> {
    const page = _.find(await rd.selectApp(address), (page) => page.title === PAGE_TITLE);
    if (!page) {
      throw new Error('Test page not found');
    }
    const pageIdStr = String(page.id);
    const [appIdKey, pageIdKey] = pageIdStr.split('.').map((id) => parseInt(id, 10));
    await rd.selectPage(appIdKey, pageIdKey);
  }

  // ==========================================================================
  // WORKING CASES - These demonstrate sync execution works correctly
  // ==========================================================================

  describe('Sync Execute (WORKS)', function () {
    it('should return primitive number', async function () {
      await selectTestPage();
      const result = await rd.executeAtom('execute_script', ['return 42;', []]);
      expect(result).to.equal(42);
    });

    it('should return primitive string', async function () {
      await selectTestPage();
      const result = await rd.executeAtom('execute_script', ['return "hello";', []]);
      expect(result).to.equal('hello');
    });

    it('should return object', async function () {
      await selectTestPage();
      const result = await rd.executeAtom('execute_script', ['return {foo: "bar"};', []]);
      expect(result).to.deep.equal({ foo: 'bar' });
    });

    it('should return array', async function () {
      await selectTestPage();
      const result = await rd.executeAtom('execute_script', ['return [1, 2, 3];', []]);
      expect(result).to.deep.equal([1, 2, 3]);
    });

    it('should handle sync IIFE', async function () {
      await selectTestPage();
      const result = await rd.executeAtom('execute_script', ['return (function() { return "sync iife"; })();', []]);
      expect(result).to.equal('sync iife');
    });
  });

  // ==========================================================================
  // BROKEN CASES - These demonstrate the async execute issue
  // ==========================================================================

  describe('Async Execute (BROKEN - returns {} instead of value)', function () {
    /**
     * ISSUE: This test demonstrates the core problem.
     *
     * When executing an async function, the function returns a Promise object.
     * The Remote Debugger Protocol serializes this Promise as {} (empty object)
     * instead of awaiting it and returning the resolved value.
     */
    it('should return resolved value from async function - FAILS with {}', async function () {
      await selectTestPage();

      // This is the simplest reproduction case
      const script = `return (async function() { return "hello from async"; })();`;
      const result = await rd.executeAtom('execute_script', [script, []]);

      // EXPECTED: result === "hello from async"
      // ACTUAL: result === {} (empty object)
      // Debug: Async function result will be {} instead of "hello from async"

      // This assertion currently FAILS
      expect(result).to.equal('hello from async');
    });

    it('should return resolved value from async arrow function - FAILS with {}', async function () {
      await selectTestPage();

      const script = `return (async () => "async arrow")();`;
      const result = await rd.executeAtom('execute_script', [script, []]);

      // Debug: Async arrow result will be {} instead of "async arrow"

      // This assertion currently FAILS
      expect(result).to.equal('async arrow');
    });

    it('should return resolved value from Promise.resolve - FAILS with {}', async function () {
      await selectTestPage();

      const script = `return Promise.resolve("promised value");`;
      const result = await rd.executeAtom('execute_script', [script, []]);

      // Debug: Promise.resolve result will be {} instead of "promised value"

      // This assertion currently FAILS
      expect(result).to.equal('promised value');
    });

    it('should return resolved value after await - FAILS with {}', async function () {
      await selectTestPage();

      const script = `return (async function() {
        await Promise.resolve();
        return "after await";
      })();`;
      const result = await rd.executeAtom('execute_script', [script, []]);

      // Debug: After await result will be {} instead of "after await"

      // This assertion currently FAILS
      expect(result).to.equal('after await');
    });

    it('should return resolved value from setTimeout wrapped in Promise - FAILS with {}', async function () {
      await selectTestPage();

      const script = `return new Promise(function(resolve) {
        setTimeout(function() { resolve("delayed"); }, 100);
      });`;
      const result = await rd.executeAtom('execute_script', [script, []]);

      // Debug: setTimeout Promise result will be {} instead of "delayed"

      // This assertion currently FAILS
      expect(result).to.equal('delayed');
    });

    /**
     * This is the pattern that wdi5 uses internally for SAP UI5 control interaction.
     * The sap.ui.require() callback pattern requires a Promise to wait for the
     * asynchronous module loading to complete.
     */
    it('should handle async module loading pattern (wdi5 pattern) - FAILS with {}', async function () {
      await selectTestPage();

      // Simplified version of what wdi5 does internally
      const script = `return (async function(selector) {
        return new Promise(function(resolve) {
          // Simulating sap.ui.require callback pattern
          setTimeout(function() {
            // In real wdi5, this would be: sap.ui.require(['sap/ui/test/RecordReplay'], function(RR) { ... })
            var control = { id: selector, type: 'sap.m.Button' };
            resolve(control);
          }, 50);
        });
      })('__button0');`;

      const result = await rd.executeAtom('execute_script', [script, []]);

      // Debug: wdi5 pattern result will be {} instead of the control object

      // This assertion currently FAILS - wdi5 gets {} instead of the control object
      expect(result).to.deep.equal({ id: '__button0', type: 'sap.m.Button' });
    });
  });

  // ==========================================================================
  // WORKAROUND CASES - These demonstrate executeAsync works correctly
  // ==========================================================================

  describe('executeAsync with callback (WORKS - current workaround)', function () {
    const timeout = 5000;

    it('should return value via callback', async function () {
      await selectTestPage();

      const script = `arguments[arguments.length - 1]("hello from callback");`;
      const result = await rd.executeAtomAsync('execute_async_script', [script, [], timeout]);

      expect(result).to.equal('hello from callback');
    });

    it('should handle async operation via callback', async function () {
      await selectTestPage();

      const script = `
        var done = arguments[arguments.length - 1];
        setTimeout(function() { done("delayed via callback"); }, 100);
      `;
      const result = await rd.executeAtomAsync('execute_async_script', [script, [], timeout]);

      expect(result).to.equal('delayed via callback');
    });

    it('should handle Promise.then() via callback', async function () {
      await selectTestPage();

      const script = `
        var done = arguments[arguments.length - 1];
        Promise.resolve("promised via callback").then(done);
      `;
      const result = await rd.executeAtomAsync('execute_async_script', [script, [], timeout]);

      expect(result).to.equal('promised via callback');
    });

    /**
     * This is the workaround that wdi5-cordova uses:
     * Convert async functions to executeAsync with callback pattern.
     */
    it('should handle async function converted to callback pattern (wdi5-cordova workaround)', async function () {
      await selectTestPage();

      // This is how the workaround converts async functions to executeAsync
      const asyncFnSource = `async function(selector) {
        return new Promise(function(resolve) {
          setTimeout(function() {
            var control = { id: selector, type: 'sap.m.Button' };
            resolve(control);
          }, 50);
        });
      }`;

      const script = `
        var done = arguments[arguments.length - 1];
        var selector = arguments[0];
        var asyncFn = ${asyncFnSource};
        Promise.resolve(asyncFn(selector)).then(done).catch(function(e) {
          done({ error: e.message || String(e) });
        });
      `;

      const result = await rd.executeAtomAsync('execute_async_script', [script, ['__button0'], timeout]);

      // This WORKS because we use executeAsync with callback
      expect(result).to.deep.equal({ id: '__button0', type: 'sap.m.Button' });
    });
  });

  // ==========================================================================
  // LOW-LEVEL REPRODUCTION - Direct rd.execute() calls
  // ==========================================================================

  describe('Direct rd.execute() (BROKEN for async)', function () {
    it('should return sync value directly', async function () {
      await selectTestPage();

      const result = await rd.execute('42');
      expect(result).to.equal(42);
    });

    it('should return sync string directly', async function () {
      await selectTestPage();

      const result = await rd.execute('"hello"');
      expect(result).to.equal('hello');
    });

    it('should return resolved value for Promise (FIXED)', async function () {
      await selectTestPage();

      const result = await rd.execute('Promise.resolve("should be this value")');

      expect(result).to.equal('should be this value');
    });

    it('should return resolved value for async IIFE (FIXED)', async function () {
      await selectTestPage();

      const result = await rd.execute('(async () => "async value")()');

      expect(result).to.equal('async value');
    });
  });
});
