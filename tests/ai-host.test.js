const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = file => fs.readFileSync(path.join(__dirname, '..', 'extension', file), 'utf8');
// background.js is an ES module since the desktop link landed, and vm.runInContext only
// takes a classic script. The import is replaced with a stub so these tests keep exercising
// the offscreen AI host, which is what they are about.
const asClassicScript = text => text.replace(
  /^import \{ installDesktopLink \} from "\.\/link\/worker\.mjs";$/m,
  'const installDesktopLink = () => {};'
).replace(/^import \{ installFeedback \} from "\.\/link\/feedback\.mjs";$/m, 'const installFeedback = () => {};')
  // #226：站点配方的规则脚本只挂接口到 self 上，这里的测试用不到。
  .replace(/^import "\.\/[\w-]+\.js";$/gm, '');

test('service worker only creates one concurrent offscreen worker host and never fetches AI', async () => {
  let complete, creates = 0;
  const context = vm.createContext({ chrome: {
    action: { onClicked: { addListener() {} } },
    sidePanel: { setPanelBehavior: async () => {} },
    runtime: { getURL: name => `chrome-extension://test/${name}`, getContexts: async () => [], onMessage: { addListener() {} } },
    offscreen: { createDocument: options => { creates++; assert.equal(options.reasons[0], 'WORKERS'); return new Promise(resolve => { complete = resolve; }); } }
  } });
  vm.runInContext(asClassicScript(source('background.js')), context);
  const a = context.ensureAiHost(), b = context.ensureAiHost();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(creates, 1);
  complete();
  await Promise.all([a, b]);
  assert.doesNotMatch(source('background.js'), /\bfetch\s*\(/);
});

test('a browser without the sidePanel API still opens the independent manager tab', async () => {
  let actionClick;
  let created;
  const context = vm.createContext({ chrome: {
    action: { onClicked: { addListener(fn) { actionClick = fn; } } },
    runtime: { getURL: name => `chrome-extension://test/${name}`, onMessage: { addListener() {} } },
    tabs: { query: async () => [], create: async options => { created = options.url; return { id: 1 }; } }
  } });
  vm.runInContext(asClassicScript(source('background.js')), context);
  assert.equal(typeof actionClick, 'function');
  actionClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(created, 'chrome-extension://test/popup.html');
});

test('offscreen host forwards sender identity and correlated replies to its dedicated worker', async () => {
  let listener, worker;
  class MockWorker { constructor(url) { assert.equal(url, 'ai-worker.js'); worker = this; } postMessage(data) { this.last = data; } }
  const context = vm.createContext({ Worker: MockWorker, chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } } });
  vm.runInContext(source('ai-host.js'), context);
  let result;
  assert.equal(listener({ type: 'AI_FILL', requestId: 'a' }, { tab: { id: 3 }, frameId: 2, documentId: 'doc' }, reply => { result = reply; }), true);
  assert.equal(worker.last.sender.tab.id, 3);
  assert.equal(worker.last.sender.documentId, 'doc');
  worker.onmessage({ data: { id: worker.last.id, reply: { success: true } } });
  assert.equal(result.success, true);
  listener({ type: 'AI_FILL', requestId: 'b' }, {}, reply => { result = reply; });
  worker.onerror();
  assert.equal(result.success, false);
  listener({ type: 'AI_HOST_READY' }, {}, reply => { result = reply; });
  assert.equal(result.ready, false);
});

test('offscreen host relays desktop AI requests and cancellation', async () => {
  let worker;
  const sent = [];
  class MockWorker { constructor() { worker = this; } postMessage(data) { this.last = data; } }
  const context = vm.createContext({ Worker: MockWorker, chrome: { runtime: {
    onMessage: { addListener() {} },
    sendMessage: async message => { sent.push(message); return { ok: true, text: 'synthetic' }; }
  } } });
  vm.runInContext(source('ai-host.js'), context);
  worker.onmessage({ data: { kind: 'desktop-complete', callId: 'a', purpose: 'fill', system: 's', user: 'u' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent[0].type, 'DESKTOP_AI_COMPLETE');
  assert.equal(sent[0].requestId, 'a');
  assert.equal(worker.last.kind, 'desktop-result');
  assert.equal(worker.last.reply.text, 'synthetic');
  assert.equal(sent[0].tier, undefined);
  worker.onmessage({ data: { kind: 'desktop-cancel', callId: 'a' } });
  assert.equal(sent[1].type, 'DESKTOP_AI_CANCEL');
  worker.onmessage({ data: { kind: 'desktop-complete', callId: 'b', purpose: 'fill', tier: 'strong', system: 's', user: 'u' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent[2].tier, 'strong');
});

test('feedback failures cannot interrupt worker failure cleanup after extension context loss', () => {
  for (const failure of ['getURL', 'sendMessage']) {
    let listener, worker, invalidated = false;
    class MockWorker { constructor() { worker = this; } postMessage() {} }
    const context = vm.createContext({ Worker: MockWorker,
      ResumeProFeedback: { install() {}, exception: () => ({ type: 'exception' }) },
      chrome: { runtime: {
        getURL: () => { if (invalidated && failure === 'getURL') throw new Error('context invalidated'); return 'chrome-extension://test/'; },
        sendMessage: () => { throw new Error('context invalidated'); },
        onMessage: { addListener(fn) { listener = fn; } }
      } }
    });
    vm.runInContext(source('ai-host.js'), context);
    const replies = [];
    listener({ type: 'AI_FILL' }, {}, reply => replies.push(reply));
    listener({ type: 'AI_EXTRACT_JOB' }, {}, reply => replies.push(reply));
    invalidated = true;
    assert.doesNotThrow(() => worker.onmessage({ data: { kind: 'feedback-error', report: {} } }));
    assert.doesNotThrow(() => worker.onerror());
    assert.equal(replies.length, 2);
    assert.ok(replies.every(reply => reply.success === false));
    worker.onerror();
    assert.equal(replies.length, 2, 'pending responses are cleared');
    listener({ type: 'AI_HOST_READY' }, {}, reply => assert.equal(reply.ready, false));
  }
});

test('client cancellation waits for startup and original dispatch rather than racing the host', async () => {
  let ready, complete;
  const calls = [];
  const context = vm.createContext({ chrome: { runtime: { sendMessage: message => {
    calls.push(message.type);
    if (message.type === 'AI_SEND_VALUES_STATUS') return Promise.resolve({ ok: true, enabled: false });
    if (message.type === 'ENSURE_AI_HOST') return new Promise(resolve => { ready = resolve; });
    if (message.type === 'AI_HOST_READY') return Promise.resolve({ ready: true });
    if (message.type === 'AI_FILL') return new Promise(resolve => { complete = resolve; });
    complete({ success: false, error: 'cancelled' });
    return Promise.resolve({ cancelled: true });
  } } } });
  vm.runInContext(source('ai-client.js'), context);
  const result = context.ResumeProAIClient.send({ type: 'AI_FILL', requestId: 'a' });
  const cancelled = context.ResumeProAIClient.cancel('a');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['AI_SEND_VALUES_STATUS', 'ENSURE_AI_HOST']);
  ready({ ready: true });
  assert.equal((await cancelled).cancelled, true);
  assert.equal((await result).success, false);
  assert.deepEqual(calls, ['AI_SEND_VALUES_STATUS', 'ENSURE_AI_HOST', 'AI_HOST_READY', 'AI_FILL', 'CANCEL_AI_FILL']);
  assert.equal((await context.ResumeProAIClient.cancel('a')).cancelled, false);
});

test('failed startup sends no AI request and does not leave cancellation hanging', async () => {
  const calls = [];
  const context = vm.createContext({ chrome: { runtime: { sendMessage: async message => { calls.push(message.type); return { ready: false }; } } } });
  vm.runInContext(source('ai-client.js'), context);
  const result = context.ResumeProAIClient.send({ type: 'AI_FILL', requestId: 'a' });
  const cancel = context.ResumeProAIClient.cancel('a');
  await assert.rejects(result, /启动/);
  assert.equal((await cancel).cancelled, false);
  assert.deepEqual(calls, ['AI_SEND_VALUES_STATUS', 'ENSURE_AI_HOST']);
});

// #429「AI 填写时发送资料原文」：一键填写只按后台存的设置带 sendValues，调用方带的不算，问不到按关着。
test('a fill request carries sendValues only from the stored switch, never from the caller', async () => {
  const run = async (status, message) => {
    const sent = [];
    const context = vm.createContext({ chrome: { runtime: { sendMessage: async request => {
      if (request.type === 'AI_SEND_VALUES_STATUS') {
        if (status instanceof Error) throw status;
        return status;
      }
      if (request.type === 'ENSURE_AI_HOST' || request.type === 'AI_HOST_READY') return { ready: true };
      sent.push(JSON.parse(JSON.stringify(request)));
      return { success: true };
    } } } });
    vm.runInContext(source('ai-client.js'), context);
    await context.ResumeProAIClient.send(message);
    return sent[0];
  };
  const fill = { type: 'AI_FILL', requestId: 'a', formFields: [], resumeFields: [] };
  assert.equal((await run({ ok: true, enabled: true }, fill)).sendValues, true);
  assert.equal((await run({ ok: true, enabled: false }, { ...fill, sendValues: true })).sendValues, false, 'the caller cannot turn it on');
  for (const status of [undefined, { ok: false, enabled: true }, { ok: true, enabled: 'true' }, new Error('gone')]) {
    assert.equal((await run(status, { ...fill, sendValues: true })).sendValues, false, String(status?.message || JSON.stringify(status)));
  }
  // 别的请求不问开关，原样发。
  const repeat = await run({ ok: true, enabled: true }, { type: 'AI_PLAN_REPEAT', requestId: 'b' });
  assert.equal('sendValues' in repeat, false);
});

test('the service worker keeps the send-values switch, off unless set, and only extension pages change it', async () => {
  const listeners = [];
  let stored = {};
  let failing = false;
  const context = vm.createContext({ chrome: {
    action: { onClicked: { addListener() {} } },
    sidePanel: { setPanelBehavior: async () => {} },
    runtime: { id: 'test', getURL: name => `chrome-extension://test/${name}`, getContexts: async () => [], onMessage: { addListener(fn) { listeners.push(fn); } } },
    offscreen: { createDocument: async () => {} },
    storage: { local: {
      get: async key => { if (failing) throw new Error('storage'); return key in stored ? { [key]: stored[key] } : {}; },
      set: async values => { if (failing) throw new Error('storage'); Object.assign(stored, values); }
    } }
  } });
  vm.runInContext(asClassicScript(source('background.js')), context);
  const dispatch = (message, sender) => new Promise(resolve => {
    for (const listener of listeners) if (listener(message, sender, resolve) === true) return;
  }).then(reply => JSON.parse(JSON.stringify(reply)));
  const page = { id: 'test', url: 'chrome-extension://test/popup.html' };
  const tab = { id: 'test', url: 'https://jobs.example.test/apply', tab: { id: 1 } };
  assert.deepEqual(await dispatch({ type: 'AI_SEND_VALUES_STATUS' }, tab), { ok: true, enabled: false });
  assert.deepEqual(await dispatch({ type: 'AI_SEND_VALUES_SET', enabled: true }, tab), { ok: false, error: 'forbidden' });
  assert.deepEqual(stored, {});
  assert.deepEqual(await dispatch({ type: 'AI_SEND_VALUES_SET', enabled: true }, page), { ok: true, enabled: true });
  assert.deepEqual(await dispatch({ type: 'AI_SEND_VALUES_STATUS' }, tab), { ok: true, enabled: true });
  assert.deepEqual(await dispatch({ type: 'AI_SEND_VALUES_SET', enabled: 'yes' }, page), { ok: true, enabled: false });
  assert.deepEqual(stored, { aiSendResumeValues: false });
  failing = true;
  assert.deepEqual(await dispatch({ type: 'AI_SEND_VALUES_STATUS' }, page), { ok: false, enabled: false });
});

test('the content script loads the client and packaged host dependencies exist', () => {
  const manifest = JSON.parse(source('manifest.json'));
  assert.ok(manifest.permissions.includes('offscreen'));
  const scripts = manifest.content_scripts[0].js;
  assert.ok(scripts.indexOf('ai-client.js') < scripts.indexOf('content.js'));
  // The status page talks to the desktop only; it has no AI client.
  assert.equal(source('popup.html').includes('ai-client.js'), false);
  for (const file of ['ai-host.html', 'ai-host.js', 'ai-worker.js', 'ai-client.js']) assert.ok(source(file));
});
