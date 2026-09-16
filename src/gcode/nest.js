/**
 * Xếp hình 2D cho bàn in: dựng bóng thật của từng cụm khối lên lưới điểm ảnh rồi tìm chỗ trống gần tâm bàn nhất.
 * Nhờ làm việc trên bóng thật chứ không phải khung bao chữ nhật, vật hình chữ L hay hình vành khuyên lồng được vào nhau.
 */

/** Ô lưới 1 mm: mịn hơn cả đường kính vòi phun mà bàn 350 mm vẫn chỉ hết hơn trăm nghìn ô. */
const CELL = 1;
/** Quá số cụm này thì tìm chỗ theo bước thưa hơn, đổi một chút độ khít lấy thời gian chờ. */
const MANY = 40;
/** Trần số phép thử cho mỗi cụm, để mô hình bệnh không treo máy chủ. */
const BUDGET = 6000000;

const TAU = Math.PI * 2;

/** Nhân ma trận xoay 3x3 (quy ước cột: p' = M·p). */
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
 * Hướng nên úp xuống bàn: gom diện tích các mặt theo hướng pháp tuyến, hướng nào nhiều diện tích phẳng nhất thì chọn.
 * Đây đúng là cách chọn mặt đế của phần mềm cắt lát - mặt bám bàn rộng nhất thì ít cong vênh và ít cần hỗ trợ nhất.
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
    // Làm tròn về lưới 0,02 để các mặt cùng một phẳng gộp chung một ô, sai số dựng lưới không xé chúng ra.
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

/** Ma trận xoay đưa `normal` về đúng chiều úp xuống bàn (0, 0, -1). */
export function layFlat(normal) {
  if (!normal) return IDENTITY;
  const target = [0, 0, -1];
  const dot = normal[0] * target[0] + normal[1] * target[1] + normal[2] * target[2];
  if (dot > 0.9999) return IDENTITY;
  // Đã quay lưng lại đúng 180 độ thì trục quay nào vuông góc cũng được, lấy trục X cho gọn.
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

/** Tô đặc một tam giác lên lưới bằng cách quét từng hàng, dùng chung cho cả bóng vật lẫn vùng cấm. */
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
 * Bóng của một cụm trên mặt bàn, đã quay sẵn và dời về gốc lưới.
 * Trả về cả danh sách ô đặc để phép thử va chạm chỉ phải duyệt đúng phần có vật.
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
  // Mô hình mỏng hơn một ô lưới vẫn phải chiếm chỗ, nếu không hai vật dẹt sẽ chồng lên nhau.
  if (cells.length === 0) {
    grid[0] = 1;
    cells.push(0);
  }
  return { width, height, cells, min: [minX, minY, minZ], size: [maxX - minX, maxY - minY] };
}

/** Ghi bóng của một cụm vào lưới bàn, nới rộng thêm `spread` ô để vật sau phải giữ khoảng hở. */
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

/** Các mốc thử trên một trục: canh sao cho đúng giữa bàn luôn rơi vào mốc, thêm hai mép để góc bàn vẫn dùng được. */
function marks(want, span, step) {
  const list = [];
  for (let value = Math.round(want) % step; value <= span; value += step) list.push(value);
  if (span > 0 && !list.includes(0)) list.push(0);
  if (span > 0 && !list.includes(span)) list.push(span);
  return list;
}

/** Danh sách chỗ thử, chỗ nào kéo tâm vật về gần tâm bàn nhất thì thử trước. */
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
 * Xếp các cụm lên bàn. Mỗi cụm là `{ each, item }` với `each(cb)` duyệt tam giác; trả về vị trí và ma trận xoay của từng cụm.
 * `bed` theo milimét, `exclude` là khung bao vùng cấm (chỗ lau vòi) nếu có.
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
  // Cụm chiếm nhiều ô nhất xếp trước: chỗ khó đặt phải được chọn chỗ khi bàn còn rộng.
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
      // Bóng được dựng từ gốc riêng của cụm, nên dời đúng khoảng chênh giữa chỗ đặt và gốc đó.
      offset: [left + best.x * CELL - best.mark.min[0], bottom + best.y * CELL - best.mark.min[1], -best.mark.min[2]],
    });
  }
  return { placed, overflow };
}
