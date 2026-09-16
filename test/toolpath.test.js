import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES, packToolpath, parseToolpath } from '../src/gcode/toolpath.js';

/** Coordinates are kept as Float32, so comparisons round to printer precision. */
const mm = (values) => [...values].map((value) => Math.round(value * 1000) / 1000);

/** A sample layer in BambuStudio style: relative E, shortened numbers, both travel and extrusion moves. */
const SAMPLE = [
  'M83',
  '; CHANGE_LAYER',
  '; Z_HEIGHT: 0.2',
  'G1 Z.2 F1200',
  '; FEATURE: Outer wall',
  'G1 X10 Y10 F9000',
  'G1 X20 Y10 E.64064 F1800',
  'G1 X20 Y20 E.64064',
  '; FEATURE: Sparse infill',
  'G1 X15 Y15 F9000',
  'G1 X18 Y18 E.3 F2400',
  'G1 E-.8 F1800',
  '; CHANGE_LAYER',
  '; Z_HEIGHT: 0.4',
  '; FEATURE: Inner wall',
  'G1 X10 Y10 E.5 F1800',
].join('\n');

test('Parses G-code into extrusion segments with feature type and layer marks', () => {
  const path = parseToolpath(SAMPLE);

  // Four printed segments: two outer walls, one sparse infill, one inner wall; each segment is a point pair.
  assert.equal(path.points, 8);
  assert.equal(path.truncated, false);

  const names = [];
  for (let at = 0; at < path.points; at += 2) names.push(FEATURES[path.feature[at]]);
  assert.deepEqual(names, ['Outer wall', 'Outer wall', 'Sparse infill', 'Inner wall']);

  // The first segment runs from where the nozzle stands to the new point, not from the origin.
  assert.deepEqual(mm(path.positions.slice(0, 6)), [10, 10, 0.2, 20, 10, 0.2]);

  // An in-place retraction (`G1 E-.8`) is not a printed segment, so it is not drawn.
  assert.deepEqual(mm(path.positions.slice(12, 18)), [15, 15, 0.2, 18, 18, 0.2]);

  assert.deepEqual(path.layers, [
    { z: 0.2, point: 0 },
    { z: 0.4, point: 6 },
  ]);
  assert.deepEqual([...path.layer], [1, 1, 1, 1, 1, 1, 2, 2]);
  assert.deepEqual(mm(path.bbox), [10, 10, 0.2, 20, 20, 0.2]);
});

test('A nozzle wipe printed before the first layer mark still belongs to layer one', () => {
  const path = parseToolpath(
    ['M83', '; FEATURE: Custom', 'G1 X5 Y0 E.2', '; CHANGE_LAYER', '; Z_HEIGHT: 0.2', '; FEATURE: Outer wall', 'G1 X10 Y0 E.3'].join('\n'),
  );
  assert.equal(path.points, 4);
  assert.deepEqual(path.layers, [{ z: 0.2, point: 0 }]);
});

test('Absolute E counts as extrusion only when the filament amount rises', () => {
  const path = parseToolpath(['M82', 'G1 X0 Y0', 'G1 X10 Y0 E1', 'G1 X20 Y0 E1', 'G92 E0', 'G1 X30 Y0 E1'].join('\n'));
  // The middle move keeps E unchanged so nothing extrudes; G92 resets the baseline so the last move counts.
  assert.equal(path.points, 4);
  assert.deepEqual(mm(path.positions.slice(0, 3)), [0, 0, 0]);
  assert.deepEqual(mm(path.positions.slice(9, 12)), [30, 0, 0]);
});

test('Hitting the point cap truncates and reports it, empty layers stay out of the slider', () => {
  const lines = ['M83', '; CHANGE_LAYER', '; Z_HEIGHT: 0.2', '; FEATURE: Inner wall'];
  for (let at = 1; at <= 20; at += 1) lines.push(`G1 X${at} Y0 E.1`);
  const path = parseToolpath(lines.join('\n'), { maxPoints: 7 });

  assert.equal(path.truncated, true);
  assert.equal(path.points, 6);
  assert.equal(path.layers.length, 1);
  assert.equal(path.positions.length, 18);
});

test('The binary package reports the right point count and carries all three data arrays', () => {
  const path = { ...parseToolpath(SAMPLE), plate: 1, plates: [1], bed: null };
  const buffer = packToolpath(path);

  const headerLength = buffer.readUInt32LE(0);
  const header = JSON.parse(buffer.subarray(4, 4 + headerLength).toString('utf8'));
  assert.equal(header.points, 8);
  assert.deepEqual(header.features, FEATURES);
  assert.equal(header.layers.length, 2);

  const padded = Math.ceil(headerLength / 4) * 4;
  assert.equal(buffer.length, 4 + padded + 8 * 3 * 4 + 8 + 8 * 2);
});
