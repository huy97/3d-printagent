import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { PATHS } from './paths.js';
import { getConfig } from './config.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('hms');

const CATALOG_URL = 'https://e.bambulab.com/query.php';
const CACHE_FILE = path.join(PATHS.data, 'hms-catalog.json');
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 20000;
const CODE_PATTERN = /^HMS_([0-9A-F]{4})_([0-9A-F]{4})_([0-9A-F]{4})_([0-9A-F]{4})$/;

/** Nhóm thứ ba của mã HMS là mức độ nghiêm trọng theo quy ước của Bambu. */
const SEVERITIES = { 1: 'fatal', 2: 'serious', 3: 'common', 4: 'info' };

let entries = new Map();
let locale = null;
let fetchedAt = 0;
let pending = null;

function catalogLocale() {
  return getConfig().agent?.locale === 'en' ? 'en' : 'vi';
}

function apply(cache) {
  entries = new Map(Object.entries(cache.codes ?? {}));
  locale = cache.locale ?? null;
  fetchedAt = Number(cache.fetchedAt) || 0;
}

async function download(want) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${CATALOG_URL}?lang=${want}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const rows = payload?.data?.device_hms?.[want];
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('danh sách rỗng');
    const codes = {};
    for (const row of rows) {
      if (row?.ecode && row.intro) codes[String(row.ecode).toUpperCase()] = String(row.intro);
    }
    return { locale: want, version: payload?.data?.device_hms?.ver ?? null, fetchedAt: Date.now(), codes };
  } finally {
    clearTimeout(timer);
  }
}

/** Tải bảng mã về nền, không chặn luồng gọi; lỗi mạng chỉ ghi log vì mã trần vẫn hiển thị được. */
export function refreshHmsCatalog({ force = false } = {}) {
  const want = catalogLocale();
  if (pending) return pending;
  if (!force && locale === want && Date.now() - fetchedAt < MAX_AGE_MS) return Promise.resolve(false);
  pending = download(want)
    .then((cache) => {
      apply(cache);
      writeFileSync(CACHE_FILE, JSON.stringify(cache));
      log.info(`Đã tải ${entries.size} mã HMS (${want}) từ Bambu`);
      return true;
    })
    .catch((error) => {
      log.warn(`Không tải được bảng mã HMS: ${error.message}`);
      return false;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

export function loadHmsCatalog() {
  if (existsSync(CACHE_FILE)) {
    try {
      apply(JSON.parse(readFileSync(CACHE_FILE, 'utf8')));
    } catch (error) {
      log.warn(`Bỏ qua bảng mã HMS hỏng: ${error.message}`);
    }
  }
  refreshHmsCatalog();
  return entries.size;
}

/** Dịch mã HMS sang câu mô tả chính thức; chưa có bảng tra thì vẫn trả về mã và mức độ. */
export function describeHms(code) {
  const parts = CODE_PATTERN.exec(String(code ?? '').toUpperCase());
  if (!parts) return { code: String(code ?? ''), severity: null, text: null };
  const [, attrHigh, attrLow, severity, detail] = parts;
  return {
    code: String(code).toUpperCase(),
    severity: SEVERITIES[Number.parseInt(severity, 16)] ?? null,
    text: entries.get(`${attrHigh}${attrLow}${severity}${detail}`) ?? null,
  };
}

export function hmsCatalogStatus() {
  return { codes: entries.size, locale, fetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : null };
}
