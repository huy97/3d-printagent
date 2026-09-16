import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { arrangeModel, moveBuildItems, splitModel } from '../src/gcode/split.js';
import { extractMetadata } from '../src/gcode/metadata.js';
import { openZip } from '../src/gcode/zip.js';
import { makeZip } from './helpers.js';

const dir = mkdtempSync(path.join(tmpdir(), 'p3d-split-'));

const CORNERS = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
const FACES = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]];

/** Hộp lập phương cạnh `size`, dời đi `offset` để dựng nhiều khối rời nhau trong cùng một file. */
function cube({ size = 1, offset = [0, 0, 0] } = {}) {
  return FACES.map((face) => face.map((corner) => CORNERS[corner].map((value, axis) => value * size + offset[axis])));
}

/** Hộp chữ nhật với ba cạnh khác nhau, dùng để kiểm tra phần xoay ngang khi xếp bàn. */
function box(size, offset = [0, 0, 0]) {
  return FACES.map((face) => face.map((corner) => CORNERS[corner].map((value, axis) => value * size[axis] + offset[axis])));
}

function writeBinaryStl(name, triangles) {
  const buffer = Buffer.alloc(84 + triangles.length * 50);
  buffer.writeUInt32LE(triangles.length, 80);
  triangles.forEach((triangle, index) => {
    const at = 84 + index * 50 + 12;
    triangle.flat().forEach((value, item) => buffer.writeFloatLE(value, at + item * 4));
  });
  const file = path.join(dir, name);
  writeFileSync(file, buffer);
  return file;
}

function writeModel3mf(name, meshes) {
  const objects = meshes
    .map((triangles, index) => {
      const points = [];
      const lookup = new Map();
      const faces = triangles.map((triangle) =>
        triangle.map((point) => {
          const key = point.join(',');
          if (!lookup.has(key)) {
            lookup.set(key, points.length);
            points.push(point);
          }
          return lookup.get(key);
        }),
      );
      return `<object id="${index + 1}" type="model" name="khoi-${index + 1}"><mesh>
        <vertices>${points.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices>
        <triangles>${faces.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles>
      </mesh></object>`;
    })
    .join('');
  const model = `<model><resources>${objects}</resources><build>${meshes
    .map((_mesh, index) => `<item objectid="${index + 1}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`)
    .join('')}</build></model>`;
  const file = path.join(dir, name);
  writeFileSync(file, makeZip({ '3D/3dmodel.model': model }));
  return file;
}

function readObjects(buffer) {
  const file = path.join(dir, `read-${Math.random().toString(36).slice(2)}.3mf`);
  writeFileSync(file, buffer);
  const zip = openZip(file);
  try {
    const model = zip.read('3D/3dmodel.model').toString('utf8');
    return {
      file,
      model,
      objects: [...model.matchAll(/<object\s[^>]*>/g)].map((match) => match[0]),
      items: [...model.matchAll(/<item\s[^>]*>/g)].map((match) => match[0]),
    };
  } finally {
    zip.close();
  }
}

test('STL nhiều khối rời được tách thành từng vật thể, mesh dời về gốc riêng', () => {
  const file = writeBinaryStl('two-cubes.stl', [...cube({ size: 10 }), ...cube({ size: 20, offset: [50, 0, 0] })]);
  const { buffer, parts } = splitModel(file, 'two-cubes.stl');

  assert.equal(parts.length, 2);
  // Khối to đứng trước để người dùng nhìn danh sách là biết phần chính.
  assert.deepEqual(parts[0].size, { x: 20, y: 20, z: 20 });
  assert.deepEqual(parts[1].size, { x: 10, y: 10, z: 10 });
  assert.equal(parts[0].volumeCm3, 8);
  assert.equal(parts[0].triangles, 12);
  assert.deepEqual(parts.map((part) => part.name), ['two-cubes-1', 'two-cubes-2']);

  const { objects, items } = readObjects(buffer);
  assert.equal(objects.length, 2);
  assert.equal(items.length, 2);
  // Tâm XY và đáy Z của khối được đẩy sang transform, mesh giữ toạ độ quanh gốc.
  assert.match(items[0], /transform="1 0 0 0 1 0 0 0 1 60 10 0"/);
  assert.match(items[1], /transform="1 0 0 0 1 0 0 0 1 5 5 0"/);
});

test('3MF tách xong vẫn đọc lại được và giữ nguyên tổng kích thước', () => {
  const file = writeBinaryStl('stack.stl', [...cube({ size: 10 }), ...cube({ size: 10, offset: [0, 0, 30] })]);
  const { buffer } = splitModel(file, 'stack.stl');
  const { file: output } = readObjects(buffer);

  const { meta } = extractMetadata(output, 'stack-split.3mf');
  assert.equal(meta.sliced, false);
  assert.equal(meta.triangles, 24);
  assert.deepEqual(meta.size, { x: 10, y: 10, z: 40 });
  assert.equal(meta.volumeCm3, 2);
});

test('Tên vật thể trong 3MF nguồn được giữ lại cho từng phần', () => {
  const file = writeModel3mf('named.3mf', [cube({ size: 10 }), cube({ size: 10, offset: [40, 0, 0] })]);
  const { parts } = splitModel(file, 'named.3mf');
  assert.deepEqual(parts.map((part) => part.name).sort(), ['khoi-1', 'khoi-2']);
});

test('Mô hình chỉ có một khối liền thì báo lỗi thay vì tạo file thừa', () => {
  const file = writeBinaryStl('one-cube.stl', cube({ size: 10 }));
  assert.throws(() => splitModel(file, 'one-cube.stl'), /một khối liền|single connected shell|split_single_part/);
});

const BED = { minX: 0, minY: 0, maxX: 100, maxY: 100, maxZ: 100, exclude: [] };

test('Xếp lại thì các khối rời được rải ra trong lòng bàn in và hạ sát mặt bàn', () => {
  const file = writeBinaryStl('spread.stl', [...cube({ size: 10, offset: [0, 0, 12] }), ...cube({ size: 20, offset: [500, 0, 0] })]);
  const { buffer, clusters, overflow } = arrangeModel(file, 'spread.stl', BED);
  assert.equal(clusters, 2);
  assert.equal(overflow, 0);

  const { items } = readObjects(buffer);
  // Khối to chiếm đúng tâm bàn 100 x 100, khối nhỏ nằm sát dưới và vẫn giữ đủ khoảng hở.
  assert.match(items[0], /transform="1 0 0 0 1 0 0 0 1 50 50 0"/);
  assert.match(items[1], /transform="1 0 0 0 1 0 0 0 1 50 28 0"/);
});

test('Nới khoảng hở thì các khối rời phải đứng xa nhau hơn', () => {
  const file = writeBinaryStl('gap.stl', [...cube({ size: 10, offset: [0, 0, 12] }), ...cube({ size: 20, offset: [500, 0, 0] })]);
  const { items } = readObjects(arrangeModel(file, 'gap.stl', BED, { gap: 20 }).buffer);
  assert.match(items[0], /transform="1 0 0 0 1 0 0 0 1 50 50 0"/);
  assert.match(items[1], /transform="1 0 0 0 1 0 0 0 1 50 14 0"/);
});

test('Khối chồng bóng nhau được coi là một cụm, giữ nguyên cách ráp khi dời lên bàn', () => {
  const file = writeBinaryStl('plate.stl', [...cube({ size: 20, offset: [300, 300, 0] }), ...cube({ size: 4, offset: [305, 305, 20] })]);
  const { items } = readObjects(arrangeModel(file, 'plate.stl', BED).buffer);

  // Khối nền nằm đúng tâm bàn.
  assert.match(items[0], /transform="1 0 0 0 1 0 0 0 1 50 50 0"/);
  // Chữ nổi vẫn lệch đúng 3 mm theo mỗi cạnh và vẫn nằm trên mặt khối nền.
  assert.match(items[1], /transform="1 0 0 0 1 0 0 0 1 47 47 20"/);
});

test('Bật tách cụm thì khối nổi bị rã ra khỏi khối nền và xếp riêng', () => {
  const file = writeBinaryStl('apart.stl', [...cube({ size: 20, offset: [300, 300, 0] }), ...cube({ size: 4, offset: [305, 305, 20] })]);
  const result = arrangeModel(file, 'apart.stl', BED, { separate: true });
  assert.equal(result.clusters, 2);
  const { items } = readObjects(result.buffer);
  // Khối nhỏ rơi xuống mặt bàn chứ không còn nằm trên nóc khối nền.
  assert.match(items[0], /transform="1 0 0 0 1 0 0 0 1 50 50 0"/);
  assert.match(items[1], /transform="1 0 0 0 1 0 0 0 1 50 32 0"/);
});

test('Khối dài quá bàn theo chiều sâu thì được quay ngang cho vừa', () => {
  const file = writeBinaryStl('bar.stl', box([10, 110, 10]));
  const { items } = readObjects(arrangeModel(file, 'bar.stl', { ...BED, maxX: 140 }).buffer);
  // Quay 90 độ quanh trục Z rồi vẫn đứng đúng tâm bàn 140 x 100.
  assert.match(items[0], /transform="0 1 0 -1 0 0 0 0 1 70 50 0"/);
});

test('Bật auto rotate thì tấm dựng đứng được lật cho mặt rộng nhất úp xuống bàn', () => {
  const file = writeBinaryStl('slab.stl', box([5, 40, 40]));
  const { items } = readObjects(arrangeModel(file, 'slab.stl', BED, { autoRotate: true }).buffer);
  // Trục mỏng 5 mm quay lên thành chiều cao, đáy 40 x 40 nằm sát bàn.
  assert.match(items[0], /transform="0 0 1 0 1 0 -1 0 0 70 50 2.5"/);
});

test('Chưa biết bàn in thì báo lỗi thay vì xếp bừa', () => {
  const file = writeBinaryStl('nobed.stl', cube({ size: 10 }));
  assert.throws(() => arrangeModel(file, 'nobed.stl', null), /bàn in|bed size|arrange_no_bed/);
});

test('Khối to hơn cả bàn in thì báo lỗi', () => {
  const file = writeBinaryStl('huge.stl', cube({ size: 400 }));
  assert.throws(() => arrangeModel(file, 'huge.stl', BED), /vừa bàn in|fits on the bed|arrange_too_large/);
});

test('Vùng cấm của bàn chặn việc dồn vào giữa, khối lùi ra chứ không đè lên', () => {
  const file = writeBinaryStl('avoid.stl', cube({ size: 50 }));
  const bed = { ...BED, exclude: [[0, 0], [35, 0], [35, 35], [0, 35]] };
  const { items } = readObjects(arrangeModel(file, 'avoid.stl', bed).buffer);

  // Vẫn đứng giữa theo chiều ngang, còn chiều sâu phải lùi lên cho khỏi đè vùng cấm.
  assert.match(items[0], /transform="1 0 0 0 1 0 0 0 1 50 60 0"/);
});

test('Kéo thả xong thì chỉ phần tịnh tiến của build item đổi, hình khối giữ nguyên', () => {
  const source = writeBinaryStl('drag.stl', [...cube({ size: 10, offset: [0, 0, 12] }), ...cube({ size: 20, offset: [500, 0, 0] })]);
  const arranged = path.join(dir, 'drag.3mf');
  writeFileSync(arranged, arrangeModel(source, 'drag.stl', BED).buffer);

  const { buffer, moved } = moveBuildItems(arranged, 'drag.3mf', [{ item: 1, dx: -7.5, dy: 3 }]);
  assert.equal(moved, 1);

  const after = readObjects(buffer);
  // Vật không bị kéo đứng yên, vật bị kéo dời đúng khoảng đã báo.
  assert.match(after.items[0], /transform="1 0 0 0 1 0 0 0 1 50 50 0"/);
  assert.match(after.items[1], /transform="1 0 0 0 1 0 0 0 1 42.5 31 0"/);
  assert.equal(after.objects.length, 2);
});

test('Không có vật nào cần dời thì báo lỗi chứ không ghi đè file', () => {
  const source = writeBinaryStl('still.stl', [...cube({ size: 10, offset: [0, 0, 12] }), ...cube({ size: 20, offset: [500, 0, 0] })]);
  const arranged = path.join(dir, 'still.3mf');
  writeFileSync(arranged, arrangeModel(source, 'still.stl', BED).buffer);
  assert.throws(() => moveBuildItems(arranged, 'still.3mf', []), /cần dời|to move|layout_no_move/);
});
