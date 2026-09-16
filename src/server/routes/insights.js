import { Router } from 'express';
import * as insights from '../../core/insights.js';
import * as filament from '../../core/filament.js';
import * as library from '../../core/library.js';
import * as jobs from '../../core/jobs.js';

export const insightsRouter = Router();

insightsRouter.get('/stats', (req, res) => {
  res.json(insights.printStats({ days: Number(req.query.days) || 30, printerId: req.query.printerId || undefined }));
});

insightsRouter.get('/spools', (req, res) => {
  res.json({ spools: filament.listSpools({ printerId: req.query.printerId || undefined }), costs: filament.costSettings() });
});

insightsRouter.post('/spools', (req, res) => {
  res.status(201).json(filament.saveSpool(req.body ?? {}));
});

insightsRouter.put('/spools/:id', (req, res) => {
  res.json(filament.saveSpool({ ...(req.body ?? {}), id: req.params.id }));
});

insightsRouter.post('/spools/:id/adjust', (req, res) => {
  res.json(filament.adjustSpool(req.params.id, req.body ?? {}));
});

insightsRouter.delete('/spools/:id', (req, res) => {
  res.json(filament.deleteSpool(req.params.id));
});

insightsRouter.post('/preflight', (req, res) => {
  const body = req.body ?? {};
  const matching = body.printerId ? null : jobs.matchingPrinters(body.fileId, { printerIds: body.printerIds, plate: body.plate });
  res.json({ ...filament.preflight({ ...body, printerId: body.printerId || matching?.[0] }), matchingPrinters: matching });
});

insightsRouter.get('/files/:id/material', (req, res) => {
  const file = library.getFileRecord(req.params.id);
  res.json(filament.materialFor(file, req.query.plate) ?? null);
});

insightsRouter.get('/printers/:id/maintenance', (req, res) => {
  res.json(insights.listMaintenance(req.params.id));
});

insightsRouter.post('/printers/:id/maintenance', (req, res) => {
  res.status(201).json(insights.addMaintenance(req.params.id, req.body ?? {}));
});

insightsRouter.put('/printers/:id/maintenance/:taskId', (req, res) => {
  res.json(insights.updateMaintenance(req.params.id, req.params.taskId, req.body ?? {}));
});

insightsRouter.post('/printers/:id/maintenance/:taskId/done', (req, res) => {
  res.json(insights.completeMaintenance(req.params.id, req.params.taskId));
});

insightsRouter.delete('/printers/:id/maintenance/:taskId', (req, res) => {
  res.json(insights.deleteMaintenance(req.params.id, req.params.taskId));
});

insightsRouter.get('/maintenance/due', (req, res) => {
  res.json({ tasks: insights.dueMaintenance() });
});
