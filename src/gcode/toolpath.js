import { readFileSync } from 'node:fs';
import { openZip } from './zip.js';
import { fileFormat, parseBed } from './metadata.js';

/**
 * Đường đi thật của vòi phun, đọc từ G-code mà slicer đã sinh: mỗi điểm mang toạ độ máy,
 * loại đường (thành ngoài, đổ đầy, bắc cầu...) và số lớp, đủ để dựng lại khung xem như phần mềm cắt lát.
 */

/** Tên loại đường do BambuStudio/Orca ghi trong `; FEATURE:`, giữ nguyên thứ tự để client tra bảng màu. */
export const FEATURES = [
  'Other',
  'Outer wall',
  'Inner wall',
  'Overhang wall',
  'Sparse infill',
  'Internal solid infill',
  'Top surface',
  'Bottom surface',
  'Bridge',
  'Internal Bridge',
  'Gap infill',
  'Support',
  'Support interface',
  'Support transition',
  'Prime tower',
  'Skirt',
  'Brim',
  'Custom',
  'Ironing',
  'Floating vertical shell',
];

const FEATURE_INDEX = new Map(FEATURES.map((name, index) => [name.toLowerCase(), index]));
// Cùng một loại đường nhưng mỗi bản slicer gọi một tên, gộp về tên chuẩn để bảng màu không vỡ.
const FEATURE_ALIAS = new Map([
  ['perimeter', 'Inner wall'],
  ['external perimeter', 'Outer wall'],
  ['overhang perimeter', 'Overhang wall'],
  ['internal infill', 'Sparse infill'],
  ['solid infill', 'Internal solid infill'],
  ['top solid infill', 'Top surface'],
  ['bottom solid infill', 'Bottom surface'],
  ['overhang infill', 'Bridge'],
  ['support material', 'Support'],
  ['support material interface', 'Support interface'],
  ['skirt/brim', 'Skirt'],
  ['wipe tower', 'Prime tower'],
]);

const MAX_POINTS = 900000;
const MAX_LAYERS = 20000;
const GCODE_ENTRY = /^Metadata\/plate_(\d+)\.gcode$/;

function featureIndex(raw) {
  const name = String(raw).trim();
  const alias = FEATURE_ALIAS.get(name.toLowerCase()) ?? name;
  return FEATURE_INDEX.get(alias.toLowerCase()) ?? 0;
}

/** Đọc số ngay sau một chữ cái tham số, chấp nhận cả dạng rút gọn `E.64` mà slicer hay dùng. */
function argument(line, letter, from) {
  const at = line.indexOf(letter, from);
  if (at < 0) return null;
  let end = at + 1;
  while (end < line.length && line.charCodeAt(end) !== 32 && line.charCodeAt(end) !== 59) end += 1;
  const value = Number(line.slice(at + 1, end));
  return Number.isFinite(value) ? value : null;
}

class Trace {
  constructor(limit) {
    this.limit = limit;
    this.x = new Float32Array(limit);
    this.y = new Float32Array(limit);
    this.z = new Float32Array(limit);
    this.feature = new Uint8Array(limit);
    this.layer = new Uint16Array(limit);
    this.count = 0;
    this.truncated = false;
  }

  push(x, y, z, feature, layer) {
    if (this.count >= this.limit) {
      this.truncated = true;
      return false;
    }
    const at = this.count;
    this.x[at] = x;
    this.y[at] = y;
    this.z[at] = z;
    this.feature[at] = feature;
    this.layer[at] = layer;
    this.count = at + 1;
    return true;
  }
}

/**
 * Mỗi đoạn là một cặp điểm liên tiếp nên client dựng thẳng được LineSegments.
 * Chỉ giữ đoạn có đùn nhựa: đường di chuyển không tạo nhựa, vẽ ra chỉ làm rối khung nhìn.
 */
export function parseToolpath(text, { maxPoints = MAX_POINTS } = {}) {
  const trace = new Trace(maxPoints);
  const layers = [];
  let feature = 0;
  let layer = 0;
  let relative = false;
  let absoluteE = false;
  let x = 0;
  let y = 0;
  let z = 0;
  let lastE = 0;
  let pending = null;

  for (const raw of text.split('\n')) {
    const line = raw.trimStart();
    if (line.length === 0) continue;

    if (line.charCodeAt(0) === 59) {
      const body = line.slice(1).trimStart();
      if (body.startsWith('FEATURE:')) {
        feature = featureIndex(body.slice(8));
        continue;
      }
      if (body.startsWith('CHANGE_LAYER')) {
        if (layer < MAX_LAYERS) layer += 1;
        // Z thật nằm ở dòng Z_HEIGHT ngay sau, tạm ghi Z hiện tại rồi sửa khi đọc được.
        layers[layer - 1] = { z, point: trace.count };
        pending = layer - 1;
        continue;
      }
      if (pending !== null && body.startsWith('Z_HEIGHT:')) {
        const value = Number(body.slice(9));
        if (Number.isFinite(value)) layers[pending].z = value;
        pending = null;
        continue;
      }
      continue;
    }

    let end = 1;
    while (end < line.length && line.charCodeAt(end) > 32 && line.charCodeAt(end) !== 59) end += 1;
    const command = line.slice(0, end);
    {
      if (command === 'G0' || command === 'G1') {
        const nx = argument(line, 'X', 2);
        const ny = argument(line, 'Y', 2);
        const nz = argument(line, 'Z', 2);
        const e = argument(line, 'E', 2);
        const fromX = x;
        const fromY = y;
        const fromZ = z;
        if (nx !== null) x = relative ? x + nx : nx;
        if (ny !== null) y = relative ? y + ny : ny;
        if (nz !== null) z = relative ? z + nz : nz;
        const extruded = e === null ? 0 : absoluteE ? e - lastE : e;
        if (e !== null && absoluteE) lastE = e;
        // Vòi phun chỉ để lại nhựa khi vừa đùn vừa đi ngang, rút sợi tại chỗ không phải một đoạn in.
        if (extruded > 0 && (nx !== null || ny !== null)) {
          if (layers.length === 0) layers.push({ z, point: trace.count });
          if (!trace.push(fromX, fromY, fromZ, feature, layer)) break;
          if (!trace.push(x, y, z, feature, layer)) break;
        }
        continue;
      }
      if (command === 'M82') absoluteE = true;
      else if (command === 'M83') absoluteE = false;
      else if (command === 'G90') relative = false;
      else if (command === 'G91') relative = true;
      else if (command === 'G92') lastE = argument(line, 'E', 3) ?? lastE;
    }
  }

  // Mỗi đoạn in là một cặp điểm, cắt cụt giữa cặp thì bỏ nốt điểm lẻ cho client khỏi phải đoán.
  const used = trace.count - (trace.count % 2);
  const bbox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let at = 0; at < used; at += 1) {
    if (trace.x[at] < bbox[0]) bbox[0] = trace.x[at];
    if (trace.y[at] < bbox[1]) bbox[1] = trace.y[at];
    if (trace.z[at] < bbox[2]) bbox[2] = trace.z[at];
    if (trace.x[at] > bbox[3]) bbox[3] = trace.x[at];
    if (trace.y[at] > bbox[4]) bbox[4] = trace.y[at];
    if (trace.z[at] > bbox[5]) bbox[5] = trace.z[at];
  }

  const positions = new Float32Array(used * 3);
  for (let at = 0; at < used; at += 1) {
    positions[at * 3] = trace.x[at];
    positions[at * 3 + 1] = trace.y[at];
    positions[at * 3 + 2] = trace.z[at];
  }

  // Lớp bị cắt cụt vì chạm trần điểm thì bỏ đi, nếu không thanh trượt sẽ chỉ tới vùng rỗng.
  const bands = layers.filter((item) => item && item.point <= used).map((item) => ({ z: Math.round(item.z * 1000) / 1000, point: item.point }));
  // Máy lau vòi và mồi nhựa trước khi slicer ghi mốc lớp đầu tiên, gộp mấy đoạn đó vào lớp một cho khỏi rơi ra ngoài.
  if (bands.length > 0) bands[0].point = 0;

  return {
    points: used,
    truncated: trace.truncated,
    bbox: used > 0 ? bbox : null,
    layers: bands,
    positions,
    feature: trace.feature.subarray(0, used),
    layer: trace.layer.subarray(0, used),
  };
}

function readAll(zip, name) {
  return zip.read(name, { maxBytes: 2 * 1024 * 1024 * 1024 }).toString('utf8');
}

/** Đọc G-code của một khay, chấp nhận cả file .gcode trần lẫn 3MF do slicer xuất. */
export function readToolpath(filePath, name, plate, options = {}) {
  const format = fileFormat(name);
  if (format === '3mf') {
    const zip = openZip(filePath);
    try {
      const indexes = zip.entries
        .map((entry) => entry.name.match(GCODE_ENTRY))
        .filter(Boolean)
        .map((match) => Number(match[1]))
        .sort((left, right) => left - right);
      if (indexes.length === 0) return null;
      const index = indexes.includes(Number(plate)) ? Number(plate) : indexes[0];
      const parsed = parseToolpath(readAll(zip, `Metadata/plate_${index}.gcode`), options);
      const settings = zip.has('Metadata/project_settings.config') ? zip.read('Metadata/project_settings.config', { maxBytes: 16 * 1024 * 1024 }) : null;
      return { ...parsed, plate: index, plates: indexes, bed: settings ? parseBed(JSON.parse(settings.toString('utf8'))) : null };
    } finally {
      zip.close();
    }
  }
  if (format !== 'gcode') return null;
  return { ...parseToolpath(readFileSync(filePath, 'utf8'), options), plate: 1, plates: [1], bed: null };
}

/** Gói nhị phân: độ dài header, header JSON, rồi Float32 toạ độ, Uint8 loại đường, Uint16 số lớp. */
export function packToolpath(path) {
  const header = Buffer.from(
    JSON.stringify({
      plate: path.plate,
      plates: path.plates,
      bed: path.bed,
      features: FEATURES,
      layers: path.layers,
      points: path.points,
      truncated: path.truncated,
      bbox: path.bbox ? path.bbox.map((value) => Math.round(value * 1000) / 1000) : null,
    }),
    'utf8',
  );
  const padded = Math.ceil(header.length / 4) * 4;
  const buffer = Buffer.alloc(4 + padded + path.positions.byteLength + path.feature.byteLength + path.layer.byteLength);
  buffer.writeUInt32LE(header.length, 0);
  header.copy(buffer, 4);
  let at = 4 + padded;
  const copy = (view) => {
    Buffer.from(view.buffer, view.byteOffset, view.byteLength).copy(buffer, at);
    at += view.byteLength;
  };
  copy(path.positions);
  copy(path.feature);
  copy(path.layer);
  return buffer;
}
