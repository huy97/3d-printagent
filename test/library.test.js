import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { makeZip64 } from './helpers.js';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'p3d-library-'));
process.env.PRINTAGENT3D_DATA_DIR = dataDir;
process.env.PRINTAGENT3D_LOG_LEVEL = 'error';

const { PATHS } = await import('../src/core/paths.js');
const library = await import('../src/core/library.js');

/** STL nhị phân rỗng hợp lệ, đủ để thư viện nhận file mà không cần hình khối thật. */
function stub(name) {
  const file = path.join(dataDir, name);
  const buffer = Buffer.alloc(84);
  buffer.writeUInt32LE(0, 80);
  writeFileSync(file, buffer);
  return file;
}

test('File do cắt lát sinh ra mang sourceId, lọc được khỏi danh sách file người dùng tự đưa vào', () => {
  library.loadLibrary();
  const source = library.addFromPath(stub('khoi.stl'), 'khoi.stl', { origin: 'ui' });
  const sliced = library.addFromPath(stub('khoi-sliced.stl'), 'khoi.gcode.3mf', { origin: 'ui', sourceId: source.id });

  assert.equal(source.sourceId, null);
  assert.equal(sliced.sourceId, source.id);

  const own = library.listFiles({ derived: false });
  assert.deepEqual(own.map((file) => file.id), [source.id]);

  const derived = library.listFiles({ derived: true });
  assert.deepEqual(derived.map((file) => file.id), [sliced.id]);

  assert.deepEqual(library.listFiles({ sourceId: source.id }).map((file) => file.id), [sliced.id]);
  assert.equal(library.listFiles().length, 2);
});

test('Thư viện cũ chưa có sourceId được ghép lại theo tên, file lạc vẫn giữ nguyên là file gốc', () => {
  const index = JSON.parse(readFileSync(PATHS.libraryIndex, 'utf8'));
  for (const file of index) delete file.sourceId;
  // Bản cắt lát không còn file gốc trong thư viện thì không ghép được với ai.
  index.push({ ...index[1], id: 'fil_lac', name: 'khac.gcode.3mf', storedName: index[1].storedName });
  writeFileSync(PATHS.libraryIndex, JSON.stringify(index, null, 2));

  const loaded = library.loadLibrary();
  const byName = Object.fromEntries(loaded.map((file) => [file.name, file]));
  assert.equal(byName['khoi.stl'].sourceId, null);
  assert.equal(byName['khoi.gcode.3mf'].sourceId, byName['khoi.stl'].id);
  assert.equal(byName['khac.gcode.3mf'].sourceId, null);

  // Ghép xong phải ghi lại, lần nạp sau không cần đoán nữa.
  const saved = JSON.parse(readFileSync(PATHS.libraryIndex, 'utf8'));
  assert.equal(saved.every((file) => file.sourceId !== undefined), true);
});

const CUBE = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]];
const FACES = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]];

test('File nhập từ trước khi đọc được zip64 sẽ được quét lại hình khối đúng một lượt', () => {
  const model = `<model><resources><object id="1" type="model"><mesh>
    <vertices>${CUBE.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices>
    <triangles>${FACES.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles>
  </mesh></object></resources><build><item objectid="1"/></build></model>`;
  const source = path.join(dataDir, 'zip64.3mf');
  writeFileSync(source, makeZip64({ '[Content_Types].xml': '<Types/>', '3D/3dmodel.model': model }));
  const added = library.addFromPath(source, 'zip64.3mf', { origin: 'ui', copy: true });
  assert.equal(added.meta.triangles, 12);

  // Giả lập bản ghi cũ: metadata thiếu hình khối vì bộ đọc zip khi đó chưa hiểu zip64.
  const index = JSON.parse(readFileSync(PATHS.libraryIndex, 'utf8'));
  const stale = index.find((file) => file.id === added.id);
  stale.meta = { format: '3mf', sliced: false, plates: [] };
  delete stale.metaScan;
  writeFileSync(PATHS.libraryIndex, JSON.stringify(index, null, 2));

  const loaded = library.loadLibrary();
  const file = loaded.find((item) => item.id === added.id);
  assert.equal(file.meta.triangles, 12);
  assert.deepEqual(file.meta.size, { x: 10, y: 10, z: 10 });

  // Đã quét thì đánh dấu lại, lần nạp sau không đọc file nữa.
  const saved = JSON.parse(readFileSync(PATHS.libraryIndex, 'utf8'));
  assert.equal(saved.every((item) => item.metaScan === 1), true);
});
