import { getConfig } from './config.js';
import { inspectPrint, diagnose } from './advisor.js';
import { sendTelegram } from './notify.js';
import * as printers from './printers.js';
import { t } from '../i18n/index.js';
import { createLogger } from '../util/logger.js';

/** Soi ảnh camera bằng AI trong lúc máy đang in, và tự chẩn đoán khi máy báo lỗi. */

const log = createLogger('watch');

const TICK_MS = 30000;
const SNAPSHOT_TIMEOUT_MS = 10000;
const PRINTING_STATES = new Set(['printing']);
// Lớp đầu in xong mới soi được, trước đó trên bàn gần như chưa có gì để nhìn.
const FIRST_LAYER_AT = 2;
const WAITING_STAGES = new Set(['preparing', 'heating']);

const inspections = new Map();
const diagnoses = new Map();
const watched = new Map();
let timer = null;
let listening = false;

function settings() {
  return getConfig().watch ?? {};
}

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function telegramReady() {
  const config = getConfig().notify?.telegram ?? {};
  return Boolean(config.enabled && config.botToken && config.chatId);
}

async function tell(text, photo) {
  if (!telegramReady()) return;
  try {
    await sendTelegram(text, { photo });
  } catch (error) {
    log.warn(`Không gửi được cảnh báo Telegram: ${error.message}`);
  }
}

function entryFor(printerId, job) {
  const key = job ?? null;
  const current = watched.get(printerId);
  if (current && current.key === key) return current;
  // Tính giờ từ lúc bắt đầu theo dõi, không phải từ mốc 0, nếu không vòng đầu tiên soi ngay lúc máy còn đang gia nhiệt.
  const fresh = { key, lastAt: Date.now(), firstLayerDone: false, alerted: new Set(), busy: false, stopped: false };
  watched.set(printerId, fresh);
  return fresh;
}

async function snapshotOf(printerId) {
  let guard = null;
  try {
    const timeout = new Promise((_, reject) => {
      guard = setTimeout(() => reject(new Error(t('notify.timeout'))), SNAPSHOT_TIMEOUT_MS);
      guard.unref?.();
    });
    return await Promise.race([printers.snapshot(printerId), timeout]);
  } finally {
    clearTimeout(guard);
  }
}

function alertMessage(record, result, { paused, pauseError }) {
  const lines = [`<b>${escapeHtml(t(`watch.title_${result.verdict}`))}</b>`];
  lines.push(escapeHtml(t('watch.line_printer', { printer: record.name })));
  if (result.job) lines.push(escapeHtml(t('watch.line_file', { file: result.job })));
  if (result.layer) lines.push(escapeHtml(t('watch.line_layer', { layer: result.layer })));
  lines.push(escapeHtml(t('watch.line_issue', { issue: t(`watch.issue_${result.issue}`), percent: Math.round(result.confidence * 100) })));
  if (result.summary) lines.push(escapeHtml(result.summary));
  if (result.advice.length > 0) {
    lines.push('', escapeHtml(t('watch.advice')));
    for (const item of result.advice) lines.push(`- ${escapeHtml(item)}`);
  }
  if (paused) lines.push('', escapeHtml(t('watch.paused')));
  else if (pauseError) lines.push('', escapeHtml(t('watch.pause_failed', { error: pauseError })));
  return lines.join('\n');
}

async function react(record, result, photo) {
  const config = settings();
  const entry = watched.get(record.id);
  if (result.confidence < (Number(config.minConfidence) || 0.75)) return;
  if (!['failed', 'suspect'].includes(result.verdict)) return;
  if (entry?.alerted.has(result.verdict)) return;
  entry?.alerted.add(result.verdict);

  let paused = false;
  let pauseError = null;
  // Chỉ dừng khi chắc là hỏng; "đáng ngờ" mà dừng thì sớm muộn cũng cắt nhầm một bản in đang tốt.
  if (result.verdict === 'failed' && config.onDetect === 'pause') {
    try {
      await printers.command(record.id, 'pause', {}, { origin: 'watch' });
      paused = true;
      if (entry) entry.stopped = true;
    } catch (error) {
      pauseError = error.message;
      log.warn(`Không tạm dừng được ${record.name}: ${error.message}`);
    }
  }
  log.warn(`${record.name}: ${result.verdict} (${result.issue}, ${Math.round(result.confidence * 100)}%)`);
  await tell(alertMessage(record, result, { paused, pauseError }), photo);
}

async function inspectOne(record, status, entry) {
  entry.busy = true;
  try {
    const photo = await snapshotOf(record.id);
    const result = await inspectPrint({ printerId: record.id, photo });
    inspections.set(record.id, result);
    await react(record, result, photo);
  } catch (error) {
    log.warn(`Không soi được máy ${record.name}: ${error.message}`);
  } finally {
    entry.busy = false;
    entry.lastAt = Date.now();
  }
}

/** Máy đang gia nhiệt, đang chuẩn bị hay chưa xong lớp nào thì trên bàn chưa có gì để soi. */
function started(status) {
  const job = status.job ?? {};
  if (WAITING_STAGES.has(job.stage)) return false;
  const layer = Number(job.layer);
  // OctoPrint và PrusaLink không báo số lớp, đành lấy tiến độ làm mốc đã thật sự in hay chưa.
  if (Number.isFinite(layer) && layer > 0) return layer >= FIRST_LAYER_AT;
  return Number(job.progress ?? 0) > 0;
}

function due(entry, status, config) {
  if (entry.busy || entry.stopped || !started(status)) return false;
  if (config.firstLayer !== false && !entry.firstLayerDone && Number(status.job?.layer) >= FIRST_LAYER_AT) {
    entry.firstLayerDone = true;
    return true;
  }
  const every = Math.max(1, Number(config.intervalMin) || 10) * 60000;
  return Date.now() - entry.lastAt >= every;
}

/** Một vòng soi: gọi từ hẹn giờ, và gọi thẳng trong test cho khỏi phải chờ. */
export async function runWatchOnce() {
  const config = settings();
  if (!config.enabled || !getConfig().ai?.apiKey) return;
  for (const printer of printers.listPrinters()) {
    if (!printer.enabled || !printer.capabilities?.camera) continue;
    const status = printers.statusOf(printer.id);
    if (!status.online || !PRINTING_STATES.has(status.state) || !status.job) {
      watched.delete(printer.id);
      continue;
    }
    const entry = entryFor(printer.id, status.job.file);
    if (!due(entry, status, config)) continue;
    await inspectOne(printers.getRecord(printer.id), status, entry);
  }
}

function diagnosisMessage(record, result) {
  const lines = [`<b>${escapeHtml(t('watch.diagnose_title', { printer: record.name }))}</b>`];
  if (result.summary) lines.push(escapeHtml(result.summary));
  if (result.causes.length > 0) {
    lines.push('', escapeHtml(t('watch.diagnose_causes')));
    for (const item of result.causes) lines.push(`- ${escapeHtml(item)}`);
  }
  if (result.steps.length > 0) {
    lines.push('', escapeHtml(t('watch.diagnose_steps')));
    for (const item of result.steps) lines.push(`- ${escapeHtml(item)}`);
  }
  return lines.join('\n');
}

/** Mã lỗi máy đang bật, dùng làm mốc để mỗi đợt lỗi chỉ chẩn đoán một lần. */
function faultKey(status) {
  const codes = (status.extra?.hms ?? [])
    .filter((item) => ['fatal', 'serious'].includes(item?.severity))
    .map((item) => item?.code)
    .filter(Boolean)
    .sort();
  if (codes.length > 0) return codes.join(',');
  return status.state === 'error' ? `state:${status.message ?? 'error'}` : null;
}

async function runDiagnose(printerId, key) {
  const record = printers.getRecord(printerId);
  try {
    const result = await diagnose({ printerId });
    diagnoses.set(printerId, { ...result, fault: key });
    log.warn(`${record.name} báo lỗi, đã chẩn đoán: ${result.summary}`);
    await tell(diagnosisMessage(record, result));
  } catch (error) {
    diagnoses.set(printerId, { printerId, fault: key, error: error.message, at: new Date().toISOString() });
    log.warn(`Không chẩn đoán được ${record.name}: ${error.message}`);
  }
}

function onStatus({ printerId, status }) {
  if (!settings().autoDiagnose || !getConfig().ai?.apiKey) return;
  const key = faultKey(status);
  if (!key) {
    if (diagnoses.get(printerId)?.fault) diagnoses.delete(printerId);
    return;
  }
  if (diagnoses.get(printerId)?.fault === key) return;
  diagnoses.set(printerId, { printerId, fault: key, pending: true, at: new Date().toISOString() });
  void runDiagnose(printerId, key);
}

export function startWatcher() {
  if (listening) return;
  listening = true;
  printers.printerEvents.on('status', onStatus);
  timer = setInterval(() => {
    void runWatchOnce().catch((error) => log.warn(`Vòng soi ảnh lỗi: ${error.message}`));
  }, TICK_MS);
  timer.unref?.();
}

export function stopWatcher() {
  listening = false;
  printers.printerEvents.off('status', onStatus);
  clearInterval(timer);
  timer = null;
  watched.clear();
  inspections.clear();
  diagnoses.clear();
}

export function lastInspection(printerId) {
  return inspections.get(printerId) ?? null;
}

export function lastDiagnosis(printerId) {
  return diagnoses.get(printerId) ?? null;
}

/** Soi ngay theo yêu cầu người dùng, không phụ thuộc lịch và không tự dừng máy. */
export async function inspectNow(printerId, { note, locale } = {}) {
  const photo = await snapshotOf(printerId);
  const result = await inspectPrint({ printerId, photo, note, locale });
  inspections.set(printerId, result);
  return result;
}

export function watchStatus() {
  const config = settings();
  return {
    enabled: Boolean(config.enabled),
    running: listening,
    ready: Boolean(getConfig().ai?.apiKey),
    intervalMin: Number(config.intervalMin) || 10,
    onDetect: config.onDetect ?? 'notify',
    autoDiagnose: Boolean(config.autoDiagnose),
  };
}
