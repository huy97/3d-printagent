import { badRequest } from '../util/errors.js';
import { apply, layFlat } from './nest.js';
import { baseName, matrixText, measureParts, packModel } from './split.js';

/**
 * Tìm hướng đặt mô hình ít phải in hỗ trợ nhất: thử nhiều hướng úp xuống bàn, mỗi hướng chấm điểm theo
 * thể tích vùng treo cần đỡ, diện tích bám bàn và chiều cao. Cả mô hình xoay chung một ma trận nên các khối giữ nguyên cách ráp.
 */

/** Quá số tam giác này thì chấm điểm trên mẫu thưa, diện tích nhân bù lại theo bước lấy mẫu. */
const SAMPLE = 200000;
/** Mặt nghiêng quá 45 độ so với phương đứng thì cần đỡ, đúng ngưỡng mặc định của slicer. */
const OVERHANG = Math.SQRT1_2;
const FLAT = 0.985;
const CONTACT_MM = 0.3;
/** Hướng mới phải tốt hơn hẳn hướng đang có mới đổi, tránh xoay vì chênh lệch vặt. */
const MIN_GAIN = 0.03;

function unit(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  return length < 1e-9 ? null : [vector[0] / length, vector[1] / length, vector[2] / length];
}

function fibonacci(count) {
  const list = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let index = 0; index < count; index += 1) {
    const y = 1 - (index / (count - 1)) * 2;
    const radius = Math.sqrt(1 - y * y);
    const theta = golden * index;
    list.push([Math.cos(theta) * radius, y, Math.sin(theta) * radius]);
  }
  return list;
}

function prepare(coords, faces) {
  const count = faces.length / 3;
  const stride = Math.max(1, Math.ceil(count / SAMPLE));
  const normals = [];
  const areas = [];
  const centers = [];
  const buckets = new Map();
  let totalArea = 0;
  for (let face = 0; face < count; face += stride) {
    const at = face * 3;
    const a = faces[at] * 3;
    const b = faces[at + 1] * 3;
    const c = faces[at + 2] * 3;
    const u = [coords[b] - coords[a], coords[b + 1] - coords[a + 1], coords[b + 2] - coords[a + 2]];
    const v = [coords[c] - coords[a], coords[c + 1] - coords[a + 1], coords[c + 2] - coords[a + 2]];
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(cross[0], cross[1], cross[2]);
    if (length < 1e-12) continue;
    const area = (length / 2) * stride;
    const normal = [cross[0] / length, cross[1] / length, cross[2] / length];
    normals.push(normal);
    areas.push(area);
    centers.push([(coords[a] + coords[b] + coords[c]) / 3, (coords[a + 1] + coords[b + 1] + coords[c + 1]) / 3, (coords[a + 2] + coords[b + 2] + coords[c + 2]) / 3]);
    totalArea += area;
    const key = normal.map((value) => Math.round(value * 20)).join(',');
    const entry = buckets.get(key) ?? { normal: [0, 0, 0], area: 0 };
    entry.area += area;
    for (let axis = 0; axis < 3; axis += 1) entry.normal[axis] += normal[axis] * area;
    buckets.set(key, entry);
  }
  const flats = [...buckets.values()]
    .sort((left, right) => right.area - left.area)
    .slice(0, 16)
    .map((entry) => unit(entry.normal))
    .filter(Boolean);
  return { normals, areas, centers, totalArea, flats };
}

function extent(coords, direction) {
  let max = -Infinity;
  let min = Infinity;
  for (let at = 0; at < coords.length; at += 3) {
    const value = coords[at] * direction[0] + coords[at + 1] * direction[1] + coords[at + 2] * direction[2];
    if (value > max) max = value;
    if (value < min) min = value;
  }
  return { max, min };
}

/** `down` là hướng trong hệ toạ độ mô hình sẽ úp xuống bàn; chiều cao một điểm so với bàn là max(p·down) - p·down. */
function measure(coords, prepared, down) {
  const { max, min } = extent(coords, down);
  let support = 0;
  let contact = 0;
  for (let index = 0; index < prepared.normals.length; index += 1) {
    const normal = prepared.normals[index];
    const facing = normal[0] * down[0] + normal[1] * down[1] + normal[2] * down[2];
    if (facing <= OVERHANG) continue;
    const center = prepared.centers[index];
    const height = max - (center[0] * down[0] + center[1] * down[1] + center[2] * down[2]);
    if (height < CONTACT_MM) {
      if (facing > FLAT) contact += prepared.areas[index];
      continue;
    }
    support += prepared.areas[index] * facing * height;
  }
  return { support, contact, height: max - min };
}

function scoreOf(metrics, reference) {
  const contactRatio = Math.min(1, metrics.contact / reference.area);
  return (
    metrics.support / reference.volume +
    (0.25 * metrics.height) / reference.size -
    0.6 * contactRatio +
    (metrics.contact < reference.area * 0.02 ? 0.3 : 0)
  );
}

function publicMetrics(metrics) {
  return {
    supportCm3: Math.round(metrics.support / 10) / 100,
    contactCm2: Math.round(metrics.contact) / 100,
    heightMm: Math.round(metrics.height * 10) / 10,
  };
}

function candidates(prepared) {
  const list = [];
  for (const x of [-1, 0, 1]) {
    for (const y of [-1, 0, 1]) {
      for (const z of [-1, 0, 1]) {
        const direction = unit([x, y, z]);
        if (direction) list.push(direction);
      }
    }
  }
  list.push(...prepared.flats, ...fibonacci(64));
  const unique = [];
  for (const direction of list) {
    if (!unique.some((item) => item[0] * direction[0] + item[1] * direction[1] + item[2] * direction[2] > 0.999)) unique.push(direction);
  }
  return unique;
}

export function orientModel(filePath, name) {
  const parts = measureParts(filePath, name);
  const { coords, faces } = parts;
  const prepared = prepare(coords, faces);
  if (prepared.normals.length === 0) throw badRequest('error.split_no_mesh', { name });

  const size = [0, 1, 2].map((axis) => {
    const direction = [0, 0, 0];
    direction[axis] = 1;
    const { max, min } = extent(coords, direction);
    return Math.max(0.1, max - min);
  });
  const reference = { volume: size[0] * size[1] * size[2], size: Math.max(...size), area: prepared.totalArea / 6 };

  const current = measure(coords, prepared, [0, 0, -1]);
  const currentScore = scoreOf(current, reference);
  let best = { down: [0, 0, -1], metrics: current, score: currentScore };
  for (const down of candidates(prepared)) {
    const metrics = measure(coords, prepared, down);
    const score = scoreOf(metrics, reference);
    if (score < best.score) best = { down, metrics, score };
  }

  const before = publicMetrics(current);
  if (currentScore - best.score < MIN_GAIN) return { changed: false, before, after: before };

  const rotation = layFlat(best.down);
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  const originalMin = [Infinity, Infinity];
  const originalMax = [-Infinity, -Infinity];
  for (let at = 0; at < coords.length; at += 3) {
    const point = [coords[at], coords[at + 1], coords[at + 2]];
    const moved = apply(rotation, point);
    min = min.map((value, axis) => Math.min(value, moved[axis]));
    max = max.map((value, axis) => Math.max(value, moved[axis]));
    for (let axis = 0; axis < 2; axis += 1) {
      originalMin[axis] = Math.min(originalMin[axis], point[axis]);
      originalMax[axis] = Math.max(originalMax[axis], point[axis]);
    }
  }
  // Giữ tâm mô hình trên mặt bàn như cũ và đặt điểm thấp nhất chạm bàn.
  const shift = [(originalMin[0] + originalMax[0]) / 2 - (min[0] + max[0]) / 2, (originalMin[1] + originalMax[1]) / 2 - (min[1] + max[1]) / 2, -min[2]];
  const matrix = matrixText(rotation);
  const place = (part) => {
    const moved = apply(rotation, part.origin);
    return { matrix, at: [moved[0] + shift[0], moved[1] + shift[1], moved[2] + shift[2]] };
  };
  return {
    changed: true,
    before,
    after: publicMetrics(best.metrics),
    down: best.down.map((value) => Math.round(value * 1000) / 1000),
    ...packModel(parts, baseName(name), place),
  };
}
