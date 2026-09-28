import { EventEmitter } from 'node:events';
import { fetchSnapshot } from './http.js';
import { unsupported, upstreamError } from '../util/errors.js';
import { t } from '../i18n/index.js';

export const PRINTER_STATES = ['offline', 'connecting', 'idle', 'busy', 'printing', 'paused', 'finished', 'cancelled', 'error'];

export const READY_STATES = new Set(['idle', 'finished', 'cancelled']);

export const CAPABILITY_KEYS = [
  'files',
  'upload',
  'start',
  'pause',
  'resume',
  'cancel',
  'gcode',
  'temperature',
  'home',
  'jog',
  'fan',
  'speed',
  'light',
  'filament',
  'camera',
  'cameraStream',
  'emergencyStop',
  'connect',
  'calibrate',
];

/**
 * Calibration items, named the same across every printer type. Each driver declares the
 * subset it supports, since the same item works differently per vendor.
 */
export const CALIBRATION_OPTIONS = [
  'bedLeveling',
  'highTempBed',
  'bedScrews',
  'vibration',
  'motorNoise',
  'nozzleOffset',
  'lidar',
  'nozzleClump',
];

/** Minimum temperature for extrusion, matching Klipper's default `min_extrude_temp`. */
export const MIN_EXTRUDE_TEMP = 170;
export const FILAMENT_DEFAULTS = { temperature: 220, length: 100, purge: 30 };

export function emptyStatus() {
  return {
    online: false,
    state: 'connecting',
    message: null,
    messageKey: null,
    messageParams: null,
    temps: { nozzle: null, bed: null, chamber: null },
    job: null,
    fanSpeed: null,
    speedFactor: null,
    position: null,
    light: null,
    firmware: null,
    extra: {},
    updatedAt: null,
  };
}

/**
 * Normalizes a status message into `{ message, messageKey, messageParams }`.
 * Accepts `{ key, params }` (or an AppError) for agent wording and plain strings for firmware text.
 */
export function statusMessage(value) {
  if (value === null || value === undefined || value === '') {
    return { message: null, messageKey: null, messageParams: null };
  }
  if (typeof value === 'object' && value.key) {
    const params = value.params ?? null;
    return { message: t(value.key, params ?? undefined), messageKey: value.key, messageParams: params };
  }
  const text = String(value instanceof Error ? value.message : value);
  return { message: text, messageKey: 'printer.message.raw', messageParams: { message: text } };
}

export function temp(actual, target) {
  const value = Number(actual);
  if (!Number.isFinite(value)) return null;
  const goal = Number(target);
  return { actual: Math.round(value * 10) / 10, target: Number.isFinite(goal) ? Math.round(goal * 10) / 10 : null };
}

export function clampProgress(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, Math.round(number * 10) / 10));
}

/** File name safe for printer storage (FTP, SD card, firmware API). */
export function remoteFileName(name) {
  const base = String(name ?? 'print.gcode')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9._\-() ]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^[._]+/, '');
  return base || 'print.gcode';
}

/**
 * Base class for every driver. Subclasses declare `capabilities`, `fields` and implement `poll()`
 * (or push status through `update()` when using a push transport such as MQTT).
 * Motion and temperature commands fall back to G-code, drivers with a native API override them.
 */
export class BaseDriver extends EventEmitter {
  static id = 'base';
  static label = 'Base';
  static formats = ['gcode'];
  static capabilities = {};
  static fields = [];
  static defaults = {};

  constructor(printer, context = {}) {
    super();
    this.printer = printer;
    this.connection = { ...this.constructor.defaults, ...(printer.connection ?? {}) };
    this.context = context;
    this.status = emptyStatus();
    this.running = false;
    this.timer = null;
    this.failures = 0;
  }

  get capabilities() {
    const base = Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, Boolean(this.constructor.capabilities[key])]));
    if (this.connection.cameraUrl) base.camera = true;
    return base;
  }

  get readyForPrint() {
    return this.status.online && READY_STATES.has(this.status.state);
  }

  get pollIntervalMs() {
    return Math.max(500, Number(this.context.pollIntervalMs) || 2000);
  }

  async start() {
    this.running = true;
    this.schedule(0);
  }

  async stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
  }

  schedule(delay) {
    if (!this.running || typeof this.poll !== 'function') return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), delay);
    this.timer.unref?.();
  }

  async tick() {
    try {
      const patch = await this.poll();
      this.failures = 0;
      this.update({ online: true, ...patch });
    } catch (error) {
      this.failures += 1;
      this.update({ online: false, state: 'offline', message: error, job: this.status.job });
    } finally {
      // When the printer is off, back the poll interval off to 30 seconds to avoid spamming logs and the network.
      const backoff = this.failures > 0 ? Math.min(30000, this.pollIntervalMs * 2 ** Math.min(this.failures, 4)) : 0;
      this.schedule(backoff || this.pollIntervalMs);
    }
  }

  update(patch) {
    this.status = {
      ...this.status,
      ...patch,
      ...('message' in patch ? statusMessage(patch.message) : {}),
      temps: patch.temps ? { ...this.status.temps, ...patch.temps } : this.status.temps,
      extra: patch.extra ? { ...this.status.extra, ...patch.extra } : this.status.extra,
      updatedAt: new Date().toISOString(),
    };
    this.emit('status', this.status);
  }

  /** Connection check when adding a printer: returns identifying info or throws. */
  async test() {
    if (typeof this.poll !== 'function') return {};
    const status = await this.poll();
    return { state: status.state ?? null, firmware: status.firmware ?? null };
  }

  fail(action) {
    throw unsupported('error.action_unsupported', { action, driver: this.constructor.label });
  }

  async listFiles() {
    this.fail('files');
  }

  async uploadFile(_file) {
    this.fail('upload');
  }

  async deleteFile(_name) {
    this.fail('files');
  }

  async startPrint(_name, _options) {
    this.fail('start');
  }

  async pause() {
    this.fail('pause');
  }

  async resume() {
    this.fail('resume');
  }

  async cancel() {
    this.fail('cancel');
  }

  async connect() {
    this.fail('connect');
  }

  async sendGcode(_lines) {
    this.fail('gcode');
  }

  async setTemperature(heater, target) {
    if (!this.capabilities.temperature) this.fail('temperature');
    const value = Math.round(target);
    const line = heater === 'bed' ? `M140 S${value}` : heater === 'chamber' ? `M141 S${value}` : `M104 S${value}`;
    return this.sendGcode([line]);
  }

  /** Hardware-specific temperature limits, layered on top of the global safety limits in the config. */
  get temperatureLimits() {
    return {};
  }

  /** Calibration items this printer supports; drivers that learn more from printer reports override it. */
  get calibrations() {
    return this.constructor.calibrations ?? [];
  }

  async calibrate(_options) {
    this.fail('calibrate');
  }

  async home(axes = []) {
    if (!this.capabilities.home) this.fail('home');
    return this.sendGcode([`G28 ${axes.map((axis) => axis.toUpperCase()).join(' ')}`.trim()]);
  }

  async jog({ x, y, z, feedrate }) {
    if (!this.capabilities.jog) this.fail('jog');
    const parts = [
      Number(x) ? `X${Number(x)}` : '',
      Number(y) ? `Y${Number(y)}` : '',
      Number(z) ? `Z${Number(z)}` : '',
    ].filter(Boolean);
    if (parts.length === 0) return { ok: true };
    const speed = Number(feedrate) || (Number(z) ? 600 : 3000);
    return this.sendGcode(['G91', `G1 ${parts.join(' ')} F${speed}`, 'G90']);
  }

  async setFan(percent) {
    if (!this.capabilities.fan) this.fail('fan');
    const value = Math.round((Math.max(0, Math.min(100, percent)) / 100) * 255);
    return this.sendGcode([value === 0 ? 'M107' : `M106 S${value}`]);
  }

  async setSpeed(percent) {
    if (!this.capabilities.speed) this.fail('speed');
    return this.sendGcode([`M220 S${Math.round(percent)}`]);
  }

  async setLight(_on) {
    this.fail('light');
  }

  async loadFilament(options = {}) {
    if (!this.capabilities.filament) this.fail('filament');
    return this.sendGcode(this.filamentGcode('load', options));
  }

  async unloadFilament(options = {}) {
    if (!this.capabilities.filament) this.fail('filament');
    return this.sendGcode(this.filamentGcode('unload', options));
  }

  /**
   * Load/unload sequence built from basic extrusion commands, works on both Marlin and Klipper so it
   * does not depend on M701/M702 or vendor-specific macros. Drivers with a shorter command override it.
   */
  /** Only preheat when the nozzle is still cold, so a temperature the user already set is not overridden. */
  preheatGcode({ temperature = FILAMENT_DEFAULTS.temperature } = {}) {
    const actual = Number(this.status.temps?.nozzle?.actual);
    if (Number.isFinite(actual) && actual >= MIN_EXTRUDE_TEMP) return [];
    const target = Math.round(temperature);
    return [`M104 S${target}`, `M109 S${target}`];
  }

  filamentGcode(mode, { temperature = FILAMENT_DEFAULTS.temperature, length = FILAMENT_DEFAULTS.length } = {}) {
    const distance = Math.round(length);
    const purge = FILAMENT_DEFAULTS.purge;
    const lines = [...this.preheatGcode({ temperature }), 'M83'];
    if (mode === 'load') lines.push(`G1 E${distance} F300`, `G1 E${purge} F150`);
    else lines.push(`G1 E${purge} F150`, `G1 E-${distance} F300`);
    lines.push('M400');
    return lines;
  }

  async emergencyStop() {
    if (!this.capabilities.emergencyStop) this.fail('emergencyStop');
    return this.sendGcode(['M112']);
  }

  async snapshot() {
    const url = this.connection.cameraUrl ?? (await this.cameraUrl?.());
    if (!url) this.fail('camera');
    return fetchImage(url);
  }
}

export async function fetchImage(url, { headers } = {}) {
  try {
    const response = await fetchSnapshot(url, { headers });
    if (response.status >= 400) throw upstreamError('error.camera_failed', { detail: `HTTP ${response.status}` });
    return { buffer: response.buffer, mime: response.mime };
  } catch (error) {
    if (error.key) throw error;
    throw upstreamError('error.camera_failed', { detail: error.message });
  }
}
