import { BaseDriver, clampProgress, temp } from './base.js';
import { buildBaseUrl, createHttpClient, fileBody } from './http.js';
import { badRequest, conflict } from '../util/errors.js';

const STATE_MAP = {
  IDLE: 'idle',
  READY: 'idle',
  BUSY: 'busy',
  PRINTING: 'printing',
  PAUSED: 'paused',
  FINISHED: 'finished',
  STOPPED: 'cancelled',
  ERROR: 'error',
  ATTENTION: 'paused',
};

/** PrusaLink API v1 (MK4, MK3.9, MK3.5, XL, MINI, Core One on firmware 5.x / 6.x). */
export class PrusaLinkDriver extends BaseDriver {
  static id = 'prusalink';
  static label = 'PrusaLink';
  static formats = ['gcode', 'bgcode'];
  static capabilities = {
    files: true,
    upload: true,
    start: true,
    pause: true,
    resume: true,
    cancel: true,
  };
  static defaults = { username: 'maker', https: false };
  static fields = [
    { key: 'host', type: 'text', required: true, placeholder: '192.168.1.70' },
    { key: 'port', type: 'number', placeholder: '80' },
    { key: 'username', type: 'text', default: 'maker' },
    { key: 'password', type: 'password', secret: true },
    { key: 'apiKey', type: 'password', secret: true, advanced: true },
    { key: 'https', type: 'boolean', advanced: true },
    { key: 'cameraUrl', type: 'text', placeholder: 'http://192.168.1.71/snapshot.jpg', advanced: true },
  ];

  constructor(printer, context) {
    super(printer, context);
    const baseUrl = buildBaseUrl(this.connection);
    if (!baseUrl) throw badRequest('error.printer_host_required');
    const useKey = Boolean(this.connection.apiKey);
    this.client = createHttpClient({
      baseUrl,
      headers: useKey ? { 'x-api-key': this.connection.apiKey } : {},
      digest: useKey ? null : { username: this.connection.username || 'maker', password: this.connection.password ?? '' },
    });
    this.jobId = null;
    this.jobFile = null;
    this.storage = null;
  }

  async test() {
    const info = await this.client.get('/api/version');
    return { firmware: `${info?.text ?? 'PrusaLink'} ${info?.firmware ?? ''}`.trim() };
  }

  async poll() {
    if (!this.firmware) {
      const version = await this.client.get('/api/version').catch(() => null);
      this.firmware = version ? `${version.text ?? 'PrusaLink'} ${version.firmware ?? ''}`.trim() : 'PrusaLink';
    }
    const status = await this.client.get('/api/v1/status');
    const printer = status?.printer ?? {};
    const job = status?.job ?? null;
    const state = STATE_MAP[printer.state] ?? 'busy';

    if (job?.id && job.id !== this.jobId) {
      const detail = await this.client.get('/api/v1/job').catch(() => null);
      this.jobId = job.id;
      this.jobFile = detail?.file?.display_name ?? detail?.file?.name ?? null;
    }
    if (!job) this.jobId = null;

    return {
      state,
      message: printer.state === 'ATTENTION' ? { key: 'printer.message.attention' } : state === 'error' ? { key: 'printer.message.printer_error' } : null,
      temps: {
        nozzle: temp(printer.temp_nozzle, printer.target_nozzle),
        bed: temp(printer.temp_bed, printer.target_bed),
        chamber: null,
      },
      job: job
        ? {
            file: this.jobFile,
            progress: clampProgress(job.progress),
            elapsed: job.time_printing ?? null,
            remaining: job.time_remaining ?? null,
            layer: null,
            totalLayers: null,
          }
        : null,
      speedFactor: Number.isFinite(printer.speed) ? printer.speed : null,
      position: Number.isFinite(printer.axis_z)
        ? { x: printer.axis_x ?? null, y: printer.axis_y ?? null, z: printer.axis_z }
        : null,
      firmware: this.firmware,
    };
  }

  async storagePath() {
    if (this.storage) return this.storage;
    const result = await this.client.get('/api/v1/storage');
    const target = (result?.storage_list ?? []).find((item) => item.available && !item.read_only);
    if (!target) throw conflict('error.printer_no_storage');
    this.storage = String(target.path ?? target.name).replace(/^\/+|\/+$/g, '');
    return this.storage;
  }

  async listFiles() {
    const storage = await this.storagePath();
    const result = await this.client.get(`/api/v1/files/${storage}`);
    return (result?.children ?? [])
      .filter((item) => item.type === 'PRINT_FILE')
      .map((item) => ({
        name: item.display_name ?? item.name,
        path: item.name,
        size: item.size ?? null,
        modifiedAt: item.m_timestamp ? new Date(item.m_timestamp * 1000).toISOString() : null,
        estimatedTime: null,
      }));
  }

  async uploadFile({ path: filePath, remoteName, size, start, onProgress }) {
    const storage = await this.storagePath();
    await this.client.prime('/api/v1/status');
    await this.client.request(`/api/v1/files/${storage}/${encodeURIComponent(remoteName)}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'print-after-upload': start ? '?1' : '?0',
        overwrite: '?1',
      },
      body: fileBody(filePath, size),
      timeoutMs: 120000,
      onUploadProgress: onProgress,
    });
    return { remoteName, started: Boolean(start) };
  }

  async deleteFile(name) {
    const storage = await this.storagePath();
    await this.client.request(`/api/v1/files/${storage}/${encodeURIComponent(name)}`, { method: 'DELETE' });
    return { deleted: true };
  }

  async startPrint(name) {
    const storage = await this.storagePath();
    await this.client.request(`/api/v1/files/${storage}/${encodeURIComponent(name)}`, { method: 'POST' });
    return { started: true };
  }

  requireJob() {
    if (!this.jobId) throw conflict('error.printer_not_printing');
    return this.jobId;
  }

  async pause() {
    await this.client.request(`/api/v1/job/${this.requireJob()}/pause`, { method: 'PUT' });
    return { ok: true };
  }

  async resume() {
    await this.client.request(`/api/v1/job/${this.requireJob()}/resume`, { method: 'PUT' });
    return { ok: true };
  }

  async cancel() {
    await this.client.request(`/api/v1/job/${this.requireJob()}`, { method: 'DELETE' });
    return { ok: true };
  }
}
