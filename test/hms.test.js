import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'p3d-hms-'));
process.env.PRINTAGENT3D_DATA_DIR = dataDir;
process.env.PRINTAGENT3D_LOG_LEVEL = 'error';

const hms = await import('../src/core/hms.js');

// fetchedAt is fresh, so loadHmsCatalog reads the cache and the test never touches the network.
writeFileSync(
  path.join(dataDir, 'hms-catalog.json'),
  JSON.stringify({
    locale: 'vi',
    version: 1,
    fetchedAt: Date.now(),
    codes: {
      '0300110000020001': 'Tần số cộng hưởng của trục Y thấp. Dây đai răng có thể bị lỏng.',
      '03001A0000020001': 'Vòi phun bị sợi nhựa che lấp hoặc bàn in bị nghiêng.',
      '1807560000030001': 'AMS-HT H đang trong quá trình làm mát khô.',
    },
  }),
);

test('Catalog loads from cache and resolves HMS codes with severity', () => {
  assert.equal(hms.loadHmsCatalog(), 3);
  assert.deepEqual(hms.describeHms('HMS_0300_1100_0002_0001'), {
    code: 'HMS_0300_1100_0002_0001',
    severity: 'serious',
    text: 'Tần số cộng hưởng của trục Y thấp. Dây đai răng có thể bị lỏng.',
  });
  assert.equal(hms.describeHms('HMS_1807_5600_0003_0001').severity, 'common');
  assert.equal(hms.hmsCatalogStatus().codes, 3);
});

test('Lowercase codes still resolve, unknown codes only lose the description', () => {
  assert.equal(hms.describeHms('hms_0300_1a00_0002_0001').text, 'Vòi phun bị sợi nhựa che lấp hoặc bàn in bị nghiêng.');
  const unknown = hms.describeHms('HMS_9999_9999_0001_0001');
  assert.deepEqual(unknown, { code: 'HMS_9999_9999_0001_0001', severity: 'fatal', text: null });
});

test('Malformed strings come back unchanged instead of throwing', () => {
  assert.deepEqual(hms.describeHms('loi la'), { code: 'loi la', severity: null, text: null });
  assert.deepEqual(hms.describeHms(null), { code: '', severity: null, text: null });
});
