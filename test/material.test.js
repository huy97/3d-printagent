import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gramsAtLayer, measureText } from '../src/gcode/material.js';
import { orientModel } from '../src/gcode/orient.js';
import { combineModels } from '../src/gcode/split.js';
import { openZip } from '../src/gcode/zip.js';

const dir = mkdtempSync(path.join(tmpdir(), 'p3d-material-'));

const CORNERS = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
const FACES = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]];

function box(size, offset = [0, 0, 0]) {
  return FACES.map((face) => face.map((corner) => CORNERS[corner].map((value, axis) => value * size[axis] + offset[axis])));
}

function writeStl(name, triangles) {
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

function modelOf(buffer) {
  const file = path.join(dir, `out-${Math.random().toString(36).slice(2)}.3mf`);
  writeFileSync(file, buffer);
  const zip = openZip(file);
  try {
    return zip.read('3D/3dmodel.model').toString('utf8');
  } finally {
    zip.close();
  }
}

test('Filament measure: splits product, support, bed adhesion and the purge before the first layer', () => {
  const gcode = [
    '; filament_type = PETG',
    'M83',
    'G1 X0 Y0 E500',
    ';LAYER_CHANGE',
    ';TYPE:Skirt/Brim',
    'G1 X1 E200',
    ';TYPE:External perimeter',
    'G1 X2 E1000',
    ';LAYER_CHANGE',
    ';TYPE:Support material',
    'G1 X3 E400',
    ';TYPE:Perimeter',
    'G1 X4 E1000',
    'T1',
    'G1 X5 E300',
  ].join('\n');
  const result = measureText(gcode);
  assert.equal(result.totalMm, 3400);
  assert.equal(result.material, 'PETG');
  assert.equal(result.layerCount, 2);
  const perMm = result.totalG / 3400;
  assert.ok(Math.abs(perMm - (Math.PI * 0.875 ** 2 * 1.27) / 1000) < 1e-5);
  assert.ok(Math.abs(result.grams.purge - 500 * perMm) < 0.02);
  assert.ok(Math.abs(result.grams.adhesion - 200 * perMm) < 0.02);
  assert.ok(Math.abs(result.grams.support - 400 * perMm) < 0.02);
  assert.ok(Math.abs(result.productG - 2300 * perMm) < 0.02);
  assert.ok(Math.abs(result.wasteG - 1100 * perMm) < 0.02);
  assert.deepEqual(
    result.tools.map((item) => [item.tool, item.mm]),
    [
      [0, 3100],
      [1, 300],
    ],
  );
  assert.ok(Math.abs(gramsAtLayer(result, 1) - 1700 * perMm) < 0.1);
  assert.equal(gramsAtLayer(result, 0), 0);
  assert.ok(gramsAtLayer(result, 99) <= result.totalG);
});

test('Filament measure: absolute E only adds the increase, retraction and G92 do not count', () => {
  const result = measureText(['M82', ';LAYER_CHANGE', 'G92 E0', 'G1 E5', 'G1 E3', 'G1 E8', 'G92 E0', 'G1 E2'].join('\n'));
  assert.equal(result.totalMm, 12);
  assert.equal(result.grams.purge, 0);
});

test('Auto-orient: an upright plate is laid flat, a cube is left alone', () => {
  const plate = writeStl('tam-dung.stl', box([2, 40, 30]));
  const result = orientModel(plate, 'tam-dung.stl');
  assert.equal(result.changed, true);
  assert.ok(result.after.heightMm <= 2.1, `height ${result.after.heightMm}`);
  assert.ok(result.after.contactCm2 > result.before.contactCm2);
  assert.match(modelOf(result.buffer), /<item objectid="1" transform="/);

  const cube = writeStl('lap-phuong.stl', box([20, 20, 20]));
  assert.equal(orientModel(cube, 'lap-phuong.stl').changed, false);
});

test('Auto-orient: an upside-down T shape is flipped so the overhang sits at the bottom', () => {
  const tee = writeStl('chu-t.stl', [...box([6, 6, 30], [7, 7, 0]), ...box([20, 20, 4], [0, 0, 30])]);
  const result = orientModel(tee, 'chu-t.stl');
  assert.equal(result.changed, true);
  assert.ok(result.after.supportCm3 < result.before.supportCm3);
});

test('Plate packing: several files and copies become separate objects on one bed', () => {
  const small = writeStl('nho.stl', box([10, 10, 5]));
  const tall = writeStl('cao.stl', box([8, 8, 20]));
  const bed = { minX: 0, minY: 0, maxX: 220, maxY: 220 };
  const result = combineModels(
    [
      { filePath: small, name: 'nho.stl', copies: 3 },
      { filePath: tall, name: 'cao.stl', copies: 2 },
    ],
    bed,
  );
  assert.equal(result.placed, 5);
  assert.equal(result.overflow, 0);
  const model = modelOf(result.buffer);
  assert.equal([...model.matchAll(/<item /g)].length, 5);
  assert.deepEqual(result.parts.map((part) => part.name).sort(), ['cao', 'cao-5', 'nho', 'nho-2', 'nho-3'].sort());

  const crowded = combineModels([{ filePath: tall, name: 'cao.stl', copies: 60 }], { minX: 0, minY: 0, maxX: 40, maxY: 40 });
  assert.ok(crowded.overflow > 0);
  assert.deepEqual(crowded.overflowNames, ['cao.stl']);
});
