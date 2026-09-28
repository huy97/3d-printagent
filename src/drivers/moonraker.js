import { BaseDriver, clampProgress, temp } from './base.js';
import { buildBaseUrl, createHttpClient, multipartBody } from './http.js';
import { resolveCameraUrl } from './octoprint.js';
import { badRequest } from '../util/errors.js';

const STATE_MAP = {
  standby: 'idle',
  printing: 'printing',
  paused: 'paused',
  complete: 'finished',
  cancelled: 'cancelled',
  error: 'error',
};

const CHAMBER_CANDIDATES = ['heater_generic chamber', 'temperature_sensor chamber', 'temperature_fan chamber'];

// A dense bed mesh probe can take ten minutes or more, far longer than a normal G-code command.
const CALIBRATION_TIMEOUT_MS = 20 * 60 * 1000;

export class MoonrakerDriver extends BaseDriver {
  static id = 'moonraker';
  static label = 'Klipper (Moonraker)';
  static formats = ['gcode'];
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
    filament: true,
    camera: true,
    emergencyStop: true,
    connect: true,
    calibrate: true,
  };
  static calibrations = ['bedLeveling', 'bedScrews'];
  static defaults = { port: null, https: false };
  static fields = [
    { key: 'host', type: 'text', required: true, placeholder: '192.168.1.60' },
    { key: 'port', type: 'number', placeholder: '7125' },
    { key: 'apiKey', type: 'password', secret: true },
    { key: 'https', type: 'boolean' },
    { key: 'cameraUrl', type: 'text', placeholder: 'http://192.168.1.60/webcam/?action=snapshot', advanced: true },
  ];

  constructor(printer, context) {
    super(printer, context);
    const baseUrl = buildBaseUrl(this.connection);
    if (!baseUrl) throw badRequest('error.printer_host_required');
    this.client = createHttpClient({
      baseUrl,
      headers: this.connection.apiKey ? { 'x-api-key': this.connection.apiKey } : {},
    });
    this.objects = null;
    this.chamber = null;
    this.fileMeta = { name: null, value: null };
    this.snapshotUrl = undefined;
  }

  async test() {
    const info = await this.client.get('/server/info');
    return { firmware: `Moonraker ${info?.result?.moonraker_version ?? ''}`.trim(), klippy: info?.result?.klippy_state ?? null };
  }

  async poll() {
    const server = (await this.client.get('/server/info'))?.result ?? {};
    if (server.klippy_state !== 'ready') {
      let message = server.klippy_state ?? 'disconnected';
      const printerInfo = await this.client.get('/printer/info').catch(() => null);
      if (printerInfo?.result?.state_message) message = printerInfo.result.state_message.trim();
      this.objects = null;
      return {
        state: server.klippy_state === 'startup' ? 'busy' : 'error',
        message: { key: 'printer.message.klipper', params: { message } },
        job: null,
      };
    }

    if (!this.objects) {
      const [list, info] = await Promise.all([
        this.client.get('/printer/objects/list'),
        this.client.get('/printer/info').catch(() => null),
      ]);
      this.objects = list?.result?.objects ?? [];
      this.chamber = CHAMBER_CANDIDATES.find((name) => this.objects.includes(name)) ?? null;
      this.firmware = info?.result?.software_version ? `Klipper ${info.result.software_version}` : 'Klipper';
    }

    const names = ['webhooks', 'print_stats', 'virtual_sdcard', 'display_status', 'heater_bed', 'extruder', 'toolhead', 'fan', 'gcode_move'];
    if (this.chamber) names.push(this.chamber);
    const query = names.filter((name) => this.objects.includes(name) || name === 'webhooks').map(encodeURIComponent).join('&');
    const status = (await this.client.get(`/printer/objects/query?${query}`))?.result?.status ?? {};

    const stats = status.print_stats ?? {};
    const state = STATE_MAP[stats.state] ?? 'busy';
    const active = ['printing', 'paused'].includes(state);
    const fileName = stats.filename || null;
    const meta = fileName ? await this.metadataFor(fileName) : null;

    const displayProgress = Number(status.display_status?.progress ?? 0);
    const fileProgress = Number(status.virtual_sdcard?.progress ?? 0);
    const fraction = displayProgress > 0 ? displayProgress : fileProgress;
    const duration = Number(stats.print_duration ?? 0);
    let remaining = null;
    if (active && fraction > 0.05) remaining = Math.max(0, Math.round(duration / fraction - duration));
    else if (active && meta?.estimated_time) remaining = Math.max(0, Math.round(meta.estimated_time - duration));

    let layer = stats.info?.current_layer ?? null;
    let totalLayers = stats.info?.total_layer ?? null;
    if (!totalLayers && meta?.layer_height && meta?.object_height) {
      totalLayers = Math.max(1, Math.round((meta.object_height - (meta.first_layer_height ?? meta.layer_height)) / meta.layer_height) + 1);
    }
    const z = status.toolhead?.position?.[2];
    if (!layer && totalLayers && Number.isFinite(z) && meta?.layer_height && active) {
      layer = Math.min(totalLayers, Math.max(1, Math.round((z - (meta.first_layer_height ?? meta.layer_height)) / meta.layer_height) + 1));
    }

    const position = status.toolhead?.position;
    const chamber = this.chamber ? status[this.chamber] : null;
    return {
      state,
      message: state === 'error' ? stats.message || { key: 'printer.message.klipper_error' } : status.display_status?.message || null,
      temps: {
        nozzle: status.extruder ? temp(status.extruder.temperature, status.extruder.target) : null,
        bed: status.heater_bed ? temp(status.heater_bed.temperature, status.heater_bed.target) : null,
        chamber: chamber ? temp(chamber.temperature, chamber.target) : null,
      },
      job: fileName
        ? {
            file: fileName,
            progress: clampProgress(fraction * 100),
            elapsed: Math.round(duration),
            remaining,
            layer,
            totalLayers,
          }
        : null,
      fanSpeed: status.fan ? Math.round(Number(status.fan.speed ?? 0) * 100) : null,
      speedFactor: status.gcode_move ? Math.round(Number(status.gcode_move.speed_factor ?? 1) * 100) : null,
      position: Array.isArray(position)
        ? { x: round(position[0]), y: round(position[1]), z: round(position[2]) }
        : null,
      firmware: this.firmware,
    };
  }

  async metadataFor(fileName) {
    if (this.fileMeta.name === fileName) return this.fileMeta.value;
    const result = await this.client.get(`/server/files/metadata?filename=${encodeURIComponent(fileName)}`).catch(() => null);
    this.fileMeta = { name: fileName, value: result?.result ?? null };
    return this.fileMeta.value;
  }

  async connect() {
    await this.client.post('/printer/firmware_restart');
    this.objects = null;
    return { ok: true };
  }

  async listFiles() {
    const result = await this.client.get('/server/files/list?root=gcodes');
    return (result?.result ?? []).map((file) => ({
      name: file.path,
      path: file.path,
      size: file.size ?? null,
      modifiedAt: file.modified ? new Date(file.modified * 1000).toISOString() : null,
      estimatedTime: null,
    }));
  }

  async uploadFile({ path: filePath, remoteName, size, start, onProgress }) {
    const form = multipartBody({ root: 'gcodes', print: start ? 'true' : 'false' }, { name: remoteName, path: filePath, size });
    const response = await this.client.request('/server/files/upload', {
      method: 'POST',
      headers: { 'content-type': form.contentType },
      body: form.body,
      timeoutMs: 120000,
      onUploadProgress: onProgress,
    });
    return {
      remoteName: response.body?.item?.path ?? remoteName,
      started: Boolean(response.body?.print_started ?? start),
    };
  }

  async deleteFile(name) {
    await this.client.request(`/server/files/gcodes/${String(name).split('/').map(encodeURIComponent).join('/')}`, {
      method: 'DELETE',
    });
    return { deleted: true };
  }

  async startPrint(name) {
    await this.client.post(`/printer/print/start?filename=${encodeURIComponent(name)}`);
    return { started: true };
  }

  async pause() {
    await this.client.post('/printer/print/pause');
    return { ok: true };
  }

  async resume() {
    await this.client.post('/printer/print/resume');
    return { ok: true };
  }

  async cancel() {
    await this.client.post('/printer/print/cancel');
    return { ok: true };
  }

  async sendGcode(lines) {
    // Moonraker only answers once the command finishes (G28 can take a full minute).
    const response = await this.client.request(`/printer/gcode/script?script=${encodeURIComponent(lines.join('\n'))}`, {
      method: 'POST',
      timeoutMs: 180000,
    });
    return { ok: true, responses: [response.body?.result ?? 'ok'] };
  }

  async emergencyStop() {
    await this.client.post('/printer/emergency_stop');
    return { ok: true };
  }

  /** Klipper can only level the bed when the matching config section exists, so query the object list. */
  get calibrations() {
    const has = (name) => (this.objects ?? []).includes(name);
    if (!this.objects) return MoonrakerDriver.calibrations;
    return MoonrakerDriver.calibrations.filter((item) =>
      item === 'bedLeveling' ? has('bed_mesh') : has('screws_tilt_adjust'),
    );
  }

  /**
   * Klipper bed leveling runs synchronously: Moonraker only answers when the macro is done, and a dense mesh is slow.
   * The new mesh lives in RAM, run `SAVE_CONFIG` to keep it across restarts.
   */
  async calibrate(options) {
    const script = ['G28'];
    if (options.includes('bedLeveling')) script.push('BED_MESH_CALIBRATE');
    if (options.includes('bedScrews')) script.push('SCREWS_TILT_CALCULATE');
    const response = await this.client.request(`/printer/gcode/script?script=${encodeURIComponent(script.join('\n'))}`, {
      method: 'POST',
      timeoutMs: CALIBRATION_TIMEOUT_MS,
    });
    return { ok: true, options, script, responses: [response.body?.result ?? 'ok'] };
  }

  /** Klipper has no M701/M702, users name their own macros so look them up in the object list. */
  findMacro(...names) {
    for (const name of names) {
      const needle = `gcode_macro ${name}`.toLowerCase();
      const found = (this.objects ?? []).find((item) => item.toLowerCase() === needle);
      if (found) return found.slice('gcode_macro '.length);
    }
    return null;
  }

  async loadFilament(options = {}) {
    const macro = this.findMacro('LOAD_FILAMENT', 'M701');
    return this.sendGcode(macro ? [...this.preheatGcode(options), macro] : this.filamentGcode('load', options));
  }

  async unloadFilament(options = {}) {
    const macro = this.findMacro('UNLOAD_FILAMENT', 'M702');
    return this.sendGcode(macro ? [...this.preheatGcode(options), macro] : this.filamentGcode('unload', options));
  }

  async cameraUrl() {
    if (this.snapshotUrl !== undefined) return this.snapshotUrl;
    const list = await this.client.get('/server/webcams/list').catch(() => null);
    const webcam = list?.result?.webcams?.find((item) => item.enabled !== false && item.snapshot_url);
    // Relative camera paths are served by nginx (port 80), not Moonraker's API port 7125.
    const web = new URL(this.client.baseUrl);
    if (web.port === '7125') web.port = '';
    const webBase = web.toString().replace(/\/$/, '');
    this.snapshotUrl = webcam ? resolveCameraUrl(webcam.snapshot_url, webBase) : `${webBase}/webcam/?action=snapshot`;
    return this.snapshotUrl;
  }
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}
