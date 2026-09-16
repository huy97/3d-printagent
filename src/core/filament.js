import { EventEmitter } from 'node:events';
import { sql, transaction } from './db.js';
import { getConfig } from './config.js';
import * as library from './library.js';
import * as printers from './printers.js';
import * as insights from './insights.js';
import { analyzeMaterial, densityOf, gramsAtLayer } from '../gcode/material.js';
import { shortId } from '../util/id.js';
import { badRequest, notFound } from '../util/errors.js';
import { createLogger } from '../util/logger.js';

/** Cuộn nhựa, lượng nhựa từng bản in cần, chi phí và trừ kho khi bản in kết thúc. */

const log = createLogger('filament');
export const filamentEvents = new EventEmitter();
filamentEvents.setMaxListeners(0);

// Tăng khi bộ đo nhựa đổi cách tính để bộ nhớ đệm cũ tự bỏ.
const ANALYSIS_VERSION = 1;

function round(value, digits = 2) {
  return Math.round(value * 10 ** digits) / 10 ** digits;
}

function readSpools() {
  return sql('SELECT data FROM spools ORDER BY created_at').all().map((row) => JSON.parse(row.data));
}

function writeSpool(spool) {
  sql('INSERT INTO spools (id, created_at, data) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data').run(
    spool.id,
    spool.createdAt,
    JSON.stringify(spool),
  );
}

export function costSettings() {
  const costs = getConfig().costs ?? {};
  const number = (value) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0);
  return {
    currency: costs.currency || 'VND',
    electricityPerKwh: number(costs.electricityPerKwh),
    defaultPowerW: number(costs.defaultPowerW),
    defaultPricePerKg: number(costs.defaultPricePerKg),
  };
}

function publicSpool(spool) {
  const printer = spool.printerId ? printers.findPrinter(spool.printerId) : null;
  return {
    ...spool,
    printerName: printer?.name ?? null,
    remainingPercent: spool.totalG > 0 ? round((spool.remainingG / spool.totalG) * 100, 1) : null,
    low: spool.remainingG <= (spool.lowG ?? 0),
  };
}

export function listSpools({ printerId } = {}) {
  return readSpools()
    .filter((spool) => (printerId ? spool.printerId === printerId : true))
    .map(publicSpool);
}

function spoolRecord(id) {
  const spool = readSpools().find((item) => item.id === id);
  if (!spool) throw notFound('error.spool_not_found', { id });
  return spool;
}

export function getSpool(id) {
  return publicSpool(spoolRecord(id));
}

function cleanSpool(input, previous = {}) {
  const text = (key, max) => {
    if (input[key] === undefined) return previous[key] ?? null;
    return String(input[key] ?? '').trim().slice(0, max) || null;
  };
  const number = (key, min, max, fallback) => {
    const raw = input[key];
    if (raw === undefined) return previous[key] ?? fallback;
    if (raw === null || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) throw badRequest('error.field_invalid', { field: key });
    return value;
  };
  const material = (text('material', 20) ?? 'PLA').toUpperCase();
  const totalG = number('totalG', 1, 100000, 1000);
  let printerId = previous.printerId ?? null;
  if (input.printerId !== undefined) printerId = input.printerId ? printers.getRecord(input.printerId).id : null;
  let slot = number('slot', 0, 254, null);
  if (slot !== null) slot = Math.round(slot);
  return {
    name: text('name', 80) ?? `${material}${text('color', 20) ? ` ${text('color', 20)}` : ''}`,
    material,
    color: text('color', 20),
    brand: text('brand', 60),
    diameter: number('diameter', 1, 3, 1.75),
    density: number('density', 0.5, 3, densityOf(material)),
    pricePerKg: number('pricePerKg', 0, 1e9, null),
    totalG,
    remainingG: Math.min(totalG * 2, number('remainingG', 0, 100000, totalG)),
    lowG: number('lowG', 0, 100000, 100),
    printerId,
    slot: printerId ? slot : null,
    notes: text('notes', 500),
  };
}

/** Tạo hoặc sửa cuộn nhựa; gắn vào một khay đang có cuộn khác thì cuộn cũ được tháo ra. */
export function saveSpool(input = {}) {
  const previous = input.id ? spoolRecord(input.id) : null;
  const now = new Date().toISOString();
  const spool = {
    id: previous?.id ?? shortId('spl'),
    ...cleanSpool(input, previous ?? {}),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    lastUsedAt: previous?.lastUsedAt ?? null,
  };
  transaction(() => {
    if (spool.printerId) {
      for (const other of readSpools()) {
        if (other.id !== spool.id && other.printerId === spool.printerId && (other.slot ?? null) === (spool.slot ?? null)) {
          writeSpool({ ...other, printerId: null, slot: null, updatedAt: now });
        }
      }
    }
    writeSpool(spool);
  });
  filamentEvents.emit('changed', { event: previous ? 'updated' : 'added', spool: publicSpool(spool) });
  return publicSpool(spool);
}

export function adjustSpool(id, { remainingG, deltaG } = {}) {
  const spool = spoolRecord(id);
  const next = remainingG !== undefined ? Number(remainingG) : spool.remainingG + Number(deltaG);
  if (!Number.isFinite(next) || next < 0) throw badRequest('error.field_invalid', { field: remainingG !== undefined ? 'remainingG' : 'deltaG' });
  spool.remainingG = round(next, 1);
  spool.updatedAt = new Date().toISOString();
  writeSpool(spool);
  filamentEvents.emit('changed', { event: 'updated', spool: publicSpool(spool) });
  return publicSpool(spool);
}

export function deleteSpool(id) {
  const spool = spoolRecord(id);
  sql('DELETE FROM spools WHERE id = ?').run(spool.id);
  filamentEvents.emit('changed', { event: 'removed', spool: { id: spool.id } });
  return { deleted: true, id: spool.id };
}

/** Loại nhựa đang gắn trên máy, dùng để hàng đợi chung không đẩy file PETG sang máy đang lắp PLA. */
export function loadedMaterials(printerId) {
  return new Set(readSpools().filter((spool) => spool.printerId === printerId).map((spool) => spool.material));
}

function stamp(file) {
  return file.sha256 ?? `${file.size}:${file.updatedAt ?? file.uploadedAt}`;
}

/** Kết quả đo nhựa của một khay, đọc lại từ bộ nhớ đệm khi file chưa đổi. */
export function fileMaterial(fileOrId, plate) {
  const file = typeof fileOrId === 'string' ? library.getFileRecord(fileOrId) : fileOrId;
  if (!['gcode', '3mf'].includes(file.format) || file.meta?.sliced === false) return null;
  const key = file.format === '3mf' ? Number(plate) || 0 : 1;
  const row = sql('SELECT data FROM material_cache WHERE file_id = ? AND plate = ?').get(file.id, key);
  if (row) {
    const cached = JSON.parse(row.data);
    if (cached.version === ANALYSIS_VERSION && cached.stamp === stamp(file)) return cached.analysis;
  }
  let analysis = null;
  try {
    analysis = analyzeMaterial(library.filePath(file), file.name, plate, { material: file.meta?.filamentType });
  } catch (error) {
    log.warn(`Không đo được nhựa của ${file.name}: ${error.message}`);
  }
  if (analysis && analysis.totalG <= 0) analysis = null;
  sql('INSERT INTO material_cache (file_id, plate, data) VALUES (?, ?, ?) ON CONFLICT (file_id, plate) DO UPDATE SET data = excluded.data').run(
    file.id,
    key,
    JSON.stringify({ version: ANALYSIS_VERSION, stamp: stamp(file), analysis }),
  );
  return analysis;
}

export function forgetFile(fileId) {
  sql('DELETE FROM material_cache WHERE file_id = ?').run(fileId);
}

/** File không đọc được G-code (bgcode) thì dựa vào khối lượng slicer ghi sẵn, không tách được phần thải. */
function estimateFromMeta(file, plate) {
  const plates = file.meta?.plates ?? [];
  const selected = plates.find((item) => item.index === Number(plate)) ?? plates.find((item) => item.gcode) ?? plates[0];
  const weight = Number(selected?.weightG ?? file.meta?.filamentWeightG);
  if (!Number.isFinite(weight) || weight <= 0) return null;
  const filaments = (selected?.filaments ?? []).filter((item) => Number(item.usedG) > 0);
  const tools = filaments.length
    ? filaments.map((item) => ({ tool: Math.max(0, (Number(item.id) || 1) - 1), type: item.type ?? null, color: item.color ?? null, grams: round(Number(item.usedG)) }))
    : [{ tool: 0, type: file.meta?.filamentType ?? null, color: null, grams: round(weight) }];
  return {
    plate: selected?.index ?? 1,
    totalG: round(weight),
    grams: { model: round(weight), support: 0, adhesion: 0, purge: 0 },
    productG: round(weight),
    wasteG: 0,
    tools,
    layerCount: file.meta?.layerCount ?? null,
    layerStep: 1,
    layerGrams: [],
    material: tools[0].type,
    estimated: true,
  };
}

export function materialFor(file, plate) {
  return fileMaterial(file, plate) ?? estimateFromMeta(file, plate);
}

/** Đầu nhựa thứ `tool` lấy từ khay nào: theo bảng gán AMS nếu có, không thì khay trùng số; máy chỉ có một cuộn thì dùng cuộn đó. */
export function resolveSpools(printerId, tools, options = {}) {
  const spools = printerId ? readSpools().filter((spool) => spool.printerId === printerId) : [];
  return tools.map((entry) => {
    const mapped = Array.isArray(options.amsMapping) ? Number(options.amsMapping[entry.tool]) : NaN;
    const slot = Number.isInteger(mapped) && mapped >= 0 ? mapped : entry.tool;
    const spool = spools.find((item) => item.slot === slot) ?? (spools.length === 1 ? spools[0] : null);
    return { ...entry, slot, spool };
  });
}

export function costFor({ uses = [], seconds = 0, record = null }) {
  const settings = costSettings();
  const hours = Math.max(0, seconds) / 3600;
  const filamentCost = uses.reduce((sum, use) => sum + (use.grams / 1000) * (use.spool?.pricePerKg ?? settings.defaultPricePerKg), 0);
  const powerW = Number(record?.powerW) > 0 ? Number(record.powerW) : settings.defaultPowerW;
  const electricity = (powerW / 1000) * hours * settings.electricityPerKwh;
  const wear = (Number(record?.hourlyCost) || 0) * hours;
  return {
    filament: round(filamentCost),
    electricity: round(electricity),
    wear: round(wear),
    total: round(filamentCost + electricity + wear),
    currency: settings.currency,
    powerW,
  };
}

function publicAnalysis(analysis) {
  if (!analysis) return null;
  const { layerGrams, layerStep, ...rest } = analysis;
  return rest;
}

/** Kiểm tra trước khi in: đủ nhựa không, đúng loại không, tốn bao nhiêu và bao giờ xong. */
export function preflight({ fileId, printerId, plate, amsMapping } = {}) {
  const file = library.getFileRecord(fileId);
  const record = printerId && printerId !== 'any' ? printers.getRecord(printerId) : null;
  const analysis = materialFor(file, plate);
  const estimate = insights.adjustEstimate(record?.id ?? null, file, plate);
  const uses = analysis ? resolveSpools(record?.id ?? null, analysis.tools, { amsMapping }) : [];
  const hasSpools = record ? readSpools().some((spool) => spool.printerId === record.id) : false;
  const warnings = [];
  const spools = uses.map((use) => {
    const spool = use.spool;
    const enough = spool ? spool.remainingG >= use.grams : null;
    const materialMatch = spool && use.type ? spool.material === String(use.type).toUpperCase() : null;
    if (spool && !enough) warnings.push({ code: 'spool_low', tool: use.tool, spool: spool.name, needG: use.grams, remainingG: spool.remainingG });
    if (materialMatch === false) warnings.push({ code: 'material_mismatch', tool: use.tool, spool: spool.name, file: use.type, loaded: spool.material });
    if (!spool && hasSpools) warnings.push({ code: 'spool_unassigned', tool: use.tool, slot: use.slot });
    return {
      tool: use.tool,
      slot: use.slot,
      type: use.type ?? null,
      color: use.color ?? null,
      needG: use.grams,
      spoolId: spool?.id ?? null,
      spoolName: spool?.name ?? null,
      spoolColor: spool?.color ?? null,
      material: spool?.material ?? null,
      remainingG: spool?.remainingG ?? null,
      enough,
      materialMatch,
    };
  });
  const seconds = estimate.adjustedTime ?? estimate.estimatedTime ?? 0;
  return {
    fileId: file.id,
    printerId: record?.id ?? null,
    plate: analysis?.plate ?? (Number(plate) || null),
    material: publicAnalysis(analysis),
    estimate: { ...estimate, finishAt: seconds ? new Date(Date.now() + seconds * 1000).toISOString() : null },
    spools,
    cost: costFor({ uses, seconds, record }),
    warnings,
  };
}

function printedGrams(analysis, job) {
  const layer = Number(job.layer);
  if (layer > 0 && analysis.layerGrams?.length) return gramsAtLayer(analysis, layer) ?? 0;
  return (analysis.totalG * Math.min(100, Math.max(0, Number(job.progress) || 0))) / 100;
}

/**
 * Chốt nhựa và chi phí của một job vừa kết thúc rồi trừ vào cuộn đang gắn.
 * Xong trọn thì hỗ trợ, viền và nhựa xả là thải; hỏng hay huỷ thì toàn bộ phần đã đùn là thải.
 */
export function settleJob(job, seconds) {
  const record = job.printerId ? printers.findPrinter(job.printerId) : null;
  const file = job.fileId ? library.findFile(job.fileId) : null;
  const analysis = file ? materialFor(file, job.options?.plate) : null;
  if (!analysis) return { material: null, cost: costFor({ seconds, record }) };

  const completed = job.status === 'completed';
  const used = completed ? analysis.totalG : Math.min(analysis.totalG, printedGrams(analysis, job));
  const ratio = analysis.totalG > 0 ? used / analysis.totalG : 0;
  const grams = Object.fromEntries(Object.entries(analysis.grams).map(([group, value]) => [group, round(value * ratio)]));
  const uses = resolveSpools(job.printerId, analysis.tools, job.options).map((use) => ({ ...use, grams: round(use.grams * ratio) }));

  const now = new Date().toISOString();
  const touched = [];
  if (used > 0) {
    transaction(() => {
      for (const use of uses) {
        if (!use.spool || use.grams <= 0) continue;
        use.spool.remainingG = round(Math.max(0, use.spool.remainingG - use.grams), 1);
        use.spool.lastUsedAt = now;
        use.spool.updatedAt = now;
        writeSpool(use.spool);
        touched.push(use.spool);
      }
    });
  }
  for (const spool of touched) filamentEvents.emit('changed', { event: 'updated', spool: publicSpool(spool) });

  return {
    material: {
      usedG: round(used),
      productG: completed ? analysis.productG : 0,
      wasteG: completed ? analysis.wasteG : round(used),
      failedG: completed ? 0 : round(used),
      grams,
      material: analysis.material ?? null,
      estimated: Boolean(analysis.estimated),
      spools: uses.filter((use) => use.spool).map((use) => ({ spoolId: use.spool.id, name: use.spool.name, grams: use.grams, remainingG: use.spool.remainingG })),
    },
    cost: costFor({ uses, seconds, record }),
  };
}
