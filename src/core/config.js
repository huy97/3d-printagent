import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PATHS, ensureDataDirs } from './paths.js';
import { apiKeyValue, shortId } from '../util/id.js';

export const configEvents = new EventEmitter();

const DEFAULTS = {
  agent: {
    name: '3D PrintAgent',
    id: null,
    locale: 'en',
  },
  server: {
    host: '0.0.0.0',
    port: 7790,
    corsOrigins: [],
  },
  auth: {
    enabled: true,
    allowLocalhostWithoutKey: true,
    apiKeys: [],
  },
  files: {
    maxUploadMb: 1024,
    allowRemoteUrl: true,
    allowPrivateNetworkUrl: false,
    allowLocalFilePath: false,
    allowedFileRoots: [],
  },
  queue: {
    keepJobs: 500,
  },
  costs: {
    currency: 'VND',
    electricityPerKwh: 3000,
    defaultPowerW: 150,
    defaultPricePerKg: 350000,
  },
  safety: {
    allowGcode: true,
    blockedGcodes: ['M502', 'M997'],
    maxNozzleTemp: 300,
    maxBedTemp: 120,
    maxChamberTemp: 65,
    maxJogMm: 100,
  },
  monitoring: {
    pollIntervalMs: 2000,
    historyDays: 30,
  },
  slicer: {
    binPath: null,
    profilesDir: null,
    userProfilesDir: null,
    timeoutSec: 900,
  },
  notify: {
    telegram: {
      enabled: false,
      botToken: null,
      chatId: null,
      events: ['completed', 'failed'],
      includeSnapshot: true,
    },
  },
  watch: {
    enabled: false,
    intervalMin: 10,
    firstLayer: true,
    minConfidence: 0.75,
    onDetect: 'notify',
    autoDiagnose: false,
  },
  ai: {
    authType: 'api_key',
    apiKey: null,
    model: 'claude-sonnet-5',
    baseUrl: 'https://api.anthropic.com',
  },
  tunnel: {
    provider: 'none',
    autoStart: false,
    cloudflare: {
      binPath: 'cloudflared',
      token: null,
      hostname: null,
    },
    ngrok: {
      binPath: 'ngrok',
      authtoken: null,
      domain: null,
      region: null,
    },
  },
};

let cache = null;

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function deepMerge(base, override) {
  if (override === undefined) return base;
  if (override === null) return null;
  if (Array.isArray(base) || Array.isArray(override)) return override;
  if (typeof base !== 'object' || base === null) return override;
  if (typeof override !== 'object') return override;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    result[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return result;
}

export function loadConfig({ force = false } = {}) {
  if (cache && !force) return cache;
  ensureDataDirs();
  let stored = {};
  if (existsSync(PATHS.config)) {
    try {
      stored = JSON.parse(readFileSync(PATHS.config, 'utf8'));
    } catch {
      stored = {};
    }
  }
  cache = deepMerge(DEFAULTS, stored);

  let mutated = false;
  if (!cache.agent.id) {
    cache.agent.id = shortId('agent');
    mutated = true;
  }
  if (cache.auth.apiKeys.length === 0) {
    cache.auth.apiKeys.push({
      id: shortId('key'),
      name: 'default',
      key: apiKeyValue(),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    });
    mutated = true;
  }
  // Temperature history used to live in RAM by the minute, now stored in SQLite by day.
  if ('historyMinutes' in cache.monitoring) {
    delete cache.monitoring.historyMinutes;
    mutated = true;
  }
  if (mutated) saveConfig(cache, { silent: true });
  return cache;
}

export function saveConfig(next, { silent = false } = {}) {
  ensureDataDirs();
  cache = deepMerge(DEFAULTS, next);
  const tmp = `${PATHS.config}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2));
  renameSync(tmp, PATHS.config);
  if (!silent) configEvents.emit('changed', cache);
  return cache;
}

export function updateConfig(patch) {
  return saveConfig(deepMerge(loadConfig(), patch));
}

export function getConfig() {
  return loadConfig();
}

export function publicConfig() {
  const config = loadConfig();
  return {
    ...config,
    tunnel: {
      ...config.tunnel,
      cloudflare: {
        ...config.tunnel.cloudflare,
        token: config.tunnel.cloudflare?.token ? '***' : null,
      },
      ngrok: {
        ...config.tunnel.ngrok,
        authtoken: config.tunnel.ngrok?.authtoken ? '***' : null,
      },
    },
    ai: {
      ...config.ai,
      apiKey: config.ai?.apiKey ? '***' : null,
    },
    notify: {
      ...config.notify,
      telegram: {
        ...config.notify.telegram,
        botToken: config.notify?.telegram?.botToken ? '***' : null,
      },
    },
    auth: {
      ...config.auth,
      apiKeys: config.auth.apiKeys.map((item) => ({
        id: item.id,
        name: item.name,
        createdAt: item.createdAt,
        lastUsedAt: item.lastUsedAt,
        preview: `${item.key.slice(0, 8)}...${item.key.slice(-4)}`,
      })),
    },
  };
}

export const configDefaults = DEFAULTS;
