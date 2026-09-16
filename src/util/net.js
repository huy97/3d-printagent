import { createWriteStream, rmSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { badRequest } from './errors.js';

export function isPrivateAddress(address, family) {
  const value = String(address).toLowerCase();
  if (family === 6) {
    if (value === '::1' || value === '::') return true;
    if (value.startsWith('fe80:') || value.startsWith('fc') || value.startsWith('fd')) return true;
    const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1], 4);
    return false;
  }
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts;
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

async function assertUrlAllowed(target, { allowPrivateNetwork }) {
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    throw badRequest('error.url_invalid', { url: target });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw badRequest('error.url_scheme');
  if (allowPrivateNetwork) return parsed;

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw badRequest('error.url_dns_failed', { host });
  }
  const blocked = addresses.find((entry) => isPrivateAddress(entry.address, entry.family));
  if (blocked) throw badRequest('error.url_private_network', { host, address: blocked.address });
  return parsed;
}

/**
 * Tải file về đĩa theo từng chặng redirect và kiểm tra lại từng chặng,
 * tránh bị dẫn vòng về mạng nội bộ. Ghi thẳng ra file vì G-code có thể nặng hàng trăm MB.
 */
export async function downloadToFile(url, dest, { maxBytes, allowPrivateNetwork = false }) {
  let current = await assertUrlAllowed(url, { allowPrivateNetwork });
  for (let hop = 0; hop < 5; hop += 1) {
    const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(300000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw badRequest('error.redirect_no_location', { url: current });
      current = await assertUrlAllowed(new URL(location, current).toString(), { allowPrivateNetwork });
      continue;
    }
    if (!response.ok) throw badRequest('error.download_failed', { status: response.status, url: current });
    const declared = Number(response.headers.get('content-length') ?? 0);
    const limitMb = Math.round(maxBytes / 1024 / 1024);
    if (declared > maxBytes) throw badRequest('error.file_too_large', { limit: limitMb });

    const out = createWriteStream(dest);
    let size = 0;
    try {
      for await (const chunk of response.body ?? []) {
        size += chunk.length;
        if (size > maxBytes) throw badRequest('error.file_too_large', { limit: limitMb });
        if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
      }
      await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
    } catch (error) {
      out.destroy();
      rmSync(dest, { force: true });
      throw error;
    }
    return { url: current, bytes: size };
  }
  throw badRequest('error.too_many_redirects');
}
