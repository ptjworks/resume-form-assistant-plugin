import { buildEnvelope } from './envelope.mjs';
import { sendOnce } from './transport.mjs';
import { validateRequest } from './protocol/validate.mjs';
// The content scripts' own rule for what a site is (siteKeyOf); it only attaches to globalThis.
import '../profile-fields.js';

// #429: answers remembered per site (a question about the company, such as whether a
// relative works there). The page never names the site itself: the service worker works it
// out from the address of the frame that asked, so a page reads and writes only its own.
export const SITE_ANSWERS_READ = 'DESKTOP_SITE_ANSWERS_READ';
export const SITE_ANSWERS_SAVE = 'DESKTOP_SITE_ANSWERS_SAVE';

/** The site of a page address, or '' for a shared recruiting site (see profile-fields.js). */
export function siteOf(url) {
  return globalThis.ResumeProProfile?.siteKeyOf?.(url) ?? '';
}

/**
 * Only the extension's own content script, in a tab's top frame, may ask; the site is that
 * frame's. Returns the site, or null for any other sender.
 */
export function siteOfSender(sender, extensionId) {
  if (sender?.id !== extensionId || !sender?.tab || sender.frameId !== 0 || typeof sender.url !== 'string') return null;
  return siteOf(sender.url);
}

/**
 * Replies carry a status and never finished text:
 *   ok           { site, answers: [{ key, value }] } — after a save, the site's whole list
 *   no_site      the page is on a shared recruiting site whose company cannot be told apart
 *   unsupported  the desktop predates #429 and does not announce siteAnswers.*
 *   conflict     a saved answer changed on the desktop since the user saw it; nothing written
 *   secret / invalid_payload / input_too_large, or a session mode (not_installed, ...)
 */
export function createSiteAnswers({ session, store, sendNative, sleep, uuid, now, send = sendOnce }) {
  async function request(messageType, payload) {
    const probe = await session.probe();
    if (probe.mode !== 'ready') return { status: probe.mode };
    // A desktop that predates #429 does not announce these, and is never sent them.
    if (!probe.capabilities?.includes(messageType)) return { status: 'unsupported' };
    try {
      const envelope = await buildEnvelope({
        messageType,
        messageId: uuid(),
        clientInstanceId: await store.clientInstanceId(),
        payload,
        identity: probe.identity,
        now
      });
      await validateRequest(envelope);
      const result = await send(envelope, { sendNative, sleep });
      if (result.status === 'ok') {
        const { site, answers } = result.response.payload;
        return { status: 'ok', site, answers };
      }
      if (result.status === 'fatal') {
        if (result.code === 'secret_forbidden') return { status: 'secret' };
        if (result.code === 'payload_too_large') return { status: 'input_too_large' };
        if (['protocol_incompatible', 'unknown_message_type'].includes(result.code)) return { status: 'unsupported' };
        return { status: result.code ?? 'unavailable' };
      }
      if (result.status === 'not_installed' || result.status === 'not_paired') return { status: result.status };
      return { status: 'unavailable' };
    } catch (error) {
      if (error?.code === 'payload_too_large') return { status: 'input_too_large' };
      if (error?.code === 'secret_forbidden') return { status: 'secret' };
      if (error?.code === 'invalid_payload') return { status: 'invalid_payload' };
      return { status: 'unavailable' };
    }
  }

  /** `site` comes from siteKeyOf(sender.url); an empty one means a shared site. */
  async function read(site) {
    if (!site) return { status: 'no_site' };
    return request('siteAnswers.read', { site });
  }

  /**
   * `answers` is [{ key, value, previous? }]; anything else on an item is dropped. `expected` is the
   * site the page reviewed the answers on: when the page has moved to another site since, nothing
   * is written (`stale`).
   */
  async function save(site, answers, expected) {
    if (!site) return { status: 'no_site' };
    if (typeof expected !== 'string' || expected !== site) return { status: 'stale' };
    const items = (Array.isArray(answers) ? answers : []).map(item => ({
      key: String(item?.key ?? ''),
      value: String(item?.value ?? ''),
      ...(typeof item?.previous === 'string' && item.previous ? { previous: item.previous } : {})
    }));
    if (!items.length) return { status: 'invalid_payload' };
    return request('siteAnswers.save', { site, answers: items });
  }

  return { read, save };
}
