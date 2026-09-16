import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'p3d-advisor-'));
process.env.PRINTAGENT3D_DATA_DIR = dataDir;
process.env.PRINTAGENT3D_LOG_LEVEL = 'error';

const { updateConfig } = await import('../src/core/config.js');
const library = await import('../src/core/library.js');
const printers = await import('../src/core/printers.js');
const slicer = await import('../src/core/slicer.js');
const advisor = await import('../src/core/advisor.js');
const prompts = await import('../src/core/prompts.js');

library.loadLibrary();
printers.loadPrinters();

test('Prompt hệ thống đọc từ file .md, sửa lại được và bỏ sửa thì về bản mặc định', (t) => {
  const builtin = prompts.defaultPrompt('chat');
  assert.match(builtin, /kỹ thuật viên in 3D FDM/);
  for (const name of prompts.PROMPTS) assert.ok(prompts.systemPrompt(name).length > 0, `thiếu prompt ${name}`);
  assert.deepEqual(prompts.listPrompts().map((item) => item.name), prompts.PROMPTS);
  assert.equal(prompts.listPrompts().every((item) => item.custom === false), true);
  assert.throws(() => prompts.systemPrompt('../secrets'), { key: 'error.prompt_not_found' });
  assert.throws(() => prompts.systemPrompt('suggest'), { key: 'error.prompt_not_found' }, 'prompt gợi ý một lần đã bỏ');
  t.after(() => rmSync(prompts.promptsDir(), { recursive: true, force: true }));

  const saved = prompts.savePrompt('chat', '# Của tôi\n\nChỉ đổi mỗi chiều cao lớp.');
  assert.equal(saved.custom, true);
  assert.equal(saved.default, builtin);
  assert.equal(prompts.systemPrompt('chat'), '# Của tôi\n\nChỉ đổi mỗi chiều cao lớp.', 'sửa xong là dùng được ngay');

  writeFileSync(path.join(prompts.promptsDir(), 'chat.md'), '   \n');
  assert.equal(prompts.systemPrompt('chat'), builtin, 'file rỗng thì vẫn dùng bản mặc định');

  assert.throws(() => prompts.savePrompt('chat', 'x'.repeat(20001)), { key: 'error.prompt_too_long' });
  assert.equal(prompts.savePrompt('chat', `${builtin}\n`).custom, false, 'lưu đúng bản mặc định thì coi như không sửa');

  prompts.savePrompt('diagnose', 'Chỉ nói một câu.');
  assert.equal(prompts.resetPrompt('diagnose').custom, false);
  assert.equal(prompts.systemPrompt('diagnose'), prompts.defaultPrompt('diagnose'));
});

/** Khối hộp 20x30x40 kín, pháp tuyến hướng ra ngoài. */
function boxStl() {
  const [x0, y0, z0, x1, y1, z1] = [0, 0, 0, 20, 30, 40];
  const A = [x0, y0, z0], B = [x1, y0, z0], C = [x1, y1, z0], D = [x0, y1, z0];
  const E = [x0, y0, z1], F = [x1, y0, z1], G = [x1, y1, z1], H = [x0, y1, z1];
  const faces = [[A, C, B], [A, D, C], [E, F, G], [E, G, H], [A, B, F], [A, F, E], [D, H, G], [D, G, C], [A, E, H], [A, H, D], [B, C, G], [B, G, F]];
  const buffer = Buffer.alloc(84 + faces.length * 50);
  buffer.writeUInt32LE(faces.length, 80);
  faces.forEach((face, index) => {
    let offset = 84 + index * 50 + 12;
    for (const point of face) {
      for (const value of point) {
        buffer.writeFloatLE(value, offset);
        offset += 4;
      }
    }
  });
  return buffer;
}

/** Đóng vai API của nhà cung cấp để không gọi ra mạng ngoài trong test. */
function fakeProvider(handler) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const reply = handler(JSON.parse(body), req);
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('Chưa có khoá API thì không gọi ra ngoài, báo lỗi cấu hình', async () => {
  updateConfig({ ai: { apiKey: null } });
  await assert.rejects(advisor.chatSlice({ fileId: 'fil_x', printerId: 'prn_x', machine: 'x', message: 'x' }), {
    key: 'error.ai_not_configured',
  });
  assert.equal(advisor.advisorStatus().available, false);
});

test('Mọi tham số gửi cho model đều kèm mô tả, kiểu và khoảng giá trị', () => {
  const properties = advisor.optionSchema();
  const specs = slicer.optionSpecs();
  assert.equal(Object.keys(properties).length, specs.length, 'schema phải phủ hết tham số cắt lát');
  for (const spec of specs) {
    const property = properties[spec.key];
    assert.ok(property.description, `thiếu mô tả cho ${spec.key}`);
    if (spec.type === 'flag') assert.equal(property.type, 'boolean');
    else if (spec.type === 'enum') assert.deepEqual(property.enum, spec.values);
    else assert.deepEqual([property.minimum, property.maximum], [spec.min, spec.max]);
  }
});

test('Chat gửi đúng bảng dữ liệu, lọc tham số theo khoảng cho phép và bỏ tham số lạ', async (t) => {
  updateConfig({ slicer: { binPath: null, profilesDir: null } });
  if (!slicer.slicerStatus().available) {
    t.skip('Máy này chưa cài OrcaSlicer hoặc BambuStudio');
    return;
  }

  const stl = path.join(dataDir, 'box.stl');
  writeFileSync(stl, boxStl());
  const model = library.addFromPath(stl, 'box.stl', { copy: true });
  assert.deepEqual(model.meta.size, { x: 20, y: 30, z: 40 });
  assert.equal(model.meta.volumeCm3, 24);
  assert.equal(model.meta.overhangRatio, 0, 'mặt đáy nằm trên bàn không tính là mặt dốc');

  const printer = printers.addPrinter({
    name: 'Bambu advisor test',
    driver: 'bambu',
    enabled: false,
    connection: { host: '127.0.0.1', accessCode: '12345678', serial: '26A00000000', model: 'A2L' },
  });
  const profiles = slicer.listProfiles({ printerId: printer.id });
  const machine = profiles.suggestedMachines.find((name) => name.includes('0.4')) ?? profiles.machines[0].name;

  const slicechat = await import('../src/core/slicechat.js');
  let seen = null;
  let headers = null;
  let reply = null;
  const { server, url } = await fakeProvider((body, req) => {
    headers = req.headers;
    // Lượt gửi kết quả công cụ thì chốt bằng chữ, còn lượt đầu thì đổi thông số.
    const followUp = Array.isArray(body.messages.at(-1).content);
    if (!followUp) seen = body;
    const change = reply ?? {
      options: { wallLoops: 99, infill: 40, infillPattern: 'gyroid', seam: 'khong-ton-tai', nozzleTemp: '230', khoa_la: 1 },
      reason: 'Chi tiết chịu lực nên tăng thành và đổ đầy.',
    };
    return {
      status: 200,
      body: {
        model: 'claude-sonnet-5',
        content: followUp ? [{ type: 'text', text: 'Xong.' }] : [{ type: 'tool_use', id: 'toolu_s', name: 'update_slice_settings', input: change }],
      },
    };
  });
  t.after(() => server.close());
  slicechat.forgetFile(model.id);

  updateConfig({ ai: { authType: 'api_key', apiKey: 'sk-test', baseUrl: url, model: 'claude-sonnet-5' } });
  assert.equal(advisor.advisorStatus().available, true);

  const result = await advisor.chatSlice({ fileId: model.id, printerId: printer.id, machine, message: 'giá đỡ màn hình, cần chắc' });
  const answered = result.messages[1];
  assert.deepEqual(answered.suggestion.options, { wallLoops: 10, infill: 40, infillPattern: 'gyroid', nozzleTemp: 230 });
  assert.deepEqual(result.version.options, { wallLoops: 10, infill: 40, infillPattern: 'gyroid', nozzleTemp: 230 });
  assert.equal(answered.suggestion.reason, 'Chi tiết chịu lực nên tăng thành và đổ đầy.');
  const profileTemp = answered.suggestion.before.nozzleTemp;
  assert.ok(Number(profileTemp) > 0, 'phải kèm nhiệt độ profile đang đặt để so sánh');

  const prompt = seen.messages.at(-1).content;
  assert.match(prompt, /Giá trị các tham số sẽ dùng khi cắt lát/);
  assert.doesNotMatch(prompt, /người dùng đã chỉnh|thêm tay|Bản cắt lát gần nhất/, 'không chỉnh gì thì không được ghi chú');
  assert.match(prompt, new RegExp(`- nozzleTemp = ${profileTemp}`));
  assert.match(prompt, /20 x 30 x 40 mm/);
  assert.match(prompt, /24 cm3/);
  assert.match(prompt, /giá đỡ màn hình, cần chắc/);
  assert.ok(seen.tools[0].input_schema.properties.options.properties.wallLoops, 'schema phải liệt kê tham số cắt lát');
  assert.equal(headers['x-api-key'], 'sk-test');
  assert.equal(headers.authorization, undefined);

  reply = { options: { nozzleTemp: profileTemp, infill: 40 }, reason: 'Giữ nguyên nhiệt.' };
  const echoed = await advisor.chatSlice({ fileId: model.id, printerId: printer.id, machine, message: 'đổ đầy 40' });
  assert.equal(echoed.messages[1].suggestion.options.nozzleTemp, undefined, 'đặt lại đúng giá trị profile đang có thì không tính là thay đổi');
  assert.equal(echoed.messages[1].suggestion.options.infill, 40);

  // Người dùng chỉnh tay trên form rồi mới hỏi: mô hình phải thấy số đã chỉnh, không phải số của profile.
  reply = { options: { wallLoops: 3 }, reason: 'Giữ nguyên.' };
  const edited = await advisor.chatSlice({
    fileId: model.id,
    printerId: printer.id,
    machine,
    message: 'thế được chưa',
    options: { wallLoops: 3, nozzleTemp: 245, extra: { top_shell_thickness: '1.2', 'bad key!': 'x', seam_gap: 'rm -rf $HOME' } },
    sliceId: 'fil_khong_ton_tai',
  });
  assert.equal(edited.version, null, 'đặt trùng thứ người dùng vừa chỉnh thì không lưu phiên bản mới');
  assert.equal(edited.messages[1].suggestion, null);
  const editedPrompt = seen.messages.at(-1).content;
  assert.match(editedPrompt, new RegExp(`- nozzleTemp = 245 \\(người dùng đã chỉnh, profile đặt ${profileTemp}\\)`));
  assert.match(editedPrompt, /- top_shell_thickness = 1\.2/);
  assert.doesNotMatch(editedPrompt, /bad key|rm -rf/, 'tham số thêm tay sai luật thì bỏ, không đưa vào prompt');
  assert.doesNotMatch(editedPrompt, /Bản cắt lát gần nhất/, 'bản cắt lát không tồn tại thì bỏ qua');
  reply = null;

  updateConfig({ ai: { authType: 'auth_token' } });
  await advisor.chatSlice({ fileId: model.id, printerId: printer.id, machine, message: 'thử lại' });
  assert.equal(headers.authorization, 'Bearer sk-test', 'kiểu auth_token phải gửi qua Authorization');
  assert.equal(headers['x-api-key'], undefined);

  slicechat.forgetFile(model.id);
  await printers.stopAll();
});

test('Chat cắt lát: agent dùng công cụ nhiều vòng, tự lưu phiên bản và gửi lại lịch sử cho model', async (t) => {
  if (!slicer.slicerStatus().available) {
    t.skip('Máy này chưa cài OrcaSlicer hoặc BambuStudio');
    return;
  }
  const slicechat = await import('../src/core/slicechat.js');
  const seen = [];
  let replies = [];
  const { server, url } = await fakeProvider((body) => {
    seen.push(body);
    return { status: 200, body: { model: 'claude-sonnet-5', content: replies.shift() ?? [{ type: 'text', text: 'Hết kịch bản.' }] } };
  });
  t.after(() => server.close());
  updateConfig({ ai: { authType: 'api_key', apiKey: 'sk-test', baseUrl: url, model: 'claude-sonnet-5' } });

  const model = library.listFiles({ format: 'model' })[0];
  const printer = printers.listPrinters()[0];
  const machine = slicer.listProfiles({ printerId: printer.id }).suggestedMachines[0];
  slicechat.forgetFile(model.id);
  const toolResult = (body) => body.messages.at(-1).content[0];

  await assert.rejects(advisor.chatSlice({ fileId: model.id, printerId: printer.id, machine, message: '   ' }), { key: 'error.field_required' });

  replies = [
    [
      { type: 'text', text: 'Mặt trên rỗ thường do thiếu lớp đặc.' },
      { type: 'tool_use', id: 'toolu_1', name: 'read_profile_settings', input: { search: 'top_shell' } },
    ],
    [
      {
        type: 'tool_use',
        id: 'toolu_2',
        name: 'update_slice_settings',
        input: { options: { topLayers: 11, khoa_la: 1 }, extra: { seam_gap: '10%', top_shell_layers: '9' }, reason: 'Thêm lớp mặt trên.' },
      },
    ],
    [{ type: 'text', text: 'Đã tăng số lớp mặt trên.' }],
  ];
  const first = await advisor.chatSlice({ fileId: model.id, printerId: printer.id, machine, message: 'Mặt trên bị rỗ' });
  assert.equal(seen.length, 3, 'mỗi lần có công cụ thì phải gọi lại model với kết quả');
  assert.equal(seen[0].tool_choice.type, 'auto');
  assert.equal(seen[0].messages.length, 1);
  assert.match(seen[0].messages[0].content, /Tin nhắn mới của người dùng: Mặt trên bị rỗ/);
  const lookup = toolResult(seen[1]);
  assert.equal(lookup.type, 'tool_result');
  assert.equal(lookup.is_error, undefined);
  assert.ok('top_shell_layers' in JSON.parse(lookup.content).values, 'tra profile phải ra đúng khoá gốc');
  assert.deepEqual(JSON.parse(toolResult(seen[2]).content).ignored, ['khoa_la', 'top_shell_layers'], 'khoá lạ và khoá đã có ô riêng phải bị bỏ và báo lại');

  const [asked, answered] = first.messages;
  assert.equal(asked.role, 'user');
  assert.equal(answered.text, 'Mặt trên rỗ thường do thiếu lớp đặc.\n\nĐã tăng số lớp mặt trên.');
  assert.deepEqual(answered.suggestion.options, { topLayers: 11 });
  assert.deepEqual(answered.suggestion.extra, { seam_gap: '10%' });
  assert.ok(answered.suggestion.before.topLayers !== undefined, 'phải kèm giá trị trước khi đổi để giao diện hiện so sánh');
  assert.deepEqual(answered.actions.map((item) => item.tool), ['read_profile_settings', 'update_slice_settings']);
  assert.equal(first.version.number, 1, 'đổi thông số thì phải tự lưu phiên bản');
  assert.equal(first.version.source, 'ai');
  assert.deepEqual(first.version.options, { topLayers: 11 });
  assert.deepEqual(first.version.extra, { seam_gap: '10%' });
  assert.equal(answered.appliedVersion.number, 1);
  assert.throws(() => slicechat.addVersion(model.id, { messageId: 'msg_la' }), { key: 'error.field_invalid' });

  seen.length = 0;
  replies = [[{ type: 'tool_use', id: 'toolu_3', name: 'restore_version', input: { number: 99 } }], [{ type: 'text', text: 'Không có phiên bản đó.' }]];
  const second = await advisor.chatSlice({
    fileId: model.id,
    printerId: printer.id,
    machine,
    message: 'Quay về v99',
    options: { topLayers: 11, extra: { seam_gap: '10%' } },
  });
  assert.equal(second.version, null, 'không đổi gì thì không lưu thêm phiên bản');
  assert.equal(toolResult(seen[1]).is_error, true, 'công cụ lỗi phải báo lại cho model tự sửa');
  assert.deepEqual(seen[0].messages.map((item) => item.role), ['user', 'assistant', 'user'], 'phải gửi kèm lượt hỏi đáp trước');
  assert.equal(seen[0].messages[0].content, 'Mặt trên bị rỗ');
  assert.match(seen[0].messages[1].content, /phiên bản v1\): topLayers = 11, seam_gap = 10%/);

  const chat = slicechat.getChat(model.id);
  assert.equal(chat.messages.length, 4);
  assert.equal(chat.messages[1].appliedVersion.number, 1);
  assert.equal(chat.versions.length, 1);

  slicechat.clearMessages(model.id);
  assert.equal(slicechat.getChat(model.id).messages.length, 0);
  assert.equal(slicechat.getChat(model.id).versions.length, 1, 'xoá chat vẫn giữ phiên bản');
  slicechat.forgetFile(model.id);
  assert.equal(slicechat.getChat(model.id).versions.length, 0);
  await printers.stopAll();
});

test('Preset cắt lát: dùng chung, trùng tên thì ghi đè, agent áp và lưu được preset', async (t) => {
  if (!slicer.slicerStatus().available) {
    t.skip('Máy này chưa cài OrcaSlicer hoặc BambuStudio');
    return;
  }
  const slicechat = await import('../src/core/slicechat.js');
  let replies = [];
  const { server, url } = await fakeProvider(() => ({
    status: 200,
    body: { model: 'claude-sonnet-5', content: replies.shift() ?? [{ type: 'text', text: 'Xong.' }] },
  }));
  t.after(() => server.close());
  updateConfig({ ai: { authType: 'api_key', apiKey: 'sk-test', baseUrl: url, model: 'claude-sonnet-5' } });

  const model = library.listFiles({ format: 'model' })[0];
  const printer = printers.listPrinters()[0];
  const machine = slicer.listProfiles({ printerId: printer.id }).suggestedMachines[0];
  slicechat.forgetFile(model.id);
  for (const preset of slicechat.listPresets()) slicechat.deletePreset(preset.id);

  assert.throws(() => slicechat.savePreset({ name: '  ' }), { key: 'error.field_required' });
  const saved = slicechat.savePreset({ name: 'Chịu lực', machine, options: { wallLoops: 5, copies: 3, khoa_la: 1 }, extra: { seam_gap: '5%' } });
  assert.deepEqual(saved.options, { wallLoops: 5 }, 'preset không mang theo thao tác một lần như số bản');
  const again = slicechat.savePreset({ name: 'chịu lực', options: { wallLoops: 6 } });
  assert.equal(again.id, saved.id, 'trùng tên khác hoa thường vẫn là ghi đè');
  assert.equal(slicechat.listPresets().length, 1);

  replies = [
    [{ type: 'tool_use', id: 'toolu_p1', name: 'apply_preset', input: { name: 'Chịu lực' } }],
    [
      { type: 'tool_use', id: 'toolu_p2', name: 'update_slice_settings', input: { options: { infill: 35 }, reason: 'Tăng đổ đầy.' } },
      { type: 'tool_use', id: 'toolu_p3', name: 'save_preset', input: { name: 'Chịu lực 35', description: 'Thành dày, đổ đầy 35%' } },
    ],
    [{ type: 'text', text: 'Đã áp preset và lưu bản mới.' }],
  ];
  const result = await advisor.chatSlice({
    fileId: model.id,
    printerId: printer.id,
    machine,
    message: 'Dùng preset chịu lực, tăng đổ đầy rồi lưu lại',
    options: { scale: 2 },
  });
  assert.deepEqual(result.messages[1].actions.map((item) => item.tool), ['apply_preset', 'update_slice_settings', 'save_preset']);
  assert.deepEqual(result.version.options, { scale: 2, wallLoops: 6, infill: 35 }, 'áp preset vẫn giữ tỉ lệ người dùng đang đặt');
  const stored = slicechat.findPreset('Chịu lực 35');
  assert.deepEqual(stored.options, { wallLoops: 6, infill: 35 });
  assert.equal(stored.description, 'Thành dày, đổ đầy 35%');
  assert.equal(slicechat.getChat(model.id).presets.length, 2);

  slicechat.deletePreset(stored.id);
  assert.throws(() => slicechat.deletePreset(stored.id), { key: 'error.not_found' });
  for (const preset of slicechat.listPresets()) slicechat.deletePreset(preset.id);
  slicechat.forgetFile(model.id);
  await printers.stopAll();
});

test('Nhà cung cấp trả lỗi thì báo lại nguyên văn, không làm sập agent', async (t) => {
  const { server, url } = await fakeProvider(() => ({ status: 401, body: { error: { message: 'invalid x-api-key' } } }));
  t.after(() => server.close());
  updateConfig({ ai: { apiKey: 'sk-sai', baseUrl: url } });

  const files = library.listFiles({ format: 'model' });
  if (files.length === 0 || !slicer.slicerStatus().available) {
    t.skip('Cần slicer và mô hình từ test trước');
    return;
  }
  const printer = printers.listPrinters()[0];
  const machine = slicer.listProfiles({ printerId: printer.id }).suggestedMachines[0];
  await assert.rejects(advisor.chatSlice({ fileId: files[0].id, printerId: printer.id, machine, message: 'x' }), {
    key: 'error.ai_failed',
    params: { message: 'invalid x-api-key' },
  });
  await printers.stopAll();
});

test('Chẩn đoán máy in: gói lại kết quả, cắt bớt danh sách dài và chặn mức độ lạ', async (t) => {
  let seen = null;
  const { server, url } = await fakeProvider((body) => {
    seen = body;
    return {
      status: 200,
      body: {
        model: 'claude-sonnet-5',
        content: [
          {
            type: 'tool_use',
            name: 'diagnose_printer',
            input: {
              summary: 'Dây đai trục Y có thể bị lỏng.',
              causes: Array.from({ length: 20 }, (_, index) => `nguyên nhân ${index}`),
              steps: ['Tắt nguồn rồi kiểm tra dây đai.', ''],
              severity: 'tan-the',
            },
          },
        ],
      },
    };
  });
  t.after(() => server.close());
  updateConfig({ ai: { authType: 'api_key', apiKey: 'sk-test', baseUrl: url, model: 'claude-sonnet-5' } });

  const printer = printers.addPrinter({
    name: 'Máy chẩn đoán',
    driver: 'bambu',
    enabled: false,
    connection: { host: '127.0.0.1', accessCode: '12345678', serial: '26A00000001', model: 'A2L' },
  });

  const result = await advisor.diagnose({ printerId: printer.id, note: 'in được nửa chừng thì dừng' });
  assert.equal(result.printerId, printer.id);
  assert.equal(result.causes.length, 8, 'danh sách dài phải bị cắt bớt');
  assert.deepEqual(result.steps, ['Tắt nguồn rồi kiểm tra dây đai.'], 'bước rỗng bị loại');
  assert.equal(result.severity, 'warning', 'mức độ lạ rơi về warning');

  const prompt = seen.messages[0].content;
  assert.match(prompt, /Máy chẩn đoán/);
  assert.match(prompt, /Máy không báo mã HMS nào/);
  assert.match(prompt, /in được nửa chừng thì dừng/);
  assert.equal(seen.tool_choice.name, 'diagnose_printer');

  await printers.stopAll();
});
