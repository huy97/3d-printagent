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
import { t, localeFromAcceptLanguage, normalizeLocale, getLocale } from '../i18n/index.js';
import { logEvents, createLogger } from '../util/logger.js';
import { shortId } from '../util/id.js';
import { badRequest } from '../util/errors.js';

const log = createLogger('ws');

export const WS_CHANNELS = ['status', 'printer', 'job', 'file', 'tunnel', 'log'];
const DEFAULT_CHANNELS = ['status', 'printer', 'job', 'file', 'tunnel'];

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

    const welcome = () => send(socket, { type: 'welcome', payload: { clientId: client.id, ...snapshotState() } });

    if (!auth.ok) {
      send(socket, { type: 'auth_required', message: t('ws.auth_required', null, locale) });
      setTimeout(() => {
        if (!client.authorized) {
          send(socket, { type: 'error', payload: { message: t('ws.unauthorized', null, locale) } });
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
        send(socket, { type: 'error', payload: { message: t('ws.bad_json', null, locale) } });
        return;
      }

      if (message.type === 'auth') {
        const entry = verifyKey(message.payload?.apiKey);
        if (entry) {
          recordAuthSuccess(request);
          client.authorized = true;
          client.keyName = entry.name;
          send(socket, { id: message.id, type: 'result', payload: { authorized: true, clientId: client.id } });
          welcome();
        } else {
          recordAuthFailure(request);
          send(socket, { id: message.id, type: 'error', payload: { message: t('ws.key_invalid', null, locale) } });
          socket.close(4401, 'unauthorized');
        }
        return;
      }

      if (!client.authorized) {
        send(socket, { id: message.id, type: 'error', payload: { message: t('ws.unauthorized', null, locale) } });
        return;
      }

      if (message.type === 'subscribe') {
        const requested = message.payload?.events ?? message.payload?.channels ?? DEFAULT_CHANNELS;
        client.subscriptions = new Set([].concat(requested).filter((item) => WS_CHANNELS.includes(item)));
        send(socket, { id: message.id, type: 'result', payload: { subscriptions: [...client.subscriptions] } });
        return;
      }

      const handler = HANDLERS[message.type];
      if (!handler) {
        send(socket, {
          id: message.id,
          type: 'error',
          payload: {
            message: t('ws.unknown_command', { type: String(message.type ?? '') }, locale),
            supported: ['auth', 'subscribe', ...Object.keys(HANDLERS)],
          },
        });
        return;
      }

      try {
        const result = await handler(message.payload ?? {}, { origin: `ws:${client.keyName ?? 'local'}`, clientId: client.id });
        send(socket, { id: message.id, type: 'result', payload: result });
      } catch (error) {
        send(socket, {
          id: message.id,
          type: 'error',
          payload: {
            message: typeof error.localize === 'function' ? error.localize(locale) : error.message,
            code: error.code ?? 'error',
            key: error.key,
          },
        });
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
    const message = JSON.stringify({ type: 'event', event, payload, at: new Date().toISOString() });
    for (const client of clients) {
      if (!client.authorized || !client.subscriptions.has(channel)) continue;
      if (client.socket.readyState === client.socket.OPEN) client.socket.send(message);
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

function send(socket, message) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}
