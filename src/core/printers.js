import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { PATHS, ensureDataDirs } from './paths.js';
import { getConfig } from './config.js';
import { deleteTelemetry, queryTelemetry, recordSample } from './telemetry.js';
import { createDriver, driverClass } from '../drivers/index.js';
import { CALIBRATION_OPTIONS, CAPABILITY_KEYS, FILAMENT_DEFAULTS, MIN_EXTRUDE_TEMP, emptyStatus, statusMessage } from '../drivers/base.js';
import { shortId } from '../util/id.js';
import { createLogger } from '../util/logger.js';
import { badRequest, conflict, forbidden, notFound, upstreamError } from '../util/errors.js';

const log = createLogger('printers');
export const printerEvents = new EventEmitter();
printerEvents.setMaxListeners(0);

const TEST_TIMEOUT_MS = 15000;
const URL_SECRET = '***';
const BUSY_STATES = new Set(['printing', 'paused', 'busy']);

let records = [];
const runtime = new Map();

const driverContext = {
  get pollIntervalMs() {
    return getConfig().monitoring.pollIntervalMs;
  },
};

export function loadPrinters() {
  ensureDataDirs();
  if (!existsSync(PATHS.printers)) {
    records = [];
    return records;
  }
  try {
    const parsed = JSON.parse(readFileSync(PATHS.printers, 'utf8'));
    records = Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    log.warn(`Failed to read printers.json: ${error.message}`);
    records = [];
  }
  return records;
}

function persist() {
  ensureDataDirs();
  const tmp = `${PATHS.printers}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(records, null, 2));
  renameSync(tmp, PATHS.printers);
}

export async function startAll() {
  for (const record of records) {
    if (record.enabled) startRuntime(record);
  }
}

export async function stopAll() {
  await Promise.all([...runtime.keys()].map((id) => stopRuntime(id)));
}

function startRuntime(record) {
  const entry = { driver: null, error: null };
  runtime.set(record.id, entry);
  try {
    entry.driver = createDriver(record, driverContext);
  } catch (error) {
    entry.error = error;
    log.warn(`Failed to create the driver for ${record.name}: ${error.message}`);
    emitStatus(record.id);
    return entry;
  }
  entry.driver.on('status', (status) => {
    recordSample(record.id, status);
    printerEvents.emit('status', { printerId: record.id, status });
  });
  entry.driver.start().catch((error) => {
    log.warn(`Driver ${record.name} failed to start: ${error.message}`);
    entry.driver.update({ online: false, state: 'offline', message: error });
  });
  return entry;
}

async function stopRuntime(id) {
  const entry = runtime.get(id);
  if (!entry) return;
  runtime.delete(id);
  if (!entry.driver) return;
  entry.driver.removeAllListeners('status');
  await entry.driver.stop().catch((error) => log.warn(`Failed to stop the driver: ${error.message}`));
}

function emitStatus(id) {
  printerEvents.emit('status', { printerId: id, status: statusOf(id) });
}

export function statusOf(id) {
  const entry = runtime.get(id);
  if (entry?.driver) return entry.driver.status;
  const record = records.find((item) => item.id === id);
  return {
    ...emptyStatus(),
    state: entry?.error ? 'error' : 'offline',
    ...statusMessage(entry?.error ?? (record && !record.enabled ? { key: 'printer.message.disabled' } : null)),
  };
}

/** When connected, ask the driver directly, since many items are only known once the printer reports them. */
function calibrationsOf(record) {
  const driver = runtime.get(record.id)?.driver;
  if (driver) return driver.calibrations;
  return driverClass(record.driver).calibrations ?? [];
}

function printChoicesOf(record) {
  const driver = runtime.get(record.id)?.driver;
  if (driver) return driver.printChoices ?? null;
  return driverClass(record.driver).printChoicesFor?.(record.connection ?? {}) ?? null;
}

function capabilitiesOf(record) {
  const driver = runtime.get(record.id)?.driver;
  if (driver) return driver.capabilities;
  const Driver = driverClass(record.driver);
  const caps = Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, Boolean(Driver.capabilities[key])]));
  if (record.connection?.cameraUrl) caps.camera = true;
  return caps;
}

/** A password embedded in a camera URL is a secret too, masked like any other secret field. */
function parseUrl(value) {
  if (typeof value !== 'string' || !value.includes('://')) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function maskUrlPassword(value) {
  const url = parseUrl(value);
  if (!url?.password) return value;
  url.password = URL_SECRET;
  return url.href;
}

function restoreUrlPassword(value, existing) {
  const next = parseUrl(value);
  if (next?.password !== URL_SECRET) return value;
  const previous = parseUrl(existing);
  if (!previous?.password) return value;
  next.password = previous.password;
  return next.href;
}

export function toPublic(record) {
  const Driver = driverClass(record.driver);
  const connection = { ...record.connection };
  for (const field of Driver.fields) {
    if (field.secret && connection[field.key]) connection[field.key] = '***';
    else connection[field.key] = maskUrlPassword(connection[field.key]);
  }
  return {
    id: record.id,
    name: record.name,
    driver: record.driver,
    driverLabel: Driver.label,
    enabled: record.enabled,
    connection,
    notes: record.notes ?? '',
    autoStartQueue: Boolean(record.autoStartQueue),
    bedClear: record.bedClear !== false,
    slicer: record.slicer ?? null,
    powerW: record.powerW ?? null,
    hourlyCost: record.hourlyCost ?? null,
    formats: Driver.formats,
    capabilities: capabilitiesOf(record),
    calibrations: calibrationsOf(record),
    printChoices: printChoicesOf(record),
    status: statusOf(record.id),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function listPrinters() {
  return records.map(toPublic);
}

export function findPrinter(id) {
  return records.find((item) => item.id === id || item.name === id) ?? null;
}

export function getRecord(id) {
  const record = findPrinter(id);
  if (!record) throw notFound('error.printer_not_found', { id });
  return record;
}

export function getPrinter(id) {
  return toPublic(getRecord(id));
}

export function isReady(id) {
  const record = findPrinter(id);
  if (!record?.enabled) return false;
  return Boolean(runtime.get(record.id)?.driver?.readyForPrint);
}

function coerceField(field, value) {
  if (value === undefined || value === null || value === '') return null;
  switch (field.type) {
    case 'number': {
      const number = Number(value);
      if (!Number.isFinite(number)) throw badRequest('error.field_invalid', { field: field.key });
      if (field.min !== undefined && number < field.min) throw badRequest('error.field_invalid', { field: field.key });
      if (field.max !== undefined && number > field.max) throw badRequest('error.field_invalid', { field: field.key });
      return number;
    }
    case 'boolean':
      return value === true || value === 'true' || value === 1 || value === '1';
    case 'select': {
      const allowed = (field.options ?? []).map((option) => option.value);
      if (!allowed.includes(value)) throw badRequest('error.field_invalid', { field: field.key });
      return value;
    }
    default:
      return String(value).trim() || null;
  }
}

/** Keeps only the fields the driver declares; a secret submitted as '***' keeps its previous value. */
function sanitizeConnection(driverId, input = {}, existing = {}) {
  const Driver = driverClass(driverId);
  const result = {};
  for (const field of Driver.fields) {
    let value = Object.prototype.hasOwnProperty.call(input, field.key) ? input[field.key] : existing[field.key];
    if (field.secret && value === '***') value = existing[field.key];
    else value = restoreUrlPassword(value, existing[field.key]);
    const coerced = coerceField(field, value);
    const fallback = field.default ?? Driver.defaults[field.key] ?? null;
    result[field.key] = coerced ?? fallback;
    if (field.required && (result[field.key] === null || result[field.key] === '')) {
      throw badRequest('error.field_required', { field: field.key });
    }
  }
  return result;
}

function cleanName(value, fallback) {
  const name = String(value ?? '').trim() || fallback;
  if (!name) throw badRequest('error.field_required', { field: 'name' });
  if (name.length > 100) throw badRequest('error.field_invalid', { field: 'name' });
  return name;
}

/** Power draw (W) and wear per print hour; empty falls back to the defaults in the cost config. */
function costField(value, field, max) {
  if (value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > max) throw badRequest('error.field_invalid', { field });
  return number;
}

function sanitizeSlicer(value, previous = {}) {
  if (value === null) return null;
  if (value === undefined) return previous ?? null;
  const pick = (key) => {
    const next = value[key];
    if (next === undefined) return previous?.[key] ?? null;
    return next ? String(next).slice(0, 200) : null;
  };
  const result = { machine: pick('machine'), process: pick('process'), filament: pick('filament') };
  return result.machine || result.process || result.filament ? result : null;
}

export function addPrinter(input = {}) {
  const Driver = driverClass(input.driver);
  const now = new Date().toISOString();
  const record = {
    id: shortId('prn'),
    name: cleanName(input.name, Driver.label),
    driver: Driver.id,
    enabled: input.enabled !== false,
    connection: sanitizeConnection(Driver.id, input.connection ?? {}),
    notes: String(input.notes ?? ''),
    autoStartQueue: Boolean(input.autoStartQueue),
    bedClear: input.bedClear !== false,
    slicer: sanitizeSlicer(input.slicer, null),
    powerW: input.powerW === undefined ? null : costField(input.powerW, 'powerW', 10000),
    hourlyCost: input.hourlyCost === undefined ? null : costField(input.hourlyCost, 'hourlyCost', 1e9),
    createdAt: now,
    updatedAt: now,
  };
  if (records.some((item) => item.name === record.name)) throw conflict('error.printer_name_taken', { name: record.name });
  records.push(record);
  persist();
  if (record.enabled) startRuntime(record);
  log.info(`Added printer ${record.name} (${Driver.label})`);
  printerEvents.emit('changed', { event: 'added', printer: toPublic(record) });
  return toPublic(record);
}

export async function updatePrinter(id, patch = {}) {
  const record = getRecord(id);
  const driverId = patch.driver ? driverClass(patch.driver).id : record.driver;
  const driverChanged = driverId !== record.driver;
  let restart = false;

  if (patch.name !== undefined) {
    const name = cleanName(patch.name);
    if (records.some((item) => item.id !== record.id && item.name === name)) {
      throw conflict('error.printer_name_taken', { name });
    }
    record.name = name;
  }
  if (patch.connection !== undefined || driverChanged) {
    const next = sanitizeConnection(driverId, patch.connection ?? {}, driverChanged ? {} : record.connection);
    restart = driverChanged || JSON.stringify(next) !== JSON.stringify(record.connection);
    record.connection = next;
    record.driver = driverId;
  }
  if (patch.enabled !== undefined && Boolean(patch.enabled) !== record.enabled) {
    record.enabled = Boolean(patch.enabled);
    restart = true;
  }
  if (patch.notes !== undefined) record.notes = String(patch.notes ?? '');
  if (patch.autoStartQueue !== undefined) record.autoStartQueue = Boolean(patch.autoStartQueue);
  if (patch.bedClear !== undefined) record.bedClear = Boolean(patch.bedClear);
  if (patch.slicer !== undefined) record.slicer = sanitizeSlicer(patch.slicer, record.slicer);
  if (patch.powerW !== undefined) record.powerW = costField(patch.powerW, 'powerW', 10000);
  if (patch.hourlyCost !== undefined) record.hourlyCost = costField(patch.hourlyCost, 'hourlyCost', 1e9);
  record.updatedAt = new Date().toISOString();
  persist();

  if (restart) {
    await stopRuntime(record.id);
    if (record.enabled) startRuntime(record);
    else emitStatus(record.id);
  }
  printerEvents.emit('changed', { event: 'updated', printer: toPublic(record) });
  return toPublic(record);
}

export async function removePrinter(id) {
  const record = getRecord(id);
  await stopRuntime(record.id);
  records = records.filter((item) => item.id !== record.id);
  persist();
  deleteTelemetry(record.id);
  log.info(`Removed printer ${record.name}`);
  printerEvents.emit('changed', { event: 'removed', printer: { id: record.id, name: record.name } });
  return { removed: true, id: record.id };
}

export function setBedClear(id, value = true) {
  const record = getRecord(id);
  record.bedClear = Boolean(value);
  record.updatedAt = new Date().toISOString();
  persist();
  printerEvents.emit('changed', { event: 'updated', printer: toPublic(record) });
  return toPublic(record);
}

export async function reconnect(id) {
  const record = getRecord(id);
  if (!record.enabled) throw conflict('error.printer_disabled', { name: record.name });
  await stopRuntime(record.id);
  startRuntime(record);
  return toPublic(record);
}

function withTimeout(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(onTimeout()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Tests the connection before saving; `id` allows reusing the stored secret when the form submits '***'. */
export async function testConnection({ id, driver, connection } = {}) {
  const existing = id ? getRecord(id) : null;
  const driverId = driverClass(driver ?? existing?.driver).id;
  const base = existing && existing.driver === driverId ? existing.connection : {};
  const probe = createDriver(
    { id: 'probe', name: 'probe', driver: driverId, connection: sanitizeConnection(driverId, connection ?? {}, base) },
    driverContext,
  );
  const started = Date.now();
  try {
    const info = await withTimeout(probe.test(), TEST_TIMEOUT_MS, () =>
      upstreamError('error.printer_test_failed', { message: 'timeout' }),
    );
    return { ok: true, latencyMs: Date.now() - started, ...info };
  } catch (error) {
    if (error.key) throw error;
    throw upstreamError('error.printer_test_failed', { message: error });
  } finally {
    await probe.stop().catch(() => {});
  }
}

export function getDriver(id, { requireOnline = true } = {}) {
  const record = getRecord(id);
  if (!record.enabled) throw conflict('error.printer_disabled', { name: record.name });
  const entry = runtime.get(record.id);
  if (!entry?.driver) throw conflict('error.printer_driver_error', { name: record.name, message: entry?.error?.message ?? '' });
  if (requireOnline && !entry.driver.status.online) throw conflict('error.printer_offline', { name: record.name });
  return { record, driver: entry.driver };
}

function requireCapability(record, driver, capability) {
  if (!driver.capabilities[capability]) {
    throw badRequest('error.action_unsupported', { action: capability, driver: driverClass(record.driver).label });
  }
}

export function getHistory(id, range = {}) {
  const record = getRecord(id);
  return queryTelemetry(record.id, range);
}

export async function snapshot(id) {
  const { record, driver } = getDriver(id, { requireOnline: false });
  requireCapability(record, driver, 'camera');
  return driver.snapshot().catch((error) => {
    throw wrapUpstream(error);
  });
}

/** Subscribes to camera frames, returns the unsubscribe function. */
export function streamCamera(id, listener) {
  const { record, driver } = getDriver(id, { requireOnline: false });
  requireCapability(record, driver, 'cameraStream');
  return driver.subscribeCamera(listener);
}

export async function listPrinterFiles(id) {
  const { record, driver } = getDriver(id);
  requireCapability(record, driver, 'files');
  const files = await driver.listFiles().catch((error) => {
    throw wrapUpstream(error);
  });
  return files.sort((a, b) => String(b.modifiedAt ?? '').localeCompare(String(a.modifiedAt ?? '')));
}

export async function deletePrinterFile(id, name) {
  if (!name) throw badRequest('error.field_required', { field: 'name' });
  const { record, driver } = getDriver(id);
  requireCapability(record, driver, 'files');
  const result = await driver.deleteFile(name).catch((error) => {
    throw wrapUpstream(error);
  });
  log.info(`Deleted file ${name} on ${record.name}`);
  return result;
}

export async function startPrinterFile(id, name, options = {}) {
  if (!name) throw badRequest('error.field_required', { field: 'name' });
  const { record, driver } = getDriver(id);
  requireCapability(record, driver, 'start');
  if (!driver.readyForPrint) throw conflict('error.printer_not_ready', { name: record.name });
  const result = await driver.startPrint(name, options).catch((error) => {
    throw wrapUpstream(error);
  });
  record.bedClear = false;
  persist();
  printerEvents.emit('changed', { event: 'updated', printer: toPublic(record) });
  driver.schedule?.(500);
  log.info(`Started printing ${name} on ${record.name}`);
  return result;
}

const HEATER_LIMITS = { nozzle: 'maxNozzleTemp', bed: 'maxBedTemp', chamber: 'maxChamberTemp' };
const TEMP_CODES = { M104: 'nozzle', M109: 'nozzle', M140: 'bed', M190: 'bed', M141: 'chamber', M191: 'chamber' };

function checkTemperature(heater, target, driver) {
  const safety = getConfig().safety;
  const value = Number(target);
  if (!Number.isFinite(value) || value < 0) throw badRequest('error.field_invalid', { field: 'target' });
  const limits = [Number(safety[HEATER_LIMITS[heater]]), Number(driver?.temperatureLimits?.[heater])].filter(Number.isFinite);
  const limit = limits.length > 0 ? Math.min(...limits) : null;
  if (limit !== null && value > limit) throw badRequest('error.temperature_limit', { heater, target: value, limit });
  return value;
}

function parseGcode(input, driver) {
  const raw = Array.isArray(input) ? input.join('\n') : String(input ?? '');
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith(';'));
  if (lines.length === 0) throw badRequest('error.field_required', { field: 'gcode' });
  if (lines.length > 500) throw badRequest('error.gcode_too_long', { max: 500 });

  const safety = getConfig().safety;
  if (!safety.allowGcode) throw forbidden('error.gcode_disabled');
  const blocked = new Set((safety.blockedGcodes ?? []).map((code) => String(code).toUpperCase()));
  for (const line of lines) {
    const code = line.split(';')[0].trim().split(/\s+/)[0].toUpperCase();
    if (blocked.has(code)) throw forbidden('error.gcode_blocked', { code });
    const heater = TEMP_CODES[code];
    const match = heater ? line.toUpperCase().match(/\sS(-?[\d.]+)/) : null;
    if (match) checkTemperature(heater, match[1], driver);
  }
  return lines;
}

function assertNotPrinting(record, driver) {
  if (BUSY_STATES.has(driver.status.state)) throw conflict('error.printer_busy_printing', { name: record.name });
}

function calibrationOptions(record, driver, input) {
  const wanted = [...new Set((Array.isArray(input) ? input : String(input ?? '').split(/[\s,]+/)).map(String).filter(Boolean))];
  if (wanted.length === 0) throw badRequest('error.calibration_no_option', { options: driver.calibrations.join(', ') });
  const unknown = wanted.filter((item) => !CALIBRATION_OPTIONS.includes(item));
  if (unknown.length > 0) throw badRequest('error.field_invalid', { field: `options: ${unknown.join(', ')}` });
  const unsupported = wanted.filter((item) => !driver.calibrations.includes(item));
  if (unsupported.length > 0) {
    throw badRequest('error.calibration_unsupported', {
      options: unsupported.join(', '),
      name: record.name,
      supported: driver.calibrations.join(', ') || '-',
    });
  }
  return wanted;
}

function numberInRange(value, field, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw badRequest('error.field_invalid', { field });
  return number;
}

/** Filament only extrudes with a hot enough nozzle, so the temperature always has to clear the safety limit. */
function filamentOptions(driver, params) {
  const current = Number(driver.status.temps?.nozzle?.target) || 0;
  const requested = params.temperature ?? (current >= MIN_EXTRUDE_TEMP ? current : FILAMENT_DEFAULTS.temperature);
  const temperature = checkTemperature('nozzle', requested, driver);
  if (temperature < MIN_EXTRUDE_TEMP) throw badRequest('error.filament_temp_low', { min: MIN_EXTRUDE_TEMP });
  const length = numberInRange(params.length ?? FILAMENT_DEFAULTS.length, 'length', 10, 1000);
  const options = { temperature, length };
  if (params.slot !== undefined && params.slot !== null && params.slot !== '') {
    options.slot = numberInRange(params.slot, 'slot', 0, 254);
  }
  return options;
}

const ACTION_CAPABILITY = {
  pause: 'pause',
  resume: 'resume',
  cancel: 'cancel',
  gcode: 'gcode',
  temperature: 'temperature',
  home: 'home',
  jog: 'jog',
  fan: 'fan',
  speed: 'speed',
  light: 'light',
  loadFilament: 'filament',
  unloadFilament: 'filament',
  emergencyStop: 'emergencyStop',
  connect: 'connect',
  calibrate: 'calibrate',
};

export const COMMAND_ACTIONS = Object.keys(ACTION_CAPABILITY);

/** Every control command goes through here so the safety limits and audit logging apply uniformly. */
export async function command(id, action, params = {}, { origin = 'api' } = {}) {
  const capability = ACTION_CAPABILITY[action];
  if (!capability) throw badRequest('error.command_unknown', { action });
  const { record, driver } = getDriver(id, { requireOnline: action !== 'connect' });
  requireCapability(record, driver, capability);

  let result;
  try {
    result = await runCommand(record, driver, action, params);
  } catch (error) {
    throw wrapUpstream(error);
  }
  log.info(`Command ${action} -> ${record.name}`, { origin, params: Object.keys(params).length ? params : undefined });
  driver.schedule?.(300);
  return result ?? { ok: true };
}

async function runCommand(record, driver, action, params) {
  let result;
  switch (action) {
    case 'pause':
      result = await driver.pause();
      break;
    case 'resume':
      result = await driver.resume();
      break;
    case 'cancel':
      result = await driver.cancel();
      break;
    case 'gcode':
      result = await driver.sendGcode(parseGcode(params.gcode ?? params.lines ?? params.commands, driver));
      break;
    case 'temperature': {
      const heater = params.heater ?? 'nozzle';
      if (!HEATER_LIMITS[heater]) throw badRequest('error.field_invalid', { field: 'heater' });
      result = await driver.setTemperature(heater, checkTemperature(heater, params.target, driver));
      break;
    }
    case 'home': {
      assertNotPrinting(record, driver);
      const axes = (Array.isArray(params.axes) ? params.axes : String(params.axes ?? '').split(/[\s,]+/))
        .map((axis) => String(axis).toLowerCase())
        .filter((axis) => ['x', 'y', 'z'].includes(axis));
      result = await driver.home(axes);
      break;
    }
    case 'jog': {
      assertNotPrinting(record, driver);
      const limit = Number(getConfig().safety.maxJogMm) || 100;
      const move = {};
      for (const axis of ['x', 'y', 'z']) {
        if (params[axis] === undefined || params[axis] === null || params[axis] === '') continue;
        move[axis] = numberInRange(params[axis], axis, -limit, limit);
      }
      if (params.feedrate !== undefined) move.feedrate = numberInRange(params.feedrate, 'feedrate', 1, 30000);
      result = await driver.jog(move);
      break;
    }
    case 'fan':
      result = await driver.setFan(numberInRange(params.percent ?? params.speed, 'percent', 0, 100));
      break;
    case 'speed':
      result = await driver.setSpeed(numberInRange(params.percent, 'percent', 10, 300));
      break;
    case 'light':
      result = await driver.setLight(params.on !== false && params.on !== 'false');
      break;
    case 'loadFilament':
    case 'unloadFilament': {
      assertNotPrinting(record, driver);
      result = await driver[action](filamentOptions(driver, params));
      break;
    }
    case 'calibrate': {
      assertNotPrinting(record, driver);
      // Bed leveling and resonance scans both sweep the nozzle across the whole plate; anything left on it snaps the nozzle.
      if (record.bedClear === false && params.confirmBedClear !== true) throw conflict('error.bed_not_clear', { name: record.name });
      result = await driver.calibrate(calibrationOptions(record, driver, params.options));
      break;
    }
    case 'emergencyStop':
      result = await driver.emergencyStop();
      break;
    case 'connect':
      result = await driver.connect();
      break;
    default:
      break;
  }
  return result;
}

export function summary() {
  const counts = {};
  let online = 0;
  for (const record of records) {
    const status = statusOf(record.id);
    if (status.online) online += 1;
    counts[status.state] = (counts[status.state] ?? 0) + 1;
  }
  return { total: records.length, online, states: counts };
}

export function wrapUpstream(error) {
  if (error?.key) return error;
  return upstreamError('error.printer_request_failed', { message: error?.message ?? String(error) });
}
