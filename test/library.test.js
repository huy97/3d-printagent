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

/** Valid empty binary STL, enough for the library to accept a file without real geometry. */
function stub(name) {
  const file = path.join(dataDir, name);
  const buffer = Buffer.alloc(84);
  buffer.writeUInt32LE(0, 80);
  writeFileSync(file, buffer);
  return file;
}

test('Sliced output carries a sourceId and filters out of the user-added file list', () => {
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

test('An older library without sourceId is re-linked by name, an orphan stays a source file', () => {
  const index = JSON.parse(readFileSync(PATHS.libraryIndex, 'utf8'));
  for (const file of index) delete file.sourceId;
  // A sliced file whose source is gone from the library has nothing to link to.
  index.push({ ...index[1], id: 'fil_lac', name: 'khac.gcode.3mf', storedName: index[1].storedName });
  writeFileSync(PATHS.libraryIndex, JSON.stringify(index, null, 2));

  const loaded = library.loadLibrary();
  const byName = Object.fromEntries(loaded.map((file) => [file.name, file]));
  assert.equal(byName['khoi.stl'].sourceId, null);
  assert.equal(byName['khoi.gcode.3mf'].sourceId, byName['khoi.stl'].id);
  assert.equal(byName['khac.gcode.3mf'].sourceId, null);

  // The link is persisted so the next load does not have to guess again.
  const saved = JSON.parse(readFileSync(PATHS.libraryIndex, 'utf8'));
  assert.equal(saved.every((file) => file.sourceId !== undefined), true);
});

const CUBE = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]];
const FACES = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]];

test('Files imported before zip64 support are rescanned for geometry exactly once', () => {
  const model = `<model><resources><object id="1" type="model"><mesh>
    <vertices>${CUBE.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices>
    <triangles>${FACES.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles>
  </mesh></object></resources><build><item objectid="1"/></build></model>`;
  const source = path.join(dataDir, 'zip64.3mf');
  writeFileSync(source, makeZip64({ '[Content_Types].xml': '<Types/>', '3D/3dmodel.model': model }));
  const added = library.addFromPath(source, 'zip64.3mf', { origin: 'ui', copy: true });
  assert.equal(added.meta.triangles, 12);

  // Simulate an old record: metadata has no geometry because the zip reader did not understand zip64 back then.
  const index = JSON.parse(readFileSync(PATHS.libraryIndex, 'utf8'));
  const stale = index.find((file) => file.id === added.id);
  stale.meta = { format: '3mf', sliced: false, plates: [] };
  delete stale.metaScan;
  writeFileSync(PATHS.libraryIndex, JSON.stringify(index, null, 2));

  const loaded = library.loadLibrary();
  const file = loaded.find((item) => item.id === added.id);
  assert.equal(file.meta.triangles, 12);
  assert.deepEqual(file.meta.size, { x: 10, y: 10, z: 10 });

  // Once scanned it is marked, so the next load no longer reads the file.
  const saved = JSON.parse(readFileSync(PATHS.libraryIndex, 'utf8'));
  assert.equal(saved.every((item) => item.metaScan === 1), true);
});
