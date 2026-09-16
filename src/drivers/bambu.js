import tls from 'node:tls';
import { spawn } from 'node:child_process';
import mqtt from 'mqtt';
import { Client as FtpClient } from 'basic-ftp';
import { BaseDriver, FILAMENT_DEFAULTS, clampProgress, temp } from './base.js';
import { badRequest, conflict, upstreamError } from '../util/errors.js';
import { fileFormat } from '../gcode/metadata.js';
import { describeHms } from '../core/hms.js';

// Nguồn: BambuStudio resources/printers/<model_id>.json (mã SSDP, tiền tố serial, kiểu liveview LAN,
// nozzle_temp_range, bed_temperature_limit, thiếu thì BED_TEMP_LIMIT 120, support_chamber_temp_edit)
// và CalibrationDialog::update_cali (hạng mục hiệu chỉnh từng dòng máy cho chọn).
export const BAMBU_MODELS = [
  // X1
  { value: 'X1C', label: 'X1 Carbon', codes: ['BL-P001'], serialPrefix: '00M', series: 'x1', arch: 'core_xy', camera: 'rtsp', chamber: true, chamberMax: null, nozzleMax: 300, bedMax: 120, bedLeveling: 1, flowCalibration: true, autoFlowCalibration: false, calibrations: ['lidar', 'bedLeveling', 'vibration'] },
  { value: 'X1', label: 'X1', codes: ['BL-P002'], serialPrefix: '00W', series: 'x1', arch: 'core_xy', camera: 'rtsp', chamber: true, chamberMax: null, nozzleMax: 300, bedMax: 120, bedLeveling: 1, flowCalibration: true, autoFlowCalibration: false, calibrations: ['lidar', 'bedLeveling', 'vibration'] },
  { value: 'X1E', label: 'X1E', codes: ['C13'], serialPrefix: '03W', series: 'x1', arch: 'core_xy', camera: 'rtsp', chamber: true, chamberMax: 60, nozzleMax: 320, bedMax: 110, bedLeveling: 1, flowCalibration: true, autoFlowCalibration: false, calibrations: ['lidar', 'bedLeveling', 'vibration'] },
  { value: 'X2D', label: 'X2D', codes: ['N6'], serialPrefix: '20P', series: 'x1', arch: 'core_xy', camera: 'rtsp', chamber: true, chamberMax: 65, nozzleMax: 300, bedMax: 120, bedLeveling: 2, flowCalibration: true, autoFlowCalibration: true, calibrations: ['bedLeveling', 'vibration', 'nozzleOffset', 'highTempBed'] },
  // P
  { value: 'P1P', label: 'P1P', codes: ['C11'], serialPrefix: '01S', series: 'p1', arch: 'core_xy', camera: 'jpeg', chamber: false, chamberMax: null, nozzleMax: 300, bedMax: 100, bedLeveling: 1, flowCalibration: false, autoFlowCalibration: false, calibrations: ['bedLeveling', 'vibration'] },
  { value: 'P1S', label: 'P1S', codes: ['C12'], serialPrefix: '01P', series: 'p1', arch: 'core_xy', camera: 'jpeg', chamber: false, chamberMax: null, nozzleMax: 300, bedMax: 100, bedLeveling: 1, flowCalibration: false, autoFlowCalibration: false, calibrations: ['bedLeveling', 'vibration'] },
  { value: 'P2S', label: 'P2S', codes: ['N7'], serialPrefix: '22E', series: 'x1', arch: 'core_xy', camera: 'rtsp', chamber: true, chamberMax: null, nozzleMax: 300, bedMax: 110, bedLeveling: 2, flowCalibration: true, autoFlowCalibration: true, calibrations: ['bedLeveling', 'vibration', 'highTempBed', 'nozzleClump'] },
  // A
  { value: 'A1MINI', label: 'A1 mini', codes: ['N1'], serialPrefix: '030', series: 'n', arch: 'i3', camera: 'jpeg', chamber: false, chamberMax: null, nozzleMax: 300, bedMax: 80, bedLeveling: 1, flowCalibration: true, autoFlowCalibration: false, calibrations: ['bedLeveling', 'vibration', 'motorNoise'] },
  { value: 'A1', label: 'A1', codes: ['N2S'], serialPrefix: '039', series: 'n', arch: 'i3', camera: 'jpeg', chamber: false, chamberMax: null, nozzleMax: 300, bedMax: 100, bedLeveling: 1, flowCalibration: true, autoFlowCalibration: false, calibrations: ['bedLeveling', 'vibration', 'motorNoise'] },
  { value: 'A2L', label: 'A2L', codes: ['N9'], serialPrefix: '26A', series: 'n', arch: 'i3', camera: 'jpeg', chamber: false, chamberMax: null, nozzleMax: 300, bedMax: 80, bedLeveling: 2, flowCalibration: true, autoFlowCalibration: true, calibrations: ['bedLeveling', 'vibration', 'motorNoise', 'highTempBed'] },
  // H2
  { value: 'H2D', label: 'H2D', codes: ['O1D'], serialPrefix: '094', series: 'o', arch: 'core_xy', camera: 'rtsp', chamber: true, chamberMax: 65, nozzleMax: 350, bedMax: 120, bedLeveling: 2, flowCalibration: true, autoFlowCalibration: true, calibrations: ['bedLeveling', 'vibration', 'nozzleOffset', 'highTempBed'] },
  { value: 'H2DPRO', label: 'H2D Pro', codes: ['O1E'], serialPrefix: '239', series: 'o', arch: 'core_xy', camera: 'rtsp', chamber: true, chamberMax: 65, nozzleMax: 350, bedMax: 120, bedLeveling: 2, flowCalibration: true, autoFlowCalibration: true, calibrations: ['bedLeveling', 'vibration', 'nozzleOffset', 'highTempBed'] },
  { value: 'H2S', label: 'H2S', codes: ['O1S'], serialPrefix: '093', series: 'o', arch: 'core_xy', camera: 'rtsp', chamber: true, chamberMax: 65, nozzleMax: 350, bedMax: 120, bedLeveling: 2, flowCalibration: true, autoFlowCalibration: true, calibrations: ['bedLeveling', 'vibration', 'highTempBed', 'nozzleClump'] },
  { value: 'H2C', label: 'H2C', codes: ['O1C', 'O1C2'], serialPrefix: '31B', series: 'o', arch: 'core_xy', camera: 'rtsp', chamber: true, chamberMax: 65, nozzleMax: 350, bedMax: 120, bedLeveling: 2, flowCalibration: true, autoFlowCalibration: true, calibrations: ['bedLeveling', 'vibration', 'nozzleOffset', 'highTempBed'] },
];

// Thứ tự hạng mục như CalibrationDialog.
const CALIBRATION_ORDER = ['lidar', 'bedLeveling', 'vibration', 'motorNoise', 'nozzleOffset', 'highTempBed', 'nozzleClump'];

const FALLBACK_MODEL = BAMBU_MODELS.find((item) => item.value === 'P1S');

export function bambuModelFromCode(code) {
  if (!code) return null;
  const normalized = String(code).trim().toUpperCase();
  return BAMBU_MODELS.find((item) => item.codes.includes(normalized)) ?? null;
}

export function bambuModelFromSerial(serial) {
  const prefix = String(serial ?? '').trim().toUpperCase().slice(0, 3);
  return BAMBU_MODELS.find((item) => item.serialPrefix === prefix) ?? null;
}

export function resolveBambuModel({ model, serial } = {}) {
  return BAMBU_MODELS.find((item) => item.value === model) ?? bambuModelFromSerial(serial) ?? FALLBACK_MODEL;
}

const STAGES = {
  1: 'Auto bed leveling',
  2: 'Heatbed preheating',
  3: 'Vibration compensation',
  4: 'Changing filament',
  5: 'M400 pause',
  6: 'Paused due to filament runout',
  7: 'Heating hotend',
  8: 'Calibrating extrusion',
  9: 'Scanning bed surface',
  10: 'Inspecting first layer',
  11: 'Identifying build plate type',
  12: 'Calibrating micro lidar',
  13: 'Homing toolhead',
  14: 'Cleaning nozzle tip',
  16: 'Paused by the user',
  17: 'Pause of front cover falling',
  19: 'Calibrating extrusion flow',
  20: 'Paused: nozzle temperature malfunction',
  21: 'Paused: heatbed temperature malfunction',
  22: 'Filament unloading',
  24: 'Filament loading',
  25: 'Calibrating motor noise',
  29: 'Cooling chamber',
  30: 'Paused by the G-code',
  34: 'Paused: first layer error',
  35: 'Paused: nozzle clog',
  36: 'Measuring motion precision',
  37: 'Enhancing motion precision',
  38: 'Measuring motion accuracy',
  39: 'Nozzle offset calibration',
  40: 'High temperature auto bed leveling',
  47: 'Auto bed leveling - phase 1',
  48: 'Auto bed leveling - phase 2',
  50: 'Adjusting heatbed temperature',
  54: 'Waiting for the heatbed to reach target temperature',
  65: 'Calibrating nozzle clumping detection',
};

/**
 * Bitmask của lệnh `calibration`, lấy từ MachineObject::command_start_calibration của BambuStudio.
 * Sai bit là máy chạy nhầm hạng mục nên giữ đúng thứ tự này.
 */
const CALIBRATION_BITS = {
  lidar: 1 << 0,
  bedLeveling: 1 << 1,
  vibration: 1 << 2,
  motorNoise: 1 << 3,
  nozzleOffset: 1 << 4,
  highTempBed: 1 << 5,
  nozzleClump: 1 << 6,
};

// Máy chạy hiệu chỉnh bằng file có sẵn trong bộ nhớ, tên file là dấu hiệu để không nhầm thành lệnh in.
const CALIBRATION_GCODE = '/usr/etc/print/auto_cali_for_user.gcode';
const CALIBRATION_MARK = 'auto_cali_for_user';
// Firmware X1 cũ hơn mốc này chưa có lệnh `calibration`, chỉ gọi được file hiệu chỉnh.
const X1_SERIES = new Set(['X1', 'X1C', 'X1E']);
const X1_CALIBRATION_FIRMWARE = '00.00.15.79';

const CANCELLED_ERROR = 50348044;
const SPEED_LEVELS = [
  { level: 1, percent: 50 },
  { level: 2, percent: 100 },
  { level: 3, percent: 124 },
  { level: 4, percent: 166 },
];

function mergeDeep(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {};
      mergeDeep(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

// DevDefs.h: cuộn ngoài là ams_id 255 ở giao thức mới, 254 ở giao thức cũ; slot_id 255 đánh dấu rút nhựa.
const VIRTUAL_TRAY_MAIN = 255;
const VIRTUAL_TRAY_LEGACY = 254;
const UNLOAD_SLOT = 255;
// AIR_FUN::FAN_COOLING_0_AIRDOOR, cũng là tham số P của M106 cho quạt làm mát chi tiết.
const COOLING_FAN = 1;
// Tốc độ StatusPanel dùng khi nhích trục (mm/phút).
const JOG_SPEED = { X: 3000, Y: 3000, Z: 900 };

/** Chuỗi hex `fun` báo firmware nhận lệnh MQTT nào (DevUtil::get_flag_bits). */
function flagBit(hex, bit) {
  if (typeof hex !== 'string' || !/^[0-9a-f]+$/i.test(hex)) return false;
  return ((BigInt(`0x${hex}`) >> BigInt(bit)) & 1n) === 1n;
}

/** Schema `device.*`: 16 bit thấp là nhiệt hiện tại, 16 bit cao là nhiệt đích. */
function packedTemp(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) return null;
  return { actual: number & 0xffff, target: (number >>> 16) & 0xffff };
}

const CHOICE_VALUES = { off: 0, on: 1, auto: 2 };

/**
 * PrintOption::getValueInt: off 0, on 1, auto 2. Máy không cho "auto" thì BambuStudio chọn sẵn "on";
 * tuỳ chọn bị ẩn giữ nguyên "auto" lúc tạo hộp thoại.
 */
function printChoice(value, choices) {
  if (choices.length === 0) return CHOICE_VALUES.auto;
  const wanted = value === undefined || value === null || value === 'auto' ? 'auto' : value === true || value === 'on' ? 'on' : 'off';
  return CHOICE_VALUES[choices.includes(wanted) ? wanted : 'on'];
}

function choicesFor(level, auto) {
  if (level === 2 || (level === 1 && auto)) return ['auto', 'on', 'off'];
  return level === 1 ? ['on', 'off'] : [];
}

function mainExtruder(report) {
  const list = report.device?.extruder?.info;
  return Array.isArray(list) ? (list.find((item) => Number(item.id) === 0) ?? null) : null;
}

function coolingFanPart(report) {
  const parts = report.device?.airduct?.parts;
  return Array.isArray(parts) ? (parts.find((part) => ((Number(part.id) >> 4) & 0xff) === COOLING_FAN) ?? null) : null;
}

/** Thứ tự ưu tiên như DevFan: airduct (phần trăm), fan_gear (0-255), cuối cùng cooling_fan_speed (0-15). */
function fanPercent(report) {
  const part = coolingFanPart(report);
  if (part) return Number(part.state) & 0xff;
  if (report.fan_gear !== undefined) return Math.round(((Number(report.fan_gear) & 0xff) / 255) * 100);
  if (report.cooling_fan_speed !== undefined) return Math.round(((Math.floor(Number(report.cooling_fan_speed) / 1.5) * 25.5) / 255) * 100);
  return null;
}

function trayColor(value) {
  if (!value || typeof value !== 'string' || value.length < 6) return null;
  return `#${value.slice(0, 6)}`;
}

function hmsCode(item) {
  const attr = Number(item.attr ?? 0);
  const code = Number(item.code ?? 0);
  const hex = (value) => value.toString(16).toUpperCase().padStart(4, '0');
  return `HMS_${hex(attr >>> 16)}_${hex(attr & 0xffff)}_${hex(code >>> 16)}_${hex(code & 0xffff)}`;
}

/**
 * Bambu Lab ở chế độ LAN: trạng thái và lệnh qua MQTT/TLS cổng 8883, file qua FTPS ngầm định cổng 990,
 * camera qua TCP cổng 6000 (P1, A1, A2L) hoặc RTSPS cổng 322 (X1, X2D, P2S, H2, cần ffmpeg).
 */
export class BambuDriver extends BaseDriver {
  static id = 'bambu';
  static label = 'Bambu Lab (LAN)';
  static formats = ['3mf', 'gcode'];
  static capabilities = {
    files: true,
    upload: true,
    start: true,
    pause: true,
    resume: true,
    cancel: true,
    gcode: true,
    temperature: true,
    home: true,
    jog: true,
    fan: true,
    speed: true,
    light: true,
    filament: true,
    camera: true,
    emergencyStop: true,
    calibrate: true,
  };
  static defaults = { model: 'auto' };
  static models = BAMBU_MODELS.map((item) => item.value);
  static fields = [
    { key: 'host', type: 'text', required: true, placeholder: '192.168.1.80' },
    { key: 'serial', type: 'text', required: true, placeholder: '01P00A123456789' },
    { key: 'accessCode', type: 'password', required: true, secret: true },
    {
      key: 'model',
      type: 'select',
      default: 'auto',
      options: [{ value: 'auto', label: 'Auto' }, ...BAMBU_MODELS.map((item) => ({ value: item.value, label: item.label }))],
    },
    { key: 'cameraUrl', type: 'text', advanced: true },
  ];

  constructor(printer, context) {
    super(printer, context);
    if (!this.connection.host) throw badRequest('error.printer_host_required');
    if (!this.connection.serial) throw badRequest('error.bambu_serial_required');
    if (!this.connection.accessCode) throw badRequest('error.bambu_access_code_required');
    this.model = resolveBambuModel(this.connection);
    this.report = {};
    this.modules = {};
    this.client = null;
    this.sequence = 0;
    this.pushTimer = null;
    this.cameraClients = new Set();
    this.cameraSocket = null;
    this.cameraRetry = null;
    this.lastFrame = null;
  }

  // Luồng liên tục chỉ có ở dòng camera JPEG (P1, A1, A2L); RTSP phải qua ffmpeg nên vẫn chụp từng ảnh.
  get capabilities() {
    const base = super.capabilities;
    base.cameraStream = !this.connection.cameraUrl && this.model.camera === 'jpeg';
    return base;
  }

  // FAILED giữ nguyên tới lần in sau nhưng máy vẫn nhận lệnh in mới.
  get readyForPrint() {
    return super.readyForPrint || (this.status.online && String(this.report.gcode_state).toUpperCase() === 'FAILED');
  }

  get topicReport() {
    return `device/${this.connection.serial}/report`;
  }

  get topicRequest() {
    return `device/${this.connection.serial}/request`;
  }

  connectMqtt({ reconnect = true } = {}) {
    return mqtt.connect(`mqtts://${this.connection.host}:8883`, {
      username: 'bblp',
      password: String(this.connection.accessCode),
      clientId: `3dpa_${Math.random().toString(16).slice(2, 10)}`,
      rejectUnauthorized: false,
      reconnectPeriod: reconnect ? 10000 : 0,
      connectTimeout: 10000,
      keepalive: 30,
      protocolVersion: 4,
    });
  }

  async start() {
    this.running = true;
    this.update({ online: false, state: 'connecting', message: null });
    const client = this.connectMqtt();
    this.client = client;

    client.on('connect', () => {
      client.subscribe(this.topicReport);
      this.request({ pushing: { command: 'pushall' } });
      this.request({ info: { command: 'get_version' } });
      this.update({ online: true, message: null });
    });
    client.on('message', (topic, payload) => this.handleMessage(payload));
    client.on('error', (error) => {
      const denied = /not authorized|bad user name or password/i.test(error.message);
      this.update({ online: false, state: 'offline', message: denied ? 'MQTT: access code rejected' : `MQTT: ${error.message}` });
    });
    client.on('offline', () => this.update({ online: false, state: 'offline' }));
    client.on('close', () => {
      if (this.running && this.status.online) this.update({ online: false, state: 'offline' });
    });

    // Dòng P1/A1 chỉ gửi phần thay đổi, thỉnh thoảng xin lại toàn bộ để không lệch trạng thái.
    this.pushTimer = setInterval(() => {
      if (this.client?.connected) this.request({ pushing: { command: 'pushall' } });
    }, 300000);
    this.pushTimer.unref?.();
  }

  async stop() {
    this.running = false;
    this.cameraClients.clear();
    this.closeCameraStream();
    clearInterval(this.pushTimer);
    const client = this.client;
    this.client = null;
    if (client) await new Promise((resolve) => client.end(true, {}, resolve));
  }

  async test() {
    const client = this.connectMqtt({ reconnect: false });
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(upstreamError('error.bambu_timeout')), 12000);
        client.on('connect', () => {
          client.subscribe(this.topicReport);
          client.publish(this.topicRequest, JSON.stringify({ pushing: { sequence_id: '0', command: 'pushall' } }));
        });
        client.on('message', (topic, payload) => {
          const data = safeParse(payload);
          if (!data?.print) return;
          clearTimeout(timer);
          resolve({ state: data.print.gcode_state ?? null, firmware: `Bambu ${this.model.label}` });
        });
        client.on('error', (error) => {
          clearTimeout(timer);
          reject(upstreamError('error.bambu_mqtt', { message: error.message }));
        });
      });
    } finally {
      client.end(true);
    }
  }

  request(payload) {
    if (!this.client?.connected) throw conflict('error.printer_offline');
    this.sequence += 1;
    const [section] = Object.keys(payload);
    const message = { [section]: { sequence_id: String(this.sequence), ...payload[section] } };
    this.client.publish(this.topicRequest, JSON.stringify(message));
    return { ok: true, sequence: this.sequence };
  }

  handleMessage(payload) {
    const data = safeParse(payload);
    if (!data) return;
    if (data.info?.command === 'get_version') {
      this.modules = Object.fromEntries((data.info.module ?? []).map((item) => [item.name, item.sw_ver]));
      const ota = this.modules.ota;
      if (ota) this.firmware = `Bambu ${this.model.label} ${ota}`;
    }
    if (!data.print) {
      if (this.firmware) this.update({ firmware: this.firmware });
      return;
    }
    mergeDeep(this.report, data.print);
    this.publish();
  }

  publish() {
    const report = this.report;
    const gcodeState = String(report.gcode_state ?? '').toUpperCase();
    const printError = Number(report.print_error ?? 0);
    const stateMap = {
      IDLE: 'idle',
      PREPARE: 'printing',
      RUNNING: 'printing',
      PAUSE: 'paused',
      FINISH: 'finished',
      SLICING: 'busy',
      INIT: 'busy',
      OFFLINE: 'offline',
    };
    let state = stateMap[gcodeState] ?? (gcodeState === 'FAILED' ? 'error' : 'idle');
    if (gcodeState === 'FAILED' && printError === CANCELLED_ERROR) state = 'cancelled';

    const stage = STAGES[Number(report.stg_cur)] ?? null;
    const preparing = gcodeState === 'PREPARE';
    // Máy chạy hiệu chỉnh bằng một file dựng sẵn: đó không phải lệnh in của người dùng nên không tính là job.
    const calibrating = String(report.gcode_file ?? '').includes(CALIBRATION_MARK) && ['printing', 'paused'].includes(state);
    const steps = Array.isArray(report.stg) ? report.stg.map((item) => Number(item)) : [];

    let message = null;
    if (state === 'error') message = printError ? `Print error 0x${printError.toString(16).toUpperCase()}` : 'Print failed';
    else if (calibrating) message = stage ?? 'Calibrating';
    else if (preparing) message = stage ?? 'Preparing';
    else if (state === 'paused' && stage) message = stage;

    const active = ['printing', 'paused'].includes(state) || gcodeState === 'FINISH';
    const startedAt = Number(report.gcode_start_time ?? 0);
    const file = report.subtask_name || report.gcode_file || null;
    const trays = [];
    const ams = (report.ams?.ams ?? []).map((unit) => {
      const unitTrays = (unit.tray ?? []).map((tray) => {
        const entry = {
          id: `${unit.id}-${tray.id}`,
          type: tray.tray_type || null,
          color: trayColor(tray.tray_color),
          remain: Number.isFinite(Number(tray.remain)) && Number(tray.remain) >= 0 ? Number(tray.remain) : null,
        };
        trays.push(entry);
        return entry;
      });
      return { id: Number(unit.id), humidity: unit.humidity ?? null, temp: unit.temp ?? null, trays: unitTrays };
    });
    const hms = (report.hms ?? []).map((item) => describeHms(hmsCode(item)));
    // Delta của firmware mới chỉ cập nhật nhiệt đích trong device.*, trường cấp trên chỉ có khi pushall.
    const nozzlePacked = packedTemp(mainExtruder(report)?.temp);
    const bedPacked = packedTemp(report.device?.bed?.info?.temp);
    const spool = (Array.isArray(report.vir_slot) ? report.vir_slot.find((item) => String(item.id) === String(VIRTUAL_TRAY_MAIN)) : null) ?? report.vt_tray;

    this.update({
      online: true,
      state,
      message,
      temps: {
        nozzle: temp(report.nozzle_temper ?? nozzlePacked?.actual, nozzlePacked?.target ?? report.nozzle_target_temper),
        bed: temp(report.bed_temper ?? bedPacked?.actual, bedPacked?.target ?? report.bed_target_temper),
        chamber: this.model.chamber ? temp(report.chamber_temper, null) : null,
      },
      job:
        file && active && !calibrating
          ? {
              file,
              // Suốt bước chuẩn bị máy vẫn giữ nguyên số liệu của bản in trước; tin vào đó là báo in xong nhầm.
              progress: preparing ? 0 : clampProgress(report.mc_percent ?? 0),
              elapsed: preparing || startedAt <= 0 ? null : Math.max(0, Math.round(Date.now() / 1000 - startedAt)),
              remaining: preparing || !Number.isFinite(Number(report.mc_remaining_time)) ? null : Number(report.mc_remaining_time) * 60,
              layer: preparing ? null : (report.layer_num ?? null),
              totalLayers: report.total_layer_num ?? null,
              stage: preparing ? 'preparing' : null,
            }
          : null,
      fanSpeed: fanPercent(report),
      speedFactor: report.spd_mag !== undefined ? Number(report.spd_mag) : null,
      light: Array.isArray(report.lights_report)
        ? report.lights_report.some((item) => item.node === 'chamber_light' && item.mode === 'on')
        : null,
      firmware: this.firmware ?? `Bambu ${this.model.label}`,
      extra: {
        ams,
        amsActiveTray: report.ams?.tray_now ?? null,
        externalSpool: spool ? { type: spool.tray_type || null, color: trayColor(spool.tray_color) } : null,
        wifi: report.wifi_signal ?? null,
        hms,
        nozzleDiameter: report.nozzle_diameter ?? null,
        calibration: calibrating
          ? {
              stage,
              step: steps.indexOf(Number(report.stg_cur)) + 1 || null,
              steps: steps.length || null,
              remaining: Number.isFinite(Number(report.stg_cd)) ? Number(report.stg_cd) : null,
            }
          : null,
      },
    });
  }

  async withFtp(action) {
    const client = new FtpClient(30000);
    try {
      await client.access({
        host: this.connection.host,
        port: 990,
        user: 'bblp',
        password: String(this.connection.accessCode),
        secure: 'implicit',
        secureOptions: { rejectUnauthorized: false },
      });
      return await action(client);
    } catch (error) {
      if (error.key) throw error;
      throw upstreamError('error.bambu_ftp', { message: error.message });
    } finally {
      client.close();
    }
  }

  async listFiles() {
    return this.withFtp(async (client) => {
      const entries = await client.list('/');
      return entries
        .filter((entry) => entry.isFile && fileFormat(entry.name))
        .map((entry) => ({
          name: entry.name,
          path: entry.name,
          size: entry.size ?? null,
          modifiedAt: entry.modifiedAt ? entry.modifiedAt.toISOString() : null,
          estimatedTime: null,
        }));
    });
  }

  async uploadFile({ path: filePath, remoteName, size, start, options, onProgress }) {
    await this.withFtp(async (client) => {
      client.trackProgress((info) => onProgress?.(info.bytes, size));
      await client.uploadFrom(filePath, `/${remoteName}`);
      client.trackProgress();
    });
    if (start) await this.startPrint(remoteName, options);
    return { remoteName, started: Boolean(start) };
  }

  async deleteFile(name) {
    await this.withFtp((client) => client.remove(`/${name}`));
    return { deleted: true };
  }

  /** `ams_exist_bits` là bit-mask các hệ AMS đang gắn; chưa có báo cáo thì trả null vì chưa biết. */
  get hasAms() {
    const bits = this.report.ams?.ams_exist_bits;
    return bits === undefined ? null : parseInt(String(bits), 16) > 0;
  }

  /** BambuStudio check_enable_np: firmware đời mới báo đủ bốn khối này và dùng bộ lệnh mới. */
  get newProtocol() {
    return ['cfg', 'fun', 'aux', 'stat'].every((key) => this.report[key] !== undefined);
  }

  get temperatureLimits() {
    return { nozzle: this.model.nozzleMax, bed: this.model.bedMax, chamber: this.model.chamberMax ?? 0 };
  }

  /** DevConfig đọc các cờ support_* từ bản tin trước, bảng tra resources/printers chỉ là giá trị dự phòng. */
  reportValue(key, fallback) {
    const value = this.report[key];
    return typeof value === typeof fallback ? value : fallback;
  }

  /** Bit PA/motor noise: giao thức mới đọc `fun`, cũ đọc `home_flag`, chưa có bản tin thì theo bảng tra. */
  reportBit(funBit, homeBit, fallback) {
    if (this.newProtocol) return flagBit(this.report.fun, funBit);
    if (this.report.home_flag !== undefined) return ((Number(this.report.home_flag) >> homeBit) & 1) === 1;
    return fallback;
  }

  /** SelectMachineDialog::update_option_opts: lựa chọn cân bàn và hiệu chỉnh lưu lượng mà máy cho phép. */
  get printChoices() {
    const flow = this.model.series !== 'p1' && this.reportBit(7, 16, this.model.flowCalibration);
    return {
      bedLeveling: choicesFor(Number(this.reportValue('support_bed_leveling', this.model.bedLeveling)), false),
      flowCalibration: flow ? choicesFor(1, this.reportValue('support_auto_flow_calibration', this.model.autoFlowCalibration)) : [],
    };
  }

  static printChoicesFor(connection) {
    const model = resolveBambuModel(connection);
    return {
      bedLeveling: choicesFor(model.bedLeveling, false),
      flowCalibration: model.flowCalibration && model.series !== 'p1' ? choicesFor(1, model.autoFlowCalibration) : [],
    };
  }

  /** ams_id của cuộn đang nằm trong đầu phun: giao thức mới đọc byte cao của extruder.snow, cũ đọc ams.tray_now. */
  get loadedAmsId() {
    if (this.newProtocol) {
      const snow = Number(mainExtruder(this.report)?.snow);
      return Number.isInteger(snow) && snow !== 0xffff ? (snow >> 8) & 0xff : VIRTUAL_TRAY_MAIN;
    }
    const trayNow = Number(this.report.ams?.tray_now);
    return this.hasAms && Number.isInteger(trayNow) && trayNow < 16 * 4 ? Math.floor(trayNow / 4) : VIRTUAL_TRAY_MAIN;
  }

  hasTray(index) {
    return (this.report.ams?.ams ?? []).some(
      (unit) => Number(unit.id) === Math.floor(index / 4) && (unit.tray ?? []).some((tray) => Number(tray.id) === index % 4),
    );
  }

  async startPrint(name, options = {}) {
    if (fileFormat(name) === '3mf') {
      const plate = Math.max(1, Number(options.plate) || 1);
      // Máy không gắn AMS mà vẫn bảo lấy nhựa từ khay AMS thì nó nằm mãi ở bước chuẩn bị, không báo lỗi gì.
      const useAms = options.useAms === undefined ? this.hasAms === true : Boolean(options.useAms) && this.hasAms !== false;
      const choices = this.printChoices;
      const leveling = printChoice(options.bedLeveling, choices.bedLeveling);
      const flow = printChoice(options.flowCalibration, choices.flowCalibration);
      return this.request({
        print: {
          command: 'project_file',
          param: `Metadata/plate_${plate}.gcode`,
          url: `file:///sdcard/${name}`,
          subtask_name: name.replace(/\.gcode\.3mf$|\.3mf$/i, ''),
          md5: '',
          bed_type: 'auto',
          timelapse: Boolean(options.timelapse),
          // SelectMachineDialog::set_print_config: firmware đời mới đọc số nguyên 0/1/2 (tắt/bật/tự động),
          // cờ bool chỉ còn để máy đời cũ đọc. Chỉ gửi cờ bool thì A2L bỏ qua và tự quyết.
          bed_leveling: leveling === 1,
          auto_bed_leveling: leveling,
          flow_cali: flow === 1,
          extrude_cali_flag: flow,
          // BambuStudio luôn gửi false và không cho người dùng chọn, bù rung do firmware tự quyết.
          vibration_cali: false,
          layer_inspect: true,
          nozzle_offset_cali: 2,
          cfg: '0',
          use_ams: useAms,
          ams_mapping: useAms ? (options.amsMapping ?? [0]) : '',
          profile_id: '0',
          project_id: '0',
          subtask_id: '0',
          task_id: '0',
        },
      });
    }
    return this.request({ print: { command: 'gcode_file', param: `/sdcard/${name}` } });
  }

  async pause() {
    return this.request({ print: { command: 'pause' } });
  }

  async resume() {
    return this.request({ print: { command: 'resume' } });
  }

  async cancel() {
    return this.request({ print: { command: 'stop' } });
  }

  async sendGcode(lines) {
    return this.request({ print: { command: 'gcode_line', param: `${lines.join('\n')}\n` } });
  }

  /** Nhiệt vòi qua M104 như command_set_nozzle; bàn và buồng dùng lệnh MQTT khi firmware có (command_set_bed, set_ctt). */
  async setTemperature(heater, target) {
    const value = Math.round(target);
    if (heater === 'bed') {
      if (flagBit(this.report.fun, 39)) return this.request({ print: { command: 'set_bed_temp', temp: value } });
      return this.sendGcode([`M140 S${value}`]);
    }
    if (heater === 'chamber') {
      if (!this.model.chamberMax) this.fail('temperature');
      return this.request({ print: { command: 'set_ctt', ctt_val: value } });
    }
    return this.sendGcode([`M104 S${value}`]);
  }

  /** DevAxis::Ctrl_GoHome: máy Bambu luôn về gốc cả ba trục, không có lệnh về gốc riêng từng trục. */
  async home() {
    const result = flagBit(this.report.fun, 32) ? this.request({ print: { command: 'back_to_center' } }) : await this.sendGcode(['G28']);
    return { ...result, axes: ['x', 'y', 'z'] };
  }

  /**
   * DevAxis::Ctrl_Axis. Bước đúng 1 hoặc 10 mm dùng xyz_ctrl khi firmware có, bước khác gửi nguyên khối G-code của
   * BambuStudio (bật giới hạn mềm, đi tương đối rồi trả chế độ toạ độ). Dấu gửi xuống luôn là dấu toạ độ; BambuStudio
   * chỉ đảo Y, Z trên máy i3 để khớp nút trên giao diện của nó.
   */
  async jog({ x, y, z, feedrate }) {
    const moves = [['X', x], ['Y', y], ['Z', z]]
      .map(([axis, value]) => [axis, Math.round(Number(value) * 10) / 10])
      .filter(([, value]) => Number.isFinite(value) && value !== 0);
    // home_flag bit 0..2 là X, Y, Z đã về gốc; bằng 0 nghĩa là máy không báo, BambuStudio coi như đã về gốc.
    const homeFlag = Number(this.report.home_flag ?? 0);
    const unhomed = moves.filter(([axis]) => homeFlag !== 0 && ((homeFlag >> 'XYZ'.indexOf(axis)) & 1) === 0).map(([axis]) => axis);
    if (unhomed.length > 0) throw conflict('error.bambu_axis_not_homed', { axes: unhomed.join(', ') });

    for (const [axis, value] of moves) {
      const distance = Math.abs(value);
      if (flagBit(this.report.fun, 38) && (distance === 1 || distance === 10)) {
        this.request({ print: { command: 'xyz_ctrl', axis, dir: value > 0 ? 1 : -1, mode: distance >= 10 ? 1 : 0 } });
        continue;
      }
      const speed = Math.min(Number(feedrate) || JOG_SPEED[axis], JOG_SPEED[axis]);
      await this.sendGcode(['M211 S', 'M211 X1 Y1 Z1', 'M1002 push_ref_mode', 'G91', `G1 ${axis}${value.toFixed(1)} F${speed}`, 'M1002 pop_ref_mode', 'M211 R']);
    }
    return { ok: true, moves: Object.fromEntries(moves.map(([axis, value]) => [axis.toLowerCase(), value])) };
  }

  /**
   * MachineObject::command_ams_change_filament: luôn gửi ams_id và slot_id; target là ams_id*4+slot với AMS thường,
   * bằng ams_id với cuộn ngoài; rút nhựa thì target và slot_id đều là 255.
   */
  changeFilament({ load, amsId, slotId, temperature }) {
    const value = Math.round(temperature);
    const tray = amsId < 16 ? amsId * 4 + slotId : 0;
    return this.request({
      print: {
        command: 'ams_change_filament',
        ams_id: amsId,
        target: load ? (tray === 0 ? amsId : tray) : UNLOAD_SLOT,
        slot_id: load ? slotId : UNLOAD_SLOT,
        curr_temp: value,
        tar_temp: value,
      },
    });
  }

  /** `slot` là số khay chung ams*4+ngăn như trong ams.tray_now, 254 là cuộn ngoài. */
  async loadFilament({ temperature = FILAMENT_DEFAULTS.temperature, slot } = {}) {
    const index = slot === undefined || slot === null ? VIRTUAL_TRAY_LEGACY : Number(slot);
    if (index === VIRTUAL_TRAY_LEGACY) {
      const amsId = this.newProtocol ? VIRTUAL_TRAY_MAIN : VIRTUAL_TRAY_LEGACY;
      return { ...this.changeFilament({ load: true, amsId, slotId: 0, temperature }), slot: index };
    }
    // Khay không có thật mà vẫn gửi thì máy không gắn AMS cứ đứng chờ ở bước nạp nhựa.
    if (!Number.isInteger(index) || !this.hasTray(index)) throw badRequest('error.field_invalid', { field: 'slot' });
    return { ...this.changeFilament({ load: true, amsId: Math.floor(index / 4), slotId: index % 4, temperature }), slot: index };
  }

  async unloadFilament({ temperature = FILAMENT_DEFAULTS.temperature } = {}) {
    return this.changeFilament({ load: false, amsId: this.loadedAmsId, slotId: UNLOAD_SLOT, temperature });
  }

  /** Giao thức mới có airduct thì dùng set_fan theo bậc 10%, còn lại M106 P1 như FanControlNew::command_control_fan. */
  async setFan(percent) {
    const clamped = Math.max(0, Math.min(100, percent));
    if (this.newProtocol && coolingFanPart(this.report)) {
      const speed = Math.round(clamped / 10) * 10;
      return { ...this.request({ print: { command: 'set_fan', fan_index: COOLING_FAN, speed } }), percent: speed };
    }
    return this.sendGcode([`M106 P${COOLING_FAN} S${Math.round((clamped / 100) * 255)}`]);
  }

  async setSpeed(percent) {
    const target = SPEED_LEVELS.reduce((best, item) =>
      Math.abs(item.percent - percent) < Math.abs(best.percent - percent) ? item : best,
    );
    return { ...this.request({ print: { command: 'print_speed', param: String(target.level) } }), level: target.level, percent: target.percent };
  }

  /** DevLamp::CtrlSetChamberLight gửi cho cả hai đèn, tham số lấy đúng giá trị mặc định trong DevLamp.h. */
  async setLight(on) {
    const payload = { command: 'ledctrl', led_mode: on ? 'on' : 'off', led_on_time: 500, led_off_time: 500, loop_times: 1, interval_time: 1000 };
    this.request({ system: { ...payload, led_node: 'chamber_light' } });
    return this.request({ system: { ...payload, led_node: 'chamber_light2' } });
  }

  /** CalibrationDialog::update_cali: cân bàn và motor noise theo bản tin của máy, các hạng mục khác theo bảng tra. */
  get calibrations() {
    const list = new Set(this.model.calibrations);
    if (Number(this.reportValue('support_bed_leveling', this.model.bedLeveling)) === 0) list.delete('bedLeveling');
    if (this.reportBit(10, 21, list.has('motorNoise'))) list.add('motorNoise');
    else list.delete('motorNoise');
    return CALIBRATION_ORDER.filter((item) => list.has(item));
  }

  /** Firmware X1 đời đầu chưa có lệnh `calibration`, chỉ chạy được đúng file hiệu chỉnh dựng sẵn. */
  supportsCalibrationCommand() {
    if (!X1_SERIES.has(this.model.value)) return true;
    const version = this.modules?.rv1126;
    return !version || version >= X1_CALIBRATION_FIRMWARE;
  }

  async calibrate(options) {
    if (!this.supportsCalibrationCommand()) {
      return { ...this.request({ print: { command: 'gcode_file', param: CALIBRATION_GCODE } }), options, legacy: true };
    }
    const option = options.reduce((mask, item) => mask | (CALIBRATION_BITS[item] ?? 0), 0);
    return { ...this.request({ print: { command: 'calibration', option } }), options, option };
  }

  /** Bambu không nhận M112 qua MQTT: dừng lệnh in và tắt gia nhiệt là cách dừng khẩn gần nhất. */
  async emergencyStop() {
    if (['printing', 'paused'].includes(this.status.state)) this.request({ print: { command: 'stop' } });
    await this.setTemperature('nozzle', 0);
    return this.setTemperature('bed', 0);
  }

  /** Nhiều tab cùng xem thì dùng chung một socket camera, máy Bambu chỉ cho vài kết nối cùng lúc. */
  subscribeCamera(listener) {
    if (!this.capabilities.cameraStream) this.fail('cameraStream');
    this.cameraClients.add(listener);
    if (this.lastFrame) setImmediate(() => this.cameraClients.has(listener) && listener(this.lastFrame));
    this.openCameraStream();
    return () => {
      this.cameraClients.delete(listener);
      if (this.cameraClients.size === 0) this.closeCameraStream();
    };
  }

  openCameraStream() {
    if (this.cameraSocket || this.cameraClients.size === 0) return;
    const socket = cameraSocket(this.connection.host, this.connection.accessCode, {
      onFrame: (frame) => {
        this.lastFrame = frame;
        for (const listener of this.cameraClients) listener(frame);
      },
      onClose: () => {
        if (this.cameraSocket !== socket) return;
        this.cameraSocket = null;
        // Máy chốt kết nối camera khá thường xuyên, còn người xem thì nối lại chứ không bỏ luồng.
        if (this.cameraClients.size === 0) return;
        this.cameraRetry = setTimeout(() => {
          this.cameraRetry = null;
          this.openCameraStream();
        }, 2000);
        this.cameraRetry.unref?.();
      },
    });
    this.cameraSocket = socket;
  }

  closeCameraStream() {
    clearTimeout(this.cameraRetry);
    this.cameraRetry = null;
    this.lastFrame = null;
    const socket = this.cameraSocket;
    this.cameraSocket = null;
    socket?.destroy();
  }

  async snapshot() {
    if (this.connection.cameraUrl) return super.snapshot();
    if (this.model.camera === 'rtsp') return rtspSnapshot(this.connection.host, this.connection.accessCode);
    return jpegSnapshot(this.connection.host, this.connection.accessCode);
  }
}

function safeParse(payload) {
  try {
    return JSON.parse(String(payload));
  } catch {
    return null;
  }
}

const CAMERA_FRAME_LIMIT = 8 * 1024 * 1024;
const CAMERA_IDLE_MS = 15000;

/**
 * Camera P1, A1, A2L: gói xác thực 80 byte, sau đó máy đẩy liên tục, mỗi khung là header 16 byte + JPEG.
 * `onFrame` được gọi cho từng khung nên dùng được cho cả ảnh chụp lẫn luồng trực tiếp.
 */
function cameraSocket(host, accessCode, { onFrame, onClose, onError } = {}) {
  const auth = Buffer.alloc(80);
  auth.writeUInt32LE(0x40, 0);
  auth.writeUInt32LE(0x3000, 4);
  auth.write('bblp', 16, 'ascii');
  auth.write(String(accessCode), 48, 'ascii');
  let buffer = Buffer.alloc(0);
  const socket = tls.connect({ host, port: 6000, rejectUnauthorized: false }, () => socket.write(auth));
  // Máy im lặng thì socket cứ treo, tự cắt để lớp trên nối lại thay vì chờ vô hạn.
  socket.setTimeout(CAMERA_IDLE_MS, () => socket.destroy(upstreamError('error.camera_failed', { detail: 'timeout' })));
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 16) return;
      const size = buffer.readUInt32LE(0);
      if (size <= 0 || size > CAMERA_FRAME_LIMIT) {
        socket.destroy(upstreamError('error.camera_failed', { detail: 'invalid frame' }));
        return;
      }
      if (buffer.length < 16 + size) return;
      const image = Buffer.from(buffer.subarray(16, 16 + size));
      buffer = buffer.subarray(16 + size);
      if (image[0] !== 0xff || image[1] !== 0xd8) {
        socket.destroy(upstreamError('error.camera_failed', { detail: 'invalid frame' }));
        return;
      }
      onFrame?.(image);
    }
  });
  socket.on('error', (error) => onError?.(error));
  socket.on('close', () => onClose?.());
  return socket;
}

function jpegSnapshot(host, accessCode) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = cameraSocket(host, accessCode, {
      onFrame: (image) => {
        settled = true;
        socket.destroy();
        resolve({ buffer: image, mime: 'image/jpeg' });
      },
      onError: (error) => {
        if (settled) return;
        settled = true;
        reject(error.key ? error : upstreamError('error.camera_failed', { detail: error.message }));
      },
      onClose: () => {
        if (settled) return;
        settled = true;
        reject(upstreamError('error.camera_failed', { detail: 'no frame' }));
      },
    });
  });
}

function rtspSnapshot(host, accessCode) {
  return new Promise((resolve, reject) => {
    const url = `rtsps://bblp:${encodeURIComponent(accessCode)}@${host}:322/streaming/live/1`;
    const child = spawn(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', url, '-frames:v', '1', '-f', 'image2', '-vcodec', 'mjpeg', 'pipe:1'],
      { windowsHide: true },
    );
    const chunks = [];
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(
        error.code === 'ENOENT'
          ? upstreamError('error.ffmpeg_missing')
          : upstreamError('error.camera_failed', { detail: error.message }),
      );
    });
    child.on('close', () => {
      clearTimeout(timer);
      const buffer = Buffer.concat(chunks);
      if (buffer.length > 0) resolve({ buffer, mime: 'image/jpeg' });
      else reject(upstreamError('error.camera_failed', { detail: stderr.trim().slice(0, 200) || 'no frame' }));
    });
  });
}
