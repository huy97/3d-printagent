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

/** Thư mục profiles nằm cạnh binary, khác nhau theo cách đóng gói. */
const PROFILE_CANDIDATES = ['../Resources/profiles', '../share/OrcaSlicer/profiles', '../share/BambuStudio/profiles', 'resources/profiles', '../resources/profiles', 'profiles'];

/** Preset người dùng tự lưu không nằm cạnh binary mà nằm trong thư mục dữ liệu của ứng dụng. */
const USER_VENDOR = 'User';

const INFILL_PATTERNS = [
  'concentric', 'zig-zag', 'grid', 'line', 'cubic', 'triangles', 'tri-hexagon', 'gyroid', 'honeycomb',
  'adaptivecubic', 'alignedrectilinear', '3dhoneycomb', 'hilbertcurve', 'archimedeanchords', 'octagramspiral',
  'supportcubic', 'lightning', 'crosshatch',
];

/** Kiểu vẽ dùng cho mặt đặc: hẹp hơn danh sách đổ đầy vì mặt đặc chỉ có mấy cách rải đường hợp lý. */
const SURFACE_PATTERNS = ['concentric', 'zig-zag', 'monotonic', 'monotonicline', 'alignedrectilinear', 'hilbertcurve', 'archimedeanchords', 'octagramspiral'];

/**
 * Các loại mặt bàn của máy Bambu và khoá nhiệt độ tương ứng trong profile sợi nhựa.
 * Sợi nhựa nào khai 0 độ cho một mặt bàn nghĩa là không in được trên mặt bàn đó, chọn nhầm thì slicer bỏ ngang.
 * Thứ tự trong danh sách cũng là thứ tự ưu tiên khi máy không nói rõ nó đang lắp mặt bàn nào.
 */
const PLATES = {
  'Textured PEI Plate': 'textured_plate_temp',
  'High Temp Plate': 'hot_plate_temp',
  'Engineering Plate': 'eng_plate_temp',
  'Cool Plate': 'cool_plate_temp',
  'Supertack Plate': 'supertack_plate_temp',
};
const PLATE_NAMES = Object.keys(PLATES);

/** Độ dài nhận cả milimet lẫn phần trăm bề rộng đường, ví dụ "400%" hoặc "2.5". */
const LENGTH_VALUE = /^\d{1,4}(\.\d{1,3})?%?$/;

/** Tham số cắt lát mở cho người dùng, ánh xạ sang cờ dòng lệnh của BambuStudio/OrcaSlicer. */
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
  // Hai tham số dưới đây không đi thẳng ra dòng lệnh mà được ghi vào profile, vì phải biết mặt bàn nào đang dùng.
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
 * Preset người dùng tự lưu trong Bambu Studio / OrcaSlicer (ví dụ "Generic PETG @BBL A2L - 230C").
 * Không đọc chỗ này thì slicer web cắt lát bằng thông số gốc, khác hẳn thứ người dùng vẫn in từ app.
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
 * Gom preset người dùng vào cùng bộ chỉ mục với profile hệ thống. Phải đánh chỉ mục xong mới dựng được
 * mô tả, vì preset người dùng chỉ ghi vài khoá thay đổi, mọi thứ còn lại nằm ở profile cha.
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

/** Đọc toàn bộ profile hệ thống một lần rồi nhớ trong RAM; 3400 file mất khoảng nửa giây. */
function scanProfiles(dir, userDir) {
  const vendors = [];
  const machines = [];
  const processes = [];
  const filaments = [];
  const index = new Map();
  // Nhớ profile nào của hãng nào, để lần ngược lên profile cha còn biết phải tìm trong thư mục hãng nào.
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

  // Profile lá hầu hết không tự khai loại nhựa mà thừa kế từ profile gốc, phải lần ngược lên mới biết đó là PLA hay PETG.
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
  // Quét sau cùng để preset người dùng lần ngược được lên profile cha của hãng.
  if (userDir && scanUserProfiles(userDir, result) > 0) result.vendors.push(USER_VENDOR);
  return result;
}

/**
 * CLI chỉ nạp đúng file được chỉ định, không tự lần theo `inherits`, nên profile lá sẽ rơi
 * về giá trị gốc (PLA 200°C thay vì 220°C). Tự gộp từ tổ tiên xuống lá trước khi gọi slicer.
 * Máy đời mới còn tách các đoạn G-code dài (khởi động, kết thúc, đổi lớp, timelapse) ra file riêng
 * rồi khai trong `include`; bỏ qua chỗ đó là máy in chạy bằng G-code khởi động mặc định của slicer.
 */
function flattenProfile(profiles, kind, vendor, name, seen = new Set()) {
  const { index, owners } = profiles;
  const file = index.get(`${kind}|${vendor}|${name}`) ?? index.get(`${kind}|${name}`);
  if (!file || seen.has(file)) return {};
  seen.add(file);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  // Mười hai hãng cùng đặt tên profile gốc là `fdm_filament_pet`, nên phải lần tiếp theo hãng của
  // chính file vừa đọc; giữ nguyên hãng ban đầu là preset người dùng rơi sang profile gốc của hãng khác.
  const owner = owners.get(file) ?? vendor;
  const parent = data.inherits ? flattenProfile(profiles, kind, owner, data.inherits, seen) : {};
  const included = {};
  for (const part of Array.isArray(data.include) ? data.include : []) {
    Object.assign(included, flattenProfile(profiles, kind, owner, part, seen));
  }
  // Giá trị của chính profile lá đè lên phần include, phần include đè lên profile cha.
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
      log.info(`Đọc ${profiles.machines.length} profile máy từ ${profilesDir} trong ${Date.now() - started}ms${mine > 0 ? `, kèm ${mine} preset tự lưu` : ''}`);
    } catch (error) {
      log.warn(`Không đọc được profile slicer: ${error.message}`);
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

/** Gợi ý profile máy theo model của máy in đang chọn, để giao diện chọn sẵn cho đúng. */
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
  // Máy đang chạy báo về đường kính vòi phun, ưu tiên profile đúng vòi rồi mới tới 0.4 phổ thông.
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

/** Profile ghi mọi thứ dưới dạng chuỗi ("15%", "1"); đưa về đúng kiểu như tham số người dùng đặt mới so sánh được. */
function profileValue(spec, raw) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null || value === '') return undefined;
  if (spec.type === 'flag' || spec.type === 'bool') return !['0', 'false', 'nil'].includes(String(value).trim());
  if (spec.type === 'enum' || spec.type === 'length') return String(value).trim();
  const numeric = Number(String(value).replace('%', ''));
  return Number.isFinite(numeric) ? numeric : undefined;
}

/**
 * Giá trị đang có của các tham số mở, đọc thẳng từ bộ profile được chọn. Không biết mình đang đổi từ đâu
 * thì mọi đề xuất đều là đoán mò, nên phần gợi ý bằng AI cần đúng bảng này.
 */
export function profileValues(selection = {}) {
  const { profiles } = requireSlicer();
  const base = profileData(profiles, selection);
  const plate = choosePlate(base.filamentData, base.filamentItem.name, base.model.default_bed_type, null);
  return { machine: base.machineItem.name, process: base.processItem.name, filament: base.filamentItem.name, values: optionValues(base.data, base.filamentData, plate) };
}

/** Giá trị gốc trong bộ profile đã gộp, để agent tra cả những khoá không có ô riêng trên form trước khi đặt thêm tay. */
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
  // Nhiệt độ bàn nằm ở ô riêng của từng loại mặt bàn, lấy nhầm ô thì ra số của mặt bàn không dùng tới.
  if (plate) {
    values.plateType = plate;
    const temp = profileValue(OVERRIDES.bedTemp, filamentData[PLATES[plate]]);
    if (temp !== undefined) values.bedTemp = temp;
  }
  return values;
}

const SETTINGS_ENTRY = 'Metadata/project_settings.config';
/** Thao tác một lần lên mô hình, không phải thiết lập in nên không nạp lại vào form và preset không mang theo. */
export const ONE_OFF_OPTIONS = new Set(['scale', 'rotate', 'copies', 'arrange', 'allowRotations']);
/** Giá trị slicer tự điền khi profile không khai khoá đó, đọc từ file BambuStudio xuất ra. */
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
/** Khoá slicer tự ghi khi xuất file, không phải thiết lập người dùng đặt. */
const BOOKKEEPING = new Set([
  'from', 'name', 'version', 'inherits', 'inherits_group', 'different_settings_to_system',
  'print_settings_id', 'printer_settings_id', 'filament_settings_id', 'compatible_printers', 'print_compatible_printers',
]);

function sameValue(left, right) {
  if (typeof left === 'number' && typeof right === 'number') return Math.abs(left - right) < 1e-6;
  return String(left) === String(right);
}

/** Slicer ghi lại số theo cách riêng ("12" thay cho "12.0", "0.5,0.5" thay cho "0.5x0.5"), so thẳng chuỗi là báo đổi oan. */
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
 * Tham số của một bản đã cắt lát, đọc thẳng từ cấu hình slicer ghi trong file nên máy nào mở cũng như nhau.
 * Slicer chỉ ghi giá trị cuối cùng, không ghi ô nào bị đổi, nên phải so với profile gốc để tách ra phần người dùng đã chỉnh.
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
    // Profile đã bị xoá hoặc file cắt ở máy khác: vẫn trả tên để form chọn lại được, chỉ không tách được ô đã chỉnh.
    return result;
  }

  const plate = PLATES[settings.curr_bed_type] ? settings.curr_bed_type : null;
  const auto = choosePlate(base.filamentData, base.filamentItem.name, base.model.default_bed_type, null);
  const applied = optionValues(settings, settings, plate);
  // Nhiệt độ bàn so theo đúng mặt bàn đã dùng, không thì chỉ đổi mặt bàn cũng bị tính là đổi nhiệt độ.
  const original = { ...optionValues(base.data, base.filamentData, plate ?? auto), plateType: auto ?? undefined };
  for (const [key, value] of Object.entries(applied)) {
    if (ONE_OFF_OPTIONS.has(key)) continue;
    // Form chỉ bật được cờ, không có cách tắt cờ mà profile đang bật.
    if (OVERRIDES[key].type === 'flag' && value !== true) continue;
    // Profile không khai thì slicer tự điền mặc định; không biết mặc định thì cứ trả về, thừa một ô còn hơn cắt lại mất thiết lập.
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
 * Kích thước bàn chuẩn của một máy, đọc từ profile slicer.
 * Mô hình chưa cắt lát không ghi kích thước bàn nên khung xem phải mượn số của máy sẽ in.
 */
export function machineBed({ machine, printerId } = {}) {
  const found = detect();
  if (!found.profiles) return null;
  const list = found.profiles.machines;
  // Xem nhanh từ danh sách file thì chưa chọn được máy, mượn tạm máy in đã khai báo trong agent.
  const fallback = machine || printerId ? null : printers.listPrinters()[0];
  const name = machine || fallback?.slicer?.machine || null;
  const selected = (name ? list.find((item) => item.name === name) : null) ?? suggestMachines(list, printerId ?? fallback?.id)[0] ?? null;
  if (!selected) return null;
  const data = flattenProfile(found.profiles, 'machine', selected.vendor, selected.name);
  const bed = parseBed(data);
  return bed ? { ...bed, model: bed.model ?? selected.printerModel ?? null, machine: selected.name } : null;
}

/** Nhiệt độ bàn lớp đầu mà profile sợi nhựa khai cho một loại mặt bàn; 0 nghĩa là không in được trên mặt bàn đó. */
function plateTemp(filament, plate) {
  const key = PLATES[plate];
  const raw = filament[`${key}_initial_layer`] ?? filament[key];
  const value = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Chọn mặt bàn in cho lần cắt lát này.
 * Không nói gì thì slicer mặc định "Cool Plate", mà PETG, ABS hay PA đều không dùng được mặt bàn đó nên nó bỏ ngang.
 * Trả về null khi profile sợi nhựa không khai nhiệt độ bàn nào (máy ngoài Bambu), lúc đó để slicer tự lo.
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

/** Giữ lại các tham số hợp lệ và kẹp về khoảng cho phép; dùng cho gợi ý, nơi sai một ô không đáng bỏ cả câu trả lời. */
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

/** Tham số slicer thêm tay, lọc theo đúng luật extraArgs dùng khi cắt lát nhưng bỏ qua dòng sai thay vì báo lỗi. */
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
  // Nhân bản xong phải sắp lại khay, nếu không các bản sẽ chồng lên nhau.
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
      // Slicer đăng ký các khoá này là cờ trần nên phải dính liền giá trị, tách ra sẽ bị hiểu là tên file đầu vào.
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

/** Lối thoát cho các thiết lập hiếm dùng: slicer nhận mọi khoá cấu hình dưới dạng cờ dòng lệnh. */
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

/** Máy nhận 3mf thì giữ nguyên file slicer xuất ra, còn lại rút G-code trong đó ra. */
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

/** Cắt lát tuần tự: một việc một lúc, tránh hai tiến trình slicer giành CPU. */
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
    // Mặt bàn mặc định nằm trong file khai báo dòng máy chứ không nằm trong profile máy, nên phải đọc thêm một bậc.
    const model = machine.printerModel ? flattenProfile(profiles, 'machine', machine.vendor, machine.printerModel) : {};
    const plate = choosePlate(filamentData, filament.name, model.default_bed_type, options.plateType);
    // Kiểm khoảng giá trị trước đã, rồi mới tới luật riêng của vòi phun, để lỗi báo ra là lỗi cơ bản nhất.
    const overrides = overrideArgs(options);
    // Lớp dày hơn đường kính vòi phun thì slicer chỉ báo "thông số sai" chung chung, chặn sớm để người dùng biết sai ở đâu.
    const nozzle = Number(Array.isArray(machineData.nozzle_diameter) ? machineData.nozzle_diameter[0] : machineData.nozzle_diameter) || machine.nozzle;
    for (const key of ['layerHeight', 'firstLayerHeight']) {
      const height = Number(options[key]);
      if (nozzle && Number.isFinite(height) && height > nozzle) throw badRequest('error.layer_too_thick', { option: key, value: height, nozzle });
    }
    if (plate) machineData.curr_bed_type = plate;
    // Nhiệt độ bàn người dùng đặt phải ghi đúng vào ô của mặt bàn đang dùng, ghi nhầm ô thì slicer không thèm đọc.
    const bedTemp = options.bedTemp === undefined || options.bedTemp === null || options.bedTemp === '' ? null : Number(options.bedTemp);
    if (plate && bedTemp !== null && Number.isFinite(bedTemp)) {
      filamentData[PLATES[plate]] = [String(Math.round(bedTemp))];
      filamentData[`${PLATES[plate]}_initial_layer`] = [String(Math.round(bedTemp))];
    }
    // Cờ dòng lệnh chỉ đổi nhiệt các lớp sau; lớp đầu và cả bước đùn mồi vẫn nung theo profile nếu không ghi thêm ô này.
    const nozzleTemp = options.nozzleTemp === undefined || options.nozzleTemp === null || options.nozzleTemp === '' ? null : Number(options.nozzleTemp);
    if (nozzleTemp !== null && Number.isFinite(nozzleTemp)) {
      filamentData.nozzle_temperature = [String(Math.round(nozzleTemp))];
      filamentData.nozzle_temperature_initial_layer = [String(Math.round(nozzleTemp))];
    }

    const processData = flattenProfile(profiles, 'process', processProfile.vendor, processProfile.name);
    const formats = driverClass(record.driver).formats;
    // Cùng file nguồn, cùng bộ profile đã gộp và cùng tham số thì kết quả cắt lát như nhau, dùng lại bản cũ cho nhanh.
    const sliceKey = source.sha256
      ? createHash('sha256')
          .update(JSON.stringify([source.sha256, machineData, processData, filamentData, overrides, plate, formats.includes('3mf')]))
          .digest('hex')
      : null;
    const cached = input.cache === false ? null : library.findSliced(sliceKey);
    if (cached) {
      log.info(`Dùng lại bản cắt lát ${cached.name} cho ${source.name}`);
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
      // Máy không khai mặt bàn thì giữ nguyên cách cũ, chỉ chỉnh được nhiệt độ của mặt bàn nhiệt cao.
      ...(!plate && bedTemp !== null && Number.isFinite(bedTemp) ? ['--hot-plate-temp', String(Math.round(bedTemp))] : []),
      '--slice',
      '0',
      '--export-3mf',
      'sliced.gcode.3mf',
      '--outputdir',
      workDir,
      library.filePath(source),
    ];
    log.info(`Cắt lát ${source.name} bằng ${machine.name} / ${processProfile.name}${plate ? ` / ${plate}` : ''}`);
    let run = await runSlicer(bin, args, { timeoutSec: settings.timeoutSec, cwd: workDir });
    if (run.code !== 0 && process.platform === 'linux' && NEEDS_DISPLAY.test(run.stderr)) {
      log.info('Slicer đòi display, thử lại bằng xvfb-run');
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
    log.info(`Cắt lát xong ${output.name} (${Math.round(statSync(library.filePath(library.getFileRecord(file.id))).size / 1024)} KB) trong ${Date.now() - started}ms`);
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
