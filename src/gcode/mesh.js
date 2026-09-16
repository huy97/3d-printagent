import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';

export const MODEL_ENTRY_BYTES = 256 * 1024 * 1024;

export function readRange(fd, position, length) {
  const buffer = Buffer.alloc(length);
  const read = readSync(fd, buffer, 0, length, position);
  return buffer.subarray(0, read);
}

export function attr(tag, name) {
  const match = tag.match(new RegExp(`(?:^|\\s)(?:\\w+:)?${name}="([^"]*)"`));
  return match ? match[1] : null;
}

/** Ma trận 3MF là 12 số hàng-major, điểm nhân bên trái: p' = [x y z 1] x M. */
export function parseMatrix(value) {
  if (!value) return null;
  const numbers = value.trim().split(/\s+/).map(Number);
  return numbers.length === 12 && numbers.every(Number.isFinite) ? numbers : null;
}

export function applyMatrix(point, matrix) {
  if (!matrix) return point;
  const [x, y, z] = point;
  return [
    x * matrix[0] + y * matrix[3] + z * matrix[6] + matrix[9],
    x * matrix[1] + y * matrix[4] + z * matrix[7] + matrix[10],
    x * matrix[2] + y * matrix[5] + z * matrix[8] + matrix[11],
  ];
}

export function combineMatrix(child, parent) {
  if (!child) return parent;
  if (!parent) return child;
  const out = new Array(12);
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      out[row * 3 + col] =
        child[row * 3] * parent[col] +
        child[row * 3 + 1] * parent[3 + col] +
        child[row * 3 + 2] * parent[6 + col] +
        (row === 3 ? parent[9 + col] : 0);
    }
  }
  return out;
}

/** Gom các `<object>` của một file .model: mesh hoặc danh sách component trỏ sang file khác. */
export function readModelObjects(text) {
  const objects = new Map();
  for (const chunk of text.split('<object ').slice(1)) {
    const end = chunk.indexOf('</object>');
    const body = end === -1 ? chunk : chunk.slice(0, end);
    const head = body.slice(0, body.indexOf('>') + 1);
    const id = attr(head, 'id');
    if (!id) continue;
    const points = [];
    for (const match of body.matchAll(/<vertex\s[^>]*>/g)) {
      points.push([Number(attr(match[0], 'x')), Number(attr(match[0], 'y')), Number(attr(match[0], 'z'))]);
    }
    const faces = [];
    for (const match of body.matchAll(/<triangle\s[^>]*>/g)) {
      faces.push([Number(attr(match[0], 'v1')), Number(attr(match[0], 'v2')), Number(attr(match[0], 'v3'))]);
    }
    const components = [];
    for (const match of body.matchAll(/<component\s[^>]*>/g)) {
      components.push({ path: attr(match[0], 'path'), objectid: attr(match[0], 'objectid'), matrix: parseMatrix(attr(match[0], 'transform')) });
    }
    objects.set(id, { name: attr(head, 'name'), points, faces, components });
  }
  return objects;
}

/** Duyệt tam giác của 3MF theo từng `<item>` trong `<build>`, toạ độ đã nhân ma trận. */
export function each3mfTriangle(zip, onTriangle) {
  const cache = new Map();
  const load = (entry) => {
    const name = entry.replace(/^\//, '');
    if (cache.has(name)) return cache.get(name);
    const buffer = zip.has(name) ? zip.read(name, { maxBytes: MODEL_ENTRY_BYTES }) : null;
    const objects = buffer ? readModelObjects(buffer.toString('utf8')) : new Map();
    cache.set(name, objects);
    return objects;
  };

  const root = '3D/3dmodel.model';
  const rootText = zip.has(root) ? zip.read(root, { maxBytes: MODEL_ENTRY_BYTES }).toString('utf8') : '';
  if (!rootText) return 0;
  cache.set(root, readModelObjects(rootText));

  let count = 0;
  const visit = (entry, id, matrix, depth, item) => {
    if (depth > 8) return;
    const object = load(entry).get(String(id));
    if (!object) return;
    for (const face of object.faces) {
      const a = object.points[face[0]];
      const b = object.points[face[1]];
      const c = object.points[face[2]];
      if (!a || !b || !c) continue;
      onTriangle(applyMatrix(a, matrix), applyMatrix(b, matrix), applyMatrix(c, matrix), item);
      count += 1;
    }
    for (const component of object.components) {
      visit(component.path ?? entry, component.objectid, combineMatrix(component.matrix, matrix), depth + 1, item);
    }
  };

  const build = rootText.slice(rootText.indexOf('<build'));
  let index = 0;
  for (const match of build.matchAll(/<item\s[^>]*>/g)) {
    const id = attr(match[0], 'objectid');
    visit(root, id, parseMatrix(attr(match[0], 'transform')), 0, { index, objectId: id, name: load(root).get(String(id))?.name ?? null });
    index += 1;
  }
  return count;
}

/** STL chữ và OBJ đều là văn bản theo dòng, đọc từng khối rồi ghép phần dòng dở. */
function eachLine(fd, size, handle) {
  const chunkBytes = 1024 * 1024;
  let rest = '';
  for (let at = 0; at < size; at += chunkBytes) {
    const text = rest + readRange(fd, at, Math.min(chunkBytes, size - at)).toString('utf8');
    const lines = text.split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) handle(line);
  }
  if (rest) handle(rest);
}

function eachBinaryStlTriangle(fd, total, onTriangle, stride) {
  const chunkTriangles = 20000;
  const point = (buffer, offset) => [buffer.readFloatLE(offset), buffer.readFloatLE(offset + 4), buffer.readFloatLE(offset + 8)];
  for (let index = 0; index < total; index += chunkTriangles) {
    const count = Math.min(chunkTriangles, total - index);
    const buffer = readRange(fd, 84 + index * 50, count * 50);
    for (let item = 0; item < count; item += 1) {
      if ((index + item) % stride !== 0) continue;
      const at = item * 50 + 12;
      onTriangle(point(buffer, at), point(buffer, at + 12), point(buffer, at + 24));
    }
  }
  return total;
}

function eachAsciiStlTriangle(fd, size, onTriangle) {
  let corners = [];
  let count = 0;
  eachLine(fd, size, (line) => {
    const match = line.match(/^\s*vertex\s+(\S+)\s+(\S+)\s+(\S+)/);
    if (!match) return;
    corners.push([Number(match[1]), Number(match[2]), Number(match[3])]);
    if (corners.length === 3) {
      onTriangle(corners[0], corners[1], corners[2]);
      count += 1;
      corners = [];
    }
  });
  return count;
}

function eachObjTriangle(fd, size, onTriangle) {
  const points = [];
  let count = 0;
  eachLine(fd, size, (line) => {
    if (line.startsWith('v ')) {
      const parts = line.trim().split(/\s+/);
      points.push([Number(parts[1]), Number(parts[2]), Number(parts[3])]);
      return;
    }
    if (!line.startsWith('f ')) return;
    const corners = line
      .trim()
      .split(/\s+/)
      .slice(1)
      .map((part) => {
        const index = Number.parseInt(part.split('/')[0], 10);
        return index > 0 ? points[index - 1] : points[points.length + index];
      })
      .filter(Boolean);
    // Mặt nhiều đỉnh được cắt thành quạt tam giác quanh đỉnh đầu.
    for (let at = 1; at + 1 < corners.length; at += 1) {
      onTriangle(corners[0], corners[at], corners[at + 1]);
      count += 1;
    }
  });
  return count;
}

/**
 * Duyệt tam giác của STL/OBJ, trả về tổng số mặt có trong file.
 * `maxSample` chỉ áp dụng cho STL nhị phân vì chỉ định dạng này biết trước số mặt.
 */
export function eachModelTriangle(filePath, name, onTriangle, { maxSample = Infinity } = {}) {
  const fd = openSync(filePath, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size >= 84) {
      const total = readRange(fd, 0, 84).readUInt32LE(80);
      if (size === 84 + total * 50) return eachBinaryStlTriangle(fd, total, onTriangle, Math.ceil(total / maxSample) || 1);
    }
    return path.extname(String(name).toLowerCase()) === '.obj' ? eachObjTriangle(fd, size, onTriangle) : eachAsciiStlTriangle(fd, size, onTriangle);
  } finally {
    closeSync(fd);
  }
}
