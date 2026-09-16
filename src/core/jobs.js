import { EventEmitter } from 'node:events';
import { PATHS, ensureDataDirs } from './paths.js';
import { getConfig } from './config.js';
import { sql, transaction } from './db.js';
import { queryTelemetry } from './telemetry.js';
import * as printers from './printers.js';
import * as library from './library.js';
import * as insights from './insights.js';
import * as filament from './filament.js';
import { driverClass } from '../drivers/index.js';
import { remoteFileName } from '../drivers/base.js';
import { shortId } from '../util/id.js';
import { createLogger } from '../util/logger.js';
import { badRequest, conflict, notFound } from '../util/errors.js';
import { t } from '../i18n/index.js';

const log = createLogger('queue');
export const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(0);

export const JOB_STATUSES = ['queued', 'uploading', 'starting', 'printing', 'paused', 'completed', 'failed', 'canceled'];
const ACTIVE = new Set(['uploading', 'starting', 'printing', 'paused']);
const OPEN = new Set(['queued', ...ACTIVE]);
const FINAL = new Set(['completed', 'failed', 'canceled']);
const START_TIMEOUT_MS = 5 * 60 * 1000;
const START_GRACE_MS = 45 * 1000;

let jobs = [];
let persistTimer = null;
let sweepTimer = null;
const queueTimers = new Map();
const saved = new Map();

export function loadJobs() {
  ensureDataDirs();
  saved.clear();
  jobs = [];
  for (const row of sql('SELECT id, data FROM jobs ORDER BY created_at DESC, rowid DESC').all()) {
    try {
      jobs.push(JSON.parse(row.data));
      saved.set(row.id, row.data);
    } catch (error) {
      log.warn(`Bỏ qua job ${row.id} hỏng: ${error.message}`);
    }
  }
  for (const job of jobs) {
    if (job.status === 'uploading' || job.status === 'starting') {
      job.status = 'failed';
      job.error = t('error.job_interrupted');
      job.finishedAt = job.finishedAt ?? new Date().toISOString();
    }
    // Máy vẫn in khi agent khởi động lại: gắn lại job khi có trạng thái đầu tiên.
    if (job.status === 'printing' || job.status === 'paused') job.reattach = true;
  }
  library.setInUseCheck((fileId) =>
    jobs.some((job) => job.fileId === fileId && ['queued', 'uploading'].includes(job.status)),
  );
  persist();
  return jobs;
}

function persist() {
  if (persistTimer) return;
  persistTimer = setTimeout(flushJobs, 500);
  persistTimer.unref?.();
}

/** Chỉ ghi các job đổi nội dung so với lần ghi trước và xoá job không còn trong danh sách. */
export function flushJobs() {
  clearTimeout(persistTimer);
  persistTimer = null;
  const changed = [];
  for (const job of jobs) {
    const data = JSON.stringify(job);
    if (saved.get(job.id) !== data) changed.push([job, data]);
  }
  const current = new Set(jobs.map((job) => job.id));
  const removed = [...saved.keys()].filter((id) => !current.has(id));
  if (changed.length === 0 && removed.length === 0) return;
  try {
    transaction(() => {
      const upsert = sql(
        `INSERT INTO jobs (id, printer_id, status, created_at, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET printer_id = excluded.printer_id, status = excluded.status, data = excluded.data`,
      );
      for (const [job, data] of changed) upsert.run(job.id, job.printerId ?? '', job.status, job.createdAt, data);
      for (const id of removed) sql('DELETE FROM jobs WHERE id = ?').run(id);
    });
    for (const [job, data] of changed) saved.set(job.id, data);
    for (const id of removed) saved.delete(id);
  } catch (error) {
    log.warn(`Không ghi được lịch sử job vào SQLite: ${error.message}`);
  }
}

function publicJob(job) {
  const { reattach, startRequestedAt, ...rest } = job;
  return rest;
}

function emit(event, job) {
  jobEvents.emit('job', { event, job: publicJob(job) });
}

function updateJob(job, patch, event = 'updated') {
  Object.assign(job, patch);
  persist();
  emit(event, job);
  return job;
}

function finish(job, status, error = null) {
  if (FINAL.has(job.status)) return job;
  updateJob(job, { status, error, finishedAt: new Date().toISOString(), reattach: undefined, startRequestedAt: undefined });
  log.info(`Job ${job.id} (${job.fileName}) -> ${status}${error ? `: ${error}` : ''}`);
  if (job.printerId) schedulePrinterQueue(job.printerId, 2000);
  return job;
}

/** Gắn thêm số liệu chốt sau khi job kết thúc (nhựa, chi phí) mà không đổi trạng thái. */
export function annotateJob(id, patch) {
  const job = findJobRecord(id);
  if (!job) return null;
  updateJob(job, patch);
  return publicJob(job);
}

function queueOrder(left, right) {
  return (right.priority ?? 0) - (left.priority ?? 0) || (left.position ?? Date.parse(left.createdAt)) - (right.position ?? Date.parse(right.createdAt));
}

function clampPriority(value) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.min(100, Math.max(-100, number)) : 0;
}

function nozzleOf(file, plate) {
  const plates = file.meta?.plates ?? [];
  const selected = plates.find((item) => item.index === Number(plate)) ?? plates[0];
  return Number(selected?.nozzleDiameter ?? file.meta?.nozzleDiameter) || null;
}

function materialOf(file, plate) {
  const plates = file.meta?.plates ?? [];
  const selected = plates.find((item) => item.index === Number(plate)) ?? plates[0];
  return String(selected?.filaments?.[0]?.type ?? file.meta?.filamentType ?? '').toUpperCase() || null;
}

/** Máy có hợp với job không, xét cố định: định dạng, nhóm máy được chọn, đầu phun và loại nhựa đang gắn. */
function printerMatches(record, file, job) {
  if (!record?.enabled || !file) return false;
  const pool = job.target?.printerIds;
  if (Array.isArray(pool) && pool.length > 0 && !pool.includes(record.id)) return false;
  if (!driverClass(record.driver).formats.includes(file.format)) return false;
  if (file.format === '3mf' && file.meta?.sliced === false) return false;
  const wantNozzle = nozzleOf(file, job.options?.plate);
  const hasNozzle = Number(printers.statusOf(record.id)?.extra?.nozzleDiameter) || null;
  if (wantNozzle && hasNozzle && Math.abs(wantNozzle - hasNozzle) > 0.01) return false;
  const material = materialOf(file, job.options?.plate);
  const loaded = filament.loadedMaterials(record.id);
  if (material && loaded.size > 0 && !loaded.has(material)) return false;
  return true;
}

export function matchingPrinters(fileId, { printerIds, plate } = {}) {
  const file = library.getFileRecord(fileId);
  const probe = { target: { printerIds }, options: { plate } };
  return printers.listPrinters().filter((printer) => printerMatches(printers.findPrinter(printer.id), file, probe)).map((printer) => printer.id);
}

function assign(job, record) {
  const file = library.findFile(job.fileId);
  const estimate = insights.adjustEstimate(record.id, file, job.options?.plate);
  updateJob(job, { printerId: record.id, printerName: record.name, adjustedTime: estimate.adjustedTime });
  log.info(`Hàng đợi chung giao job ${job.id} cho ${record.name}`);
}

function trimJobs() {
  const keep = Math.max(20, Number(getConfig().queue.keepJobs) || 500);
  if (jobs.length <= keep) return;
  const open = jobs.filter((job) => OPEN.has(job.status));
  const closed = jobs.filter((job) => !OPEN.has(job.status)).slice(0, Math.max(0, keep - open.length));
  const kept = new Set([...open, ...closed]);
  jobs = jobs.filter((job) => kept.has(job));
}

export function listJobs({ status, printerId, fileId, limit = 100, active } = {}) {
  const statuses = status ? String(status).split(',') : null;
  const timeline = forecast();
  return jobs
    .filter((job) => (statuses ? statuses.includes(job.status) : true))
    .filter((job) => (printerId ? (printerId === 'any' ? !job.printerId : job.printerId === printerId) : true))
    .filter((job) => (fileId ? job.fileId === fileId : true))
    .filter((job) => (active ? OPEN.has(job.status) : true))
    .slice(0, Number(limit) || 100)
    .map((job) => (timeline.has(job.id) ? { ...publicJob(job), forecast: timeline.get(job.id) } : publicJob(job)));
}

/**
 * Giờ bắt đầu và giờ xong dự kiến của các job còn mở, dựa trên thời gian đã hiệu chỉnh theo lịch sử từng máy.
 * Job hàng đợi chung được xếp thử vào máy hợp lệ nào rảnh sớm nhất.
 */
export function forecast() {
  const now = Date.now();
  const result = new Map();
  const free = new Map();
  for (const record of printers.listPrinters()) {
    if (record.enabled) free.set(record.id, now);
  }
  for (const job of jobs) {
    if (!ACTIVE.has(job.status) || !job.printerId) continue;
    const planned = job.adjustedTime ?? job.estimatedTime;
    const elapsed = job.startedAt ? (now - Date.parse(job.startedAt)) / 1000 : 0;
    const remaining = job.remaining ?? (planned ? Math.max(0, planned - elapsed) : null);
    if (remaining === null) {
      free.set(job.printerId, null);
      continue;
    }
    const finishAt = now + remaining * 1000;
    free.set(job.printerId, finishAt);
    result.set(job.id, { startAt: job.startedAt ?? null, finishAt: new Date(finishAt).toISOString(), printerId: job.printerId });
  }
  const queued = jobs.filter((job) => job.status === 'queued').sort(queueOrder);
  const files = new Map();
  const fileOf = (id) => {
    if (!files.has(id)) files.set(id, library.findFile(id));
    return files.get(id);
  };
  for (const job of queued) {
    let printerId = job.printerId;
    if (!printerId) {
      const file = fileOf(job.fileId);
      const options = [...free.entries()].filter(([id, at]) => at !== null && printerMatches(printers.findPrinter(id), file, job));
      if (options.length === 0) continue;
      printerId = options.sort((left, right) => left[1] - right[1])[0][0];
    }
    const startAt = free.get(printerId);
    if (startAt === null || startAt === undefined) continue;
    const planned = job.printerId ? (job.adjustedTime ?? job.estimatedTime) : insights.adjustEstimate(printerId, fileOf(job.fileId), job.options?.plate).adjustedTime;
    if (!planned) {
      free.set(printerId, null);
      continue;
    }
    const finishAt = startAt + planned * 1000;
    free.set(printerId, finishAt);
    result.set(job.id, { startAt: new Date(startAt).toISOString(), finishAt: new Date(finishAt).toISOString(), printerId });
  }
  return result;
}

/** Đổi vị trí một job trong hàng đợi của cùng máy (hoặc cùng hàng đợi chung). */
export function moveJob(id, direction) {
  const job = getJobRecord(id);
  if (job.status !== 'queued') throw conflict('error.job_not_queued', { id });
  const lane = jobs.filter((item) => item.status === 'queued' && (item.printerId ?? null) === (job.printerId ?? null)).sort(queueOrder);
  const position = (item) => item.position ?? Date.parse(item.createdAt);
  const index = lane.indexOf(job);
  if (direction === 'top' || direction === 'bottom') {
    const edge = direction === 'top' ? lane[0] : lane[lane.length - 1];
    if (edge !== job) {
      updateJob(job, {
        priority: edge.priority ?? 0,
        position: direction === 'top' ? position(edge) - 1 : position(edge) + 1,
      });
    }
  } else if (direction === 'up' || direction === 'down') {
    const other = lane[direction === 'up' ? index - 1 : index + 1];
    if (other) {
      const mine = { priority: job.priority ?? 0, position: position(job) };
      const theirs = { priority: other.priority ?? 0, position: position(other) };
      updateJob(other, mine);
      updateJob(job, theirs);
    }
  } else {
    throw badRequest('error.field_invalid', { field: 'direction' });
  }
  if (job.printerId) schedulePrinterQueue(job.printerId, 0);
  else processQueue();
  return publicJob(job);
}

/** Sửa job còn chờ: độ ưu tiên, ghi chú, nhóm máy của hàng đợi chung. */
export function updateQueuedJob(id, patch = {}) {
  const job = getJobRecord(id);
  if (job.status !== 'queued') throw conflict('error.job_not_queued', { id });
  const next = {};
  if (patch.priority !== undefined) next.priority = clampPriority(patch.priority);
  if (patch.note !== undefined) next.note = patch.note ? String(patch.note).slice(0, 500) : null;
  if (patch.printerIds !== undefined && !job.printerId) {
    next.target = { any: true, printerIds: normalizePool(patch.printerIds) };
  }
  updateJob(job, next);
  if (job.printerId) schedulePrinterQueue(job.printerId, 0);
  else processQueue();
  return publicJob(job);
}

function normalizePool(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' && value ? value.split(',') : [];
  return [...new Set(list.map((item) => printers.getRecord(String(item).trim()).id))];
}

function findJobRecord(id) {
  return jobs.find((job) => job.id === id) ?? null;
}

function getJobRecord(id) {
  const job = findJobRecord(id);
  if (!job) throw notFound('error.job_not_found', { id });
  return job;
}

export function getJob(id) {
  return publicJob(getJobRecord(id));
}

/** Nhiệt độ, quạt, tốc độ và tiến độ của máy trong khoảng thời gian job chạy. */
export function getJobHistory(id, { maxPoints } = {}) {
  const job = getJobRecord(id);
  const from = Date.parse(job.startedAt ?? job.createdAt);
  const to = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
  return { jobId: job.id, printerId: job.printerId, ...queryTelemetry(job.printerId, { from, to, maxPoints }) };
}

function activeJobFor(printerId) {
  return jobs.find((job) => job.printerId === printerId && ACTIVE.has(job.status)) ?? null;
}

export function stats() {
  const counts = {};
  for (const job of jobs) counts[job.status] = (counts[job.status] ?? 0) + 1;
  return {
    total: jobs.length,
    queued: counts.queued ?? 0,
    queuedAny: jobs.filter((job) => job.status === 'queued' && !job.printerId).length,
    active: jobs.filter((job) => ACTIVE.has(job.status)).length,
    counts,
  };
}

function normalizeOptions(file, input = {}) {
  const options = {};
  if (file.format === '3mf') {
    const plates = file.meta?.plates ?? [];
    const plate = Number(input.plate) || plates.find((item) => item.gcode)?.index || 1;
    if (plates.length > 0 && !plates.some((item) => item.index === plate)) {
      throw badRequest('error.plate_not_found', { plate, available: plates.map((item) => item.index).join(', ') });
    }
    options.plate = plate;
    // Không chốt sẵn dùng AMS hay không: lúc in driver mới biết máy đang gắn AMS thật hay chỉ có cuộn ngoài.
    if (input.useAms !== undefined) options.useAms = Boolean(input.useAms);
    if (Array.isArray(input.amsMapping)) {
      options.amsMapping = input.amsMapping.map((value) => Number(value)).filter((value) => Number.isInteger(value));
    } else if (options.useAms !== false) {
      const filaments = plates.find((item) => item.index === plate)?.filaments ?? [];
      const maxId = Math.max(1, ...filaments.map((item) => Number(item.id) || 1));
      options.amsMapping = Array.from({ length: maxId }, (_, index) => index);
    }
  }
  if (input.timelapse !== undefined) options.timelapse = Boolean(input.timelapse);
  for (const key of ['bedLeveling', 'flowCalibration']) {
    if (input[key] !== undefined) options[key] = input[key] === 'auto' ? 'auto' : Boolean(input[key]);
  }
  return options;
}

function assertCompatible(record, file) {
  const Driver = driverClass(record.driver);
  if (!Driver.formats.includes(file.format)) {
    throw badRequest('error.file_format_unsupported', {
      format: file.format,
      printer: record.name,
      supported: Driver.formats.join(', '),
    });
  }
  if (file.format === '3mf' && file.meta?.sliced === false) throw badRequest('error.file_not_sliced', { name: file.name });
}

function assertCanStart(record, { confirmBedClear }) {
  if (!record.enabled) throw conflict('error.printer_disabled', { name: record.name });
  if (activeJobFor(record.id)) throw conflict('error.printer_has_active_job', { name: record.name });
  if (!printers.isReady(record.id)) throw conflict('error.printer_not_ready', { name: record.name });
  if (record.bedClear === false && !confirmBedClear) throw conflict('error.bed_not_clear', { name: record.name });
}

/**
 * `mode: 'now'` gửi file và bắt đầu in ngay (máy phải rảnh, bàn in trống hoặc có `confirmBedClear`);
 * `mode: 'queue'` chỉ xếp hàng, tự chạy khi máy bật `autoStartQueue` và bàn in đã được xác nhận trống.
 */
export async function createJob(input = {}) {
  const file = library.getFileRecord(input.fileId ?? input.file);
  const wanted = input.printerId ?? input.printer;
  const shared = wanted === 'any' || (!wanted && input.printerIds !== undefined);
  const options = normalizeOptions(file, input);
  const target = shared ? { any: true, printerIds: normalizePool(input.printerIds) } : null;
  let record = null;
  if (shared) {
    // Hàng đợi chung chỉ xếp hàng, máy nào rảnh và hợp thì nhận; phải có ít nhất một máy nhận được mới cho tạo.
    const probe = { target, options };
    if (!printers.listPrinters().some((printer) => printerMatches(printers.findPrinter(printer.id), file, probe))) {
      throw badRequest('error.no_matching_printer', { name: file.name });
    }
  } else {
    record = printers.getRecord(wanted);
    assertCompatible(record, file);
  }
  const mode = input.mode === 'queue' || shared ? 'queue' : 'now';
  if (mode === 'now') assertCanStart(record, input);
  const estimate = insights.adjustEstimate(record?.id ?? null, file, options.plate ?? input.plate);

  const job = {
    id: shortId('job'),
    printerId: record?.id ?? null,
    printerName: record?.name ?? null,
    target,
    fileId: file.id,
    fileName: file.name,
    format: file.format,
    remoteName: null,
    status: 'queued',
    priority: clampPriority(input.priority),
    position: Date.now(),
    progress: 0,
    layer: null,
    totalLayers: file.meta?.layerCount ?? null,
    remaining: null,
    estimatedTime: estimate.estimatedTime,
    adjustedTime: record ? estimate.adjustedTime : null,
    upload: null,
    options,
    origin: input.origin ?? 'api',
    note: input.note ? String(input.note).slice(0, 500) : null,
    batch: input.batch?.id ? { id: String(input.batch.id), index: Number(input.batch.index) || 1, total: Number(input.batch.total) || 1 } : null,
    error: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
  };
  jobs.unshift(job);
  trimJobs();
  persist();
  emit('created', job);
  log.info(`Tạo job ${job.id}: ${file.name} -> ${record?.name ?? 'hàng đợi chung'} (${mode})`, { origin: job.origin });

  if (mode === 'now') {
    if (input.confirmBedClear) printers.setBedClear(record.id, true);
    dispatch(job);
  } else if (record) {
    schedulePrinterQueue(record.id, 0);
  } else {
    processQueue();
  }
  return publicJob(job);
}

/**
 * In cùng một file ngay lúc này trên nhiều máy, mỗi máy một bản. Không xếp hàng: máy chưa rảnh,
 * chưa xác nhận bàn trống hoặc không hợp file thì bỏ qua và trả lý do trong `skipped`.
 */
export async function createBatch(input = {}) {
  const file = library.getFileRecord(input.fileId ?? input.file);
  const pool = normalizePool(input.printerIds);
  const base = { ...input, printerId: undefined, printer: undefined, printerIds: undefined };
  // Mỗi máy nạp khay khác nhau, bảng gán AMS chỉ có nghĩa khi lô chạy trên đúng một máy.
  if (pool.length !== 1) delete base.amsMapping;
  const probe = { target: { printerIds: pool }, options: normalizeOptions(file, base) };
  const candidates = pool.length > 0 ? pool.map((id) => printers.findPrinter(id)) : printers.listPrinters().map((item) => printers.findPrinter(item.id));

  const ready = [];
  const skipped = [];
  for (const record of candidates) {
    try {
      if (!printerMatches(record, file, probe)) throw badRequest('error.printer_not_matching', { name: record.name, file: file.name });
      assertCanStart(record, input);
      ready.push(record);
    } catch (error) {
      skipped.push({ printerId: record.id, printerName: record.name, reason: error.key ?? null, message: error.message });
    }
  }
  if (ready.length === 0) throw conflict('error.batch_none_ready', { name: file.name }, { skipped });

  const batchId = shortId('bat');
  const created = [];
  for (const record of ready) {
    created.push(await createJob({ ...base, printerId: record.id, mode: 'now', batch: { id: batchId, index: created.length + 1, total: ready.length } }));
  }
  log.info(`Lô ${batchId}: ${file.name} in đồng thời trên ${created.length} máy, bỏ qua ${skipped.length}`, { origin: input.origin });
  return { batch: batchId, started: created.length, jobs: created, skipped };
}

/** Huỷ mọi bản chưa kết thúc của một lô. */
export async function cancelBatch(batchId, { force = false } = {}) {
  if (!jobs.some((job) => job.batch?.id === batchId)) throw notFound('error.batch_not_found', { id: batchId });
  const open = jobs.filter((job) => job.batch?.id === batchId && OPEN.has(job.status));
  const failed = [];
  for (const job of open) {
    try {
      await cancelJob(job.id, { force });
    } catch (error) {
      failed.push({ jobId: job.id, printerName: job.printerName, message: error.message });
    }
  }
  return { batch: batchId, canceled: open.length - failed.length, failed };
}

async function dispatch(job) {
  const file = library.findFile(job.fileId);
  if (!file) {
    finish(job, 'failed', t('error.file_not_found', { id: job.fileId }));
    return;
  }
  const size = file.size;
  updateJob(job, { status: 'uploading', upload: { sent: 0, total: size }, error: null });

  let lastEmit = 0;
  const onProgress = (sent) => {
    job.upload = { sent: Math.min(sent, size), total: size };
    const now = Date.now();
    if (now - lastEmit < 400) return;
    lastEmit = now;
    emit('progress', job);
  };

  try {
    const { driver } = printers.getDriver(job.printerId);
    const uploaded = await driver.uploadFile({
      path: library.filePath(file),
      remoteName: remoteFileName(file.name),
      size,
      start: false,
      options: job.options,
      onProgress,
    });
    if (job.status === 'canceled') return;
    updateJob(job, { remoteName: uploaded?.remoteName ?? remoteFileName(file.name), upload: { sent: size, total: size } });

    updateJob(job, { status: 'starting', startRequestedAt: Date.now() });
    await driver.startPrint(job.remoteName, job.options);
    printers.setBedClear(job.printerId, false);
    library.markPrinted(file.id);
    driver.schedule?.(500);
  } catch (error) {
    if (job.status === 'canceled') return;
    log.warn(`Job ${job.id} lỗi: ${error.message}`);
    finish(job, 'failed', error.message);
  }
}

function sameFile(job, file) {
  if (!file) return true;
  const base = (value) =>
    String(value ?? '')
      .split('/')
      .pop()
      .replace(/\.(gcode\.3mf|3mf|bgcode|gcode|gco|g)$/i, '')
      .toLowerCase();
  const names = [job.remoteName, job.fileName].filter(Boolean).map(base);
  return names.length === 0 || names.includes(base(file));
}

function applyProgress(job, status) {
  const info = status.job;
  if (!info) return {};
  return {
    progress: info.progress ?? job.progress,
    layer: info.layer ?? job.layer,
    totalLayers: info.totalLayers ?? job.totalLayers,
    remaining: info.remaining ?? job.remaining,
    elapsed: info.elapsed ?? job.elapsed ?? null,
    stage: info.stage ?? null,
  };
}

function onPrinterStatus({ printerId, status }) {
  if (!status?.online) return;
  const job = activeJobFor(printerId);
  const state = status.state;

  if (!job) {
    if ((state === 'printing' || state === 'paused') && status.job?.file) trackExternal(printerId, status);
    else if (printers.isReady(printerId)) schedulePrinterQueue(printerId, 1000);
    return;
  }

  if (job.status === 'starting') {
    if (state === 'printing' || state === 'paused') {
      updateJob(job, { status: state, startedAt: new Date().toISOString(), ...applyProgress(job, status) });
      log.info(`Job ${job.id} đã bắt đầu in trên ${job.printerName}`);
    } else if (state === 'error' && Date.now() - (job.startRequestedAt ?? 0) > START_GRACE_MS) {
      finish(job, 'failed', status.message || t('error.job_printer_error'));
    }
    return;
  }

  if (job.status !== 'printing' && job.status !== 'paused') return;

  if (job.reattach) {
    job.reattach = undefined;
    if ((state === 'printing' || state === 'paused') && !sameFile(job, status.job?.file)) {
      finish(job, 'failed', t('error.job_interrupted'));
      trackExternal(printerId, status);
      return;
    }
  }

  switch (state) {
    case 'printing':
    case 'paused': {
      const patch = applyProgress(job, status);
      const changed = job.status !== state || Object.entries(patch).some(([key, value]) => job[key] !== value);
      if (changed) updateJob(job, { status: state, ...patch }, job.status !== state ? 'updated' : 'progress');
      break;
    }
    case 'finished':
      updateJob(job, { progress: 100, remaining: 0, layer: job.totalLayers ?? job.layer });
      finish(job, 'completed');
      break;
    case 'cancelled':
      finish(job, 'canceled', t('error.job_canceled_at_printer'));
      break;
    case 'error':
      finish(job, 'failed', status.message || t('error.job_printer_error'));
      break;
    case 'idle':
      if ((status.job?.progress ?? job.progress ?? 0) >= 99) {
        updateJob(job, { progress: 100, remaining: 0, layer: job.totalLayers ?? job.layer });
        finish(job, 'completed');
      } else {
        finish(job, 'canceled', t('error.job_canceled_at_printer'));
      }
      break;
    default:
      break;
  }
}

/** Bản in được bật trực tiếp trên máy (màn hình, slicer) cũng được ghi vào lịch sử. */
function trackExternal(printerId, status) {
  const record = printers.findPrinter(printerId);
  if (!record) return;
  const job = {
    id: shortId('job'),
    printerId: record.id,
    printerName: record.name,
    fileId: null,
    fileName: status.job.file,
    format: null,
    remoteName: status.job.file,
    status: status.state,
    ...applyProgress({ progress: 0 }, status),
    estimatedTime: null,
    priority: 0,
    position: Date.now(),
    upload: null,
    options: {},
    origin: 'printer',
    note: null,
    error: null,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.unshift(job);
  trimJobs();
  persist();
  emit('created', job);
  if (record.bedClear !== false) printers.setBedClear(record.id, false);
  log.info(`Phát hiện bản in ngoài agent trên ${record.name}: ${job.fileName}`);
}

function schedulePrinterQueue(printerId, delay) {
  if (queueTimers.has(printerId)) return;
  const timer = setTimeout(() => {
    queueTimers.delete(printerId);
    processPrinterQueue(printerId);
  }, delay);
  timer.unref?.();
  queueTimers.set(printerId, timer);
}

/** Job kế tiếp cho máy: job riêng của máy và job hàng đợi chung mà máy nhận được, xếp theo ưu tiên rồi thứ tự. */
function nextQueued(printerId) {
  const record = printers.findPrinter(printerId);
  const candidates = jobs.filter(
    (job) => job.status === 'queued' && (job.printerId === printerId || (!job.printerId && printerMatches(record, library.findFile(job.fileId), job))),
  );
  return candidates.sort(queueOrder)[0] ?? null;
}

function processPrinterQueue(printerId) {
  const record = printers.findPrinter(printerId);
  if (!record?.enabled || !record.autoStartQueue || record.bedClear === false) return;
  if (activeJobFor(printerId) || !printers.isReady(printerId)) return;
  const job = nextQueued(printerId);
  if (!job) return;
  if (!job.printerId) assign(job, record);
  log.info(`Tự chạy job ${job.id} từ hàng đợi trên ${record.name}`);
  dispatch(job);
}

export function processQueue() {
  const shared = jobs.some((job) => job.status === 'queued' && !job.printerId);
  const targets = new Set(jobs.filter((job) => job.status === 'queued' && job.printerId).map((job) => job.printerId));
  if (shared) for (const printer of printers.listPrinters()) targets.add(printer.id);
  for (const printerId of targets) schedulePrinterQueue(printerId, 0);
}

export function startJob(id, { confirmBedClear, printerId } = {}) {
  const job = getJobRecord(id);
  if (job.status !== 'queued') throw conflict('error.job_not_queued', { id });
  const record = printers.getRecord(job.printerId ?? printerId);
  if (!job.printerId && !printerMatches(record, library.findFile(job.fileId), job)) {
    throw badRequest('error.printer_not_matching', { name: record.name, file: job.fileName });
  }
  assertCanStart(record, { confirmBedClear });
  if (confirmBedClear) printers.setBedClear(record.id, true);
  if (!job.printerId) assign(job, record);
  dispatch(job);
  return publicJob(job);
}

/** `force` đóng job kể cả khi không gửi được lệnh huỷ (máy mất kết nối, đã bị xoá). */
export async function cancelJob(id, { force = false } = {}) {
  const job = getJobRecord(id);
  if (FINAL.has(job.status)) return publicJob(job);
  if (job.status === 'queued' || job.status === 'uploading') {
    finish(job, 'canceled');
    return publicJob(job);
  }
  try {
    const { driver } = printers.getDriver(job.printerId);
    await driver.cancel();
    driver.schedule?.(500);
  } catch (error) {
    if (!force) throw printers.wrapUpstream(error);
  }
  finish(job, 'canceled');
  return publicJob(job);
}

export async function reprintJob(id, overrides = {}) {
  const job = getJobRecord(id);
  if (!job.fileId) throw badRequest('error.job_no_file', { id });
  return createJob({
    printerId: overrides.printerId ?? (job.target?.any ? 'any' : job.printerId),
    printerIds: job.target?.printerIds,
    priority: job.priority,
    fileId: job.fileId,
    ...job.options,
    ...overrides,
    origin: overrides.origin ?? job.origin,
  });
}

export function deleteJob(id) {
  const job = getJobRecord(id);
  if (OPEN.has(job.status)) throw conflict('error.job_active', { id });
  jobs = jobs.filter((item) => item.id !== job.id);
  persist();
  jobEvents.emit('job', { event: 'removed', job: { id: job.id } });
  return { deleted: true, id: job.id };
}

export function clearFinished({ printerId } = {}) {
  const before = jobs.length;
  jobs = jobs.filter((job) => OPEN.has(job.status) || (printerId && job.printerId !== printerId));
  persist();
  jobEvents.emit('job', { event: 'cleared', job: null });
  return { removed: before - jobs.length };
}

function onPrinterChanged({ event, printer }) {
  if (event === 'removed') {
    for (const job of jobs) {
      if (job.printerId === printer.id && OPEN.has(job.status)) finish(job, 'canceled', t('error.printer_removed'));
      if (!job.printerId && job.target?.printerIds?.includes(printer.id)) job.target.printerIds = job.target.printerIds.filter((id) => id !== printer.id);
    }
    return;
  }
  if (event === 'updated') {
    for (const job of jobs) {
      if (job.printerId === printer.id && OPEN.has(job.status) && job.printerName !== printer.name) job.printerName = printer.name;
    }
    schedulePrinterQueue(printer.id, 500);
  }
}

function sweep() {
  const now = Date.now();
  for (const job of jobs) {
    if (job.status === 'starting' && now - (job.startRequestedAt ?? now) > START_TIMEOUT_MS) {
      finish(job, 'failed', t('error.job_start_timeout'));
    }
  }
}

export function startQueue() {
  printers.printerEvents.on('status', onPrinterStatus);
  printers.printerEvents.on('changed', onPrinterChanged);
  sweepTimer = setInterval(sweep, 10000);
  sweepTimer.unref?.();
  processQueue();
}

export function stopQueue() {
  printers.printerEvents.off('status', onPrinterStatus);
  printers.printerEvents.off('changed', onPrinterChanged);
  clearInterval(sweepTimer);
  for (const timer of queueTimers.values()) clearTimeout(timer);
  queueTimers.clear();
  flushJobs();
}
