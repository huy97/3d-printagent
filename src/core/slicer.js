import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { PATHS, ensureDataDirs } from './paths.js';
import { configEvents, getConfig } from './config.js';
import * as library from './library.js';
import * as printers from './printers.js';
import { driverClass } from '../drivers/index.js';
import { openZip } from '../gcode/zip.js';
import { parseBed } from '../gcode/metadata.js';
import { createLogger } from '../util/logger.js';
import { badRequest, unsupported } from '../util/errors.js';

const log = createLogger('slicer');

const BIN_CANDIDATES = {
  darwin: [
    '/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer',
    '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio',
  ],
  linux: [
    '/usr/bin/orca-slicer',
    '/usr/local/bin/orca-slicer',
    '/opt/OrcaSlicer/orca-slicer',
    '/usr/bin/OrcaSlicer',
    '/usr/bin/bambu-studio',
    '/opt/BambuStudio/bambu-studio',
  ],
  win32: [
    'C:\\Program Files\\OrcaSlicer\\orca-slicer.exe',
    'C:\\Program Files\\Bambu Studio\\bambu-studio.exe',
  ],
};

/** The profiles directory sits next to the binary, varying by packaging. */
const PROFILE_CANDIDATES = ['../Resources/profiles', '../share/OrcaSlicer/profiles', '../share/BambuStudio/profiles', 'resources/profiles', '../resources/profiles', 'profiles'];

/** User-saved presets live in the app data directory, not next to the binary. */
const USER_VENDOR = 'User';

const INFILL_PATTERNS = [
  'concentric', 'zig-zag', 'grid', 'line', 'cubic', 'triangles', 'tri-hexagon', 'gyroid', 'honeycomb',
  'adaptivecubic', 'alignedrectilinear', '3dhoneycomb', 'hilbertcurve', 'archimedeanchords', 'octagramspiral',
  'supportcubic', 'lightning', 'crosshatch',
];

/** Patterns for solid surfaces: narrower than the infill list since only a few line layouts make sense there. */
const SURFACE_PATTERNS = ['concentric', 'zig-zag', 'monotonic', 'monotonicline', 'alignedrectilinear', 'hilbertcurve', 'archimedeanchords', 'octagramspiral'];

/**
 * Bambu plate types and their matching temperature keys in the filament profile.
 * A filament declaring 0 degrees for a plate cannot print on it, and the wrong pick makes the slicer bail out.
 * The list order is also the priority order when the printer does not say which plate is installed.
 */
const PLATES = {
  'Textured PEI Plate': 'textured_plate_temp',
  'High Temp Plate': 'hot_plate_temp',
  'Engineering Plate': 'eng_plate_temp',
  'Cool Plate': 'cool_plate_temp',
  'Supertack Plate': 'supertack_plate_temp',
};
const PLATE_NAMES = Object.keys(PLATES);

/** Lengths accept millimeters or a percentage of line width, e.g. "400%" or "2.5". */
const LENGTH_VALUE = /^\d{1,4}(\.\d{1,3})?%?$/;

/** Slice parameters exposed to users, mapped to BambuStudio/OrcaSlicer command-line flags. */
const OVERRIDES = {
  layerHeight: { flag: 'layer-height', type: 'number', min: 0.04, max: 0.8 },
  firstLayerHeight: { flag: 'initial-layer-print-height', type: 'number', min: 0.04, max: 1 },
  seam: { flag: 'seam-position', type: 'enum', values: ['nearest', 'aligned', 'back', 'random'] },
  ironing: { flag: 'ironing-type', type: 'enum', values: ['no ironing', 'top', 'topmost', 'solid'] },
  wallLoops: { flag: 'wall-loops', type: 'integer', min: 1, max: 10 },
  topLayers: { flag: 'top-shell-layers', type: 'integer', min: 0, max: 50 },
  bottomLayers: { flag: 'bottom-shell-layers', type: 'integer', min: 0, max: 50 },
  infill: { flag: 'sparse-infill-density', type: 'number', min: 0, max: 100 },
  infillPattern: { flag: 'sparse-infill-pattern', type: 'enum', values: INFILL_PATTERNS },
  outerWallSpeed: { flag: 'outer-wall-speed', type: 'number', min: 1, max: 1000 },
  innerWallSpeed: { flag: 'inner-wall-speed', type: 'number', min: 1, max: 1000 },
  infillSpeed: { flag: 'sparse-infill-speed', type: 'number', min: 1, max: 1000 },
  support: { flag: 'enable-support', type: 'flag' },
  supportType: { flag: 'support-type', type: 'enum', values: ['normal(auto)', 'tree(auto)', 'normal', 'tree', 'hybrid(auto)'] },
  supportThreshold: { flag: 'support-threshold-angle', type: 'integer', min: 0, max: 90 },
  nozzleTemp: { flag: 'nozzle-temperature', type: 'integer', min: 150, max: 350 },
  // The two parameters below are written into the profile rather than passed on the command line, since they depend on the plate in use.
  bedTemp: { flag: 'hot-plate-temp', type: 'integer', min: 0, max: 120, apply: 'filament' },
  plateType: { flag: 'curr-bed-type', type: 'enum', values: PLATE_NAMES, apply: 'machine' },
  brim: { flag: 'brim-type', type: 'enum', values: ['auto_brim', 'outer_only', 'inner_only', 'outer_and_inner', 'no_brim'] },
  brimWidth: { flag: 'brim-width', type: 'number', min: 0, max: 50 },
  spiralMode: { flag: 'spiral-mode', type: 'flag' },
  scale: { flag: 'scale', type: 'number', min: 0.05, max: 20 },
  rotate: { flag: 'rotate', type: 'number', min: -360, max: 360 },
  copies: { flag: 'clone-objects', type: 'clones', min: 1, max: 50 },
  arrange: { flag: 'arrange', type: 'flag' },
  allowRotations: { flag: 'allow-rotations', type: 'flag' },

  alternateExtraWall: { flag: 'alternate-extra-wall', type: 'bool' },
  embedWallIntoInfill: { flag: 'embedding-wall-into-infill', type: 'bool' },
  detectThinWall: { flag: 'detect-thin-wall', type: 'bool' },

  topSurfacePattern: { flag: 'top-surface-pattern', type: 'enum', values: SURFACE_PATTERNS },
  topSurfaceDensity: { flag: 'top-surface-density', type: 'percent', min: 0, max: 100 },
  topShellThickness: { flag: 'top-shell-thickness', type: 'number', min: 0, max: 20 },
  topPaintLayers: { flag: 'top-color-penetration-layers', type: 'integer', min: 0, max: 50 },
  bottomSurfacePattern: { flag: 'bottom-surface-pattern', type: 'enum', values: SURFACE_PATTERNS },
  bottomSurfaceDensity: { flag: 'bottom-surface-density', type: 'percent', min: 0, max: 100 },
  bottomShellThickness: { flag: 'bottom-shell-thickness', type: 'number', min: 0, max: 20 },
  bottomPaintLayers: { flag: 'bottom-color-penetration-layers', type: 'integer', min: 0, max: 50 },
  solidInfillPattern: { flag: 'internal-solid-infill-pattern', type: 'enum', values: SURFACE_PATTERNS },
  subTopSurfacePattern: { flag: 'sub-top-surface-pattern', type: 'enum', values: SURFACE_PATTERNS },

  fillMultiline: { flag: 'fill-multiline', type: 'integer', min: 1, max: 5 },
  infillAnchor: { flag: 'sparse-infill-anchor', type: 'length' },
  infillAnchorMax: { flag: 'sparse-infill-anchor-max', type: 'length' },

  infillWallOverlap: { flag: 'infill-wall-overlap', type: 'percent', min: 0, max: 100 },
  infillDirection: { flag: 'infill-direction', type: 'number', min: 0, max: 360 },
  bridgeAngle: { flag: 'bridge-angle', type: 'number', min: 0, max: 360 },
  minSparseInfillArea: { flag: 'minimum-sparse-infill-area', type: 'number', min: 0, max: 1000 },
  infillCombination: { flag: 'infill-combination', type: 'bool' },
  detectNarrowSolidInfill: { flag: 'detect-narrow-internal-solid-infill', type: 'bool' },
  ensureVerticalShell: { flag: 'ensure-vertical-shell-thickness', type: 'enum', values: ['enabled', 'disabled'] },
  detectFloatingShell: { flag: 'detect-floating-vertical-shell', type: 'bool' },
};

const EXTRA_KEY = /^[a-z][a-z0-9_]{1,60}$/;
const EXTRA_VALUE = /^[\w .,:;/+()%-]{0,200}$/;

let cache = null;

function configured() {
  const slicer = getConfig().slicer ?? {};
  return {
    binPath: slicer.binPath || null,
    profilesDir: slicer.profilesDir || null,
    userProfilesDir: slicer.userProfilesDir || null,
    timeoutSec: Number(slicer.timeoutSec) || 900,
  };
}

function findBin(explicit) {
  if (explicit) return existsSync(explicit) ? explicit : null;
  return (BIN_CANDIDATES[process.platform] ?? []).find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Presets the user saved in Bambu Studio / OrcaSlicer (for example "Generic PETG @BBL A2L - 230C").
 * Without reading these, the web slicer slices with stock settings, unlike what the user prints from the app.
 */
function findUserProfilesDir(bin, explicit) {
  if (explicit) return existsSync(explicit) ? explicit : null;
  const app = /orca/i.test(bin) ? 'OrcaSlicer' : 'BambuStudio';
  const home = os.homedir();
  const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const candidates = {
    darwin: [path.join(home, 'Library', 'Application Support', app, 'user')],
    win32: [path.join(roaming, app, 'user')],
  }[process.platform] ?? [path.join(home, '.config', app, 'user'), path.join(home, `.${app}`, 'user')];
  return candidates.find((dir) => existsSync(dir)) ?? null;
}

function findProfilesDir(bin, explicit) {
  if (explicit) return existsSync(explicit) ? explicit : null;
  const base = path.dirname(bin);
  for (const candidate of PROFILE_CANDIDATES) {
    const dir = path.resolve(base, candidate);
    if (existsSync(path.join(dir, 'BBL'))) return dir;
  }
  return null;
}

/**
 * Folds user presets into the same index as the system profiles. The index must be complete before descriptions
 * can be built, since a user preset only stores the changed keys and inherits the rest from its parent.
 */
function scanUserProfiles(dir, profiles) {
  const { machines, processes, filaments, index, owners } = profiles;
  const kinds = [['machine', machines], ['process', processes], ['filament', filaments]];
  const found = [];
  for (const user of readdirSync(dir, { withFileTypes: true })) {
    if (!user.isDirectory()) continue;
    for (const [kind, target] of kinds) {
      const kindDir = path.join(dir, user.name, kind);
      if (!existsSync(kindDir)) continue;
      for (const file of readdirSync(kindDir)) {
        if (!file.endsWith('.json')) continue;
        let data;
        try {
          data = JSON.parse(readFileSync(path.join(kindDir, file), 'utf8'));
        } catch {
          continue;
        }
        if (!data.name) continue;
        const full = path.join(kindDir, file);
        index.set(`${kind}|${USER_VENDOR}|${data.name}`, full);
        owners.set(full, USER_VENDOR);
        if (!index.has(`${kind}|${data.name}`)) index.set(`${kind}|${data.name}`, full);
        found.push({ kind, target, name: data.name });
      }
    }
  }
  for (const { kind, target, name } of found) {
    const data = flattenProfile(profiles, kind, USER_VENDOR, name);
    const item = { name, vendor: USER_VENDOR, path: index.get(`${kind}|${USER_VENDOR}|${name}`) };
    if (kind === 'machine') {
      item.printerModel = data.printer_model ?? null;
      item.nozzle = Number(Array.isArray(data.nozzle_diameter) ? data.nozzle_diameter[0] : data.nozzle_diameter) || null;
      item.defaultProcess = data.default_print_profile ?? null;
      item.defaultFilament = Array.isArray(data.default_filament_profile) ? data.default_filament_profile[0] : (data.default_filament_profile ?? null);
    } else {
      item.printers = Array.isArray(data.compatible_printers) ? data.compatible_printers : [];
      if (kind === 'filament') item.filamentType = data.filament_type?.[0] ?? null;
    }
    target.push(item);
  }
  return found.length;
}

/** Reads every system profile once and keeps it in RAM; 3400 files take about half a second. */
function scanProfiles(dir, userDir) {
  const vendors = [];
  const machines = [];
  const processes = [];
  const filaments = [];
  const index = new Map();
  // Remember which vendor owns which profile, so walking up to a parent knows which vendor directory to search.
  const owners = new Map();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const vendor = entry.name;
    let count = 0;
    for (const [kind, target] of [['machine', machines], ['process', processes], ['filament', filaments]]) {
      const kindDir = path.join(dir, vendor, kind);
      if (!existsSync(kindDir)) continue;
      for (const file of readdirSync(kindDir)) {
        if (!file.endsWith('.json')) continue;
        let data;
        try {
          data = JSON.parse(readFileSync(path.join(kindDir, file), 'utf8'));
        } catch {
          continue;
        }
        if (!data.name) continue;
        const full = path.join(kindDir, file);
        index.set(`${kind}|${vendor}|${data.name}`, full);
        owners.set(full, vendor);
        if (!index.has(`${kind}|${data.name}`)) index.set(`${kind}|${data.name}`, full);
        if (data.instantiation !== 'true') continue;
        const item = { name: data.name, vendor, path: full };
        if (kind === 'machine') {
          item.printerModel = data.printer_model ?? null;
          item.nozzle = Number(Array.isArray(data.nozzle_diameter) ? data.nozzle_diameter[0] : data.nozzle_diameter) || null;
          item.defaultProcess = data.default_print_profile ?? null;
          item.defaultFilament = Array.isArray(data.default_filament_profile) ? data.default_filament_profile[0] : (data.default_filament_profile ?? null);
        } else {
          item.printers = Array.isArray(data.compatible_printers) ? data.compatible_printers : [];
          if (kind === 'filament') {
            item.filamentType = data.filament_type?.[0] ?? null;
            item.inherits = data.inherits ?? null;
          }
        }
        target.push(item);
        count += 1;
      }
    }
    if (count > 0) vendors.push(vendor);
  }

  // Leaf profiles mostly inherit the material from their root rather than declaring it, so walking up is the only way to tell PLA from PETG.
  const known = new Map();
  const inheritedType = (vendor, name, seen = new Set()) => {
    if (!name) return null;
    const key = `${vendor}|${name}`;
    if (known.has(key)) return known.get(key);
    const file = index.get(`filament|${vendor}|${name}`) ?? index.get(`filament|${name}`);
    let value = null;
    if (file && !seen.has(file)) {
      seen.add(file);
      try {
        const data = JSON.parse(readFileSync(file, 'utf8'));
        value = data.filament_type?.[0] ?? inheritedType(owners.get(file) ?? vendor, data.inherits, seen);
      } catch {
        value = null;
      }
    }
    known.set(key, value);
    return value;
  };
  for (const item of filaments) {
    if (!item.filamentType) item.filamentType = inheritedType(item.vendor, item.inherits);
    delete item.inherits;
  }

  const result = { vendors: vendors.sort(), machines, processes, filaments, index, owners };
  // Scanned last so user presets can walk up to their vendor's parent profiles.
  if (userDir && scanUserProfiles(userDir, result) > 0) result.vendors.push(USER_VENDOR);
  return result;
}

/**
 * The CLI loads only the file it is given and does not follow `inherits`, so a leaf profile falls back
 * to root values (PLA 200°C instead of 220°C). Merge from ancestors down to the leaf before calling the slicer.
 * Newer machines also split long G-code blocks (start, end, layer change, timelapse) into separate files
 * declared under `include`; skipping those leaves the printer running the slicer's default start G-code.
 */
function flattenProfile(profiles, kind, vendor, name, seen = new Set()) {
  const { index, owners } = profiles;
  const file = index.get(`${kind}|${vendor}|${name}`) ?? index.get(`${kind}|${name}`);
  if (!file || seen.has(file)) return {};
  seen.add(file);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  // Twelve vendors name their root profile `fdm_filament_pet`, so keep walking with the vendor of the file
  // just read; keeping the original vendor would send a user preset to another vendor's root profile.
  const owner = owners.get(file) ?? vendor;
  const parent = data.inherits ? flattenProfile(profiles, kind, owner, data.inherits, seen) : {};
  const included = {};
  for (const part of Array.isArray(data.include) ? data.include : []) {
    Object.assign(included, flattenProfile(profiles, kind, owner, part, seen));
  }
  // The leaf profile's own values override the includes, which override the parent.
  const merged = { ...parent, ...included, ...data };
  delete merged.inherits;
  delete merged.include;
  return merged;
}

function detect() {
  const settings = configured();
  if (cache && cache.binPath === settings.binPath && cache.profilesDirSetting === settings.profilesDir && cache.userDirSetting === settings.userProfilesDir) return cache;
  const bin = findBin(settings.binPath);
  const profilesDir = bin ? findProfilesDir(bin, settings.profilesDir) : null;
  const userDir = bin ? findUserProfilesDir(bin, settings.userProfilesDir) : null;
  let profiles = null;
  if (profilesDir) {
    const started = Date.now();
    try {
      profiles = scanProfiles(profilesDir, userDir);
      const mine = profiles.filaments.concat(profiles.processes, profiles.machines).filter((item) => item.vendor === USER_VENDOR).length;
      log.info(`Read ${profiles.machines.length} machine profiles from ${profilesDir} in ${Date.now() - started}ms${mine > 0 ? `, including ${mine} saved presets` : ''}`);
    } catch (error) {
      log.warn(`Failed to read slicer profiles: ${error.message}`);
    }
  }
  cache = { binPath: settings.binPath, profilesDirSetting: settings.profilesDir, userDirSetting: settings.userProfilesDir, bin, profilesDir, userDir, profiles };
  return cache;
}

export function resetSlicerCache() {
  cache = null;
}

configEvents.on('changed', resetSlicerCache);

export function slicerStatus() {
  const found = detect();
  const kind = found.bin ? (/orca/i.test(found.bin) ? 'orca' : 'bambu') : null;
  return {
    available: Boolean(found.bin && found.profiles),
    bin: found.bin,
    kind,
    profilesDir: found.profilesDir,
    userProfilesDir: found.userDir ?? null,
    vendors: found.profiles?.vendors ?? [],
    machines: found.profiles?.machines.length ?? 0,
  };
}

function requireSlicer() {
  const found = detect();
  if (!found.bin) throw unsupported('error.slicer_not_found');
  if (!found.profiles) throw unsupported('error.slicer_profiles_not_found', { path: found.profilesDir ?? '-' });
  return found;
}

/** Suggests machine profiles from the selected printer's model, so the UI preselects the right one. */
function suggestMachines(machines, printerId) {
  if (!printerId) return [];
  let record;
  try {
    record = printers.getRecord(printerId);
  } catch {
    return [];
  }
  const hints = [record.connection?.model, record.name].filter(Boolean).map((value) => String(value).toLowerCase());
  const matched = machines.filter((machine) => {
    const model = String(machine.printerModel ?? '').toLowerCase();
    return hints.some((hint) => model.includes(hint) || hint.includes(model));
  });
  // A running printer reports its nozzle diameter, so prefer the matching profile before the common 0.4.
  const nozzle = Number(printers.statusOf(record.id)?.extra?.nozzleDiameter) || null;
  const rank = (machine) => (nozzle && machine.nozzle === nozzle ? 0 : machine.nozzle === 0.4 ? 1 : 2);
  return matched.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export function listProfiles({ vendor, machine, printerId } = {}) {
  const { profiles } = requireSlicer();
  const suggested = suggestMachines(profiles.machines, printerId);
  const machines = (vendor ? profiles.machines.filter((item) => item.vendor === vendor) : profiles.machines)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  const selected = machine ? profiles.machines.find((item) => item.name === machine) : null;
  const compatible = (list) => (selected ? list.filter((item) => item.printers.includes(selected.name)) : []);
  return {
    vendors: profiles.vendors,
    machines: machines.map(({ path: _path, ...rest }) => rest),
    suggestedMachines: suggested.map((item) => item.name),
    processes: compatible(profiles.processes).map(({ path: _path, printers: _printers, ...rest }) => rest),
    filaments: compatible(profiles.filaments).map(({ path: _path, printers: _printers, ...rest }) => rest),
    defaults: selected ? { process: selected.defaultProcess, filament: selected.defaultFilament } : null,
  };
}

/** Profiles store everything as strings ("15%", "1"); coerce to the same types as user parameters to compare them. */
function profileValue(spec, raw) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null || value === '') return undefined;
  if (spec.type === 'flag' || spec.type === 'bool') return !['0', 'false', 'nil'].includes(String(value).trim());
  if (spec.type === 'enum' || spec.type === 'length') return String(value).trim();
  const numeric = Number(String(value).replace('%', ''));
  return Number.isFinite(numeric) ? numeric : undefined;
}

/**
 * Current values of the exposed parameters, read straight from the selected profiles. Without knowing what
 * a change starts from, every suggestion is a guess, so the AI advice needs exactly this table.
 */
export function profileValues(selection = {}) {
  const { profiles } = requireSlicer();
  const base = profileData(profiles, selection);
  const plate = choosePlate(base.filamentData, base.filamentItem.name, base.model.default_bed_type, null);
  return { machine: base.machineItem.name, process: base.processItem.name, filament: base.filamentItem.name, values: optionValues(base.data, base.filamentData, plate) };
}

/** Raw values from the merged profiles, so the agent can look up keys with no field on the form before setting them by hand. */
export function profileSettings(selection = {}, { keys = [], search = '' } = {}) {
  const { profiles } = requireSlicer();
  const base = profileData(profiles, selection);
  const wanted = new Set(keys.map((key) => String(key).trim().toLowerCase().replace(/-/g, '_')));
  const needle = String(search).trim().toLowerCase().replace(/-/g, '_');
  const values = {};
  for (const [key, raw] of Object.entries(base.data)) {
    if (BOOKKEEPING.has(key) || !EXTRA_KEY.test(key)) continue;
    if (!wanted.has(key) && !(needle && key.includes(needle))) continue;
    const value = Array.isArray(raw) ? raw.join(',') : typeof raw === 'object' || raw === undefined ? null : String(raw);
    if (value === null) continue;
    values[key] = value.slice(0, 200);
    if (Object.keys(values).length >= 60) break;
  }
  return {
    machine: base.machineItem.name,
    process: base.processItem.name,
    filament: base.filamentItem.name,
    values,
    missing: [...wanted].filter((key) => !(key in values)),
  };
}

function profileData(profiles, { machine, process: processName, filament } = {}) {
  const machineItem = pickProfile(profiles.machines, machine, 'machine');
  const compatible = (list) => list.filter((item) => item.printers.includes(machineItem.name));
  const processItem = pickProfile(
    profiles.processes,
    processName ?? machineItem.defaultProcess ?? compatible(profiles.processes)[0]?.name,
    'process',
  );
  const filamentItem = pickProfile(
    profiles.filaments,
    filament ?? machineItem.defaultFilament ?? compatible(profiles.filaments)[0]?.name,
    'filament',
  );
  const machineData = flattenProfile(profiles, 'machine', machineItem.vendor, machineItem.name);
  const filamentData = flattenProfile(profiles, 'filament', filamentItem.vendor, filamentItem.name);
  const data = { ...machineData, ...flattenProfile(profiles, 'process', processItem.vendor, processItem.name), ...filamentData };
  const model = machineItem.printerModel ? flattenProfile(profiles, 'machine', machineItem.vendor, machineItem.printerModel) : {};
  return { machineItem, processItem, filamentItem, data, filamentData, model };
}

function optionValues(data, filamentData, plate) {
  const values = {};
  for (const [key, spec] of Object.entries(OVERRIDES)) {
    const value = profileValue(spec, data[spec.flag.replace(/-/g, '_')]);
    if (value !== undefined) values[key] = value;
  }
  // Bed temperature lives in a per-plate field, and the wrong field returns the number for an unused plate.
  if (plate) {
    values.plateType = plate;
    const temp = profileValue(OVERRIDES.bedTemp, filamentData[PLATES[plate]]);
    if (temp !== undefined) values.bedTemp = temp;
  }
  return values;
}

const SETTINGS_ENTRY = 'Metadata/project_settings.config';
/** One-off operations on the model, not print settings, so they are not reloaded into the form and presets do not carry them. */
export const ONE_OFF_OPTIONS = new Set(['scale', 'rotate', 'copies', 'arrange', 'allowRotations']);
/** Values the slicer fills in when the profile does not declare the key, taken from BambuStudio output files. */
const SLICER_DEFAULTS = {
  brim: 'auto_brim',
  alternateExtraWall: false,
  embedWallIntoInfill: false,
  solidInfillPattern: 'zig-zag',
  subTopSurfacePattern: 'monotonic',
  infillAnchor: '400%',
  infillAnchorMax: '20',
  bridgeAngle: 0,
  detectNarrowSolidInfill: true,
  ensureVerticalShell: 'enabled',
};
/** Keys the slicer writes on export, not settings the user chose. */
const BOOKKEEPING = new Set([
  'from', 'name', 'version', 'inherits', 'inherits_group', 'different_settings_to_system',
  'print_settings_id', 'printer_settings_id', 'filament_settings_id', 'compatible_printers', 'print_compatible_printers',
]);

function sameValue(left, right) {
  if (typeof left === 'number' && typeof right === 'number') return Math.abs(left - right) < 1e-6;
  return String(left) === String(right);
}

/** The slicer rewrites numbers its own way ("12" for "12.0", "0.5,0.5" for "0.5x0.5"), so plain string comparison reports false changes. */
function sameSetting(left, right) {
  const parts = (text) => text.split(/[,x]/).map((part) => {
    const numeric = Number(part.trim().replace(/%$/, ''));
    return part.trim() !== '' && Number.isFinite(numeric) ? numeric : part.trim();
  });
  const a = parts(left);
  const b = parts(right);
  return a.length === b.length && a.every((value, index) => sameValue(value, b[index]));
}

function scalar(value) {
  if (Array.isArray(value)) return value.length === 1 ? scalar(value[0]) : null;
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

/**
 * Settings of a sliced file, read from the slicer config embedded in it so it reads the same anywhere.
 * The slicer records only final values, not which fields changed, so comparing against the source profiles isolates the user's edits.
 */
export function readSliceSettings(fileId) {
  const record = library.getFileRecord(fileId);
  if (record.format !== '3mf' || record.meta?.sliced !== true) return null;
  const zip = openZip(library.filePath(record));
  let settings = null;
  try {
    const raw = zip.has(SETTINGS_ENTRY) ? zip.read(SETTINGS_ENTRY, { maxBytes: 16 * 1024 * 1024 }) : null;
    settings = raw ? JSON.parse(raw.toString('utf8')) : null;
  } catch {
    settings = null;
  } finally {
    zip.close();
  }
  if (!settings || typeof settings !== 'object') return null;

  const result = {
    fileId: record.id,
    machine: scalar(settings.printer_settings_id),
    process: scalar(settings.print_settings_id),
    filament: scalar(settings.filament_settings_id),
    options: {},
    extra: {},
  };
  const found = detect();
  if (!found.profiles || !result.machine) return result;
  let base;
  try {
    base = profileData(found.profiles, result);
  } catch {
    // The profile was deleted or the file was sliced elsewhere: still return the names so the form can reselect, just without isolating the edits.
    return result;
  }

  const plate = PLATES[settings.curr_bed_type] ? settings.curr_bed_type : null;
  const auto = choosePlate(base.filamentData, base.filamentItem.name, base.model.default_bed_type, null);
  const applied = optionValues(settings, settings, plate);
  // Compare bed temperature against the plate actually used, otherwise changing the plate alone counts as a temperature change.
  const original = { ...optionValues(base.data, base.filamentData, plate ?? auto), plateType: auto ?? undefined };
  for (const [key, value] of Object.entries(applied)) {
    if (ONE_OFF_OPTIONS.has(key)) continue;
    // The form can only turn flags on, there is no way to turn off a flag the profile enables.
    if (OVERRIDES[key].type === 'flag' && value !== true) continue;
    // When the profile does not declare it the slicer fills in a default; with no known default, return it anyway, an extra field beats losing a setting on the next slice.
    const expected = original[key] ?? SLICER_DEFAULTS[key];
    if (expected === undefined || !sameValue(value, expected)) result.options[key] = value;
  }

  const covered = new Set(['nozzle_temperature_initial_layer']);
  for (const spec of Object.values(OVERRIDES)) covered.add(spec.flag.replace(/-/g, '_'));
  for (const key of Object.values(PLATES)) covered.add(key).add(`${key}_initial_layer`);
  for (const [key, raw] of Object.entries(settings)) {
    if (covered.has(key) || BOOKKEEPING.has(key) || !(key in base.data) || !EXTRA_KEY.test(key)) continue;
    const value = scalar(raw);
    const before = scalar(base.data[key]);
    if (value === null || !before || before === 'nil' || sameSetting(value, before) || !EXTRA_VALUE.test(value)) continue;
    result.extra[key] = value;
  }
  return result;
}

/**
 * A machine's standard bed size, read from the slicer profile.
 * Unsliced models carry no bed size, so the viewer borrows the target printer's.
 */
export function machineBed({ machine, printerId } = {}) {
  const found = detect();
  if (!found.profiles) return null;
  const list = found.profiles.machines;
  // A quick preview from the file list has no machine selected, so borrow a printer declared in the agent.
  const fallback = machine || printerId ? null : printers.listPrinters()[0];
  const name = machine || fallback?.slicer?.machine || null;
  const selected = (name ? list.find((item) => item.name === name) : null) ?? suggestMachines(list, printerId ?? fallback?.id)[0] ?? null;
  if (!selected) return null;
  const data = flattenProfile(found.profiles, 'machine', selected.vendor, selected.name);
  const bed = parseBed(data);
  return bed ? { ...bed, model: bed.model ?? selected.printerModel ?? null, machine: selected.name } : null;
}

/** First-layer bed temperature the filament profile declares for a plate type; 0 means it cannot print on that plate. */
function plateTemp(filament, plate) {
  const key = PLATES[plate];
  const raw = filament[`${key}_initial_layer`] ?? filament[key];
  const value = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Picks the plate for this slice.
 * Left unset, the slicer defaults to "Cool Plate", which PETG, ABS and PA cannot use, so it bails out.
 * Returns null when the filament profile declares no bed temperature at all (non-Bambu machines), leaving it to the slicer.
 */
function choosePlate(filament, name, preferred, wanted) {
  const usable = PLATE_NAMES.filter((plate) => plateTemp(filament, plate) > 0);
  if (usable.length === 0) return null;
  if (wanted) {
    if (!usable.includes(wanted)) throw badRequest('error.plate_incompatible', { filament: name, plate: wanted, plates: usable.join(', ') });
    return wanted;
  }
  return usable.includes(preferred) ? preferred : usable[0];
}

function pickProfile(list, name, field) {
  const found = list.find((item) => item.name === name);
  if (!found) throw badRequest('error.slicer_profile_not_found', { field, name });
  return found;
}

export function optionSpecs() {
  return Object.entries(OVERRIDES).map(([key, spec]) => ({ key, ...spec }));
}

/** Keeps the valid parameters and clamps them into range; used for suggestions, where one bad field should not discard the whole answer. */
export function sanitizeOptions(options = {}) {
  const clean = {};
  for (const [key, spec] of Object.entries(OVERRIDES)) {
    const value = options[key];
    if (value === undefined || value === null || value === '') continue;
    if (spec.type === 'flag' || spec.type === 'bool') {
      if (typeof value === 'boolean') clean[key] = value;
      else if (value === 'true' || value === 'false') clean[key] = value === 'true';
      continue;
    }
    if (spec.type === 'enum') {
      if (spec.values.includes(String(value))) clean[key] = String(value);
      continue;
    }
    if (spec.type === 'length') {
      if (LENGTH_VALUE.test(String(value).trim())) clean[key] = String(value).trim();
      continue;
    }
    const numeric = Number(String(value).replace('%', ''));
    if (!Number.isFinite(numeric)) continue;
    const clamped = Math.min(spec.max, Math.max(spec.min, numeric));
    clean[key] = spec.type === 'integer' ? Math.round(clamped) : clamped;
  }
  return clean;
}

/** Hand-added slicer parameters, filtered by the same rules extraArgs uses when slicing but skipping bad lines instead of failing. */
export function sanitizeExtra(extra) {
  const clean = {};
  if (!extra || typeof extra !== 'object') return clean;
  for (const [key, raw] of Object.entries(extra).slice(0, 100)) {
    const flag = String(key).trim().toLowerCase().replace(/-/g, '_');
    if (raw === undefined || raw === null || raw === '' || !EXTRA_KEY.test(flag)) continue;
    const value = String(raw);
    if (EXTRA_VALUE.test(value)) clean[flag] = value;
  }
  return clean;
}

function overrideArgs(options = {}) {
  const args = [];
  // After copying, the plate must be rearranged or the copies overlap.
  let arrange = options.arrange === true || options.arrange === 'true';
  for (const [key, spec] of Object.entries(OVERRIDES)) {
    const value = options[key];
    if (value === undefined || value === null || value === '') continue;
    if (key === 'arrange' || spec.apply) continue;
    if (spec.type === 'flag') {
      if (value === true || value === 'true') args.push(`--${spec.flag}`);
      continue;
    }
    if (spec.type === 'clones') {
      const count = Math.round(Number(value));
      if (!Number.isFinite(count) || count < spec.min || count > spec.max) {
        throw badRequest('error.slicer_option_range', { option: key, min: spec.min, max: spec.max });
      }
      if (count > 1) {
        args.push(`--${spec.flag}`, String(count));
        arrange = true;
      }
      continue;
    }
    if (spec.type === 'bool') {
      // The slicer registers these keys as bare flags, so the value must be attached; separated, it is read as an input filename.
      args.push(`--${spec.flag}=${value === true || value === 'true' ? '1' : '0'}`);
      continue;
    }
    if (spec.type === 'enum') {
      if (!spec.values.includes(String(value))) throw badRequest('error.slicer_option_invalid', { option: key, value });
      args.push(`--${spec.flag}`, String(value));
      continue;
    }
    if (spec.type === 'length') {
      const text = String(value).trim();
      if (!LENGTH_VALUE.test(text)) throw badRequest('error.slicer_option_invalid', { option: key, value });
      args.push(`--${spec.flag}`, text);
      continue;
    }
    const numeric = Number(String(value).replace('%', ''));
    if (!Number.isFinite(numeric) || numeric < spec.min || numeric > spec.max) {
      throw badRequest('error.slicer_option_range', { option: key, min: spec.min, max: spec.max });
    }
    const rounded = spec.type === 'integer' ? String(Math.round(numeric)) : String(numeric);
    args.push(`--${spec.flag}`, spec.type === 'percent' ? `${rounded}%` : rounded);
  }
  if (arrange) args.push('--arrange', '1');
  return [...args, ...extraArgs(options.extra)];
}

/** Escape hatch for rarely used settings: the slicer accepts any config key as a command-line flag. */
function extraArgs(extra) {
  if (!extra || typeof extra !== 'object') return [];
  const args = [];
  for (const [key, raw] of Object.entries(extra)) {
    if (raw === undefined || raw === null || raw === '') continue;
    const flag = String(key).trim().toLowerCase().replace(/-/g, '_');
    if (!EXTRA_KEY.test(flag)) throw badRequest('error.slicer_option_invalid', { option: key, value: '' });
    if (raw === true || raw === 'true') {
      args.push(`--${flag.replace(/_/g, '-')}`);
      continue;
    }
    if (raw === false || raw === 'false') continue;
    const value = String(raw);
    if (!EXTRA_VALUE.test(value)) throw badRequest('error.slicer_option_invalid', { option: key, value });
    args.push(`--${flag.replace(/_/g, '-')}`, value);
  }
  return args;
}

function runSlicer(bin, args, { timeoutSec, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutSec * 1000);
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-200000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-200000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: error.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

const NEEDS_DISPLAY = /cannot open display|GTK|Gtk|X11|GLX|DISPLAY/;

function readResult(dir) {
  const file = path.join(dir, 'result.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function summarize(result) {
  const plate = result?.sliced_plates?.[0];
  if (!plate) return null;
  return {
    estimatedTime: Math.round(plate.total_predication ?? 0) || null,
    filamentWeightG: Math.round((plate.filaments ?? []).reduce((sum, item) => sum + (item.total_used_g ?? 0), 0) * 100) / 100 || null,
    layerHeight: result.layer_height ? Math.round(result.layer_height * 100) / 100 : null,
    infill: result.sparse_infill_density ?? null,
    warning: plate.warning_message || null,
  };
}

/** Printers that accept 3mf keep the slicer output as is, the rest get the G-code extracted from it. */
function outputFor(record, sourceName, slicedPath, workDir) {
  const formats = driverClass(record.driver).formats;
  const base = sourceName.replace(/\.[^.]+$/, '');
  if (formats.includes('3mf')) return { file: slicedPath, name: `${base}.gcode.3mf` };
  const zip = openZip(slicedPath);
  try {
    const entry = zip.entries.find((item) => /^Metadata\/plate_\d+\.gcode$/.test(item.name));
    if (!entry) throw badRequest('error.slicer_no_gcode');
    const gcode = zip.read(entry.name, { maxBytes: 2 * 1024 * 1024 * 1024 });
    const dest = path.join(workDir, `${base}.gcode`);
    writeFileSync(dest, gcode);
    return { file: dest, name: `${base}.gcode` };
  } finally {
    zip.close();
  }
}

let chain = Promise.resolve();

/** Slicing runs serially: one job at a time, so two slicer processes do not fight over the CPU. */
function enqueue(action) {
  const next = chain.then(action, action);
  chain = next.then(() => undefined, () => undefined);
  return next;
}

export function sliceModel(input = {}) {
  return enqueue(() => runSlice(input));
}

async function runSlice(input) {
  const { bin, profiles } = requireSlicer();
  const settings = configured();
  const source = library.getFileRecord(input.fileId ?? input.file);
  if (source.format !== 'model' && !(source.format === '3mf' && source.meta?.sliced === false)) {
    throw badRequest('error.slicer_source_invalid', { name: source.name });
  }
  const record = printers.getRecord(input.printerId ?? input.printer);
  const machine = pickProfile(profiles.machines, input.machine, 'machine');
  const compatible = (list) => list.filter((item) => item.printers.includes(machine.name));
  const processProfile = pickProfile(
    profiles.processes,
    input.process ?? machine.defaultProcess ?? compatible(profiles.processes)[0]?.name,
    'process',
  );
  const filament = pickProfile(
    profiles.filaments,
    input.filament ?? machine.defaultFilament ?? compatible(profiles.filaments)[0]?.name,
    'filament',
  );

  ensureDataDirs();
  const workDir = mkdtempSync(path.join(PATHS.tmp, 'slice-'));
  const started = Date.now();
  try {
    const options = input.options ?? input;
    const filamentData = flattenProfile(profiles, 'filament', filament.vendor, filament.name);
    const machineData = flattenProfile(profiles, 'machine', machine.vendor, machine.name);
    // The default plate is declared in the printer model file, not the machine profile, so read one level further.
    const model = machine.printerModel ? flattenProfile(profiles, 'machine', machine.vendor, machine.printerModel) : {};
    const plate = choosePlate(filamentData, filament.name, model.default_bed_type, options.plateType);
    // Check ranges first, then the nozzle-specific rules, so the reported error is the most basic one.
    const overrides = overrideArgs(options);
    // A layer thicker than the nozzle only makes the slicer say "invalid parameters", so block it early to show what is wrong.
    const nozzle = Number(Array.isArray(machineData.nozzle_diameter) ? machineData.nozzle_diameter[0] : machineData.nozzle_diameter) || machine.nozzle;
    for (const key of ['layerHeight', 'firstLayerHeight']) {
      const height = Number(options[key]);
      if (nozzle && Number.isFinite(height) && height > nozzle) throw badRequest('error.layer_too_thick', { option: key, value: height, nozzle });
    }
    if (plate) machineData.curr_bed_type = plate;
    // A user bed temperature must be written into the field of the plate in use, the slicer ignores the wrong field.
    const bedTemp = options.bedTemp === undefined || options.bedTemp === null || options.bedTemp === '' ? null : Number(options.bedTemp);
    if (plate && bedTemp !== null && Number.isFinite(bedTemp)) {
      filamentData[PLATES[plate]] = [String(Math.round(bedTemp))];
      filamentData[`${PLATES[plate]}_initial_layer`] = [String(Math.round(bedTemp))];
    }
    // The command-line flag only changes later layers; the first layer and the prime line still heat per the profile unless this field is written too.
    const nozzleTemp = options.nozzleTemp === undefined || options.nozzleTemp === null || options.nozzleTemp === '' ? null : Number(options.nozzleTemp);
    if (nozzleTemp !== null && Number.isFinite(nozzleTemp)) {
      filamentData.nozzle_temperature = [String(Math.round(nozzleTemp))];
      filamentData.nozzle_temperature_initial_layer = [String(Math.round(nozzleTemp))];
    }

    const processData = flattenProfile(profiles, 'process', processProfile.vendor, processProfile.name);
    const formats = driverClass(record.driver).formats;
    // Same source file, same merged profiles and same parameters give the same slice, so reuse the old one.
    const sliceKey = source.sha256
      ? createHash('sha256')
          .update(JSON.stringify([source.sha256, machineData, processData, filamentData, overrides, plate, formats.includes('3mf')]))
          .digest('hex')
      : null;
    const cached = input.cache === false ? null : library.findSliced(sliceKey);
    if (cached) {
      log.info(`Reusing slice ${cached.name} for ${source.name}`);
      return {
        file: cached,
        sourceId: source.id,
        printerId: record.id,
        machine: machine.name,
        process: processProfile.name,
        filament: filament.name,
        plate,
        durationMs: Date.now() - started,
        stats: cached.slice?.stats ?? null,
        cached: true,
      };
    }

    const write = (kind, data) => {
      const dest = path.join(workDir, `${kind}.json`);
      writeFileSync(dest, JSON.stringify(data));
      return dest;
    };
    const args = [
      '--load-settings',
      `${write('machine', machineData)};${write('process', processData)}`,
      '--load-filaments',
      write('filament', filamentData),
      ...overrides,
      // Machines that declare no plate keep the old behavior, where only the high-temperature plate can be adjusted.
      ...(!plate && bedTemp !== null && Number.isFinite(bedTemp) ? ['--hot-plate-temp', String(Math.round(bedTemp))] : []),
      '--slice',
      '0',
      '--export-3mf',
      'sliced.gcode.3mf',
      '--outputdir',
      workDir,
      library.filePath(source),
    ];
    log.info(`Slicing ${source.name} with ${machine.name} / ${processProfile.name}${plate ? ` / ${plate}` : ''}`);
    let run = await runSlicer(bin, args, { timeoutSec: settings.timeoutSec, cwd: workDir });
    if (run.code !== 0 && process.platform === 'linux' && NEEDS_DISPLAY.test(run.stderr)) {
      log.info('Slicer needs a display, retrying with xvfb-run');
      run = await runSlicer('xvfb-run', ['-a', bin, ...args], { timeoutSec: settings.timeoutSec, cwd: workDir });
    }
    const result = readResult(workDir);
    if (run.timedOut) throw badRequest('error.slicer_timeout', { seconds: settings.timeoutSec });
    if (run.code !== 0 || !result || result.return_code !== 0) {
      const message = result?.error_string || run.stderr.split('\n').filter(Boolean).slice(-1)[0] || `exit ${run.code}`;
      throw badRequest('error.slicer_failed', { message: String(message).slice(0, 300) });
    }
    const sliced = path.join(workDir, 'sliced.gcode.3mf');
    if (!existsSync(sliced)) throw badRequest('error.slicer_failed', { message: 'no output' });
    const output = outputFor(record, source.name, sliced, workDir);
    const stats = summarize(result);
    const file = library.addFromPath(output.file, output.name, {
      origin: input.origin ?? 'slicer',
      sourceId: source.id,
      sliceKey,
      slice: { machine: machine.name, process: processProfile.name, filament: filament.name, plate, stats },
    });
    log.info(`Sliced ${output.name} (${Math.round(statSync(library.filePath(library.getFileRecord(file.id))).size / 1024)} KB) in ${Date.now() - started}ms`);
    return {
      file,
      sourceId: source.id,
      printerId: record.id,
      machine: machine.name,
      process: processProfile.name,
      filament: filament.name,
      plate,
      durationMs: Date.now() - started,
      stats,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
