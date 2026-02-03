/**
 * Unit tests demonstrating the async execute issue.
 *
 * These tests mock the RPC client to show exactly what happens when
 * async functions are executed: the Promise object is returned immediately
 * without being awaited, resulting in an empty object {}.
 */

import { MOCHA_TIMEOUT } from '../../helpers/helpers';
import { execute } from '../../../lib/mixins/execute';
import sinon from 'sinon';
import { expect } from 'chai';

describe('Async Execute Issue - Unit Tests', function () {
  this.timeout(MOCHA_TIMEOUT);

  /**
   * Creates a mock context that simulates the RemoteDebugger behavior
   */
  function createMockContext(sendResponse: any) {
    return {
      _appIdKey: 'appId',
      _pageIdKey: 'pageId',
      log: { debug: () => { } },
      _rpcClient: {
        isConnected: true,
        send: sinon.stub().resolves(sendResponse),
        waitForPage: async () => { },
      },
      requireRpcClient() {
        return this._rpcClient;
      }
    };
  }

  describe('Current Behavior (demonstrates the bug)', function () {
    /**
     * This test shows that when a sync value is returned, everything works correctly.
     * The convertJavascriptEvaluationResult function extracts the value from { value: X }
     */
    it('should correctly return sync primitive values', async function () {
      // Mock returns the format that convertJavascriptEvaluationResult expects
      const ctx = createMockContext({ value: 42 });

      const result = await execute.call(ctx as any, '42');
      expect(result).to.equal(42);
    });

    it('should correctly return sync string values', async function () {
      const ctx = createMockContext({ value: 'hello' });

      const result = await execute.call(ctx as any, '"hello"');
      expect(result).to.equal('hello');
    });

    it('should correctly return sync object values', async function () {
      const ctx = createMockContext({ value: { foo: 'bar' } });

      const result = await execute.call(ctx as any, '({foo: "bar"})');
      expect(result).to.deep.equal({ foo: 'bar' });
    });

    /**
     * THIS TEST DEMONSTRATES THE BUG
     *
     * When an async function is executed, WebKit's Runtime.evaluate returns
     * a Promise object immediately. Since returnByValue is true, WebKit
     * attempts to serialize the Promise, which results in an empty object {}.
     *
     * The expected behavior would be to await the Promise and return the
     * resolved value.
     */
    it('DEMONSTRATES BUG: Promise serializes to empty object {}', async function () {
      // This is what WebKit returns when evaluating a Promise with returnByValue: true
      // The Promise cannot be serialized, so it becomes {}
      // The response format after processing is { value: {} }
      const ctx = createMockContext({ value: {} });

      const result = await execute.call(ctx as any, 'Promise.resolve("should be this")');

      // BUG: Result is {} instead of "should be this"
      expect(result).to.deep.equal({});

      // This is what we WANT (but doesn't happen currently):
      // expect(result).to.equal("should be this");
    });

    it('DEMONSTRATES BUG: async function result serializes to empty object {}', async function () {
      // When an async function is executed, WebKit serializes the Promise as {}
      const ctx = createMockContext({ value: {} });

      const result = await execute.call(ctx as any, '(async () => "async value")()');

      // BUG: Result is {} instead of "async value"
      expect(result).to.deep.equal({});
    });
  });

  describe('Expected Behavior (what should happen)', function () {
    /**
     * This test shows what SHOULD happen: the Promise should be awaited
     * using Runtime.awaitPromise and the resolved value should be returned.
     *
     * Note: This test shows the expected API calls, not what currently happens.
     */
    it('should await Promise and return resolved value (EXPECTED BEHAVIOR)', async function () {
      const sendStub = sinon.stub();

      // First call: Runtime.evaluate returns a Promise object reference
      sendStub.onFirstCall().resolves({
        result: {
          type: 'object',
          subtype: 'promise',
          className: 'Promise',
          description: 'Promise',
          objectId: 'promise-object-id-123' // objectId allows awaiting
        }
      });

      // Second call: Runtime.awaitPromise returns the resolved value
      sendStub.onSecondCall().resolves({
        result: {
          type: 'string',
          value: 'resolved value'
        }
      });

      const ctx = {
        _appIdKey: 'appId',
        _pageIdKey: 'pageId',
        log: { debug: () => { } },
        _rpcClient: {
          isConnected: true,
          send: sendStub,
          waitForPage: async () => { },
        },
        requireRpcClient() {
          return this._rpcClient;
        }
      };

      // Note: This is showing what the FIXED behavior should look like
      // Currently execute() only makes ONE call to Runtime.evaluate
      // The fix would detect the Promise and make a SECOND call to Runtime.awaitPromise

      // Simulate the fixed behavior manually:
      // 1. First call to evaluate (returns Promise reference)
      const evalResult = await ctx._rpcClient.send('Runtime.evaluate', {
        expression: 'Promise.resolve("resolved value")',
        returnByValue: false, // Important: false to get objectId
        appIdKey: 'appId',
        pageIdKey: 'pageId',
      });

      // Check if result is a Promise (has subtype: 'promise')
      const isPromise = evalResult.result.subtype === 'promise';
      expect(isPromise).to.be.true;

      // 2. Second call to awaitPromise (gets resolved value)
      const awaitResult = await ctx._rpcClient.send('Runtime.awaitPromise', {
        promiseObjectId: evalResult.result.objectId,
        returnByValue: true,
        appIdKey: 'appId',
        pageIdKey: 'pageId',
      });

      // The resolved value
      expect(awaitResult.result.value).to.equal('resolved value');
    });
  });

  describe('Async Detection Helper', function () {
    /**
     * Tests for the async detection function that would be used in the fix.
     */
    function isAsyncScript(script: string): boolean {
      // Detect async function patterns
      return /\basync\s+(function|\()/.test(script) ||
        /\basync\s+\w+\s*=>/.test(script) ||
        /Promise\s*\.\s*(resolve|reject|all|race|any|allSettled)/.test(script) ||
        /new\s+Promise\s*\(/.test(script) ||
        /\.then\s*\(/.test(script);
    }

    it('should detect async function declaration', function () {
      expect(isAsyncScript('async function foo() { return 1; }')).to.be.true;
    });

    it('should detect async arrow function', function () {
      expect(isAsyncScript('async () => "hello"')).to.be.true;
    });

    it('should detect async arrow with name', function () {
      expect(isAsyncScript('async x => x * 2')).to.be.true;
    });

    it('should detect async IIFE', function () {
      expect(isAsyncScript('(async function() { return 1; })()')).to.be.true;
    });

    it('should detect Promise.resolve', function () {
      expect(isAsyncScript('Promise.resolve("value")')).to.be.true;
    });

    it('should detect Promise.reject', function () {
      expect(isAsyncScript('Promise.reject(new Error())')).to.be.true;
    });

    it('should detect Promise.all', function () {
      expect(isAsyncScript('Promise.all([p1, p2])')).to.be.true;
    });

    it('should detect new Promise', function () {
      expect(isAsyncScript('new Promise((resolve) => resolve(1))')).to.be.true;
    });

    it('should detect .then()', function () {
      expect(isAsyncScript('fetch(url).then(r => r.json())')).to.be.true;
    });

    it('should NOT detect sync function', function () {
      expect(isAsyncScript('function foo() { return 1; }')).to.be.false;
    });

    it('should NOT detect sync arrow', function () {
      expect(isAsyncScript('() => "hello"')).to.be.false;
    });

    it('should NOT detect sync IIFE', function () {
      expect(isAsyncScript('(function() { return 1; })()')).to.be.false;
    });

    it('should NOT detect simple expression', function () {
      expect(isAsyncScript('1 + 1')).to.be.false;
    });

    it('should NOT detect object literal', function () {
      expect(isAsyncScript('({ foo: "bar" })')).to.be.false;
    });
  });
});
