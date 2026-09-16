import { getConfig } from './config.js';
import * as library from './library.js';
import * as jobs from './jobs.js';
import * as printers from './printers.js';
import * as insights from './insights.js';
import { ONE_OFF_OPTIONS, listProfiles, optionSpecs, profileSettings, profileValues, sanitizeExtra, sanitizeOptions, sliceModel } from './slicer.js';
import { systemPrompt } from './prompts.js';
import * as slicechat from './slicechat.js';
import { readToolpath } from '../gcode/toolpath.js';
import { t } from '../i18n/index.js';
import { driverClass } from '../drivers/index.js';
import { createLogger } from '../util/logger.js';
import { badRequest, upstreamError } from '../util/errors.js';

const log = createLogger('advisor');

const TIMEOUT_MS = 45000;
const MAX_PURPOSE = 500;
const MAX_MESSAGE = 2000;
// Past turns replayed to the model; even number so it always starts with a user turn.
const MAX_HISTORY = 20;
const MAX_TOOL_ROUNDS = 8;
const MAX_TURN_SLICES = 2;
// Anthropic caps images at 5MB after base64 encoding, leave room for the one third expansion.
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** Anthropic takes the API key via x-api-key, and session tokens (OAuth, proxy gateways) via Authorization. */
export const AUTH_TYPES = ['api_key', 'auth_token'];
const AUTH_HEADER = {
  api_key: (value) => ({ 'x-api-key': value }),
  auth_token: (value) => ({ authorization: `Bearer ${value}` }),
};

/** Each setting described with its unit and effect; the model picks far better values than from key names alone. */
const OPTION_NOTES = {
  layerHeight: 'Layer height, mm. Small is smooth and slow, large is fast and coarse; should not exceed 75% of the nozzle diameter.',
  firstLayerHeight: 'First layer height, mm. Thicker than a normal layer gives a stronger grip on the plate.',
  seam: 'Where each layer joins: nearest is fastest, aligned stacks the seams in a line so they are easy to hide on one edge, back pushes them to the rear, random spreads them out but speckles the surface.',
  ironing: 'Flatten top surfaces by passing the nozzle over them again: no ironing is off, top does every upward face, topmost only the very top face, solid covers everything. Nicer surface but much slower.',
  wallLoops: 'Number of wall loops. Adding loops is the most effective way to carry load and uses less filament than raising infill density.',
  topLayers: 'Number of solid layers on the top surface. Too few and the top is pitted with holes because the infill underneath does not support it.',
  bottomLayers: 'Number of solid layers on the bottom surface, deciding how sealed and how stiff the base is.',
  infill: 'Infill density, %. Around 10-15 for decorative objects, 25-40 for load bearing parts, above 50 is rarely worth the time it costs.',
  infillPattern: 'Infill pattern. gyroid and cubic carry load evenly in every direction, grid and line are fast, lightning only raises pillars under the top surface so it is the lightest and fastest, honeycomb is stiff but slow.',
  outerWallSpeed: 'Outer wall speed, mm/s. Going slower makes the surface smoother and crisper.',
  innerWallSpeed: 'Inner wall speed, mm/s. It barely affects the surface so it can run faster than the outer wall.',
  infillSpeed: 'Infill speed, mm/s. This is usually the biggest slice of the print time, so raising it shortens the print noticeably.',
  support: 'Turn supports on. Only needed when the model has overhangs or very steep faces; check the downward face ratio given above before turning it on.',
  supportType: 'Support type: normal(auto) is solid and holds wide flat areas well; tree(auto) is a tree shape that uses less filament and is easier to remove, suited to curved models or figurines.',
  supportThreshold: 'Support generation threshold, degrees, where 90 is a vertical wall. Only faces steeper than this threshold get supported, so a larger number generates more support.',
  nozzleTemp: 'Nozzle temperature, degrees C. Compare the current value against the usual range for this filament (PLA 200-220, PETG 230-250, ABS 240-260, TPU 220-235) and against the purpose of the print: outside the range, propose bringing it back, especially when it is higher than needed because the filament runs soupy, oozes and strings. Inside the range, leave it alone, unless another 5-10 degrees is needed to bond the layers more strongly.',
  bedTemp: 'Bed temperature, degrees C. Compare the current value against the usual range for this filament (PLA 55-65, PETG 70-80, ABS 90-100, TPU 40-60): outside the range, propose bringing it back, because too low means the base lifts and too high means elephant foot and a part stuck fast to the plate. Inside the range, only change it when the object struggles to stick or the corners curl.',
  brim: 'Plate adhesion brim: auto_brim lets the slicer decide, no_brim turns it off entirely, outer_only adds a brim on the outside only. Needed when the contact base is small or the object tends to curl.',
  brimWidth: 'Brim width, mm. Wider grips harder but takes more work to remove.',
  spiralMode: 'Spiral printing, the whole object is one continuous wall. Only for hollow open-bottomed objects such as vases and pots; turning it on makes the wall, infill and top surface settings all ignored.',
  scale: 'Scaling factor, 1 keeps the original size.',
  rotate: 'Rotation about the Z axis, degrees. It only changes the orientation on the plate, it does not change steep faces or the need for support.',
  copies: 'Number of copies on one plate, the agent rearranges the plate itself. Only set it when the user explicitly asks for several copies.',
  arrange: 'Rearrange every object on the plate before slicing. Needed when the file holds several separate objects since they may overlap or sit off the plate.',
  allowRotations: 'Allow objects to rotate about the Z axis while arranging the plate so more of them fit. Only has an effect when plate arranging is on.',
  plateType: 'The type of plate fitted on the printer. This is hardware, only the user can tell by looking at the printer, so never guess: only set it when they say which plate they are using, otherwise leave it empty and let the agent pick a plate that suits the filament.',

  alternateExtraWall: 'Add an extra wall loop on every other layer, alternating. The layers interlock so the part is stronger while using less filament than raising the wall count outright.',
  embedWallIntoInfill: 'Sink the innermost wall loop into the infill so the wall bonds more tightly to the core. Better load bearing, at the cost of a possibly rippled inner surface.',
  detectThinWall: 'Detect walls thinner than one extrusion and print them as a single line. It preserves fine detail, but single lines break up easily on 3D scanned models.',
  topSurfacePattern: 'Pattern for the topmost surface. monotonic and monotonicline sweep evenly in one direction so the surface catches light uniformly and looks best; concentric follows the outline; zig-zag is fast but leaves interleaved marks.',
  topSurfaceDensity: 'Density of the topmost surface, %. Below 100 the top has tiny gaps, only lower it when a porous surface is intended.',
  topShellThickness: 'Thickness of the solid top shell in mm; the slicer takes enough layers to reach it at the current layer height. Set 0 to use only the layer count given in topLayers.',
  topPaintLayers: 'Number of top layers printed in the painted colour when multi-colour printing. Nothing to do with strength, only change it when the painted colour shows the base through.',
  bottomSurfacePattern: 'Pattern for the bottom surface, affecting how smooth the plate-contact face is. monotonic gives the most even surface.',
  bottomSurfaceDensity: 'Density of the bottom surface, %. Below 100 the base has gaps, rarely a good idea.',
  bottomShellThickness: 'Thickness of the solid bottom shell, mm. Set 0 to use only the layer count given in bottomLayers.',
  bottomPaintLayers: 'Number of bottom layers printed in the painted colour when multi-colour printing.',
  solidInfillPattern: 'Pattern for the solid layers inside the object (not the outer surfaces). zig-zag is fast and strong, monotonic looks better but is slower.',
  subTopSurfacePattern: 'Pattern for the solid layers just below the topmost surface. Matching the top surface gives it an even bed to sit on, so the top ripples less.',
  fillMultiline: 'Number of adjacent lines per infill stroke. Raising it to 2-3 makes the core noticeably stronger without raising the density, at the cost of filament and time.',
  infillAnchor: 'Length the infill anchors along the wall, in mm or as a percentage of line width, for example "400%". Longer bonds the core to the wall more strongly, shorter saves time.',
  infillAnchorMax: 'Upper limit on that anchor length, also in mm or a percentage. Set 0 to disallow anchoring along the wall.',
  infillWallOverlap: 'How far infill overlaps the wall, % of line width. More bonds the core to the wall better but can bulge the surface.',
  infillDirection: 'Angle of the infill strokes, degrees. Rotate it so the strokes do not line up with the direction of bending load.',
  bridgeAngle: 'Angle of the extrusion when bridging a gap, degrees. 0 lets the slicer choose; only set it when the bridge sags in one clear direction.',
  minSparseInfillArea: 'Smallest area that gets sparse infill, mm2. Anything smaller is printed solid for strength.',
  infillCombination: 'Merge the infill of several layers into one thick layer to print faster. A coarser core and a top surface more prone to rippling.',
  detectNarrowSolidInfill: 'Recognise narrow solid regions and change how they are drawn for a more continuous path. Best left on, only turn it off when the surface paths get tangled.',
  ensureVerticalShell: 'Guarantee wall thickness in the vertical direction by adding solid layers on sloped roofs. On gives sealed, strong sloped faces, off is faster and uses less filament.',
  detectFloatingShell: 'Recognise vertical wall patches left hanging in mid air and slow down so they stick. Best left on for models with many protruding details.',
};

export function optionSchema() {
  const properties = {};
  for (const spec of optionSpecs()) {
    const base =
      spec.type === 'flag' || spec.type === 'bool'
        ? { type: 'boolean' }
        : spec.type === 'enum'
          ? { type: 'string', enum: spec.values }
          : spec.type === 'length'
            ? { type: 'string', pattern: '^[0-9]+(\\.[0-9]+)?%?$' }
            : { type: 'number', minimum: spec.min, maximum: spec.max };
    properties[spec.key] = OPTION_NOTES[spec.key] ? { ...base, description: OPTION_NOTES[spec.key] } : base;
  }
  return properties;
}

function describeModel(file) {
  const meta = file.meta ?? {};
  const parts = [`File name: ${file.name}`];
  if (meta.size) parts.push(`Bounding size: ${meta.size.x} x ${meta.size.y} x ${meta.size.z} mm`);
  if (meta.volumeCm3) parts.push(`Solid volume: ${meta.volumeCm3} cm3`);
  if (meta.triangles) parts.push(`Triangle count: ${meta.triangles}`);
  if (meta.overhangRatio !== undefined) {
    parts.push(`Area ratio of downward faces steeper than 30 degrees (excluding faces resting on the plate): ${Math.round(meta.overhangRatio * 100)}%`);
  }
  return parts.join('\n');
}

function describeTarget(record, machine, processProfile, filament, { nozzle, filamentType } = {}) {
  const driver = driverClass(record.driver);
  return [
    `Printer: ${record.name} (${driver.label})`,
    `Machine profile: ${machine}`,
    processProfile ? `Print quality profile: ${processProfile}` : null,
    filament ? `Filament: ${filament}${filamentType ? ` (${filamentType})` : ''}` : null,
    nozzle ? `Nozzle diameter: ${nozzle} mm` : null,
    nozzle ? `Hard limit: neither layer height nor first layer height may exceed ${nozzle} mm, going over makes the slicer abort.` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function aiSettings() {
  const settings = getConfig().ai ?? {};
  if (!settings.apiKey) throw badRequest('error.ai_not_configured');
  return {
    apiKey: settings.apiKey,
    authType: settings.authType,
    baseUrl: settings.baseUrl || 'https://api.anthropic.com',
    model: settings.model || 'claude-sonnet-5',
  };
}

async function callModel({ apiKey, authType, baseUrl, model }, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...(AUTH_HEADER[authType] ?? AUTH_HEADER.api_key)(apiKey),
      },
      body: JSON.stringify({ model, max_tokens: 1024, ...body }),
      signal: controller.signal,
    });
  } catch (error) {
    throw upstreamError('error.ai_failed', { message: error.name === 'AbortError' ? 'timeout' : error.message });
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      message = JSON.parse(text).error?.message ?? message;
    } catch {
      // Provider returned a non-JSON error, keep the status code as is.
    }
    throw upstreamError('error.ai_failed', { message: String(message).slice(0, 300) });
  }
  return JSON.parse(text);
}

function sameValue(a, b) {
  if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b);
  if (typeof a === 'number') return Number.isFinite(Number(b)) && Math.abs(Number(b) - a) < 1e-6;
  return String(a).trim() === String(b).trim();
}

/** The slice the user is still tuning; only accept a slice produced from this very model. */
function previousSlice(sliceId, sourceId) {
  if (!sliceId) return null;
  let file;
  try {
    file = library.getFile(sliceId);
  } catch {
    return null;
  }
  if (file.format !== '3mf' || file.meta?.sliced !== true) return null;
  const ancestors = new Set();
  for (let current = file; current?.sourceId && !ancestors.has(current.sourceId); ) {
    ancestors.add(current.sourceId);
    try {
      current = library.getFile(current.sourceId);
    } catch {
      break;
    }
  }
  if (!ancestors.has(sourceId)) return null;
  const meta = file.meta ?? {};
  const detail = [
    meta.estimatedTime ? `estimated ${Math.round(meta.estimatedTime / 60)} minutes` : null,
    meta.filamentWeightG ? `${meta.filamentWeightG} g of filament` : null,
  ]
    .filter(Boolean)
    .join(', ');
  return { name: file.name, detail };
}

/** The data table sent to the chat agent: model, printer, and the values that will be used for slicing. */
function sliceContext(input) {
  const source = library.getFile(input.fileId ?? input.file);
  if (source.format !== 'model' && !(source.format === '3mf' && source.meta?.sliced === false)) {
    throw badRequest('error.slicer_source_invalid', { name: source.name });
  }
  const record = printers.getRecord(input.printerId ?? input.printer);
  const machine = String(input.machine ?? '').trim();
  if (!machine) throw badRequest('error.field_required', { field: 'machine' });
  const profiles = listProfiles({ printerId: record.id, machine });
  const filamentName = input.filament ?? profiles.defaults?.filament ?? null;
  const processName = input.process ?? profiles.defaults?.process ?? null;
  // Without this table the model does not know what it is changing from, and stays silent even about wrong values.
  const profile = profileValues({ machine, process: processName, filament: filamentName });
  // The user edits a few fields by hand before asking, so compare against what will be sliced, not the stock profile.
  const edited = sanitizeOptions(input.options ?? input);
  const current = { ...profile.values, ...edited };
  const extra = sanitizeExtra(input.options?.extra ?? input.extra);
  const previous = previousSlice(input.sliceId, source.id);
  // An offline printer reports no nozzle, fall back to the selected machine profile so the model still knows the limit.
  const nozzle = profiles.machines.find((item) => item.name === machine)?.nozzle ?? printers.statusOf(record.id)?.extra?.nozzleDiameter ?? null;

  const lines = [
    describeModel(source),
    '',
    describeTarget(record, machine, processName, filamentName, {
      nozzle,
      filamentType: profiles.filaments.find((item) => item.name === filamentName)?.filamentType ?? null,
    }),
    '',
    '',
    'Values that will be used when slicing (the profile, merged with the fields the user edited by hand):',
    ...Object.entries(current).map(([key, value]) => {
      if (!(key in edited)) return `- ${key} = ${value}`;
      return key in profile.values && String(profile.values[key]) !== String(value)
        ? `- ${key} = ${value} (edited by the user, profile sets ${profile.values[key]})`
        : `- ${key} = ${value} (edited by the user)`;
    }),
    ...(Object.keys(extra).length > 0
      ? ['', 'Slicer settings the user added by hand, kept as is when slicing and not changeable by the tools:', ...Object.entries(extra).map(([key, value]) => `- ${key} = ${value}`)]
      : []),
    ...(previous ? ['', `Most recent slice of this model: "${previous.name}"${previous.detail ? ` (${previous.detail})` : ''}.`] : []),
  ];
  return { source, record, machine, process: profile.process, filament: profile.filament, nozzle: Number(nozzle) || null, edited, extra, current, lines };
}

const language = (locale) => `Answer in this language: ${locale === 'en' ? 'English' : 'Vietnamese'}.`;

/** Past turns replayed as text; changes carry the saved version so the model knows where the current table came from. */
function historyText(message) {
  if (message.role === 'user') return message.text;
  const parts = message.text ? [message.text] : [];
  const suggestion = message.suggestion;
  const changes = [
    ...Object.entries(suggestion?.options ?? {}).map(([key, value]) => `${key} = ${value}`),
    ...Object.entries(suggestion?.extra ?? {}).map(([key, value]) => `${key} = ${value ?? '(cleared, follows the profile)'}`),
    ...Object.entries(suggestion?.profiles ?? {}).map(([kind, name]) => `${kind} = ${name}`),
  ];
  if (changes.length > 0) {
    const applied = message.appliedVersion ? `saved and applied as version v${message.appliedVersion.number}` : 'not applied by the user';
    parts.push(`Changes (${applied}): ${changes.join(', ')}. ${suggestion.reason ?? ''}`.trim());
  } else if (message.appliedVersion) {
    parts.push(`Saved version v${message.appliedVersion.number}.`);
  }
  const actions = (message.actions ?? []).map((item) => `${item.tool}${item.error ? ' (error)' : ''}`);
  if (actions.length > 0) parts.push(`Tools used: ${actions.join(', ')}.`);
  return parts.join('\n') || '(no content)';
}

function chatTools() {
  return [
    {
      name: 'update_slice_settings',
      description:
        'Change the settings that will be used when slicing. At the end of the turn the agent saves every change as a new version and applies it to the user form straight away, so pass only what needs to change.',
      input_schema: {
        type: 'object',
        properties: {
          options: { type: 'object', properties: optionSchema(), additionalProperties: false, description: 'Settings that have their own field on the form.' },
          extra: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description:
              'Raw slicer keys with no field of their own on the form, for example retraction_length or fan_max_speed; lowercase names joined by underscores, values as strings in the profile format. Look them up with read_profile_settings before setting them.',
          },
          reset: { type: 'array', items: { type: 'string' }, description: 'Names of settings in options, or extra keys, whose current value should be dropped so they follow the profile again.' },
          process: { type: 'string', description: 'Switch to another print quality profile, named exactly as list_profiles returns it.' },
          filament: { type: 'string', description: 'Switch to another filament profile, named exactly as list_profiles returns it. Only switch when the user names the filament explicitly.' },
          reason: { type: 'string', description: 'A short reason, at most three sentences.' },
        },
        required: ['reason'],
      },
    },
    {
      name: 'list_profiles',
      description: 'List the print quality and filament profiles usable with the selected printer.',
      input_schema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['process', 'filament', 'all'] },
          search: { type: 'string', description: 'Filter by part of the name, case insensitive.' },
        },
      },
    },
    {
      name: 'read_profile_settings',
      description: 'Read the original values in the selected profile set (machine, print quality and filament merged), including keys with no field of their own on the form.',
      input_schema: {
        type: 'object',
        properties: {
          keys: { type: 'array', items: { type: 'string' }, description: 'Exact key names, for example retraction_length.' },
          search: { type: 'string', description: 'Find keys containing this string, for example retract or fan.' },
        },
      },
    },
    {
      name: 'list_versions',
      description: 'List the saved setting versions of this model, with the print time and filament usage of any version that has been sliced.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'restore_version',
      description: 'Return every setting to exactly one earlier version. The result is saved as a new version at the end of the turn.',
      input_schema: { type: 'object', properties: { number: { type: 'integer', minimum: 1 } }, required: ['number'] },
    },
    {
      name: 'list_presets',
      description: 'List the presets the user has saved, shared across every model, with the profiles and settings inside each one.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'apply_preset',
      description:
        'Apply a saved preset: replace every current setting (except scale, rotation and copies) with the settings in the preset, switching profiles too if they work with the selected printer.',
      input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Preset name, case insensitive.' } }, required: ['name'] },
    },
    {
      name: 'save_preset',
      description:
        'Save the current settings (including this turn\'s changes) as a preset shared across every model. Only call it when the user asks to save a preset; a duplicate name overwrites the old preset.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'A short name, at most 60 characters, for example "Strong PETG".' },
          description: { type: 'string', description: 'One sentence saying what the preset is for.' },
        },
        required: ['name'],
      },
    },
    {
      name: 'slice_preview',
      description: `Run a test slice with the current settings to get the real print time, filament usage and slicer warnings. It takes anywhere from seconds to minutes and creates a slice in the library; only use it when the user cares about time or filament usage, or wants a comparison, at most ${MAX_TURN_SLICES} times per turn.`,
      input_schema: { type: 'object', properties: {} },
    },
  ];
}

const extraKey = (key) => String(key).trim().toLowerCase().replace(/-/g, '_');

function stateKey(state) {
  const sorted = (object) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify([state.machine, state.process, state.filament, sorted(state.options), sorted(state.extra)]);
}

function sliceStats(sliceId) {
  if (!sliceId) return null;
  try {
    const meta = library.getFile(sliceId).meta ?? {};
    return { estimatedMinutes: meta.estimatedTime ? Math.round(meta.estimatedTime / 60) : null, filamentWeightG: meta.filamentWeightG ?? null };
  } catch {
    return null;
  }
}

/** The chat agent's tools. Changes only land in the turn state; the version is saved when the turn ends. */
function chatSession({ source, record, rootId, nozzle, state, locale }) {
  const session = { state, reason: '', actions: [], slices: 0, saved: null, savedKey: stateKey(state) };
  session.table = () => ({ ...profileValues(state).values, ...state.options });

  const handlers = {
    update_slice_settings(input) {
      const profiles = input.process || input.filament ? listProfiles({ printerId: record.id, machine: state.machine }) : null;
      let count = 0;
      for (const [kind, list] of [
        ['process', profiles?.processes],
        ['filament', profiles?.filaments],
      ]) {
        const name = typeof input[kind] === 'string' ? input[kind].trim() : '';
        if (!name || name === state[kind]) continue;
        if (!list.some((item) => item.name === name)) throw badRequest('error.slicer_profile_not_found', { field: kind, name });
        state[kind] = name;
        count += 1;
      }
      for (const key of Array.isArray(input.reset) ? input.reset : []) {
        if (key in state.options || extraKey(key) in state.extra) count += 1;
        delete state.options[key];
        delete state.extra[extraKey(key)];
      }
      const raw = input.options && typeof input.options === 'object' ? input.options : {};
      const options = sanitizeOptions(raw);
      for (const key of ['layerHeight', 'firstLayerHeight']) {
        if (nozzle && options[key] > nozzle) throw badRequest('error.layer_too_thick', { option: key, value: options[key], nozzle });
      }
      // A key with its own field set through extra would clash with options, force it through options.
      const covered = new Set(optionSpecs().map((spec) => spec.flag.replace(/-/g, '_')));
      const extra = Object.fromEntries(Object.entries(sanitizeExtra(input.extra)).filter(([key]) => !covered.has(key)));
      Object.assign(state.options, options);
      Object.assign(state.extra, extra);
      count += Object.keys(options).length + Object.keys(extra).length;
      if (input.reason) session.reason = String(input.reason).trim().slice(0, 1000);
      const ignored = [
        ...Object.keys(raw).filter((key) => !(key in options)),
        ...Object.keys(input.extra && typeof input.extra === 'object' ? input.extra : {}).filter((key) => !(extraKey(key) in extra)),
      ];
      const values = session.table();
      return {
        params: { count },
        result: {
          ok: true,
          process: state.process,
          filament: state.filament,
          options: Object.fromEntries(Object.keys(options).map((key) => [key, values[key]])),
          extra,
          ...(ignored.length > 0 ? { ignored, note: 'Keys skipped because the name is wrong, the value is wrong, or the key has its own field and must be set through options.' } : {}),
        },
      };
    },

    list_profiles(input) {
      const profiles = listProfiles({ printerId: record.id, machine: state.machine });
      const needle = String(input.search ?? '').trim().toLowerCase();
      const pick = (list) =>
        list
          .filter((item) => !needle || item.name.toLowerCase().includes(needle))
          .slice(0, 60)
          .map((item) => (item.filamentType ? { name: item.name, filamentType: item.filamentType } : { name: item.name }));
      const kind = input.kind ?? 'all';
      return {
        params: { search: needle },
        result: {
          current: { process: state.process, filament: state.filament },
          ...(kind !== 'filament' ? { processes: pick(profiles.processes) } : {}),
          ...(kind !== 'process' ? { filaments: pick(profiles.filaments) } : {}),
        },
      };
    },

    read_profile_settings(input) {
      const keys = (Array.isArray(input.keys) ? input.keys : []).slice(0, 40);
      const search = String(input.search ?? '').trim();
      if (keys.length === 0 && !search) throw badRequest('error.field_required', { field: 'keys' });
      const found = profileSettings(state, { keys, search });
      const setByUser = Object.fromEntries(Object.entries(state.extra).filter(([key]) => key in found.values || keys.map(extraKey).includes(key)));
      return { params: { query: search || keys.join(', ') }, result: { ...found, setByUser } };
    },

    list_versions() {
      const versions = slicechat
        .listVersions(rootId)
        .slice(-15)
        .map((version) => ({
          number: version.number,
          source: version.source,
          createdAt: version.createdAt,
          machine: version.machine,
          process: version.process,
          filament: version.filament,
          options: version.options,
          extra: version.extra,
          slice: sliceStats(version.sliceId),
        }));
      return { params: {}, result: { versions } };
    },

    restore_version(input) {
      const version = slicechat.listVersions(rootId).find((item) => item.number === Number(input.number));
      if (!version) throw badRequest('error.field_invalid', { field: 'number' });
      if (version.machine && version.machine !== state.machine) {
        throw badRequest('error.version_machine_mismatch', { number: version.number, machine: version.machine });
      }
      state.process = version.process ?? state.process;
      state.filament = version.filament ?? state.filament;
      state.options = { ...version.options };
      state.extra = { ...version.extra };
      return { params: { number: version.number }, result: { ok: true, process: state.process, filament: state.filament, options: state.options, extra: state.extra } };
    },

    list_presets() {
      const presets = slicechat.listPresets().map(({ id: _id, createdAt: _createdAt, ...preset }) => preset);
      return { params: {}, result: { presets } };
    },

    apply_preset(input) {
      const preset = slicechat.findPreset(input.name);
      if (!preset) throw badRequest('error.field_invalid', { field: 'name' });
      const profiles = listProfiles({ printerId: record.id, machine: state.machine });
      const skipped = [];
      for (const [kind, list] of [
        ['process', profiles.processes],
        ['filament', profiles.filaments],
      ]) {
        if (!preset[kind] || preset[kind] === state[kind]) continue;
        if (list.some((item) => item.name === preset[kind])) state[kind] = preset[kind];
        else skipped.push(preset[kind]);
      }
      const oneOff = Object.fromEntries(Object.entries(state.options).filter(([key]) => ONE_OFF_OPTIONS.has(key)));
      state.options = { ...oneOff, ...preset.options };
      state.extra = { ...preset.extra };
      return {
        params: { name: preset.name },
        result: {
          ok: true,
          process: state.process,
          filament: state.filament,
          options: state.options,
          extra: state.extra,
          ...(skipped.length > 0 ? { skipped, note: 'The profiles in the preset do not work with the selected printer, so the current profiles were kept.' } : {}),
        },
      };
    },

    save_preset(input) {
      const preset = slicechat.savePreset({ ...state, name: input.name, description: input.description });
      return { params: { name: preset.name }, result: { ok: true, name: preset.name, overwritten: preset.createdAt !== preset.updatedAt } };
    },

    async slice_preview() {
      if (session.slices >= MAX_TURN_SLICES) throw badRequest('error.slice_limit', { max: MAX_TURN_SLICES });
      session.slices += 1;
      const result = await sliceModel({
        fileId: source.id,
        printerId: record.id,
        machine: state.machine,
        process: state.process,
        filament: state.filament,
        options: { ...state.options, extra: state.extra },
        extra: state.extra,
      });
      const version = slicechat.addVersion(source.id, { source: 'slice', ...state, sliceId: result.file.id });
      session.saved = version;
      session.savedKey = stateKey(state);
      const stats = result.stats ?? {};
      const seconds = stats.estimatedTime ?? result.file.meta?.estimatedTime ?? null;
      const grams = stats.filamentWeightG ?? result.file.meta?.filamentWeightG ?? null;
      return {
        params: { number: version.number, seconds, grams },
        result: {
          file: result.file.name,
          version: version.number,
          estimatedMinutes: seconds ? Math.round(seconds / 60) : null,
          filamentWeightG: grams,
          layerHeight: stats.layerHeight ?? null,
          warning: stats.warning ?? null,
        },
      };
    },
  };

  session.run = async (call) => {
    const handler = handlers[call.name];
    if (!handler) return { type: 'tool_result', tool_use_id: call.id, is_error: true, content: `There is no tool named ${call.name}.` };
    try {
      const { params, result } = await handler(call.input ?? {});
      session.actions.push({ tool: call.name, params });
      return { type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(result) };
    } catch (error) {
      log.warn(`Tool ${call.name} failed: ${error.message}`);
      session.actions.push({ tool: call.name, params: {}, error: true });
      return { type: 'tool_result', tool_use_id: call.id, is_error: true, content: error.key ? t(error.key, error.params, locale) : error.message };
    }
  };
  return session;
}

/** Compare the value table at the start and end of the turn; a profile switch moves many values, so compare the whole table, not just the fields that were set. */
function settingsDiff(initial, before, final, after) {
  const options = {};
  const previous = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (after[key] === undefined || (key in before && sameValue(after[key], before[key]))) continue;
    options[key] = after[key];
    if (before[key] !== undefined) previous[key] = before[key];
  }
  const extra = {};
  for (const key of new Set([...Object.keys(initial.extra), ...Object.keys(final.extra)])) {
    if (initial.extra[key] !== final.extra[key]) extra[key] = final.extra[key] ?? null;
  }
  const profiles = {};
  for (const kind of ['process', 'filament']) if (initial[kind] !== final[kind]) profiles[kind] = final[kind];
  if (Object.keys(options).length + Object.keys(extra).length + Object.keys(profiles).length === 0) return null;
  return { options, before: previous, extra, profiles };
}

/** Multi-turn chat about slicing settings. The agent uses tools over several rounds and saves a version at the end of the turn if the settings changed. */
export async function chatSlice(input = {}) {
  const settings = aiSettings();
  const message = String(input.message ?? '').trim().slice(0, MAX_MESSAGE);
  if (!message) throw badRequest('error.field_required', { field: 'message' });
  const context = sliceContext(input);
  const { source, record, current, lines } = context;
  const rootId = slicechat.rootIdOf(source.id);
  const initial = { machine: context.machine, process: context.process, filament: context.filament, options: context.edited, extra: context.extra };
  const session = chatSession({ source, record, rootId, nozzle: context.nozzle, state: structuredClone(initial), locale: input.locale });

  const history = slicechat.listMessages(rootId).slice(-MAX_HISTORY);
  if (history[0]?.role === 'assistant') history.shift();
  const presets = slicechat.listPresets().map((item) => item.name);
  const presetLine = presets.length > 0 ? `Saved presets, shared across every model: ${presets.join(', ')}.` : 'The user has not saved any preset.';
  const messages = [
    ...history.map((item) => ({ role: item.role, content: historyText(item) })),
    { role: 'user', content: [...lines, '', presetLine, '', language(input.locale), '', `New user message: ${message}`].join('\n') },
  ];

  const started = Date.now();
  const tools = chatTools();
  const texts = [];
  let data = null;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    data = await callModel(settings, {
      max_tokens: 2048,
      system: systemPrompt('chat'),
      messages,
      tools,
      // The last round forbids tool calls so the model has to settle on an answer.
      tool_choice: { type: round === MAX_TOOL_ROUNDS - 1 ? 'none' : 'auto' },
    });
    const content = data.content ?? [];
    const text = content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n')
      .trim();
    if (text) texts.push(text);
    const calls = content.filter((item) => item.type === 'tool_use');
    if (calls.length === 0) break;
    messages.push({ role: 'assistant', content });
    const results = [];
    for (const call of calls) results.push(await session.run(call));
    messages.push({ role: 'user', content: results });
  }

  const diff = settingsDiff(initial, current, session.state, session.table());
  const suggestion = diff ? { ...diff, reason: session.reason } : null;
  const reply = texts.join('\n\n').trim() || session.reason;
  if (!reply && !suggestion && !session.saved) throw upstreamError('error.ai_failed', { message: 'empty reply' });

  const saved = slicechat.addMessages(rootId, [
    { role: 'user', text: message, sliceId: input.sliceId ?? null },
    { role: 'assistant', text: reply, suggestion, actions: session.actions, model: data?.model ?? settings.model },
  ]);
  const answer = saved[1];
  let version = session.saved;
  if (stateKey(session.state) !== session.savedKey) {
    version = slicechat.addVersion(source.id, { source: 'ai', messageId: answer.id, ...session.state });
  } else if (version) {
    slicechat.linkVersion(answer.id, version);
  }
  if (version) answer.appliedVersion = { id: version.id, number: version.number };
  log.info(`Slice chat ${source.name}: ${session.actions.length} tool calls, ${version ? `saved v${version.number}` : 'settings unchanged'}, ${Date.now() - started}ms`);
  return { fileId: rootId, messages: saved, version: version ?? null };
}

function describePrinterState(record, status, recent) {
  const job = status?.job;
  const alerts = (status?.extra?.hms ?? []).map((item) =>
    item?.text ? `${item.code} (${item.severity ?? 'severity unknown'}): ${item.text}` : `${item?.code ?? item} (no description available)`,
  );
  return [
    `Printer: ${record.name} (${driverClass(record.driver).label})`,
    record.connection?.model ? `Model: ${record.connection.model}` : null,
    status?.firmware ? `Firmware: ${status.firmware}` : null,
    `State: ${status?.online ? status.state : 'offline'}`,
    status?.message ? `Printer message: ${status.message}` : null,
    status?.temps?.nozzle ? `Nozzle: ${status.temps.nozzle.actual}C, target ${status.temps.nozzle.target}C` : null,
    status?.temps?.bed ? `Bed: ${status.temps.bed.actual}C, target ${status.temps.bed.target}C` : null,
    job ? `Running print: ${job.file}, ${job.progress}%, layer ${job.layer}/${job.totalLayers}` : 'No print is running',
    record.slicer?.filament ? `Selected filament: ${record.slicer.filament}` : null,
    status?.extra?.nozzleDiameter ? `Nozzle diameter: ${status.extra.nozzleDiameter} mm` : null,
    '',
    alerts.length > 0 ? `Active HMS alerts:\n${alerts.join('\n')}` : 'The printer reports no HMS code.',
    '',
    recent.length > 0 ? `Recent jobs:\n${recent.join('\n')}` : 'No job in the history yet.',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/** Read the printer state and the vendor alert codes, then ask the model for the cause and the fix. */
export async function diagnose(input = {}) {
  const settings = aiSettings();

  const record = printers.getRecord(input.printerId ?? input.printer);
  const status = printers.statusOf(record.id);
  const recent = jobs
    .listJobs({ printerId: record.id, limit: 5 })
    .map((job) => `- ${job.fileName ?? job.remoteName ?? job.id}: ${job.status}${job.error ? `, error: ${job.error}` : ''}`);
  const note = String(input.note ?? '').trim().slice(0, MAX_PURPOSE);

  const history = insights.statsDigest({ printerId: record.id });
  const prompt = [
    describePrinterState(record, status, recent),
    '',
    history.length > 0 ? `Print statistics for this printer:\n${history.join('\n')}` : null,
    history.length > 0 ? '' : null,
    note ? `Extra notes from the user: ${note}` : 'The user gave no extra notes.',
    '',
    `Answer in this language: ${input.locale === 'en' ? 'English' : 'Vietnamese'}.`,
  ].join('\n');

  const started = Date.now();
  const data = await callModel(settings, {
    system: systemPrompt('diagnose'),
    messages: [{ role: 'user', content: prompt }],
    tools: [
      {
        name: 'diagnose_printer',
        description: 'Conclusion about the printer state, the likely causes and the fix steps.',
        input_schema: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: 'One to two sentences summarising what is wrong with the printer.' },
            causes: {
              type: 'array',
              description: 'Likely causes, ordered from most likely down.',
              items: { type: 'string' },
            },
            steps: {
              type: 'array',
              description: 'Concrete fix steps, in the order they should be done.',
              items: { type: 'string' },
            },
            severity: {
              type: 'string',
              enum: ['info', 'warning', 'critical'],
              description: 'info means nothing urgent, warning means fix it before printing again, critical means stop the printer now.',
            },
          },
          required: ['summary', 'causes', 'steps', 'severity'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'diagnose_printer' },
  });

  const call = (data.content ?? []).find((item) => item.type === 'tool_use');
  if (!call) throw upstreamError('error.ai_failed', { message: 'no diagnosis' });
  const result = call.input ?? {};
  const list = (value) =>
    (Array.isArray(value) ? value : [])
      .map((item) => String(item).slice(0, 500))
      .filter(Boolean)
      .slice(0, 8);
  log.info(`Diagnosed ${record.name} in ${Date.now() - started}ms`);
  return {
    printerId: record.id,
    summary: String(result.summary ?? '').slice(0, 1000),
    causes: list(result.causes),
    steps: list(result.steps),
    severity: ['info', 'warning', 'critical'].includes(result.severity) ? result.severity : 'warning',
    model: data.model ?? settings.model,
  };
}

export function advisorStatus() {
  const settings = getConfig().ai ?? {};
  return { available: Boolean(settings.apiKey), model: settings.model || 'claude-sonnet-5' };
}

const INSPECT_VERDICTS = ['ok', 'suspect', 'failed', 'unclear'];
const INSPECT_ISSUES = ['none', 'spaghetti', 'detached', 'layer_shift', 'warping', 'under_extrusion', 'blob', 'support_failed', 'other'];

function describePrintInPhoto(record, status) {
  const job = status?.job;
  return [
    `Printer: ${record.name} (${driverClass(record.driver).label})`,
    record.connection?.model ? `Model: ${record.connection.model}` : null,
    `State: ${status?.state ?? 'unknown'}`,
    job ? `Printing: ${job.file}` : 'The printer reports no running print',
    job?.layer ? `Current layer: ${job.layer}${job.totalLayers ? `/${job.totalLayers}` : ''}` : null,
    job?.progress != null ? `Progress: ${job.progress}%` : null,
    status?.temps?.nozzle ? `Nozzle: ${status.temps.nozzle.actual}C` : null,
    status?.temps?.bed ? `Bed: ${status.temps.bed.actual}C` : null,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/** Send the camera frame along with the printer state to the vision model to say whether the print is still healthy. */
export async function inspectPrint(input = {}) {
  const settings = aiSettings();
  const record = printers.getRecord(input.printerId ?? input.printer);
  const status = printers.statusOf(record.id);
  const photo = input.photo ?? (await printers.snapshot(record.id));
  if (!photo?.buffer?.length) throw upstreamError('error.camera_failed', { detail: 'empty frame' });
  if (photo.buffer.length > MAX_IMAGE_BYTES) {
    throw badRequest('error.ai_image_too_large', { limit: Math.round(MAX_IMAGE_BYTES / (1024 * 1024)) });
  }

  const prompt = [
    describePrintInPhoto(record, status),
    '',
    input.note ? `Extra notes from the user: ${String(input.note).trim().slice(0, MAX_PURPOSE)}` : null,
    `Answer in this language: ${input.locale === 'en' ? 'English' : 'Vietnamese'}.`,
  ]
    .filter((line) => line !== null)
    .join('\n');

  const started = Date.now();
  const data = await callModel(settings, {
    system: systemPrompt('inspect'),
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: IMAGE_TYPES.has(photo.mime) ? photo.mime : 'image/jpeg',
              data: photo.buffer.toString('base64'),
            },
          },
          { type: 'text', text: prompt },
        ],
      },
    ],
    tools: [
      {
        name: 'report_print_health',
        description: 'Conclusion on whether the print in the image is healthy or has failed.',
        input_schema: {
          type: 'object',
          properties: {
            verdict: {
              type: 'string',
              enum: INSPECT_VERDICTS,
              description: 'ok means printing normally, suspect means there are worrying signs but nothing certain, failed means a clear failure, unclear means the image is not enough to judge.',
            },
            issue: { type: 'string', enum: INSPECT_ISSUES, description: 'The failure type you can see, or none if you see nothing.' },
            confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Confidence in the conclusion, from 0 to 1.' },
            summary: { type: 'string', description: 'One to two sentences describing exactly what you see in the image.' },
            advice: { type: 'array', items: { type: 'string' }, description: 'What to do right now, leave empty if the print is healthy.' },
          },
          required: ['verdict', 'issue', 'confidence', 'summary'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'report_print_health' },
  });

  const call = (data.content ?? []).find((item) => item.type === 'tool_use');
  if (!call) throw upstreamError('error.ai_failed', { message: 'no verdict' });
  const result = call.input ?? {};
  const confidence = Number(result.confidence);
  log.info(`Inspected image ${record.name}: ${result.verdict} in ${Date.now() - started}ms`);
  return {
    printerId: record.id,
    verdict: INSPECT_VERDICTS.includes(result.verdict) ? result.verdict : 'unclear',
    issue: INSPECT_ISSUES.includes(result.issue) ? result.issue : 'other',
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
    summary: String(result.summary ?? '').slice(0, 1000),
    advice: textList(result.advice),
    job: status?.job?.file ?? null,
    layer: status?.job?.layer ?? null,
    model: data.model ?? settings.model,
    at: new Date().toISOString(),
  };
}

const REVIEW_VERDICTS = ['ok', 'warning', 'risky'];

function textList(value, limit = 8) {
  return (Array.isArray(value) ? value : [])
    .map((item) => String(item).slice(0, 500))
    .filter(Boolean)
    .slice(0, limit);
}

/** Area and dimensions of the plate contact, computed from the real toolpath of the first layer. */
function firstLayerFootprint(file, plate) {
  let path = null;
  try {
    path = readToolpath(library.filePath(file), file.name, plate);
  } catch {
    return null;
  }
  if (!path?.points || !path.layers?.length) return null;

  const end = path.layers[1]?.point ?? path.points;
  const cells = new Set();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let at = path.layers[0].point; at + 1 < end; at += 2) {
    const fromX = path.positions[at * 3];
    const fromY = path.positions[at * 3 + 1];
    const toX = path.positions[(at + 1) * 3];
    const toY = path.positions[(at + 1) * 3 + 1];
    // Sample points along each segment then count 1mm grid cells; counting only the endpoints loses area on long infill lines.
    const steps = Math.min(200, Math.max(1, Math.ceil(Math.hypot(toX - fromX, toY - fromY))));
    for (let step = 0; step <= steps; step += 1) {
      const x = fromX + ((toX - fromX) * step) / steps;
      const y = fromY + ((toY - fromY) * step) / steps;
      cells.add(`${Math.floor(x)}:${Math.floor(y)}`);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (cells.size === 0) return null;
  return {
    areaMm2: cells.size,
    width: round(maxX - minX, 1),
    depth: round(maxY - minY, 1),
    height: path.bbox ? round(path.bbox[5], 1) : null,
    truncated: path.truncated === true,
    bed: path.bed ?? null,
  };
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function hoursOf(seconds) {
  return Number.isFinite(Number(seconds)) && Number(seconds) > 0 ? round(Number(seconds) / 3600, 1) : null;
}

/** Warnings computed straight from the numbers without the model, so they are always correct and always available even without AI configured. */
function ruleFindings({ meta, footprint, status, activeTray }) {
  const list = [];
  const add = (key, severity, params) => list.push({ key, severity, params, source: 'rule' });

  const nozzle = Number(status?.extra?.nozzleDiameter) || null;
  const sliceNozzle = Number(meta.nozzleDiameter) || null;
  const height = meta.maxZ ?? footprint?.height ?? null;

  if (meta.layerHeight && sliceNozzle && meta.layerHeight > sliceNozzle * 0.75 + 1e-9) {
    add('review.layer_too_thick', 'warning', { layer: meta.layerHeight, nozzle: sliceNozzle });
  }
  if (sliceNozzle && nozzle && Math.abs(sliceNozzle - nozzle) > 0.01) {
    add('review.nozzle_mismatch', 'critical', { file: sliceNozzle, printer: nozzle });
  }
  if (footprint && height) {
    const base = Math.max(1, Math.min(footprint.width, footprint.depth));
    const ratio = round(height / base, 1);
    if (ratio >= 4) add('review.tall_thin', 'warning', { height: round(height, 1), width: footprint.width, depth: footprint.depth, ratio });
  }
  if (footprint && footprint.areaMm2 < 600 && (height ?? 0) > 30) {
    add('review.small_footprint', 'warning', { area: footprint.areaMm2, height: round(height, 1) });
  }
  if (footprint?.bed?.x && footprint?.bed?.y && (footprint.width > footprint.bed.x || footprint.depth > footprint.bed.y)) {
    add('review.outside_bed', 'critical', { width: footprint.width, depth: footprint.depth, x: footprint.bed.x, y: footprint.bed.y });
  }
  const hours = hoursOf(meta.estimatedTime);
  if (hours && hours >= 8) add('review.long_print', 'info', { hours });
  if (meta.filamentType && activeTray?.type && meta.filamentType.toUpperCase() !== String(activeTray.type).toUpperCase()) {
    add('review.filament_mismatch', 'critical', { file: meta.filamentType, loaded: activeTray.type });
  }
  if (meta.filamentWeightG && activeTray?.remain != null && activeTray.remain <= 25) {
    add('review.filament_low', 'warning', { remain: activeTray.remain, weight: round(meta.filamentWeightG, 0) });
  }
  return list;
}

function describeFile(file, meta, footprint, status, record) {
  const size = meta.size ?? null;
  return [
    `File: ${file.name} (${file.format}${meta.sliced === false ? ', not sliced' : ''})`,
    meta.slicer ? `Sliced with: ${meta.slicer}` : null,
    size ? `Model bounding size: ${size.x} x ${size.y} x ${size.z} mm` : null,
    meta.maxZ ? `Print height: ${meta.maxZ} mm` : null,
    footprint ? `Plate contact at the first layer: about ${footprint.areaMm2} mm2, spread over ${footprint.width} x ${footprint.depth} mm` : null,
    meta.layerCount ? `Layer count: ${meta.layerCount}` : null,
    meta.layerHeight ? `Layer height: ${meta.layerHeight} mm` : null,
    meta.nozzleDiameter ? `File sliced for nozzle: ${meta.nozzleDiameter} mm` : null,
    meta.estimatedTime ? `Estimated print time: ${hoursOf(meta.estimatedTime)} hours` : null,
    meta.filamentWeightG ? `Filament needed: ${round(meta.filamentWeightG, 0)} g` : null,
    meta.filamentType ? `Filament type in the file: ${meta.filamentType}` : null,
    meta.nozzleTemp ? `Nozzle temperature in the file: ${meta.nozzleTemp}C` : null,
    meta.bedTemp ? `Bed temperature in the file: ${meta.bedTemp}C` : null,
    meta.overhangRatio !== undefined && meta.overhangRatio !== null
      ? `Area ratio of downward faces steeper than 30 degrees: ${Math.round(meta.overhangRatio * 100)}%`
      : null,
    '',
    record ? `Printer that will run it: ${record.name} (${driverClass(record.driver).label})` : 'No specific printer selected.',
    status?.extra?.nozzleDiameter ? `Nozzle installed on the printer: ${status.extra.nozzleDiameter} mm` : null,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/** Review a file about to be printed: the measurements yield certain warnings, the model adds risks that are hard to express as rules. */
export async function analyzePrint(input = {}) {
  const settings = aiSettings();
  const file = library.getFileRecord(input.fileId ?? input.file);
  const meta = file.meta ?? {};
  const record = input.printerId || input.printer ? printers.getRecord(input.printerId ?? input.printer) : null;
  const status = record ? printers.statusOf(record.id) : null;
  const plate = Number(input.plate) > 0 ? Number(input.plate) : 1;
  const footprint = meta.sliced === false ? null : firstLayerFootprint(file, plate);
  const trays = status?.extra?.ams?.flatMap((unit) => unit.trays ?? []) ?? [];
  const activeTray = trays.find((tray) => tray.id === status?.extra?.amsActiveTray) ?? status?.extra?.externalSpool ?? null;
  const findings = ruleFindings({ meta, footprint, status, activeTray });
  const history = insights.statsDigest({ printerId: record?.id, fileId: file.sourceId ?? file.id, material: meta.filamentType });

  const prompt = [
    describeFile(file, meta, footprint, status, record),
    '',
    history.length > 0 ? `Statistics from previous prints:\n${history.join('\n')}\n` : null,
    findings.length > 0
      ? `Warnings the agent computed itself:\n${findings.map((item) => `- ${t(item.key, item.params, input.locale)}`).join('\n')}`
      : 'The agent computed no warning.',
    '',
    input.note ? `Extra notes from the user: ${String(input.note).trim().slice(0, MAX_PURPOSE)}` : null,
    `Answer in this language: ${input.locale === 'en' ? 'English' : 'Vietnamese'}.`,
  ]
    .filter((line) => line !== null)
    .join('\n');

  const started = Date.now();
  const data = await callModel(settings, {
    system: systemPrompt('review'),
    messages: [{ role: 'user', content: prompt }],
    tools: [
      {
        name: 'review_print_job',
        description: 'Assess the file about to be printed and list the risks along with their fixes.',
        input_schema: {
          type: 'object',
          properties: {
            verdict: {
              type: 'string',
              enum: REVIEW_VERDICTS,
              description: 'ok means ready to print, warning means a few things should be adjusted, risky means it is likely to fail if printed as is.',
            },
            summary: { type: 'string', description: 'One to two sentences settling whether this file can be printed.' },
            findings: {
              type: 'array',
              description: 'The risks worth mentioning, ordered from most serious down. Do not repeat the agent-computed warnings verbatim.',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: 'A short name for the risk.' },
                  detail: { type: 'string', description: 'Why it matters for this exact file.' },
                  severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
                  advice: { type: 'string', description: 'A concrete fix.' },
                },
                required: ['title', 'detail', 'severity'],
              },
            },
          },
          required: ['verdict', 'summary'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'review_print_job' },
  });

  const call = (data.content ?? []).find((item) => item.type === 'tool_use');
  if (!call) throw upstreamError('error.ai_failed', { message: 'no review' });
  const result = call.input ?? {};
  log.info(`Reviewed file ${file.name} in ${Date.now() - started}ms`);
  return {
    fileId: file.id,
    printerId: record?.id ?? null,
    plate,
    verdict: REVIEW_VERDICTS.includes(result.verdict) ? result.verdict : 'warning',
    summary: String(result.summary ?? '').slice(0, 1000),
    findings: [
      ...findings.map((item) => ({ title: t(item.key, item.params, input.locale), detail: null, severity: item.severity, advice: null, source: 'rule' })),
      ...(Array.isArray(result.findings) ? result.findings : []).slice(0, 8).map((item) => ({
        title: String(item?.title ?? '').slice(0, 200),
        detail: String(item?.detail ?? '').slice(0, 800) || null,
        severity: ['info', 'warning', 'critical'].includes(item?.severity) ? item.severity : 'info',
        advice: item?.advice ? String(item.advice).slice(0, 500) : null,
        source: 'ai',
      })),
    ].filter((item) => item.title),
    footprint,
    model: data.model ?? settings.model,
    at: new Date().toISOString(),
  };
}
