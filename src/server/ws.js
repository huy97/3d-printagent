import { WebSocketServer } from 'ws';
import { URL } from 'node:url';
import { authorize, verifyKey, isSameOrigin, isSelfServedOrigin } from './auth.js';
import { blockedFor, recordAuthFailure, recordAuthSuccess } from './guard.js';
import * as jobs from '../core/jobs.js';
import * as printers from '../core/printers.js';
import * as library from '../core/library.js';
import { describeDrivers } from '../drivers/index.js';
import { getConfig } from '../core/config.js';
import { getTunnelStatus, tunnelEvents } from '../core/tunnel.js';
import { t, localeFromAcceptLanguage, localizePayload, normalizeLocale, getLocale } from '../i18n/index.js';
import { logEvents, createLogger } from '../util/logger.js';
import { shortId } from '../util/id.js';
import { AppError, badRequest, serializeError, unauthorized } from '../util/errors.js';

const log = createLogger('ws');

export const WS_CHANNELS = ['status', 'printer', 'job', 'file', 'tunnel', 'log'];
const DEFAULT_CHANNELS = ['status', 'printer', 'job', 'file', 'tunnel'];
const BAD_JSON = new AppError('ws.bad_json', { status: 400, code: 'bad_json' });

function snapshotState() {
  return {
    agent: getConfig().agent,
    printers: printers.listPrinters(),
    queue: jobs.stats(),
    library: library.librarySummary(),
    tunnel: getTunnelStatus(),
  };
}

const HANDLERS = {
  ping: async () => ({ pong: Date.now() }),
  status: async () => snapshotState(),
  'drivers.list': async () => ({ drivers: describeDrivers() }),
  'printers.list': async () => ({ printers: printers.listPrinters(), summary: printers.summary() }),
  'printer.get': async (payload) => printers.getPrinter(payload.printerId ?? payload.id),
  'printer.status': async (payload) => printers.statusOf(printers.getRecord(payload.printerId ?? payload.id).id),
  'printer.command': async (payload, context) => {
    if (!payload.action) throw badRequest('error.field_required', { field: 'action' });
    return printers.command(payload.printerId ?? payload.id, payload.action, payload.params ?? {}, { origin: context.origin });
  },
  'printer.files': async (payload) => ({ files: await printers.listPrinterFiles(payload.printerId ?? payload.id) }),
  'printer.bedCleared': async (payload) => printers.setBedClear(payload.printerId ?? payload.id, payload.clear !== false),
  'files.list': async (payload) => ({ files: library.listFiles(payload ?? {}), summary: library.librarySummary() }),
  'file.get': async (payload) => library.getFile(payload.fileId ?? payload.id),
  'jobs.list': async (payload) => ({ jobs: jobs.listJobs(payload ?? {}), stats: jobs.stats() }),
  'job.get': async (payload) => jobs.getJob(payload.jobId ?? payload.id),
  'job.start': async (payload) => jobs.startJob(payload.jobId ?? payload.id, payload),
  'job.cancel': async (payload) => jobs.cancelJob(payload.jobId ?? payload.id, payload),
  'print.start': async (payload, context) => jobs.createJob({ ...payload, origin: context.origin }),
  'print.batch': async (payload, context) => jobs.createBatch({ ...payload, origin: context.origin }),
  'tunnel.status': async () => getTunnelStatus(),
};

export function attachWebSocket(server) {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 1024 * 1024,
    verifyClient: ({ req }, done) => {
      if (blockedFor(req) > 0) {
        done(false, 429, 'too many attempts');
        return;
      }
      const origins = getConfig().server.corsOrigins ?? [];
      const origin = req.headers.origin;
      // Browsers set Origin: accept only same-origin or a declared origin.
      if (!origin || isSameOrigin(req) || isSelfServedOrigin(req) || origins.includes('*') || origins.includes(origin)) {
        done(true);
        return;
      }
      log.warn(t('ws.origin_rejected', { origin }));
      done(false, 403, 'origin not allowed');
    },
  });
  const clients = new Set();

  // ws re-emits http server errors; leaving them unhandled crashes the process.
  wss.on('error', (error) => log.error(`WebSocket: ${error.message}`));

  wss.on('connection', (socket, request) => {
    const url = new URL(request.url, 'http://localhost');
    const fakeReq = {
      headers: request.headers,
      socket: request.socket,
      query: { apiKey: url.searchParams.get('apiKey') ?? url.searchParams.get('api_key') },
    };
    const auth = authorize(fakeReq);
    const locale = normalizeLocale(url.searchParams.get('lang') || localeFromAcceptLanguage(request.headers['accept-language']) || getLocale());

    const client = {
      id: shortId('ws'),
      socket,
      locale,
      authorized: auth.ok,
      subscriptions: new Set(DEFAULT_CHANNELS),
      keyName: auth.key?.name ?? null,
      alive: true,
    };
    clients.add(client);

    const reply = (message) => send(socket, message, locale);
    const fail = (id, error, extra) => reply({ id, type: 'error', payload: { ...serializeError(error, locale), ...extra } });
    const welcome = () => reply({ type: 'welcome', payload: { clientId: client.id, ...snapshotState() } });

    if (!auth.ok) {
      reply({ type: 'auth_required', key: 'ws.auth_required', message: t('ws.auth_required', null, locale) });
      setTimeout(() => {
        if (!client.authorized) {
          fail(undefined, unauthorized('ws.unauthorized'));
          socket.close(4401, 'unauthorized');
        }
      }, 10000).unref?.();
    } else {
      welcome();
    }

    socket.on('pong', () => {
      client.alive = true;
    });

    socket.on('message', async (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        fail(undefined, BAD_JSON);
        return;
      }

      if (message.type === 'auth') {
        const entry = verifyKey(message.payload?.apiKey);
        if (entry) {
          recordAuthSuccess(request);
          client.authorized = true;
          client.keyName = entry.name;
          reply({ id: message.id, type: 'result', payload: { authorized: true, clientId: client.id } });
          welcome();
        } else {
          recordAuthFailure(request);
          fail(message.id, unauthorized('ws.key_invalid'));
          socket.close(4401, 'unauthorized');
        }
        return;
      }

      if (!client.authorized) {
        fail(message.id, unauthorized('ws.unauthorized'));
        return;
      }

      if (message.type === 'subscribe') {
        const requested = message.payload?.events ?? message.payload?.channels ?? DEFAULT_CHANNELS;
        client.subscriptions = new Set([].concat(requested).filter((item) => WS_CHANNELS.includes(item)));
        reply({ id: message.id, type: 'result', payload: { subscriptions: [...client.subscriptions] } });
        return;
      }

      const handler = HANDLERS[message.type];
      if (!handler) {
        fail(message.id, badRequest('ws.unknown_command', { type: String(message.type ?? '') }), {
          supported: ['auth', 'subscribe', ...Object.keys(HANDLERS)],
        });
        return;
      }

      try {
        const result = await handler(message.payload ?? {}, { origin: `ws:${client.keyName ?? 'local'}`, clientId: client.id });
        reply({ id: message.id, type: 'result', payload: result });
      } catch (error) {
        fail(message.id, error);
      }
    });

    socket.on('close', () => clients.delete(client));
    socket.on('error', () => clients.delete(client));
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.socket.terminate();
        clients.delete(client);
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }, 30000);
  heartbeat.unref?.();
  wss.on('close', () => clearInterval(heartbeat));

  function broadcast(channel, event, payload) {
    const message = { type: 'event', event, payload, at: new Date().toISOString() };
    const encoded = new Map();
    for (const client of clients) {
      if (!client.authorized || !client.subscriptions.has(channel)) continue;
      if (client.socket.readyState !== client.socket.OPEN) continue;
      if (!encoded.has(client.locale)) encoded.set(client.locale, JSON.stringify(localizePayload(message, client.locale)));
      client.socket.send(encoded.get(client.locale));
    }
  }

  printers.printerEvents.on('status', (payload) => broadcast('status', 'printer.status', payload));
  printers.printerEvents.on('changed', (payload) => broadcast('printer', 'printer.changed', payload));
  jobs.jobEvents.on('job', ({ event, job }) => broadcast('job', `job.${event}`, job));
  library.libraryEvents.on('file', ({ event, file }) => broadcast('file', `file.${event}`, file));
  tunnelEvents.on('changed', (payload) => broadcast('tunnel', 'tunnel.changed', payload));
  logEvents.on('log', (entry) => broadcast('log', 'log', entry));

  return { wss, broadcast, clients };
}

function send(socket, message, locale) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(localizePayload(message, locale)));
}
