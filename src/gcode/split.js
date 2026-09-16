import path from 'node:path';
import { badRequest } from '../util/errors.js';
import { fileFormat } from './metadata.js';
import { each3mfTriangle, eachModelTriangle } from './mesh.js';
import { apply, nest } from './nest.js';
import { openZip, writeZip } from './zip.js';

const MAX_TRIANGLES = 1000000;
const MAX_PARTS = 200;
/** Gap between two objects and margin from the bed edge when re-nesting, taken from slicer defaults. */
const GAP = 6;
const MARGIN = 2;
/** Above this triangle count, try two rotations instead of four, trading packing density for wait time. */
const HEAVY = 300000;
/** Two parts touching along a single line still count as separate, only past this threshold do footprints overlap. */
const TOUCH = 0.05;
/** Adjacent triangles always write a shared vertex with the same value, welding at 0.1 micron is enough. */
const WELD = 1e4;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rel-1" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;

function escapeXml(value) {
  return String(value).replace(/[<>&"']/g, (char) => `&${{ '<': 'lt', '>': 'gt', '&': 'amp', '"': 'quot', "'": 'apos' }[char]};`);
}

function num(value) {
  const rounded = Math.round(value * WELD) / WELD;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

function round(value, digits) {
  return Math.round(value * 10 ** digits) / 10 ** digits;
}

/** Collect every triangle into one welded vertex table, with union-find to tell which faces are connected. */
function collect(filePath, name) {
  const lookup = new Map();
  const coords = [];
  const faces = [];
  const sources = [];
  const parent = [];
  const depth = [];

  const find = (item) => {
    let node = item;
    while (parent[node] !== node) {
      parent[node] = parent[parent[node]];
      node = parent[node];
    }
    return node;
  };

  const union = (left, right) => {
    const rootLeft = find(left);
    const rootRight = find(right);
    if (rootLeft === rootRight) return;
    if (depth[rootLeft] < depth[rootRight]) {
      parent[rootLeft] = rootRight;
      return;
    }
    parent[rootRight] = rootLeft;
    if (depth[rootLeft] === depth[rootRight]) depth[rootLeft] += 1;
  };

  const vertex = (point) => {
    const key = `${Math.round(point[0] * WELD)},${Math.round(point[1] * WELD)},${Math.round(point[2] * WELD)}`;
    const found = lookup.get(key);
    if (found !== undefined) return found;
    const id = parent.length;
    lookup.set(key, id);
    parent.push(id);
    depth.push(0);
    coords.push(point[0], point[1], point[2]);
    return id;
  };

  const add = (a, b, c, item) => {
    if (faces.length >= MAX_TRIANGLES * 3) throw badRequest('error.split_too_large', { limit: MAX_TRIANGLES });
    const first = vertex(a);
    const second = vertex(b);
    const third = vertex(c);
    // A degenerate triangle adds no geometry but still connects its vertices.
    union(first, second);
    union(second, third);
    if (first === second || second === third || first === third) return;
    faces.push(first, second, third);
    sources.push(item?.name ?? null);
  };

  const format = fileFormat(name);
  if (format === '3mf') {
    const zip = openZip(filePath);
    try {
      each3mfTriangle(zip, add);
    } finally {
      zip.close();
    }
  } else if (format === 'model') {
    eachModelTriangle(filePath, name, add);
  } else {
    throw badRequest('error.split_source_invalid', { name });
  }

  return { coords, faces, sources, find };
}

function measurePart(coords, faces, offsets) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let volume = 0;
  for (const at of offsets) {
    const corners = [faces[at], faces[at + 1], faces[at + 2]].map((index) => [coords[index * 3], coords[index * 3 + 1], coords[index * 3 + 2]]);
    for (const point of corners) {
      for (let axis = 0; axis < 3; axis += 1) {
        if (point[axis] < min[axis]) min[axis] = point[axis];
        if (point[axis] > max[axis]) max[axis] = point[axis];
      }
    }
    const [a, b, c] = corners;
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return {
    offsets,
    volume: Math.abs(volume),
    min,
    max,
    size: { x: round(max[0] - min[0], 2), y: round(max[1] - min[1], 2), z: round(max[2] - min[2], 2) },
    // Move the mesh to its own origin and push the old position into the build item transform, the way slicers write 3MF.
    origin: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, min[2]],
  };
}

function partXml(id, label, coords, faces, { offsets, origin }, place = null) {
  const remap = new Map();
  const vertices = [];
  const triangles = [];
  for (const at of offsets) {
    const refs = [];
    for (let corner = 0; corner < 3; corner += 1) {
      const index = faces[at + corner];
      let mapped = remap.get(index);
      if (mapped === undefined) {
        mapped = remap.size;
        remap.set(index, mapped);
        vertices.push(
          `<vertex x="${num(coords[index * 3] - origin[0])}" y="${num(coords[index * 3 + 1] - origin[1])}" z="${num(coords[index * 3 + 2] - origin[2])}"/>`,
        );
      }
      refs.push(mapped);
    }
    triangles.push(`<triangle v1="${refs[0]}" v2="${refs[1]}" v3="${refs[2]}"/>`);
  }
  const matrix = place?.matrix ?? '1 0 0 0 1 0 0 0 1';
  const at = place?.at ?? origin;
  return {
    object: `<object id="${id}" type="model" name="${escapeXml(label)}"><mesh><vertices>${vertices.join('')}</vertices><triangles>${triangles.join('')}</triangles></mesh></object>`,
    item: `<item objectid="${id}" transform="${matrix} ${num(at[0])} ${num(at[1])} ${num(at[2])}" printable="1"/>`,
  };
}

/** Read the file into a list of disconnected parts, largest first so the main part is obvious from the list. */
export function measureParts(filePath, name) {
  const { coords, faces, sources, find } = collect(filePath, name);
  if (faces.length === 0) throw badRequest('error.split_no_mesh', { name });

  const groups = new Map();
  for (let at = 0; at < faces.length; at += 3) {
    const root = find(faces[at]);
    const existing = groups.get(root);
    if (existing) existing.push(at);
    else groups.set(root, [at]);
  }
  if (groups.size > MAX_PARTS) throw badRequest('error.split_too_many', { count: groups.size, limit: MAX_PARTS });

  const measured = [...groups.values()].map((offsets) => measurePart(coords, faces, offsets)).sort((left, right) => right.volume - left.volume);
  return { coords, faces, sources, measured };
}

/** Pack the parts into a 3MF; `place(part, index)` decides placement, omit it to keep the original positions. */
export function packModel({ coords, faces, sources, measured }, base, place = null) {
  const objects = [];
  const items = [];
  const parts = [];
  const used = new Set();
  measured.forEach((part, index) => {
    let label = sources[part.offsets[0] / 3] || `${base}-${index + 1}`;
    // One source object can break into several parts, names must differ to stay recognizable in the slicer.
    if (used.has(label)) label = `${label}-${index + 1}`;
    used.add(label);
    const xml = partXml(index + 1, label, coords, faces, part, place?.(part, index) ?? null);
    objects.push(xml.object);
    items.push(xml.item);
    parts.push({ name: label, triangles: part.offsets.length, size: part.size, volumeCm3: round(part.volume / 1000, 2) });
  });

  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <metadata name="Application">PrintAgent3D</metadata>
 <resources>${objects.join('')}</resources>
 <build>${items.join('')}</build>
</model>`;

  return { buffer: writeZip({ '[Content_Types].xml': CONTENT_TYPES, '_rels/.rels': RELS, '3D/3dmodel.model': model }), parts };
}

export function baseName(name) {
  return path.basename(String(name)).replace(/\.[^.]+$/, '') || 'part';
}

/**
 * Split the disconnected parts of a model file into independent objects and repack them as 3MF,
 * so the slicer treats them as separate objects and can arrange them on the bed.
 */
export function splitModel(filePath, name) {
  const parts = measureParts(filePath, name);
  if (parts.measured.length < 2) throw badRequest('error.split_single_part', { name });
  return packModel(parts, baseName(name));
}

/**
 * Group parts whose bed footprints overlap into one cluster.
 * Name plates or multi-piece molds have a base and raised parts sitting on top of each other; nesting those apart breaks the model.
 * With `separate` on, every part stands alone, for when the user deliberately wants overlapping clusters broken up.
 */
function clusterParts(measured, separate = false) {
  if (separate) return measured.map((part) => [part]);

  const parent = measured.map((_, index) => index);
  const find = (item) => {
    let node = item;
    while (parent[node] !== node) {
      parent[node] = parent[parent[node]];
      node = parent[node];
    }
    return node;
  };

  for (let left = 0; left < measured.length; left += 1) {
    for (let right = left + 1; right < measured.length; right += 1) {
      const a = measured[left];
      const b = measured[right];
      const apart = a.max[0] - b.min[0] <= TOUCH || b.max[0] - a.min[0] <= TOUCH || a.max[1] - b.min[1] <= TOUCH || b.max[1] - a.min[1] <= TOUCH;
      if (apart) continue;
      const rootLeft = find(left);
      const rootRight = find(right);
      if (rootLeft !== rootRight) parent[rootRight] = rootLeft;
    }
  }

  const clusters = new Map();
  measured.forEach((part, index) => {
    const root = find(index);
    const existing = clusters.get(root);
    if (existing) existing.push(part);
    else clusters.set(root, [part]);
  });
  return [...clusters.values()];
}

/** Triangle iterator for a cluster, letting the nester build the real footprint without copying coordinates. */
function clusterTriangles(coords, faces, items) {
  const point = (index) => [coords[index * 3], coords[index * 3 + 1], coords[index * 3 + 2]];
  return (onTriangle) => {
    for (const part of items) {
      for (const at of part.offsets) onTriangle(point(faces[at]), point(faces[at + 1]), point(faces[at + 2]));
    }
  };
}

/**
 * Convert a 3x3 rotation matrix (column convention) into a 3MF transform string.
 * In 3MF points are row vectors, so the transpose must be written or the object rotates the wrong way.
 */
export function matrixText(matrix) {
  return [matrix[0], matrix[3], matrix[6], matrix[1], matrix[4], matrix[7], matrix[2], matrix[5], matrix[8]].map(num).join(' ');
}

export function arrangeModel(filePath, name, bed, { gap = GAP, margin = MARGIN, separate = false, autoRotate = false } = {}) {
  if (!bed) throw badRequest('error.arrange_no_bed', { name });
  const parts = measureParts(filePath, name);
  const groups = clusterParts(parts.measured, separate).map((items) => ({
    item: items,
    each: clusterTriangles(parts.coords, parts.faces, items),
  }));

  const { placed, overflow } = nest(groups, bed, {
    gap,
    margin,
    autoRotate,
    angles: parts.faces.length / 3 > HEAVY ? 2 : 4,
  });
  if (placed.length === 0) throw badRequest('error.arrange_too_large', { name });

  const spots = new Map();
  for (const spot of placed) {
    for (const part of spot.item) spots.set(part, spot);
  }

  const place = (part) => {
    const spot = spots.get(part);
    // A cluster that could not be nested stays where it was, so the user can see it and deal with it.
    if (!spot) return null;
    // The mesh in the file is stored around the part's own origin, so the translation must add how the rotation moved that origin.
    const moved = apply(spot.matrix, part.origin);
    return { matrix: matrixText(spot.matrix), at: [moved[0] + spot.offset[0], moved[1] + spot.offset[1], moved[2] + spot.offset[2]] };
  };

  return { ...packModel(parts, baseName(name), place), clusters: placed.length, overflow: overflow.length };
}

const MAX_COMBINED_PARTS = 500;

/**
 * Combine several model files (each with any number of copies) onto one plate and pack them into a single 3MF,
 * to slice once instead of per file. Copies that do not fit the bed are dropped and reported back.
 */
export function combineModels(sources, bed, { gap = GAP, margin = MARGIN, autoRotate = false } = {}) {
  if (!bed) throw badRequest('error.arrange_no_bed', { name: sources[0]?.name ?? '' });
  const coords = [];
  const faces = [];
  const labels = [];
  const groups = [];
  let partCount = 0;

  for (const source of sources) {
    const parts = measureParts(source.filePath, source.name);
    const vertexBase = coords.length / 3;
    const faceBase = faces.length;
    if (faceBase + parts.faces.length > MAX_TRIANGLES * 3) throw badRequest('error.split_too_large', { limit: MAX_TRIANGLES });
    for (let at = 0; at < parts.coords.length; at += 1) coords.push(parts.coords[at]);
    for (let at = 0; at < parts.faces.length; at += 1) faces.push(parts.faces[at] + vertexBase);
    const label = baseName(source.name);
    for (let at = 0; at < parts.faces.length; at += 3) labels.push(label);
    const shifted = parts.measured.map((part) => ({ ...part, offsets: part.offsets.map((offset) => offset + faceBase) }));
    for (let copy = 0; copy < source.copies; copy += 1) {
      for (const cluster of clusterParts(shifted)) {
        const items = cluster.map((part) => ({ ...part }));
        partCount += items.length;
        if (partCount > MAX_COMBINED_PARTS) throw badRequest('error.split_too_many', { count: partCount, limit: MAX_COMBINED_PARTS });
        groups.push({ item: items, each: clusterTriangles(coords, faces, items), name: source.name });
      }
    }
  }

  const { placed, overflow } = nest(groups, bed, { gap, margin, autoRotate, angles: faces.length / 3 > HEAVY ? 2 : 4 });
  if (placed.length === 0) throw badRequest('error.arrange_too_large', { name: sources[0]?.name ?? '' });

  const spots = new Map();
  const measured = [];
  for (const spot of placed) {
    for (const part of spot.item) {
      spots.set(part, spot);
      measured.push(part);
    }
  }
  const place = (part) => {
    const spot = spots.get(part);
    const moved = apply(spot.matrix, part.origin);
    return { matrix: matrixText(spot.matrix), at: [moved[0] + spot.offset[0], moved[1] + spot.offset[1], moved[2] + spot.offset[2]] };
  };
  return {
    ...packModel({ coords, faces, sources: labels, measured }, 'plate', place),
    placed: placed.length,
    overflow: overflow.length,
    overflowNames: [...new Set(overflow.map((group) => group.name))],
  };
}

/**
 * Move objects on the bed from the user's drag and drop: only the translation part of the build item transform changes,
 * everything else in the 3MF package stays untouched so geometry and file settings are preserved.
 */
export function moveBuildItems(filePath, name, moves) {
  if (fileFormat(name) !== '3mf') throw badRequest('error.split_source_invalid', { name });
  const shifts = new Map();
  for (const move of moves ?? []) {
    const index = Number(move?.item);
    const dx = Number(move?.dx) || 0;
    const dy = Number(move?.dy) || 0;
    if (!Number.isInteger(index) || index < 0) continue;
    shifts.set(index, [dx, dy]);
  }
  if (shifts.size === 0) throw badRequest('error.layout_no_move', { name });

  const zip = openZip(filePath);
  let entries;
  let model;
  try {
    model = zip.read('3D/3dmodel.model')?.toString('utf8') ?? null;
    if (!model) throw badRequest('error.split_source_invalid', { name });
    entries = Object.fromEntries(zip.entries.map((entry) => [entry.name, zip.read(entry.name)]).filter(([, data]) => data));
  } finally {
    zip.close();
  }

  let index = -1;
  let moved = 0;
  const next = model.replace(/<item\s[^>]*?\/?>/g, (tag) => {
    index += 1;
    const shift = shifts.get(index);
    if (!shift) return tag;
    moved += 1;
    const found = tag.match(/transform="([^"]*)"/);
    const numbers = found ? found[1].trim().split(/\s+/).map(Number) : [];
    const matrix = numbers.length === 12 && numbers.every(Number.isFinite) ? numbers : [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
    matrix[9] += shift[0];
    matrix[10] += shift[1];
    const text = `transform="${matrix.map(num).join(' ')}"`;
    return found ? tag.replace(found[0], text) : tag.replace(/\/?>$/, (end) => ` ${text}${end}`);
  });
  if (moved === 0) throw badRequest('error.layout_no_move', { name });

  entries['3D/3dmodel.model'] = Buffer.from(next, 'utf8');
  return { buffer: writeZip(entries), moved };
}
