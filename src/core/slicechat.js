import { sql, transaction } from './db.js';
import * as library from './library.js';
import { ONE_OFF_OPTIONS, sanitizeExtra, sanitizeOptions, sliceModel } from './slicer.js';
import { shortId } from '../util/id.js';
import { badRequest, notFound } from '../util/errors.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('slicer');

const VERSION_SOURCES = ['ai', 'slice', 'manual'];
const MAX_TEXT = 4000;
const MAX_PRESET_NAME = 60;

/** Lịch sử chat và phiên bản gắn với mô hình gốc, nên bản sắp khay hay bản cắt lát đều dùng chung một cuộc trò chuyện. */
export function rootIdOf(fileId) {
  let file = library.getFile(fileId);
  const seen = new Set([file.id]);
  while (file.sourceId && !seen.has(file.sourceId)) {
    seen.add(file.sourceId);
    try {
      file = library.getFile(file.sourceId);
    } catch {
      break;
    }
  }
  return file.id;
}

const parse = (row) => ({ id: row.id, createdAt: row.created_at, ...JSON.parse(row.data) });

export function listMessages(rootId) {
  return sql('SELECT id, created_at, data FROM slice_messages WHERE file_id = ? ORDER BY rowid').all(rootId).map(parse);
}

export function listVersions(rootId) {
  return sql('SELECT id, created_at, data FROM slice_versions WHERE file_id = ? ORDER BY rowid').all(rootId).map(parse);
}

export function getChat(fileId) {
  const rootId = rootIdOf(fileId);
  return { fileId: rootId, messages: listMessages(rootId), versions: listVersions(rootId), presets: listPresets() };
}

export function listPresets() {
  return sql('SELECT id, created_at, data FROM slice_presets ORDER BY name COLLATE NOCASE').all().map(parse);
}

export function findPreset(idOrName) {
  const key = String(idOrName ?? '').trim();
  const row = key ? sql('SELECT id, created_at, data FROM slice_presets WHERE id = ? OR name = ? COLLATE NOCASE').get(key, key) : null;
  return row ? parse(row) : null;
}

/** Preset dùng chung cho mọi mô hình; lưu trùng tên thì ghi đè để agent cập nhật được preset người dùng đang dùng. */
export function savePreset(input = {}) {
  const name = String(input.name ?? '').trim().slice(0, MAX_PRESET_NAME);
  if (!name) throw badRequest('error.field_required', { field: 'name' });
  const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  const existing = sql('SELECT id, created_at, data FROM slice_presets WHERE name = ? COLLATE NOCASE').get(name);
  const now = new Date().toISOString();
  const options = sanitizeOptions(input.options ?? {});
  for (const key of ONE_OFF_OPTIONS) delete options[key];
  const preset = {
    id: existing?.id ?? shortId('pre'),
    createdAt: existing?.created_at ?? now,
    updatedAt: now,
    name,
    description: text(input.description)?.slice(0, 300) ?? null,
    machine: text(input.machine),
    process: text(input.process),
    filament: text(input.filament),
    options,
    extra: sanitizeExtra(input.extra),
  };
  const { id, createdAt, ...data } = preset;
  sql('INSERT INTO slice_presets (id, name, created_at, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, data = excluded.data').run(
    id,
    name,
    createdAt,
    JSON.stringify(data),
  );
  return preset;
}

export function deletePreset(id) {
  const result = sql('DELETE FROM slice_presets WHERE id = ?').run(String(id ?? ''));
  if (Number(result.changes) === 0) throw notFound('error.not_found');
  return { id, removed: true };
}

/** Ghi cả lượt hỏi lẫn lượt đáp cùng lúc: lịch sử luôn xen kẽ người dùng và agent như API mô hình yêu cầu. */
export function addMessages(rootId, items) {
  const createdAt = new Date().toISOString();
  const saved = items.map((item) => ({
    id: shortId('msg'),
    createdAt,
    role: item.role === 'assistant' ? 'assistant' : 'user',
    text: String(item.text ?? '').slice(0, MAX_TEXT),
    suggestion: item.suggestion ?? null,
    appliedVersion: null,
    actions: Array.isArray(item.actions) ? item.actions : [],
    sliceId: item.sliceId ?? null,
    model: item.model ?? null,
  }));
  transaction(() => {
    const insert = sql('INSERT INTO slice_messages (id, file_id, created_at, data) VALUES (?, ?, ?, ?)');
    for (const { id, createdAt: at, ...data } of saved) insert.run(id, rootId, at, JSON.stringify(data));
  });
  return saved;
}

export function addVersion(fileId, input = {}) {
  const rootId = rootIdOf(fileId);
  const source = VERSION_SOURCES.includes(input.source) ? input.source : 'manual';
  const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  const message = input.messageId ? sql('SELECT id, created_at, data FROM slice_messages WHERE id = ? AND file_id = ?').get(input.messageId, rootId) : null;
  if (input.messageId && !message) throw badRequest('error.field_invalid', { field: 'messageId' });
  const count = sql('SELECT COUNT(*) AS count FROM slice_versions WHERE file_id = ?').get(rootId).count;
  const version = {
    id: shortId('ver'),
    createdAt: new Date().toISOString(),
    number: Number(count) + 1,
    source,
    machine: text(input.machine),
    process: text(input.process),
    filament: text(input.filament),
    options: sanitizeOptions(input.options ?? {}),
    extra: sanitizeExtra(input.extra),
    sliceId: text(input.sliceId),
    messageId: message?.id ?? null,
  };
  transaction(() => {
    const { id, createdAt, ...data } = version;
    sql('INSERT INTO slice_versions (id, file_id, created_at, data) VALUES (?, ?, ?, ?)').run(id, rootId, createdAt, JSON.stringify(data));
    if (message) linkVersion(message.id, version);
  });
  return version;
}

/** Cắt lát rồi lưu thành phiên bản; bản cắt lát đã xong thì lỗi lưu phiên bản chỉ ghi log. */
export async function sliceAndRecord(input = {}) {
  const result = await sliceModel(input);
  let version = null;
  try {
    version = addVersion(result.sourceId, {
      source: 'slice',
      machine: result.machine,
      process: result.process,
      filament: result.filament,
      options: input,
      extra: input.extra,
      sliceId: result.file.id,
    });
  } catch (error) {
    log.warn(`Không lưu được phiên bản cắt lát: ${error.message}`);
  }
  return { ...result, version };
}

/** Gắn phiên bản vào tin nhắn đã tạo ra nó, giao diện dựa vào đây để hiện nhãn và nút khôi phục. */
export function linkVersion(messageId, version) {
  const row = sql('SELECT id, created_at, data FROM slice_messages WHERE id = ?').get(messageId);
  if (!row) return;
  const { id, createdAt: _at, ...data } = parse(row);
  data.appliedVersion = { id: version.id, number: version.number };
  sql('UPDATE slice_messages SET data = ? WHERE id = ?').run(JSON.stringify(data), id);
}

/** Xoá cuộc trò chuyện nhưng giữ các phiên bản, đó là thông số đã dùng thật. */
export function clearMessages(fileId) {
  const rootId = rootIdOf(fileId);
  const result = sql('DELETE FROM slice_messages WHERE file_id = ?').run(rootId);
  return { fileId: rootId, removed: Number(result.changes) };
}

export function forgetFile(fileId) {
  transaction(() => {
    sql('DELETE FROM slice_messages WHERE file_id = ?').run(fileId);
    sql('DELETE FROM slice_versions WHERE file_id = ?').run(fileId);
  });
}
