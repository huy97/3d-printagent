import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'p3d-mcp-'));
process.env.PRINTAGENT3D_DATA_DIR = dataDir;
process.env.PRINTAGENT3D_LOG_LEVEL = 'error';

const { vi } = await import('../src/i18n/vi.js');
const { en } = await import('../src/i18n/en.js');
const { createMcpServer, toolNames } = await import('../src/mcp/server.js');
const { createLocalApi } = await import('../src/mcp/api.js');

test('Tool MCP nào cũng có tiêu đề và mô tả ở cả hai ngôn ngữ, gồm cả nhóm cắt lát', () => {
  createMcpServer(createLocalApi());
  const names = toolNames();
  for (const name of ['list_slice_profiles', 'get_slice_options', 'read_profile_settings', 'slice_file', 'get_slice_history', 'save_slice_preset']) {
    assert.ok(names.includes(name), `thiếu tool ${name}`);
  }
  assert.equal(names.includes('ask_slice_agent'), false, 'MCP dùng chính AI đang gọi, không gọi agent chat nội bộ');
  for (const catalog of [vi, en]) {
    for (const name of names) {
      assert.ok(catalog[`mcp.${name}.title`], `thiếu tiêu đề ${name}`);
      assert.ok(catalog[`mcp.${name}.description`], `thiếu mô tả ${name}`);
    }
  }
  assert.deepEqual(Object.keys(vi).filter((key) => key.startsWith('mcp.')).sort(), Object.keys(en).filter((key) => key.startsWith('mcp.')).sort());
});

test('MCP đọc được bảng tham số và quản lý preset cắt lát', async () => {
  const api = createLocalApi();
  const { options } = await api.sliceOptions();
  assert.ok(options.some((item) => item.key === 'layerHeight' && item.max > 0));

  const saved = await api.savePreset({ name: 'Nhanh', options: { layerHeight: 0.28, copies: 4, khoa_la: 1 }, extra: { 'bad key': 'x' } });
  assert.deepEqual(saved.options, { layerHeight: 0.28 }, 'số bản và khoá lạ không vào preset');
  assert.deepEqual(saved.extra, {});
  assert.deepEqual((await api.listPresets()).presets.map((item) => item.name), ['Nhanh']);
  await api.deletePreset({ presetId: saved.id });
  assert.deepEqual((await api.listPresets()).presets, []);
});
