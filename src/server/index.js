import http from 'node:http';
import path from 'node:path';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { getConfig } from '../core/config.js';
import { PATHS, ensureDataDirs } from '../core/paths.js';
import { configureLogger, createLogger } from '../util/logger.js';
import { requireAuth, authorize } from './auth.js';
import { systemRouter, healthHandler } from './routes/system.js';
import { printersRouter, driversHandler } from './routes/printers.js';
import { filesRouter, printRouter } from './routes/files.js';
import { jobsRouter } from './routes/jobs.js';
import { slicerRouter } from './routes/slicer.js';
import { attachWebSocket } from './ws.js';
import { createMcpHttpHandler } from '../mcp/http.js';
import { createLocalApi } from '../mcp/api.js';
import { buildOpenApi } from './openapi.js';
import { loadHmsCatalog } from '../core/hms.js';
import * as printers from '../core/printers.js';
import * as library from '../core/library.js';
import * as jobs from '../core/jobs.js';
import { autoStartTunnel, stopTunnel } from '../core/tunnel.js';
import { startBambuListener, stopBambuListener } from '../core/discovery.js';
import { startNotifier, stopNotifier } from '../core/notify.js';
import { startInsights, stopInsights } from '../core/insights.js';
import { insightsRouter } from './routes/insights.js';
import { startWatcher, stopWatcher } from '../core/watch.js';
import { closeDb } from '../core/db.js';
import { AppError } from '../util/errors.js';
import { VERSION } from '../util/version.js';
import { t, localeFromRequest, setLocale, LOCALES } from '../i18n/index.js';

const log = createLogger('server');
const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const webDir = path.join(rootDir, 'web');
const API_PREFIXES = ['/api', '/ws', '/mcp', '/openapi.json', '/llms.txt', '/.well-known'];

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(express.json({ limit: '64mb' }));
  app.use(express.urlencoded({ extended: true, limit: '16mb' }));

  app.use((req, res, next) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'SAMEORIGIN');
    next();
  });

  app.use((req, res, next) => {
    const origins = getConfig().server.corsOrigins ?? [];
    const origin = req.headers.origin;
    const allowed = origin && (origins.includes('*') || origins.includes(origin));
    if (allowed) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-headers', 'content-type,x-api-key,authorization,mcp-session-id,x-locale');
      res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('access-control-expose-headers', 'mcp-session-id');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(allowed ? 204 : 403);
      return;
    }
    next();
  });

  app.get('/api/health', (req, res) => {
    req.auth = authorize(req);
    healthHandler(req, res);
  });

  app.use('/api', requireAuth);
  app.use('/api', systemRouter);
  app.get('/api/drivers', driversHandler);
  app.use('/api/printers', printersRouter);
  app.use('/api/files', filesRouter);
  app.use('/api/jobs', jobsRouter);
  app.use('/api/print', printRouter);
  app.use('/api/slicer', slicerRouter);
  app.use('/api', insightsRouter);

  app.all('/mcp', requireAuth, createMcpHttpHandler(createLocalApi()));

  app.get('/llms.txt', (req, res) => {
    const locale = localeFromRequest(req);
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('content-language', locale);
    res.setHeader('cache-control', 'no-store');
    res.sendFile(path.join(rootDir, locale === 'vi' ? 'llms.txt' : `llms.${locale}.txt`));
  });

  app.get('/openapi.json', (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.json(buildOpenApi(`${req.protocol}://${req.get('host')}`));
  });

  // Điểm khám phá cho tác nhân AI: một request là biết agent có gì và đọc tiếp ở đâu.
  app.get('/.well-known/3d-printagent.json', (req, res) => {
    const base = `${req.protocol}://${req.get('host')}`;
    const locale = localeFromRequest(req);
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-language', locale);
    res.json({
      name: '3D PrintAgent',
      description: t('discovery.description', null, locale),
      version: VERSION,
      docs: {
        llms: `${base}/llms.txt`,
        openapi: `${base}/openapi.json`,
        llmsByLanguage: Object.fromEntries(LOCALES.map((item) => [item, `${base}/llms.txt?lang=${item}`])),
      },
      endpoints: { rest: `${base}/api`, websocket: `${base.replace(/^http/, 'ws')}/ws`, mcp: `${base}/mcp` },
      auth: { header: 'x-api-key', alternatives: ['Authorization: Bearer', '?apiKey='] },
      language: { current: locale, supported: LOCALES, select: ['x-locale', '?lang=', 'accept-language'] },
    });
  });

  app.use(
    express.static(webDir, {
      index: false,
      maxAge: '1y',
      immutable: true,
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) res.setHeader('cache-control', 'no-store');
      },
    }),
  );
  const sendIndex = (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.sendFile(path.join(webDir, 'index.html'), (error) => {
      if (error && !res.headersSent) res.status(404).type('text').send(t('server.ui_missing'));
    });
  };
  app.get('/', sendIndex);

  // Route của UI nằm phía client (/printers/prn_x...), nên mọi GET trang phải trả index.html để F5 không mất trang.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (API_PREFIXES.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`))) return next();
    if (path.extname(req.path) || !req.accepts('html')) return next();
    sendIndex(req, res);
  });

  app.use((req, res) => {
    const locale = localeFromRequest(req);
    res.status(404).json({
      error: {
        code: 'not_found',
        key: 'error.no_route',
        message: t('error.no_route', { method: req.method, path: req.path }, locale),
      },
    });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    const isApp = error instanceof AppError;
    const status = isApp ? error.status : error.type === 'entity.too.large' ? 413 : (error.status ?? 500);
    if (status >= 500) log.error(`${req.method} ${req.path} -> ${error.message}`);
    const locale = localeFromRequest(req);
    res.setHeader('content-language', locale);
    res.status(status).json({
      error: {
        code: error.code ?? (status >= 500 ? 'internal_error' : 'bad_request'),
        key: isApp ? error.key : undefined,
        message: isApp ? error.localize(locale) : (error.message ?? t('error.unknown', null, locale)),
        details: error.details,
      },
    });
  });

  return app;
}

function cleanupTemp(maxAgeMs = 24 * 3600 * 1000) {
  const cutoff = Date.now() - maxAgeMs;
  let entries = [];
  try {
    entries = readdirSync(PATHS.tmp);
  } catch {
    return;
  }
  for (const entry of entries) {
    const file = path.join(PATHS.tmp, entry);
    try {
      if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true, recursive: true });
    } catch {
      // file đang được ghi dở
    }
  }
}

export async function startServer({ port, host } = {}) {
  ensureDataDirs();
  configureLogger({ dir: PATHS.logs });
  const config = getConfig();
  setLocale(process.env.PRINTAGENT3D_LANG || config.agent.locale);
  const listenPort = port ?? (process.env.PORT ? Number(process.env.PORT) : config.server.port);
  const listenHost = host ?? config.server.host;

  printers.loadPrinters();
  library.loadLibrary();
  jobs.loadJobs();
  loadHmsCatalog();
  cleanupTemp();

  const app = createApp();
  const server = http.createServer(app);
  attachWebSocket(server);

  await new Promise((resolve, reject) => {
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(t('server.port_in_use', { port: listenPort })));
        return;
      }
      reject(error);
    });
    server.listen(listenPort, listenHost, resolve);
  });

  await printers.startAll();
  jobs.startQueue();
  startBambuListener();
  // Sổ in phải chạy trước thông báo để tin Telegram có sẵn số nhựa và chi phí của job.
  startInsights();
  startNotifier();
  startWatcher();

  const cleanupTimer = setInterval(() => cleanupTemp(), 3600 * 1000);
  cleanupTimer.unref?.();

  const local = `http://127.0.0.1:${listenPort}`;
  log.info(t('server.started', { url: local, host: listenHost, port: listenPort }));
  log.info(`Web UI: ${local}  |  REST: ${local}/api  |  WS: ws://127.0.0.1:${listenPort}/ws  |  MCP: ${local}/mcp`);

  autoStartTunnel().then((status) => {
    if (status?.url) log.info(t('tunnel.log.public_url', { url: status.url }));
  });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log.info(t('server.stopping'));
    clearInterval(cleanupTimer);
    jobs.stopQueue();
    stopBambuListener();
    stopNotifier();
    stopInsights();
    stopWatcher();
    await Promise.race([
      Promise.all([printers.stopAll(), stopTunnel().catch(() => {})]),
      new Promise((resolve) => setTimeout(resolve, 4000)),
    ]);
    const exit = () => {
      closeDb();
      process.exit(0);
    };
    server.close(exit);
    setTimeout(exit, 2000).unref?.();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { server, app, port: listenPort, host: listenHost, shutdown };
}
