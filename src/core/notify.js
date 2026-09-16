import { getConfig } from './config.js';
import { jobEvents } from './jobs.js';
import * as printers from './printers.js';
import { t } from '../i18n/index.js';
import { createLogger } from '../util/logger.js';
import { AppError, badRequest } from '../util/errors.js';

/** Bắn thông báo ra Telegram khi một lệnh in kết thúc. */

// upstreamError dùng mã printer_error, ở đây bên thứ ba là Telegram chứ không phải máy in.
const telegramError = (detail) => new AppError('error.telegram_failed', { status: 502, code: 'upstream_error', params: { detail } });

const log = createLogger('notify');

export const NOTIFY_EVENTS = ['completed', 'failed', 'canceled'];
const API = 'https://api.telegram.org';
const TIMEOUT_MS = 15000;
const SNAPSHOT_TIMEOUT_MS = 8000;
// Đủ nhớ cho vài nghìn lệnh in gần đây, tránh gửi trùng khi có nhiều sự kiện cùng trỏ về một job đã xong.
const REMEMBER = 500;

const sent = new Set();
let attached = false;

function settings() {
  return getConfig().notify?.telegram ?? {};
}

/** Telegram parse_mode HTML chỉ đòi thoát ba ký tự này. */
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

/** Ảnh chụp là thứ có cũng được, máy không có camera hay chụp hỏng thì vẫn phải gửi được tin nhắn chữ. */
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
    log.warn(`Không chụp được ảnh máy ${printerId}: ${error.message}`);
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
    log.warn('Bật thông báo Telegram nhưng thiếu bot token hoặc chat id');
    return;
  }
  try {
    await sendTelegram(messageFor(job), { photo: await snapshotOf(job.printerId) });
    log.info(`Đã báo Telegram: ${job.fileName} -> ${job.status}`);
  } catch (error) {
    log.warn(`Không gửi được thông báo Telegram: ${error.message}`);
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

/** Gửi một tin nhắn thử theo đúng cấu hình đang nhập, dùng cho nút "Gửi thử" trong màn cài đặt. */
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
