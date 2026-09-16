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

test('System prompts load from .md files, can be edited and fall back to the default when reset', (t) => {
  const builtin = prompts.defaultPrompt('chat');
  assert.match(builtin, /experienced FDM 3D printing technician/);
  for (const name of prompts.PROMPTS) assert.ok(prompts.systemPrompt(name).length > 0, `missing prompt ${name}`);
  assert.deepEqual(prompts.listPrompts().map((item) => item.name), prompts.PROMPTS);
  assert.equal(prompts.listPrompts().every((item) => item.custom === false), true);
  assert.throws(() => prompts.systemPrompt('../secrets'), { key: 'error.prompt_not_found' });
  assert.throws(() => prompts.systemPrompt('suggest'), { key: 'error.prompt_not_found' }, 'the one-off suggest prompt was removed');
  t.after(() => rmSync(prompts.promptsDir(), { recursive: true, force: true }));

  const saved = prompts.savePrompt('chat', '# Mine\n\nOnly change the layer height.');
  assert.equal(saved.custom, true);
  assert.equal(saved.default, builtin);
  assert.equal(prompts.systemPrompt('chat'), '# Mine\n\nOnly change the layer height.', 'an edit takes effect right away');

  writeFileSync(path.join(prompts.promptsDir(), 'chat.md'), '   \n');
  assert.equal(prompts.systemPrompt('chat'), builtin, 'an empty file still falls back to the default');

  assert.throws(() => prompts.savePrompt('chat', 'x'.repeat(20001)), { key: 'error.prompt_too_long' });
  assert.equal(prompts.savePrompt('chat', `${builtin}\n`).custom, false, 'saving the exact default counts as unedited');

  prompts.savePrompt('diagnose', 'Say one sentence only.');
  assert.equal(prompts.resetPrompt('diagnose').custom, false);
  assert.equal(prompts.systemPrompt('diagnose'), prompts.defaultPrompt('diagnose'));
});

/** A closed 20x30x40 box with outward facing normals. */
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

/** Stands in for the provider API so tests never reach the outside network. */
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

test('Without an API key nothing is called out, a configuration error is raised', async () => {
  updateConfig({ ai: { apiKey: null } });
  await assert.rejects(advisor.chatSlice({ fileId: 'fil_x', printerId: 'prn_x', machine: 'x', message: 'x' }), {
    key: 'error.ai_not_configured',
  });
  assert.equal(advisor.advisorStatus().available, false);
});

test('Every setting sent to the model carries a description, a type and a value range', () => {
  const properties = advisor.optionSchema();
  const specs = slicer.optionSpecs();
  assert.equal(Object.keys(properties).length, specs.length, 'the schema must cover every slicing setting');
  for (const spec of specs) {
    const property = properties[spec.key];
    assert.ok(property.description, `missing description for ${spec.key}`);
    if (spec.type === 'flag') assert.equal(property.type, 'boolean');
    else if (spec.type === 'enum') assert.deepEqual(property.enum, spec.values);
    else assert.deepEqual([property.minimum, property.maximum], [spec.min, spec.max]);
  }
});

test('Chat sends the right data table, clamps settings to their allowed range and drops unknown ones', async (t) => {
  updateConfig({ slicer: { binPath: null, profilesDir: null } });
  if (!slicer.slicerStatus().available) {
    t.skip('OrcaSlicer or BambuStudio is not installed on this machine');
    return;
  }

  const stl = path.join(dataDir, 'box.stl');
  writeFileSync(stl, boxStl());
  const model = library.addFromPath(stl, 'box.stl', { copy: true });
  assert.deepEqual(model.meta.size, { x: 20, y: 30, z: 40 });
  assert.equal(model.meta.volumeCm3, 24);
  assert.equal(model.meta.overhangRatio, 0, 'the bottom face resting on the plate does not count as a steep face');

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
    // The turn carrying tool results wraps up in text, the first turn changes settings.
    const followUp = Array.isArray(body.messages.at(-1).content);
    if (!followUp) seen = body;
    const change = reply ?? {
      options: { wallLoops: 99, infill: 40, infillPattern: 'gyroid', seam: 'not-a-real-value', nozzleTemp: '230', unknown_key: 1 },
      reason: 'A load bearing part, so raise the walls and infill.',
    };
    return {
      status: 200,
      body: {
        model: 'claude-sonnet-5',
        content: followUp ? [{ type: 'text', text: 'Done.' }] : [{ type: 'tool_use', id: 'toolu_s', name: 'update_slice_settings', input: change }],
      },
    };
  });
  t.after(() => server.close());
  slicechat.forgetFile(model.id);

  updateConfig({ ai: { authType: 'api_key', apiKey: 'sk-test', baseUrl: url, model: 'claude-sonnet-5' } });
  assert.equal(advisor.advisorStatus().available, true);

  const result = await advisor.chatSlice({ fileId: model.id, printerId: printer.id, machine, message: 'a monitor stand, it has to be strong' });
  const answered = result.messages[1];
  assert.deepEqual(answered.suggestion.options, { wallLoops: 10, infill: 40, infillPattern: 'gyroid', nozzleTemp: 230 });
  assert.deepEqual(result.version.options, { wallLoops: 10, infill: 40, infillPattern: 'gyroid', nozzleTemp: 230 });
  assert.equal(answered.suggestion.reason, 'A load bearing part, so raise the walls and infill.');
  const profileTemp = answered.suggestion.before.nozzleTemp;
  assert.ok(Number(profileTemp) > 0, 'the profile temperature must come along for comparison');

  const prompt = seen.messages.at(-1).content;
  assert.match(prompt, /Values that will be used when slicing/);
  assert.doesNotMatch(prompt, /edited by the user|added by hand|Most recent slice/, 'nothing edited means no annotation');
  assert.match(prompt, new RegExp(`- nozzleTemp = ${profileTemp}`));
  assert.match(prompt, /20 x 30 x 40 mm/);
  assert.match(prompt, /24 cm3/);
  assert.match(prompt, /a monitor stand, it has to be strong/);
  assert.ok(seen.tools[0].input_schema.properties.options.properties.wallLoops, 'the schema must list the slicing settings');
  assert.equal(headers['x-api-key'], 'sk-test');
  assert.equal(headers.authorization, undefined);

  reply = { options: { nozzleTemp: profileTemp, infill: 40 }, reason: 'Keep the temperature as it is.' };
  const echoed = await advisor.chatSlice({ fileId: model.id, printerId: printer.id, machine, message: 'infill 40' });
  assert.equal(echoed.messages[1].suggestion.options.nozzleTemp, undefined, 'setting a value back to what the profile already has does not count as a change');
  assert.equal(echoed.messages[1].suggestion.options.infill, 40);

  // The user edits the form by hand before asking: the model must see the edited number, not the profile one.
  reply = { options: { wallLoops: 3 }, reason: 'Leave it as it is.' };
  const edited = await advisor.chatSlice({
    fileId: model.id,
    printerId: printer.id,
    machine,
    message: 'is that good now',
    options: { wallLoops: 3, nozzleTemp: 245, extra: { top_shell_thickness: '1.2', 'bad key!': 'x', seam_gap: 'rm -rf $HOME' } },
    sliceId: 'fil_does_not_exist',
  });
  assert.equal(edited.version, null, 'setting exactly what the user just edited saves no new version');
  assert.equal(edited.messages[1].suggestion, null);
  const editedPrompt = seen.messages.at(-1).content;
  assert.match(editedPrompt, new RegExp(`- nozzleTemp = 245 \\(edited by the user, profile sets ${profileTemp}\\)`));
  assert.match(editedPrompt, /- top_shell_thickness = 1\.2/);
  assert.doesNotMatch(editedPrompt, /bad key|rm -rf/, 'hand-added settings that break the rules are dropped, never put in the prompt');
  assert.doesNotMatch(editedPrompt, /Most recent slice/, 'a slice that does not exist is skipped');
  reply = null;

  updateConfig({ ai: { authType: 'auth_token' } });
  await advisor.chatSlice({ fileId: model.id, printerId: printer.id, machine, message: 'try again' });
  assert.equal(headers.authorization, 'Bearer sk-test', 'the auth_token type must be sent through Authorization');
  assert.equal(headers['x-api-key'], undefined);

  slicechat.forgetFile(model.id);
  await printers.stopAll();
});

test('Slice chat: the agent uses tools over several rounds, saves a version itself and replays the history to the model', async (t) => {
  if (!slicer.slicerStatus().available) {
    t.skip('OrcaSlicer or BambuStudio is not installed on this machine');
    return;
  }
  const slicechat = await import('../src/core/slicechat.js');
  const seen = [];
  let replies = [];
  const { server, url } = await fakeProvider((body) => {
    seen.push(body);
    return { status: 200, body: { model: 'claude-sonnet-5', content: replies.shift() ?? [{ type: 'text', text: 'Out of script.' }] } };
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
      { type: 'text', text: 'A pitted top surface usually means too few solid layers.' },
      { type: 'tool_use', id: 'toolu_1', name: 'read_profile_settings', input: { search: 'top_shell' } },
    ],
    [
      {
        type: 'tool_use',
        id: 'toolu_2',
        name: 'update_slice_settings',
        input: { options: { topLayers: 11, unknown_key: 1 }, extra: { seam_gap: '10%', top_shell_layers: '9' }, reason: 'Add more top layers.' },
      },
    ],
    [{ type: 'text', text: 'Raised the number of top layers.' }],
  ];
  const first = await advisor.chatSlice({ fileId: model.id, printerId: printer.id, machine, message: 'The top surface is pitted' });
  assert.equal(seen.length, 3, 'every tool call means calling the model again with the result');
  assert.equal(seen[0].tool_choice.type, 'auto');
  assert.equal(seen[0].messages.length, 1);
  assert.match(seen[0].messages[0].content, /New user message: The top surface is pitted/);
  const lookup = toolResult(seen[1]);
  assert.equal(lookup.type, 'tool_result');
  assert.equal(lookup.is_error, undefined);
  assert.ok('top_shell_layers' in JSON.parse(lookup.content).values, 'the profile lookup must return the raw key');
  assert.deepEqual(JSON.parse(toolResult(seen[2]).content).ignored, ['unknown_key', 'top_shell_layers'], 'unknown keys and keys with their own field must be dropped and reported back');

  const [asked, answered] = first.messages;
  assert.equal(asked.role, 'user');
  assert.equal(answered.text, 'A pitted top surface usually means too few solid layers.\n\nRaised the number of top layers.');
  assert.deepEqual(answered.suggestion.options, { topLayers: 11 });
  assert.deepEqual(answered.suggestion.extra, { seam_gap: '10%' });
  assert.ok(answered.suggestion.before.topLayers !== undefined, 'the value before the change must come along so the interface can show a comparison');
  assert.deepEqual(answered.actions.map((item) => item.tool), ['read_profile_settings', 'update_slice_settings']);
  assert.equal(first.version.number, 1, 'changing settings must save a version automatically');
  assert.equal(first.version.source, 'ai');
  assert.deepEqual(first.version.options, { topLayers: 11 });
  assert.deepEqual(first.version.extra, { seam_gap: '10%' });
  assert.equal(answered.appliedVersion.number, 1);
  assert.throws(() => slicechat.addVersion(model.id, { messageId: 'msg_unknown' }), { key: 'error.field_invalid' });

  seen.length = 0;
  replies = [[{ type: 'tool_use', id: 'toolu_3', name: 'restore_version', input: { number: 99 } }], [{ type: 'text', text: 'There is no such version.' }]];
  const second = await advisor.chatSlice({
    fileId: model.id,
    printerId: printer.id,
    machine,
    message: 'Go back to v99',
    options: { topLayers: 11, extra: { seam_gap: '10%' } },
  });
  assert.equal(second.version, null, 'nothing changed means no extra version saved');
  assert.equal(toolResult(seen[1]).is_error, true, 'a tool error must be reported back so the model can fix it');
  assert.deepEqual(seen[0].messages.map((item) => item.role), ['user', 'assistant', 'user'], 'the previous exchange must be sent along');
  assert.equal(seen[0].messages[0].content, 'The top surface is pitted');
  assert.match(seen[0].messages[1].content, /version v1\): topLayers = 11, seam_gap = 10%/);

  const chat = slicechat.getChat(model.id);
  assert.equal(chat.messages.length, 4);
  assert.equal(chat.messages[1].appliedVersion.number, 1);
  assert.equal(chat.versions.length, 1);

  slicechat.clearMessages(model.id);
  assert.equal(slicechat.getChat(model.id).messages.length, 0);
  assert.equal(slicechat.getChat(model.id).versions.length, 1, 'clearing the chat keeps the versions');
  slicechat.forgetFile(model.id);
  assert.equal(slicechat.getChat(model.id).versions.length, 0);
  await printers.stopAll();
});

test('Slicing presets: shared, overwritten on a duplicate name, and the agent can apply and save them', async (t) => {
  if (!slicer.slicerStatus().available) {
    t.skip('OrcaSlicer or BambuStudio is not installed on this machine');
    return;
  }
  const slicechat = await import('../src/core/slicechat.js');
  let replies = [];
  const { server, url } = await fakeProvider(() => ({
    status: 200,
    body: { model: 'claude-sonnet-5', content: replies.shift() ?? [{ type: 'text', text: 'Done.' }] },
  }));
  t.after(() => server.close());
  updateConfig({ ai: { authType: 'api_key', apiKey: 'sk-test', baseUrl: url, model: 'claude-sonnet-5' } });

  const model = library.listFiles({ format: 'model' })[0];
  const printer = printers.listPrinters()[0];
  const machine = slicer.listProfiles({ printerId: printer.id }).suggestedMachines[0];
  slicechat.forgetFile(model.id);
  for (const preset of slicechat.listPresets()) slicechat.deletePreset(preset.id);

  assert.throws(() => slicechat.savePreset({ name: '  ' }), { key: 'error.field_required' });
  const saved = slicechat.savePreset({ name: 'Strong', machine, options: { wallLoops: 5, copies: 3, unknown_key: 1 }, extra: { seam_gap: '5%' } });
  assert.deepEqual(saved.options, { wallLoops: 5 }, 'a preset does not carry one-off actions such as the copy count');
  const again = slicechat.savePreset({ name: 'strong', options: { wallLoops: 6 } });
  assert.equal(again.id, saved.id, 'a duplicate name in another case still overwrites');
  assert.equal(slicechat.listPresets().length, 1);

  replies = [
    [{ type: 'tool_use', id: 'toolu_p1', name: 'apply_preset', input: { name: 'Strong' } }],
    [
      { type: 'tool_use', id: 'toolu_p2', name: 'update_slice_settings', input: { options: { infill: 35 }, reason: 'Raise the infill.' } },
      { type: 'tool_use', id: 'toolu_p3', name: 'save_preset', input: { name: 'Strong 35', description: 'Thick walls, 35% infill' } },
    ],
    [{ type: 'text', text: 'Applied the preset and saved a new one.' }],
  ];
  const result = await advisor.chatSlice({
    fileId: model.id,
    printerId: printer.id,
    machine,
    message: 'Use the strong preset, raise the infill and save it',
    options: { scale: 2 },
  });
  assert.deepEqual(result.messages[1].actions.map((item) => item.tool), ['apply_preset', 'update_slice_settings', 'save_preset']);
  assert.deepEqual(result.version.options, { scale: 2, wallLoops: 6, infill: 35 }, 'applying a preset keeps the scale the user set');
  const stored = slicechat.findPreset('Strong 35');
  assert.deepEqual(stored.options, { wallLoops: 6, infill: 35 });
  assert.equal(stored.description, 'Thick walls, 35% infill');
  assert.equal(slicechat.getChat(model.id).presets.length, 2);

  slicechat.deletePreset(stored.id);
  assert.throws(() => slicechat.deletePreset(stored.id), { key: 'error.not_found' });
  for (const preset of slicechat.listPresets()) slicechat.deletePreset(preset.id);
  slicechat.forgetFile(model.id);
  await printers.stopAll();
});

test('A provider error is reported back verbatim without crashing the agent', async (t) => {
  const { server, url } = await fakeProvider(() => ({ status: 401, body: { error: { message: 'invalid x-api-key' } } }));
  t.after(() => server.close());
  updateConfig({ ai: { apiKey: 'sk-wrong', baseUrl: url } });

  const files = library.listFiles({ format: 'model' });
  if (files.length === 0 || !slicer.slicerStatus().available) {
    t.skip('Needs a slicer and the model from the previous test');
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

test('Printer diagnosis: wraps the result, trims long lists and rejects unknown severities', async (t) => {
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
              summary: 'The Y axis belt may be loose.',
              causes: Array.from({ length: 20 }, (_, index) => `cause ${index}`),
              steps: ['Switch the power off and check the belt.', ''],
              severity: 'not-a-real-severity',
            },
          },
        ],
      },
    };
  });
  t.after(() => server.close());
  updateConfig({ ai: { authType: 'api_key', apiKey: 'sk-test', baseUrl: url, model: 'claude-sonnet-5' } });

  const printer = printers.addPrinter({
    name: 'Diagnosis printer',
    driver: 'bambu',
    enabled: false,
    connection: { host: '127.0.0.1', accessCode: '12345678', serial: '26A00000001', model: 'A2L' },
  });

  const result = await advisor.diagnose({ printerId: printer.id, note: 'it stopped partway through the print' });
  assert.equal(result.printerId, printer.id);
  assert.equal(result.causes.length, 8, 'a long list must be trimmed');
  assert.deepEqual(result.steps, ['Switch the power off and check the belt.'], 'empty steps are dropped');
  assert.equal(result.severity, 'warning', 'an unknown severity falls back to warning');

  const prompt = seen.messages[0].content;
  assert.match(prompt, /Diagnosis printer/);
  assert.match(prompt, /The printer reports no HMS code/);
  assert.match(prompt, /it stopped partway through the print/);
  assert.equal(seen.tool_choice.name, 'diagnose_printer');

  await printers.stopAll();
});
