import { openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
// A 32-bit field holding exactly this value is the flag meaning "the real number is in the zip64 record".
const OVERFLOW32 = 0xffffffff;

function readAt(fd, position, length) {
  const buffer = Buffer.alloc(length);
  const read = readSync(fd, buffer, 0, length, position);
  return buffer.subarray(0, read);
}

function big(buffer, offset) {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Zip entry too large');
  return Number(value);
}

/**
 * Real values of the fields that overflowed 32 bits, taken from the directory's 0x0001 extra.
 * The extra holds only the overflowed fields, in this fixed order.
 */
function readZip64Extra(extra, entry) {
  for (let at = 0; at + 4 <= extra.length; ) {
    const id = extra.readUInt16LE(at);
    const length = extra.readUInt16LE(at + 2);
    const body = extra.subarray(at + 4, at + 4 + length);
    at += 4 + length;
    if (id !== 0x0001) continue;
    let taken = 0;
    for (const key of ['uncompressedSize', 'compressedSize', 'localOffset']) {
      if (entry[key] !== OVERFLOW32 || taken + 8 > body.length) continue;
      entry[key] = big(body, taken);
      taken += 8;
    }
    return entry;
  }
  return entry;
}

/**
 * Read a zip central directory (3MF is a zip) without extracting everything.
 * Handles zip64 too: many CAD tools write 3MF that way even for small files.
 */
export function openZip(filePath) {
  const fd = openSync(filePath, 'r');
  const size = fstatSync(fd).size;
  const tailLength = Math.min(size, 65557);
  const tail = readAt(fd, size - tailLength, tailLength);
  let eocd = -1;
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === EOCD_SIGNATURE) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) {
    closeSync(fd);
    throw new Error('Not a zip archive');
  }
  let count = tail.readUInt16LE(eocd + 10);
  let directorySize = tail.readUInt32LE(eocd + 12);
  let directoryOffset = tail.readUInt32LE(eocd + 16);

  // In zip64 the plain EOCD is usually all overflow flags, with the real numbers in the record the preceding locator points to.
  const locator = eocd - 20;
  if (locator >= 0 && tail.readUInt32LE(locator) === ZIP64_LOCATOR_SIGNATURE) {
    const record = readAt(fd, big(tail, locator + 8), 56);
    if (record.length === 56 && record.readUInt32LE(0) === ZIP64_EOCD_SIGNATURE) {
      count = big(record, 32);
      directorySize = big(record, 40);
      directoryOffset = big(record, 48);
    }
  }
  const directory = readAt(fd, directoryOffset, directorySize);

  const entries = [];
  let cursor = 0;
  for (let index = 0; index < count && cursor + 46 <= directory.length; index += 1) {
    if (directory.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) break;
    const method = directory.readUInt16LE(cursor + 10);
    const compressedSize = directory.readUInt32LE(cursor + 20);
    const uncompressedSize = directory.readUInt32LE(cursor + 24);
    const nameLength = directory.readUInt16LE(cursor + 28);
    const extraLength = directory.readUInt16LE(cursor + 30);
    const commentLength = directory.readUInt16LE(cursor + 32);
    const localOffset = directory.readUInt32LE(cursor + 42);
    const name = directory.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const entry = { name, method, compressedSize, uncompressedSize, localOffset };
    const overflowed = compressedSize === OVERFLOW32 || uncompressedSize === OVERFLOW32 || localOffset === OVERFLOW32;
    entries.push(overflowed ? readZip64Extra(directory.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength), entry) : entry);
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return {
    entries,
    has: (name) => entries.some((entry) => entry.name === name),
    read(name, { maxBytes = 64 * 1024 * 1024 } = {}) {
      const entry = entries.find((item) => item.name === name);
      if (!entry) return null;
      if (entry.uncompressedSize > maxBytes) return null;
      const header = readAt(fd, entry.localOffset, 30);
      if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) return null;
      const dataOffset = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      const data = readAt(fd, dataOffset, entry.compressedSize);
      if (entry.method === 0) return data;
      if (entry.method === 8) return inflateRawSync(data);
      return null;
    },
    close: () => closeSync(fd),
  };
}

/** Pack a zip in one pass in RAM to export 3MF; keeps entry order so [Content_Types].xml stays first. */
export function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  let count = 0;
  for (const [name, content] of Object.entries(entries)) {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const packed = deflateRawSync(raw, { level: 6 });
    // Content that is already smaller raw (PNG for instance) is not worth compressing again.
    const deflated = packed.length < raw.length;
    const data = deflated ? packed : raw;
    const nameBuffer = Buffer.from(name, 'utf8');
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(deflated ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    locals.push(local, nameBuffer, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(deflated ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuffer);

    offset += local.length + nameBuffer.length + data.length;
    count += 1;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD_SIGNATURE, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
