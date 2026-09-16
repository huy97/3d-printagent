import { VERSION } from '../util/version.js';
import { JOB_STATUSES } from '../core/jobs.js';
import { PRINTER_STATES, CAPABILITY_KEYS } from '../drivers/base.js';
import { DRIVERS } from '../drivers/index.js';
import { COMMAND_ACTIONS } from '../core/printers.js';
import { optionSchema } from '../core/advisor.js';
import { CALIBRATION_OPTIONS } from '../drivers/base.js';

const json = (schema) => ({ 'application/json': { schema } });
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const ERROR = { description: 'Error', content: json(ref('Error')) };

const SCHEMAS = {
  Error: {
    type: 'object',
    properties: {
      error: {
        type: 'object',
        properties: {
          code: { type: 'string', example: 'conflict' },
          key: { type: 'string', description: 'i18n message key, for clients that translate on their own', example: 'error.printer_not_ready' },
          message: { type: 'string', description: 'Message translated per x-locale / ?lang= / Accept-Language' },
          details: { type: ['object', 'null'] },
        },
      },
    },
  },
  Temperature: {
    type: ['object', 'null'],
    properties: { actual: { type: 'number' }, target: { type: ['number', 'null'] } },
  },
  PrinterStatus: {
    type: 'object',
    properties: {
      online: { type: 'boolean', description: 'Whether the agent can reach the printer (or the OctoPrint/Moonraker host)' },
      state: { type: 'string', enum: PRINTER_STATES },
      message: { type: ['string', 'null'] },
      temps: {
        type: 'object',
        properties: { nozzle: ref('Temperature'), bed: ref('Temperature'), chamber: ref('Temperature') },
      },
      job: {
        type: ['object', 'null'],
        properties: {
          file: { type: 'string' },
          progress: { type: 'number', description: '0-100' },
          elapsed: { type: ['integer', 'null'], description: 'Seconds' },
          remaining: { type: ['integer', 'null'], description: 'Seconds' },
          layer: { type: ['integer', 'null'] },
          totalLayers: { type: ['integer', 'null'] },
        },
      },
      fanSpeed: { type: ['number', 'null'], description: 'Percent' },
      speedFactor: { type: ['number', 'null'], description: 'Percent' },
      position: { type: ['object', 'null'] },
      light: { type: ['boolean', 'null'] },
      firmware: { type: ['string', 'null'] },
      extra: { type: 'object', description: 'Driver-specific data; for Bambu it includes AMS and hms, a list of { code, severity, text } resolved from the vendor code table' },
      updatedAt: { type: ['string', 'null'], format: 'date-time' },
    },
  },
  Printer: {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'prn_1a2b3c4d5e6f' },
      name: { type: 'string' },
      driver: { type: 'string', enum: Object.keys(DRIVERS) },
      driverLabel: { type: 'string' },
      enabled: { type: 'boolean' },
      connection: { type: 'object', description: 'Connection fields per driver; secrets are returned as ***' },
      notes: { type: 'string' },
      autoStartQueue: { type: 'boolean', description: 'Automatically print the next queued job when the printer is idle and the plate is clear' },
      bedClear: { type: 'boolean', description: 'The plate was confirmed clear after the previous print' },
      formats: { type: 'array', items: { type: 'string', enum: ['gcode', 'bgcode', '3mf'] } },
      capabilities: { type: 'object', properties: Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, { type: 'boolean' }])) },
      status: ref('PrinterStatus'),
    },
  },
  PrinterInput: {
    type: 'object',
    required: ['driver', 'connection'],
    properties: {
      name: { type: 'string' },
      driver: { type: 'string', enum: Object.keys(DRIVERS) },
      connection: {
        type: 'object',
        description: 'See GET /api/drivers for the fields of each driver',
        example: { host: '192.168.1.80', serial: '01P00A123456789', accessCode: '12345678', model: 'P1S' },
      },
      enabled: { type: 'boolean' },
      notes: { type: 'string' },
      autoStartQueue: { type: 'boolean' },
      powerW: { type: ['number', 'null'], description: 'Average power while printing (W), used for electricity cost' },
      hourlyCost: { type: ['number', 'null'], description: 'Wear cost per print hour' },
    },
  },
  SpoolInput: {
    type: 'object',
    properties: {
      name: { type: 'string', example: 'PLA Basic Black' },
      material: { type: 'string', example: 'PLA' },
      color: { type: ['string', 'null'], example: '#000000' },
      brand: { type: ['string', 'null'] },
      diameter: { type: 'number', default: 1.75 },
      density: { type: 'number', description: 'g/cm3; left empty it is taken from the material type' },
      pricePerKg: { type: ['number', 'null'] },
      totalG: { type: 'number', default: 1000 },
      remainingG: { type: 'number' },
      lowG: { type: 'number', default: 100, description: 'Warn when the remaining amount falls below this' },
      printerId: { type: ['string', 'null'], description: 'Printer this spool is loaded on' },
      slot: { type: ['integer', 'null'], description: 'AMS slot (0 is A1); leave empty for single-spool printers' },
      notes: { type: ['string', 'null'] },
    },
  },
  File: {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'fil_1a2b3c4d5e6f' },
      name: { type: 'string', example: 'benchy.gcode.3mf' },
      size: { type: 'integer' },
      format: { type: 'string', enum: ['gcode', 'bgcode', '3mf', 'model'] },
      meta: {
        type: 'object',
        description: 'Metadata read from the slicer file, or geometry measurements for unsliced models',
        properties: {
          slicer: { type: ['string', 'null'] },
          estimatedTime: { type: ['integer', 'null'], description: 'Seconds' },
          filamentType: { type: ['string', 'null'] },
          filamentWeightG: { type: ['number', 'null'] },
          layerCount: { type: ['integer', 'null'] },
          plates: { type: 'array', description: '3MF only' },
          sliced: { type: 'boolean', description: 'An unsliced 3MF cannot be printed' },
          triangles: { type: ['integer', 'null'], description: 'Unsliced model' },
          size: { type: ['object', 'null'], description: 'Bounding size in mm', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
          volumeCm3: { type: ['number', 'null'] },
          overhangRatio: { type: ['number', 'null'], description: 'Share of downward-facing area steeper than 30 degrees, excluding faces resting on the plate' },
        },
      },
      hasThumbnail: { type: 'boolean' },
      uploadedAt: { type: 'string', format: 'date-time' },
    },
  },
  FileSource: {
    type: 'object',
    description: 'Pick one source: url, content (G-code text), contentBase64 or path (requires files.allowLocalFilePath)',
    properties: {
      url: { type: 'string', format: 'uri' },
      content: { type: 'string' },
      contentBase64: { type: 'string' },
      path: { type: 'string' },
      name: { type: 'string', description: 'File name with the .gcode/.bgcode/.3mf extension' },
    },
  },
  PrintOptions: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['now', 'queue'], default: 'now' },
      confirmBedClear: { type: 'boolean', description: 'Confirm the plate is clear (required when bedClear=false)' },
      plate: { type: 'integer', description: '3MF: plate number to print' },
      useAms: { type: 'boolean' },
      amsMapping: { type: 'array', items: { type: 'integer' } },
      timelapse: { type: 'boolean' },
      bedLeveling: { oneOf: [{ type: 'boolean' }, { type: 'string', enum: ['auto'] }], description: 'Bambu: true on, false off, "auto" lets the printer decide (default)' },
      flowCalibration: { oneOf: [{ type: 'boolean' }, { type: 'string', enum: ['auto'] }], description: 'Bambu: true on, false off, "auto" skips it when the filament was just calibrated (default)' },
    },
  },
  Job: {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'job_1a2b3c4d5e6f' },
      printerId: { type: ['string', 'null'], description: 'null while the job sits in the shared queue with no printer assigned' },
      printerName: { type: ['string', 'null'] },
      target: { type: ['object', 'null'], description: 'Shared queue: { any: true, printerIds }' },
      priority: { type: 'integer', description: 'Higher runs first, from -100 to 100' },
      fileId: { type: ['string', 'null'] },
      fileName: { type: 'string' },
      status: { type: 'string', enum: JOB_STATUSES },
      adjustedTime: { type: ['integer', 'null'], description: 'Estimated time adjusted from the printer history (seconds)' },
      forecast: { type: 'object', description: 'Estimated start and finish time', properties: { startAt: { type: ['string', 'null'] }, finishAt: { type: 'string' }, printerId: { type: 'string' } } },
      material: { type: ['object', 'null'], description: 'Filament used once the job ends: usedG, productG, wasteG, grams{model,support,adhesion,purge}' },
      cost: { type: ['object', 'null'], description: 'Cost: filament, electricity, wear, total, currency' },
      progress: { type: 'number' },
      layer: { type: ['integer', 'null'] },
      totalLayers: { type: ['integer', 'null'] },
      remaining: { type: ['integer', 'null'] },
      upload: { type: ['object', 'null'], properties: { sent: { type: 'integer' }, total: { type: 'integer' } } },
      origin: { type: 'string', example: 'mcp' },
      error: { type: ['string', 'null'] },
      createdAt: { type: 'string', format: 'date-time' },
      startedAt: { type: ['string', 'null'], format: 'date-time' },
      finishedAt: { type: ['string', 'null'], format: 'date-time' },
    },
  },
};

const idParam = (name, description) => ({ name, in: 'path', required: true, schema: { type: 'string' }, description });
const PRINTER_ID = idParam('id', 'Printer id or name');
const FILE_ID = idParam('id', 'File id in the library');
const JOB_ID = idParam('id', 'Job id');
const queryParam = (name, type, description) => ({ name, in: 'query', required: false, description, schema: { type } });
const POINTS = queryParam('points', 'integer', 'Maximum number of points (default 1500); long ranges are averaged into buckets');
const HISTORY_QUERY = [
  queryParam('minutes', 'integer', 'Last N minutes when from is absent (default 30)'),
  queryParam('from', 'string', 'ISO 8601 or epoch ms'),
  queryParam('to', 'string', 'ISO 8601 or epoch ms, defaults to now'),
  POINTS,
];

function op(summary, { tags, params, body, response, status = 200, multipart } = {}) {
  const operation = { summary, tags, responses: { [status]: { description: 'OK', ...(response ? { content: json(response) } : {}) }, default: ERROR } };
  if (params) operation.parameters = params;
  if (body || multipart) {
    operation.requestBody = {
      required: true,
      content: {
        ...(body ? json(body) : {}),
        ...(multipart ? { 'multipart/form-data': { schema: multipart } } : {}),
      },
    };
  }
  return operation;
}

const commandBody = (properties, required) => ({ type: 'object', properties, ...(required ? { required } : {}) });

function printerAction(summary, body) {
  return { post: op(summary, { tags: ['Control'], params: [PRINTER_ID], body }) };
}

export function buildOpenApi(baseUrl) {
  const multipartFile = {
    type: 'object',
    properties: {
      file: { type: 'string', format: 'binary' },
      name: { type: 'string' },
      printerId: { type: 'string', description: 'Add printerId + print=true to print right after upload' },
      print: { type: 'boolean' },
    },
  };

  return {
    openapi: '3.1.0',
    info: {
      title: '3D PrintAgent API',
      version: VERSION,
      description:
        'Manage multiple 3D printers (OctoPrint, Klipper/Moonraker, PrusaLink, Bambu Lab LAN) over REST. ' +
        'Realtime events over WebSocket /ws; AI agents use MCP at /mcp.',
    },
    servers: [{ url: baseUrl }],
    security: [{ apiKey: [] }, { bearer: [] }],
    components: {
      securitySchemes: {
        apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' },
        bearer: { type: 'http', scheme: 'bearer' },
      },
      schemas: SCHEMAS,
    },
    paths: {
      '/api/health': { get: { ...op('Agent health', { tags: ['System'] }), security: [] } },
      '/api/info': { get: op('Agent info and endpoints', { tags: ['System'] }) },
      '/api/logs': { get: op('Recent logs', { tags: ['System'], params: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 200 } }] }) },
      '/api/drivers': { get: op('Driver list and connection fields', { tags: ['Printers'] }) },
      '/api/printers': {
        get: op('Printer list with status', { tags: ['Printers'], response: { type: 'object', properties: { printers: { type: 'array', items: ref('Printer') } } } }),
        post: op('Add printer', { tags: ['Printers'], body: ref('PrinterInput'), response: ref('Printer'), status: 201 }),
      },
      '/api/printers/test': { post: op('Test the connection before saving', { tags: ['Printers'], body: ref('PrinterInput') }) },
      '/api/printers/detect': {
        post: op('Guess the printer type from an IP address', { tags: ['Printers'], body: commandBody({ host: { type: 'string' }, port: { type: 'integer' } }, ['host']) }),
      },
      '/api/printers/discover': {
        get: op('Discover printers on the LAN (SSDP Bambu, mDNS OctoPrint/Moonraker)', {
          tags: ['Printers'],
          params: [{ name: 'timeout', in: 'query', schema: { type: 'integer', default: 12000 } }],
        }),
      },
      '/api/printers/{id}': {
        get: op('Printer details', { tags: ['Printers'], params: [PRINTER_ID], response: ref('Printer') }),
        put: op('Update printer', { tags: ['Printers'], params: [PRINTER_ID], body: ref('PrinterInput'), response: ref('Printer') }),
        delete: op('Delete printer', { tags: ['Printers'], params: [PRINTER_ID] }),
      },
      '/api/printers/{id}/status': { get: op('Realtime status', { tags: ['Printers'], params: [PRINTER_ID] }) },
      '/api/printers/{id}/history': {
        get: op('Temperature, fan, speed and progress history stored in SQLite (5 second samples)', { tags: ['Printers'], params: [PRINTER_ID, ...HISTORY_QUERY] }),
      },
      '/api/printers/{id}/reconnect': { post: op('Reconnect the driver', { tags: ['Printers'], params: [PRINTER_ID] }) },
      '/api/printers/{id}/snapshot': {
        get: {
          ...op('Current camera snapshot', { tags: ['Printers'], params: [PRINTER_ID] }),
          responses: { 200: { description: 'JPEG/PNG image', content: { 'image/jpeg': {}, 'image/png': {} } }, default: ERROR },
        },
      },
      '/api/printers/{id}/camera': {
        get: {
          ...op('Continuous MJPEG camera stream, only on printers with the cameraStream capability', { tags: ['Printers'], params: [PRINTER_ID] }),
          responses: { 200: { description: 'multipart/x-mixed-replace, each part is a JPEG image', content: { 'multipart/x-mixed-replace': {} } }, default: ERROR },
        },
      },
      '/api/printers/{id}/diagnose': {
        post: op('AI reads printer state, decoded HMS codes and recent jobs to point out the cause and the fix; requires ai.apiKey in config', {
          tags: ['Printers'],
          params: [PRINTER_ID],
          body: commandBody({ note: { type: 'string', description: 'Extra user description of the symptom' } }),
        }),
        get: op('Latest automatic diagnosis, available when watch.autoDiagnose is on', { tags: ['Printers'], params: [PRINTER_ID] }),
      },
      '/api/printers/{id}/inspect': {
        post: op('AI inspects the current camera image to say whether the print is still fine or has failed; requires ai.apiKey in config', {
          tags: ['Printers'],
          params: [PRINTER_ID],
          body: commandBody({ note: { type: 'string', description: 'Extra user description of the symptom' } }),
        }),
        get: op('Latest image inspection for this printer, with the automatic monitoring state', { tags: ['Printers'], params: [PRINTER_ID] }),
      },
      '/api/printers/{id}/bed-cleared': {
        post: op('Confirm the plate is clear', { tags: ['Printers'], params: [PRINTER_ID], body: commandBody({ clear: { type: 'boolean', default: true } }) }),
      },
      '/api/printers/{id}/files': {
        get: op('Files currently on the printer', { tags: ['Printers'], params: [PRINTER_ID] }),
        delete: op('Delete a file on the printer', { tags: ['Printers'], params: [PRINTER_ID, { name: 'name', in: 'query', required: true, schema: { type: 'string' } }] }),
      },
      '/api/printers/{id}/files/start': {
        post: op('Print a file already on the printer', { tags: ['Printers'], params: [PRINTER_ID], body: commandBody({ name: { type: 'string' } }, ['name']) }),
      },
      '/api/printers/{id}/print': {
        post: op('Create a print job for this printer', {
          tags: ['Job'],
          params: [PRINTER_ID],
          body: { allOf: [commandBody({ fileId: { type: 'string' } }, ['fileId']), ref('PrintOptions')] },
          response: ref('Job'),
          status: 201,
        }),
      },
      '/api/printers/{id}/command': printerAction(
        'Generic control command: action + params',
        commandBody({ action: { type: 'string', enum: COMMAND_ACTIONS }, params: { type: 'object', example: { heater: 'bed', target: 60 } } }, ['action']),
      ),
      '/api/printers/{id}/pause': printerAction('Pause the print'),
      '/api/printers/{id}/resume': printerAction('Resume the print'),
      '/api/printers/{id}/cancel': printerAction('Cancel the running print'),
      '/api/printers/{id}/gcode': printerAction('Send G-code (through the safety filter)', commandBody({ gcode: { type: 'string', example: 'G28\nM104 S200' } }, ['gcode'])),
      '/api/printers/{id}/temperature': printerAction(
        'Set temperature',
        commandBody({ heater: { type: 'string', enum: ['nozzle', 'bed', 'chamber'] }, target: { type: 'number' } }, ['heater', 'target']),
      ),
      '/api/printers/{id}/home': printerAction('Home axes', commandBody({ axes: { type: 'array', items: { type: 'string', enum: ['x', 'y', 'z'] } } })),
      '/api/printers/{id}/jog': printerAction(
        'Relative move (mm)',
        commandBody({ x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, feedrate: { type: 'number' } }),
      ),
      '/api/printers/{id}/fan': printerAction('Part cooling fan speed (%)', commandBody({ percent: { type: 'number' } }, ['percent'])),
      '/api/printers/{id}/speed': printerAction('Print speed (%)', commandBody({ percent: { type: 'number' } }, ['percent'])),
      '/api/printers/{id}/light': printerAction('Toggle the light', commandBody({ on: { type: 'boolean' } }, ['on'])),
      '/api/printers/{id}/load-filament': printerAction(
        'Load filament into the nozzle',
        commandBody({ temperature: { type: 'number' }, length: { type: 'number' }, slot: { type: 'number', description: 'Bambu: AMS slot counted from 0, 254 is the external spool' } }),
      ),
      '/api/printers/{id}/unload-filament': printerAction(
        'Unload filament from the nozzle',
        commandBody({ temperature: { type: 'number' }, length: { type: 'number' } }),
      ),
      '/api/printers/{id}/calibrate': printerAction(
        'Run printer calibration (bed leveling, vibration compensation, noise cancelling...). Supported items are listed in the `calibrations` field of the printer',
        commandBody(
          {
            options: {
              type: 'array',
              items: { type: 'string', enum: [...CALIBRATION_OPTIONS] },
              example: ['bedLeveling'],
            },
            confirmBedClear: { type: 'boolean', description: 'Confirm the plate is clear' },
          },
          ['options'],
        ),
      ),
      '/api/printers/{id}/emergency-stop': printerAction('Emergency stop'),
      '/api/printers/{id}/connect': printerAction('Reconnect firmware (OctoPrint connect, Klipper firmware restart)'),
      '/api/files': {
        get: op('File library', {
          tags: ['File'],
          params: [
            { name: 'search', in: 'query', schema: { type: 'string' } },
            { name: 'format', in: 'query', schema: { type: 'string' } },
            {
              name: 'derived',
              in: 'query',
              description: 'false returns only user-added files, true only files produced by slicing or object splitting',
              schema: { type: 'boolean' },
            },
            { name: 'sourceId', in: 'query', description: 'Only files derived from this source file', schema: { type: 'string' } },
          ],
        }),
        post: op('Upload a file to the library', { tags: ['File'], body: ref('FileSource'), multipart: multipartFile, response: ref('File'), status: 201 }),
      },
      '/api/files/{id}': {
        get: op('File details', { tags: ['File'], params: [FILE_ID], response: ref('File') }),
        put: op('Rename file', { tags: ['File'], params: [FILE_ID], body: commandBody({ name: { type: 'string' } }, ['name']) }),
        delete: op('Delete file', { tags: ['File'], params: [FILE_ID] }),
      },
      '/api/files/{id}/analyze': {
        post: op('Inspect a file before printing: measurements give hard warnings, AI adds risks that are hard to encode as rules; requires ai.apiKey in config', {
          tags: ['File'],
          params: [FILE_ID],
          body: commandBody({
            printerId: { type: 'string', description: 'Target printer, to check against its nozzle and loaded filament slots' },
            plate: { type: 'integer', minimum: 1, description: 'Plate to inspect for multi-plate 3MF files' },
            note: { type: 'string' },
          }),
        }),
      },
      '/api/files/{id}/split': {
        post: op('Split the disconnected parts of a model into separate objects, returning a new 3MF file', { tags: ['File'], params: [FILE_ID], status: 201 }),
      },
      '/api/files/{id}/arrange': {
        post: op('Rearrange the parts of a model to fit on the plate, returning a new 3MF file', {
          tags: ['File'],
          params: [FILE_ID],
          body: commandBody({
            machine: { type: 'string' },
            printerId: { type: 'string' },
            gap: { type: 'number', description: 'Gap between two objects in mm, default 6' },
            margin: { type: 'number', description: 'Margin from the plate edge in mm, default 2' },
            separate: { type: 'boolean', description: 'Also separate parts that merely touch and arrange them individually' },
            autoRotate: { type: 'boolean', description: 'Flip each group so its largest flat face rests on the plate' },
          }),
          status: 201,
        }),
      },
      '/api/files/{id}/layout': {
        post: op('Store the new object position after dragging it on the plate, editing the file in place', {
          tags: ['File'],
          params: [FILE_ID],
          body: commandBody(
            {
              moves: {
                type: 'array',
                description: 'List of objects to move',
                items: {
                  type: 'object',
                  properties: {
                    item: { type: 'integer', description: 'Object index on the plate, taken from the item field of /mesh' },
                    dx: { type: 'number', description: 'Move along the X axis, mm' },
                    dy: { type: 'number', description: 'Move along the Y axis, mm' },
                  },
                },
              },
            },
            ['moves'],
          ),
        }),
      },
      '/api/files/{id}/plate': {
        get: op('Object positions on the plate, read straight from the 3MF written by the slicer', {
          tags: ['File'],
          params: [FILE_ID, { name: 'plate', in: 'query', schema: { type: 'integer' }, description: 'Plate number, defaults to the first plate' }],
        }),
      },
      '/api/files/{id}/mesh': {
        get: op('Model geometry in plate coordinates, binary format for the 3D viewer', {
          tags: ['File'],
          params: [
            FILE_ID,
            { name: 'plate', in: 'query', schema: { type: 'integer' } },
            {
              name: 'machine',
              in: 'query',
              schema: { type: 'string' },
              description: 'Machine profile name, used for the nominal plate size when the model is unsliced',
            },
            { name: 'printerId', in: 'query', schema: { type: 'string' }, description: 'A configured printer, used to guess the machine profile' },
          ],
        }),
      },
      '/api/files/{id}/toolpath': {
        get: op('Nozzle toolpath read from the sliced G-code, binary format for the layer viewer', {
          tags: ['File'],
          params: [FILE_ID, { name: 'plate', in: 'query', schema: { type: 'integer' } }],
        }),
      },
      '/api/files/{id}/plate-image': {
        get: op('Top-down image of the plate (PNG embedded by the slicer)', {
          tags: ['File'],
          params: [FILE_ID, { name: 'plate', in: 'query', schema: { type: 'integer' } }],
        }),
      },
      '/api/files/{id}/download': { get: op('Download the original file', { tags: ['File'], params: [FILE_ID] }) },
      '/api/files/{id}/thumbnail': { get: op('Preview image embedded by the slicer', { tags: ['File'], params: [FILE_ID] }) },
      '/api/jobs': {
        get: op('Job list', {
          tags: ['Job'],
          params: [
            { name: 'status', in: 'query', schema: { type: 'string' }, description: 'One or more statuses, comma separated' },
            { name: 'printerId', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer' } },
          ],
        }),
        post: op('Create a print job', {
          tags: ['Job'],
          body: { allOf: [commandBody({ printerId: { type: 'string' }, fileId: { type: 'string' } }, ['printerId', 'fileId']), ref('PrintOptions')] },
          response: ref('Job'),
          status: 201,
        }),
      },
      '/api/jobs/batch': {
        post: op('Print the same file immediately on several printers, one copy each; printers that are not ready are skipped, not queued', {
          tags: ['Job'],
          body: {
            allOf: [
              commandBody(
                {
                  fileId: { type: 'string' },
                  printerIds: { type: 'array', items: { type: 'string' } },
                  confirmBedClear: { type: 'boolean' },
                },
                ['fileId'],
              ),
              ref('PrintOptions'),
            ],
          },
          status: 201,
        }),
      },
      '/api/jobs/batch/{batchId}/cancel': {
        post: op('Cancel every unfinished copy of a batch', {
          tags: ['Job'],
          params: [{ name: 'batchId', in: 'path', required: true, schema: { type: 'string' } }],
          body: commandBody({ force: { type: 'boolean' } }),
        }),
      },
      '/api/jobs/clear': { post: op('Delete finished jobs', { tags: ['Job'], body: commandBody({ printerId: { type: 'string' } }) }) },
      '/api/jobs/{id}': {
        get: op('Job details', { tags: ['Job'], params: [JOB_ID], response: ref('Job') }),
        put: op('Update a pending job: priority, note, printer group for the shared queue', {
          tags: ['Job'],
          params: [JOB_ID],
          body: commandBody({
            priority: { type: 'integer', minimum: -100, maximum: 100 },
            note: { type: ['string', 'null'] },
            printerIds: { type: 'array', items: { type: 'string' } },
          }),
        }),
        delete: op('Delete a finished job', { tags: ['Job'], params: [JOB_ID] }),
      },
      '/api/jobs/{id}/history': { get: op('Temperature history over the job run', { tags: ['Job'], params: [JOB_ID, POINTS] }) },
      '/api/jobs/{id}/start': {
        post: op('Start a queued job; a shared-queue job needs the printerId of the target printer', {
          tags: ['Job'],
          params: [JOB_ID],
          body: commandBody({ confirmBedClear: { type: 'boolean' }, printerId: { type: 'string' } }),
        }),
      },
      '/api/jobs/{id}/move': {
        post: op('Reorder a pending job in the queue', {
          tags: ['Job'],
          params: [JOB_ID],
          body: commandBody({ direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] } }, ['direction']),
        }),
      },
      '/api/jobs/{id}/cancel': { post: op('Cancel job', { tags: ['Job'], params: [JOB_ID], body: commandBody({ force: { type: 'boolean' } }) }) },
      '/api/jobs/{id}/reprint': { post: op('Reprint', { tags: ['Job'], params: [JOB_ID], body: ref('PrintOptions'), status: 201 }) },
      '/api/print': {
        post: op('One step: bring the file into the library then print it', {
          tags: ['Job'],
          body: { allOf: [ref('FileSource'), commandBody({ printerId: { type: 'string' }, fileId: { type: 'string' } }, ['printerId']), ref('PrintOptions')] },
          multipart: { ...multipartFile, required: ['file', 'printerId'] },
          status: 201,
        }),
      },
      '/api/slicer': {
        get: op('Slicer state on the agent machine, with advisor telling whether the AI key is configured', { tags: ['Slicer'] }),
        post: op('Slice a model and put the result into the library', {
          tags: ['Slicer'],
          body: commandBody(
            {
              fileId: { type: 'string', description: 'STL/OBJ/3MF model file in the library' },
              printerId: { type: 'string', description: 'Target printer, decides whether 3MF or G-code is produced' },
              machine: { type: 'string', description: 'Machine profile name, from /api/slicer/profiles' },
              process: { type: 'string' },
              filament: { type: 'string' },
              // Override list comes straight from the slicer table so the docs stay in sync when new keys appear.
              ...optionSchema(),
              extra: {
                type: 'object',
                description: 'Any slicer config key, e.g. {"reduce_crossing_wall": true, "top_surface_pattern": "monotonic"}',
                additionalProperties: { type: ['string', 'number', 'boolean'] },
              },
            },
            ['fileId', 'printerId', 'machine'],
          ),
          status: 201,
        }),
      },
      '/api/slicer/chat/{fileId}': {
        get: op('Chat history and slicing parameter versions, keyed by the source model of the file', {
          tags: ['Slicer'],
          params: [idParam('fileId', 'Id of the model, the arranged version or the sliced version')],
        }),
        delete: op('Delete the chat history, keeping the versions', { tags: ['Slicer'], params: [idParam('fileId', 'File id')] }),
      },
      '/api/slicer/chat/{fileId}/messages': {
        post: op('Message the agent about slicing parameters; returns the stored question and answer, where the answer may carry parameter suggestions', {
          tags: ['Slicer'],
          params: [idParam('fileId', 'Id of the unsliced model')],
          status: 201,
          body: commandBody(
            {
              message: { type: 'string', description: 'Up to 2000 characters' },
              printerId: { type: 'string' },
              machine: { type: 'string' },
              process: { type: 'string' },
              filament: { type: 'string' },
              options: { type: 'object', description: 'Fields currently edited on the form, with extra holding manually added slicer parameters' },
              sliceId: { type: 'string', description: 'Latest sliced version so the agent knows what is being tuned further' },
            },
            ['message', 'printerId', 'machine'],
          ),
        }),
      },
      '/api/slicer/chat/{fileId}/versions': {
        post: op('Save a slicing parameter version; slicing via POST /api/slicer saves one automatically', {
          tags: ['Slicer'],
          params: [idParam('fileId', 'File id')],
          status: 201,
          body: commandBody({
            source: { type: 'string', enum: ['ai', 'slice', 'manual'] },
            machine: { type: 'string' },
            process: { type: 'string' },
            filament: { type: 'string' },
            options: { type: 'object' },
            extra: { type: 'object' },
            sliceId: { type: 'string' },
            messageId: { type: 'string', description: 'Message holding the suggestion just applied' },
          }),
        }),
      },
      '/api/slicer/presets': {
        get: op('Slicing parameter presets, shared across all models', { tags: ['Slicer'] }),
        post: op('Save a preset; a name clash (case insensitive) overwrites', {
          tags: ['Slicer'],
          status: 201,
          body: commandBody(
            {
              name: { type: 'string', description: 'Up to 60 characters' },
              description: { type: 'string' },
              machine: { type: 'string' },
              process: { type: 'string' },
              filament: { type: 'string' },
              options: { type: 'object', description: 'Scale, rotation, copy count and plate arrangement are not stored in a preset' },
              extra: { type: 'object' },
            },
            ['name'],
          ),
        }),
      },
      '/api/slicer/presets/{id}': {
        delete: op('Delete preset', { tags: ['Slicer'], params: [idParam('id', 'Preset id')] }),
      },
      '/api/slicer/profiles': {
        get: op('Machine, process and filament profiles; pass machine to filter compatible process/filament', {
          tags: ['Slicer'],
          params: [
            queryParam('printerId', 'string', 'Suggest machine profiles matching this printer'),
            queryParam('vendor', 'string', 'Filter by vendor'),
            queryParam('machine', 'string', 'Selected machine profile name'),
          ],
        }),
      },
      '/api/slicer/options': {
        get: op('Overridable slicing parameters with type, min/max range and allowed values', { tags: ['Slicer'] }),
      },
      '/api/slicer/profile-settings': {
        get: op('Base values from the merged machine, process and filament profiles, up to 60 keys', {
          tags: ['Slicer'],
          params: [
            queryParam('machine', 'string', 'Machine profile name'),
            queryParam('process', 'string', 'Left empty, the machine default is used'),
            queryParam('filament', 'string', 'Left empty, the machine default is used'),
            queryParam('keys', 'string', 'Exact key names, comma separated'),
            queryParam('search', 'string', 'Substring of the key name'),
          ],
        }),
      },
      '/api/files/{id}/orient': {
        post: op('Rotate the model to the orientation needing the least support, returns a new 3MF (201) or changed=false (200)', { tags: ['File'], params: [FILE_ID] }),
      },
      '/api/files/combine': {
        post: op('Pack several unsliced models (with copy counts) onto one plate, returns a new 3MF', {
          tags: ['File'],
          body: commandBody(
            {
              items: {
                type: 'array',
                items: { type: 'object', properties: { fileId: { type: 'string' }, copies: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['fileId'] },
              },
              printerId: { type: 'string', description: 'Target printer, used for the plate size' },
              machine: { type: 'string' },
              gap: { type: 'number' },
              margin: { type: 'number' },
              autoRotate: { type: 'boolean' },
              name: { type: 'string' },
            },
            ['items'],
          ),
          status: 201,
        }),
      },
      '/api/files/{id}/material': {
        get: op('Filament the file needs by group (model, support, adhesion, purge) and by filament slot', {
          tags: ['Filament'],
          params: [FILE_ID, queryParam('plate', 'integer', '3MF plate number')],
        }),
      },
      '/api/preflight': {
        post: op('Pre-print check: filament needed versus loaded spools, cost, and finish time adjusted from history', {
          tags: ['Filament'],
          body: commandBody(
            {
              fileId: { type: 'string' },
              printerId: { type: 'string', description: 'Leave empty to let the agent pick the first suitable printer' },
              printerIds: { type: 'array', items: { type: 'string' } },
              plate: { type: 'integer' },
              amsMapping: { type: 'array', items: { type: 'integer' } },
            },
            ['fileId'],
          ),
        }),
      },
      '/api/spools': {
        get: op('Spool list and cost configuration', { tags: ['Filament'], params: [queryParam('printerId', 'string', 'Filter by the printer it is loaded on')] }),
        post: op('Add spool', { tags: ['Filament'], body: ref('SpoolInput'), status: 201 }),
      },
      '/api/spools/{id}': {
        put: op('Update spool', { tags: ['Filament'], params: [idParam('id', 'Spool id')], body: ref('SpoolInput') }),
        delete: op('Delete spool', { tags: ['Filament'], params: [idParam('id', 'Spool id')] }),
      },
      '/api/spools/{id}/adjust': {
        post: op('Reweigh a spool: set the remaining grams or add/subtract', {
          tags: ['Filament'],
          params: [idParam('id', 'Spool id')],
          body: commandBody({ remainingG: { type: 'number' }, deltaG: { type: 'number' } }),
        }),
      },
      '/api/stats': {
        get: op('Success rate, print hours, wasted filament and cost by printer, model, filament, profile and day', {
          tags: ['Stats'],
          params: [queryParam('days', 'integer', 'Last N days, 0 for all (default 30)'), queryParam('printerId', 'string', 'Filter by printer')],
        }),
      },
      '/api/maintenance/due': { get: op('Maintenance tasks due across all printers', { tags: ['Stats'] }) },
      '/api/printers/{id}/maintenance': {
        get: op('Maintenance tasks by printer print hours', { tags: ['Stats'], params: [PRINTER_ID] }),
        post: op('Add a maintenance task', {
          tags: ['Stats'],
          params: [PRINTER_ID],
          body: commandBody({ name: { type: 'string' }, intervalHours: { type: 'integer', minimum: 1 } }, ['name', 'intervalHours']),
          status: 201,
        }),
      },
      '/api/printers/{id}/maintenance/{taskId}': {
        put: op('Update a maintenance task', {
          tags: ['Stats'],
          params: [PRINTER_ID, idParam('taskId', 'Task id')],
          body: commandBody({ name: { type: 'string' }, intervalHours: { type: 'integer', minimum: 1 } }),
        }),
        delete: op('Delete a maintenance task', { tags: ['Stats'], params: [PRINTER_ID, idParam('taskId', 'Task id')] }),
      },
      '/api/printers/{id}/maintenance/{taskId}/done': {
        post: op('Mark maintenance done and reset the print-hour counter', { tags: ['Stats'], params: [PRINTER_ID, idParam('taskId', 'Task id')] }),
      },
      '/api/settings': { get: op('Configuration', { tags: ['System'] }), put: op('Update configuration', { tags: ['System'], body: { type: 'object' } }) },
      '/api/apikeys': {
        get: op('API key list (masked)', { tags: ['System'] }),
        post: op('Create an API key (local machine only)', { tags: ['System'], body: commandBody({ name: { type: 'string' } }), status: 201 }),
      },
      '/api/apikeys/{id}/reveal': { get: op('Reveal the full API key (local machine only)', { tags: ['System'], params: [idParam('id', 'Key id')] }) },
      '/api/apikeys/{id}': { delete: op('Delete an API key (local machine only)', { tags: ['System'], params: [idParam('id', 'Key id')] }) },
      '/api/service': {
        get: op('Background service status with the OS', { tags: ['System'] }),
        post: op('Install or remove the background service (local machine only)', { tags: ['System'], body: commandBody({ action: { type: 'string', enum: ['install', 'uninstall'] } }) }),
      },
      '/api/notify/test': {
        post: op('Send a test Telegram message using the stored configuration', {
          tags: ['System'],
          body: commandBody({ chatId: { type: 'string' }, botToken: { type: 'string', description: 'Accepted only when called from the machine running the agent' } }),
        }),
      },
      '/api/tunnel': { get: op('Tunnel status', { tags: ['Tunnel'] }) },
      '/api/tunnel/start': { post: op('Start the tunnel', { tags: ['Tunnel'], body: commandBody({ provider: { type: 'string', enum: ['cloudflare', 'ngrok'] } }) }) },
      '/api/tunnel/stop': { post: op('Stop the tunnel', { tags: ['Tunnel'] }) },
    },
  };
}
