// Packfile build and read for the git smart-HTTP engine.
//
// buildPack writes plain (non-delta) objects — every object deflated independently, correct
// header, sha1 trailer — which is fast to build and trivially correct to read. readPackFile parses
// a pushed pack completely: full objects, OFS_DELTA and REF_DELTA with delta application, and the
// trailing sha1 verified before anything is stored.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { hashObject, type ForgeRepo, type GitObject, type ObjectType } from './forge.ts';

const TYPE_CODES: Readonly<Record<ObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Readonly<Record<number, ObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** One object's pack header: the type/size varint git's pack format uses. */
function objectHeaderVarint(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  let remaining = Math.floor(size / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * A packfile version 2 from plain objects, in the order given. The trailer is the sha1 of every
 * byte before it, exactly as index-pack verifies.
 */
export function buildPack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(objectHeaderVarint(TYPE_CODES[object.type], object.data.length));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Apply a git delta (the copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (off >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[off++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[off++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[off++]! * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (off + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, off, off + literal);
      off += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface RawEntry {
  readonly offset: number;
  readonly typeCode: number;
  data: Buffer;
  readonly baseOffset?: number;
  readonly baseSha?: string;
  resolvedType?: ObjectType;
  resolved?: Buffer;
  oid?: string;
}

export interface UnpackedObject {
  readonly type: ObjectType;
  readonly data: Buffer;
  readonly sha: string;
}

/**
 * Read a pushed packfile (version 2 or 3) and resolve every object. `resolveBase` supplies the
 * base of a thin pack's ref-delta (an object the sender assumed the receiver holds). The trailing
 * sha1 is verified first, so corruption can never be stored as a successful unpack.
 */
export function readPackFile(pack: Buffer, resolveBase?: (sha: string) => GitObject | undefined): UnpackedObject[] {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('latin1') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (computed !== pack.subarray(trailerStart).toString('hex')) {
    throw new Error('pack trailer checksum mismatch');
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let off = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = off;
    if (off >= trailerStart) throw new Error('pack entry header is truncated');
    let byte = pack[off++]!;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      if (off >= trailerStart) throw new Error('pack entry size varint is truncated');
      byte = pack[off++]!;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 63) throw new Error('pack entry size varint is too long');
    }
    const entry: RawEntry = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      if (off >= trailerStart) throw new Error('ofs-delta base offset is truncated');
      let value = pack[off++]! & 0x7f;
      while (pack[off - 1]! & 0x80) {
        if (off >= trailerStart) throw new Error('ofs-delta base offset is truncated');
        const next = pack[off++]!;
        value = (value + 1) * 128 + (next & 0x7f);
      }
      if (value <= 0 || value > entryOffset) throw new Error(`ofs-delta names an invalid base offset ${value}`);
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      if (off + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseSha = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (CODE_TYPES[typeCode] === undefined) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateSync(pack.subarray(off, trailerStart), { info: true });
    const data = inflated.buffer as Buffer;
    const consumed = (inflated.engine as unknown as { bytesWritten: number }).bytesWritten;
    if (data.length !== size) throw new Error(`pack entry declares ${size} bytes but inflated to ${data.length}`);
    entry.data = data;
    off += consumed;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (off !== trailerStart) throw new Error(`pack has ${trailerStart - off} stray bytes before its trailer`);

  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: ObjectType; data: Buffer; sha: string } => {
    if (entry.resolved !== undefined && entry.resolvedType !== undefined && entry.oid !== undefined) {
      return { type: entry.resolvedType, data: entry.resolved, sha: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: ObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (baseEntry === undefined) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseSha!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry !== undefined) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase === undefined ? undefined : resolveBase(wanted);
        if (external === undefined) throw new Error(`ref-delta base ${wanted} is not available`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPES[entry.typeCode]!;
      data = entry.data;
    }
    const sha = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = sha;
    resolvedByOid.set(sha, entry);
    resolving.delete(entry.offset);
    return { type, data, sha };
  };

  const objects: UnpackedObject[] = [];
  for (const entry of raw) {
    const resolved = resolve(entry);
    objects.push({ type: resolved.type, data: resolved.data, sha: resolved.sha });
  }
  return objects;
}

/** The commit a tag object names, from its `object <sha>` header, or null. */
export function tagTargetOf(data: Buffer): string | null {
  const match = /^object ([0-9a-f]{40})$/m.exec(data.toString('utf8'));
  return match === null ? null : match[1] ?? null;
}

/** Peel a ref's sha through annotated tags to the first non-tag object. */
export function peelRef(repo: ForgeRepo, sha: string): string | null {
  let current = sha;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = repo.readObject(current);
    if (object === undefined) return null;
    if (object.type !== 'tag') return current;
    const target = tagTargetOf(object.data);
    if (target === null) return current;
    current = target;
  }
  return current;
}
