#!/usr/bin/env node
import process from 'node:process';
import { startServer } from '../src/server/index.js';
import { startStdioMcp } from '../src/mcp/stdio.js';
import { getConfig, publicConfig } from '../src/core/config.js';
import { PATHS } from '../src/core/paths.js';
import { loadPrinters, listPrinters } from '../src/core/printers.js';
import { describeDrivers } from '../src/drivers/index.js';
import { detectPrinter, discoverPrinters } from '../src/core/discovery.js';
import { detectBinaries, startTunnel } from '../src/core/tunnel.js';
import { installService, uninstallService, serviceStatus, openBrowser } from '../src/setup/service.js';
import { t, setLocale } from '../src/i18n/index.js';
import { VERSION } from '../src/util/version.js';

const [, , command = 'start', ...rest] = process.argv;

if (!process.env.PRINTAGENT3D_LANG) setLocale(getConfig().agent.locale);

function flag(name) {
  const index = rest.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = rest[index + 1];
  return value && !value.startsWith('--') ? value : true;
}

const stringFlag = (name) => (typeof flag(name) === 'string' ? flag(name) : undefined);
const print = (value) => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));

/** Ask the running agent first for live state, fall back to the config on disk when it is not running. */
async function fetchFromAgent(path) {
  const config = getConfig();
  const url = process.env.PRINTAGENT3D_URL ?? `http://127.0.0.1:${config.server.port}`;
  const key = process.env.PRINTAGENT3D_API_KEY ?? config.auth.apiKeys[0]?.key;
  try {
    const response = await fetch(`${url}${path}`, { headers: key ? { 'x-api-key': key } : {}, signal: AbortSignal.timeout(3000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function main() {
  switch (command) {
    case 'start': {
      const { port } = await startServer({
        port: stringFlag('port') ? Number(stringFlag('port')) : undefined,
        host: stringFlag('host'),
      });
      if (flag('open') && process.stdout.isTTY) openBrowser(`http://127.0.0.1:${port}`);
      break;
    }

    case 'service': {
      const action = rest[0] ?? 'status';
      if (action === 'install') {
        const result = await installService();
        print(t('cli.service.installed', { manager: result.manager, unit: result.unit }));
      } else if (action === 'uninstall') {
        const result = await uninstallService();
        print(t('cli.service.uninstalled', { manager: result.manager, unit: result.unit }));
      } else {
        print(await serviceStatus());
      }
      break;
    }

    case 'mcp': {
      await startStdioMcp({ standalone: Boolean(flag('standalone')), baseUrl: stringFlag('url'), apiKey: stringFlag('key') });
      break;
    }

    case 'printers': {
      const remote = await fetchFromAgent('/api/printers');
      if (!remote) loadPrinters();
      const list = remote?.printers ?? listPrinters();
      if (!remote) print(t('cli.printers.offline_agent'));
      if (list.length === 0) print(t('cli.printers.none'));
      for (const printer of list) {
        const status = remote ? `${printer.status.state}${printer.status.job ? ` ${printer.status.job.progress ?? 0}%` : ''}` : '-';
        print(`- ${printer.name} [${printer.driverLabel}] ${printer.id} ${status}`);
      }
      break;
    }

    case 'drivers': {
      for (const driver of describeDrivers()) {
        print(`- ${driver.id} (${driver.label}): ${driver.fields.map((field) => `${field.key}${field.required ? '*' : ''}`).join(', ')}`);
      }
      break;
    }

    case 'discover': {
      print(t('cli.discover.scanning'));
      const found = await discoverPrinters({ timeoutMs: Number(stringFlag('timeout')) || undefined });
      if (found.length === 0) print(t('cli.discover.none'));
      for (const item of found) print(`- ${item.name} [${item.driver}] ${item.host}${item.port ? `:${item.port}` : ''} (${item.source})`);
      break;
    }

    case 'detect': {
      if (!rest[0]) throw new Error(t('cli.detect.usage'));
      print(await detectPrinter(rest[0], { port: stringFlag('port') ? Number(stringFlag('port')) : undefined }));
      break;
    }

    case 'config': {
      print(t('cli.config.data_dir', { path: PATHS.data }));
      print(publicConfig());
      break;
    }

    case 'key': {
      for (const item of getConfig().auth.apiKeys) print(`${item.name}\t${item.key}`);
      break;
    }

    case 'tunnel': {
      if (rest[0] === 'check' || rest.length === 0) {
        print(await detectBinaries());
        break;
      }
      print(await startTunnel({ provider: rest[0] }));
      break;
    }

    case 'version':
    case '--version':
    case '-v':
      print(VERSION);
      break;

    default:
      print(`${t('cli.tagline')} v${VERSION}\n\n${t('cli.usage')}`);
  }
}

main().catch((error) => {
  console.error(t('cli.error', { message: error.message }));
  process.exit(1);
});
