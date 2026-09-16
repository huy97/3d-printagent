import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'p3d-storage-'));
process.env.PRINTAGENT3D_DATA_DIR = dataDir;
process.env.PRINTAGENT3D_LOG_LEVEL = 'error';

const { closeDb, sql } = await import('../src/core/db.js');
const telemetry = await import('../src/core/telemetry.js');
const jobs = await import('../src/core/jobs.js');

after(() => closeDb());

const status = (nozzle, bed, extra = {}) => ({
  online: true,
  state: 'printing',
  temps: { nozzle: { actual: nozzle, target: 220 }, bed: { actual: bed, target: 60 }, chamber: null },
  fanSpeed: 50,
  speedFactor: 100,
  job: { progress: 10, layer: 2 },
  ...extra,
});

test('Jobs in SQLite survive a reopen', () => {
  const seeds = [
    { id: 'job_new', printerId: 'prn_a', status: 'completed', fileName: 'b.gcode', createdAt: '2026-09-02T00:00:00.000Z' },
    { id: 'job_old', printerId: 'prn_a', status: 'uploading', fileName: 'a.gcode', createdAt: '2026-09-01T00:00:00.000Z' },
  ];
  for (const job of seeds) {
    sql('INSERT INTO jobs (id, printer_id, status, created_at, data) VALUES (?, ?, ?, ?, ?)').run(
      job.id,
      job.printerId,
      job.status,
      job.createdAt,
      JSON.stringify(job),
    );
  }

  const loaded = jobs.loadJobs();
  assert.deepEqual(loaded.map((job) => job.id), ['job_new', 'job_old']);
  assert.equal(loaded[1].status, 'failed', 'a job still uploading when the agent stopped must turn into failed');

  jobs.flushJobs();
  closeDb();
  const reloaded = jobs.loadJobs();
  assert.equal(reloaded.length, 2);
  assert.equal(reloaded[1].status, 'failed');

  jobs.deleteJob('job_new');
  jobs.flushJobs();
  closeDb();
  assert.deepEqual(jobs.loadJobs().map((job) => job.id), ['job_old']);
});

test('Telemetry writes 5-second samples to SQLite and buckets them over long ranges', () => {
  const base = Date.UTC(2026, 8, 11, 10, 0, 0);
  assert.equal(telemetry.recordSample('prn_t', status(200, 60), base), true);
  assert.equal(telemetry.recordSample('prn_t', status(201, 60), base + 1000), false);
  assert.equal(telemetry.recordSample('prn_t', { ...status(0, 0), online: false }, base + 6000), false);
  for (let index = 1; index < 120; index += 1) telemetry.recordSample('prn_t', status(200 + (index % 2) * 2, 60), base + index * 5000);

  const raw = telemetry.queryTelemetry('prn_t', { from: base, to: base + 10 * 60000 });
  assert.equal(raw.bucketMs, 5000);
  assert.equal(raw.samples.length, 120);
  assert.deepEqual(
    { n: raw.samples[0].n, nt: raw.samples[0].nt, b: raw.samples[0].b, f: raw.samples[0].f, s: raw.samples[0].s, p: raw.samples[0].p, l: raw.samples[0].l },
    { n: 200, nt: 220, b: 60, f: 50, s: 100, p: 10, l: 2 },
  );

  const grouped = telemetry.queryTelemetry('prn_t', { from: base, to: base + 10 * 60000, maxPoints: 20 });
  assert.equal(grouped.bucketMs, 30000);
  assert.equal(grouped.samples.length, 20);
  assert.equal(grouped.samples[0].n, 201);

  closeDb();
  assert.equal(telemetry.queryTelemetry('prn_t', { from: base, to: base + 10 * 60000 }).samples.length, 120);

  assert.equal(telemetry.purgeTelemetry(base + 31 * 86400000), 120);
  telemetry.recordSample('prn_x', status(100, 50), Date.now());
  telemetry.deleteTelemetry('prn_x');
  assert.equal(telemetry.telemetryStats().samples, 0);
});
