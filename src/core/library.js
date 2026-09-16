import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { PATHS, ensureDataDirs } from './paths.js';
import { getConfig } from './config.js';
import { packToolpath, readToolpath } from '../gcode/toolpath.js';
import { extractMetadata, fileFormat, packMesh, readPlateImage, readPlateLayout, readPlateMesh, SUPPORTED_EXTENSIONS } from '../gcode/metadata.js';
import { arrangeModel, combineModels, moveBuildItems, splitModel } from '../gcode/split.js';
import { orientModel } from '../gcode/orient.js';
import { downloadToFile } from '../util/net.js';
import { shortId } from '../util/id.js';
import { createLogger } from '../util/logger.js';
import { badRequest, conflict, forbidden, notFound } from '../util/errors.js';

const log = createLogger('library');

// Tăng số này khi bộ đọc file hiểu thêm được thứ mà bản cũ bỏ sót, thư viện sẽ quét lại đúng một lượt.
const META_SCAN = 1;
export const libraryEvents = new EventEmitter();
libraryEvents.setMaxListeners(0);

let files = [];
let inUseCheck = () => false;

export function setInUseCheck(fn) {
  inUseCheck = fn;
}

export function loadLibrary() {
  ensureDataDirs();
  if (!existsSync(PATHS.libraryIndex)) {
    files = [];
    return files;
  }
  try {
    const parsed = JSON.parse(readFileSync(PATHS.libraryIndex, 'utf8'));
    files = (Array.isArray(parsed) ? parsed : []).filter((file) => existsSync(storedPath(file)));
    if (linkOldSliced() | rescanMissingMesh()) persist();
  } catch (error) {
    log.warn(`Không đọc được library index: ${error.message}`);
    files = [];
  }
  setImmediate(() => void backfillHashes());
  return files;
}

function hashFileSync(target) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  const handle = openSync(target, 'r');
  try {
    let read;
    while ((read = readSync(handle, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  } finally {
    closeSync(handle);
  }
  return hash.digest('hex');
}

function hashFile(target) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(target)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** File nhập trước khi có chống trùng chưa có mã băm; băm dần ở nền để không làm chậm lúc khởi động. */
async function backfillHashes() {
  let changed = false;
  for (const file of files.filter((item) => !item.sha256)) {
    try {
      file.sha256 = await hashFile(storedPath(file));
      changed = true;
    } catch {
      // File có thể vừa bị xoá trong lúc băm.
    }
  }
  if (changed) persist();
}

/** File người dùng tự đưa vào có cùng nội dung; bản sinh ra (cắt lát, tách, xếp) không tính. */
function findDuplicate(sha256) {
  return files.find((file) => file.sha256 === sha256 && !file.sourceId && existsSync(storedPath(file))) ?? null;
}

/** Bản cắt lát cũ có cùng đầu vào (file nguồn, profile, tuỳ chọn) để dùng lại thay vì chạy slicer lần nữa. */
export function findSliced(key) {
  if (!key) return null;
  const file = files.find((item) => item.sliceKey === key && existsSync(storedPath(item)));
  return file ? toPublic(file) : null;
}

/**
 * Thư viện cũ chưa ghi sourceId. Bản cắt lát luôn mang tên "<tên gốc>.gcode[.3mf]" nên ghép lại được
 * với file gốc còn trong thư viện; không ghép được thì để nguyên, không đoán bừa.
 */
function linkOldSliced() {
  let changed = false;
  for (const file of files) {
    if (file.sourceId !== undefined) continue;
    const base = /\.gcode(\.3mf)?$/i.test(file.name) ? file.name.replace(/\.gcode(\.3mf)?$/i, '') : null;
    const source = base
      ? files.find(
          (item) => item !== file && item.name.replace(/\.[^.]+$/, '') === base && Date.parse(item.uploadedAt) <= Date.parse(file.uploadedAt),
        )
      : null;
    file.sourceId = source?.id ?? null;
    changed = true;
  }
  return changed;
}

/**
 * File nhập trước khi bộ đọc zip hiểu được zip64 bị mất phần hình khối trong metadata.
 * Đọc lại đúng một lượt cho những file đó, đánh dấu lại để lần sau không quét nữa dù có đọc ra hay không.
 */
function rescanMissingMesh() {
  let changed = false;
  for (const file of files) {
    if (file.metaScan === META_SCAN) continue;
    file.metaScan = META_SCAN;
    changed = true;
    const meta = file.meta ?? {};
    if (!['3mf', 'model'].includes(file.format) || meta.sliced === true || meta.triangles != null) continue;
    try {
      const scanned = extractMetadata(storedPath(file), file.name);
      if (scanned.meta?.triangles == null) continue;
      file.meta = { ...meta, ...scanned.meta };
      if (!file.thumbnail && scanned.thumbnail?.buffer?.length) {
        const thumbnailName = `${file.id}.thumb.${scanned.thumbnail.mime === 'image/jpeg' ? 'jpg' : 'png'}`;
        writeFileSync(path.join(PATHS.library, thumbnailName), scanned.thumbnail.buffer);
        file.thumbnail = thumbnailName;
        file.thumbMime = scanned.thumbnail.mime ?? null;
      }
      log.info(`Đọc lại hình khối cho ${file.name}`);
    } catch (error) {
      log.warn(`Không đọc lại được ${file.name}: ${error.message}`);
    }
  }
  return changed;
}

function persist() {
  ensureDataDirs();
  const tmp = `${PATHS.libraryIndex}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(files, null, 2));
  renameSync(tmp, PATHS.libraryIndex);
}

function storedPath(file) {
  return path.join(PATHS.library, file.storedName);
}

export function filePath(file) {
  return storedPath(file);
}

export function thumbnailPath(file) {
  return file.thumbnail ? path.join(PATHS.library, file.thumbnail) : null;
}

export function toPublic(file) {
  return {
    id: file.id,
    name: file.name,
    size: file.size,
    format: file.format,
    meta: file.meta,
    hasThumbnail: Boolean(file.thumbnail),
    origin: file.origin,
    sourceId: file.sourceId ?? null,
    sources: file.sources ?? null,
    sha256: file.sha256 ?? null,
    slice: file.slice ?? null,
    uploadedAt: file.uploadedAt,
    updatedAt: file.updatedAt ?? file.uploadedAt,
    lastPrintedAt: file.lastPrintedAt ?? null,
    printCount: file.printCount ?? 0,
  };
}

export function listFiles({ search, format, limit, sourceId, derived } = {}) {
  const query = String(search ?? '').trim().toLowerCase();
  return files
    .filter((file) => (format ? file.format === format : true))
    .filter((file) => (sourceId ? file.sourceId === sourceId : true))
    // derived=false chỉ lấy file người dùng tự đưa vào, bỏ qua bản do cắt lát hay tách vật thể sinh ra.
    .filter((file) => (derived === undefined ? true : derived ? Boolean(file.sourceId) : !file.sourceId))
    .filter((file) => (query ? file.name.toLowerCase().includes(query) : true))
    .slice(0, Number(limit) || files.length)
    .map(toPublic);
}

export function findFile(id) {
  return files.find((file) => file.id === id) ?? null;
}

export function getFileRecord(id) {
  const file = findFile(id);
  if (!file) throw notFound('error.file_not_found', { id });
  return file;
}

export function getFile(id) {
  return toPublic(getFileRecord(id));
}

function cleanName(value) {
  const base = path.basename(String(value ?? '').replace(/\\/g, '/'));
  return base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim().slice(0, 200);
}

function assertSupported(name) {
  const format = fileFormat(name);
  if (!format) {
    throw badRequest('error.file_type_unsupported', { name, supported: SUPPORTED_EXTENSIONS.join(', ') });
  }
  return format;
}

function maxBytes() {
  return Math.max(1, Number(getConfig().files.maxUploadMb) || 1024) * 1024 * 1024;
}

export function tempPath(ext = '') {
  ensureDataDirs();
  return path.join(PATHS.tmp, `${shortId('up')}${ext}`);
}

function moveInto(source, dest, { copy }) {
  if (copy) {
    copyFileSync(source, dest);
    return;
  }
  try {
    renameSync(source, dest);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    copyFileSync(source, dest);
    rmSync(source, { force: true });
  }
}

/** Nhận file đã nằm trên đĩa (upload tạm, tải về, đường dẫn cục bộ), đọc metadata và đưa vào thư viện. */
export function addFromPath(
  source,
  originalName,
  { origin = 'api', copy = false, sourceId = null, dedupe = true, sliceKey = null, slice = null, sources = null } = {},
) {
  const name = cleanName(originalName);
  if (!name) throw badRequest('error.field_required', { field: 'name' });
  let format;
  try {
    format = assertSupported(name);
  } catch (error) {
    if (!copy) rmSync(source, { force: true });
    throw error;
  }
  const size = statSync(source).size;
  if (size === 0) {
    if (!copy) rmSync(source, { force: true });
    throw badRequest('error.file_empty', { name });
  }
  if (size > maxBytes()) {
    if (!copy) rmSync(source, { force: true });
    throw badRequest('error.file_too_large', { limit: getConfig().files.maxUploadMb });
  }

  const sha256 = hashFileSync(source);
  const existing = dedupe && !sourceId ? findDuplicate(sha256) : null;
  if (existing) {
    if (!copy) rmSync(source, { force: true });
    log.info(`Bỏ qua ${name}: trùng nội dung với ${existing.name}`, { origin });
    return { ...toPublic(existing), duplicate: true };
  }

  const id = shortId('fil');
  const storedName = `${id}${path.extname(name).toLowerCase()}`;
  const dest = path.join(PATHS.library, storedName);
  moveInto(source, dest, { copy });

  const { meta, thumbnail } = extractMetadata(dest, name);
  let thumbnailName = null;
  if (thumbnail?.buffer?.length) {
    thumbnailName = `${id}.thumb.${thumbnail.mime === 'image/jpeg' ? 'jpg' : 'png'}`;
    writeFileSync(path.join(PATHS.library, thumbnailName), thumbnail.buffer);
  }
  if (meta.parseError) log.warn(`Không đọc được metadata của ${name}: ${meta.parseError}`);

  const file = {
    id,
    name,
    storedName,
    size,
    format,
    meta,
    thumbnail: thumbnailName,
    thumbMime: thumbnail?.mime ?? null,
    origin,
    sourceId,
    sources,
    sha256,
    sliceKey,
    slice,
    uploadedAt: new Date().toISOString(),
    lastPrintedAt: null,
    printCount: 0,
  };
  files.unshift(file);
  persist();
  log.info(`Đã thêm file ${name} (${Math.round(size / 1024)} KB)`, { origin });
  libraryEvents.emit('file', { event: 'added', file: toPublic(file) });
  return toPublic(file);
}

function nameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    return decodeURIComponent(pathname.split('/').filter(Boolean).pop() ?? '');
  } catch {
    return '';
  }
}

export async function addFromUrl(url, { name, origin = 'api' } = {}) {
  const settings = getConfig().files;
  if (!settings.allowRemoteUrl) throw forbidden('error.remote_url_disabled');
  const finalName = cleanName(name || nameFromUrl(url));
  assertSupported(finalName || 'download');
  const temp = tempPath();
  try {
    await downloadToFile(url, temp, { maxBytes: maxBytes(), allowPrivateNetwork: settings.allowPrivateNetworkUrl });
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return addFromPath(temp, finalName, { origin });
}

export function addFromContent({ content, contentBase64, name, origin = 'api' }) {
  const finalName = cleanName(name);
  if (!finalName) throw badRequest('error.field_required', { field: 'name' });
  assertSupported(finalName);
  const buffer = contentBase64 !== undefined ? Buffer.from(String(contentBase64), 'base64') : Buffer.from(String(content), 'utf8');
  if (buffer.length > maxBytes()) throw badRequest('error.file_too_large', { limit: getConfig().files.maxUploadMb });
  const temp = tempPath();
  writeFileSync(temp, buffer);
  return addFromPath(temp, finalName, { origin });
}

export function addFromLocalPath(localPath, { name, origin = 'api' } = {}) {
  const settings = getConfig().files;
  if (!settings.allowLocalFilePath) throw forbidden('error.local_path_disabled');
  let resolved;
  try {
    resolved = realpathSync(path.resolve(String(localPath)));
  } catch {
    throw notFound('error.local_path_not_found', { path: localPath });
  }
  const roots = (settings.allowedFileRoots ?? []).filter(Boolean);
  if (roots.length > 0) {
    const allowed = roots.some((root) => {
      let base;
      try {
        base = realpathSync(path.resolve(root));
      } catch {
        return false;
      }
      return resolved === base || resolved.startsWith(`${base}${path.sep}`);
    });
    if (!allowed) throw forbidden('error.local_path_outside_roots', { path: localPath });
  }
  if (!statSync(resolved).isFile()) throw badRequest('error.local_path_not_file', { path: localPath });
  return addFromPath(resolved, name || path.basename(resolved), { origin, copy: true });
}

/** Một cổng chung cho REST/MCP/WS: chấp nhận url, content, contentBase64 hoặc path. */
export async function addFile(input = {}) {
  const origin = input.origin ?? 'api';
  if (input.url) return addFromUrl(input.url, { name: input.name, origin });
  if (input.content !== undefined || input.contentBase64 !== undefined) return addFromContent({ ...input, origin });
  if (input.path) return addFromLocalPath(input.path, { name: input.name, origin });
  throw badRequest('error.file_source_required');
}

/** Vị trí vật thể trên khay, đọc trực tiếp từ file mỗi lần gọi nên không phụ thuộc metadata lưu lúc nhập. */
export function platePreview(id, plate) {
  const file = getFileRecord(id);
  const layout = file.format === '3mf' ? readPlateLayout(storedPath(file), plate) : null;
  if (!layout) throw badRequest('error.plate_preview_missing', { name: file.name });
  return { fileId: file.id, name: file.name, ...layout };
}

export function plateImage(id, plate) {
  const file = getFileRecord(id);
  const buffer = file.format === '3mf' ? readPlateImage(storedPath(file), plate) : null;
  if (!buffer) throw notFound('error.plate_preview_missing', { name: file.name });
  return buffer;
}

/** Mesh thật để dựng khung xem 3D: đọc thẳng từ file nên STL/OBJ và mọi 3MF cũ đều xem được. */
export function plateMesh(id, plate, { bed = null } = {}) {
  const file = getFileRecord(id);
  const mesh = readPlateMesh(storedPath(file), file.name, plate);
  if (!mesh) throw badRequest('error.mesh_missing', { name: file.name });
  // Mô hình chưa cắt lát không ghi kích thước bàn, mượn số chuẩn của máy sẽ in để nhìn đúng tỉ lệ.
  return packMesh({ ...mesh, bed: mesh.bed ?? bed, name: file.name });
}

/** Đường đi thật của vòi phun, đọc từ G-code trong file đã cắt lát. */
export function plateToolpath(id, plate) {
  const file = getFileRecord(id);
  const path = readToolpath(storedPath(file), file.name, plate);
  if (!path) throw badRequest('error.toolpath_missing', { name: file.name });
  return packToolpath(path);
}

/** Tách các khối rời nhau trong mô hình thành từng vật thể riêng, lưu lại thành 3MF mới để slicer sắp lên bàn. */
export function splitFile(id) {
  const file = getFileRecord(id);
  if (file.format !== 'model' && !(file.format === '3mf' && file.meta?.sliced === false)) {
    throw badRequest('error.split_source_invalid', { name: file.name });
  }
  const { buffer, parts } = splitModel(storedPath(file), file.name);
  const temp = tempPath('.3mf');
  writeFileSync(temp, buffer);
  const created = addFromPath(temp, `${file.name.replace(/\.[^.]+$/, '')}-split.3mf`, { origin: 'split', sourceId: file.id });
  log.info(`Đã tách ${file.name} thành ${parts.length} vật thể`);
  return { file: created, sourceId: file.id, parts };
}

/** Xếp lại các khối của mô hình cho nằm gọn trên bàn in, lưu thành 3MF mới. */
export function arrangeFile(id, bed, options = {}) {
  const file = getFileRecord(id);
  if (file.format !== 'model' && !(file.format === '3mf' && file.meta?.sliced === false)) {
    throw badRequest('error.split_source_invalid', { name: file.name });
  }
  const { buffer, parts, clusters, overflow } = arrangeModel(storedPath(file), file.name, bed, options);
  const temp = tempPath('.3mf');
  writeFileSync(temp, buffer);
  const created = addFromPath(temp, `${file.name.replace(/\.[^.]+$/, '')}-arranged.3mf`, { origin: 'arrange', sourceId: file.id });
  log.info(`Đã xếp ${file.name} thành ${clusters} cụm trên bàn in${overflow > 0 ? `, ${overflow} cụm không vừa` : ''}`);
  return { file: created, sourceId: file.id, parts, clusters, overflow };
}

function assertModel(file) {
  if (file.format !== 'model' && !(file.format === '3mf' && file.meta?.sliced === false)) {
    throw badRequest('error.split_source_invalid', { name: file.name });
  }
}

/** Xoay cả mô hình sang hướng ít phải in hỗ trợ nhất, lưu thành 3MF mới; hướng đang có đã tốt thì không tạo file. */
export function orientFile(id) {
  const file = getFileRecord(id);
  assertModel(file);
  const result = orientModel(storedPath(file), file.name);
  if (!result.changed) return { file: toPublic(file), sourceId: file.id, changed: false, before: result.before, after: result.after };
  const temp = tempPath('.3mf');
  writeFileSync(temp, result.buffer);
  const created = addFromPath(temp, `${file.name.replace(/\.[^.]+$/, '')}-oriented.3mf`, { origin: 'orient', sourceId: file.id });
  log.info(`Đã xoay ${file.name}: hỗ trợ ${result.before.supportCm3} -> ${result.after.supportCm3} cm3`);
  return { file: created, sourceId: file.id, changed: true, before: result.before, after: result.after, parts: result.parts };
}

const MAX_COMBINE_COPIES = 100;

/** Gom nhiều mô hình (mỗi mô hình có thể nhân bản) lên cùng một khay, lưu thành 3MF mới. */
export function combineFiles(items, bed, options = {}) {
  if (!Array.isArray(items) || items.length === 0) throw badRequest('error.field_required', { field: 'items' });
  const sources = items.map((item) => {
    const file = getFileRecord(item?.fileId);
    assertModel(file);
    const copies = Math.max(1, Math.min(MAX_COMBINE_COPIES, Math.round(Number(item.copies) || 1)));
    return { file, copies, filePath: storedPath(file), name: file.name };
  });
  const total = sources.reduce((sum, item) => sum + item.copies, 0);
  if (total > MAX_COMBINE_COPIES) throw badRequest('error.combine_too_many', { count: total, limit: MAX_COMBINE_COPIES });
  const result = combineModels(sources, bed, options);
  const temp = tempPath('.3mf');
  writeFileSync(temp, result.buffer);
  const first = sources[0].file.name.replace(/\.[^.]+$/, '');
  const name = options.name ? String(options.name).replace(/\.3mf$/i, '') : sources.length > 1 ? `${first}-plate-${sources.length}` : `${first}-x${total}`;
  const created = addFromPath(temp, `${name}.3mf`, {
    origin: 'combine',
    dedupe: false,
    sources: sources.map((item) => ({ fileId: item.file.id, name: item.file.name, copies: item.copies })),
  });
  log.info(`Đã gom ${total} bản từ ${sources.length} file lên một khay${result.overflow > 0 ? `, ${result.overflow} cụm không vừa` : ''}`);
  return { file: created, parts: result.parts, placed: result.placed, overflow: result.overflow, overflowNames: result.overflowNames };
}

/**
 * Ghi lại vị trí mới của các vật thể sau khi người dùng kéo thả trên bàn in.
 * Sửa ngay trên file đang xem để đường dẫn và mọi bản xem trước không đổi.
 */
export function moveObjects(id, moves) {
  const file = getFileRecord(id);
  if (file.format !== '3mf' || file.meta?.sliced !== false) throw badRequest('error.split_source_invalid', { name: file.name });
  const target = storedPath(file);
  const { buffer, moved } = moveBuildItems(target, file.name, moves);
  writeFileSync(target, buffer);
  file.size = buffer.length;
  file.sha256 = createHash('sha256').update(buffer).digest('hex');
  file.meta = extractMetadata(target, file.name).meta;
  // Nội dung file đổi mà đường dẫn giữ nguyên, nên phải có mốc thời gian để trình duyệt không dùng lại bản mesh cũ.
  file.updatedAt = new Date().toISOString();
  persist();
  log.info(`Đã dời ${moved} vật thể trên bàn in của ${file.name}`);
  libraryEvents.emit('file', { event: 'updated', file: toPublic(file) });
  return { file: toPublic(file), moved };
}

export function renameFile(id, name) {
  const file = getFileRecord(id);
  let next = cleanName(name);
  if (!next) throw badRequest('error.field_required', { field: 'name' });
  const ext = path.extname(file.name);
  if (path.extname(next).toLowerCase() !== ext.toLowerCase()) next = `${next}${ext}`;
  file.name = next;
  persist();
  libraryEvents.emit('file', { event: 'updated', file: toPublic(file) });
  return toPublic(file);
}

export function markPrinted(id) {
  const file = findFile(id);
  if (!file) return;
  file.printCount = (file.printCount ?? 0) + 1;
  file.lastPrintedAt = new Date().toISOString();
  persist();
  libraryEvents.emit('file', { event: 'updated', file: toPublic(file) });
}

export function deleteFile(id) {
  const file = getFileRecord(id);
  if (inUseCheck(file.id)) throw conflict('error.file_in_use', { name: file.name });
  rmSync(storedPath(file), { force: true });
  if (file.thumbnail) rmSync(path.join(PATHS.library, file.thumbnail), { force: true });
  files = files.filter((item) => item.id !== file.id);
  persist();
  log.info(`Đã xoá file ${file.name}`);
  libraryEvents.emit('file', { event: 'removed', file: { id: file.id, name: file.name } });
  return { deleted: true, id: file.id };
}

export function librarySummary() {
  return {
    total: files.length,
    bytes: files.reduce((sum, file) => sum + (file.size ?? 0), 0),
  };
}
