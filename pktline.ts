// pkt-line framing for the git smart-HTTP engine: encode, and a strict request decoder that stops
// at the flush-pkt so a receive-pack body can hand the packfile bytes back untouched.

const HEX4 = /^[0-9a-fA-F]{4}$/;

export const PKT_MAX = 65520; // git's LARGE_PACKET_MAX, length header included
export const PKT_MAX_PAYLOAD = PKT_MAX - 4;

/** Encode one data pkt-line: the 4-byte hex length, then the payload. */
export function pktData(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_MAX_PAYLOAD) throw new Error(`pkt-line payload of ${data.length} bytes is over the maximum`);
  const head = Buffer.allocUnsafe(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'latin1');
  return Buffer.concat([head, data]);
}

export function flushPkt(): Buffer {
  return Buffer.from('0000', 'latin1');
}

export function delimPkt(): Buffer {
  return Buffer.from('0001', 'latin1');
}

export interface Pkt {
  readonly kind: 'data' | 'flush' | 'delim';
  /** The payload without the 4-byte length header; null for control packets. */
  readonly payload: Buffer | null;
}

export interface DecodedPktStream {
  readonly packets: Pkt[];
  /** Every byte after the terminating flush-pkt (a receive-pack body's packfile). */
  readonly rest: Buffer;
}

/**
 * Decode a request body's pkt-lines up to and including the first flush-pkt. Control packets other
 * than flush and delim (the sideband '0002') are skipped. A malformed length header, an over-long
 * packet or a truncated stream throws; the caller answers 400 and the server stays up.
 */
export function decodePktStream(buf: Buffer): DecodedPktStream {
  const packets: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (buf.length - off < 4) throw new Error('truncated pkt-line header');
    const hex = buf.toString('latin1', off, off + 4);
    if (!HEX4.test(hex)) throw new Error(`invalid pkt-line length ${JSON.stringify(hex)}`);
    const len = Number.parseInt(hex, 16);
    if (len === 0) {
      off += 4;
      packets.push({ kind: 'flush', payload: null });
      return { packets, rest: buf.subarray(off) };
    }
    if (len === 1) {
      off += 4;
      packets.push({ kind: 'delim', payload: null });
      continue;
    }
    if (len === 2) {
      off += 4;
      continue;
    }
    if (len < 4 || len > PKT_MAX) throw new Error(`invalid pkt-line length ${len}`);
    if (off + len > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, rest: buf.subarray(off) };
}

/**
 * Wrap raw bytes in sideband band frames: every frame's payload is the band byte followed by a
 * chunk of data, each frame a well-formed pkt-line under git's 65520-byte limit.
 */
export function sidebandFrames(data: Buffer, band: number, maxChunk = PKT_MAX_PAYLOAD - 1): Buffer[] {
  const frames: Buffer[] = [];
  for (let off = 0; off < data.length || (off === 0 && data.length === 0); off += maxChunk) {
    const end = Math.min(off + maxChunk, data.length);
    const chunk = data.subarray(off, end);
    const payload = Buffer.allocUnsafe(1 + chunk.length);
    payload[0] = band;
    if (chunk.length > 0) chunk.copy(payload, 1);
    frames.push(pktData(payload));
    if (data.length === 0) break;
  }
  return frames;
}
