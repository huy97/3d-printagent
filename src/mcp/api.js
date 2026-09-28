import * as printers from '../core/printers.js';
import * as jobs from '../core/jobs.js';
import * as library from '../core/library.js';
import * as slicer from '../core/slicer.js';
import * as slicechat from '../core/slicechat.js';
import * as insights from '../core/insights.js';
import * as filament from '../core/filament.js';
import { describeDrivers } from '../drivers/index.js';
import { detectPrinter, discoverPrinters } from '../core/discovery.js';
import { getConfig } from '../core/config.js';
import { getTunnelStatus } from '../core/tunnel.js';
import { historyRange } from '../server/routes/helpers.js';
import { AppError } from '../util/errors.js';
import { t } from '../i18n/index.js';

const ORIGIN = 'mcp';

/** Rebuilds a remote agent error so its i18n key survives the hop; unknown keys fall back to the raw text. */
function remoteError(status, body) {
  const remote = body?.error ?? {};
  const known = typeof remote.key === 'string' && t(remote.key) !== remote.key;
  return new AppError(known ? remote.key : 'error.request_failed', {
    status,
    code: remote.code ?? 'remote_error',
    params: known ? remote.params : { message: remote.message ?? `HTTP ${status}` },
    details: body ?? undefined,
  });
}

/** One function set for MCP: calls core directly when running inside the agent, or REST when running over stdio. */
export function createLocalApi() {
  return {
    mode: 'local',
    status: async () => ({
      agent: getConfig().agent,
      printers: printers.listPrinters().map(({ id, name, driverLabel, enabled, bedClear, status }) => ({
        id,
        name,
        driver: driverLabel,
        enabled,
        bedClear,
        state: status.state,
        online: status.online,
        job: status.job,
      })),
      queue: jobs.stats(),
      library: library.librarySummary(),
      tunnel: { status: getTunnelStatus().status, url: getTunnelStatus().url },
    }),
    listDrivers: async () => ({ drivers: describeDrivers() }),
    listPrinters: async () => ({ printers: printers.listPrinters() }),
    getPrinter: async ({ printerId }) => printers.getPrinter(printerId),
    addPrinter: async ({ skipTest, ...input }) => {
      const test = skipTest ? null : await printers.testConnection(input);
      return { printer: printers.addPrinter(input), test };
    },
    removePrinter: ({ printerId }) => printers.removePrinter(printerId),
    detectPrinter: ({ host, port }) => detectPrinter(host, { port }),
    discoverPrinters: async ({ timeoutMs }) => ({ found: await discoverPrinters({ timeoutMs }) }),
    listFiles: async (input = {}) => ({ files: library.listFiles(input) }),
    uploadFile: (input) => library.addFile({ ...input, origin: ORIGIN }),
    deleteFile: async ({ fileId }) => library.deleteFile(fileId),
    listPrinterFiles: async ({ printerId }) => ({ files: await printers.listPrinterFiles(printerId) }),
    printFile: (input) => jobs.createJob({ ...input, origin: ORIGIN }),
    printBatch: (input) => jobs.createBatch({ ...input, origin: ORIGIN }),
    cancelBatch: ({ batchId, force }) => jobs.cancelBatch(batchId, { force }),
    listJobs: async (input = {}) => ({ jobs: jobs.listJobs(input), stats: jobs.stats() }),
    getJob: async ({ jobId }) => jobs.getJob(jobId),
    printerHistory: async ({ printerId, ...query }) => printers.getHistory(printerId, historyRange(query)),
    jobHistory: async ({ jobId, points }) => jobs.getJobHistory(jobId, { maxPoints: points }),
    startJob: async ({ jobId, confirmBedClear, printerId }) => jobs.startJob(jobId, { confirmBedClear, printerId }),
    reorderJob: async ({ jobId, direction, priority }) => {
      if (priority !== undefined) jobs.updateQueuedJob(jobId, { priority });
      return direction ? jobs.moveJob(jobId, direction) : jobs.getJob(jobId);
    },
    printStats: async ({ days, printerId }) => insights.printStats({ days, printerId }),
    listSpools: async ({ printerId }) => ({ spools: filament.listSpools({ printerId }), costs: filament.costSettings() }),
    saveSpool: async ({ spoolId, ...input }) => filament.saveSpool({ ...input, id: spoolId }),
    deleteSpool: async ({ spoolId }) => filament.deleteSpool(spoolId),
    preflight: async ({ printerId, ...input }) => {
      const matching = printerId ? null : jobs.matchingPrinters(input.fileId, { plate: input.plate });
      return { ...filament.preflight({ ...input, printerId: printerId || matching?.[0] }), matchingPrinters: matching };
    },
    orientModel: async ({ fileId }) => library.orientFile(fileId),
    combineModels: async ({ items, printerId, autoRotate }) =>
      library.combineFiles(items, slicer.machineBed({ printerId }), { autoRotate: autoRotate === true }),
    listMaintenance: async ({ printerId }) => insights.listMaintenance(printerId),
    completeMaintenance: async ({ printerId, taskId }) => insights.completeMaintenance(printerId, taskId),
    cancelJob: ({ jobId, force }) => jobs.cancelJob(jobId, { force }),
    command: ({ printerId, action, params }) => printers.command(printerId, action, params ?? {}, { origin: ORIGIN }),
    markBedCleared: async ({ printerId }) => printers.setBedClear(printerId, true),
    sliceProfiles: async ({ printerId, machine }) => slicer.listProfiles({ printerId, machine }),
    sliceOptions: async () => ({ options: slicer.optionSpecs() }),
    profileSettings: async ({ keys, search, ...selection }) => slicer.profileSettings(selection, { keys, search }),
    sliceSettings: async ({ fileId }) => slicer.readSliceSettings(fileId),
    sliceHistory: async ({ fileId }) => slicechat.getChat(fileId),
    sliceFile: ({ options, ...input }) => slicechat.sliceAndRecord({ ...options, ...input, origin: ORIGIN }),
    listPresets: async () => ({ presets: slicechat.listPresets() }),
    savePreset: async (input) => slicechat.savePreset(input),
    deletePreset: async ({ presetId }) => slicechat.deletePreset(presetId),
    snapshot: async ({ printerId }) => {
      const image = await printers.snapshot(printerId);
      return { mime: image.mime, base64: image.buffer.toString('base64') };
    },
  };
}

const ACTION_PATHS = {
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
  loadFilament: 'load-filament',
  unloadFilament: 'unload-filament',
  emergencyStop: 'emergency-stop',
  connect: 'connect',
};

export function createRemoteApi({ baseUrl, apiKey }) {
  const root = baseUrl.replace(/\/$/, '');
  const headers = apiKey ? { 'x-api-key': apiKey } : {};

  async function call(method, path, body, query) {
    const url = new URL(`${root}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const response = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    if (!response.ok) {
      throw remoteError(response.status, parsed);
    }
    return parsed;
  }

  const id = (value) => encodeURIComponent(value);

  return {
    mode: 'remote',
    baseUrl: root,
    status: () => call('GET', '/api/health'),
    listDrivers: () => call('GET', '/api/drivers'),
    listPrinters: () => call('GET', '/api/printers'),
    getPrinter: ({ printerId }) => call('GET', `/api/printers/${id(printerId)}`),
    addPrinter: async ({ skipTest, ...input }) => {
      const test = skipTest ? null : await call('POST', '/api/printers/test', input);
      return { printer: await call('POST', '/api/printers', input), test };
    },
    removePrinter: ({ printerId }) => call('DELETE', `/api/printers/${id(printerId)}`),
    detectPrinter: (input) => call('POST', '/api/printers/detect', input),
    discoverPrinters: ({ timeoutMs }) => call('GET', '/api/printers/discover', null, { timeout: timeoutMs }),
    listFiles: (input = {}) => call('GET', '/api/files', null, input),
    uploadFile: (input) => call('POST', '/api/files', input),
    deleteFile: ({ fileId }) => call('DELETE', `/api/files/${id(fileId)}`),
    listPrinterFiles: ({ printerId }) => call('GET', `/api/printers/${id(printerId)}/files`),
    printFile: (input) => call('POST', '/api/jobs', input),
    printBatch: (input) => call('POST', '/api/jobs/batch', input),
    cancelBatch: ({ batchId, force }) => call('POST', `/api/jobs/batch/${id(batchId)}/cancel`, { force }),
    listJobs: (input = {}) => call('GET', '/api/jobs', null, input),
    getJob: ({ jobId }) => call('GET', `/api/jobs/${id(jobId)}`),
    printerHistory: ({ printerId, ...query }) => call('GET', `/api/printers/${id(printerId)}/history`, null, query),
    jobHistory: ({ jobId, points }) => call('GET', `/api/jobs/${id(jobId)}/history`, null, { points }),
    startJob: ({ jobId, confirmBedClear, printerId }) => call('POST', `/api/jobs/${id(jobId)}/start`, { confirmBedClear, printerId }),
    reorderJob: async ({ jobId, direction, priority }) => {
      if (priority !== undefined) await call('PUT', `/api/jobs/${id(jobId)}`, { priority });
      return direction ? call('POST', `/api/jobs/${id(jobId)}/move`, { direction }) : call('GET', `/api/jobs/${id(jobId)}`);
    },
    printStats: ({ days, printerId }) => call('GET', '/api/stats', null, { days, printerId }),
    listSpools: ({ printerId }) => call('GET', '/api/spools', null, { printerId }),
    saveSpool: ({ spoolId, ...input }) => (spoolId ? call('PUT', `/api/spools/${id(spoolId)}`, input) : call('POST', '/api/spools', input)),
    deleteSpool: ({ spoolId }) => call('DELETE', `/api/spools/${id(spoolId)}`),
    preflight: (input) => call('POST', '/api/preflight', input),
    orientModel: ({ fileId }) => call('POST', `/api/files/${id(fileId)}/orient`),
    combineModels: (input) => call('POST', '/api/files/combine', input),
    listMaintenance: ({ printerId }) => call('GET', `/api/printers/${id(printerId)}/maintenance`),
    completeMaintenance: ({ printerId, taskId }) => call('POST', `/api/printers/${id(printerId)}/maintenance/${id(taskId)}/done`),
    cancelJob: ({ jobId, force }) => call('POST', `/api/jobs/${id(jobId)}/cancel`, { force }),
    command: ({ printerId, action, params }) =>
      call('POST', `/api/printers/${id(printerId)}/${ACTION_PATHS[action] ?? action}`, params ?? {}),
    markBedCleared: ({ printerId }) => call('POST', `/api/printers/${id(printerId)}/bed-cleared`, { clear: true }),
    sliceProfiles: ({ printerId, machine }) => call('GET', '/api/slicer/profiles', null, { printerId, machine }),
    sliceOptions: () => call('GET', '/api/slicer/options'),
    profileSettings: ({ keys, ...query }) => call('GET', '/api/slicer/profile-settings', null, { ...query, keys: keys?.join(',') }),
    sliceSettings: ({ fileId }) => call('GET', `/api/slicer/settings/${id(fileId)}`),
    sliceHistory: ({ fileId }) => call('GET', `/api/slicer/chat/${id(fileId)}`),
    sliceFile: ({ options, ...input }) => call('POST', '/api/slicer', { ...options, ...input }),
    listPresets: async () => ({ presets: await call('GET', '/api/slicer/presets') }),
    savePreset: (input) => call('POST', '/api/slicer/presets', input),
    deletePreset: ({ presetId }) => call('DELETE', `/api/slicer/presets/${id(presetId)}`),
    snapshot: async ({ printerId }) => {
      const response = await fetch(`${root}/api/printers/${id(printerId)}/snapshot`, { headers });
      if (!response.ok) {
        throw remoteError(response.status, await response.json().catch(() => null));
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      return { mime: response.headers.get('content-type') ?? 'image/jpeg', base64: buffer.toString('base64') };
    },
  };
}
