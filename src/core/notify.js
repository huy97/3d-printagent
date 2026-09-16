import { getConfig } from './config.js';
import { jobEvents } from './jobs.js';
import * as printers from './printers.js';
import { t } from '../i18n/index.js';
import { createLogger } from '../util/logger.js';
import { AppError, badRequest } from '../util/errors.js';

/** Pushes a Telegram notification when a print job ends. */

// upstreamError uses the printer_error code; here the third party is Telegram, not the printer.
const telegramError = (detail) => new AppError('error.telegram_failed', { status: 502, code: 'upstream_error', params: { detail } });

const log = createLogger('notify');

export const NOTIFY_EVENTS = ['completed', 'failed', 'canceled'];
const API = 'https://api.telegram.org';
const TIMEOUT_MS = 15000;
const SNAPSHOT_TIMEOUT_MS = 8000;
// Enough memory for the last few thousand jobs, avoiding duplicates when several events point at one finished job.
const REMEMBER = 500;

const sent = new Set();
let attached = false;

function settings() {
  return getConfig().notify?.telegram ?? {};
}

/** Telegram parse_mode HTML only requires escaping these three characters. */
function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function duration(job) {
  const from = Date.parse(job.startedAt ?? job.createdAt);
  const to = Date.parse(job.finishedAt ?? new Date().toISOString());
  const seconds = Math.round((to - from) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return t('notify.duration_hm', { hours, minutes });
  return t('notify.duration_m', { minutes: Math.max(1, minutes) });
}

export function messageFor(job) {
  const lines = [`<b>${escapeHtml(t(`notify.title_${job.status}`))}</b>`];
  lines.push(t('notify.line_file', { file: escapeHtml(job.fileName) }));
  lines.push(t('notify.line_printer', { printer: escapeHtml(job.printerName) }));
  const spent = duration(job);
  if (spent) lines.push(t('notify.line_duration', { duration: spent }));
  if (job.totalLayers) lines.push(t('notify.line_layers', { layers: job.totalLayers }));
  if (job.material?.usedG) {
    lines.push(t('notify.line_material', { used: job.material.usedG, product: job.material.productG, waste: job.material.wasteG }));
  }
  if (job.cost?.total) {
    lines.push(t('notify.line_cost', { total: Math.round(job.cost.total).toLocaleString('vi-VN'), currency: escapeHtml(job.cost.currency) }));
  }
  if (job.error) lines.push(t('notify.line_error', { error: escapeHtml(job.error) }));
  return lines.join('\n');
}

async function callTelegram(method, { botToken, body, form }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${API}/bot${botToken}/${method}`, {
      method: 'POST',
      signal: controller.signal,
      ...(form ? { body: form } : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.ok === false) {
      throw telegramError(data?.description ?? `HTTP ${response.status}`);
    }
    return data?.result ?? null;
  } catch (error) {
    if (error.key) throw error;
    throw telegramError(error.name === 'AbortError' ? t('notify.timeout') : error.message);
  } finally {
    clearTimeout(timer);
  }
}

/** The snapshot is optional; with no camera or a failed capture the text message must still go out. */
async function snapshotOf(printerId) {
  if (!settings().includeSnapshot) return null;
  let timer = null;
  try {
    if (!printers.getPrinter(printerId).capabilities?.camera) return null;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(t('notify.timeout'))), SNAPSHOT_TIMEOUT_MS);
      timer.unref?.();
    });
    return await Promise.race([printers.snapshot(printerId), guard]);
  } catch (error) {
    log.warn(`Failed to capture a snapshot of printer ${printerId}: ${error.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function sendTelegram(text, { botToken, chatId, photo } = {}) {
  const config = settings();
  const token = botToken ?? config.botToken;
  const chat = chatId ?? config.chatId;
  if (!token) throw badRequest('error.telegram_no_token');
  if (!chat) throw badRequest('error.telegram_no_chat');
  if (photo) {
    const form = new FormData();
    form.set('chat_id', String(chat));
    form.set('caption', text);
    form.set('parse_mode', 'HTML');
    form.set('photo', new Blob([photo.buffer], { type: photo.mime || 'image/jpeg' }), 'snapshot.jpg');
    return callTelegram('sendPhoto', { botToken: token, form });
  }
  return callTelegram('sendMessage', {
    botToken: token,
    body: { chat_id: String(chat), text, parse_mode: 'HTML', disable_web_page_preview: true },
  });
}

async function notifyJob(job) {
  const config = settings();
  const events = Array.isArray(config.events) && config.events.length > 0 ? config.events : NOTIFY_EVENTS;
  if (!config.enabled || !events.includes(job.status)) return;
  if (!config.botToken || !config.chatId) {
    log.warn('Telegram notifications enabled but bot token or chat id is missing');
    return;
  }
  try {
    await sendTelegram(messageFor(job), { photo: await snapshotOf(job.printerId) });
    log.info(`Telegram notified: ${job.fileName} -> ${job.status}`);
  } catch (error) {
    log.warn(`Failed to send the Telegram notification: ${error.message}`);
  }
}

function onJob({ job }) {
  if (!NOTIFY_EVENTS.includes(job.status) || sent.has(job.id)) return;
  sent.add(job.id);
  if (sent.size > REMEMBER) sent.delete(sent.values().next().value);
  void notifyJob(job);
}

export function startNotifier() {
  if (attached) return;
  attached = true;
  jobEvents.on('job', onJob);
}

export function stopNotifier() {
  attached = false;
  sent.clear();
  jobEvents.off('job', onJob);
}

/** Sends a test message using the settings currently being entered, for the "Send test" button in the settings screen. */
export async function testTelegram({ botToken, chatId } = {}) {
  const config = settings();
  const token = botToken && botToken !== '***' ? botToken : config.botToken;
  const chat = chatId || config.chatId;
  const result = await sendTelegram(`<b>${escapeHtml(t('notify.test_title'))}</b>\n${escapeHtml(t('notify.test_body', { agent: getConfig().agent.name }))}`, {
    botToken: token,
    chatId: chat,
  });
  return { sent: true, chatId: result?.chat?.id ?? chat };
}
