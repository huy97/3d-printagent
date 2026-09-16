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

// Bump this when the file reader learns something the old one missed; the library rescans exactly once.
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
    log.warn(`Failed to read the library index: ${error.message}`);
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

/** Files imported before dedup existed have no hash; hash them gradually in the background so startup stays fast. */
async function backfillHashes() {
  let changed = false;
  for (const file of files.filter((item) => !item.sha256)) {
    try {
      file.sha256 = await hashFile(storedPath(file));
      changed = true;
    } catch {
      // The file may have been deleted while hashing.
    }
  }
  if (changed) persist();
}

/** A user-imported file with identical content; generated files (sliced, split, arranged) do not count. */
function findDuplicate(sha256) {
  return files.find((file) => file.sha256 === sha256 && !file.sourceId && existsSync(storedPath(file))) ?? null;
}

/** An earlier slice with the same inputs (source file, profile, options) to reuse instead of running the slicer again. */
export function findSliced(key) {
  if (!key) return null;
  const file = files.find((item) => item.sliceKey === key && existsSync(storedPath(item)));
  return file ? toPublic(file) : null;
}

/**
 * Older libraries did not record sourceId. A slice is always named "<original>.gcode[.3mf]", so it can be matched
 * back to a source file still in the library; when it cannot, leave it alone rather than guessing.
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
 * Files imported before the zip reader handled zip64 lost the mesh part of their metadata.
 * Rescan those exactly once and mark them so later runs skip them whether or not the read succeeded.
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
      log.info(`Rescanned the mesh for ${file.name}`);
    } catch (error) {
      log.warn(`Failed to rescan ${file.name}: ${error.message}`);
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
    // derived=false keeps only user-imported files, skipping ones produced by slicing or splitting.
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

/** Takes a file already on disk (temp upload, download, local path), reads its metadata and adds it to the library. */
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
    log.info(`Skipped ${name}: same content as ${existing.name}`, { origin });
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
  if (meta.parseError) log.warn(`Failed to read metadata of ${name}: ${meta.parseError}`);

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
  log.info(`Added file ${name} (${Math.round(size / 1024)} KB)`, { origin });
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

/** One entry point for REST/MCP/WS: accepts url, content, contentBase64 or path. */
export async function addFile(input = {}) {
  const origin = input.origin ?? 'api';
  if (input.url) return addFromUrl(input.url, { name: input.name, origin });
  if (input.content !== undefined || input.contentBase64 !== undefined) return addFromContent({ ...input, origin });
  if (input.path) return addFromLocalPath(input.path, { name: input.name, origin });
  throw badRequest('error.file_source_required');
}

/** Object positions on a plate, read straight from the file on every call so it does not rely on metadata stored at import. */
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

/** The real mesh for the 3D viewer: read straight from the file, so STL/OBJ and every old 3MF work. */
export function plateMesh(id, plate, { bed = null } = {}) {
  const file = getFileRecord(id);
  const mesh = readPlateMesh(storedPath(file), file.name, plate);
  if (!mesh) throw badRequest('error.mesh_missing', { name: file.name });
  // Unsliced models carry no bed size, so borrow the target printer's to keep the scale right.
  return packMesh({ ...mesh, bed: mesh.bed ?? bed, name: file.name });
}

/** The real nozzle path, read from the G-code in a sliced file. */
export function plateToolpath(id, plate) {
  const file = getFileRecord(id);
  const path = readToolpath(storedPath(file), file.name, plate);
  if (!path) throw badRequest('error.toolpath_missing', { name: file.name });
  return packToolpath(path);
}

/** Splits disconnected shells of a model into separate objects, saved as a new 3MF for the slicer to lay out. */
export function splitFile(id) {
  const file = getFileRecord(id);
  if (file.format !== 'model' && !(file.format === '3mf' && file.meta?.sliced === false)) {
    throw badRequest('error.split_source_invalid', { name: file.name });
  }
  const { buffer, parts } = splitModel(storedPath(file), file.name);
  const temp = tempPath('.3mf');
  writeFileSync(temp, buffer);
  const created = addFromPath(temp, `${file.name.replace(/\.[^.]+$/, '')}-split.3mf`, { origin: 'split', sourceId: file.id });
  log.info(`Split ${file.name} into ${parts.length} objects`);
  return { file: created, sourceId: file.id, parts };
}

/** Rearranges a model's shells to fit the plate, saved as a new 3MF. */
export function arrangeFile(id, bed, options = {}) {
  const file = getFileRecord(id);
  if (file.format !== 'model' && !(file.format === '3mf' && file.meta?.sliced === false)) {
    throw badRequest('error.split_source_invalid', { name: file.name });
  }
  const { buffer, parts, clusters, overflow } = arrangeModel(storedPath(file), file.name, bed, options);
  const temp = tempPath('.3mf');
  writeFileSync(temp, buffer);
  const created = addFromPath(temp, `${file.name.replace(/\.[^.]+$/, '')}-arranged.3mf`, { origin: 'arrange', sourceId: file.id });
  log.info(`Arranged ${file.name} into ${clusters} clusters on the plate${overflow > 0 ? `, ${overflow} clusters did not fit` : ''}`);
  return { file: created, sourceId: file.id, parts, clusters, overflow };
}

function assertModel(file) {
  if (file.format !== 'model' && !(file.format === '3mf' && file.meta?.sliced === false)) {
    throw badRequest('error.split_source_invalid', { name: file.name });
  }
}

/** Rotates the whole model to the orientation needing the least support, saved as a new 3MF; no file when the current orientation is already best. */
export function orientFile(id) {
  const file = getFileRecord(id);
  assertModel(file);
  const result = orientModel(storedPath(file), file.name);
  if (!result.changed) return { file: toPublic(file), sourceId: file.id, changed: false, before: result.before, after: result.after };
  const temp = tempPath('.3mf');
  writeFileSync(temp, result.buffer);
  const created = addFromPath(temp, `${file.name.replace(/\.[^.]+$/, '')}-oriented.3mf`, { origin: 'orient', sourceId: file.id });
  log.info(`Oriented ${file.name}: support ${result.before.supportCm3} -> ${result.after.supportCm3} cm3`);
  return { file: created, sourceId: file.id, changed: true, before: result.before, after: result.after, parts: result.parts };
}

const MAX_COMBINE_COPIES = 100;

/** Combines several models (each with optional copies) onto one plate, saved as a new 3MF. */
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
  log.info(`Combined ${total} copies from ${sources.length} files onto one plate${result.overflow > 0 ? `, ${result.overflow} clusters did not fit` : ''}`);
  return { file: created, parts: result.parts, placed: result.placed, overflow: result.overflow, overflowNames: result.overflowNames };
}

/**
 * Records the new object positions after the user drags them around the plate.
 * Edits the viewed file in place so its path and every preview stay the same.
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
  // The content changes while the path stays, so a timestamp is needed to stop the browser reusing the old mesh.
  file.updatedAt = new Date().toISOString();
  persist();
  log.info(`Moved ${moved} objects on the plate of ${file.name}`);
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
  log.info(`Deleted file ${file.name}`);
  libraryEvents.emit('file', { event: 'removed', file: { id: file.id, name: file.name } });
  return { deleted: true, id: file.id };
}

export function librarySummary() {
  return {
    total: files.length,
    bytes: files.reduce((sum, file) => sum + (file.size ?? 0), 0),
  };
}
