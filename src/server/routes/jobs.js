import { Router } from 'express';
import * as jobs from '../../core/jobs.js';
import { requestOrigin, wrap } from './helpers.js';

export const jobsRouter = Router();

jobsRouter.get('/', (req, res) => {
  res.json({
    jobs: jobs.listJobs({
      status: req.query.status,
      printerId: req.query.printerId,
      fileId: req.query.fileId,
      limit: req.query.limit,
      active: req.query.active === '1' || req.query.active === 'true',
    }),
    stats: jobs.stats(),
  });
});

jobsRouter.post(
  '/',
  wrap(async (req, res) => {
    res.status(201).json(await jobs.createJob({ ...(req.body ?? {}), origin: requestOrigin(req) }));
  }),
);

jobsRouter.post(
  '/batch',
  wrap(async (req, res) => {
    res.status(201).json(await jobs.createBatch({ ...(req.body ?? {}), origin: requestOrigin(req) }));
  }),
);

jobsRouter.post(
  '/batch/:batchId/cancel',
  wrap(async (req, res) => {
    res.json(await jobs.cancelBatch(req.params.batchId, { force: Boolean(req.body?.force) }));
  }),
);

jobsRouter.post('/clear', (req, res) => {
  res.json(jobs.clearFinished({ printerId: req.body?.printerId }));
});

jobsRouter.get('/:id', (req, res) => {
  res.json(jobs.getJob(req.params.id));
});

jobsRouter.get('/:id/history', (req, res) => {
  res.json(jobs.getJobHistory(req.params.id, { maxPoints: req.query.points ? Number(req.query.points) : undefined }));
});

jobsRouter.put('/:id', (req, res) => {
  res.json(jobs.updateQueuedJob(req.params.id, req.body ?? {}));
});

jobsRouter.post('/:id/move', (req, res) => {
  res.json(jobs.moveJob(req.params.id, req.body?.direction));
});

jobsRouter.post('/:id/start', (req, res) => {
  res.json(jobs.startJob(req.params.id, { confirmBedClear: Boolean(req.body?.confirmBedClear), printerId: req.body?.printerId }));
});

jobsRouter.post(
  '/:id/cancel',
  wrap(async (req, res) => {
    res.json(await jobs.cancelJob(req.params.id, { force: Boolean(req.body?.force) }));
  }),
);

jobsRouter.post(
  '/:id/reprint',
  wrap(async (req, res) => {
    res.status(201).json(await jobs.reprintJob(req.params.id, { ...(req.body ?? {}), origin: requestOrigin(req) }));
  }),
);

jobsRouter.delete('/:id', (req, res) => {
  res.json(jobs.deleteJob(req.params.id));
});
