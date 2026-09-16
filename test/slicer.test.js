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

/** STL nhị phân: khối lập phương 20mm, 12 tam giác. */
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

test('Không có slicer thì báo lỗi rõ ràng thay vì chạy lệnh bừa', async () => {
  updateConfig({ slicer: { binPath: path.join(dataDir, 'khong-ton-tai') } });
  assert.equal(slicer.slicerStatus().available, false);
  await assert.rejects(slicer.sliceModel({ fileId: 'fil_x', printerId: 'prn_x', machine: 'x' }), { key: 'error.slicer_not_found' });
});

test('Cắt lát thật khi máy có slicer: Bambu nhận 3MF, máy G-code nhận .gcode', async (t) => {
  updateConfig({ slicer: { binPath: null, profilesDir: null } });
  if (!slicer.slicerStatus().available) {
    t.skip('Máy này chưa cài OrcaSlicer hoặc BambuStudio');
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
  assert.ok(detail.processes.length > 0, 'phải có process tương thích');
  assert.ok(detail.filaments.length > 0, 'phải có sợi nhựa tương thích');
  // Loại nhựa nằm ở profile gốc chứ không ở profile lá, đọc thiếu thì cả giao diện lẫn AI đều không biết đang in nhựa gì.
  assert.ok(detail.filaments.some((item) => item.filamentType), 'phải đọc được loại nhựa của profile');

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
  // Profile gộp kế thừa mới ra khối lượng nhựa, nếu không sẽ là 0 vì mật độ nhựa bằng 0.
  assert.ok(sliced.stats.filamentWeightG > 0, 'phải tính được khối lượng nhựa');
  assert.ok(sliced.file.hasThumbnail, 'phải lấy được ảnh khay in');

  // Mọi tham số phải đi vào cấu hình của file 3MF, kể cả khoá tự nhập trong extra.
  const zip = openZip(library.filePath(library.getFileRecord(sliced.file.id)));
  const applied = JSON.parse(zip.read('Metadata/project_settings.config').toString('utf8'));
  zip.close();
  assert.equal(applied.seam_position, 'back');
  assert.equal(applied.wall_loops, '3');
  assert.equal(applied.sparse_infill_pattern, 'gyroid');
  assert.deepEqual(applied.outer_wall_speed, ['120']);
  assert.deepEqual(applied.nozzle_temperature, ['225']);
  assert.equal(applied.brim_type, 'outer_only');
  // Cờ bool phải gửi dạng --key=value, tách rời sẽ bị slicer hiểu là tên file đầu vào.
  assert.equal(applied.detect_thin_wall, '1');
  assert.equal(applied.infill_combination, '0');
  assert.equal(applied.top_surface_pattern, 'monotonicline');
  assert.equal(applied.top_surface_density, '95%');
  assert.equal(applied.infill_wall_overlap, '25%');
  assert.equal(applied.sparse_infill_anchor, '400%');
  assert.equal(applied.fill_multiline, '3');
  assert.equal(applied.ensure_vertical_shell_thickness, 'disabled');
  assert.equal(applied.ironing_speed, '20');

  // Mở lại để cắt tiếp thì form phải nhận đúng những ô đã đổi so với profile, không kéo theo cả bộ profile.
  const readBack = slicer.readSliceSettings(sliced.file.id);
  assert.equal(readBack.machine, machine);
  assert.equal(readBack.options.layerHeight, 0.28);
  assert.equal(readBack.options.seam, 'back');
  assert.equal(readBack.options.wallLoops, 3);
  assert.equal(readBack.options.infillPattern, 'gyroid');
  assert.equal(readBack.options.nozzleTemp, 225);
  assert.equal(readBack.options.brim, 'outer_only');
  assert.equal(readBack.options.topLayers, undefined, 'ô không đổi thì phải để trống, để còn theo profile');
  assert.equal(readBack.extra.ironing_speed, '20');
  assert.equal(readBack.extra.name, undefined, 'khoá slicer tự ghi không phải thiết lập của người dùng');
  // Không nói gì thì agent phải tự chọn mặt bàn, để trống là slicer lấy "Cool Plate" rồi bỏ ngang với nhiều loại nhựa.
  assert.ok(sliced.plate, 'phải chọn được mặt bàn');
  assert.equal(applied.curr_bed_type, sliced.plate);

  // PETG không in được trên Cool Plate: chọn bừa thì phải báo lỗi rõ ràng, còn để agent tự chọn thì phải cắt lát được.
  const petg = detail.filaments.find((item) => item.filamentType === 'PETG');
  if (petg) {
    const onPetg = await slicer.sliceModel({ fileId: model.id, printerId: bambu.id, machine, filament: petg.name, bedTemp: 82, nozzleTemp: 241 });
    assert.notEqual(onPetg.plate, 'Cool Plate');
    const petgZip = openZip(library.filePath(library.getFileRecord(onPetg.file.id)));
    const petgConfig = JSON.parse(petgZip.read('Metadata/project_settings.config').toString('utf8'));
    petgZip.close();
    assert.equal(petgConfig.curr_bed_type, onPetg.plate);
    // Nhiệt độ bàn phải rơi đúng vào ô của mặt bàn đang dùng, ghi nhầm ô thì slicer không đọc tới.
    const plateKey = { 'Textured PEI Plate': 'textured_plate_temp', 'High Temp Plate': 'hot_plate_temp', 'Engineering Plate': 'eng_plate_temp', 'Supertack Plate': 'supertack_plate_temp' }[onPetg.plate];
    assert.deepEqual(petgConfig[`${plateKey}_initial_layer`], ['82']);
    // Đặt nhiệt vòi phun mà lớp đầu vẫn nung theo profile thì máy in lớp đầu sai nhiệt người dùng chọn.
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
  // Lớp dày hơn vòi phun thì slicer chỉ kêu "thông số sai", phải chặn trước và nói rõ vướng ở đâu.
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

test('Profile máy khai G-code khởi động ở file riêng qua include thì vẫn phải gộp vào', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'p3d-include-'));
  const bin = path.join(root, 'fake-slicer');
  writeFileSync(bin, '');
  const write = (file, data) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data));
  };
  const system = path.join(root, 'profiles');
  // Máy Bambu đời mới tách đoạn G-code dài và cả kích thước bàn ra file template rồi khai trong include.
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
    'thiết lập nằm trong file include phải gộp được, nếu không slicer chạy bằng bản mặc định của nó',
  );

  updateConfig({ slicer: { binPath: null, profilesDir: null, userProfilesDir: null } });
});

test('Preset tự lưu trong Bambu Studio cũng hiện ra và thừa kế được profile của hãng', () => {
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
  // Preset tự lưu chỉ ghi khoá đã đổi, không có compatible_printers lẫn filament_type.
  const mine = path.join(root, 'user');
  write(path.join(mine, '42', 'filament', 'petg-230.json'), {
    type: 'filament', from: 'User', name: 'PETG goc - 230C', inherits: 'PETG goc', nozzle_temperature: ['230'],
  });

  updateConfig({ slicer: { binPath: bin, profilesDir: system, userProfilesDir: mine } });
  const list = slicer.listProfiles({ machine: 'May Thu 0.4 nozzle' });
  assert.ok(list.vendors.includes('User'), 'phải có nhóm preset tự lưu');
  const found = list.filaments.find((item) => item.name === 'PETG goc - 230C');
  assert.ok(found, `preset tự lưu phải hiện ra, đang có: ${list.filaments.map((item) => item.name).join(', ')}`);
  assert.equal(found.vendor, 'User');
  assert.equal(found.filamentType, 'PETG', 'loại nhựa phải lần ngược lên profile cha');

  updateConfig({ slicer: { binPath: null, profilesDir: null, userProfilesDir: null } });
});

test('Preset tự lưu lần ngược lên profile gốc phải lấy đúng của hãng máy, không lấy nhầm hãng khác trùng tên', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'p3d-vendor-'));
  const bin = path.join(root, 'fake-slicer');
  writeFileSync(bin, '');
  const write = (file, data) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data));
  };
  const system = path.join(root, 'profiles');
  // Mười hai hãng trong BambuStudio cùng đặt tên profile gốc là `fdm_filament_pet`, mỗi hãng một số khác nhau.
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
    'preset tự lưu phải lần lên profile gốc của chính hãng máy đó, lấy nhầm hãng khác là sai nhiệt độ và sai cả G-code',
  );

  updateConfig({ slicer: { binPath: null, profilesDir: null, userProfilesDir: null } });
});
