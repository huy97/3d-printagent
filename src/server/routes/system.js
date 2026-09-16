import os from 'node:os';
import { statSync } from 'node:fs';
import { Router } from 'express';
import { getConfig, publicConfig, saveConfig, updateConfig } from '../../core/config.js';
import { apiKeyValue, shortId } from '../../util/id.js';
import { recentLogs } from '../../util/logger.js';
import * as printers from '../../core/printers.js';
import * as jobs from '../../core/jobs.js';
import * as library from '../../core/library.js';
import * as tunnel from '../../core/tunnel.js';
import { AUTH_TYPES } from '../../core/advisor.js';
import { NOTIFY_EVENTS, testTelegram } from '../../core/notify.js';
import { badRequest, notFound } from '../../util/errors.js';
import { setLocale, LOCALES } from '../../i18n/index.js';
import { PATHS } from '../../core/paths.js';
import { telemetryStats } from '../../core/telemetry.js';
import { getPrompt, listPrompts, promptsDir, resetPrompt, savePrompt } from '../../core/prompts.js';
import { serviceStatus, installService, uninstallService } from '../../setup/service.js';
import { requireLocal, wrap } from './helpers.js';
import { VERSION } from '../../util/version.js';

export const systemRouter = Router();

export const WATCH_ACTIONS = ['notify', 'pause'];

function databaseSize() {
  let total = 0;
  for (const suffix of ['', '-wal']) {
    try {
      total += statSync(`${PATHS.db}${suffix}`).size;
    } catch {
      // WAL may not exist yet.
    }
  }
  return total;
}

export function healthHandler(req, res) {
  const status = tunnel.getTunnelStatus();
  // The agent probes its own tunnel by calling the public hostname and matching this nonce.
  const probe = req.headers['x-printagent3d-probe'];
  if (probe) res.setHeader('x-printagent3d-probe', String(probe).slice(0, 64));
  if (!req.auth?.ok) {
    res.json({ ok: true, service: 'printagent3d', uptimeSeconds: Math.round(process.uptime()) });
    return;
  }
  res.json({
    ok: true,
    service: 'printagent3d',
    agent: getConfig().agent,
    version: VERSION,
    uptimeSeconds: Math.round(process.uptime()),
    platform: `${os.platform()} ${os.release()}`,
    node: process.version,
    printers: printers.summary(),
    queue: jobs.stats(),
    library: library.librarySummary(),
    tunnel: { status: status.status, url: status.url },
  });
}

systemRouter.get('/health', healthHandler);

systemRouter.get('/info', (req, res) => {
  const config = getConfig();
  res.json({
    agent: config.agent,
    version: VERSION,
    dataDir: PATHS.data,
    platform: { os: os.platform(), release: os.release(), arch: os.arch(), hostname: os.hostname() },
    node: process.version,
    printers: printers.summary(),
    queue: jobs.stats(),
    library: library.librarySummary(),
    storage: { database: PATHS.db, sizeBytes: databaseSize(), telemetry: telemetryStats() },
    local: Boolean(req.auth?.local),
    endpoints: {
      rest: `http://${config.server.host}:${config.server.port}/api`,
      websocket: `ws://${config.server.host}:${config.server.port}/ws`,
      mcp: `http://${config.server.host}:${config.server.port}/mcp`,
    },
  });
});

systemRouter.get('/logs', (req, res) => {
  res.json({ logs: recentLogs(Number(req.query.limit) || 200) });
});

systemRouter.get('/settings', (req, res) => {
  res.json({ ...publicConfig(), local: Boolean(req.auth?.local) });
});

/**
 * The fields below decide which binary the agent spawns, the printer's safety limits, or
 * whether authentication is off entirely, so accept them only from the machine running the agent.
 */
const LOCAL_ONLY_FIELDS = [
  ['files', 'allowLocalFilePath'],
  ['files', 'allowedFileRoots'],
  ['files', 'allowRemoteUrl'],
  ['files', 'allowPrivateNetworkUrl'],
  ['safety', 'allowGcode'],
  ['safety', 'blockedGcodes'],
  ['safety', 'maxNozzleTemp'],
  ['safety', 'maxBedTemp'],
  ['safety', 'maxChamberTemp'],
  ['safety', 'maxJogMm'],
  ['auth', 'enabled'],
  ['auth', 'allowLocalhostWithoutKey'],
  ['server', 'corsOrigins'],
  ['server', 'host'],
  ['server', 'port'],
  ['tunnel', 'cloudflare', 'binPath'],
  ['tunnel', 'ngrok', 'binPath'],
  ['notify', 'telegram', 'botToken'],
  ['ai', 'authType'],
  ['ai', 'apiKey'],
  ['ai', 'model'],
  ['ai', 'baseUrl'],
  ['slicer', 'binPath'],
  ['slicer', 'profilesDir'],
  ['slicer', 'userProfilesDir'],
];

function stripLocalOnly(patch) {
  const removed = [];
  for (const pathParts of LOCAL_ONLY_FIELDS) {
    let node = patch;
    for (let index = 0; index < pathParts.length - 1; index += 1) {
      node = node?.[pathParts[index]];
      if (!node || typeof node !== 'object') break;
    }
    const leaf = pathParts.at(-1);
    if (node && typeof node === 'object' && leaf in node) {
      delete node[leaf];
      removed.push(pathParts.join('.'));
    }
  }
  return removed;
}

const NUMERIC_RANGES = [
  [['files', 'maxUploadMb'], 1, 10240],
  [['queue', 'keepJobs'], 20, 100000],
  [['safety', 'maxNozzleTemp'], 0, 500],
  [['safety', 'maxBedTemp'], 0, 200],
  [['safety', 'maxChamberTemp'], 0, 120],
  [['safety', 'maxJogMm'], 1, 1000],
  [['monitoring', 'pollIntervalMs'], 500, 60000],
  [['monitoring', 'historyDays'], 1, 3650],
  [['slicer', 'timeoutSec'], 30, 7200],
  [['server', 'port'], 1, 65535],
  [['costs', 'electricityPerKwh'], 0, 10000000],
  [['costs', 'defaultPowerW'], 0, 10000],
  [['costs', 'defaultPricePerKg'], 0, 1000000000],
];

function validateNumbers(patch) {
  for (const [[section, key], min, max] of NUMERIC_RANGES) {
    const value = patch?.[section]?.[key];
    if (value === undefined) continue;
    const number = Number(value);
    if (!Number.isFinite(number) || number < min || number > max) {
      throw badRequest('error.setting_invalid', { field: `${section}.${key}`, min, max });
    }
    patch[section][key] = number;
  }
}

systemRouter.put('/settings', (req, res) => {
  const patch = structuredClone(req.body ?? {});
  if (patch.agent?.locale && !LOCALES.includes(patch.agent.locale)) {
    throw badRequest('error.locale_unsupported', { locale: patch.agent.locale, supported: LOCALES.join(', ') });
  }
  if (patch.auth) delete patch.auth.apiKeys;
  if (patch.agent) delete patch.agent.id;
  if (patch.ai?.apiKey === '***') delete patch.ai.apiKey;
  if (patch.ai?.authType !== undefined && !AUTH_TYPES.includes(patch.ai.authType)) {
    throw badRequest('error.field_invalid', { field: 'ai.authType' });
  }
  if (patch.notify?.telegram?.botToken === '***') delete patch.notify.telegram.botToken;
  if (patch.notify?.telegram?.events !== undefined) {
    const events = [].concat(patch.notify.telegram.events).map((item) => String(item));
    if (events.some((item) => !NOTIFY_EVENTS.includes(item))) throw badRequest('error.field_invalid', { field: 'notify.telegram.events' });
    patch.notify.telegram.events = events;
  }
  if (patch.watch?.onDetect !== undefined && !WATCH_ACTIONS.includes(patch.watch.onDetect)) {
    throw badRequest('error.field_invalid', { field: 'watch.onDetect' });
  }
  if (patch.watch?.minConfidence !== undefined) {
    const value = Number(patch.watch.minConfidence);
    if (!Number.isFinite(value) || value < 0.3 || value > 1) throw badRequest('error.field_invalid', { field: 'watch.minConfidence' });
    patch.watch.minConfidence = value;
  }
  if (patch.watch?.intervalMin !== undefined) {
    const value = Number(patch.watch.intervalMin);
    if (!Number.isFinite(value) || value < 1 || value > 120) throw badRequest('error.field_invalid', { field: 'watch.intervalMin' });
    patch.watch.intervalMin = Math.round(value);
  }
  if (patch.tunnel?.cloudflare?.token === '***') delete patch.tunnel.cloudflare.token;
  if (patch.tunnel?.ngrok?.authtoken === '***') delete patch.tunnel.ngrok.authtoken;
  const rejected = req.auth?.local ? [] : stripLocalOnly(patch);
  if (patch.auth?.enabled === false && tunnel.getTunnelStatus().status === 'running') {
    throw badRequest('error.auth_off_while_tunnel');
  }
  if (patch.safety?.blockedGcodes) {
    patch.safety.blockedGcodes = [].concat(patch.safety.blockedGcodes).map((code) => String(code).trim().toUpperCase()).filter(Boolean);
  }
  validateNumbers(patch);
  if (patch.costs?.currency !== undefined) {
    const currency = String(patch.costs.currency ?? '').trim().toUpperCase().slice(0, 8);
    if (!currency) throw badRequest('error.field_invalid', { field: 'costs.currency' });
    patch.costs.currency = currency;
  }
  updateConfig(patch);
  if (patch.agent?.locale) setLocale(getConfig().agent.locale);
  res.json({ ...publicConfig(), local: Boolean(req.auth?.local), rejectedFields: rejected });
});

systemRouter.get('/apikeys', (req, res) => {
  res.json({ apiKeys: publicConfig().auth.apiKeys });
});

systemRouter.post('/apikeys', (req, res) => {
  requireLocal(req);
  const name = String(req.body?.name ?? '').trim().slice(0, 60) || 'key';
  const config = getConfig();
  const entry = { id: shortId('key'), name, key: apiKeyValue(), createdAt: new Date().toISOString(), lastUsedAt: null };
  config.auth.apiKeys.push(entry);
  saveConfig(config);
  res.status(201).json(entry);
});

systemRouter.get('/apikeys/:id/reveal', (req, res) => {
  requireLocal(req);
  const entry = getConfig().auth.apiKeys.find((item) => item.id === req.params.id);
  if (!entry) throw notFound('error.apikey_not_found');
  res.json(entry);
});

systemRouter.delete('/apikeys/:id', (req, res) => {
  requireLocal(req);
  const config = getConfig();
  const index = config.auth.apiKeys.findIndex((item) => item.id === req.params.id);
  if (index < 0) throw notFound('error.apikey_not_found');
  if (config.auth.apiKeys.length === 1) throw badRequest('error.apikey_last_one');
  config.auth.apiKeys.splice(index, 1);
  saveConfig(config);
  res.json({ deleted: true });
});

systemRouter.get('/prompts', (req, res) => {
  res.json({ prompts: listPrompts(), dir: promptsDir() });
});

systemRouter.get('/prompts/:name', (req, res) => {
  res.json(getPrompt(req.params.name));
});

systemRouter.put('/prompts/:name', (req, res) => {
  // Prompts drive what the agent tells the model; if editable remotely, anyone with a key could change them.
  requireLocal(req);
  res.json(savePrompt(req.params.name, req.body?.text));
});

systemRouter.delete('/prompts/:name', (req, res) => {
  requireLocal(req);
  res.json(resetPrompt(req.params.name));
});

systemRouter.get(
  '/service',
  wrap(async (req, res) => {
    res.json(await serviceStatus());
  }),
);

systemRouter.post(
  '/service',
  wrap(async (req, res) => {
    requireLocal(req);
    const action = String(req.body?.action ?? 'install');
    if (action === 'uninstall') await uninstallService();
    else if (action === 'install') await installService();
    else throw badRequest('error.service_action_invalid');
    res.json(await serviceStatus());
  }),
);

systemRouter.post(
  '/notify/test',
  wrap(async (req, res) => {
    // Remote machines may only test with the stored token, not borrow the agent to call Telegram with an arbitrary one.
    const botToken = req.auth?.local ? req.body?.botToken : null;
    res.json(await testTelegram({ botToken, chatId: req.body?.chatId }));
  }),
);

systemRouter.get(
  '/tunnel',
  wrap(async (req, res) => {
    res.json({
      status: tunnel.getTunnelStatus(),
      config: publicConfig().tunnel,
      binaries: await tunnel.detectBinaries(),
      exposureIssue: tunnel.tunnelExposureIssue(),
    });
  }),
);

systemRouter.post(
  '/tunnel/start',
  wrap(async (req, res) => {
    res.json(await tunnel.startTunnel({ provider: req.body?.provider }));
  }),
);

systemRouter.post(
  '/tunnel/stop',
  wrap(async (req, res) => {
    res.json(await tunnel.stopTunnel());
  }),
);
