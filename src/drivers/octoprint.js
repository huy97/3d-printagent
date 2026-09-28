import { BaseDriver, clampProgress, temp } from './base.js';
import { buildBaseUrl, createHttpClient, HttpError, multipartBody } from './http.js';
import { badRequest } from '../util/errors.js';

function mapState(text, flags = {}) {
  const value = String(text ?? '').toLowerCase();
  if (flags.cancelling || value.includes('cancelling')) return 'busy';
  if (flags.pausing || flags.paused || value.includes('paus')) return 'paused';
  if (flags.printing || value.includes('printing') || value.includes('starting') || value.includes('finishing')) {
    return 'printing';
  }
  if (flags.error || value.includes('error')) return 'error';
  if (value.includes('offline') || value.includes('closed') || value.includes('detecting') || value.includes('connecting')) {
    return 'offline';
  }
  if (flags.ready || flags.operational || value.includes('operational')) return 'idle';
  return 'busy';
}

function flattenFiles(entries, out = []) {
  for (const entry of entries ?? []) {
    if (entry.type === 'folder') {
      flattenFiles(entry.children, out);
      continue;
    }
    if (entry.type !== 'machinecode') continue;
    out.push({
      name: entry.display ?? entry.name,
      path: entry.path ?? entry.name,
      size: entry.size ?? null,
      modifiedAt: entry.date ? new Date(entry.date * 1000).toISOString() : null,
      estimatedTime: entry.gcodeAnalysis?.estimatedPrintTime ? Math.round(entry.gcodeAnalysis.estimatedPrintTime) : null,
    });
  }
  return out;
}

export class OctoPrintDriver extends BaseDriver {
  static id = 'octoprint';
  static label = 'OctoPrint';
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
  static calibrations = ['bedLeveling'];
  static defaults = { port: null, https: false };
  static fields = [
    { key: 'host', type: 'text', required: true, placeholder: '192.168.1.50' },
    { key: 'port', type: 'number', placeholder: '80' },
    { key: 'apiKey', type: 'password', required: true, secret: true },
    { key: 'https', type: 'boolean' },
    { key: 'cameraUrl', type: 'text', placeholder: 'http://192.168.1.50/webcam/?action=snapshot', advanced: true },
  ];

  constructor(printer, context) {
    super(printer, context);
    const baseUrl = buildBaseUrl(this.connection);
    if (!baseUrl) throw badRequest('error.printer_host_required');
    this.client = createHttpClient({ baseUrl, headers: { 'x-api-key': this.connection.apiKey ?? '' } });
    this.snapshotUrl = undefined;
  }

  async test() {
    const version = await this.client.get('/api/version');
    return { firmware: version?.text ?? `OctoPrint ${version?.server ?? ''}`.trim() };
  }

  async poll() {
    if (!this.version) {
      const version = await this.client.get('/api/version');
      this.version = version?.text ?? `OctoPrint ${version?.server ?? ''}`.trim();
    }
    const job = await this.client.get('/api/job');
    const printerResponse = await this.client.request('/api/printer?exclude=sd', { allowStatus: [409] });
    const connected = printerResponse.status !== 409;
    const printer = connected ? printerResponse.body : null;
    const state = connected ? mapState(printer?.state?.text ?? job?.state, printer?.state?.flags) : 'offline';
    const temperature = printer?.temperature ?? {};
    const file = job?.job?.file?.display ?? job?.job?.file?.name ?? null;
    const active = ['printing', 'paused', 'busy'].includes(state);

    return {
      state,
      message: connected ? (state === 'error' ? (printer?.state?.error ?? job?.error ?? job?.state) : null) : { key: 'printer.message.octoprint_disconnected' },
      temps: {
        nozzle: temperature.tool0 ? temp(temperature.tool0.actual, temperature.tool0.target) : null,
        bed: temperature.bed ? temp(temperature.bed.actual, temperature.bed.target) : null,
        chamber: temperature.chamber ? temp(temperature.chamber.actual, temperature.chamber.target) : null,
      },
      job:
        file && (active || job?.progress?.completion)
          ? {
              file,
              progress: clampProgress(job.progress?.completion ?? 0),
              elapsed: job.progress?.printTime ?? null,
              remaining: job.progress?.printTimeLeft ?? null,
              layer: null,
              totalLayers: null,
            }
          : null,
      firmware: this.version,
    };
  }

  async connect() {
    await this.client.post('/api/connection', { command: 'connect', autoconnect: true });
    return { ok: true };
  }

  async listFiles() {
    const result = await this.client.get('/api/files/local?recursive=true');
    return flattenFiles(result?.files ?? result?.children ?? []);
  }

  async uploadFile({ path: filePath, remoteName, size, start, onProgress }) {
    const form = multipartBody({ select: start ? 'true' : 'false', print: start ? 'true' : 'false' }, {
      name: remoteName,
      path: filePath,
      size,
    });
    const response = await this.client.request('/api/files/local', {
      method: 'POST',
      headers: { 'content-type': form.contentType },
      body: form.body,
      timeoutMs: 120000,
      onUploadProgress: onProgress,
    });
    const stored = response.body?.files?.local?.path ?? remoteName;
    return { remoteName: stored, started: Boolean(start) };
  }

  async deleteFile(name) {
    await this.client.request(`/api/files/local/${encodePath(name)}`, { method: 'DELETE' });
    return { deleted: true };
  }

  async startPrint(name) {
    await this.client.post(`/api/files/local/${encodePath(name)}`, { command: 'select', print: true });
    return { started: true };
  }

  async pause() {
    await this.client.post('/api/job', { command: 'pause', action: 'pause' });
    return { ok: true };
  }

  async resume() {
    await this.client.post('/api/job', { command: 'pause', action: 'resume' });
    return { ok: true };
  }

  async cancel() {
    await this.client.post('/api/job', { command: 'cancel' });
    return { ok: true };
  }

  async sendGcode(lines) {
    await this.client.post('/api/printer/command', { commands: lines });
    return { ok: true };
  }

  /**
   * Marlin/RepRap firmware: home, then probe the mesh. Returns as soon as the commands are sent while
   * the printer is still probing, track the rest through status. The new mesh lives in RAM only, send `M500` to keep it.
   */
  async calibrate(options) {
    if (!options.includes('bedLeveling')) return { ok: true, options: [] };
    const lines = ['G28', 'G29'];
    await this.sendGcode(lines);
    return { ok: true, options, script: lines };
  }

  async cameraUrl() {
    if (this.snapshotUrl !== undefined) return this.snapshotUrl;
    try {
      const settings = await this.client.get('/api/settings');
      const configured = settings?.webcam?.snapshotUrl ?? settings?.webcam?.webcams?.[0]?.snapshotDisplay ?? null;
      this.snapshotUrl = configured ? resolveCameraUrl(configured, this.client.baseUrl) : `${this.client.baseUrl}/webcam/?action=snapshot`;
    } catch (error) {
      if (error instanceof HttpError) this.snapshotUrl = `${this.client.baseUrl}/webcam/?action=snapshot`;
      else throw error;
    }
    return this.snapshotUrl;
  }
}

function encodePath(name) {
  return String(name).split('/').map(encodeURIComponent).join('/');
}

/** Camera URLs configured on the Pi usually point at 127.0.0.1, rewrite them to the Pi address. */
export function resolveCameraUrl(value, baseUrl) {
  const resolved = new URL(value, `${baseUrl}/`);
  if (['127.0.0.1', 'localhost', '0.0.0.0'].includes(resolved.hostname)) {
    resolved.hostname = new URL(baseUrl).hostname;
  }
  return resolved.toString();
}
