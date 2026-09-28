import { EventEmitter } from 'node:events';
import { sql } from './db.js';
import { getConfig } from './config.js';
import { annotateJob, jobEvents } from './jobs.js';
import * as printers from './printers.js';
import * as library from './library.js';
import * as filament from './filament.js';
import { sendTelegram } from './notify.js';
import { shortId } from '../util/id.js';
import { badRequest, notFound } from '../util/errors.js';
import { t } from '../i18n/index.js';
import { createLogger } from '../util/logger.js';

/** Ledger of every print run: the basis for stats, the estimate correction factor and maintenance reminders by print hours. */

const log = createLogger('insights');
export const insightsEvents = new EventEmitter();
insightsEvents.setMaxListeners(0);

const FINAL = new Set(['completed', 'failed', 'canceled']);
const DEFAULT_TASKS = [
  ['clean_bed', 50],
  ['lubricate_rods', 200],
  ['inspect_nozzle', 300],
  ['check_belts', 500],
];
const FACTOR_MIN = 0.5;
const FACTOR_MAX = 2.5;
let attached = false;

function round(value, digits = 2) {
  return Math.round(value * 10 ** digits) / 10 ** digits;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function planEstimate(file, plate) {
  const plates = file?.meta?.plates ?? [];
  const selected = plates.find((item) => item.index === Number(plate)) ?? plates.find((item) => item.gcode) ?? plates[0];
  return selected?.estimatedTime ?? file?.meta?.estimatedTime ?? null;
}

/** Median actual / estimated ratio of recent finished prints; with enough samples for a profile, the profile wins. */
export function estimateFactor(printerId, process = null) {
  if (!printerId) return { factor: 1, samples: 0, basis: 'none' };
  const rows = sql(`SELECT data FROM print_records WHERE printer_id = ? AND status = 'completed' ORDER BY finished_at DESC LIMIT 80`)
    .all(printerId)
    .map((row) => JSON.parse(row.data))
    .filter((item) => item.estimatedTime > 0 && item.duration > 60);
  const byProcess = process ? rows.filter((item) => item.process === process) : [];
  const basis = byProcess.length >= 3 ? 'profile' : 'printer';
  const chosen = (basis === 'profile' ? byProcess : rows).slice(0, 20);
  if (chosen.length < 2) return { factor: 1, samples: chosen.length, basis: 'none' };
  const factor = Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, median(chosen.map((item) => item.duration / item.estimatedTime))));
  return { factor: round(factor, 3), samples: chosen.length, basis };
}

export function adjustEstimate(printerId, file, plate) {
  const estimatedTime = planEstimate(file, plate);
  const factor = estimateFactor(printerId, file?.slice?.process ?? null);
  return {
    estimatedTime,
    adjustedTime: estimatedTime ? Math.round(estimatedTime * factor.factor) : null,
    ...factor,
  };
}

function sourceOf(file) {
  if (!file) return null;
  const source = file.sourceId ? library.findFile(file.sourceId) : null;
  return source ?? file;
}

/** Records a finished job; a job canceled while still queued does not count as a print. */
export function recordJob(job) {
  if (!job || !FINAL.has(job.status)) return null;
  if (!job.startedAt && job.status !== 'failed') return null;
  if (!job.printerId) return null;
  if (sql('SELECT 1 AS found FROM print_records WHERE job_id = ?').get(job.id)) return null;

  const finishedAt = job.finishedAt ?? new Date().toISOString();
  const duration = job.startedAt ? Math.max(0, (Date.parse(finishedAt) - Date.parse(job.startedAt)) / 1000) : 0;
  const file = job.fileId ? library.findFile(job.fileId) : null;
  const source = sourceOf(file);
  let settled = { material: null, cost: null };
  try {
    settled = filament.settleJob(job, duration);
  } catch (error) {
    log.warn(`Failed to settle filament for job ${job.id}: ${error.message}`);
  }
  const record = printers.findPrinter(job.printerId);
  const data = {
    jobId: job.id,
    printerId: job.printerId,
    printerName: record?.name ?? job.printerName,
    fileId: job.fileId,
    fileName: job.fileName,
    sourceId: source?.id ?? null,
    sourceName: source?.name ?? job.fileName,
    status: job.status,
    origin: job.origin,
    error: job.error ?? null,
    errorKey: job.errorKey ?? null,
    errorParams: job.errorParams ?? null,
    material: settled.material?.material ?? file?.meta?.filamentType ?? null,
    process: file?.slice?.process ?? null,
    estimatedTime: job.estimatedTime ?? null,
    adjustedTime: job.adjustedTime ?? null,
    duration: Math.round(duration),
    layer: job.layer ?? null,
    progress: job.progress ?? null,
    usedG: settled.material?.usedG ?? 0,
    productG: settled.material?.productG ?? 0,
    wasteG: settled.material?.wasteG ?? 0,
    grams: settled.material?.grams ?? null,
    failedG: settled.material?.failedG ?? 0,
    spools: settled.material?.spools ?? [],
    cost: settled.cost,
    startedAt: job.startedAt ?? null,
    finishedAt,
  };
  sql('INSERT OR IGNORE INTO print_records (job_id, printer_id, file_id, status, finished_at, duration, data) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    data.jobId,
    data.printerId,
    data.fileId ?? null,
    data.status,
    data.finishedAt,
    data.duration,
    JSON.stringify(data),
  );
  annotateJob(job.id, { material: settled.material, cost: settled.cost, duration: data.duration });
  insightsEvents.emit('record', data);
  void checkMaintenance(job.printerId);
  return data;
}

function onJob({ job }) {
  if (!job || !FINAL.has(job.status)) return;
  try {
    recordJob(job);
  } catch (error) {
    log.warn(`Failed to record job ${job.id}: ${error.message}`);
  }
}

function onFile({ event, file }) {
  if (event === 'removed' && file?.id) filament.forgetFile(file.id);
}

export function startInsights() {
  if (attached) return;
  attached = true;
  jobEvents.on('job', onJob);
  library.libraryEvents.on('file', onFile);
}

export function stopInsights() {
  attached = false;
  jobEvents.off('job', onJob);
  library.libraryEvents.off('file', onFile);
}

function records({ days, printerId } = {}) {
  const span = Number(days);
  const from = Number.isFinite(span) && span > 0 ? new Date(Date.now() - span * 86400000).toISOString() : '';
  const rows = printerId
    ? sql('SELECT data FROM print_records WHERE printer_id = ? AND finished_at >= ? ORDER BY finished_at').all(printerId, from)
    : sql('SELECT data FROM print_records WHERE finished_at >= ? ORDER BY finished_at').all(from);
  return { from: from || null, list: rows.map((row) => JSON.parse(row.data)) };
}

function bucket() {
  return {
    jobs: 0,
    completed: 0,
    failed: 0,
    canceled: 0,
    printSeconds: 0,
    usedG: 0,
    productG: 0,
    wasteG: 0,
    waste: { support: 0, adhesion: 0, purge: 0, failed: 0 },
    cost: { filament: 0, electricity: 0, wear: 0, total: 0 },
  };
}

function add(target, item) {
  target.jobs += 1;
  target[item.status] = (target[item.status] ?? 0) + 1;
  target.printSeconds += item.duration ?? 0;
  target.usedG += item.usedG ?? 0;
  target.productG += item.productG ?? 0;
  target.wasteG += item.wasteG ?? 0;
  if (item.status === 'completed') {
    for (const group of ['support', 'adhesion', 'purge']) target.waste[group] += item.grams?.[group] ?? 0;
  } else {
    target.waste.failed += item.failedG ?? 0;
  }
  for (const key of Object.keys(target.cost)) target.cost[key] += item.cost?.[key] ?? 0;
}

function finalize(target) {
  const decided = target.completed + target.failed + target.canceled;
  const rounded = {
    ...target,
    successRate: decided > 0 ? round((target.completed / decided) * 100, 1) : null,
    printSeconds: Math.round(target.printSeconds),
    usedG: round(target.usedG, 1),
    productG: round(target.productG, 1),
    wasteG: round(target.wasteG, 1),
    waste: Object.fromEntries(Object.entries(target.waste).map(([key, value]) => [key, round(value, 1)])),
    cost: Object.fromEntries(Object.entries(target.cost).map(([key, value]) => [key, round(value)])),
  };
  rounded.wasteRate = rounded.usedG > 0 ? round((rounded.wasteG / rounded.usedG) * 100, 1) : null;
  return rounded;
}

function grouped(list, keyOf, labelOf) {
  const map = new Map();
  for (const item of list) {
    const key = keyOf(item);
    if (key === null || key === undefined) continue;
    const entry = map.get(key) ?? { key, label: labelOf(item), ...bucket() };
    add(entry, item);
    map.set(key, entry);
  }
  return [...map.values()].map(finalize).sort((left, right) => right.jobs - left.jobs);
}

/** Success rate, filament, waste and cost over the last `days` days (0 means all time). */
export function printStats({ days = 30, printerId } = {}) {
  const { from, list } = records({ days, printerId });
  const totals = bucket();
  for (const item of list) add(totals, item);
  const daily = new Map();
  for (const item of list) {
    const date = item.finishedAt.slice(0, 10);
    const entry = daily.get(date) ?? { date, completed: 0, failed: 0, canceled: 0, usedG: 0, wasteG: 0 };
    entry[item.status] += 1;
    entry.usedG = round(entry.usedG + (item.usedG ?? 0), 1);
    entry.wasteG = round(entry.wasteG + (item.wasteG ?? 0), 1);
    daily.set(date, entry);
  }
  const printerStats = grouped(list, (item) => item.printerId, (item) => printers.findPrinter(item.printerId)?.name ?? item.printerName).map((entry) => ({
    ...entry,
    estimate: estimateFactor(entry.key),
  }));
  return {
    from,
    to: new Date().toISOString(),
    days: Number(days) || 0,
    currency: filament.costSettings().currency,
    totals: finalize(totals),
    printers: printerStats,
    files: grouped(list, (item) => item.sourceId ?? item.fileName, (item) => item.sourceName ?? item.fileName).slice(0, 20),
    materials: grouped(list, (item) => item.material?.toUpperCase() ?? null, (item) => item.material?.toUpperCase()),
    processes: grouped(list, (item) => item.process, (item) => item.process),
    origins: grouped(list, (item) => item.origin ?? 'api', (item) => item.origin ?? 'api'),
    daily: [...daily.values()],
    recentFailures: list
      .filter((item) => item.status === 'failed')
      .slice(-5)
      .reverse()
      .map((item) => ({ jobId: item.jobId, printerName: item.printerName, fileName: item.fileName, error: item.error, errorKey: item.errorKey ?? null, errorParams: item.errorParams ?? null, finishedAt: item.finishedAt })),
    maintenanceDue: dueMaintenance(),
  };
}

/** A few history lines to feed the prompts for AI diagnosis and file inspection. */
export function statsDigest({ printerId, fileId, material } = {}) {
  const lines = [];
  if (printerId) {
    const stats = printStats({ days: 90, printerId });
    const total = stats.totals;
    if (total.jobs > 0) {
      lines.push(
        `Printer history over 90 days: ${total.jobs} prints, ${total.completed} completed, ${total.failed} failed, ${total.canceled} canceled` +
          `${total.successRate !== null ? `, success rate ${total.successRate}%` : ''}; ${total.wasteG} g wasted out of ${total.usedG} g.`,
      );
      const factor = stats.printers[0]?.estimate;
      if (factor?.samples >= 2) lines.push(`Actual print time is about ${Math.round(factor.factor * 100)}% of the slicer estimate (${factor.samples} samples).`);
      for (const failure of stats.recentFailures.slice(0, 3)) lines.push(`Recent failure: ${failure.fileName} - ${failure.error ?? 'unknown reason'}`);
      const due = stats.maintenanceDue.filter((item) => item.printerId === printerId);
      if (due.length > 0) lines.push(`Maintenance due: ${due.map((item) => item.name).join(', ')}.`);
    }
  }
  if (material) {
    const entry = printStats({ days: 180 }).materials.find((item) => item.key === String(material).toUpperCase());
    if (entry && entry.jobs >= 2) lines.push(`Filament ${entry.key}: ${entry.jobs} prints, success rate ${entry.successRate ?? '-'}%.`);
  }
  if (fileId) {
    const file = library.findFile(fileId);
    const source = sourceOf(file);
    const entry = source ? printStats({ days: 0 }).files.find((item) => item.key === source.id) : null;
    if (entry) lines.push(`This model has been printed ${entry.jobs} times: ${entry.completed} completed, ${entry.failed} failed, ${entry.canceled} canceled.`);
  }
  return lines;
}

export function printerUsage(printerId) {
  const row = sql(
    `SELECT COALESCE(SUM(duration), 0) AS seconds, COUNT(*) AS jobs, COALESCE(SUM(json_extract(data, '$.usedG')), 0) AS grams FROM print_records WHERE printer_id = ?`,
  ).get(printerId);
  return { printSeconds: Math.round(row.seconds), printHours: round(row.seconds / 3600, 1), jobs: row.jobs, usedG: round(row.grams, 1) };
}

function readTasks(printerId) {
  return sql('SELECT data FROM maintenance_tasks WHERE printer_id = ?')
    .all(printerId)
    .map((row) => JSON.parse(row.data));
}

function writeTask(task) {
  sql('INSERT INTO maintenance_tasks (id, printer_id, data) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data').run(task.id, task.printerId, JSON.stringify(task));
}

function taskName(task) {
  return task.name || t(`maintenance.task.${task.key}`);
}

function seed(printerId) {
  if (sql('SELECT 1 AS found FROM maintenance_seeded WHERE printer_id = ?').get(printerId)) return;
  const usage = printerUsage(printerId);
  const now = new Date().toISOString();
  for (const [key, intervalHours] of DEFAULT_TASKS) {
    writeTask({ id: shortId('mnt'), printerId, key, name: null, intervalHours, doneAtSeconds: usage.printSeconds, doneAt: now, notifiedFor: null, createdAt: now });
  }
  sql('INSERT OR IGNORE INTO maintenance_seeded (printer_id) VALUES (?)').run(printerId);
}

function publicTask(task, usage) {
  const usedHours = Math.max(0, (usage.printSeconds - (task.doneAtSeconds ?? 0)) / 3600);
  return {
    id: task.id,
    printerId: task.printerId,
    key: task.key ?? null,
    name: taskName(task),
    custom: Boolean(task.name),
    intervalHours: task.intervalHours,
    usedHours: round(usedHours, 1),
    remainingHours: round(task.intervalHours - usedHours, 1),
    percent: round(Math.min(999, (usedHours / task.intervalHours) * 100), 1),
    due: usedHours >= task.intervalHours,
    doneAt: task.doneAt ?? null,
    createdAt: task.createdAt,
  };
}

export function listMaintenance(printerId) {
  const record = printers.getRecord(printerId);
  seed(record.id);
  const usage = printerUsage(record.id);
  const tasks = readTasks(record.id)
    .map((task) => publicTask(task, usage))
    .sort((left, right) => left.remainingHours - right.remainingHours);
  return { printerId: record.id, usage, tasks };
}

function taskRecord(printerId, taskId) {
  const task = readTasks(printerId).find((item) => item.id === taskId);
  if (!task) throw notFound('error.maintenance_not_found', { id: taskId });
  return task;
}

function cleanInterval(value) {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours < 1 || hours > 100000) throw badRequest('error.field_invalid', { field: 'intervalHours' });
  return Math.round(hours);
}

export function addMaintenance(printerId, { name, intervalHours } = {}) {
  const record = printers.getRecord(printerId);
  seed(record.id);
  const label = String(name ?? '').trim().slice(0, 80);
  if (!label) throw badRequest('error.field_required', { field: 'name' });
  const now = new Date().toISOString();
  const task = { id: shortId('mnt'), printerId: record.id, key: null, name: label, intervalHours: cleanInterval(intervalHours), doneAtSeconds: printerUsage(record.id).printSeconds, doneAt: now, notifiedFor: null, createdAt: now };
  writeTask(task);
  return publicTask(task, printerUsage(record.id));
}

export function updateMaintenance(printerId, taskId, patch = {}) {
  const record = printers.getRecord(printerId);
  const task = taskRecord(record.id, taskId);
  if (patch.name !== undefined) task.name = String(patch.name ?? '').trim().slice(0, 80) || null;
  if (patch.intervalHours !== undefined) task.intervalHours = cleanInterval(patch.intervalHours);
  writeTask(task);
  return publicTask(task, printerUsage(record.id));
}

/** Marks the task as just done: print hours are counted again from now. */
export function completeMaintenance(printerId, taskId) {
  const record = printers.getRecord(printerId);
  const task = taskRecord(record.id, taskId);
  const usage = printerUsage(record.id);
  task.doneAtSeconds = usage.printSeconds;
  task.doneAt = new Date().toISOString();
  task.notifiedFor = null;
  writeTask(task);
  return publicTask(task, usage);
}

export function deleteMaintenance(printerId, taskId) {
  const record = printers.getRecord(printerId);
  const task = taskRecord(record.id, taskId);
  sql('DELETE FROM maintenance_tasks WHERE id = ?').run(task.id);
  return { deleted: true, id: task.id };
}

export function dueMaintenance() {
  const due = [];
  for (const record of printers.listPrinters()) {
    if (!sql('SELECT 1 AS found FROM maintenance_seeded WHERE printer_id = ?').get(record.id)) continue;
    const usage = printerUsage(record.id);
    for (const task of readTasks(record.id)) {
      const item = publicTask(task, usage);
      if (item.due) due.push({ ...item, printerName: record.name });
    }
  }
  return due;
}

/** Notifies Telegram exactly once per maintenance cycle that just came due. */
export async function checkMaintenance(printerId) {
  const record = printers.findPrinter(printerId);
  if (!record) return [];
  seed(record.id);
  const usage = printerUsage(record.id);
  const fresh = [];
  for (const task of readTasks(record.id)) {
    const item = publicTask(task, usage);
    if (!item.due || task.notifiedFor === task.doneAtSeconds) continue;
    task.notifiedFor = task.doneAtSeconds;
    writeTask(task);
    fresh.push(item);
  }
  if (fresh.length === 0) return fresh;
  insightsEvents.emit('maintenance', { printerId: record.id, tasks: fresh });
  const telegram = getConfig().notify?.telegram ?? {};
  if (telegram.enabled && telegram.botToken && telegram.chatId) {
    const escape = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const lines = [`<b>${escape(t('maintenance.notify_title', { printer: record.name }))}</b>`];
    for (const item of fresh) lines.push(escape(t('maintenance.notify_line', { name: item.name, used: item.usedHours, interval: item.intervalHours })));
    try {
      await sendTelegram(lines.join('\n'));
    } catch (error) {
      log.warn(`Failed to send the maintenance reminder: ${error.message}`);
    }
  }
  return fresh;
}
