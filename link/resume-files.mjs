import { buildEnvelope } from './envelope.mjs';
import { sendOnce } from './transport.mjs';
import { decodeStandardBase64, MAX_RESUME_FILE_BYTES, RESUME_FILE_CHUNK_BYTES, sha256Hex, validateRequest } from './protocol/validate.mjs';

// #429: files kept on the desktop for upload — resume, photo, transcript, other material.
// The list is read once per fill. A file is read chunk by chunk over one Native Messaging
// port and checked twice before anything is handed on: every chunk against its digest, the
// whole file against the digest it was listed with. Nothing here is written to storage.

/**
 * Replies carry a status:
 *   ok           list: { files }; fetch: { name, mime, byteSize, sha256, bytesBase64 }
 *   unsupported  the desktop predates #429 and does not announce resumeFiles.*
 *   conflict     the file was replaced or deleted on the desktop since it was listed, or its
 *                stored bytes no longer match its record
 *   corrupt      a chunk or the assembled file did not match its digest
 *   invalid_payload, unavailable, or a session mode (not_installed, not_paired, ...)
 */
export function createResumeFiles({ session, store, sendNative, openChannel, sleep, uuid, now, send = sendOnce }) {
  async function ready(messageType) {
    const probe = await session.probe();
    if (probe.mode !== 'ready') return { status: probe.mode };
    // A desktop that predates #429 does not announce these, and is never sent them.
    if (!probe.capabilities?.includes(messageType)) return { status: 'unsupported' };
    return { probe };
  }

  async function envelope(messageType, payload, probe) {
    const message = await buildEnvelope({
      messageType,
      messageId: uuid(),
      clientInstanceId: await store.clientInstanceId(),
      payload,
      identity: probe.identity,
      now
    });
    await validateRequest(message);
    return message;
  }

  function failure(result) {
    if (result.status === 'fatal') {
      if (result.code === 'conflict') return { status: 'conflict' };
      if (['protocol_incompatible', 'unknown_message_type'].includes(result.code)) return { status: 'unsupported' };
      return { status: result.code ?? 'unavailable' };
    }
    if (result.status === 'not_installed' || result.status === 'not_paired') return { status: result.status };
    return { status: 'unavailable' };
  }

  async function list() {
    const gate = await ready('resumeFiles.list');
    if (!gate.probe) return gate;
    try {
      const result = await send(await envelope('resumeFiles.list', {}, gate.probe), { sendNative, sleep });
      return result.status === 'ok' ? { status: 'ok', files: result.response.payload.files } : failure(result);
    } catch {
      return { status: 'unavailable' };
    }
  }

  /** `file` is a row from list(): the version to read is the one listed (its sha256). */
  async function fetch(file) {
    const gate = await ready('resumeFiles.read');
    if (!gate.probe) return gate;
    if (!file || typeof file.fileId !== 'string' || typeof file.sha256 !== 'string'
        || !Number.isInteger(file.byteSize) || file.byteSize < 1 || file.byteSize > MAX_RESUME_FILE_BYTES) {
      return { status: 'invalid_payload' };
    }
    const count = Math.ceil(file.byteSize / RESUME_FILE_CHUNK_BYTES);
    const bytes = new Uint8Array(file.byteSize);
    const pieces = [];
    let channel;
    try {
      channel = openChannel();
    } catch {
      // The browser refused the port: the same as a desktop that cannot be reached.
      return { status: 'unavailable' };
    }
    try {
      for (let index = 0; index < count; index += 1) {
        const message = await envelope('resumeFiles.read', { fileId: file.fileId, sha256: file.sha256, chunkIndex: index }, gate.probe);
        // Only the first chunk can meet a desktop that is still starting; a failure later ends the read.
        const result = await send(message, { sendNative: channel.send, sleep, retry: index === 0 });
        // A reply the validator refused (a chunk of the wrong length, say) is the desktop's data being wrong, not the desktop being away.
        if (result.status === 'retryable' && result.code === 'invalid_payload') return { status: 'corrupt' };
        if (result.status !== 'ok') return failure(result);
        const chunk = result.response.payload;
        if (chunk.byteSize !== file.byteSize || chunk.chunkCount !== count) return { status: 'conflict' };
        const piece = decodeStandardBase64(chunk.bytesBase64);
        const expected = index + 1 === count ? file.byteSize - index * RESUME_FILE_CHUNK_BYTES : RESUME_FILE_CHUNK_BYTES;
        if (piece.length !== expected || await sha256Hex(piece) !== chunk.chunkSha256) return { status: 'corrupt' };
        bytes.set(piece, index * RESUME_FILE_CHUNK_BYTES);
        pieces.push(chunk.bytesBase64);
      }
      if (await sha256Hex(bytes) !== file.sha256) return { status: 'corrupt' };
      // Every chunk but the last is a whole number of Base64 groups, so the pieces join as they are.
      return { status: 'ok', name: file.name, mime: file.mime, byteSize: file.byteSize, sha256: file.sha256, bytesBase64: pieces.join('') };
    } catch {
      return { status: 'unavailable' };
    } finally {
      channel.close();
    }
  }

  return { list, fetch };
}
