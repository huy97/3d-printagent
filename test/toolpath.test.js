import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES, packToolpath, parseToolpath } from '../src/gcode/toolpath.js';

/** Toạ độ giữ ở Float32 nên so sánh phải làm tròn về đúng độ chính xác của máy in. */
const mm = (values) => [...values].map((value) => Math.round(value * 1000) / 1000);

/** Một lớp mẫu viết đúng kiểu BambuStudio: E tương đối, số rút gọn, có cả đoạn di chuyển lẫn đoạn đùn. */
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

test('Đọc G-code ra từng đoạn đùn, kèm loại đường và mốc lớp', () => {
  const path = parseToolpath(SAMPLE);

  // Bốn đoạn in: hai thành ngoài, một đổ đầy thưa, một thành trong; mỗi đoạn là một cặp điểm.
  assert.equal(path.points, 8);
  assert.equal(path.truncated, false);

  const names = [];
  for (let at = 0; at < path.points; at += 2) names.push(FEATURES[path.feature[at]]);
  assert.deepEqual(names, ['Outer wall', 'Outer wall', 'Sparse infill', 'Inner wall']);

  // Đoạn đầu nối từ chỗ vòi phun đang đứng tới điểm mới, không phải từ gốc toạ độ.
  assert.deepEqual(mm(path.positions.slice(0, 6)), [10, 10, 0.2, 20, 10, 0.2]);

  // Rút sợi tại chỗ (`G1 E-.8`) không phải đoạn in nên không được vẽ.
  assert.deepEqual(mm(path.positions.slice(12, 18)), [15, 15, 0.2, 18, 18, 0.2]);

  assert.deepEqual(path.layers, [
    { z: 0.2, point: 0 },
    { z: 0.4, point: 6 },
  ]);
  assert.deepEqual([...path.layer], [1, 1, 1, 1, 1, 1, 2, 2]);
  assert.deepEqual(mm(path.bbox), [10, 10, 0.2, 20, 20, 0.2]);
});

test('Đoạn lau vòi in trước mốc lớp đầu tiên vẫn nằm trong lớp một', () => {
  const path = parseToolpath(
    ['M83', '; FEATURE: Custom', 'G1 X5 Y0 E.2', '; CHANGE_LAYER', '; Z_HEIGHT: 0.2', '; FEATURE: Outer wall', 'G1 X10 Y0 E.3'].join('\n'),
  );
  assert.equal(path.points, 4);
  assert.deepEqual(path.layers, [{ z: 0.2, point: 0 }]);
});

test('E tuyệt đối chỉ tính là đùn khi lượng nhựa tăng lên', () => {
  const path = parseToolpath(['M82', 'G1 X0 Y0', 'G1 X10 Y0 E1', 'G1 X20 Y0 E1', 'G92 E0', 'G1 X30 Y0 E1'].join('\n'));
  // Đoạn giữa giữ nguyên E nên không có nhựa ra; G92 đặt lại mốc cho đoạn cuối được tính.
  assert.equal(path.points, 4);
  assert.deepEqual(mm(path.positions.slice(0, 3)), [0, 0, 0]);
  assert.deepEqual(mm(path.positions.slice(9, 12)), [30, 0, 0]);
});

test('Chạm trần số điểm thì cắt bớt và báo lại, lớp rỗng không lọt vào thanh trượt', () => {
  const lines = ['M83', '; CHANGE_LAYER', '; Z_HEIGHT: 0.2', '; FEATURE: Inner wall'];
  for (let at = 1; at <= 20; at += 1) lines.push(`G1 X${at} Y0 E.1`);
  const path = parseToolpath(lines.join('\n'), { maxPoints: 7 });

  assert.equal(path.truncated, true);
  assert.equal(path.points, 6);
  assert.equal(path.layers.length, 1);
  assert.equal(path.positions.length, 18);
});

test('Gói nhị phân mô tả đúng số điểm và kèm đủ ba mảng dữ liệu', () => {
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
