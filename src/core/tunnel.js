import { spawn } from 'node:child_process';
import os from 'node:os';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { getConfig, updateConfig } from './config.js';
import { tryRun } from '../util/exec.js';
import { createLogger } from '../util/logger.js';
import { badRequest } from '../util/errors.js';
import { t } from '../i18n/index.js';

const log = createLogger('tunnel');
export const tunnelEvents = new EventEmitter();

const URL_PATTERNS = [
  /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i,
  /url=(https:\/\/[^\s"']+)/i,
  /"url":"(https:\/\/[^"]+)"/i,
];

const CONNECTION_PATTERN = /Registered tunnel connection|Connection [0-9a-f-]+ registered/i;

const state = {
  provider: null,
  status: 'stopped',
  url: null,
  pid: null,
  startedAt: null,
  error: null,
  warning: null,
  logs: [],
};

let child = null;

function pushLog(line) {
  const text = String(line).trimEnd();
  if (!text) return;
  state.logs.push(`${new Date().toISOString()} ${text}`);
  if (state.logs.length > 200) state.logs.shift();
  tunnelEvents.emit('log', text);
}

function setState(patch) {
  Object.assign(state, patch);
  tunnelEvents.emit('changed', getTunnelStatus());
}

export function getTunnelStatus() {
  return { ...state, logs: state.logs.slice(-50) };
}

export async function detectBinaries() {
  const which = os.platform() === 'win32' ? 'where' : 'which';
  const config = getConfig().tunnel ?? {};
  const results = {};
  for (const [provider, binName] of [
    ['cloudflare', config.cloudflare?.binPath || 'cloudflared'],
    ['ngrok', config.ngrok?.binPath || 'ngrok'],
  ]) {
    const found = await tryRun(which, [binName]);
    const path = found.failed ? null : found.stdout.split('\n')[0].trim();
    let version = null;
    if (path) {
      const versionResult = await tryRun(binName, [provider === 'ngrok' ? 'version' : '--version']);
      version = versionResult.failed ? null : versionResult.stdout.trim().split('\n')[0];
    }
    results[provider] = { installed: Boolean(path), path, version, install: installHint(provider) };
  }
  return results;
}

function installHint(provider) {
  const platform = os.platform();
  if (provider === 'cloudflare') {
    if (platform === 'darwin') return 'brew install cloudflared';
    if (platform === 'win32') return 'winget install --id Cloudflare.cloudflared';
    return 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';
  }
  if (platform === 'darwin') return 'brew install ngrok';
  if (platform === 'win32') return 'winget install --id Ngrok.Ngrok';
  return 'https://ngrok.com/download';
}

function buildCommand(provider, config, port) {
  if (provider === 'cloudflare') {
    const bin = config.cloudflare?.binPath || 'cloudflared';
    const origin = `http://127.0.0.1:${port}`;
    if (config.cloudflare?.token) {
      // --url must come before "run"; a dashboard-managed tunnel uses remote ingress and ignores this flag.
      return { bin, args: ['tunnel', '--no-autoupdate', '--url', origin, 'run', '--token', config.cloudflare.token] };
    }
    return { bin, args: ['tunnel', '--no-autoupdate', '--url', origin] };
  }
  if (provider === 'ngrok') {
    const bin = config.ngrok?.binPath || 'ngrok';
    const args = ['http', String(port), '--log=stdout', '--log-format=logfmt'];
    if (config.ngrok?.domain) args.push(`--domain=${config.ngrok.domain}`);
    if (config.ngrok?.authtoken) args.push(`--authtoken=${config.ngrok.authtoken}`);
    if (config.ngrok?.region) args.push(`--region=${config.ngrok.region}`);
    return { bin, args };
  }
  throw badRequest('error.tunnel_provider_unsupported', { provider });
}

/** A named tunnel token is base64 JSON holding the account (a), tunnel id (t) and secret (s). */
function decodeTunnelId(token) {
  try {
    const raw = String(token).trim().replace(/-/g, '+').replace(/_/g, '/');
    const padded = raw + '='.repeat((4 - (raw.length % 4)) % 4);
    const data = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    return typeof data?.t === 'string' ? data.t : null;
  } catch {
    return null;
  }
}

function commandTunnelId(command) {
  const token = command.match(/--token[=\s]+([A-Za-z0-9+/=_-]{40,})/)?.[1];
  if (token) return decodeTunnelId(token);
  return command.match(/\brun\b[^|]*?\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i)?.[1] ?? null;
}

/**
 * Two connectors on the same tunnel make Cloudflare load balance between them, and requests landing
 * on the old connector break. Warn early instead of leaving the user to figure it out.
 */
async function findRivalConnectors(tunnelId) {
  if (!tunnelId || os.platform() === 'win32') return [];
  const result = await tryRun('ps', ['-Ao', 'pid=,command=']);
  if (result.failed) return [];
  const rivals = [];
  for (const line of result.stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    const [, pid, command] = match;
    if (!command.includes('cloudflared') || !command.includes('tunnel')) continue;
    if (Number(pid) === state.pid) continue;
    if (commandTunnelId(command) === tunnelId) rivals.push(Number(pid));
  }
  return rivals;
}

/** Calls the public hostname directly to check it really reaches this agent. */
async function probeHostname(hostname, timeoutMs = 8000) {
  const nonce = crypto.randomUUID();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`https://${hostname}/api/health`, {
      signal: controller.signal,
      headers: { 'x-printagent3d-probe': nonce, 'cache-control': 'no-cache' },
    });
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
    if (response.headers.get('x-printagent3d-probe') === nonce) return { ok: true };
    const body = await response.json().catch(() => null);
    if (body?.service === 'printagent3d' || body?.agent) return { ok: false, detail: 'other-agent' };
    return { ok: false, detail: 'not-printagent3d' };
  } catch (error) {
    if (error.name === 'AbortError') return { ok: false, detail: 'timeout' };
    return { ok: false, detail: error.cause?.message ?? error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function verifyNamedTunnel(cloudflare, port) {
  const hostname = String(cloudflare.hostname ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!hostname) {
    setWarning(t('tunnel.warn_hostname_missing'));
    return;
  }
  setState({ url: `https://${hostname}`, status: 'running' });
  void verifyPublicUrl(`https://${hostname}`, port, 'tunnel.warn_hostname_unreachable');
}

/** A tunnel with a URL is not necessarily reachable: the edge needs a few seconds to route to the connector. */
// Probe fast right after start, then back off: quick tunnel DNS can take minutes to propagate.
const PROBE_SCHEDULE = [2000, 3000, 5000, 8000, 12000, 60000, 60000, 60000, 60000];
const PROBE_WARN_AT = 4;

let verifyToken = 0;

async function verifyPublicUrl(url, port, warningKey = 'tunnel.warn_url_unreachable') {
  const hostname = new URL(url).hostname;
  const token = ++verifyToken;
  for (let attempt = 0; attempt <= PROBE_SCHEDULE.length; attempt += 1) {
    if (!child || token !== verifyToken) return;
    const probe = await probeHostname(hostname);
    if (probe.ok) {
      setWarning(null);
      log.info(t('tunnel.log.verified', { url }));
      return;
    }
    if (attempt === PROBE_WARN_AT) {
      const text = t(warningKey, { hostname, port, detail: probe.detail });
      setWarning(text);
      log.warn(text);
    }
    if (attempt < PROBE_SCHEDULE.length) await delay(PROBE_SCHEDULE[attempt]);
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

let rivalWarning = null;

function setWarning(text) {
  const merged = [rivalWarning, text].filter(Boolean).join(' ');
  setState({ warning: merged || null });
}

/** The agent should only face the Internet while API keys are required and at least one key exists. */
export function tunnelExposureIssue(config = getConfig()) {
  if (!config.auth.enabled) return 'auth_disabled';
  if (config.auth.apiKeys.length === 0) return 'no_api_key';
  return null;
}

export async function startTunnel({ provider } = {}) {
  const config = getConfig();
  const tunnelConfig = config.tunnel ?? {};
  const chosen = provider || tunnelConfig.provider;
  if (!chosen || chosen === 'none') throw badRequest('error.tunnel_provider_missing');
  // Exposing the agent with auth disabled means anyone can print, so block it right here.
  const exposure = tunnelExposureIssue(config);
  if (exposure) throw badRequest(`error.tunnel_unsafe_${exposure}`);
  if (child) await stopTunnel();

  const port = config.server.port;
  const { bin, args } = buildCommand(chosen, tunnelConfig, port);

  const detected = await detectBinaries();
  if (!detected[chosen].installed) {
    throw badRequest('error.tunnel_binary_missing', { bin, install: detected[chosen].install }, detected[chosen]);
  }

  const named = chosen === 'cloudflare' && Boolean(tunnelConfig.cloudflare?.token);
  rivalWarning = null;
  if (named) {
    const rivals = await findRivalConnectors(decodeTunnelId(tunnelConfig.cloudflare.token));
    if (rivals.length) {
      rivalWarning = t('tunnel.warn_duplicate_connector', { pids: rivals.join(', ') });
      log.warn(rivalWarning);
    }
  }

  log.info(t('tunnel.log.starting', { provider: chosen, command: `${bin} ${maskArgs(args).join(' ')}` }));
  setState({
    provider: chosen,
    status: 'starting',
    url: null,
    error: null,
    warning: rivalWarning,
    logs: [],
    startedAt: new Date().toISOString(),
  });

  child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  state.pid = child.pid;
  let connected = false;

  const handleOutput = (chunk) => {
    const text = String(chunk);
    pushLog(text);
    if (!connected && CONNECTION_PATTERN.test(text)) {
      connected = true;
      tunnelEvents.emit('connected');
    }
    if (state.url) return;
    for (const pattern of URL_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        const url = (match[1] ?? match[0]).replace(/[",]$/, '');
        if (url.includes('ngrok') || url.includes('trycloudflare') || chosen === 'ngrok') {
          setState({ url, status: 'running' });
          log.info(t('tunnel.log.public_url', { url }));
          return;
        }
      }
    }
  };

  child.stdout.on('data', handleOutput);
  child.stderr.on('data', handleOutput);

  child.on('exit', (code, signal) => {
    child = null;
    const stopped = state.status === 'stopping';
    setState({
      status: stopped ? 'stopped' : 'error',
      pid: null,
      error: stopped ? null : t('tunnel.log.exited', { code: code ?? signal }),
      warning: null,
      url: null,
    });
    log.warn(t('tunnel.log.stopped', { provider: chosen, code: code ?? signal }));
  });

  child.on('error', (error) => {
    setState({ status: 'error', error: error.message });
    log.error(t('tunnel.log.spawn_failed', { message: error.message }));
  });

  if (named) {
    await waitForConnection(20000);
    if (child) await verifyNamedTunnel(tunnelConfig.cloudflare, port);

    return getTunnelStatus();
  }

  await waitForUrl(15000);
  if (child && state.url) void verifyPublicUrl(state.url, port);
  return getTunnelStatus();
}

/** Keeps tokens out of logs and the UI. */
function maskArgs(args) {
  return args.map((arg, index) =>
    args[index - 1] === '--token' || args[index - 1] === '--authtoken' ? '***' : arg,
  );
}

function waitForConnection(timeoutMs) {
  return new Promise((resolve) => {
    if (state.status === 'error') {
      resolve();
      return;
    }
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    function onChange() {
      if (state.status === 'error') finish();
    }
    function finish() {
      clearTimeout(timer);
      tunnelEvents.off('connected', finish);
      tunnelEvents.off('changed', onChange);
      resolve();
    }
    tunnelEvents.once('connected', finish);
    tunnelEvents.on('changed', onChange);
  });
}

function waitForUrl(timeoutMs) {
  return new Promise((resolve) => {
    if (state.url || state.status === 'error') {
      resolve();
      return;
    }
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    function onChange() {
      if (state.url || state.status === 'error') {
        clearTimeout(timer);
        finish();
      }
    }
    function finish() {
      tunnelEvents.off('changed', onChange);
      if (!state.url && state.status === 'starting') {
        setState({ status: 'running' });
      }
      resolve();
    }
    tunnelEvents.on('changed', onChange);
  });
}

export async function stopTunnel() {
  rivalWarning = null;
  if (!child) {
    setState({ status: 'stopped', url: null, pid: null, warning: null });
    return getTunnelStatus();
  }
  setState({ status: 'stopping' });
  const current = child;
  current.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      current.kill('SIGKILL');
      resolve();
    }, 5000);
    timer.unref?.();
    current.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  child = null;
  setState({ status: 'stopped', url: null, pid: null, warning: null });
  return getTunnelStatus();
}

export async function saveTunnelConfig(patch) {
  updateConfig({ tunnel: patch });
  return getConfig().tunnel;
}

export async function autoStartTunnel() {
  const tunnelConfig = getConfig().tunnel ?? {};
  if (!tunnelConfig.autoStart || !tunnelConfig.provider || tunnelConfig.provider === 'none') return null;
  try {
    return await startTunnel({});
  } catch (error) {
    log.warn(t('tunnel.log.autostart_failed', { message: error.message }));
    return null;
  }
}
