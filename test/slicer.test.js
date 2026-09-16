import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'p3d-slicer-'));
process.env.PRINTAGENT3D_DATA_DIR = dataDir;
process.env.PRINTAGENT3D_LOG_LEVEL = 'error';

const { openZip } = await import('../src/gcode/zip.js');
const { updateConfig } = await import('../src/core/config.js');
const library = await import('../src/core/library.js');
const printers = await import('../src/core/printers.js');
const slicer = await import('../src/core/slicer.js');

library.loadLibrary();
printers.loadPrinters();

/** Binary STL: a 20mm cube, 12 triangles. */
function cubeStl() {
  const corners = [
    [0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0],
    [0, 0, 20], [20, 0, 20], [20, 20, 20], [0, 20, 20],
  ];
  const faces = [
    [0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  const buffer = Buffer.alloc(84 + faces.length * 50);
  buffer.writeUInt32LE(faces.length, 80);
  faces.forEach((face, index) => {
    let offset = 84 + index * 50 + 12;
    for (const corner of face) {
      for (const value of corners[corner]) {
        buffer.writeFloatLE(value, offset);
        offset += 4;
      }
    }
  });
  return buffer;
}

test('With no slicer it errors clearly instead of running a command blindly', async () => {
  updateConfig({ slicer: { binPath: path.join(dataDir, 'khong-ton-tai') } });
  assert.equal(slicer.slicerStatus().available, false);
  await assert.rejects(slicer.sliceModel({ fileId: 'fil_x', printerId: 'prn_x', machine: 'x' }), { key: 'error.slicer_not_found' });
});

test('Real slicing when a slicer is installed: Bambu takes 3MF, G-code printers take .gcode', async (t) => {
  updateConfig({ slicer: { binPath: null, profilesDir: null } });
  if (!slicer.slicerStatus().available) {
    t.skip('Neither OrcaSlicer nor BambuStudio is installed on this machine');
    return;
  }

  const stl = path.join(dataDir, 'cube.stl');
  writeFileSync(stl, cubeStl());
  const model = library.addFromPath(stl, 'cube.stl', { copy: true });
  assert.equal(model.format, 'model');
  assert.equal(model.meta.triangles, 12);

  const bambu = printers.addPrinter({
    name: 'Bambu slicer test',
    driver: 'bambu',
    enabled: false,
    connection: { host: '127.0.0.1', accessCode: '12345678', serial: '26A00000000', model: 'A2L' },
  });
  const klipper = printers.addPrinter({ name: 'Klipper slicer test', driver: 'moonraker', enabled: false, connection: { host: '127.0.0.1' } });

  const profiles = slicer.listProfiles({ printerId: bambu.id });
  assert.ok(profiles.machines.length > 0);
  const machine = profiles.suggestedMachines.find((name) => name.includes('0.4')) ?? profiles.machines[0].name;
  const detail = slicer.listProfiles({ printerId: bambu.id, machine });
  assert.ok(detail.processes.length > 0, 'must have a compatible process');
  assert.ok(detail.filaments.length > 0, 'must have a compatible filament');
  // The filament type lives in the root profile, not the leaf; miss it and neither the UI nor the AI knows which filament is printing.
  assert.ok(detail.filaments.some((item) => item.filamentType), 'must read the filament type from the profile');

  const sliced = await slicer.sliceModel({
    fileId: model.id,
    printerId: bambu.id,
    machine,
    layerHeight: 0.28,
    infill: 25,
    seam: 'back',
    wallLoops: 3,
    infillPattern: 'gyroid',
    outerWallSpeed: 120,
    nozzleTemp: 225,
    brim: 'outer_only',
    detectThinWall: true,
    infillCombination: false,
    topSurfacePattern: 'monotonicline',
    topSurfaceDensity: 95,
    infillWallOverlap: 25,
    infillAnchor: '400%',
    fillMultiline: 3,
    ensureVerticalShell: 'disabled',
    extra: { ironing_speed: '20' },
  });
  assert.equal(sliced.file.format, '3mf');
  assert.equal(sliced.file.meta.sliced, true);
  assert.equal(sliced.stats.layerHeight, 0.28);
  assert.equal(sliced.stats.infill, 25);
  // Only the merged inherited profile yields a filament weight, otherwise it is 0 because the density is 0.
  assert.ok(sliced.stats.filamentWeightG > 0, 'must compute the filament weight');
  assert.ok(sliced.file.hasThumbnail, 'must pick up the plate thumbnail');

  // Every option must land in the 3MF config, including custom keys passed through extra.
  const zip = openZip(library.filePath(library.getFileRecord(sliced.file.id)));
  const applied = JSON.parse(zip.read('Metadata/project_settings.config').toString('utf8'));
  zip.close();
  assert.equal(applied.seam_position, 'back');
  assert.equal(applied.wall_loops, '3');
  assert.equal(applied.sparse_infill_pattern, 'gyroid');
  assert.deepEqual(applied.outer_wall_speed, ['120']);
  assert.deepEqual(applied.nozzle_temperature, ['225']);
  assert.equal(applied.brim_type, 'outer_only');
  // Boolean flags must be sent as --key=value; split apart, the slicer reads them as an input file name.
  assert.equal(applied.detect_thin_wall, '1');
  assert.equal(applied.infill_combination, '0');
  assert.equal(applied.top_surface_pattern, 'monotonicline');
  assert.equal(applied.top_surface_density, '95%');
  assert.equal(applied.infill_wall_overlap, '25%');
  assert.equal(applied.sparse_infill_anchor, '400%');
  assert.equal(applied.fill_multiline, '3');
  assert.equal(applied.ensure_vertical_shell_thickness, 'disabled');
  assert.equal(applied.ironing_speed, '20');

  // Reopening to slice again must fill the form with exactly the fields changed from the profile, not the whole profile.
  const readBack = slicer.readSliceSettings(sliced.file.id);
  assert.equal(readBack.machine, machine);
  assert.equal(readBack.options.layerHeight, 0.28);
  assert.equal(readBack.options.seam, 'back');
  assert.equal(readBack.options.wallLoops, 3);
  assert.equal(readBack.options.infillPattern, 'gyroid');
  assert.equal(readBack.options.nozzleTemp, 225);
  assert.equal(readBack.options.brim, 'outer_only');
  assert.equal(readBack.options.topLayers, undefined, 'an unchanged field stays empty so it keeps following the profile');
  assert.equal(readBack.extra.ironing_speed, '20');
  assert.equal(readBack.extra.name, undefined, 'keys the slicer writes itself are not user settings');
  // With nothing specified the agent must pick the plate itself; left empty the slicer takes "Cool Plate" and then aborts on many filaments.
  assert.ok(sliced.plate, 'must pick a plate');
  assert.equal(applied.curr_bed_type, sliced.plate);

  // PETG cannot print on a Cool Plate: a blind pick must error clearly, while letting the agent choose must still slice.
  const petg = detail.filaments.find((item) => item.filamentType === 'PETG');
  if (petg) {
    const onPetg = await slicer.sliceModel({ fileId: model.id, printerId: bambu.id, machine, filament: petg.name, bedTemp: 82, nozzleTemp: 241 });
    assert.notEqual(onPetg.plate, 'Cool Plate');
    const petgZip = openZip(library.filePath(library.getFileRecord(onPetg.file.id)));
    const petgConfig = JSON.parse(petgZip.read('Metadata/project_settings.config').toString('utf8'));
    petgZip.close();
    assert.equal(petgConfig.curr_bed_type, onPetg.plate);
    // The bed temperature must land in the field of the plate in use; the wrong field is never read by the slicer.
    const plateKey = { 'Textured PEI Plate': 'textured_plate_temp', 'High Temp Plate': 'hot_plate_temp', 'Engineering Plate': 'eng_plate_temp', 'Supertack Plate': 'supertack_plate_temp' }[onPetg.plate];
    assert.deepEqual(petgConfig[`${plateKey}_initial_layer`], ['82']);
    // If the nozzle temperature is set but the first layer still follows the profile, the first layer prints at the wrong temperature.
    assert.deepEqual(petgConfig.nozzle_temperature, ['241']);
    assert.deepEqual(petgConfig.nozzle_temperature_initial_layer, ['241']);

    await assert.rejects(slicer.sliceModel({ fileId: model.id, printerId: bambu.id, machine, filament: petg.name, plateType: 'Cool Plate' }), {
      key: 'error.plate_incompatible',
    });
  }

  const gcode = await slicer.sliceModel({ fileId: model.id, printerId: klipper.id, machine });
  assert.equal(gcode.file.format, 'gcode');
  assert.ok(gcode.file.meta.estimatedTime > 0);
  assert.equal(slicer.readSliceSettings(gcode.file.id), null);

  await assert.rejects(slicer.sliceModel({ fileId: model.id, printerId: bambu.id, machine, layerHeight: 9 }), {
    key: 'error.slicer_option_range',
  });
  // A layer thicker than the nozzle only makes the slicer say "invalid parameter", so block it up front and say exactly what is wrong.
  await assert.rejects(slicer.sliceModel({ fileId: model.id, printerId: bambu.id, machine, layerHeight: 0.6 }), {
    key: 'error.layer_too_thick',
  });
  await assert.rejects(slicer.sliceModel({ fileId: model.id, printerId: bambu.id, machine, seam: 'diagonal' }), {
    key: 'error.slicer_option_invalid',
  });
  await assert.rejects(slicer.sliceModel({ fileId: model.id, printerId: bambu.id, machine, extra: { 'rm -rf': '1' } }), {
    key: 'error.slicer_option_invalid',
  });
  await assert.rejects(slicer.sliceModel({ fileId: model.id, printerId: bambu.id, machine, infillAnchor: '4 cm' }), {
    key: 'error.slicer_option_invalid',
  });
  await assert.rejects(slicer.sliceModel({ fileId: model.id, printerId: bambu.id, machine, topSurfaceDensity: 140 }), {
    key: 'error.slicer_option_range',
  });
  await assert.rejects(slicer.sliceModel({ fileId: sliced.file.id, printerId: bambu.id, machine }), {
    key: 'error.slicer_source_invalid',
  });

  await printers.stopAll();
});

test('A machine profile declaring start G-code in a separate file via include must still be merged', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'p3d-include-'));
  const bin = path.join(root, 'fake-slicer');
  writeFileSync(bin, '');
  const write = (file, data) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data));
  };
  const system = path.join(root, 'profiles');
  // Newer Bambu machines move long G-code blocks and even the bed size into a template file declared through include.
  write(path.join(system, 'BBL', 'machine', 'may.json'), {
    type: 'machine', name: 'May Moi 0.4 nozzle', instantiation: 'true',
    printer_model: 'May Moi', nozzle_diameter: ['0.4'],
    include: ['May Moi 0.4 nozzle template machine_start_gcode'],
  });
  write(path.join(system, 'BBL', 'machine', 'may-start.json'), {
    type: 'machine', name: 'May Moi 0.4 nozzle template machine_start_gcode', instantiation: 'false',
    printable_area: ['0x0', '330x0', '330x320', '0x320'], printable_height: '325',
    machine_start_gcode: 'M109 S[nozzle_temperature_initial_layer]',
  });

  updateConfig({ slicer: { binPath: bin, profilesDir: system, userProfilesDir: null } });
  const bed = slicer.machineBed({ machine: 'May Moi 0.4 nozzle' });
  assert.deepEqual(
    bed && { maxX: bed.maxX, maxY: bed.maxY, maxZ: bed.maxZ },
    { maxX: 330, maxY: 320, maxZ: 325 },
    'settings inside an included file must be merged, otherwise the slicer runs on its own defaults',
  );

  updateConfig({ slicer: { binPath: null, profilesDir: null, userProfilesDir: null } });
});

test('User presets saved in Bambu Studio show up too and inherit the vendor profile', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'p3d-presets-'));
  const bin = path.join(root, 'fake-slicer');
  writeFileSync(bin, '');
  const write = (file, data) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data));
  };
  const system = path.join(root, 'profiles');
  write(path.join(system, 'BBL', 'machine', 'may.json'), {
    type: 'machine', name: 'May Thu 0.4 nozzle', instantiation: 'true',
    printer_model: 'May Thu', nozzle_diameter: ['0.4'], default_filament_profile: ['PETG goc'],
  });
  write(path.join(system, 'BBL', 'filament', 'petg.json'), {
    type: 'filament', name: 'PETG goc', instantiation: 'true',
    compatible_printers: ['May Thu 0.4 nozzle'], filament_type: ['PETG'], nozzle_temperature: ['255'],
  });
  // A user preset only stores the keys it changed, with no compatible_printers and no filament_type.
  const mine = path.join(root, 'user');
  write(path.join(mine, '42', 'filament', 'petg-230.json'), {
    type: 'filament', from: 'User', name: 'PETG goc - 230C', inherits: 'PETG goc', nozzle_temperature: ['230'],
  });

  updateConfig({ slicer: { binPath: bin, profilesDir: system, userProfilesDir: mine } });
  const list = slicer.listProfiles({ machine: 'May Thu 0.4 nozzle' });
  assert.ok(list.vendors.includes('User'), 'must include the user preset group');
  const found = list.filaments.find((item) => item.name === 'PETG goc - 230C');
  assert.ok(found, `user preset must show up, got: ${list.filaments.map((item) => item.name).join(', ')}`);
  assert.equal(found.vendor, 'User');
  assert.equal(found.filamentType, 'PETG', 'the filament type must be resolved from the parent profile');

  updateConfig({ slicer: { binPath: null, profilesDir: null, userProfilesDir: null } });
});

test('A user preset resolving to a root profile must take its own vendor, not a same-named profile from another vendor', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'p3d-vendor-'));
  const bin = path.join(root, 'fake-slicer');
  writeFileSync(bin, '');
  const write = (file, data) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data));
  };
  const system = path.join(root, 'profiles');
  // Twelve vendors in BambuStudio all name their root profile `fdm_filament_pet`, each with different numbers.
  write(path.join(system, 'Anker', 'filament', 'pet.json'), {
    type: 'filament', name: 'fdm_filament_pet', instantiation: 'false', filament_type: ['PETG'], nozzle_temperature: ['240'],
  });
  write(path.join(system, 'BBL', 'filament', 'pet.json'), {
    type: 'filament', name: 'fdm_filament_pet', instantiation: 'false', filament_type: ['PETG'], nozzle_temperature: ['255'],
  });
  write(path.join(system, 'BBL', 'machine', 'may.json'), {
    type: 'machine', name: 'May Hang 0.4 nozzle', instantiation: 'true',
    printer_model: 'May Hang', nozzle_diameter: ['0.4'], default_filament_profile: ['PETG hang'], default_print_profile: 'Quy trinh hang',
  });
  write(path.join(system, 'BBL', 'process', 'quy-trinh.json'), {
    type: 'process', name: 'Quy trinh hang', instantiation: 'true',
    compatible_printers: ['May Hang 0.4 nozzle'], layer_height: '0.2',
  });
  write(path.join(system, 'BBL', 'filament', 'petg.json'), {
    type: 'filament', name: 'PETG hang', instantiation: 'true', inherits: 'fdm_filament_pet',
    compatible_printers: ['May Hang 0.4 nozzle'],
  });
  const mine = path.join(root, 'user');
  write(path.join(mine, '42', 'filament', 'petg-toc-do.json'), {
    type: 'filament', from: 'User', name: 'PETG hang - nhanh', inherits: 'PETG hang',
  });

  updateConfig({ slicer: { binPath: bin, profilesDir: system, userProfilesDir: mine } });
  const values = slicer.profileValues({ machine: 'May Hang 0.4 nozzle', filament: 'PETG hang - nhanh' });
  assert.equal(
    values.values.nozzleTemp,
    255,
    'a user preset must resolve to the root profile of its own machine vendor; the wrong vendor means wrong temperatures and wrong G-code',
  );

  updateConfig({ slicer: { binPath: null, profilesDir: null, userProfilesDir: null } });
});
