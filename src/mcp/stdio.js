import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.js';
import { createLocalApi, createRemoteApi } from './api.js';
import { getConfig } from '../core/config.js';
import { configureLogger } from '../util/logger.js';
import { PATHS, ensureDataDirs } from '../core/paths.js';
import { loadPrinters, startAll } from '../core/printers.js';
import { loadLibrary } from '../core/library.js';
import { loadJobs, startQueue } from '../core/jobs.js';

/**
 * By default stdio is only a bridge to the running agent (over REST) so two processes never
 * connect to the same printer. `standalone` loads core itself, for when no agent is running.
 */
export async function startStdioMcp({ standalone = false, baseUrl, apiKey } = {}) {
  ensureDataDirs();
  configureLogger({ dir: PATHS.logs, silent: true });

  const config = getConfig();
  let api;
  if (standalone) {
    loadPrinters();
    loadLibrary();
    loadJobs();
    await startAll();
    startQueue();
    api = createLocalApi();
  } else {
    const url = baseUrl ?? process.env.PRINTAGENT3D_URL ?? `http://127.0.0.1:${config.server.port}`;
    const key = apiKey ?? process.env.PRINTAGENT3D_API_KEY ?? config.auth.apiKeys[0]?.key ?? null;
    api = createRemoteApi({ baseUrl: url, apiKey: key });
  }

  const server = createMcpServer(api);
  await server.connect(new StdioServerTransport());
  return server;
}
