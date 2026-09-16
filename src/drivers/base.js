import { EventEmitter } from 'node:events';
import { fetchSnapshot } from './http.js';
import { unsupported, upstreamError } from '../util/errors.js';

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
 * Các hạng mục hiệu chỉnh máy, dùng chung tên cho mọi loại máy in. Mỗi driver khai riêng
 * danh sách nó làm được, vì cùng một hạng mục mỗi hãng lại chạy một kiểu.
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

/** Nhiệt độ tối thiểu để đùn được nhựa, khớp với `min_extrude_temp` mặc định của Klipper. */
export const MIN_EXTRUDE_TEMP = 170;
export const FILAMENT_DEFAULTS = { temperature: 220, length: 100, purge: 30 };

export function emptyStatus() {
  return {
    online: false,
    state: 'connecting',
    message: null,
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

/** Tên file an toàn cho bộ nhớ máy in (FTP, SD card, API của firmware). */
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
 * Lớp nền cho mọi driver. Driver con khai báo `capabilities`, `fields` và cài `poll()`
 * (hoặc tự đẩy trạng thái qua `update()` nếu dùng kết nối đẩy như MQTT).
 * Các lệnh chuyển động/nhiệt độ mặc định quy về G-code, driver nào có API riêng thì ghi đè.
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
      this.update({ online: false, state: 'offline', message: error.message, job: this.status.job });
    } finally {
      // Máy tắt thì giãn nhịp hỏi dần tới 30 giây để khỏi spam log và mạng.
      const backoff = this.failures > 0 ? Math.min(30000, this.pollIntervalMs * 2 ** Math.min(this.failures, 4)) : 0;
      this.schedule(backoff || this.pollIntervalMs);
    }
  }

  update(patch) {
    this.status = {
      ...this.status,
      ...patch,
      temps: patch.temps ? { ...this.status.temps, ...patch.temps } : this.status.temps,
      extra: patch.extra ? { ...this.status.extra, ...patch.extra } : this.status.extra,
      updatedAt: new Date().toISOString(),
    };
    this.emit('status', this.status);
  }

  /** Kiểm tra kết nối khi thêm máy: trả thông tin nhận diện hoặc ném lỗi. */
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

  /** Giới hạn nhiệt riêng của phần cứng, áp chồng lên giới hạn an toàn chung trong cấu hình. */
  get temperatureLimits() {
    return {};
  }

  /** Hạng mục hiệu chỉnh máy này làm được; driver nào biết thêm từ bản tin của máy thì ghi đè. */
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
   * Chuỗi nạp/rút bằng lệnh đùn cơ bản, chạy được trên cả Marlin lẫn Klipper nên không
   * phụ thuộc M701/M702 hay macro riêng của từng máy. Driver nào có lệnh gọn hơn thì ghi đè.
   */
  /** Chỉ gia nhiệt khi đầu phun còn nguội, tránh ép nhiệt độ khi người dùng đã chỉnh sẵn. */
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
