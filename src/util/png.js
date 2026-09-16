import { deflateSync } from 'node:zlib';

const CRC_TABLE = new Int32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value;
});

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Minimal RGB canvas to draw fake camera frames for the virtual printer, no graphics library needed. */
export function createCanvas(width, height, background = [0, 0, 0]) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let index = 0; index < width * height; index += 1) pixels.set(background, index * 3);
  return {
    width,
    height,
    rect(x, y, w, h, color) {
      const x0 = Math.max(0, Math.round(x));
      const y0 = Math.max(0, Math.round(y));
      const x1 = Math.min(width, Math.round(x + w));
      const y1 = Math.min(height, Math.round(y + h));
      for (let row = y0; row < y1; row += 1) {
        for (let col = x0; col < x1; col += 1) pixels.set(color, (row * width + col) * 3);
      }
    },
    toPng() {
      const raw = Buffer.alloc((width * 3 + 1) * height);
      for (let row = 0; row < height; row += 1) {
        raw[row * (width * 3 + 1)] = 0;
        pixels.copy(raw, row * (width * 3 + 1) + 1, row * width * 3, (row + 1) * width * 3);
      }
      const header = Buffer.alloc(13);
      header.writeUInt32BE(width, 0);
      header.writeUInt32BE(height, 4);
      header[8] = 8;
      header[9] = 2;
      return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
      ]);
    },
  };
}
