import http from 'node:http';
import https from 'node:https';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

export class HttpError extends Error {
  constructor(status, body, url) {
    super(describeError(status, body));
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

function describeError(status, body) {
  if (body && typeof body === 'object') {
    const detail = body.error?.message ?? body.error ?? body.message ?? body.title ?? null;
    if (detail) return `HTTP ${status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  }
  if (typeof body === 'string' && body.trim()) return `HTTP ${status}: ${body.trim().slice(0, 200)}`;
  return `HTTP ${status}`;
}

/**
 * Máy in trong LAN thường dùng HTTPS tự ký nên mặc định bỏ qua xác minh chứng chỉ.
 * `body` có thể là chuỗi, Buffer hoặc `{ length, open }` để stream file lớn và thử lại được.
 * Timeout là thời gian socket im lặng, không phải tổng thời gian, để upload file lớn không bị cắt ngang.
 */
export function httpRequest(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 10000,
    insecure = true,
    responseType = 'json',
    maxBytes = 32 * 1024 * 1024,
    onUploadProgress,
  } = options;
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const finalHeaders = { ...headers };
    let payload = null;
    let streamSource = null;
    if (typeof body === 'string' || Buffer.isBuffer(body)) {
      payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
      finalHeaders['content-length'] = String(payload.length);
    } else if (body && typeof body.open === 'function') {
      streamSource = body;
      finalHeaders['content-length'] = String(body.length);
    }

    const req = transport.request(
      target,
      { method, headers: finalHeaders, rejectUnauthorized: !insecure },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new Error(`Response exceeds ${Math.round(maxBytes / 1024 / 1024)}MB`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const contentType = String(res.headers['content-type'] ?? '');
          let parsed = raw;
          if (responseType === 'json' || (responseType !== 'buffer' && contentType.includes('json'))) {
            const text = raw.toString('utf8');
            try {
              parsed = text ? JSON.parse(text) : null;
            } catch {
              parsed = text;
            }
          } else if (responseType === 'text') {
            parsed = raw.toString('utf8');
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed, url: target.toString() });
        });
        res.on('error', reject);
      },
    );

    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout after ${timeoutMs}ms (${target.host})`)));
    req.on('error', reject);

    if (streamSource) {
      const stream = streamSource.open();
      let sent = 0;
      stream.on('data', (chunk) => {
        sent += chunk.length;
        onUploadProgress?.(sent, streamSource.length);
      });
      stream.on('error', (error) => req.destroy(error));
      stream.pipe(req);
      return;
    }
    req.end(payload ?? undefined);
  });
}

function md5(value) {
  return createHash('md5').update(value).digest('hex');
}

function parseChallenge(header) {
  if (!header || !/^digest\s/i.test(header)) return null;
  const params = {};
  for (const match of header.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) {
    params[match[1].toLowerCase()] = match[2] ?? match[3];
  }
  return params.nonce ? params : null;
}

/** HTTP Digest (RFC 7616, MD5) cho PrusaLink. Giữ nonce để request stream không phải gửi hai lần. */
export class DigestSession {
  constructor(username, password) {
    this.username = username;
    this.password = password;
    this.challenge = null;
    this.nc = 0;
  }

  update(header) {
    const values = Array.isArray(header) ? header : [header];
    for (const value of values) {
      const parsed = parseChallenge(value);
      if (parsed) {
        this.challenge = parsed;
        this.nc = 0;
        return true;
      }
    }
    return false;
  }

  header(method, uri) {
    const challenge = this.challenge;
    if (!challenge) return null;
    const ha1 = md5(`${this.username}:${challenge.realm}:${this.password}`);
    const ha2 = md5(`${method}:${uri}`);
    const parts = [
      `username="${this.username}"`,
      `realm="${challenge.realm}"`,
      `nonce="${challenge.nonce}"`,
      `uri="${uri}"`,
    ];
    const qop = challenge.qop?.split(',').map((item) => item.trim()).find((item) => item === 'auth');
    let response;
    if (qop) {
      this.nc += 1;
      const nc = this.nc.toString(16).padStart(8, '0');
      const cnonce = randomBytes(8).toString('hex');
      response = md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
      parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
    } else {
      response = md5(`${ha1}:${challenge.nonce}:${ha2}`);
    }
    parts.push(`response="${response}"`);
    if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`);
    if (challenge.algorithm) parts.push(`algorithm=${challenge.algorithm}`);
    return `Digest ${parts.join(', ')}`;
  }
}

export function buildBaseUrl({ host, port, https: secure }) {
  const raw = String(host ?? '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) {
    const parsed = new URL(raw);
    if (port) parsed.port = String(port);
    return parsed.toString().replace(/\/$/, '');
  }
  const scheme = secure ? 'https' : 'http';
  return `${scheme}://${raw}${port ? `:${port}` : ''}`;
}

/**
 * Client gắn với một máy in: tự thêm header xác thực, tự thử lại khi Digest yêu cầu nonce mới,
 * và ném HttpError với mọi mã >= 400 trừ khi truyền `allowStatus`.
 */
export function createHttpClient({ baseUrl, headers = {}, digest, insecure = true, timeoutMs = 8000 }) {
  const session = digest?.username ? new DigestSession(digest.username, digest.password ?? '') : null;

  async function request(path, options = {}) {
    const url = new URL(path, `${baseUrl}/`);
    const method = options.method ?? 'GET';
    const uri = `${url.pathname}${url.search}`;
    const send = () => {
      const auth = session?.header(method, uri);
      return httpRequest(url, {
        timeoutMs,
        insecure,
        ...options,
        method,
        headers: { ...headers, ...(options.headers ?? {}), ...(auth ? { authorization: auth } : {}) },
      });
    };
    let response = await send();
    if (response.status === 401 && session && session.update(response.headers['www-authenticate'])) {
      response = await send();
    }
    if (response.status >= 400 && !(options.allowStatus ?? []).includes(response.status)) {
      throw new HttpError(response.status, response.body, url.toString());
    }
    return response;
  }

  return {
    baseUrl,
    request,
    get: (path, options) => request(path, options).then((res) => res.body),
    post: (path, json, options = {}) =>
      request(path, {
        ...options,
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
        body: json === undefined ? undefined : JSON.stringify(json),
      }).then((res) => res.body),
    /** Lấy nonce Digest trước khi stream file, vì body stream không gửi lại được sau 401. */
    async prime(path) {
      if (!session || session.challenge) return;
      await request(path, { allowStatus: [401, 403, 404] }).catch(() => {});
    },
  };
}

const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);

/**
 * Lấy một khung hình từ camera. URL có thể là ảnh tĩnh hoặc luồng MJPEG (mjpg-streamer, crowsnest):
 * với luồng thì cắt khung JPEG đầu tiên rồi đóng kết nối, không chờ luồng kết thúc.
 */
export function fetchSnapshot(url, { headers = {}, insecure = true, timeoutMs = 8000, maxBytes = 16 * 1024 * 1024 } = {}) {
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(target, { headers, rejectUnauthorized: !insecure }, (res) => {
      const mime = String(res.headers['content-type'] ?? 'image/jpeg').split(';')[0].trim();
      const streaming = mime.startsWith('multipart');
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        chunks.push(chunk);
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy(new Error('Snapshot too large'));
          return;
        }
        if (!streaming) return;
        const buffer = Buffer.concat(chunks);
        const start = buffer.indexOf(JPEG_START);
        const end = start >= 0 ? buffer.indexOf(JPEG_END, start + 2) : -1;
        if (end > 0) {
          req.destroy();
          resolve({ status: res.statusCode ?? 0, buffer: buffer.subarray(start, end + 2), mime: 'image/jpeg' });
        }
      });
      res.on('end', () => {
        if (!streaming) resolve({ status: res.statusCode ?? 0, buffer: Buffer.concat(chunks), mime });
        else reject(new Error('Stream ended without a JPEG frame'));
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout after ${timeoutMs}ms (${target.host})`)));
    req.on('error', reject);
    req.end();
  });
}

export function fileBody(filePath, size) {
  return { length: size, open: () => createReadStream(filePath) };
}

/** Multipart stream thủ công để biết trước Content-Length và báo được tiến độ upload. */
export function multipartBody(fields, file) {
  const boundary = `----3dprintagent${randomBytes(12).toString('hex')}`;
  let head = '';
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    head += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  }
  const safeName = String(file.name).replace(/"/g, '');
  head +=
    `--${boundary}\r\nContent-Disposition: form-data; name="${file.field ?? 'file'}"; filename="${safeName}"\r\n` +
    `Content-Type: ${file.contentType ?? 'application/octet-stream'}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const headBuffer = Buffer.from(head);
  const tailBuffer = Buffer.from(tail);
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: {
      length: headBuffer.length + file.size + tailBuffer.length,
      open: () =>
        Readable.from(
          (async function* generate() {
            yield headBuffer;
            for await (const chunk of createReadStream(file.path)) yield chunk;
            yield tailBuffer;
          })(),
        ),
    },
  };
}
