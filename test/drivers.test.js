import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OctoPrintDriver } from '../src/drivers/octoprint.js';
import { MoonrakerDriver } from '../src/drivers/moonraker.js';
import { PrusaLinkDriver } from '../src/drivers/prusalink.js';
import { parseBambuAnnouncement } from '../src/core/discovery.js';
import { BambuDriver, bambuModelFromCode, bambuModelFromSerial, resolveBambuModel } from '../src/drivers/bambu.js';
import { mockServer } from './helpers.js';

const dir = mkdtempSync(path.join(tmpdir(), 'p3d-drv-'));
const gcodePath = path.join(dir, 'part.gcode');
writeFileSync(gcodePath, 'G28\nG1 X10 Y10\n');
const upload = { path: gcodePath, remoteName: 'part.gcode', size: 15 };

function driverFor(Driver, port, connection = {}) {
  return new Driver({ id: 'prn_test', name: 'Test', connection: { host: '127.0.0.1', port, ...connection } }, {});
}

test('OctoPrint: status, multipart upload and print commands', async () => {
  const server = await mockServer((req) => {
    if (req.headers['x-api-key'] !== 'secret') return { status: 403, json: { error: 'Forbidden' } };
    const url = req.url.split('?')[0];
    if (url === '/api/version') return { json: { server: '1.10.2', text: 'OctoPrint 1.10.2' } };
    if (url === '/api/job') return { json: { state: 'Printing', job: { file: { name: 'part.gcode', display: 'part.gcode' } }, progress: { completion: 42.37, printTime: 600, printTimeLeft: 800 } } };
    if (url === '/api/printer') {
      return { json: { state: { text: 'Printing', flags: { printing: true, operational: true } }, temperature: { tool0: { actual: 214.6, target: 215 }, bed: { actual: 60.1, target: 60 } } } };
    }
    if (url === '/api/files/local' && req.method === 'POST') return { status: 201, json: { files: { local: { path: 'part.gcode' } } } };
    if (url === '/api/files/local/part.gcode' && req.method === 'POST') return { status: 204 };
    if (url === '/api/job' && req.method === 'POST') return { status: 204 };
    return null;
  });
  try {
    const driver = driverFor(OctoPrintDriver, server.port, { apiKey: 'secret' });
    const status = await driver.poll();
    assert.equal(status.state, 'printing');
    assert.equal(status.job.progress, 42.4);
    assert.equal(status.job.remaining, 800);
    assert.deepEqual(status.temps.nozzle, { actual: 214.6, target: 215 });
    assert.equal(status.firmware, 'OctoPrint 1.10.2');

    const progress = [];
    const result = await driver.uploadFile({ ...upload, start: false, onProgress: (sent, total) => progress.push([sent, total]) });
    assert.equal(result.remoteName, 'part.gcode');
    const uploadRequest = server.requests.find((item) => item.url === '/api/files/local');
    assert.match(uploadRequest.headers['content-type'], /^multipart\/form-data; boundary=/);
    assert.match(uploadRequest.body.toString(), /filename="part.gcode"[\s\S]*G28/);
    assert.equal(Number(uploadRequest.headers['content-length']), uploadRequest.body.length);
    assert.ok(progress.length > 0);

    await driver.startPrint('part.gcode');
    const start = server.requests.find((item) => item.url === '/api/files/local/part.gcode');
    assert.deepEqual(JSON.parse(start.body), { command: 'select', print: true });

    await driver.pause();
    assert.deepEqual(JSON.parse(server.requests.at(-1).body), { command: 'pause', action: 'pause' });

    await assert.rejects(driverFor(OctoPrintDriver, server.port, { apiKey: 'wrong' }).poll(), /403/);
  } finally {
    await server.close();
  }
});

test('OctoPrint: a disconnected printer (409) reports offline', async () => {
  const server = await mockServer((req) => {
    if (req.url.startsWith('/api/version')) return { json: { text: 'OctoPrint 1.10.2' } };
    if (req.url.startsWith('/api/job')) return { json: { state: 'Offline', job: { file: {} }, progress: {} } };
    if (req.url.startsWith('/api/printer')) return { status: 409, json: { error: 'Printer is not operational' } };
    return null;
  });
  try {
    const status = await driverFor(OctoPrintDriver, server.port, { apiKey: 'x' }).poll();
    assert.equal(status.state, 'offline');
    assert.equal(status.job, null);
  } finally {
    await server.close();
  }
});

test('Moonraker: reads print_stats, derives the layer count from metadata, uploads and starts', async () => {
  const server = await mockServer((req) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/server/info') return { json: { result: { klippy_state: 'ready', moonraker_version: 'v0.9.3' } } };
    if (url.pathname === '/printer/info') return { json: { result: { software_version: 'v0.12.0' } } };
    if (url.pathname === '/printer/objects/list') {
      return { json: { result: { objects: ['print_stats', 'virtual_sdcard', 'display_status', 'heater_bed', 'extruder', 'toolhead', 'fan', 'gcode_move', 'temperature_sensor chamber'] } } };
    }
    if (url.pathname === '/printer/objects/query') {
      assert.ok(url.search.includes('temperature_sensor%20chamber'));
      return {
        json: {
          result: {
            status: {
              print_stats: { state: 'printing', filename: 'part.gcode', print_duration: 300, info: { current_layer: null, total_layer: null } },
              virtual_sdcard: { progress: 0.25 },
              display_status: { progress: 0.25, message: null },
              extruder: { temperature: 230.2, target: 230 },
              heater_bed: { temperature: 80, target: 80 },
              'temperature_sensor chamber': { temperature: 35.5 },
              toolhead: { position: [100, 100, 5.2, 10] },
              fan: { speed: 0.5 },
              gcode_move: { speed_factor: 1.2 },
            },
          },
        },
      };
    }
    if (url.pathname === '/server/files/metadata') return { json: { result: { layer_height: 0.2, first_layer_height: 0.2, object_height: 20, estimated_time: 1500 } } };
    if (url.pathname === '/server/files/upload') return { status: 201, json: { item: { path: 'part.gcode' }, print_started: false } };
    if (url.pathname === '/printer/print/start') return { json: { result: 'ok' } };
    if (url.pathname === '/printer/gcode/script') return { json: { result: 'ok' } };
    return null;
  });
  try {
    const driver = driverFor(MoonrakerDriver, server.port);
    const status = await driver.poll();
    assert.equal(status.state, 'printing');
    assert.equal(status.firmware, 'Klipper v0.12.0');
    assert.equal(status.job.progress, 25);
    assert.equal(status.job.remaining, 900);
    assert.equal(status.job.totalLayers, 100);
    assert.equal(status.job.layer, 26);
    assert.equal(status.temps.chamber.actual, 35.5);
    assert.equal(status.fanSpeed, 50);
    assert.equal(status.speedFactor, 120);

    const result = await driver.uploadFile({ ...upload, start: false });
    assert.equal(result.started, false);
    assert.match(server.requests.find((item) => item.url === '/server/files/upload').body.toString(), /name="root"\r\n\r\ngcodes/);

    await driver.startPrint('part.gcode');
    assert.ok(server.requests.some((item) => item.url === '/printer/print/start?filename=part.gcode'));

    await driver.home(['x', 'y']);
    assert.ok(server.requests.some((item) => item.url === `/printer/gcode/script?script=${encodeURIComponent('G28 X Y')}`));
  } finally {
    await server.close();
  }
});

test('Moonraker: a Klipper that is not ready reports the error with its reason', async () => {
  const server = await mockServer((req) => {
    if (req.url === '/server/info') return { json: { result: { klippy_state: 'shutdown' } } };
    if (req.url === '/printer/info') return { json: { result: { state_message: 'MCU shutdown: Timer too close\n' } } };
    return null;
  });
  try {
    const status = await driverFor(MoonrakerDriver, server.port).poll();
    assert.equal(status.state, 'error');
    assert.deepEqual(status.message, { key: 'printer.message.klipper', params: { message: 'MCU shutdown: Timer too close' } });
  } finally {
    await server.close();
  }
});

function md5(value) {
  return createHash('md5').update(value).digest('hex');
}

/** Checks the Digest header the way PrusaLink does (realm, nonce, qop=auth). */
function digestValid(req, password) {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Digest ')) return false;
  const params = Object.fromEntries([...header.slice(7).matchAll(/(\w+)="?([^",]*)"?/g)].map((match) => [match[1], match[2]]));
  const ha1 = md5(`${params.username}:${params.realm}:${password}`);
  const ha2 = md5(`${req.method}:${params.uri}`);
  const expected = md5(`${ha1}:${params.nonce}:${params.nc}:${params.cnonce}:${params.qop}:${ha2}`);
  return params.nonce === 'n0nce' && params.uri === req.url && expected === params.response;
}

test('PrusaLink: Digest auth, status, PUT upload and job control', async () => {
  const server = await mockServer((req) => {
    if (!digestValid(req, 'pass123')) {
      return { status: 401, headers: { 'www-authenticate': 'Digest realm="Printer API", nonce="n0nce", qop="auth"' }, json: {} };
    }
    const url = req.url;
    if (url === '/api/version') return { json: { text: 'PrusaLink', firmware: '6.1.3' } };
    if (url === '/api/v1/status') {
      return { json: { printer: { state: 'PRINTING', temp_nozzle: 215, target_nozzle: 215, temp_bed: 60, target_bed: 60, speed: 100, axis_z: 2.4 }, job: { id: 7, progress: 12, time_printing: 120, time_remaining: 880 } } };
    }
    if (url === '/api/v1/job') return { json: { id: 7, file: { name: 'PART~1.GCO', display_name: 'part.gcode' } } };
    if (url === '/api/v1/storage') return { json: { storage_list: [{ path: '/usb/', available: true, read_only: false }] } };
    if (url === '/api/v1/files/usb/part.gcode') return { status: req.method === 'PUT' ? 201 : 204 };
    if (url === '/api/v1/job/7/pause') return { status: 204 };
    return null;
  });
  try {
    const driver = driverFor(PrusaLinkDriver, server.port, { username: 'maker', password: 'pass123' });
    const status = await driver.poll();
    assert.equal(status.state, 'printing');
    assert.equal(status.firmware, 'PrusaLink 6.1.3');
    assert.equal(status.job.file, 'part.gcode');
    assert.equal(status.job.progress, 12);
    assert.equal(status.position.z, 2.4);

    await driver.uploadFile({ ...upload, start: false });
    const put = server.requests.find((item) => item.method === 'PUT' && item.url === '/api/v1/files/usb/part.gcode' && item.headers.authorization);
    assert.equal(put.body.toString(), 'G28\nG1 X10 Y10\n');
    assert.equal(put.headers['print-after-upload'], '?0');

    await driver.startPrint('part.gcode');
    await driver.pause();
    assert.ok(server.requests.some((item) => item.method === 'PUT' && item.url === '/api/v1/job/7/pause'));

    await assert.rejects(driverFor(PrusaLinkDriver, server.port, { username: 'maker', password: 'wrong' }).poll(), /401/);
  } finally {
    await server.close();
  }
});

test('Bambu SSDP: ignores M-SEARCH, reads the printer NOTIFY', () => {
  const search = 'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1990\r\nMAN: "ssdp:discover"\r\nMX: 3\r\nST: urn:bambulab-com:device:3dprinter:1\r\n\r\n';
  assert.equal(parseBambuAnnouncement(search, '192.168.1.81'), null);

  const notify = [
    'NOTIFY * HTTP/1.1',
    'HOST: 239.255.255.250:1900',
    'Location: 192.168.1.80',
    'NT: urn:bambulab-com:device:3dprinter:1',
    'USN: 01P00A123456789',
    'DevModel.bambu.com: C12',
    'DevName.bambu.com: Lab P1S',
    'DevConnect.bambu.com: lan',
  ].join('\r\n');
  const printer = parseBambuAnnouncement(notify, '192.168.1.80');
  assert.equal(printer.name, 'Lab P1S');
  assert.deepEqual(printer.connection, { host: '192.168.1.80', serial: '01P00A123456789', model: 'P1S' });

  const a2l = parseBambuAnnouncement(notify.replace('C12', 'N9'), '192.168.1.80');
  assert.equal(a2l.connection.model, 'A2L');

  const bySerial = parseBambuAnnouncement(notify.replace('C12', 'ZZ9').replace('01P00A', '094000'), '192.168.1.80');
  assert.equal(bySerial.connection.model, 'H2D');

  const unknown = parseBambuAnnouncement(notify.replace('C12', 'ZZ9').replace('01P00A', 'XYZ00A'), '192.168.1.80');
  assert.equal(unknown.connection.model, undefined);
  assert.equal(unknown.details.model, 'ZZ9');
});

test('Bambu model: a manual choice wins, then the serial prefix', () => {
  assert.equal(resolveBambuModel({ model: 'X1C', serial: '03919A000000000' }).value, 'X1C');
  assert.equal(resolveBambuModel({ model: 'auto', serial: '03919A000000000' }).value, 'A1');
  assert.equal(resolveBambuModel({ model: 'auto', serial: '22E00A000000000' }).camera, 'rtsp');
  assert.equal(resolveBambuModel({ model: 'auto', serial: 'XYZ' }).value, 'P1S');
  assert.equal(bambuModelFromCode('o1c2').value, 'H2C');
});

test('Moonraker: bed leveling is offered only when the Klipper config has the matching section', async () => {
  const objects = ['print_stats', 'virtual_sdcard', 'display_status', 'heater_bed', 'extruder', 'toolhead', 'bed_mesh'];
  const server = await mockServer((req) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/server/info') return { json: { result: { klippy_state: 'ready', moonraker_version: 'v0.9.3' } } };
    if (url.pathname === '/printer/info') return { json: { result: { software_version: 'v0.12.0' } } };
    if (url.pathname === '/printer/objects/list') return { json: { result: { objects } } };
    if (url.pathname === '/printer/objects/query') {
      return { json: { result: { status: { print_stats: { state: 'standby' }, display_status: {}, extruder: {}, heater_bed: {} } } } };
    }
    if (url.pathname === '/printer/gcode/script') return { json: { result: 'ok' } };
    return null;
  });
  try {
    const driver = driverFor(MoonrakerDriver, server.port);
    // Before polling the printer the list stays as is, only afterwards is it filtered by the real config.
    assert.deepEqual(driver.calibrations, ['bedLeveling', 'bedScrews']);
    await driver.poll();
    assert.deepEqual(driver.calibrations, ['bedLeveling']);

    const result = await driver.calibrate(['bedLeveling']);
    assert.deepEqual(result.script, ['G28', 'BED_MESH_CALIBRATE']);
    assert.ok(
      server.requests.some((item) => item.url === `/printer/gcode/script?script=${encodeURIComponent('G28\nBED_MESH_CALIBRATE')}`),
    );
  } finally {
    await server.close();
  }
});

test('Bambu: the calibration command bitmask matches each item', () => {
  const driver = new BambuDriver(
    { id: 'prn_b', name: 'B', connection: { host: '127.0.0.1', serial: '01P00A123456789', accessCode: '12345678', model: 'A2L' } },
    {},
  );
  const sent = [];
  driver.client = { connected: true, publish: (topic, payload) => sent.push(JSON.parse(payload)) };

  driver.calibrate(['bedLeveling']);
  assert.equal(sent.at(-1).print.command, 'calibration');
  assert.equal(sent.at(-1).print.option, 2);

  driver.calibrate(['motorNoise', 'vibration', 'bedLeveling']);
  assert.equal(sent.at(-1).print.option, 2 + 4 + 8);

  driver.calibrate(['highTempBed']);
  assert.equal(sent.at(-1).print.option, 32);

  // With nothing reported yet, fall back to the model table: exactly the four items the A2L screen offers.
  assert.deepEqual(driver.calibrations, ['bedLeveling', 'vibration', 'motorNoise', 'highTempBed']);
  driver.report.support_bed_leveling = 0;
  assert.deepEqual(driver.calibrations, ['vibration', 'motorNoise', 'highTempBed']);
  driver.report.support_bed_leveling = 1;
  driver.report.home_flag = 0;
  assert.deepEqual(driver.calibrations, ['bedLeveling', 'vibration', 'highTempBed']);
  driver.report.home_flag = 1 << 21;
  assert.deepEqual(driver.calibrations, ['bedLeveling', 'vibration', 'motorNoise', 'highTempBed']);
});

test('Bambu: per-model specs match BambuStudio resources/printers', () => {
  const make = (model) =>
    new BambuDriver({ id: `prn_${model}`, name: model, connection: { host: '127.0.0.1', serial: 'X', accessCode: '12345678', model } }, {});
  const expected = {
    X1C: { limits: { nozzle: 300, bed: 120, chamber: 0 }, calibrations: ['lidar', 'bedLeveling', 'vibration'], bed: ['on', 'off'], flow: ['on', 'off'] },
    X1: { limits: { nozzle: 300, bed: 120, chamber: 0 }, calibrations: ['lidar', 'bedLeveling', 'vibration'], bed: ['on', 'off'], flow: ['on', 'off'] },
    X1E: { limits: { nozzle: 320, bed: 110, chamber: 60 }, calibrations: ['lidar', 'bedLeveling', 'vibration'], bed: ['on', 'off'], flow: ['on', 'off'] },
    X2D: { limits: { nozzle: 300, bed: 120, chamber: 65 }, calibrations: ['bedLeveling', 'vibration', 'nozzleOffset', 'highTempBed'], bed: ['auto', 'on', 'off'], flow: ['auto', 'on', 'off'] },
    P1P: { limits: { nozzle: 300, bed: 100, chamber: 0 }, calibrations: ['bedLeveling', 'vibration'], bed: ['on', 'off'], flow: [] },
    P1S: { limits: { nozzle: 300, bed: 100, chamber: 0 }, calibrations: ['bedLeveling', 'vibration'], bed: ['on', 'off'], flow: [] },
    P2S: { limits: { nozzle: 300, bed: 110, chamber: 0 }, calibrations: ['bedLeveling', 'vibration', 'highTempBed', 'nozzleClump'], bed: ['auto', 'on', 'off'], flow: ['auto', 'on', 'off'] },
    A1MINI: { limits: { nozzle: 300, bed: 80, chamber: 0 }, calibrations: ['bedLeveling', 'vibration', 'motorNoise'], bed: ['on', 'off'], flow: ['on', 'off'] },
    A1: { limits: { nozzle: 300, bed: 100, chamber: 0 }, calibrations: ['bedLeveling', 'vibration', 'motorNoise'], bed: ['on', 'off'], flow: ['on', 'off'] },
    A2L: { limits: { nozzle: 300, bed: 80, chamber: 0 }, calibrations: ['bedLeveling', 'vibration', 'motorNoise', 'highTempBed'], bed: ['auto', 'on', 'off'], flow: ['auto', 'on', 'off'] },
  };
  for (const [model, spec] of Object.entries(expected)) {
    const driver = make(model);
    assert.deepEqual(driver.temperatureLimits, spec.limits, model);
    assert.deepEqual(driver.calibrations, spec.calibrations, model);
    assert.deepEqual(driver.printChoices, { bedLeveling: spec.bed, flowCalibration: spec.flow }, model);
    assert.deepEqual(BambuDriver.printChoicesFor({ model }), driver.printChoices, model);
  }
  assert.equal(bambuModelFromSerial('22E00A000000000').value, 'P2S');
  assert.equal(bambuModelFromSerial('26A19A01B671502831').value, 'A2L');

  // P1 always hides flow calibration even with the PA bit set; when the printer reports a support_* flag, trust the printer.
  const p1s = make('P1S');
  p1s.report.home_flag = 1 << 16;
  assert.deepEqual(p1s.printChoices.flowCalibration, []);
  const x1c = make('X1C');
  x1c.report.home_flag = (1 << 16) | (1 << 21);
  x1c.report.support_bed_leveling = 2;
  assert.deepEqual(x1c.printChoices, { bedLeveling: ['auto', 'on', 'off'], flowCalibration: ['on', 'off'] });
  assert.deepEqual(x1c.calibrations, ['lidar', 'bedLeveling', 'vibration', 'motorNoise']);
  x1c.report.home_flag = 0;
  assert.deepEqual(x1c.printChoices.flowCalibration, []);
});

test('Bambu: print options map onto the choices each model allows', async () => {
  const run = async (model, options, report = {}) => {
    const driver = new BambuDriver({ id: 'prn_c', name: 'C', connection: { host: '127.0.0.1', serial: 'X', accessCode: '12345678', model } }, {});
    const { body } = bambuRecorder(driver);
    Object.assign(driver.report, report);
    await driver.startPrint('a.3mf', options);
    const { bed_leveling, auto_bed_leveling, flow_cali, extrude_cali_flag } = body();
    return { bed_leveling, auto_bed_leveling, flow_cali, extrude_cali_flag };
  };
  // X1C has no "auto": BambuStudio preselects "on".
  assert.deepEqual(await run('X1C', {}), { bed_leveling: true, auto_bed_leveling: 1, flow_cali: true, extrude_cali_flag: 1 });
  assert.deepEqual(await run('X1C', { bedLeveling: false, flowCalibration: false }), { bed_leveling: false, auto_bed_leveling: 0, flow_cali: false, extrude_cali_flag: 0 });
  // P1S hides flow calibration and sends the default value of the hidden option.
  assert.deepEqual(await run('P1S', { flowCalibration: true }), { bed_leveling: true, auto_bed_leveling: 1, flow_cali: false, extrude_cali_flag: 2 });
  assert.deepEqual(await run('A2L', {}, { cfg: '0', fun: '100d102002fbd', aux: '0', stat: '0' }), { bed_leveling: false, auto_bed_leveling: 2, flow_cali: false, extrude_cali_flag: 2 });
});

test('Bambu: early X1 firmware runs a prebuilt calibration file instead of the calibration command', () => {
  const driver = new BambuDriver(
    { id: 'prn_x', name: 'X', connection: { host: '127.0.0.1', serial: '00M00A123456789', accessCode: '12345678', model: 'X1C' } },
    {},
  );
  const sent = [];
  driver.client = { connected: true, publish: (topic, payload) => sent.push(JSON.parse(payload)) };

  driver.modules = { rv1126: '00.00.15.50' };
  driver.calibrate(['bedLeveling']);
  assert.equal(sent.at(-1).print.command, 'gcode_file');
  assert.match(sent.at(-1).print.param, /auto_cali_for_user/);

  driver.modules = { rv1126: '00.00.16.00' };
  driver.calibrate(['bedLeveling']);
  assert.equal(sent.at(-1).print.command, 'calibration');
});

test('Bambu: a running calibration is not counted as a print job but still reports its stage', () => {
  const driver = new BambuDriver(
    { id: 'prn_c', name: 'C', connection: { host: '127.0.0.1', serial: '26A00A123456789', accessCode: '12345678', model: 'A2L' } },
    {},
  );
  driver.report = {
    gcode_state: 'RUNNING',
    gcode_file: '/usr/etc/print/auto_cali_for_user.gcode',
    stg: [1, 25, 3],
    stg_cur: 25,
    stg_cd: 420,
    mc_percent: 40,
  };
  driver.publish();
  assert.equal(driver.status.state, 'printing');
  assert.equal(driver.status.job, null, 'calibration must not create a ghost job in the queue');
  assert.equal(driver.status.message, 'Calibrating motor noise');
  assert.deepEqual(driver.status.extra.calibration, { stage: 'Calibrating motor noise', step: 2, steps: 3, remaining: 420 });

  driver.report.gcode_file = '/sdcard/part.gcode';
  driver.report.subtask_name = 'part.gcode';
  driver.publish();
  assert.equal(driver.status.extra.calibration, null);
  assert.equal(driver.status.job.file, 'part.gcode');
});

test('Bambu: the preparing stage does not borrow numbers from the previous print', () => {
  const driver = new BambuDriver(
    { id: 'prn_p', name: 'P', connection: { host: '127.0.0.1', serial: '01P00A123456789', accessCode: '12345678', model: 'A2L' } },
    {},
  );
  // The printer just finished a 72-layer print and takes a new 16-layer one: mc_percent and layer_num still hold the old values.
  const report = {
    gcode_state: 'PREPARE',
    subtask_name: 'step1',
    mc_percent: 100,
    layer_num: 72,
    total_layer_num: 16,
    mc_remaining_time: 0,
    gcode_start_time: String(Math.round(Date.now() / 1000) - 900),
  };
  driver.handleMessage(JSON.stringify({ print: report }));
  assert.equal(driver.status.job.stage, 'preparing');
  assert.equal(driver.status.job.progress, 0, 'nothing printed yet must not report 100%');
  assert.equal(driver.status.job.layer, null);
  assert.equal(driver.status.job.elapsed, null);
  assert.equal(driver.status.job.remaining, null);

  driver.handleMessage(JSON.stringify({ print: { gcode_state: 'RUNNING', mc_percent: 4, layer_num: 1, mc_remaining_time: 55 } }));
  assert.equal(driver.status.job.stage, null);
  assert.equal(driver.status.job.progress, 4);
  assert.equal(driver.status.job.layer, 1);
  assert.equal(driver.status.job.remaining, 3300);
});

test('Bambu: without an AMS the printer is not told to pull filament from a tray', async () => {
  const driver = new BambuDriver(
    { id: 'prn_a', name: 'A', connection: { host: '127.0.0.1', serial: '01P00A123456789', accessCode: '12345678', model: 'A2L' } },
    {},
  );
  const sent = [];
  driver.client = { connected: true, publish: (topic, payload) => sent.push(JSON.parse(payload)) };

  driver.report.ams = { ams_exist_bits: '0' };
  assert.equal(driver.hasAms, false);
  await driver.startPrint('step1.gcode.3mf', { plate: 1, useAms: true, amsMapping: [0] });
  assert.equal(sent.at(-1).print.use_ams, false, 'AMS on with none attached leaves the printer stuck in the preparing stage');
  assert.equal(sent.at(-1).print.ams_mapping, '');

  driver.report.ams = { ams_exist_bits: '1' };
  await driver.startPrint('step1.gcode.3mf', { plate: 1, useAms: true, amsMapping: [0] });
  assert.equal(sent.at(-1).print.use_ams, true);
  assert.deepEqual(sent.at(-1).print.ams_mapping, [0]);

  // When the caller says nothing, follow the printer: use the AMS only if one is attached.
  await driver.startPrint('step1.gcode.3mf', { plate: 1 });
  assert.equal(sent.at(-1).print.use_ams, true);
  driver.report.ams = { ams_exist_bits: '0' };
  await driver.startPrint('step1.gcode.3mf', { plate: 1 });
  assert.equal(sent.at(-1).print.use_ams, false);
});

test('Bambu: print options send both the boolean flag and the 0/1/2 integer like BambuStudio', async () => {
  const driver = new BambuDriver(
    { id: 'prn_t', name: 'T', connection: { host: '127.0.0.1', serial: '26A00A123456789', accessCode: '12345678', model: 'A2L' } },
    {},
  );
  const sent = [];
  driver.client = { connected: true, publish: (topic, payload) => sent.push(JSON.parse(payload)) };

  await driver.startPrint('part.gcode.3mf', { bedLeveling: false, flowCalibration: false, vibrationCalibration: true });
  let print = sent.at(-1).print;
  assert.equal(print.bed_leveling, false);
  assert.equal(print.auto_bed_leveling, 0, 'off must send 0, newer firmware ignores the boolean flag');
  assert.equal(print.flow_cali, false);
  assert.equal(print.extrude_cali_flag, 0);
  assert.equal(print.vibration_cali, false);

  await driver.startPrint('part.gcode.3mf', { bedLeveling: true, flowCalibration: true });
  print = sent.at(-1).print;
  assert.deepEqual([print.bed_leveling, print.auto_bed_leveling, print.flow_cali, print.extrude_cali_flag], [true, 1, true, 1]);

  await driver.startPrint('part.gcode.3mf', {});
  print = sent.at(-1).print;
  assert.deepEqual([print.bed_leveling, print.auto_bed_leveling, print.flow_cali, print.extrude_cali_flag], [false, 2, false, 2]);
});

function bambuRecorder(driver) {
  const sent = [];
  driver.client = { connected: true, publish: (topic, payload) => sent.push(JSON.parse(payload)) };
  const body = (index = -1) => {
    const { sequence_id: _sequence, ...rest } = sent.at(index).print ?? sent.at(index).system;
    return rest;
  };
  return { sent, body };
}

test('Bambu A2L new protocol: control commands match BambuStudio', async () => {
  const driver = new BambuDriver(
    { id: 'prn_n', name: 'N', connection: { host: '127.0.0.1', serial: '26A19A01B671502831', accessCode: '12345678', model: 'A2L' } },
    {},
  );
  const { sent, body } = bambuRecorder(driver);
  // Taken from a real A2L firmware 01.01.00.00 report, with no AMS attached.
  driver.handleMessage(
    JSON.stringify({
      print: {
        cfg: '120001870a09',
        fun: '100d102002fbd',
        aux: '31004',
        stat: '700400f0',
        home_flag: 863847871,
        nozzle_temper: 244.5,
        bed_temper: 69,
        ams: { ams: [], ams_exist_bits: '0', tray_now: '0' },
        vir_slot: [{ id: '255', tray_type: 'PETG', tray_color: '000000FF' }],
        device: {
          extruder: { info: [{ id: 0, snow: 65280, temp: 16056564 }] },
          bed: { info: { temp: 4587589 } },
          airduct: { parts: [{ id: 16, func: 0, state: 40, range: 6553600 }] },
        },
      },
    }),
  );
  assert.equal(driver.newProtocol, true);
  assert.deepEqual(driver.status.temps.nozzle, { actual: 244.5, target: 245 });
  assert.deepEqual(driver.status.temps.bed, { actual: 69, target: 70 });
  assert.equal(driver.status.fanSpeed, 40);
  assert.deepEqual(driver.status.extra.externalSpool, { type: 'PETG', color: '#000000' });
  assert.deepEqual(driver.temperatureLimits, { nozzle: 300, bed: 80, chamber: 0 });

  await driver.loadFilament({ temperature: 230, slot: 254 });
  assert.deepEqual(body(), { command: 'ams_change_filament', ams_id: 255, target: 255, slot_id: 0, curr_temp: 230, tar_temp: 230 });
  await assert.rejects(driver.loadFilament({ temperature: 230, slot: 0 }), { key: 'error.field_invalid' });
  await driver.unloadFilament({ temperature: 230 });
  assert.deepEqual(body(), { command: 'ams_change_filament', ams_id: 255, target: 255, slot_id: 255, curr_temp: 230, tar_temp: 230 });

  await driver.setTemperature('bed', 60);
  assert.deepEqual(body(), { command: 'set_bed_temp', temp: 60 });
  await driver.setTemperature('nozzle', 230);
  assert.deepEqual(body(), { command: 'gcode_line', param: 'M104 S230\n' });
  await assert.rejects(driver.setTemperature('chamber', 40));

  await driver.home();
  assert.deepEqual(body(), { command: 'back_to_center' });

  await driver.jog({ z: 10 });
  assert.deepEqual(body(), { command: 'xyz_ctrl', axis: 'Z', dir: 1, mode: 1 });
  await driver.jog({ y: -1 });
  assert.deepEqual(body(), { command: 'xyz_ctrl', axis: 'Y', dir: -1, mode: 0 });
  await driver.jog({ x: 0.1 });
  assert.equal(body().param, 'M211 S\nM211 X1 Y1 Z1\nM1002 push_ref_mode\nG91\nG1 X0.1 F3000\nM1002 pop_ref_mode\nM211 R\n');
  await driver.jog({ z: -50, feedrate: 30000 });
  assert.match(body().param, /\nG1 Z-50\.0 F900\n/, 'Z must not run faster than the feedrate BambuStudio uses');
  driver.report.home_flag = 0b011;
  const count = sent.length;
  await assert.rejects(driver.jog({ x: 1, z: 1 }), { key: 'error.bambu_axis_not_homed' });
  assert.equal(sent.length, count, 'if any axis is not homed, no axis is sent at all');

  const fan = await driver.setFan(44);
  assert.deepEqual(body(), { command: 'set_fan', fan_index: 1, speed: 40 });
  assert.equal(fan.percent, 40);

  await driver.setLight(true);
  assert.equal(body(-2).led_node, 'chamber_light');
  assert.deepEqual(body(), { command: 'ledctrl', led_node: 'chamber_light2', led_mode: 'on', led_on_time: 500, led_off_time: 500, loop_times: 1, interval_time: 1000 });
});

test('Bambu legacy protocol: filament load, fan and homing via G-code with the old tray ids', async () => {
  const driver = new BambuDriver(
    { id: 'prn_o', name: 'O', connection: { host: '127.0.0.1', serial: '01P00A123456789', accessCode: '12345678', model: 'P1S' } },
    {},
  );
  const { body } = bambuRecorder(driver);
  driver.handleMessage(
    JSON.stringify({ print: { cooling_fan_speed: '15', ams: { ams_exist_bits: '1', tray_now: '2', ams: [{ id: '0', tray: [{ id: '2' }] }] } } }),
  );
  assert.equal(driver.newProtocol, false);
  assert.equal(driver.status.fanSpeed, 100);
  assert.deepEqual(driver.temperatureLimits, { nozzle: 300, bed: 100, chamber: 0 });

  await driver.loadFilament({ temperature: 220, slot: 254 });
  assert.deepEqual(body(), { command: 'ams_change_filament', ams_id: 254, target: 254, slot_id: 0, curr_temp: 220, tar_temp: 220 });
  await driver.loadFilament({ temperature: 220, slot: 2 });
  assert.deepEqual(body(), { command: 'ams_change_filament', ams_id: 0, target: 2, slot_id: 2, curr_temp: 220, tar_temp: 220 });
  await assert.rejects(driver.loadFilament({ temperature: 220, slot: 1 }), { key: 'error.field_invalid' });
  await driver.unloadFilament({ temperature: 220 });
  assert.deepEqual(body(), { command: 'ams_change_filament', ams_id: 0, target: 255, slot_id: 255, curr_temp: 220, tar_temp: 220 });

  await driver.setTemperature('bed', 60);
  assert.deepEqual(body(), { command: 'gcode_line', param: 'M140 S60\n' });
  await driver.home();
  assert.deepEqual(body(), { command: 'gcode_line', param: 'G28\n' });
  await driver.jog({ y: 10 });
  assert.match(body().param, /\nG1 Y10\.0 F3000\n/);
  await driver.setFan(50);
  assert.deepEqual(body(), { command: 'gcode_line', param: 'M106 P1 S128\n' });
});
