import { Router } from 'express';
import * as advisor from '../../core/advisor.js';
import * as watch from '../../core/watch.js';
import * as printers from '../../core/printers.js';
import * as jobs from '../../core/jobs.js';
import { describeDrivers } from '../../drivers/index.js';
import { detectPrinter, discoverPrinters } from '../../core/discovery.js';
import { badRequest } from '../../util/errors.js';
import { localeFromRequest } from '../../i18n/index.js';
import { historyRange, requestOrigin, wrap } from './helpers.js';

export const printersRouter = Router();

const ACTION_ROUTES = {
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
  'load-filament': 'loadFilament',
  'unload-filament': 'unloadFilament',
  'emergency-stop': 'emergencyStop',
  calibrate: 'calibrate',
  connect: 'connect',
};

export function driversHandler(req, res) {
  res.json({ drivers: describeDrivers() });
}

printersRouter.get('/', (req, res) => {
  res.json({ printers: printers.listPrinters(), summary: printers.summary() });
});

printersRouter.post('/', (req, res) => {
  res.status(201).json(printers.addPrinter(req.body ?? {}));
});

printersRouter.post(
  '/test',
  wrap(async (req, res) => {
    res.json(await printers.testConnection(req.body ?? {}));
  }),
);

printersRouter.post(
  '/detect',
  wrap(async (req, res) => {
    res.json(await detectPrinter(req.body?.host, { port: req.body?.port }));
  }),
);

printersRouter.get(
  '/discover',
  wrap(async (req, res) => {
    res.json({ found: await discoverPrinters({ timeoutMs: Number(req.query.timeout) || undefined }) });
  }),
);

printersRouter.get('/:id', (req, res) => {
  res.json(printers.getPrinter(req.params.id));
});

printersRouter.put(
  '/:id',
  wrap(async (req, res) => {
    res.json(await printers.updatePrinter(req.params.id, req.body ?? {}));
  }),
);

printersRouter.delete(
  '/:id',
  wrap(async (req, res) => {
    res.json(await printers.removePrinter(req.params.id));
  }),
);

printersRouter.get('/:id/status', (req, res) => {
  const record = printers.getRecord(req.params.id);
  res.json({ id: record.id, name: record.name, status: printers.statusOf(record.id) });
});

printersRouter.get('/:id/history', (req, res) => {
  res.json(printers.getHistory(req.params.id, historyRange(req.query)));
});

printersRouter.post(
  '/:id/reconnect',
  wrap(async (req, res) => {
    res.json(await printers.reconnect(req.params.id));
  }),
);

printersRouter.post(
  '/:id/diagnose',
  wrap(async (req, res) => {
    res.json(await advisor.diagnose({ printerId: req.params.id, note: req.body?.note, locale: localeFromRequest(req) }));
  }),
);

printersRouter.get('/:id/diagnose', (req, res) => {
  res.json({ printerId: req.params.id, diagnosis: watch.lastDiagnosis(req.params.id) });
});

printersRouter.post(
  '/:id/inspect',
  wrap(async (req, res) => {
    res.json(await watch.inspectNow(req.params.id, { note: req.body?.note, locale: localeFromRequest(req) }));
  }),
);

printersRouter.get('/:id/inspect', (req, res) => {
  res.json({ printerId: req.params.id, inspection: watch.lastInspection(req.params.id), watch: watch.watchStatus() });
});

printersRouter.post('/:id/bed-cleared', (req, res) => {
  res.json(printers.setBedClear(req.params.id, req.body?.clear !== false));
});

printersRouter.post(
  '/:id/command',
  wrap(async (req, res) => {
    const { action, params, ...rest } = req.body ?? {};
    if (!action) throw badRequest('error.field_required', { field: 'action' });
    res.json(await printers.command(req.params.id, action, params ?? rest, { origin: requestOrigin(req) }));
  }),
);

printersRouter.get(
  '/:id/snapshot',
  wrap(async (req, res) => {
    const image = await printers.snapshot(req.params.id);
    res.setHeader('content-type', image.mime);
    res.setHeader('cache-control', 'no-store');
    res.send(image.buffer);
  }),
);

const CAMERA_BOUNDARY = 'printagent3dframe';

printersRouter.get(
  '/:id/camera',
  wrap(async (req, res) => {
    const write = (frame) => {
      if (res.writableEnded) return;
      if (!res.headersSent) startStream();
      res.write(`--${CAMERA_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
      res.write(frame);
      res.write('\r\n');
    };
    const startStream = () => {
      res.writeHead(200, {
        'content-type': `multipart/x-mixed-replace; boundary=${CAMERA_BOUNDARY}`,
        'cache-control': 'no-store, no-cache, must-revalidate',
        pragma: 'no-cache',
        connection: 'close',
      });
      res.flushHeaders?.();
    };
    // Subscribe before sending headers so errors (printer without streaming) still return JSON like any other route.
    const unsubscribe = printers.streamCamera(req.params.id, write);
    if (!res.headersSent) startStream();
    req.socket.setTimeout(0);
    const stop = () => {
      unsubscribe();
      res.end();
    };
    req.on('close', stop);
    req.on('error', stop);
  }),
);

printersRouter.get(
  '/:id/files',
  wrap(async (req, res) => {
    res.json({ files: await printers.listPrinterFiles(req.params.id) });
  }),
);

printersRouter.delete(
  '/:id/files',
  wrap(async (req, res) => {
    res.json(await printers.deletePrinterFile(req.params.id, req.query.name ?? req.body?.name));
  }),
);

printersRouter.post(
  '/:id/files/start',
  wrap(async (req, res) => {
    const { name, ...options } = req.body ?? {};
    res.json(await printers.startPrinterFile(req.params.id, name, options));
  }),
);

printersRouter.post(
  '/:id/print',
  wrap(async (req, res) => {
    const job = await jobs.createJob({ ...(req.body ?? {}), printerId: req.params.id, origin: requestOrigin(req) });
    res.status(201).json(job);
  }),
);

printersRouter.post(
  '/:id/:action',
  wrap(async (req, res, next) => {
    const action = ACTION_ROUTES[req.params.action];
    if (!action) {
      next();
      return;
    }
    res.json(await printers.command(req.params.id, action, req.body ?? {}, { origin: requestOrigin(req) }));
  }),
);
