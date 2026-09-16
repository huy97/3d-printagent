/**
 * 2D nesting for the print bed: rasterize each group's real footprint onto a pixel grid, then find the free spot closest to the bed center.
 * Working on the real footprint instead of a bounding box lets L-shaped or ring-shaped parts interlock.
 */

/** 1 mm grid cell: finer than the nozzle diameter, yet a 350 mm bed still takes only a hundred thousand cells or so. */
const CELL = 1;
/** Above this group count, search on a coarser step, trading a little packing density for wait time. */
const MANY = 40;
/** Cap on placement attempts per group, so a pathological model cannot hang the server. */
const BUDGET = 6000000;

const TAU = Math.PI * 2;

/** Multiply 3x3 rotation matrices (column convention: p' = M·p). */
export function multiply(left, right) {
  const out = new Array(9);
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      out[row * 3 + col] = left[row * 3] * right[col] + left[row * 3 + 1] * right[3 + col] + left[row * 3 + 2] * right[6 + col];
    }
  }
  return out;
}

export function apply(matrix, point) {
  return [
    matrix[0] * point[0] + matrix[1] * point[1] + matrix[2] * point[2],
    matrix[3] * point[0] + matrix[4] * point[1] + matrix[5] * point[2],
    matrix[6] * point[0] + matrix[7] * point[1] + matrix[8] * point[2],
  ];
}

export const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function spin(angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [cos, -sin, 0, sin, cos, 0, 0, 0, 1];
}

/**
 * Direction to face the bed: bucket face area by normal, then pick the normal with the most flat area.
 * This is how a slicer picks a base face - the widest bed contact warps least and needs the least support.
 */
export function bestDown(each) {
  const buckets = new Map();
  let best = null;
  each((a, b, c) => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(cross[0], cross[1], cross[2]);
    if (length < 1e-9) return;
    const unit = [cross[0] / length, cross[1] / length, cross[2] / length];
    // Round to a 0.02 grid so coplanar faces land in one bucket and mesh noise does not split them apart.
    const key = unit.map((value) => Math.round(value * 50)).join(',');
    const found = buckets.get(key);
    const entry = found ?? { normal: [0, 0, 0], area: 0 };
    entry.area += length / 2;
    for (let axis = 0; axis < 3; axis += 1) entry.normal[axis] += unit[axis] * (length / 2);
    if (!found) buckets.set(key, entry);
    if (!best || entry.area > best.area) best = entry;
  });
  if (!best) return null;
  const length = Math.hypot(...best.normal);
  return length < 1e-9 ? null : best.normal.map((value) => value / length);
}

/** Rotation matrix turning `normal` to face the bed (0, 0, -1). */
export function layFlat(normal) {
  if (!normal) return IDENTITY;
  const target = [0, 0, -1];
  const dot = normal[0] * target[0] + normal[1] * target[1] + normal[2] * target[2];
  if (dot > 0.9999) return IDENTITY;
  // At exactly 180 degrees any perpendicular axis works, take the X axis for simplicity.
  if (dot < -0.9999) return [1, 0, 0, 0, -1, 0, 0, 0, -1];
  const axis = [normal[1] * target[2] - normal[2] * target[1], normal[2] * target[0] - normal[0] * target[2], normal[0] * target[1] - normal[1] * target[0]];
  const length = Math.hypot(...axis);
  const [x, y, z] = axis.map((value) => value / length);
  const cos = dot;
  const sin = length;
  const rest = 1 - cos;
  return [
    cos + x * x * rest,
    x * y * rest - z * sin,
    x * z * rest + y * sin,
    y * x * rest + z * sin,
    cos + y * y * rest,
    y * z * rest - x * sin,
    z * x * rest - y * sin,
    z * y * rest + x * sin,
    cos + z * z * rest,
  ];
}

/** Fill a triangle on the grid by scanline, shared by part footprints and exclusion zones. */
function fillTriangle(grid, width, height, a, b, c) {
  const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
  const edges = [
    [a, b],
    [b, c],
    [c, a],
  ];
  for (let row = minY; row <= maxY; row += 1) {
    const y = row + 0.5;
    const crossings = [];
    for (const [from, to] of edges) {
      if (from[1] === to[1]) continue;
      if (y < Math.min(from[1], to[1]) || y >= Math.max(from[1], to[1])) continue;
      crossings.push(from[0] + ((y - from[1]) / (to[1] - from[1])) * (to[0] - from[0]));
    }
    crossings.sort((left, right) => left - right);
    for (let at = 0; at + 1 < crossings.length; at += 2) {
      const from = Math.max(0, Math.floor(crossings[at]));
      const to = Math.min(width - 1, Math.ceil(crossings[at + 1]));
      for (let col = from; col <= to; col += 1) grid[row * width + col] = 1;
    }
  }
}

/**
 * A group's footprint on the bed, already rotated and shifted to the grid origin.
 * Also returns the list of filled cells so collision tests only walk the occupied part.
 */
export function shadow(each, matrix) {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  each((a, b, c) => {
    for (const point of [a, b, c]) {
      const [x, y, z] = apply(matrix, point);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  });
  const width = Math.max(1, Math.ceil((maxX - minX) / CELL));
  const height = Math.max(1, Math.ceil((maxY - minY) / CELL));
  const grid = new Uint8Array(width * height);
  const flat = (point) => {
    const moved = apply(matrix, point);
    return [(moved[0] - minX) / CELL, (moved[1] - minY) / CELL];
  };
  each((a, b, c) => fillTriangle(grid, width, height, flat(a), flat(b), flat(c)));
  const cells = [];
  for (let at = 0; at < grid.length; at += 1) {
    if (grid[at]) cells.push(at);
  }
  // A model thinner than one grid cell must still occupy space, otherwise two flat parts would overlap.
  if (cells.length === 0) {
    grid[0] = 1;
    cells.push(0);
  }
  return { width, height, cells, min: [minX, minY, minZ], size: [maxX - minX, maxY - minY] };
}

/** Stamp a group's footprint into the bed grid, dilated by `spread` cells so later parts keep a gap. */
function stamp(bed, mark, atX, atY, spread) {
  for (const cell of mark.cells) {
    const col = atX + (cell % mark.width);
    const row = atY + Math.floor(cell / mark.width);
    for (let dy = -spread; dy <= spread; dy += 1) {
      const y = row + dy;
      if (y < 0 || y >= bed.height) continue;
      for (let dx = -spread; dx <= spread; dx += 1) {
        const x = col + dx;
        if (x >= 0 && x < bed.width) bed.grid[y * bed.width + x] = 1;
      }
    }
  }
}

function free(bed, mark, atX, atY) {
  for (const cell of mark.cells) {
    const col = atX + (cell % mark.width);
    const row = atY + Math.floor(cell / mark.width);
    if (bed.grid[row * bed.width + col]) return false;
  }
  return true;
}

/** Candidate positions along one axis: aligned so the bed center is always a candidate, plus both edges so bed corners stay usable. */
function marks(want, span, step) {
  const list = [];
  for (let value = Math.round(want) % step; value <= span; value += step) list.push(value);
  if (span > 0 && !list.includes(0)) list.push(0);
  if (span > 0 && !list.includes(span)) list.push(span);
  return list;
}

/** Candidate spots, trying first the one that puts the part center closest to the bed center. */
function candidates(bed, mark, step) {
  const spanX = bed.width - mark.width;
  const spanY = bed.height - mark.height;
  if (spanX < 0 || spanY < 0) return [];
  const wantX = spanX / 2;
  const wantY = spanY / 2;
  const list = [];
  for (const y of marks(wantY, spanY, step)) {
    for (const x of marks(wantX, spanX, step)) list.push([x, y, (x - wantX) ** 2 + (y - wantY) ** 2]);
  }
  list.sort((left, right) => left[2] - right[2]);
  return list;
}

/**
 * Nest groups onto the bed. Each group is `{ each, item }` where `each(cb)` walks triangles; returns each group's position and rotation matrix.
 * `bed` is in millimeters, `exclude` is the bounding box of an excluded zone (the nozzle wipe area) if any.
 */
export function nest(groups, bed, { gap = 6, margin = 2, autoRotate = false, angles = 4 } = {}) {
  const left = bed.minX + margin;
  const bottom = bed.minY + margin;
  const width = Math.max(1, Math.floor((bed.maxX - margin - left) / CELL));
  const height = Math.max(1, Math.floor((bed.maxY - margin - bottom) / CELL));
  const plate = { grid: new Uint8Array(width * height), width, height };

  if (bed.exclude?.length >= 3) {
    const points = bed.exclude.map(([x, y]) => [(x - left) / CELL, (y - bottom) / CELL]);
    for (let at = 1; at + 1 < points.length; at += 1) fillTriangle(plate.grid, width, height, points[0], points[at], points[at + 1]);
  }

  const spread = Math.max(0, Math.round(gap / CELL));
  const step = groups.length > MANY ? 4 : 2;

  const prepared = groups.map((group) => {
    const flat = autoRotate ? layFlat(bestDown(group.each)) : IDENTITY;
    return { group, flat, turns: [] };
  });
  // Place the group covering the most cells first: the hardest one to fit should pick its spot while the bed is still empty.
  for (const entry of prepared) {
    for (let turn = 0; turn < angles; turn += 1) entry.turns.push(shadow(entry.group.each, multiply(spin((turn * TAU) / angles), entry.flat)));
    entry.area = entry.turns[0].cells.length;
  }
  prepared.sort((a, b) => b.area - a.area);

  const placed = [];
  const overflow = [];
  for (const entry of prepared) {
    let best = null;
    let budget = BUDGET;
    for (let turn = 0; turn < entry.turns.length && !best; turn += 1) {
      const mark = entry.turns[turn];
      for (const [x, y] of candidates(plate, mark, step)) {
        budget -= mark.cells.length;
        if (budget < 0) break;
        if (!free(plate, mark, x, y)) continue;
        best = { turn, mark, x, y };
        break;
      }
    }
    if (!best) {
      overflow.push(entry.group);
      continue;
    }
    stamp(plate, best.mark, best.x, best.y, spread);
    placed.push({
      item: entry.group.item,
      matrix: multiply(spin((best.turn * TAU) / entry.turns.length), entry.flat),
      // The footprint was built from the group's own origin, so shift by the difference between the placement and that origin.
      offset: [left + best.x * CELL - best.mark.min[0], bottom + best.y * CELL - best.mark.min[1], -best.mark.min[2]],
    });
  }
  return { placed, overflow };
}
