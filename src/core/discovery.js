import dgram from 'node:dgram';
import net from 'node:net';
import multicastDns from 'multicast-dns';
import { httpRequest } from '../drivers/http.js';
import { bambuModelFromCode, bambuModelFromSerial } from '../drivers/bambu.js';
import { createLogger } from '../util/logger.js';
import { badRequest } from '../util/errors.js';

const log = createLogger('discovery');

const MDNS_SERVICES = {
  '_octoprint._tcp.local': 'octoprint',
  '_moonraker._tcp.local': 'moonraker',
  '_prusa-link._tcp.local': 'prusalink',
};

function parseSsdp(text) {
  const headers = {};
  for (const line of text.split(/\r?\n/).slice(1)) {
    const index = line.indexOf(':');
    if (index > 0) headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return headers;
}

/**
 * Máy Bambu phát SSDP NOTIFY định kỳ lên UDP 2021 (broadcast) kèm serial và mã model.
 * Bỏ qua M-SEARCH: agent nhận lại gói của chính mình, Bambu Studio trong LAN cũng phát loại này.
 */
export function parseBambuAnnouncement(text, remoteAddress) {
  const firstLine = text.split(/\r?\n/, 1)[0].trim().toUpperCase();
  if (!firstLine.startsWith('NOTIFY') && !firstLine.startsWith('HTTP/')) return null;
  if (!/bambulab|bambu\.com/i.test(text)) return null;
  const headers = parseSsdp(text);
  const serial = headers.usn?.trim();
  if (!serial) return null;
  const host = headers.location || remoteAddress;
  const code = headers['devmodel.bambu.com'] ?? null;
  const model = bambuModelFromCode(code) ?? bambuModelFromSerial(serial);
  return {
    driver: 'bambu',
    host,
    port: null,
    name: headers['devname.bambu.com'] || `Bambu ${model?.label ?? code ?? ''}`.trim(),
    connection: { host, serial, ...(model ? { model: model.value } : {}) },
    source: 'ssdp',
    details: {
      model: model?.label ?? code,
      mode: headers['devconnect.bambu.com'] ?? null,
      signal: headers['devsignal.bambu.com'] ?? null,
    },
  };
}

const SEEN_TTL_MS = 120000;
const seenBambu = new Map();
let passiveSocket = null;

function rememberBambu(message, remote) {
  const printer = parseBambuAnnouncement(message.toString('utf8'), remote.address);
  if (printer) seenBambu.set(printer.connection.serial, { printer, at: Date.now() });
  return printer;
}

/**
 * Broadcast qua Wi-Fi không được gửi lại nên hay rơi gói; nghe nền liên tục và nhớ máy đã thấy
 * để lần quét sau không phụ thuộc vào đúng một gói NOTIFY rơi vào cửa sổ quét.
 */
export function startBambuListener() {
  if (passiveSocket) return;
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  passiveSocket = socket;
  socket.on('message', rememberBambu);
  socket.on('error', (error) => {
    log.debug(`SSDP 2021 không khả dụng: ${error.message}`);
    stopBambuListener();
  });
  socket.bind(2021);
  socket.unref();
}

export function stopBambuListener() {
  try {
    passiveSocket?.close();
  } catch {
    // socket đã đóng
  }
  passiveSocket = null;
}

function recentBambu() {
  const cutoff = Date.now() - SEEN_TTL_MS;
  return [...seenBambu.values()].filter((entry) => entry.at >= cutoff).map((entry) => entry.printer);
}

function discoverBambu(timeoutMs) {
  return new Promise((resolve) => {
    const found = new Map(recentBambu().map((printer) => [printer.connection.serial, printer]));
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const done = () => {
      try {
        socket.close();
      } catch {
        // socket đã đóng
      }
      resolve([...found.values()]);
    };
    socket.on('error', (error) => {
      log.debug(`SSDP 2021 không khả dụng: ${error.message}`);
      done();
    });
    socket.on('message', (message, remote) => {
      const printer = rememberBambu(message, remote);
      if (printer) found.set(printer.connection.serial, printer);
    });
    socket.bind(2021, () => {
      try {
        socket.setBroadcast(true);
        const search = Buffer.from(
          'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1990\r\nMAN: "ssdp:discover"\r\nMX: 3\r\nST: urn:bambulab-com:device:3dprinter:1\r\n\r\n',
        );
        socket.send(search, 1990, '255.255.255.255');
        socket.send(search, 2021, '255.255.255.255');
      } catch (error) {
        log.debug(`Không gửi được M-SEARCH: ${error.message}`);
      }
    });
    setTimeout(done, timeoutMs).unref?.();
  });
}

function discoverMdns(timeoutMs) {
  return new Promise((resolve) => {
    let mdns;
    try {
      mdns = multicastDns();
    } catch (error) {
      log.debug(`mDNS không khả dụng: ${error.message}`);
      resolve([]);
      return;
    }
    const instances = new Map();
    const hosts = new Map();

    const instance = (name) => {
      if (!instances.has(name)) instances.set(name, { name, service: null, target: null, port: null });
      return instances.get(name);
    };

    mdns.on('response', (response) => {
      for (const record of [...(response.answers ?? []), ...(response.additionals ?? [])]) {
        if (record.type === 'PTR' && MDNS_SERVICES[record.name]) instance(record.data).service = record.name;
        if (record.type === 'SRV') {
          const entry = instance(record.name);
          entry.target = record.data?.target ?? null;
          entry.port = record.data?.port ?? null;
          if (!entry.service) entry.service = Object.keys(MDNS_SERVICES).find((key) => record.name.endsWith(key)) ?? null;
        }
        if (record.type === 'A') hosts.set(record.name, record.data);
      }
    });
    mdns.on('error', (error) => log.debug(`mDNS lỗi: ${error.message}`));
    mdns.query({ questions: Object.keys(MDNS_SERVICES).map((name) => ({ name, type: 'PTR' })) });

    setTimeout(() => {
      mdns.destroy();
      const results = [];
      for (const entry of instances.values()) {
        if (!entry.service) continue;
        const driver = MDNS_SERVICES[entry.service];
        const host = hosts.get(entry.target) ?? entry.target?.replace(/\.$/, '') ?? null;
        if (!host) continue;
        const defaultPort = driver === 'moonraker' ? 7125 : 80;
        const port = entry.port && entry.port !== defaultPort ? entry.port : null;
        results.push({
          driver,
          host,
          port,
          name: entry.name.replace(`.${entry.service}`, ''),
          connection: { host, ...(port ? { port } : {}) },
          source: 'mdns',
          details: {},
        });
      }
      resolve(results);
    }, timeoutMs).unref?.();
  });
}

/** Bambu không trả lời M-SEARCH mà tự phát NOTIFY khoảng 10 giây một lần, nên mặc định phải nghe lâu hơn một chu kỳ. */
export const DISCOVERY_TIMEOUT_MS = 12000;

export async function discoverPrinters({ timeoutMs = DISCOVERY_TIMEOUT_MS } = {}) {
  const duration = Math.max(1000, Math.min(30000, Number(timeoutMs) || DISCOVERY_TIMEOUT_MS));
  const [bambu, mdns] = await Promise.all([discoverBambu(duration), discoverMdns(duration)]);
  const unique = new Map();
  for (const item of [...bambu, ...mdns]) unique.set(`${item.driver}:${item.host}:${item.port ?? ''}`, item);
  return [...unique.values()];
}

function tcpOpen(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function probe(url, responseType = 'json') {
  try {
    return await httpRequest(url, { timeoutMs: 3000, responseType, maxBytes: 512 * 1024 });
  } catch {
    return null;
  }
}

/** Đoán loại firmware của một địa chỉ IP bằng các endpoint đặc trưng của từng hệ. */
export async function detectPrinter(hostInput, { port } = {}) {
  const host = String(hostInput ?? '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  if (!host) throw badRequest('error.field_required', { field: 'host' });
  const [hostname, inlinePort] = host.split(':');
  const webPort = Number(port ?? inlinePort) || null;
  const web = `http://${hostname}${webPort ? `:${webPort}` : ''}`;

  const [moonrakerDirect, moonrakerProxy, version, v1Status, page, mqttPort, ftpsPort] = await Promise.all([
    probe(`http://${hostname}:${webPort ?? 7125}/server/info`),
    webPort ? null : probe(`${web}/server/info`),
    probe(`${web}/api/version`),
    probe(`${web}/api/v1/status`),
    probe(`${web}/`, 'text'),
    tcpOpen(hostname, 8883),
    tcpOpen(hostname, 990),
  ]);

  const candidates = [];
  const moonraker = [moonrakerDirect, moonrakerProxy].find((item) => item?.status === 200 && item.body?.result?.klippy_state);
  if (moonraker) {
    const viaProxy = moonraker === moonrakerProxy;
    candidates.push({
      driver: 'moonraker',
      confidence: 'high',
      connection: { host: hostname, port: viaProxy ? webPort : webPort ?? 7125 },
      details: { klippy: moonraker.body.result.klippy_state, version: moonraker.body.result.moonraker_version ?? null },
    });
  }

  const html = typeof page?.body === 'string' ? page.body.toLowerCase() : '';
  const authHeader = String(version?.headers?.['www-authenticate'] ?? v1Status?.headers?.['www-authenticate'] ?? '');
  const versionText = String(version?.body?.text ?? version?.body?.server ?? '');
  const isPrusa =
    /digest/i.test(authHeader) ||
    /prusalink|prusa link/i.test(versionText) ||
    Boolean(version?.body?.firmware && version?.body?.api) ||
    html.includes('prusalink') ||
    html.includes('prusa-link');
  if (isPrusa) {
    candidates.push({
      driver: 'prusalink',
      confidence: /digest/i.test(authHeader) || /prusa/i.test(versionText) ? 'high' : 'medium',
      connection: { host: hostname, ...(webPort ? { port: webPort } : {}), username: 'maker' },
      details: { version: versionText || null },
    });
  }

  const isOctoPrint = html.includes('octoprint') || /octoprint/i.test(versionText);
  if (isOctoPrint && !moonraker) {
    candidates.push({
      driver: 'octoprint',
      confidence: 'high',
      connection: { host: hostname, ...(webPort ? { port: webPort } : {}) },
      details: { version: versionText || null },
    });
  }

  if (mqttPort && ftpsPort) {
    candidates.push({
      driver: 'bambu',
      confidence: 'medium',
      connection: { host: hostname },
      details: { note: 'MQTT 8883 + FTPS 990' },
    });
  }

  return { host: hostname, candidates };
}
