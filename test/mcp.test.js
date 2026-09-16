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

test('Every MCP tool has a title and description in both languages, slicing tools included', () => {
  createMcpServer(createLocalApi());
  const names = toolNames();
  for (const name of ['list_slice_profiles', 'get_slice_options', 'read_profile_settings', 'slice_file', 'get_slice_history', 'save_slice_preset']) {
    assert.ok(names.includes(name), `missing tool ${name}`);
  }
  assert.equal(names.includes('ask_slice_agent'), false, 'MCP uses the calling AI itself, not the internal chat agent');
  for (const catalog of [vi, en]) {
    for (const name of names) {
      assert.ok(catalog[`mcp.${name}.title`], `missing title for ${name}`);
      assert.ok(catalog[`mcp.${name}.description`], `missing description for ${name}`);
    }
  }
  assert.deepEqual(Object.keys(vi).filter((key) => key.startsWith('mcp.')).sort(), Object.keys(en).filter((key) => key.startsWith('mcp.')).sort());
});

test('MCP reads the option table and manages slice presets', async () => {
  const api = createLocalApi();
  const { options } = await api.sliceOptions();
  assert.ok(options.some((item) => item.key === 'layerHeight' && item.max > 0));

  const saved = await api.savePreset({ name: 'Nhanh', options: { layerHeight: 0.28, copies: 4, khoa_la: 1 }, extra: { 'bad key': 'x' } });
  assert.deepEqual(saved.options, { layerHeight: 0.28 }, 'copy count and unknown keys stay out of the preset');
  assert.deepEqual(saved.extra, {});
  assert.deepEqual((await api.listPresets()).presets.map((item) => item.name), ['Nhanh']);
  await api.deletePreset({ presetId: saved.id });
  assert.deepEqual((await api.listPresets()).presets, []);
});
