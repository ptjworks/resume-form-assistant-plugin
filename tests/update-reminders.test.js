// 侧栏顶部的更新提醒：插件新版本已下载、解压安装、桌面太旧。旧版本一直在用，反馈里就一直是早修好的问题。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const reminders = require('../extension/update-reminder.js');

const source = file => fs.readFileSync(path.join(__dirname, '..', 'extension', file), 'utf8');

test('桌面落后一个次版本才算太旧，认不出的版本号不提示', () => {
  assert.equal(reminders.desktopBehind('0.4.4', '0.5.0'), true);
  assert.equal(reminders.desktopBehind('0.4.9', '0.5.3'), true);
  assert.equal(reminders.desktopBehind('0.9.0', '1.0.0'), true);
  assert.equal(reminders.desktopBehind('0.5.0', '0.5.2'), false, '同一个次版本里的小更新由桌面自己提示');
  assert.equal(reminders.desktopBehind('0.6.0', '0.5.0'), false);
  assert.equal(reminders.desktopBehind('0.10.0', '0.9.1'), false, '按数字比，不按字符串比');
  assert.equal(reminders.desktopBehind('', '0.5.0'), false);
  assert.equal(reminders.desktopBehind('0.4.4-beta.1', '0.5.0'), false);
  assert.equal(reminders.desktopBehind('0.4.4', ''), false);
});

test('一次只提示一件：先重新加载，再装商店版，最后更新桌面', () => {
  const all = { extensionVersion: '0.5.0', installType: 'development', desktopVersion: '0.4.4', readyVersion: '0.5.1' };
  assert.equal(reminders.reminder(all).kind, 'reload');
  assert.match(reminders.reminder(all).message, /0\.5\.1/);
  assert.equal(reminders.reminder({ ...all, readyVersion: '' }).kind, 'store');
  assert.equal(reminders.reminder({ ...all, readyVersion: '0.5.0' }).kind, 'store', '下载好的不比现在新就不算');
  const desktop = reminders.reminder({ ...all, readyVersion: '', installType: 'normal' });
  assert.equal(desktop.kind, 'download');
  assert.match(desktop.message, /0\.4\.4/);
  assert.equal(reminders.reminder({ ...all, readyVersion: '', installType: 'normal', desktopVersion: '0.5.0' }), null);
  assert.equal(reminders.reminder({ extensionVersion: '0.5.0', installType: 'admin', desktopVersion: '0.5.1' }), null);
  assert.equal(reminders.reminder(), null);
});

test('握手时桌面报的版本跟着简历读取一起回到侧栏，别的请求不带', async () => {
  const { createResume } = await import('../extension/link/resume.mjs');
  const probe = { mode: 'ready', identity: { archiveId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', restoreEpoch: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, appVersion: '0.4.4' };
  const resume = createResume({
    session: { probe: async () => probe },
    store: { clientInstanceId: async () => '11111111-1111-4111-8111-111111111111' },
    uuid: () => '33333333-3333-4333-8333-333333333333',
    now: () => new Date('2026-11-07T00:00:00.000Z'),
    send: async () => ({ status: 'ok', response: { payload: { templates: [] } } })
  });
  assert.deepEqual(await resume.read(), { status: 'ok', data: { templates: [] }, desktopVersion: '0.4.4' });
  const other = await resume.setActiveTemplate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal('desktopVersion' in other, false);
  probe.appVersion = undefined;
  assert.deepEqual(await resume.read(), { status: 'ok', data: { templates: [] } });
});

test('握手成功时把桌面版本交给调用方', async () => {
  const { createStore } = await import('../extension/link/store.mjs');
  const { createSession } = await import('../extension/link/session.mjs');
  const data = {};
  const storage = { get: async keys => Object.fromEntries([].concat(keys).filter(key => key in data).map(key => [key, data[key]])), set: async values => { Object.assign(data, values); } };
  const session = createSession({
    store: createStore({ storage, uuid: () => '11111111-1111-4111-8111-111111111111' }),
    send: async message => ({ status: 'ok', resultId: null, response: { protocolVersion: 2, correlationId: message.messageId, ok: true, payload: {
      appVersion: '0.4.4', minProtocolVersion: 1, maxProtocolVersion: 2, archiveId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      restoreEpoch: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', capabilities: ['handshake'] } } }),
    uuid: () => '33333333-3333-4333-8333-333333333333',
    now: () => new Date('2026-11-07T00:00:00.000Z'),
    getManifest: () => ({ version: '0.5.0' })
  });
  const probe = await session.probe();
  assert.equal(probe.mode, 'ready');
  assert.equal(probe.appVersion, '0.4.4');
});

test('手动反馈带上桌面版本，自动上报不带', async () => {
  const { createFeedback } = await import('../extension/link/feedback.mjs');
  const data = {};
  const sent = [];
  const service = createFeedback({
    storage: { get: async () => structuredClone(data), set: async value => Object.assign(data, structuredClone(value)) },
    now: () => 1800000000000, version: '0.5.0', os: 'Windows / Edge 140', timeoutMs: 20,
    fetchImpl: async (url, request) => { sent.push(JSON.parse(request.body)); return new Response(JSON.stringify({ ok: true, id: 'test-1' })); }
  });
  assert.equal(service.preview({ description: '按钮不可用', desktopVersion: '0.4.4' }).user_description,
    '按钮不可用\n--- 诊断信息 v1 ---\n[来源]\napp_version: 0.5.0\nos: Windows / Edge 140\nbuild: dev\ndesktop_version: 0.4.4');
  for (const odd of ['', '0.4.4\nhost: evil.example', '下一版', undefined]) {
    assert.ok(!service.preview({ description: 'x', desktopVersion: odd }).user_description.includes('desktop_version'), String(odd));
  }
  await service.setConsent(true);
  await service.automatic({ kind: 'fill_failed', desktopVersion: '0.4.4' }, 'c.liepin.com');
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].user_description.includes('desktop_version'), sent[0].user_description);
});

function loadBackground({ contexts }) {
  let updateListener = null;
  const session = {};
  let reloads = 0;
  const chrome = {
    action: { onClicked: { addListener() {} } },
    runtime: {
      id: 'ext', getURL: name => `chrome-extension://ext/${name}`, onMessage: { addListener() {} },
      getContexts: async () => { if (contexts instanceof Error) throw contexts; return contexts; },
      onUpdateAvailable: { addListener: listener => { updateListener = listener; } },
      reload: () => { reloads += 1; }
    },
    storage: { local: { get: async () => ({}), set: async () => {} }, session: { set: async values => { Object.assign(session, values); } } }
  };
  const context = vm.createContext({ chrome, TextEncoder, URL, console });
  context.self = context;
  const background = source('background.js')
    .replace(/^import \{ installDesktopLink \} from "\.\/link\/worker\.mjs";$/m, 'const installDesktopLink = () => {};')
    .replace(/^import \{ installFeedback \} from "\.\/link\/feedback\.mjs";$/m, 'const installFeedback = () => {};')
    .replace(/^import "\.\/[\w-]+\.js";$/gm, '');
  vm.runInContext(background, context);
  return {
    fire: async version => { updateListener({ version }); for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve)); },
    session: () => JSON.parse(JSON.stringify(session)), reloads: () => reloads
  };
}

test('新版本下载好时，插件没在用就直接重新加载', async () => {
  const bg = loadBackground({ contexts: [{ contextType: 'BACKGROUND' }] });
  await bg.fire('0.5.1');
  assert.equal(bg.reloads(), 1);
  assert.deepEqual(bg.session(), {});
});

test('侧栏、插件页面或 AI 请求进程开着时不重新加载，记下来让侧栏提示', async () => {
  for (const open of ['SIDE_PANEL', 'POPUP', 'TAB', 'OFFSCREEN_DOCUMENT']) {
    const bg = loadBackground({ contexts: [{ contextType: 'BACKGROUND' }, { contextType: open }] });
    await bg.fire('0.5.1');
    assert.equal(bg.reloads(), 0, open);
    assert.deepEqual(bg.session(), { extensionUpdateReady: { version: '0.5.1' } }, open);
  }
  // 查不了开着什么，就当在用。
  const bg = loadBackground({ contexts: new Error('unsupported') });
  await bg.fire('0.5.1');
  assert.equal(bg.reloads(), 0);
  assert.deepEqual(bg.session(), { extensionUpdateReady: { version: '0.5.1' } });
});

function element() {
  const listeners = {};
  return {
    listeners, dataset: {}, hidden: false, disabled: false, value: '', textContent: '', innerHTML: '',
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(type, listener) { listeners[type] = listener; },
    querySelectorAll() { return []; },
    querySelector() { return { textContent: '' }; }
  };
}

async function panel({ read, installType = 'normal', ready = null, sessionRead = null }) {
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const created = [];
  const storageListeners = [];
  let reloads = 0;
  const chrome = {
    runtime: {
      id: 'diagjmploldedipjdenmecmjokckelkl',
      getManifest: () => ({ version: '0.5.0' }),
      reload: () => { reloads += 1; },
      sendMessage: async message => (message.type === 'DESKTOP_RESUME_READ' ? read : {})
    },
    management: { getSelf: async () => ({ installType }) },
    storage: {
      local: { get: async () => ({}) },
      session: { get: sessionRead || (async () => (ready ? { extensionUpdateReady: { version: ready } } : {})) },
      onChanged: { addListener(listener) { storageListeners.push(listener); } }
    },
    tabs: {
      query: async () => [{ id: 9 }],
      sendMessage: async () => ({ ready: true, ok: true }),
      create: async options => { created.push(options.url); },
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} }
    }
  };
  const document = {
    hidden: false, getElementById: get, querySelectorAll: () => [], querySelector: () => ({ click() {}, open: false }), addEventListener() {}
  };
  const context = vm.createContext({
    document, chrome, navigator: { clipboard: { writeText: async () => {} } },
    self: {
      ResumeProProfile: require('../extension/profile-fields.js'), ResumeProResumeData: require('../extension/resume-data.js'),
      ResumeProCompose: require('../extension/sidepanel-compose.js'), ResumeProUpdateReminder: reminders
    },
    setTimeout: () => 1, clearTimeout() {}, setInterval() {}
  });
  vm.runInContext(source('sidepanel.js'), context);
  const tick = async () => { for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve)); };
  await tick();
  const strip = get('update-reminder');
  const action = get('update-reminder-action');
  return {
    strip, text: () => get('update-reminder-text').textContent, action, created, reloads: () => reloads, tick,
    click: async () => { await action.listeners.click(); await tick(); },
    sessionChanged: async version => { for (const listener of storageListeners) listener({ extensionUpdateReady: { newValue: version ? { version } : undefined } }, 'session'); await tick(); }
  };
}

const data = { templates: [], activeTemplate: null, profile: { values: {}, family: [], custom: [] }, profileRevision: 1 };

test('侧栏：桌面太旧时一直提示，点了打开下载页', async () => {
  const p = await panel({ read: { status: 'ok', data, desktopVersion: '0.4.4' } });
  assert.equal(p.strip.hidden, false);
  assert.match(p.text(), /0\.4\.4/);
  assert.equal(p.action.textContent, '去下载');
  await p.click();
  assert.deepEqual(p.created, [require('../extension/resume-data.js').DOWNLOAD_URL]);
});

test('侧栏：桌面版本对得上、没连上桌面时都不提示', async () => {
  assert.equal((await panel({ read: { status: 'ok', data, desktopVersion: '0.5.0' } })).strip.hidden, true);
  assert.equal((await panel({ read: { status: 'ok', data } })).strip.hidden, true);
  // 没连上就不知道现在的桌面是哪一版，「桌面需更新」另有提示。
  assert.equal((await panel({ read: { status: 'unavailable', desktopVersion: '0.4.4' } })).strip.hidden, true);
});

test('侧栏：解压安装的插件提示改装商店版', async () => {
  const p = await panel({ read: { status: 'ok', data, desktopVersion: '0.5.0' }, installType: 'development' });
  assert.equal(p.strip.hidden, false);
  assert.match(p.text(), /解压安装/);
  assert.match(p.text(), /待同步/, '移除插件会删掉还没同步到桌面的记录');
  await p.click();
  assert.deepEqual(p.created, [reminders.STORE_URL]);
});

test('侧栏：新版本已下载时给「重新加载」，后台记下的变化也跟着显示', async () => {
  const p = await panel({ read: { status: 'ok', data, desktopVersion: '0.5.0' }, ready: '0.5.1' });
  assert.equal(p.strip.hidden, false);
  assert.equal(p.action.textContent, '重新加载');
  await p.click();
  assert.equal(p.reloads(), 1);

  const later = await panel({ read: { status: 'ok', data, desktopVersion: '0.5.0' } });
  assert.equal(later.strip.hidden, true);
  await later.sessionChanged('0.5.1');
  assert.equal(later.strip.hidden, false);
  assert.match(later.text(), /0\.5\.1/);
});

test('侧栏：启动时的读取比变化通知晚回来，不会盖掉新版本', async () => {
  let answer;
  const late = new Promise(resolve => { answer = resolve; });
  const p = await panel({ read: { status: 'ok', data, desktopVersion: '0.5.0' }, sessionRead: () => late });
  await p.sessionChanged('0.5.1');
  assert.equal(p.action.textContent, '重新加载');
  answer({});
  await p.tick();
  assert.equal(p.strip.hidden, false);
  assert.equal(p.action.textContent, '重新加载');
});
