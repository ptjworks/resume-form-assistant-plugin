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
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

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

  // Only the statuses listed above leave this module; any other desktop code reads as unavailable.
  function failure(result) {
    if (result.status === 'fatal') {
      if (result.code === 'conflict') return { status: 'conflict' };
      if (result.code === 'invalid_payload') return { status: 'invalid_payload' };
      if (['protocol_incompatible', 'unknown_message_type'].includes(result.code)) return { status: 'unsupported' };
      return { status: 'unavailable' };
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
    if (!file || !(typeof file.fileId === 'string' && UUID.test(file.fileId))
        || !(typeof file.sha256 === 'string' && SHA256.test(file.sha256))
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
    const drop = () => {
      const current = channel;
      channel = null;
      // A port that fails to close changes nothing about what was read; fetch still answers with a status.
      try {
        current?.close();
      } catch {}
    };
    // A port that reported an error (the host exited, or never came up) is not used again: the
    // next request, the retry of the first chunk, goes out on a new one.
    const sendNative = async (host, message) => {
      channel ??= openChannel();
      const reply = await channel.send(host, message);
      if (reply?.lastError) drop();
      return reply;
    };
    try {
      for (let index = 0; index < count; index += 1) {
        const message = await envelope('resumeFiles.read', { fileId: file.fileId, sha256: file.sha256, chunkIndex: index }, gate.probe);
        // Only the first chunk can meet a desktop that is still starting; a failure later ends the read.
        const result = await send(message, { sendNative, sleep, retry: index === 0 });
        // A reply the validator refused (a chunk of the wrong length, say) is the desktop's data being wrong, not the desktop being away.
        if (result.status === 'retryable' && result.code === 'invalid_payload') return { status: 'corrupt' };
        if (result.status !== 'ok') return failure(result);
        const chunk = result.response.payload;
        // The transport's validator checks the echo as well; a reply for another file or chunk is never used.
        if (chunk.fileId !== file.fileId || chunk.sha256 !== file.sha256 || chunk.chunkIndex !== index) return { status: 'corrupt' };
        if (chunk.byteSize !== file.byteSize || chunk.chunkCount !== count) return { status: 'conflict' };
        let piece;
        try {
          piece = decodeStandardBase64(chunk.bytesBase64);
        } catch {
          return { status: 'corrupt' };
        }
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
      drop();
    }
  }

  return { list, fetch };
}
