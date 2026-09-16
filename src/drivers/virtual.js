import { statSync } from 'node:fs';
import { BaseDriver, clampProgress, temp } from './base.js';
import { createCanvas } from '../util/png.js';
import { extractMetadata } from '../gcode/metadata.js';
import { conflict, notFound } from '../util/errors.js';

const BED = { x: 220, y: 220, z: 250 };
const AMBIENT = 24;

// Mỗi hạng mục hiệu chỉnh giả lập mất chừng này giây máy, đủ để thấy tiến trình chạy qua từng bước.
const CALIBRATION_STEP_SECONDS = 60;

function approach(current, target, rate) {
  const goal = target > 0 ? target : AMBIENT;
  const delta = goal - current;
  if (Math.abs(delta) <= rate) return goal + (target > 0 ? (Math.random() - 0.5) * 0.4 : 0);
  return current + Math.sign(delta) * rate;
}

/**
 * Máy in mô phỏng để thử toàn bộ luồng (upload, hàng đợi, điều khiển, camera) khi chưa có máy thật.
 * `simulationSpeed` là hệ số tua nhanh thời gian in.
 */
export class VirtualDriver extends BaseDriver {
  static id = 'virtual';
  static label = 'Virtual printer';
  static formats = ['gcode', 'bgcode', '3mf'];
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
    connect: true,
    calibrate: true,
  };
  static calibrations = ['bedLeveling', 'vibration', 'motorNoise'];
  static defaults = { model: 'Virtual i3', simulationSpeed: 30 };
  static fields = [
    { key: 'model', type: 'text', placeholder: 'Virtual i3' },
    { key: 'simulationSpeed', type: 'number', default: 30, min: 1, max: 1000 },
  ];

  constructor(printer, context) {
    super(printer, context);
    this.sim = {
      nozzle: { actual: AMBIENT, target: 0 },
      bed: { actual: AMBIENT, target: 0 },
      position: { x: 0, y: 0, z: 0 },
      relative: false,
      fan: 0,
      speed: 100,
      light: false,
      phase: 'idle',
      halted: false,
      job: null,
      calibration: null,
      files: new Map([
        [
          'calibration_cube.gcode',
          { name: 'calibration_cube.gcode', size: 482113, modifiedAt: new Date().toISOString(), estimatedTime: 1800, layers: 100, nozzleTemp: 210, bedTemp: 60 },
        ],
      ]),
    };
    this.interval = null;
  }

  async start() {
    this.running = true;
    this.update({ firmware: `Virtual firmware 1.0 (${this.connection.model})` });
    this.publish();
    this.interval = setInterval(() => this.step(1), 1000);
    this.interval.unref?.();
  }

  async stop() {
    this.running = false;
    clearInterval(this.interval);
  }

  async test() {
    return { state: 'idle', firmware: `Virtual firmware 1.0 (${this.connection.model})` };
  }

  get speedFactor() {
    return Math.max(1, Number(this.connection.simulationSpeed) || 30);
  }

  step(seconds) {
    const sim = this.sim;
    const boost = Math.max(1, this.speedFactor / 10);
    sim.nozzle.actual = approach(sim.nozzle.actual, sim.nozzle.target, (sim.nozzle.target > 0 ? 8 : 2) * boost);
    sim.bed.actual = approach(sim.bed.actual, sim.bed.target, (sim.bed.target > 0 ? 3 : 0.8) * boost);

    const job = sim.job;
    if (job && sim.phase === 'heating') {
      const ready = Math.abs(sim.nozzle.actual - sim.nozzle.target) < 3 && Math.abs(sim.bed.actual - sim.bed.target) < 2;
      if (ready) {
        sim.phase = 'printing';
        sim.fan = 100;
        job.startedAt = Date.now();
      }
    } else if (sim.calibration) {
      const run = sim.calibration;
      run.elapsed += seconds * this.speedFactor;
      run.step = Math.min(run.options.length, Math.floor(run.elapsed / CALIBRATION_STEP_SECONDS) + 1);
      if (run.elapsed >= run.options.length * CALIBRATION_STEP_SECONDS) {
        sim.calibration = null;
        sim.phase = 'idle';
      }
    } else if (job && sim.phase === 'printing') {
      job.elapsed += seconds * this.speedFactor * (sim.speed / 100);
      const fraction = Math.min(1, job.elapsed / job.total);
      sim.position = {
        x: Math.round(60 + Math.random() * 100),
        y: Math.round(60 + Math.random() * 100),
        z: Math.round(fraction * job.height * 100) / 100,
      };
      if (fraction >= 1) this.finish('finished');
    }
    this.publish();
  }

  finish(state) {
    const sim = this.sim;
    sim.phase = state;
    sim.calibration = null;
    sim.nozzle.target = 0;
    sim.bed.target = 0;
    sim.fan = 0;
    if (sim.job) sim.job.finishedAt = Date.now();
  }

  publish() {
    const sim = this.sim;
    const job = sim.job;
    const stateByPhase = {
      idle: 'idle',
      heating: 'printing',
      printing: 'printing',
      paused: 'paused',
      finished: 'finished',
      cancelled: 'cancelled',
    };
    let jobStatus = null;
    if (job) {
      const fraction = Math.min(1, job.elapsed / job.total);
      jobStatus = {
        file: job.file,
        progress: clampProgress(fraction * 100),
        elapsed: Math.round(job.elapsed),
        remaining: Math.max(0, Math.round((job.total - job.elapsed) / (sim.speed / 100))),
        layer: Math.max(sim.phase === 'heating' ? 0 : 1, Math.ceil(fraction * job.layers)),
        totalLayers: job.layers,
        stage: sim.phase === 'heating' ? 'heating' : null,
      };
    }
    const run = sim.calibration;
    this.update({
      online: true,
      state: sim.halted ? 'error' : stateByPhase[sim.phase],
      message: sim.halted ? 'Emergency stop (M112)' : run ? `Calibrating: ${run.options[run.step - 1]}` : null,
      temps: { nozzle: temp(sim.nozzle.actual, sim.nozzle.target), bed: temp(sim.bed.actual, sim.bed.target), chamber: null },
      job: jobStatus,
      fanSpeed: sim.fan,
      speedFactor: sim.speed,
      position: { ...sim.position },
      light: sim.light,
      extra: {
        calibration: run
          ? {
              stage: run.options[run.step - 1],
              step: run.step,
              steps: run.options.length,
              remaining: Math.max(0, Math.round(run.options.length * CALIBRATION_STEP_SECONDS - run.elapsed)),
            }
          : null,
      },
    });
  }

  async calibrate(options) {
    const sim = this.sim;
    sim.calibration = { options, step: 1, elapsed: 0 };
    sim.phase = 'printing';
    this.publish();
    return { ok: true, options };
  }

  async listFiles() {
    return [...this.sim.files.values()].map((file) => ({
      name: file.name,
      path: file.name,
      size: file.size,
      modifiedAt: file.modifiedAt,
      estimatedTime: file.estimatedTime,
    }));
  }

  async uploadFile({ path: filePath, remoteName, size, start, onProgress }) {
    const { meta } = extractMetadata(filePath, remoteName);
    const total = size ?? statSync(filePath).size;
    for (let sent = 0; sent < total; sent += Math.ceil(total / 5)) onProgress?.(sent, total);
    onProgress?.(total, total);
    this.sim.files.set(remoteName, {
      name: remoteName,
      size: total,
      modifiedAt: new Date().toISOString(),
      estimatedTime: meta.estimatedTime ?? Math.max(600, Math.round(total / 40)),
      layers: meta.layerCount ?? 100,
      height: meta.maxZ ?? null,
      nozzleTemp: meta.nozzleTemp ?? 210,
      bedTemp: meta.bedTemp ?? 60,
    });
    if (start) await this.startPrint(remoteName);
    return { remoteName, started: Boolean(start) };
  }

  async deleteFile(name) {
    if (this.sim.job?.file === name && ['heating', 'printing', 'paused'].includes(this.sim.phase)) {
      throw conflict('error.file_in_use', { name });
    }
    if (!this.sim.files.delete(name)) throw notFound('error.printer_file_not_found', { name });
    return { deleted: true };
  }

  async startPrint(name) {
    const sim = this.sim;
    const file = sim.files.get(name);
    if (!file) throw notFound('error.printer_file_not_found', { name });
    if (sim.halted) throw conflict('error.printer_halted');
    if (['heating', 'printing', 'paused'].includes(sim.phase)) throw conflict('error.printer_busy_printing');
    sim.job = {
      file: name,
      total: file.estimatedTime,
      layers: file.layers,
      height: file.height ?? Math.round(file.layers * 0.2 * 100) / 100,
      elapsed: 0,
      startedAt: null,
    };
    sim.phase = 'heating';
    sim.nozzle.target = file.nozzleTemp;
    sim.bed.target = file.bedTemp;
    this.publish();
    return { started: true };
  }

  async pause() {
    if (this.sim.phase !== 'printing' && this.sim.phase !== 'heating') throw conflict('error.printer_not_printing');
    this.sim.phase = 'paused';
    this.publish();
    return { ok: true };
  }

  async resume() {
    if (this.sim.phase !== 'paused') throw conflict('error.printer_not_paused');
    this.sim.phase = this.sim.job?.startedAt ? 'printing' : 'heating';
    this.publish();
    return { ok: true };
  }

  async cancel() {
    if (!['heating', 'printing', 'paused'].includes(this.sim.phase)) throw conflict('error.printer_not_printing');
    this.finish('cancelled');
    this.publish();
    return { ok: true };
  }

  async sendGcode(lines) {
    const sim = this.sim;
    const responses = [];
    for (const raw of lines) {
      const line = raw.split(';')[0].trim().toUpperCase();
      if (!line) continue;
      const [code, ...args] = line.split(/\s+/);
      const param = (letter) => {
        const found = args.find((item) => item.startsWith(letter));
        return found ? Number(found.slice(1)) : undefined;
      };
      if (sim.halted && code !== 'M999') {
        responses.push('!! Printer halted. M999 to restart');
        continue;
      }
      switch (code) {
        case 'M104':
        case 'M109':
          sim.nozzle.target = param('S') ?? 0;
          break;
        case 'M140':
        case 'M190':
          sim.bed.target = param('S') ?? 0;
          break;
        case 'M106':
          sim.fan = Math.round(((param('S') ?? 255) / 255) * 100);
          break;
        case 'M107':
          sim.fan = 0;
          break;
        case 'M220':
          sim.speed = Math.max(10, Math.min(300, param('S') ?? 100));
          break;
        case 'G28': {
          const axes = args.filter((item) => /^[XYZ]/.test(item)).map((item) => item[0].toLowerCase());
          for (const axis of axes.length ? axes : ['x', 'y', 'z']) sim.position[axis] = 0;
          break;
        }
        case 'G90':
          sim.relative = false;
          break;
        case 'G91':
          sim.relative = true;
          break;
        case 'G0':
        case 'G1':
          for (const axis of ['x', 'y', 'z']) {
            const value = param(axis.toUpperCase());
            if (value === undefined) continue;
            const next = sim.relative ? sim.position[axis] + value : value;
            sim.position[axis] = Math.round(Math.max(0, Math.min(BED[axis], next)) * 100) / 100;
          }
          break;
        case 'M112':
          sim.halted = true;
          if (sim.job && ['heating', 'printing', 'paused'].includes(sim.phase)) this.finish('cancelled');
          sim.nozzle.target = 0;
          sim.bed.target = 0;
          break;
        case 'M999':
          sim.halted = false;
          break;
        case 'M105':
          responses.push(`ok T:${sim.nozzle.actual.toFixed(1)} /${sim.nozzle.target} B:${sim.bed.actual.toFixed(1)} /${sim.bed.target}`);
          continue;
        case 'M114':
          responses.push(`X:${sim.position.x} Y:${sim.position.y} Z:${sim.position.z} E:0`);
          break;
        default:
          break;
      }
      responses.push('ok');
    }
    this.publish();
    return { ok: true, responses };
  }

  async setLight(on) {
    this.sim.light = Boolean(on);
    this.publish();
    return { ok: true };
  }

  async connect() {
    this.sim.halted = false;
    this.publish();
    return { ok: true };
  }

  async snapshot() {
    const sim = this.sim;
    const canvas = createCanvas(320, 240, sim.light ? [58, 62, 70] : [22, 24, 28]);
    canvas.rect(40, 200, 240, 10, [120, 124, 132]);
    const job = sim.job;
    if (job) {
      const fraction = Math.min(1, job.elapsed / job.total);
      const height = Math.round(fraction * 110);
      canvas.rect(110, 200 - height, 100, height, sim.phase === 'cancelled' ? [180, 70, 60] : [240, 130, 40]);
      canvas.rect(16, 16, 288, 8, [60, 64, 72]);
      canvas.rect(16, 16, Math.round(288 * fraction), 8, [110, 200, 140]);
    }
    const nozzleX = 40 + (sim.position.x / BED.x) * 240;
    const nozzleY = 200 - Math.min(150, (sim.position.z / BED.z) * 150) - 22;
    canvas.rect(nozzleX - 10, nozzleY - 16, 20, 16, [200, 200, 210]);
    canvas.rect(nozzleX - 3, nozzleY, 6, 6, sim.nozzle.actual > 150 ? [255, 80, 40] : [150, 150, 160]);
    return { buffer: canvas.toPng(), mime: 'image/png' };
  }
}
