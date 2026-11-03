// #429 item 4: a desktop file reaches a web page only after the user said yes in the side panel.
// The panel tells the service worker which tab, which site, which card and which files; a content
// script then gets each of those files once, for that tab, that page address (the whole of it) and
// that card only, within a few minutes. The tab closing or moving to another address takes the yes
// with it (coming back does not bring it back), and so does the page itself when it moves on or its
// upload ends. Anything else is refused here, whatever the content script asks for. Grants live in
// the worker's memory only.
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
export const RESUME_FILES_RELEASE = 'DESKTOP_RESUME_FILES_RELEASE';
export const RESUME_FILE_FETCH = 'DESKTOP_RESUME_FILE_FETCH';
export const GRANT_TTL_MS = 10 * 60 * 1000;
// How long the worker reads one file before it gives up and lets the hold go: shorter than the
// page waits (60 s in content.js), so the page hears back first and the yes is not used up.
export const FETCH_TIMEOUT_MS = 45 * 1000;
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

/** A file bound to templates is for those templates only; an unbound one is for any. */
export function usableFor(file, templateId) {
  const ids = Array.isArray(file?.templateIds) ? file.templateIds : [];
  return !ids.length || (Boolean(templateId) && ids.includes(templateId));
}

export function createUploadGrants({ now = () => Date.now() } = {}) {
  // tabId -> { origin, url, card, templateId, files: Map<fileId, { sha256, claim }>, expires }
  const grants = new Map();

  /**
   * The user's yes for one card in one tab: `url` is the address the tab showed when the panel
   * asked (the whole address: a single-page app that moves on, even on the same site, is another
   * page), `card` the card's `${epoch}:${version}`, `files` the [{ fileId, sha256 }] it listed,
   * `templateId` the template the panel had in use. A new yes for the same tab replaces the old one.
   */
  function grant(tabId, url, card, files, templateId = '') {
    const origin = originOf(url);
    if (!Number.isInteger(tabId) || !origin) return false;
    if (typeof card !== 'string' || !CARD.test(card)) return false;
    if (typeof templateId !== 'string' || templateId.length > 128) return false;
    const list = Array.isArray(files) ? files : [];
    if (!list.length || list.length > MAX_GRANTED_FILES) return false;
    const granted = new Map();
    for (const file of list) {
      if (typeof file?.fileId !== 'string' || !file.fileId || file.fileId.length > 64 || !SHA256.test(file?.sha256 ?? '')) return false;
      granted.set(file.fileId, { sha256: file.sha256, claim: null });
    }
    grants.set(tabId, { origin, url: String(url), card, templateId, files: granted, expires: now() + GRANT_TTL_MS });
    return true;
  }

  function held(tabId, url, fileId, card) {
    const entry = grants.get(tabId);
    if (!entry) return null;
    if (now() > entry.expires) { grants.delete(tabId); return null; }
    if (url !== entry.url || card !== entry.card) return null;
    const file = typeof fileId === 'string' ? entry.files.get(fileId) : undefined;
    return file ? { entry, file } : null;
  }

  /**
   * Hold one file of the yes for the card `card` shown by the frame at `url` in `tabId` while it
   * is read: { sha256, templateId, token }; 'busy' while another request holds it; null when
   * there is no such yes. Holding does not use the yes up (see settle).
   */
  function claim(tabId, url, fileId, card) {
    const found = held(tabId, url, fileId, card);
    if (!found) return null;
    if (found.file.claim) return 'busy';
    const token = Symbol('claim');
    found.file.claim = token;
    return { sha256: found.file.sha256, templateId: found.entry.templateId, token };
  }

  /**
   * End a hold: `used` true hands the file over and uses up the yes for it; false lets it go, and
   * the yes stays for another try. False when the hold is no longer this one (it timed out).
   */
  function settle(tabId, fileId, card, token, used) {
    const entry = grants.get(tabId);
    const file = entry && entry.card === card ? entry.files.get(fileId) : undefined;
    if (!file || file.claim !== token) return false;
    if (!used) {
      file.claim = null;
      return true;
    }
    entry.files.delete(fileId);
    if (!entry.files.size) grants.delete(tabId);
    return true;
  }

  /** Hold and use up at once: the yes for one file, at most once. */
  function take(tabId, url, fileId, card) {
    const claimed = claim(tabId, url, fileId, card);
    if (!claimed || claimed === 'busy') return null;
    settle(tabId, fileId, card, claimed.token, true);
    return { sha256: claimed.sha256, templateId: claimed.templateId };
  }

  function revoke(tabId) {
    grants.delete(tabId);
  }

  /** A page gives back what is left of the yes for its own card (it moved on, or its upload ended). */
  function release(tabId, card) {
    if (grants.get(tabId)?.card === card) grants.delete(tabId);
  }

  /**
   * Where the tab is now, as the worker last saw it (tabs.onUpdated, tabs.get). Once that is another
   * address than the one the yes was for, the yes goes and stays gone, even if the page comes back.
   */
  function seen(tabId, url) {
    const entry = grants.get(tabId);
    if (entry && url !== entry.url) grants.delete(tabId);
  }

  return { grant, claim, settle, take, revoke, release, seen };
}

/**
 * A tab that closes or moves to another address (a single-page app's too) loses its yes, and keeps
 * it lost when it comes back. The worker hears of every move from tabs.onUpdated (a new url comes
 * with pushState, a new hash and history.back as well) and looks at where the tab is when a file
 * is taken (tabs.get); it does not ask for webNavigation. A message's sender.url does not help: it
 * stays where the page loaded. The page also gives its card back when it notices it moved.
 */
export function revokeOnNavigation(api, grants) {
  api.tabs?.onRemoved?.addListener?.(tabId => grants.revoke(tabId));
  api.tabs?.onUpdated?.addListener?.((tabId, change) => {
    if (change?.url) grants.seen(tabId, change.url);
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
 * The six messages. `files` is createResumeFiles(): list() and fetch(row). `slots` is
 * upload-slots.js (chooseFile, MAX_FILE_BYTES), so a page's boxes get files by the same rules
 * as everywhere else. Returns true when the answer comes later (the listener keeps the port
 * open), false when it was sent already, and null when the message is not one of these.
 */
export function handleUploadMessage({ api, grants, files, slots, fetchTimeoutMs = FETCH_TIMEOUT_MS }, message, sender, sendResponse) {
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
    // The yes is for the address the tab shows now, the whole of it.
    Promise.resolve(api.tabs.get(message.tabId)).then(tab => {
      const origin = originOf(tab?.url);
      if (!origin || origin !== message.origin) return { status: 'stale' };
      return grants.grant(message.tabId, tab.url, message.card, message.files, message.templateId ?? '') ? { status: 'ok' } : { status: 'invalid_payload' };
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
  if (type === RESUME_FILES_RELEASE) {
    // The page moved on, or its upload ended: what is left of the yes for its card goes.
    if (!fromTopFrame(sender, api)) { sendResponse({ status: 'forbidden' }); return false; }
    if (typeof message.card === 'string') grants.release(sender.tab.id, message.card);
    sendResponse({ status: 'ok' });
    return false;
  }
  if (type === RESUME_FILE_FETCH) {
    if (!fromTopFrame(sender, api)) { sendResponse({ status: 'forbidden' }); return false; }
    const tabId = sender.tab.id;
    const { fileId, card } = message;
    // Read one held file: the yes is used up only when the file is handed over. A desktop that
    // fails, or a read that runs past fetchTimeoutMs (shorter than the page's own wait), lets the
    // hold go and the yes stays.
    const deliver = claimed => {
      const settle = used => grants.settle(tabId, fileId, card, claimed.token, used);
      let timer = null;
      const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(null), fetchTimeoutMs); });
      const work = (async () => {
        // The version the user confirmed must still be the one on the desktop, and still be for
        // the template the panel had in use (the panel lists only those; this does not rely on it).
        const listed = await files.list();
        if (listed.status !== 'ok') return { status: listed.status };
        const row = listed.files.find(file => file.fileId === fileId && file.sha256 === claimed.sha256);
        if (!row) return { status: 'conflict' };
        if (!usableFor(row, claimed.templateId)) return { status: 'wrong_template' };
        const read = await files.fetch(row);
        if (read.status !== 'ok') return { status: read.status };
        return { status: 'ok', name: row.name, mime: row.mime, kind: row.kind, byteSize: row.byteSize, updatedAt: row.updatedAt,
          bytesBase64: read.bytesBase64 };
      })();
      return Promise.race([work, deadline]).then(reply => {
        clearTimeout(timer);
        // Past the deadline: the page stops waiting soon; whatever the read brings later is dropped.
        if (!reply) { settle(false); return { status: 'unavailable' }; }
        if (reply.status !== 'ok') { settle(false); return reply; }
        return settle(true) ? reply : { status: 'not_confirmed' };
      }, () => {
        clearTimeout(timer);
        settle(false);
        return { status: 'unavailable' };
      });
    };
    // Check the yes against where the tab is now. sender.url is where the page loaded: a
    // single-page app that moved since (pushState, a new hash) still reports that address, so it
    // says nothing about where the tab is; tabs.get does. A tab seen at another address than the
    // yes was for loses it for good. The file is held before anything is read, so a second
    // request for it reads nothing.
    Promise.resolve().then(() => api.tabs.get(tabId)).then(tab => String(tab?.url || ''), () => '').then(address => {
      grants.seen(tabId, address);
      const claimed = grants.claim(tabId, address, fileId, card);
      if (claimed === 'busy') return { status: 'busy' };
      if (!claimed) return { status: 'not_confirmed' };
      return deliver(claimed);
    }).then(sendResponse, () => sendResponse({ status: 'unavailable' }));
    return true;
  }
  return null;
}
