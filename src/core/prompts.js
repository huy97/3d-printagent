import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PATHS } from './paths.js';
import { createLogger } from '../util/logger.js';
import { badRequest, notFound } from '../util/errors.js';

/** System prompts for the AI features, kept in .md files so they stay readable and editable from the UI. */

const log = createLogger('prompts');

const BUILTIN_DIR = fileURLToPath(new URL('./prompts/', import.meta.url));

/** Each name is an .md file in src/core/prompts, and one model call site in advisor. */
export const PROMPTS = ['chat', 'diagnose', 'inspect', 'review'];

const MAX_LENGTH = 20000;

/** Dropping a file with the same name in this directory overrides the default without touching code. */
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

/** Re-read on every call: an edit applies to the next AI request without restarting the agent. */
export function systemPrompt(name) {
  const file = customFile(name);
  if (existsSync(file)) {
    try {
      const text = readFileSync(file, 'utf8').trim();
      if (text) return text;
      log.warn(`Custom prompt ${name} is empty, using the default`);
    } catch (error) {
      log.warn(`Failed to read custom prompt ${name}: ${error.message}`);
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

/** Saves the custom version. Empty or identical to the default removes the file so it cannot drift later. */
export function savePrompt(name, text) {
  const file = customFile(name);
  const value = String(text ?? '').trim();
  if (value.length > MAX_LENGTH) throw badRequest('error.prompt_too_long', { max: MAX_LENGTH });
  if (!value || value === defaultPrompt(name)) return resetPrompt(name);
  mkdirSync(promptsDir(), { recursive: true });
  writeFileSync(file, `${value}\n`, 'utf8');
  log.info(`Saved custom prompt ${name} (${value.length} characters)`);
  return getPrompt(name);
}

export function resetPrompt(name) {
  const file = customFile(name);
  if (existsSync(file)) {
    rmSync(file, { force: true });
    log.info(`Dropped custom prompt ${name}, back to the default`);
  }
  return getPrompt(name);
}
