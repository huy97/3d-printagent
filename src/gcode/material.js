import { closeSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { openZip } from './zip.js';
import { fileFormat } from './metadata.js';

/**
 * Measure filament use in G-code per group: what becomes the part and what is thrown away (support, bed adhesion,
 * prime tower, purge on color change). Reads in chunks so a few hundred MB file never has to be loaded entirely.
 */

export const GROUPS = ['model', 'support', 'adhesion', 'purge'];

/** Density (g/cm3) used when the file carries no `filament_density`. */
export const DENSITY = { PLA: 1.24, PETG: 1.27, PET: 1.27, ABS: 1.04, ASA: 1.07, TPU: 1.21, PA: 1.14, PC: 1.2, PVA: 1.23, HIPS: 1.04 };
const DEFAULT_DIAMETER = 1.75;
const CHUNK = 4 * 1024 * 1024;
/** The cumulative per-layer weight array is downsampled to stay small when stored. */
const MAX_LAYER_POINTS = 400;
const GCODE_ENTRY = /^Metadata\/plate_(\d+)\.gcode$/;

export function densityOf(material) {
  const key = String(material ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  if (DENSITY[key]) return DENSITY[key];
  const found = Object.keys(DENSITY).find((name) => key.startsWith(name));
  return found ? DENSITY[found] : DENSITY.PLA;
}

function classify(name) {
  const text = String(name).trim().toLowerCase();
  if (/support/.test(text)) return 'support';
  if (/skirt|brim|raft/.test(text)) return 'adhesion';
  if (/prime|wipe|purge|flush|custom/.test(text)) return 'purge';
  return 'model';
}

function argument(line, letter) {
  const at = line.indexOf(letter, 1);
  if (at < 0) return null;
  let end = at + 1;
  while (end < line.length && line.charCodeAt(end) !== 32 && line.charCodeAt(end) !== 59) end += 1;
  const value = Number(line.slice(at + 1, end));
  return Number.isFinite(value) ? value : null;
}

function listValue(raw) {
  return String(raw)
    .split(/[;,]/)
    .map((item) => item.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

class Meter {
  constructor() {
    this.group = 'model';
    this.flushing = false;
    this.started = false;
    this.absoluteE = false;
    this.lastE = 0;
    this.tool = 0;
    this.mm = Object.fromEntries(GROUPS.map((group) => [group, 0]));
    this.tools = new Map();
    this.layers = [];
    this.total = 0;
    this.header = {};
    this.rest = '';
  }

  feed(text) {
    const lines = `${this.rest}${text}`.split('\n');
    this.rest = lines.pop();
    for (const line of lines) this.line(line);
  }

  end() {
    if (this.rest) this.line(this.rest);
    this.rest = '';
    this.layers.push(this.total);
  }

  layer() {
    if (this.started) this.layers.push(this.total);
    this.started = true;
  }

  line(raw) {
    const line = raw.trimStart();
    if (line.length === 0) return;
    if (line.charCodeAt(0) === 59) {
      const body = line.slice(1).trim();
      if (body.startsWith('FEATURE:')) this.group = classify(body.slice(8));
      else if (body.startsWith('TYPE:')) this.group = classify(body.slice(5));
      else if (body === 'CHANGE_LAYER' || body === 'LAYER_CHANGE' || body.startsWith('LAYER:')) this.layer();
      else if (body.startsWith('FLUSH_START')) this.flushing = true;
      else if (body.startsWith('FLUSH_END')) this.flushing = false;
      else {
        const match = body.match(/^(filament_density|filament_diameter|filament_type|filament_cost|filament_colour)\s*[=:]\s*(.+)$/);
        if (match) this.header[match[1]] = listValue(match[2]);
      }
      return;
    }
    const code = line.charCodeAt(0);
    if (code === 71 || code === 103) {
      if (line.startsWith('G1') || line.startsWith('G0') || line.startsWith('G2') || line.startsWith('G3')) {
        const e = argument(line, 'E');
        if (e === null) return;
        const extruded = this.absoluteE ? e - this.lastE : e;
        if (this.absoluteE) this.lastE = e;
        if (extruded <= 0) return;
        // Extrusion before the first layer marker is the prime line at the bed edge, not part of the model.
        const group = this.flushing || !this.started ? 'purge' : this.group;
        this.mm[group] += extruded;
        this.total += extruded;
        this.tools.set(this.tool, (this.tools.get(this.tool) ?? 0) + extruded);
        return;
      }
      if (line.startsWith('G92')) this.lastE = argument(line, 'E') ?? this.lastE;
      return;
    }
    if (code === 77) {
      if (line.startsWith('M82')) this.absoluteE = true;
      else if (line.startsWith('M83')) this.absoluteE = false;
      return;
    }
    if (code === 84) {
      const tool = Number(line.slice(1).split(/[\s;]/)[0]);
      if (Number.isInteger(tool) && tool >= 0 && tool < 64) this.tool = tool;
    }
  }
}

function round(value, digits = 2) {
  return Math.round(value * 10 ** digits) / 10 ** digits;
}

/** Convert mm of filament to grams using each tool's diameter and density. */
function summarize(meter, { plate = 1, material } = {}) {
  const header = meter.header;
  const types = header.filament_type ?? (material ? [material] : []);
  const densityAt = (tool) => Number(header.filament_density?.[tool] ?? header.filament_density?.[0]) || densityOf(types[tool] ?? types[0]);
  const diameterAt = (tool) => Number(header.filament_diameter?.[tool] ?? header.filament_diameter?.[0]) || DEFAULT_DIAMETER;
  const gramsPerMm = (tool) => (Math.PI * (diameterAt(tool) / 2) ** 2 * densityAt(tool)) / 1000;

  // Groups are not split per tool, convert with an average factor weighted by each tool's extrusion.
  let weighted = 0;
  const tools = [...meter.tools.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([tool, mm]) => {
      weighted += mm * gramsPerMm(tool);
      return { tool, type: types[tool] ?? types[0] ?? null, color: header.filament_colour?.[tool] ?? null, mm: round(mm, 1), grams: round(mm * gramsPerMm(tool)) };
    });
  const factor = meter.total > 0 ? weighted / meter.total : gramsPerMm(0);
  const grams = Object.fromEntries(GROUPS.map((group) => [group, round(meter.mm[group] * factor)]));

  const step = Math.max(1, Math.ceil(meter.layers.length / MAX_LAYER_POINTS));
  const layers = [];
  for (let at = 0; at < meter.layers.length; at += step) layers.push(round(meter.layers[at] * factor, 1));

  return {
    plate,
    totalMm: round(meter.total, 1),
    totalG: round(meter.total * factor),
    grams,
    productG: grams.model,
    wasteG: round(grams.support + grams.adhesion + grams.purge),
    tools,
    layerCount: meter.layers.length,
    layerStep: step,
    layerGrams: layers,
    density: round(densityAt(0), 3),
    diameter: diameterAt(0),
    material: types[0] ?? null,
  };
}

export function measureText(text, options) {
  const meter = new Meter();
  meter.feed(text);
  meter.end();
  return summarize(meter, options);
}

function measureFile(filePath, options) {
  const meter = new Meter();
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.alloc(CHUNK);
  const fd = openSync(filePath, 'r');
  try {
    let read;
    while ((read = readSync(fd, buffer, 0, CHUNK, null)) > 0) meter.feed(decoder.write(buffer.subarray(0, read)));
    meter.feed(decoder.end());
  } finally {
    closeSync(fd);
  }
  meter.end();
  return summarize(meter, options);
}

function measureBuffer(data, options) {
  const meter = new Meter();
  const decoder = new StringDecoder('utf8');
  for (let at = 0; at < data.length; at += CHUNK) meter.feed(decoder.write(data.subarray(at, at + CHUNK)));
  meter.feed(decoder.end());
  meter.end();
  return summarize(meter, options);
}

/** Measure filament for one plate; returns null when the file has no G-code (unsliced model, binary bgcode). */
export function analyzeMaterial(filePath, name, plate, options = {}) {
  const format = fileFormat(name);
  if (format === 'gcode') return measureFile(filePath, { ...options, plate: 1 });
  if (format !== '3mf') return null;
  const zip = openZip(filePath);
  try {
    const indexes = zip.entries
      .map((entry) => entry.name.match(GCODE_ENTRY))
      .filter(Boolean)
      .map((match) => Number(match[1]))
      .sort((left, right) => left - right);
    if (indexes.length === 0) return null;
    const index = indexes.includes(Number(plate)) ? Number(plate) : indexes[0];
    return measureBuffer(zip.read(`Metadata/plate_${index}.gcode`, { maxBytes: 2 * 1024 * 1024 * 1024 }), { ...options, plate: index });
  } finally {
    zip.close();
  }
}

/** Weight extruded through the end of layer `layer` (1-based), interpolated over the downsampled array. */
export function gramsAtLayer(analysis, layer) {
  const points = analysis?.layerGrams ?? [];
  if (points.length === 0 || !Number.isFinite(layer)) return null;
  if (layer < 1) return 0;
  const position = (layer - 1) / (analysis.layerStep || 1);
  const low = Math.min(points.length - 1, Math.floor(position));
  const high = Math.min(points.length - 1, low + 1);
  const ratio = position - low;
  return Math.min(analysis.totalG, points[low] + (points[high] - points[low]) * ratio);
}
