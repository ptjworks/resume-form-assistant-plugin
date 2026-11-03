// #429 item 4: a desktop file reaches a web page only after the user said yes in the side panel.
// The panel tells the service worker which tab, which site, which card and which files; a content
// script then gets each of those files once, for that tab, site and card only, within a few
// minutes. The tab closing or moving to another address takes the yes with it. Anything else is
// refused here, whatever the content script asks for. Grants live in the worker's memory only.
//
// Metadata and content are kept apart. The file list (names, labels, sizes, types, template
// bindings, digests) goes to the side panel alone, which shows it on the card. A page's content
// script never gets the list: it describes its upload boxes and hears back, per box, which file
// id would go there or why none would, plus a size when every candidate is too large. File bytes,
// with the name and type the page needs to hand them over, go only to the page the user confirmed.

export const RESUME_FILES_LIST = 'DESKTOP_RESUME_FILES_LIST';
export const RESUME_FILES_PLAN = 'DESKTOP_RESUME_FILES_PLAN';
export const RESUME_FILES_GRANT = 'DESKTOP_RESUME_FILES_GRANT';
export const RESUME_FILES_REVOKE = 'DESKTOP_RESUME_FILES_REVOKE';
export const RESUME_FILE_FETCH = 'DESKTOP_RESUME_FILE_FETCH';
export const GRANT_TTL_MS = 10 * 60 * 1000;
const MAX_GRANTED_FILES = 30;
const MAX_PLANNED_SLOTS = 30;
const SHA256 = /^[0-9a-f]{64}$/;
// The card the user said yes to: the page load's epoch and the card's version (content.js).
const CARD = /^[\w-]{1,64}:\d{1,9}$/;
const SLOT_ID = /^upload-\d{1,3}$/;
const PLANNED_KINDS = ['resume', 'photo', 'transcript'];
const LANGUAGES = ['zh', 'en'];

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
  // tabId -> { origin, card, files: Map<fileId, sha256>, expires }
  const grants = new Map();

  /**
   * The user's yes for one card in one tab: `origin` is the site the panel showed, `card` the
   * card's `${epoch}:${version}`, `files` the [{ fileId, sha256 }] it listed. A new yes for the
   * same tab replaces the old one.
   */
  function grant(tabId, origin, card, files) {
    if (!Number.isInteger(tabId) || !originOf(origin) || originOf(origin) !== origin) return false;
    if (typeof card !== 'string' || !CARD.test(card)) return false;
    const list = Array.isArray(files) ? files : [];
    if (!list.length || list.length > MAX_GRANTED_FILES) return false;
    const granted = new Map();
    for (const file of list) {
      if (typeof file?.fileId !== 'string' || !file.fileId || file.fileId.length > 64 || !SHA256.test(file?.sha256 ?? '')) return false;
      granted.set(file.fileId, file.sha256);
    }
    grants.set(tabId, { origin, card, files: granted, expires: now() + GRANT_TTL_MS });
    return true;
  }

  /**
   * One file for the card `card` shown by the frame at `url` in `tabId`: the confirmed digest,
   * at most once per granted file, or '' when there is no such yes.
   */
  function take(tabId, url, fileId, card) {
    const held = grants.get(tabId);
    if (!held) return '';
    if (now() > held.expires) { grants.delete(tabId); return ''; }
    if (originOf(url) !== held.origin || card !== held.card) return '';
    const sha256 = typeof fileId === 'string' ? held.files.get(fileId) : undefined;
    if (!sha256) return '';
    held.files.delete(fileId);
    if (!held.files.size) grants.delete(tabId);
    return sha256;
  }

  function revoke(tabId) {
    grants.delete(tabId);
  }

  return { grant, take, revoke };
}

/** A tab that closes or moves to another address (a single-page app's too) loses its yes. */
export function revokeOnNavigation(api, grants) {
  api.tabs?.onRemoved?.addListener?.(tabId => grants.revoke(tabId));
  api.tabs?.onUpdated?.addListener?.((tabId, change) => {
    if (change?.url) grants.revoke(tabId);
  });
}

/** A page's plan request: the boxes it found that want a resume, a photo or a transcript. */
function planRequest(message, maxBytes) {
  const list = Array.isArray(message?.slots) ? message.slots : null;
  if (!list || list.length > MAX_PLANNED_SLOTS) return null;
  if (typeof message.templateId !== 'string' || message.templateId.length > 128) return null;
  const slots = [];
  for (const slot of list) {
    if (!SLOT_ID.test(slot?.id ?? '') || !PLANNED_KINDS.includes(slot.kind)) return null;
    if (typeof slot.accept !== 'string' || slot.accept.length > 2000) return null;
    if (!Number.isInteger(slot.limit) || slot.limit <= 0 || slot.limit > maxBytes) return null;
    const language = slot.language ?? [];
    if (!Array.isArray(language) || language.length > LANGUAGES.length || !language.every(key => LANGUAGES.includes(key))) return null;
    slots.push({ id: slot.id, kind: slot.kind, accept: slot.accept, limit: slot.limit, language: [...language] });
  }
  return { templateId: message.templateId, slots };
}

/**
 * The five messages. `files` is createResumeFiles(): list() and fetch(row). `slots` is
 * upload-slots.js (chooseFile, MAX_FILE_BYTES), so a page's boxes get files by the same rules
 * as everywhere else. Returns true when the answer comes later (the listener keeps the port
 * open), false when it was sent already, and null when the message is not one of these.
 */
export function handleUploadMessage({ api, grants, files, slots }, message, sender, sendResponse) {
  const type = message?.type;
  if (type === RESUME_FILES_LIST) {
    // Names, labels and sizes are for the card in the side panel only.
    if (!fromSidePanel(sender, api)) { sendResponse({ status: 'forbidden' }); return false; }
    files.list().then(sendResponse, () => sendResponse({ status: 'unavailable' }));
    return true;
  }
  if (type === RESUME_FILES_PLAN) {
    if (!fromTopFrame(sender, api)) { sendResponse({ status: 'forbidden' }); return false; }
    const request = planRequest(message, slots.MAX_FILE_BYTES);
    if (!request) { sendResponse({ status: 'invalid_payload' }); return false; }
    files.list().then(listed => {
      if (listed.status !== 'ok') return { status: listed.status };
      return {
        status: 'ok',
        slots: request.slots.map(slot => {
          const chosen = slots.chooseFile(slot, listed.files, { templateId: request.templateId });
          return { id: slot.id, fileId: chosen.fileId || '', reason: chosen.reason || '',
            ...(Number.isInteger(chosen.byteSize) ? { byteSize: chosen.byteSize } : {}) };
        })
      };
    }).then(sendResponse, () => sendResponse({ status: 'unavailable' }));
    return true;
  }
  if (type === RESUME_FILES_GRANT) {
    if (!fromSidePanel(sender, api)) { sendResponse({ status: 'forbidden' }); return false; }
    // The tab must still show the site the panel asked about; a tab that moved on gets nothing.
    Promise.resolve(api.tabs.get(message.tabId)).then(tab => {
      const origin = originOf(tab?.url);
      if (!origin || origin !== message.origin) return { status: 'stale' };
      return grants.grant(message.tabId, origin, message.card, message.files) ? { status: 'ok' } : { status: 'invalid_payload' };
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
    const sha256 = grants.take(sender.tab.id, sender.url, message.fileId, message.card);
    if (!sha256) { sendResponse({ status: 'not_confirmed' }); return false; }
    (async () => {
      // The version the user confirmed must still be the one on the desktop.
      const listed = await files.list();
      if (listed.status !== 'ok') return { status: listed.status };
      const row = listed.files.find(file => file.fileId === message.fileId && file.sha256 === sha256);
      if (!row) return { status: 'conflict' };
      const read = await files.fetch(row);
      if (read.status !== 'ok') return { status: read.status };
      return { status: 'ok', name: row.name, mime: row.mime, kind: row.kind, byteSize: row.byteSize, updatedAt: row.updatedAt,
        bytesBase64: read.bytesBase64 };
    })().then(sendResponse, () => sendResponse({ status: 'unavailable' }));
    return true;
  }
  return null;
}
