import { sql } from './db.js';
import { getConfig } from './config.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('telemetry');

export const SAMPLE_INTERVAL_MS = 5000;
const MAX_POINTS = 1500;
const PURGE_INTERVAL_MS = 3600 * 1000;
const DAY_MS = 86400 * 1000;

const lastSample = new Map();
let lastPurge = 0;

function numeric(value) {
  const number = Number(value);
  return value === null || value === undefined || !Number.isFinite(number) ? null : Math.round(number * 10) / 10;
}

export function retentionDays() {
  return Math.max(1, Number(getConfig().monitoring.historyDays) || 30);
}

/** Records one sample every 5 seconds per online printer reporting temperatures. */
export function recordSample(printerId, status, now = Date.now()) {
  if (!status?.online || (!status.temps?.nozzle && !status.temps?.bed)) return false;
  if (now - (lastSample.get(printerId) ?? 0) < SAMPLE_INTERVAL_MS) return false;
  lastSample.set(printerId, now);
  const { nozzle, bed, chamber } = status.temps;
  try {
    sql(
      `INSERT INTO telemetry (printer_id, t, nozzle, nozzle_target, bed, bed_target, chamber, fan, speed, progress, layer, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      printerId,
      now,
      numeric(nozzle?.actual),
      numeric(nozzle?.target),
      numeric(bed?.actual),
      numeric(bed?.target),
      numeric(chamber?.actual),
      numeric(status.fanSpeed),
      numeric(status.speedFactor),
      numeric(status.job?.progress),
      numeric(status.job?.layer),
      status.state ?? null,
    );
    if (now - lastPurge > PURGE_INTERVAL_MS) purgeTelemetry(now);
  } catch (error) {
    log.warn(`Failed to record telemetry: ${error.message}`);
  }
  return true;
}

export function purgeTelemetry(now = Date.now()) {
  lastPurge = now;
  return Number(sql('DELETE FROM telemetry WHERE t < ?').run(now - retentionDays() * DAY_MS).changes);
}

export function deleteTelemetry(printerId) {
  lastSample.delete(printerId);
  sql('DELETE FROM telemetry WHERE printer_id = ?').run(printerId);
}

/** Long ranges are bucketed (averaged) so no more than MAX_POINTS points are returned. */
export function queryTelemetry(printerId, { from, to, maxPoints = MAX_POINTS } = {}) {
  const end = Number.isFinite(to) ? to : Date.now();
  const start = Number.isFinite(from) ? Math.min(from, end) : end - 30 * 60 * 1000;
  const points = Math.max(10, Math.min(5000, Number(maxPoints) || MAX_POINTS));
  const bucketMs = Math.max(SAMPLE_INTERVAL_MS, Math.ceil((end - start) / points));
  const samples = sql(
    `SELECT MAX(t) AS t,
            ROUND(AVG(nozzle), 1) AS n, MAX(nozzle_target) AS nt,
            ROUND(AVG(bed), 1) AS b, MAX(bed_target) AS bt,
            ROUND(AVG(chamber), 1) AS c,
            ROUND(AVG(fan)) AS f, ROUND(AVG(speed)) AS s,
            MAX(progress) AS p, MAX(layer) AS l
     FROM telemetry
     WHERE printer_id = ? AND t >= ? AND t <= ?
     GROUP BY CAST(t / ? AS INTEGER)
     ORDER BY t`,
  ).all(printerId, start, end, bucketMs);
  return { from: start, to: end, bucketMs, samples };
}

export function telemetryStats() {
  const row = sql('SELECT COUNT(*) AS count, MIN(t) AS oldest FROM telemetry').get();
  return { samples: Number(row.count), oldest: row.oldest ?? null, retentionDays: retentionDays() };
}
