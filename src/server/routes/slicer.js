import { Router } from 'express';
import * as advisor from '../../core/advisor.js';
import * as slicer from '../../core/slicer.js';
import * as slicechat from '../../core/slicechat.js';
import { localeFromRequest } from '../../i18n/index.js';
import { requestOrigin, wrap } from './helpers.js';

export const slicerRouter = Router();

slicerRouter.get('/', (req, res) => {
  res.json({ ...slicer.slicerStatus(), advisor: advisor.advisorStatus() });
});

slicerRouter.get('/profiles', (req, res) => {
  res.json(slicer.listProfiles({ vendor: req.query.vendor, machine: req.query.machine, printerId: req.query.printerId }));
});

slicerRouter.get('/options', (req, res) => {
  res.json({ options: slicer.optionSpecs() });
});

slicerRouter.get('/profile-settings', (req, res) => {
  const keys = String(req.query.keys ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  const { machine, process, filament } = req.query;
  res.json(slicer.profileSettings({ machine, process, filament }, { keys, search: req.query.search ?? '' }));
});

slicerRouter.get('/settings/:fileId', (req, res) => {
  res.json(slicer.readSliceSettings(req.params.fileId));
});

slicerRouter.get('/presets', (req, res) => {
  res.json(slicechat.listPresets());
});

slicerRouter.post('/presets', (req, res) => {
  res.status(201).json(slicechat.savePreset(req.body ?? {}));
});

slicerRouter.delete('/presets/:id', (req, res) => {
  res.json(slicechat.deletePreset(req.params.id));
});

slicerRouter.get('/chat/:fileId', (req, res) => {
  res.json(slicechat.getChat(req.params.fileId));
});

slicerRouter.delete('/chat/:fileId', (req, res) => {
  res.json(slicechat.clearMessages(req.params.fileId));
});

slicerRouter.post(
  '/chat/:fileId/messages',
  wrap(async (req, res) => {
    res.status(201).json(await advisor.chatSlice({ ...req.body, fileId: req.params.fileId, locale: localeFromRequest(req) }));
  }),
);

slicerRouter.post('/chat/:fileId/versions', (req, res) => {
  res.status(201).json(slicechat.addVersion(req.params.fileId, req.body ?? {}));
});

slicerRouter.post(
  '/',
  wrap(async (req, res) => {
    res.status(201).json(await slicechat.sliceAndRecord({ ...req.body, origin: requestOrigin(req) }));
  }),
);
