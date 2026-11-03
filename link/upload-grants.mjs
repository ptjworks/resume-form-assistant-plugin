// #429 item 4: a desktop file reaches a web page only after the user said yes in the side panel.
// The panel tells the service worker which tab, which site and which files; a content script then
// gets each of those files once, for that tab and site only, within a few minutes. Anything else is
// refused here, whatever the content script asks for. Grants live in the worker's memory only.

export const RESUME_FILES_LIST = 'DESKTOP_RESUME_FILES_LIST';
export const RESUME_FILES_GRANT = 'DESKTOP_RESUME_FILES_GRANT';
export const RESUME_FILES_REVOKE = 'DESKTOP_RESUME_FILES_REVOKE';
export const RESUME_FILE_FETCH = 'DESKTOP_RESUME_FILE_FETCH';
export const GRANT_TTL_MS = 10 * 60 * 1000;
const MAX_GRANTED_FILES = 30;
const SHA256 = /^[0-9a-f]{64}$/;

/** The origin of an http(s) page address, or '' for anything else. */
export function originOf(url) {
  try {
    const parsed = new URL(String(url ?? ''));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : '';
  } catch {
    return '';
  }
}

/** The extension's own side panel, never a page or a content script. */
export function fromSidePanel(sender, api) {
  return sender?.id === api.runtime.id && !sender?.tab && sender?.url === api.runtime.getURL('sidepanel.html');
}

/** The extension's own content script in a tab's top frame. */
export function fromTopFrame(sender, api) {
  return sender?.id === api.runtime.id && Boolean(sender?.tab) && Number.isInteger(sender.tab.id)
    && sender.frameId === 0 && typeof sender.url === 'string';
}

export function createUploadGrants({ now = () => Date.now() } = {}) {
  // tabId -> { origin, files: Map<fileId, sha256>, expires }
  const grants = new Map();

  /**
   * The user's yes for one tab: `origin` is the site the panel showed, `files` the
   * [{ fileId, sha256 }] it listed. A new yes for the same tab replaces the old one.
   */
  function grant(tabId, origin, files) {
    if (!Number.isInteger(tabId) || !originOf(origin) || originOf(origin) !== origin) return false;
    const list = Array.isArray(files) ? files : [];
    if (!list.length || list.length > MAX_GRANTED_FILES) return false;
    const granted = new Map();
    for (const file of list) {
      if (typeof file?.fileId !== 'string' || !file.fileId || file.fileId.length > 64 || !SHA256.test(file?.sha256 ?? '')) return false;
      granted.set(file.fileId, file.sha256);
    }
    grants.set(tabId, { origin, files: granted, expires: now() + GRANT_TTL_MS });
    return true;
  }

  /** One file for the frame at `url` in `tabId`; true at most once per granted file. */
  function take(tabId, url, fileId, sha256) {
    const held = grants.get(tabId);
    if (!held) return false;
    if (now() > held.expires) { grants.delete(tabId); return false; }
    if (originOf(url) !== held.origin) return false;
    if (typeof fileId !== 'string' || held.files.get(fileId) !== sha256) return false;
    held.files.delete(fileId);
    if (!held.files.size) grants.delete(tabId);
    return true;
  }

  function revoke(tabId) {
    grants.delete(tabId);
  }

  return { grant, take, revoke };
}

/**
 * The four messages. `files` is createResumeFiles(): list() and fetch(row). Returns true when the
 * answer comes later (the listener keeps the port open), false when it was sent already, and null
 * when the message is not one of these.
 */
export function handleUploadMessage({ api, grants, files }, message, sender, sendResponse) {
  const type = message?.type;
  if (type === RESUME_FILES_LIST) {
    if (!fromSidePanel(sender, api) && !fromTopFrame(sender, api)) { sendResponse({ status: 'forbidden' }); return false; }
    files.list().then(sendResponse, () => sendResponse({ status: 'unavailable' }));
    return true;
  }
  if (type === RESUME_FILES_GRANT) {
    if (!fromSidePanel(sender, api)) { sendResponse({ status: 'forbidden' }); return false; }
    // The tab must still show the site the panel asked about; a tab that moved on gets nothing.
    Promise.resolve(api.tabs.get(message.tabId)).then(tab => {
      const origin = originOf(tab?.url);
      if (!origin || origin !== message.origin) return { status: 'stale' };
      return grants.grant(message.tabId, origin, message.files) ? { status: 'ok' } : { status: 'invalid_payload' };
    }).then(sendResponse, () => sendResponse({ status: 'stale' }));
    return true;
  }
  if (type === RESUME_FILES_REVOKE) {
    // The page turned the panel's yes down (the card had gone stale): that yes goes too.
    if (!fromSidePanel(sender, api)) { sendResponse({ status: 'forbidden' }); return false; }
    if (Number.isInteger(message.tabId)) grants.revoke(message.tabId);
    sendResponse({ status: 'ok' });
    return false;
  }
  if (type === RESUME_FILE_FETCH) {
    if (!fromTopFrame(sender, api)) { sendResponse({ status: 'forbidden' }); return false; }
    if (!grants.take(sender.tab.id, sender.url, message.fileId, message.sha256)) { sendResponse({ status: 'not_confirmed' }); return false; }
    (async () => {
      // The version the user confirmed must still be the one on the desktop.
      const listed = await files.list();
      if (listed.status !== 'ok') return { status: listed.status };
      const row = listed.files.find(file => file.fileId === message.fileId && file.sha256 === message.sha256);
      if (!row) return { status: 'conflict' };
      return files.fetch(row);
    })().then(sendResponse, () => sendResponse({ status: 'unavailable' }));
    return true;
  }
  return null;
}
