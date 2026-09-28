import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { t } from '../i18n/index.js';
import { serializeError } from '../util/errors.js';
import { VERSION } from '../util/version.js';

function text(payload) {
  return {
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }],
  };
}

function failure(error) {
  const payload = serializeError(error);
  return {
    isError: true,
    content: [
      { type: 'text', text: t('mcp.error', { message: payload.message }) },
      { type: 'text', text: JSON.stringify({ error: payload }) },
    ],
  };
}

const arg = (name) => t(`mcp.arg.${name}`);
const printerId = () => z.string().describe(arg('printerId'));
const fileId = () => z.string().describe(arg('fileId'));
const settings = () => z.record(z.union([z.string(), z.number(), z.boolean()]));
const profiles = (required = true) => ({
  machine: required ? z.string().describe(arg('machine')) : z.string().optional().describe(arg('machine')),
  process: z.string().optional().describe(arg('process')),
  filament: z.string().optional().describe(arg('filament')),
});

/** Each tool: name, parameter schema, API call. Title and description come from the i18n catalog by name. */
function toolDefinitions() {
  return [
    ['agent_status', {}, (api) => api.status()],
    ['list_printers', {}, (api) => api.listPrinters()],
    ['get_printer_status', { printerId: printerId() }, (api, args) => api.getPrinter(args)],
    ['list_drivers', {}, (api) => api.listDrivers()],
    [
      'add_printer',
      {
        name: z.string().describe(arg('name')),
        driver: z.enum(['octoprint', 'moonraker', 'prusalink', 'bambu', 'virtual']).describe(arg('driver')),
        connection: z.record(z.union([z.string(), z.number(), z.boolean()])).describe(arg('connection')),
        skipTest: z.boolean().optional().describe(arg('skipTest')),
      },
      (api, args) => api.addPrinter(args),
    ],
    ['remove_printer', { printerId: printerId() }, (api, args) => api.removePrinter(args)],
    [
      'detect_printer',
      { host: z.string().describe(arg('host')), port: z.number().int().optional().describe(arg('port')) },
      (api, args) => api.detectPrinter(args),
    ],
    [
      'discover_printers',
      { timeoutMs: z.number().int().min(1000).max(30000).optional().describe(arg('timeoutMs')) },
      (api, args) => api.discoverPrinters(args),
    ],
    [
      'list_files',
      {
        search: z.string().optional().describe(arg('search')),
        format: z.enum(['gcode', 'bgcode', '3mf']).optional().describe(arg('format')),
      },
      (api, args) => api.listFiles(args),
    ],
    [
      'upload_file',
      {
        url: z.string().url().optional().describe(arg('url')),
        content: z.string().optional().describe(arg('content')),
        contentBase64: z.string().optional().describe(arg('contentBase64')),
        path: z.string().optional().describe(arg('path')),
        name: z.string().optional().describe(arg('fileName')),
      },
      (api, args) => api.uploadFile(args),
    ],
    ['delete_file', { fileId: z.string().describe(arg('fileId')) }, (api, args) => api.deleteFile(args)],
    ['list_printer_files', { printerId: printerId() }, (api, args) => api.listPrinterFiles(args)],
    [
      'print_file',
      {
        printerId: z.string().optional().describe(arg('printerIdOrAny')),
        printerIds: z.array(z.string()).optional().describe(arg('printerIds')),
        priority: z.number().int().min(-100).max(100).optional().describe(arg('priority')),
        fileId: z.string().describe(arg('fileId')),
        mode: z.enum(['now', 'queue']).optional().describe(arg('mode')),
        confirmBedClear: z.boolean().optional().describe(arg('confirmBedClear')),
        plate: z.number().int().min(1).optional().describe(arg('plate')),
        useAms: z.boolean().optional().describe(arg('useAms')),
        amsMapping: z.array(z.number().int()).optional().describe(arg('amsMapping')),
        timelapse: z.boolean().optional().describe(arg('timelapse')),
        bedLeveling: z.union([z.boolean(), z.literal('auto')]).optional().describe(arg('bedLeveling')),
        flowCalibration: z.union([z.boolean(), z.literal('auto')]).optional().describe(arg('flowCalibration')),
      },
      (api, args) => api.printFile(args),
    ],
    [
      'print_batch',
      {
        fileId: z.string().describe(arg('fileId')),
        printerIds: z.array(z.string()).optional().describe(arg('batchPrinterIds')),
        confirmBedClear: z.boolean().optional().describe(arg('confirmBedClear')),
        plate: z.number().int().min(1).optional().describe(arg('plate')),
        useAms: z.boolean().optional().describe(arg('useAms')),
        timelapse: z.boolean().optional().describe(arg('timelapse')),
      },
      (api, args) => api.printBatch(args),
    ],
    [
      'cancel_batch',
      { batchId: z.string().describe(arg('batchId')), force: z.boolean().optional().describe(arg('force')) },
      (api, args) => api.cancelBatch(args),
    ],
    [
      'list_jobs',
      {
        status: z.string().optional().describe(arg('status')),
        printerId: z.string().optional().describe(arg('printerId')),
        limit: z.number().int().min(1).max(500).optional().describe(arg('limit')),
      },
      (api, args) => api.listJobs(args),
    ],
    ['get_job', { jobId: z.string().describe(arg('jobId')) }, (api, args) => api.getJob(args)],
    [
      'get_printer_history',
      {
        printerId: printerId(),
        minutes: z.number().int().min(1).optional().describe(arg('minutes')),
        from: z.string().optional().describe(arg('from')),
        to: z.string().optional().describe(arg('to')),
        points: z.number().int().min(10).max(5000).optional().describe(arg('points')),
      },
      (api, args) => api.printerHistory(args),
    ],
    [
      'get_job_history',
      { jobId: z.string().describe(arg('jobId')), points: z.number().int().min(10).max(5000).optional().describe(arg('points')) },
      (api, args) => api.jobHistory(args),
    ],
    [
      'start_job',
      {
        jobId: z.string().describe(arg('jobId')),
        confirmBedClear: z.boolean().optional().describe(arg('confirmBedClear')),
        printerId: z.string().optional().describe(arg('startPrinterId')),
      },
      (api, args) => api.startJob(args),
    ],
    [
      'reorder_job',
      {
        jobId: z.string().describe(arg('jobId')),
        direction: z.enum(['up', 'down', 'top', 'bottom']).optional().describe(arg('direction')),
        priority: z.number().int().min(-100).max(100).optional().describe(arg('priority')),
      },
      (api, args) => api.reorderJob(args),
    ],
    [
      'get_print_stats',
      {
        days: z.number().int().min(1).max(365).optional().describe(arg('days')),
        printerId: z.string().optional().describe(arg('printerId')),
      },
      (api, args) => api.printStats(args),
    ],
    ['list_spools', { printerId: z.string().optional().describe(arg('printerId')) }, (api, args) => api.listSpools(args)],
    [
      'save_spool',
      {
        spoolId: z.string().optional().describe(arg('spoolId')),
        name: z.string().optional().describe(arg('spoolName')),
        material: z.string().optional().describe(arg('spoolMaterial')),
        color: z.string().optional().describe(arg('spoolColor')),
        brand: z.string().optional(),
        totalG: z.number().min(1).optional().describe(arg('spoolTotal')),
        remainingG: z.number().min(0).optional().describe(arg('spoolRemaining')),
        pricePerKg: z.number().min(0).optional().describe(arg('spoolPrice')),
        printerId: z.string().nullable().optional().describe(arg('spoolPrinter')),
        slot: z.number().int().min(0).max(254).nullable().optional().describe(arg('filamentSlot')),
      },
      (api, args) => api.saveSpool(args),
    ],
    ['delete_spool', { spoolId: z.string().describe(arg('spoolId')) }, (api, args) => api.deleteSpool(args)],
    [
      'preflight_print',
      {
        fileId: fileId(),
        printerId: z.string().optional().describe(arg('printerId')),
        plate: z.number().int().min(1).optional().describe(arg('plate')),
        amsMapping: z.array(z.number().int()).optional().describe(arg('amsMapping')),
      },
      (api, args) => api.preflight(args),
    ],
    ['orient_model', { fileId: fileId() }, (api, args) => api.orientModel(args)],
    [
      'combine_models',
      {
        items: z
          .array(z.object({ fileId: z.string(), copies: z.number().int().min(1).max(100).optional() }))
          .min(1)
          .describe(arg('combineItems')),
        printerId: z.string().optional().describe(arg('bedPrinterId')),
        autoRotate: z.boolean().optional().describe(arg('autoRotate')),
      },
      (api, args) => api.combineModels(args),
    ],
    ['list_maintenance', { printerId: printerId() }, (api, args) => api.listMaintenance(args)],
    [
      'complete_maintenance',
      { printerId: printerId(), taskId: z.string().describe(arg('taskId')) },
      (api, args) => api.completeMaintenance(args),
    ],
    [
      'cancel_job',
      { jobId: z.string().describe(arg('jobId')), force: z.boolean().optional().describe(arg('force')) },
      (api, args) => api.cancelJob(args),
    ],
    ['pause_print', { printerId: printerId() }, (api, args) => api.command({ ...args, action: 'pause' })],
    ['resume_print', { printerId: printerId() }, (api, args) => api.command({ ...args, action: 'resume' })],
    ['cancel_print', { printerId: printerId() }, (api, args) => api.command({ ...args, action: 'cancel' })],
    [
      'set_temperature',
      {
        printerId: printerId(),
        heater: z.enum(['nozzle', 'bed', 'chamber']).describe(arg('heater')),
        target: z.number().min(0).describe(arg('target')),
      },
      (api, { printerId: id, ...params }) => api.command({ printerId: id, action: 'temperature', params }),
    ],
    [
      'send_gcode',
      { printerId: printerId(), gcode: z.string().describe(arg('gcode')) },
      (api, { printerId: id, gcode }) => api.command({ printerId: id, action: 'gcode', params: { gcode } }),
    ],
    [
      'home_axes',
      { printerId: printerId(), axes: z.array(z.enum(['x', 'y', 'z'])).optional().describe(arg('axes')) },
      (api, { printerId: id, axes }) => api.command({ printerId: id, action: 'home', params: { axes: axes ?? [] } }),
    ],
    [
      'jog',
      {
        printerId: printerId(),
        x: z.number().optional().describe(arg('jogAxis')),
        y: z.number().optional().describe(arg('jogAxis')),
        z: z.number().optional().describe(arg('jogAxis')),
        feedrate: z.number().optional().describe(arg('feedrate')),
      },
      (api, { printerId: id, ...params }) => api.command({ printerId: id, action: 'jog', params }),
    ],
    [
      'set_fan',
      { printerId: printerId(), percent: z.number().min(0).max(100).describe(arg('fanPercent')) },
      (api, { printerId: id, percent }) => api.command({ printerId: id, action: 'fan', params: { percent } }),
    ],
    [
      'set_speed',
      { printerId: printerId(), percent: z.number().min(10).max(300).describe(arg('speedPercent')) },
      (api, { printerId: id, percent }) => api.command({ printerId: id, action: 'speed', params: { percent } }),
    ],
    [
      'set_light',
      { printerId: printerId(), on: z.boolean().describe(arg('lightOn')) },
      (api, { printerId: id, on }) => api.command({ printerId: id, action: 'light', params: { on } }),
    ],
    [
      'load_filament',
      {
        printerId: printerId(),
        temperature: z.number().min(0).optional().describe(arg('filamentTemp')),
        length: z.number().min(10).max(1000).optional().describe(arg('filamentLength')),
        slot: z.number().int().min(0).max(254).optional().describe(arg('filamentSlot')),
      },
      (api, { printerId: id, ...params }) => api.command({ printerId: id, action: 'loadFilament', params }),
    ],
    [
      'unload_filament',
      {
        printerId: printerId(),
        temperature: z.number().min(0).optional().describe(arg('filamentTemp')),
        length: z.number().min(10).max(1000).optional().describe(arg('filamentLength')),
      },
      (api, { printerId: id, ...params }) => api.command({ printerId: id, action: 'unloadFilament', params }),
    ],
    ['emergency_stop', { printerId: printerId() }, (api, args) => api.command({ ...args, action: 'emergencyStop' })],
    ['mark_bed_cleared', { printerId: printerId() }, (api, args) => api.markBedCleared(args)],
    [
      'list_slice_profiles',
      { printerId: z.string().optional().describe(arg('printerId')), machine: z.string().optional().describe(arg('machineFilter')) },
      (api, args) => api.sliceProfiles(args),
    ],
    ['get_slice_options', {}, (api) => api.sliceOptions()],
    [
      'read_profile_settings',
      {
        ...profiles(),
        keys: z.array(z.string()).max(60).optional().describe(arg('settingKeys')),
        search: z.string().optional().describe(arg('settingSearch')),
      },
      (api, args) => api.profileSettings(args),
    ],
    ['get_slice_settings', { fileId: fileId() }, (api, args) => api.sliceSettings(args)],
    ['get_slice_history', { fileId: fileId() }, (api, args) => api.sliceHistory(args)],
    [
      'slice_file',
      {
        fileId: fileId(),
        printerId: printerId(),
        ...profiles(),
        options: settings().optional().describe(arg('sliceOptions')),
        extra: settings().optional().describe(arg('sliceExtra')),
      },
      (api, args) => api.sliceFile(args),
    ],
    ['list_slice_presets', {}, (api) => api.listPresets()],
    [
      'save_slice_preset',
      {
        name: z.string().describe(arg('presetName')),
        description: z.string().optional().describe(arg('presetDescription')),
        ...profiles(false),
        options: settings().optional().describe(arg('sliceOptions')),
        extra: settings().optional().describe(arg('sliceExtra')),
      },
      (api, args) => api.savePreset(args),
    ],
    ['delete_slice_preset', { presetId: z.string().describe(arg('presetId')) }, (api, args) => api.deletePreset(args)],
  ];
}

export function createMcpServer(api) {
  const server = new McpServer({ name: '3d-printagent', version: VERSION }, { instructions: t('mcp.instructions') });

  for (const [name, inputSchema, run] of toolDefinitions()) {
    server.registerTool(
      name,
      { title: t(`mcp.${name}.title`), description: t(`mcp.${name}.description`), inputSchema },
      async (args) => {
        try {
          return text(await run(api, args ?? {}));
        } catch (error) {
          return failure(error);
        }
      },
    );
  }

  server.registerTool(
    'get_snapshot',
    {
      title: t('mcp.get_snapshot.title'),
      description: t('mcp.get_snapshot.description'),
      inputSchema: { printerId: printerId() },
    },
    async (args) => {
      try {
        const image = await api.snapshot(args);
        return { content: [{ type: 'image', data: image.base64, mimeType: image.mime }] };
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}

export function toolNames() {
  return [...toolDefinitions().map(([name]) => name), 'get_snapshot'];
}
