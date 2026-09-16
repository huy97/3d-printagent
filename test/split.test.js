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

/** Cube of edge `size`, shifted by `offset`, to build several disjoint solids in one file. */
function cube({ size = 1, offset = [0, 0, 0] } = {}) {
  return FACES.map((face) => face.map((corner) => CORNERS[corner].map((value, axis) => value * size + offset[axis])));
}

/** Box with three different edges, used to check the in-plane rotation when packing the bed. */
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

test('A multi-shell STL splits into separate objects, each mesh moved to its own origin', () => {
  const file = writeBinaryStl('two-cubes.stl', [...cube({ size: 10 }), ...cube({ size: 20, offset: [50, 0, 0] })]);
  const { buffer, parts } = splitModel(file, 'two-cubes.stl');

  assert.equal(parts.length, 2);
  // The larger solid comes first so the list shows the main part right away.
  assert.deepEqual(parts[0].size, { x: 20, y: 20, z: 20 });
  assert.deepEqual(parts[1].size, { x: 10, y: 10, z: 10 });
  assert.equal(parts[0].volumeCm3, 8);
  assert.equal(parts[0].triangles, 12);
  assert.deepEqual(parts.map((part) => part.name), ['two-cubes-1', 'two-cubes-2']);

  const { objects, items } = readObjects(buffer);
  assert.equal(objects.length, 2);
  assert.equal(items.length, 2);
  // The XY center and Z bottom move into the transform, the mesh keeps coordinates around the origin.
  assert.match(items[0], /transform="1 0 0 0 1 0 0 0 1 60 10 0"/);
  assert.match(items[1], /transform="1 0 0 0 1 0 0 0 1 5 5 0"/);
});

test('The split 3MF still reads back and keeps the overall size', () => {
  const file = writeBinaryStl('stack.stl', [...cube({ size: 10 }), ...cube({ size: 10, offset: [0, 0, 30] })]);
  const { buffer } = splitModel(file, 'stack.stl');
  const { file: output } = readObjects(buffer);

  const { meta } = extractMetadata(output, 'stack-split.3mf');
  assert.equal(meta.sliced, false);
  assert.equal(meta.triangles, 24);
  assert.deepEqual(meta.size, { x: 10, y: 10, z: 40 });
  assert.equal(meta.volumeCm3, 2);
});

test('Object names from the source 3MF are kept for each part', () => {
  const file = writeModel3mf('named.3mf', [cube({ size: 10 }), cube({ size: 10, offset: [40, 0, 0] })]);
  const { parts } = splitModel(file, 'named.3mf');
  assert.deepEqual(parts.map((part) => part.name).sort(), ['khoi-1', 'khoi-2']);
});

test('A model with a single connected shell errors instead of writing a pointless file', () => {
  const file = writeBinaryStl('one-cube.stl', cube({ size: 10 }));
  assert.throws(() => splitModel(file, 'one-cube.stl'), /một khối liền|single connected shell|split_single_part/);
});

const BED = { minX: 0, minY: 0, maxX: 100, maxY: 100, maxZ: 100, exclude: [] };

test('Rearranging spreads the separate solids over the bed and drops them onto it', () => {
  const file = writeBinaryStl('spread.stl', [...cube({ size: 10, offset: [0, 0, 12] }), ...cube({ size: 20, offset: [500, 0, 0] })]);
  const { buffer, clusters, overflow } = arrangeModel(file, 'spread.stl', BED);
  assert.equal(clusters, 2);
  assert.equal(overflow, 0);

  const { items } = readObjects(buffer);
  // The large solid takes the center of the 100 x 100 bed, the small one sits below it with enough clearance.
  assert.match(items[0], /transform="1 0 0 0 1 0 0 0 1 50 50 0"/);
  assert.match(items[1], /transform="1 0 0 0 1 0 0 0 1 50 28 0"/);
});

test('A wider gap pushes the separate solids further apart', () => {
  const file = writeBinaryStl('gap.stl', [...cube({ size: 10, offset: [0, 0, 12] }), ...cube({ size: 20, offset: [500, 0, 0] })]);
  const { items } = readObjects(arrangeModel(file, 'gap.stl', BED, { gap: 20 }).buffer);
  assert.match(items[0], /transform="1 0 0 0 1 0 0 0 1 50 50 0"/);
  assert.match(items[1], /transform="1 0 0 0 1 0 0 0 1 50 14 0"/);
});

test('Solids with overlapping footprints count as one cluster and keep their assembly when moved', () => {
  const file = writeBinaryStl('plate.stl', [...cube({ size: 20, offset: [300, 300, 0] }), ...cube({ size: 4, offset: [305, 305, 20] })]);
  const { items } = readObjects(arrangeModel(file, 'plate.stl', BED).buffer);

  // The base solid sits at the bed center.
  assert.match(items[0], /transform="1 0 0 0 1 0 0 0 1 50 50 0"/);
  // The raised lettering keeps its 3 mm offset on each side and still rests on the base.
  assert.match(items[1], /transform="1 0 0 0 1 0 0 0 1 47 47 20"/);
});

test('With separation on, the stacked solid is pulled off the base and packed on its own', () => {
  const file = writeBinaryStl('apart.stl', [...cube({ size: 20, offset: [300, 300, 0] }), ...cube({ size: 4, offset: [305, 305, 20] })]);
  const result = arrangeModel(file, 'apart.stl', BED, { separate: true });
  assert.equal(result.clusters, 2);
  const { items } = readObjects(result.buffer);
  // The small solid drops to the bed instead of resting on top of the base.
  assert.match(items[0], /transform="1 0 0 0 1 0 0 0 1 50 50 0"/);
  assert.match(items[1], /transform="1 0 0 0 1 0 0 0 1 50 32 0"/);
});

test('A solid too deep for the bed is turned sideways to fit', () => {
  const file = writeBinaryStl('bar.stl', box([10, 110, 10]));
  const { items } = readObjects(arrangeModel(file, 'bar.stl', { ...BED, maxX: 140 }).buffer);
  // Rotated 90 degrees about Z and still centered on the 140 x 100 bed.
  assert.match(items[0], /transform="0 1 0 -1 0 0 0 0 1 70 50 0"/);
});

test('With auto rotate on, an upright slab is flipped so its widest face lies on the bed', () => {
  const file = writeBinaryStl('slab.stl', box([5, 40, 40]));
  const { items } = readObjects(arrangeModel(file, 'slab.stl', BED, { autoRotate: true }).buffer);
  // The 5 mm thin axis becomes the height, the 40 x 40 face rests on the bed.
  assert.match(items[0], /transform="0 0 1 0 1 0 -1 0 0 70 50 2.5"/);
});

test('An unknown bed errors instead of packing blindly', () => {
  const file = writeBinaryStl('nobed.stl', cube({ size: 10 }));
  assert.throws(() => arrangeModel(file, 'nobed.stl', null), /bàn in|bed size|arrange_no_bed/);
});

test('A solid larger than the bed errors', () => {
  const file = writeBinaryStl('huge.stl', cube({ size: 400 }));
  assert.throws(() => arrangeModel(file, 'huge.stl', BED), /vừa bàn in|fits on the bed|arrange_too_large/);
});

test('An exclusion zone blocks centering, the solid backs off instead of overlapping it', () => {
  const file = writeBinaryStl('avoid.stl', cube({ size: 50 }));
  const bed = { ...BED, exclude: [[0, 0], [35, 0], [35, 35], [0, 35]] };
  const { items } = readObjects(arrangeModel(file, 'avoid.stl', bed).buffer);

  // Still centered horizontally, but shifted back in depth to clear the exclusion zone.
  assert.match(items[0], /transform="1 0 0 0 1 0 0 0 1 50 60 0"/);
});

test('After a drag only the build item translation changes, the geometry stays', () => {
  const source = writeBinaryStl('drag.stl', [...cube({ size: 10, offset: [0, 0, 12] }), ...cube({ size: 20, offset: [500, 0, 0] })]);
  const arranged = path.join(dir, 'drag.3mf');
  writeFileSync(arranged, arrangeModel(source, 'drag.stl', BED).buffer);

  const { buffer, moved } = moveBuildItems(arranged, 'drag.3mf', [{ item: 1, dx: -7.5, dy: 3 }]);
  assert.equal(moved, 1);

  const after = readObjects(buffer);
  // The untouched object stays put, the dragged one moves exactly by the reported amount.
  assert.match(after.items[0], /transform="1 0 0 0 1 0 0 0 1 50 50 0"/);
  assert.match(after.items[1], /transform="1 0 0 0 1 0 0 0 1 42.5 31 0"/);
  assert.equal(after.objects.length, 2);
});

test('Nothing to move errors instead of overwriting the file', () => {
  const source = writeBinaryStl('still.stl', [...cube({ size: 10, offset: [0, 0, 12] }), ...cube({ size: 20, offset: [500, 0, 0] })]);
  const arranged = path.join(dir, 'still.3mf');
  writeFileSync(arranged, arrangeModel(source, 'still.stl', BED).buffer);
  assert.throws(() => moveBuildItems(arranged, 'still.3mf', []), /cần dời|to move|layout_no_move/);
});
