import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PATHS } from './paths.js';
import { createLogger } from '../util/logger.js';
import { badRequest, notFound } from '../util/errors.js';

/** Prompt hệ thống của các tính năng AI, để ngoài file .md cho dễ đọc và sửa được ngay trong UI. */

const log = createLogger('prompts');

const BUILTIN_DIR = fileURLToPath(new URL('./prompts/', import.meta.url));

/** Mỗi tên là một file .md trong src/core/prompts, và là một chỗ gọi model trong advisor. */
export const PROMPTS = ['chat', 'diagnose', 'inspect', 'review'];

const MAX_LENGTH = 20000;

/** Đặt file cùng tên trong thư mục này là ghi đè được bản mặc định mà không phải sửa code. */
export function promptsDir() {
  return path.join(PATHS.data, 'prompts');
}

function customFile(name) {
  if (!PROMPTS.includes(name)) throw notFound('error.prompt_not_found', { name });
  return path.join(promptsDir(), `${name}.md`);
}

export function defaultPrompt(name) {
  if (!PROMPTS.includes(name)) throw notFound('error.prompt_not_found', { name });
  return readFileSync(path.join(BUILTIN_DIR, `${name}.md`), 'utf8').trim();
}

/** Đọc lại mỗi lần gọi: sửa xong là lần hỏi AI kế tiếp đã dùng bản mới, khỏi khởi động lại agent. */
export function systemPrompt(name) {
  const file = customFile(name);
  if (existsSync(file)) {
    try {
      const text = readFileSync(file, 'utf8').trim();
      if (text) return text;
      log.warn(`Prompt ${name} tự sửa đang để trống, dùng bản mặc định`);
    } catch (error) {
      log.warn(`Không đọc được prompt ${name} tự sửa: ${error.message}`);
    }
  }
  return defaultPrompt(name);
}

export function getPrompt(name) {
  const fallback = defaultPrompt(name);
  const text = systemPrompt(name);
  return { name, text, default: fallback, custom: text !== fallback };
}

export function listPrompts() {
  return PROMPTS.map((name) => getPrompt(name));
}

/** Lưu bản tự sửa. Để trống hoặc giống hệt bản mặc định thì xoá luôn file cho khỏi lệch về sau. */
export function savePrompt(name, text) {
  const file = customFile(name);
  const value = String(text ?? '').trim();
  if (value.length > MAX_LENGTH) throw badRequest('error.prompt_too_long', { max: MAX_LENGTH });
  if (!value || value === defaultPrompt(name)) return resetPrompt(name);
  mkdirSync(promptsDir(), { recursive: true });
  writeFileSync(file, `${value}\n`, 'utf8');
  log.info(`Đã lưu prompt ${name} tự sửa (${value.length} ký tự)`);
  return getPrompt(name);
}

export function resetPrompt(name) {
  const file = customFile(name);
  if (existsSync(file)) {
    rmSync(file, { force: true });
    log.info(`Đã bỏ prompt ${name} tự sửa, quay về bản mặc định`);
  }
  return getPrompt(name);
}
