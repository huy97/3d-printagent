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
// Số lượt cũ gửi lại cho mô hình; số chẵn để luôn bắt đầu bằng lượt của người dùng.
const MAX_HISTORY = 20;
const MAX_TOOL_ROUNDS = 8;
const MAX_TURN_SLICES = 2;
// Anthropic nhận ảnh tối đa 5MB sau khi mã hoá base64, chừa sẵn phần phình ra một phần ba.
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** Anthropic nhận khoá API qua x-api-key, còn token phiên (OAuth, cổng trung gian) qua Authorization. */
export const AUTH_TYPES = ['api_key', 'auth_token'];
const AUTH_HEADER = {
  api_key: (value) => ({ 'x-api-key': value }),
  auth_token: (value) => ({ authorization: `Bearer ${value}` }),
};

/** Mô tả kèm đơn vị và ảnh hưởng của từng tham số; model chọn sát hơn hẳn so với khi chỉ thấy tên khoá. */
const OPTION_NOTES = {
  layerHeight: 'Chiều cao lớp, mm. Nhỏ thì mịn và lâu, lớn thì nhanh và thô; không nên vượt quá 75% đường kính vòi phun.',
  firstLayerHeight: 'Chiều cao lớp đầu, mm. Dày hơn lớp thường giúp bám bàn chắc hơn.',
  seam: 'Vị trí điểm nối của mỗi lớp: nearest nhanh nhất, aligned xếp thẳng hàng nên dễ giấu vào một cạnh, back dồn ra mặt sau, random rải đều nhưng làm bề mặt lấm tấm.',
  ironing: 'Là phẳng mặt trên bằng cách rê lại vòi phun: no ironing tắt, top làm mọi mặt hướng lên, topmost chỉ mặt trên cùng, solid phủ kín. Mặt đẹp hơn nhưng lâu hơn nhiều.',
  wallLoops: 'Số vòng thành. Tăng số vòng là cách chịu lực hiệu quả nhất và tốn ít nhựa hơn so với tăng mật độ đổ đầy.',
  topLayers: 'Số lớp đặc ở mặt trên. Ít quá thì mặt trên thủng lỗ chỗ vì không đủ đỡ trên nền đổ đầy.',
  bottomLayers: 'Số lớp đặc ở mặt đáy, quyết định độ kín và độ cứng của đế.',
  infill: 'Mật độ đổ đầy, %. Khoảng 10-15 cho vật trang trí, 25-40 cho chi tiết chịu lực, trên 50 hiếm khi đáng thời gian bỏ ra.',
  infillPattern: 'Kiểu đổ đầy. gyroid và cubic chịu lực đều theo mọi hướng, grid và line nhanh, lightning chỉ dựng cột đỡ mặt trên nên nhẹ và nhanh nhất, honeycomb cứng nhưng chậm.',
  outerWallSpeed: 'Tốc độ thành ngoài, mm/s. Đi chậm lại thì bề mặt nhẵn và sắc nét hơn.',
  innerWallSpeed: 'Tốc độ thành trong, mm/s. Ít ảnh hưởng tới bề mặt nên có thể để nhanh hơn thành ngoài.',
  infillSpeed: 'Tốc độ đổ đầy, mm/s. Đây thường là phần chiếm nhiều thời gian nhất nên tăng lên rút ngắn đáng kể.',
  support: 'Bật hỗ trợ. Chỉ cần khi mô hình có phần lơ lửng hoặc mặt quá dốc, xem tỉ lệ mặt úp xuống nêu ở trên trước khi bật.',
  supportType: 'Kiểu hỗ trợ: normal(auto) chắc, đỡ tốt mặt phẳng rộng; tree(auto) dạng cây tốn ít nhựa và dễ gỡ, hợp mô hình cong hoặc tượng.',
  supportThreshold: 'Ngưỡng sinh hỗ trợ, độ, với 90 là thành thẳng đứng. Mặt nào dốc dưới ngưỡng này mới được đỡ, nên số lớn thì sinh nhiều hỗ trợ hơn.',
  nozzleTemp: 'Nhiệt độ vòi phun, độ C. So giá trị hiện tại với khoảng thường dùng của loại nhựa này (PLA 200-220, PETG 230-250, ABS 240-260, TPU 220-235) và với mục đích in: nằm ngoài khoảng thì đề xuất kéo về, nhất là khi đang cao hơn mức cần vì nhựa chảy nhão, rỉ nhựa và kéo tơ. Trong khoảng rồi thì để yên, trừ khi cần thêm 5-10 độ cho các lớp dính nhau chắc hơn.',
  bedTemp: 'Nhiệt độ bàn in, độ C. So giá trị hiện tại với khoảng thường dùng của loại nhựa này (PLA 55-65, PETG 70-80, ABS 90-100, TPU 40-60): lệch khỏi khoảng thì đề xuất kéo về, vì thấp quá thì bong chân còn cao quá thì bè đế và dính chặt khó gỡ. Nằm trong khoảng rồi thì chỉ đổi khi vật khó bám bàn hoặc bị cong mép.',
  brim: 'Viền bám bàn: auto_brim để slicer tự quyết, no_brim tắt hẳn, outer_only chỉ thêm viền phía ngoài. Cần khi đế tiếp xúc nhỏ hoặc vật dễ cong mép.',
  brimWidth: 'Bề rộng viền bám bàn, mm. Rộng thì bám chắc hơn nhưng mất công gỡ.',
  spiralMode: 'In xoắn ốc, cả vật chỉ là một thành liền mạch. Chỉ dùng cho vật rỗng hở đáy như bình, lọ; bật lên thì thiết lập thành, đổ đầy và mặt trên đều bị bỏ qua.',
  scale: 'Hệ số phóng to thu nhỏ, 1 là giữ nguyên kích thước gốc.',
  rotate: 'Xoay quanh trục Z, độ. Chỉ đổi hướng đặt trên mặt bàn, không làm thay đổi mặt dốc hay nhu cầu hỗ trợ.',
  copies: 'Số bản in trên một khay, agent tự sắp lại khay. Chỉ đặt khi người dùng nói rõ cần nhiều bản.',
  arrange: 'Sắp lại toàn bộ vật thể trên khay trước khi cắt lát. Cần khi file có nhiều vật thể rời vì chúng có thể chồng lên nhau hoặc nằm ngoài bàn.',
  allowRotations: 'Cho phép xoay vật thể quanh trục Z khi sắp khay để xếp được nhiều hơn. Chỉ có tác dụng khi đã bật sắp khay.',
  plateType: 'Loại mặt bàn đang lắp trên máy. Đây là chuyện phần cứng, người dùng nhìn máy mới biết, nên tuyệt đối đừng đoán: chỉ đặt khi họ nói rõ đang dùng mặt bàn nào, còn lại bỏ trống để agent tự chọn mặt bàn hợp với sợi nhựa.',

  alternateExtraWall: 'Cứ một lớp lại thêm một vòng thành, xen kẽ nhau. Các lớp cài vào nhau nên vật chắc hơn mà tốn ít nhựa hơn so với tăng hẳn số vòng thành.',
  embedWallIntoInfill: 'Dìm vòng thành trong cùng vào phần đổ đầy để thành dính chặt hơn vào lõi. Giúp chịu lực tốt hơn, đổi lại bề mặt trong có thể gợn.',
  detectThinWall: 'Phát hiện thành mỏng hơn một đường đùn và in bằng một đường đơn. Giữ được chi tiết mảnh, nhưng đường đơn dễ đứt nét trên mô hình quét 3D.',
  topSurfacePattern: 'Kiểu vẽ mặt trên cùng. monotonic và monotonicline quét đều một chiều nên mặt sáng đều, đẹp nhất; concentric chạy vòng theo biên; zig-zag nhanh nhưng vệt đan xen.',
  topSurfaceDensity: 'Độ đặc của mặt trên cùng, %. Dưới 100 thì mặt trên hở li ti, chỉ giảm khi cố ý làm mặt xốp.',
  topShellThickness: 'Bề dày lớp đặc mặt trên tính bằng mm; slicer lấy số lớp đủ dày theo chiều cao lớp. Đặt 0 để chỉ dùng số lớp đã khai ở topLayers.',
  topPaintLayers: 'Số lớp trên cùng in bằng màu đã tô khi dùng in nhiều màu. Không liên quan độ bền, chỉ đổi khi màu tô bị lộ nền.',
  bottomSurfacePattern: 'Kiểu vẽ mặt đáy, ảnh hưởng độ nhẵn của mặt tiếp xúc bàn. monotonic cho mặt đều nhất.',
  bottomSurfaceDensity: 'Độ đặc của mặt đáy, %. Giảm xuống dưới 100 thì đáy hở, hiếm khi nên làm.',
  bottomShellThickness: 'Bề dày lớp đặc mặt đáy, mm. Đặt 0 để chỉ dùng số lớp đã khai ở bottomLayers.',
  bottomPaintLayers: 'Số lớp đáy in bằng màu đã tô khi in nhiều màu.',
  solidInfillPattern: 'Kiểu vẽ các lớp đặc nằm bên trong vật (không phải mặt ngoài). zig-zag nhanh và chắc, monotonic đẹp hơn nhưng chậm hơn.',
  subTopSurfacePattern: 'Kiểu vẽ các lớp đặc ngay dưới mặt trên cùng. Để giống mặt trên thì lớp đỡ đều đặn, mặt trên ít bị gợn.',
  fillMultiline: 'Số đường kề nhau cho mỗi nét đổ đầy. Tăng lên 2-3 làm lõi chắc hơn hẳn mà không phải tăng mật độ, đổi lại tốn nhựa và lâu hơn.',
  infillAnchor: 'Đoạn đổ đầy bám vào thành, nhận mm hoặc phần trăm bề rộng đường, ví dụ "400%". Dài thì lõi dính thành chắc hơn, ngắn thì tiết kiệm thời gian.',
  infillAnchorMax: 'Giới hạn trên của đoạn bám nói trên, cũng nhận mm hoặc phần trăm. Đặt 0 là không cho bám dọc theo thành.',
  infillWallOverlap: 'Mức đổ đầy đè lên thành, % bề rộng đường. Nhiều thì lõi dính thành chắc hơn nhưng dễ phồng bề mặt.',
  infillDirection: 'Góc nghiêng của nét đổ đầy, độ. Xoay đi để hướng nét không trùng với hướng lực bẻ.',
  bridgeAngle: 'Góc nét in khi bắc cầu qua khoảng trống, độ. 0 là để slicer tự chọn; chỉ đặt khi cầu bị võng theo một hướng rõ rệt.',
  minSparseInfillArea: 'Diện tích nhỏ nhất mới sinh đổ đầy, mm2. Vùng nhỏ hơn được in đặc luôn cho chắc.',
  infillCombination: 'Gộp đổ đầy của vài lớp thành một lớp dày để in nhanh hơn. Lõi thô hơn và mặt trên dễ gợn.',
  detectNarrowSolidInfill: 'Nhận ra các mảng đặc hẹp và đổi cách vẽ cho liền nét hơn. Nên để bật, chỉ tắt khi mặt bị rối nét.',
  ensureVerticalShell: 'Bảo đảm bề dày thành theo phương đứng bằng cách thêm lớp đặc ở chỗ mái dốc. Bật thì mặt dốc kín và chắc, tắt thì nhanh hơn và tốn ít nhựa.',
  detectFloatingShell: 'Nhận ra mảng thành đứng bị treo lơ lửng và in chậm lại cho bám. Nên để bật với mô hình nhiều chi tiết nhô.',
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
  const parts = [`Tên file: ${file.name}`];
  if (meta.size) parts.push(`Kích thước bao: ${meta.size.x} x ${meta.size.y} x ${meta.size.z} mm`);
  if (meta.volumeCm3) parts.push(`Thể tích đặc: ${meta.volumeCm3} cm3`);
  if (meta.triangles) parts.push(`Số tam giác: ${meta.triangles}`);
  if (meta.overhangRatio !== undefined) {
    parts.push(`Tỉ lệ diện tích mặt úp xuống dốc hơn 30 độ (không tính mặt nằm trên bàn): ${Math.round(meta.overhangRatio * 100)}%`);
  }
  return parts.join('\n');
}

function describeTarget(record, machine, processProfile, filament, { nozzle, filamentType } = {}) {
  const driver = driverClass(record.driver);
  return [
    `Máy in: ${record.name} (${driver.label})`,
    `Profile máy: ${machine}`,
    processProfile ? `Profile chất lượng in: ${processProfile}` : null,
    filament ? `Sợi nhựa: ${filament}${filamentType ? ` (${filamentType})` : ''}` : null,
    nozzle ? `Đường kính vòi phun: ${nozzle} mm` : null,
    nozzle ? `Giới hạn cứng: chiều cao lớp và chiều cao lớp đầu đều không được vượt quá ${nozzle} mm, vượt là slicer bỏ ngang.` : null,
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
      // Nhà cung cấp trả lỗi không phải JSON thì giữ nguyên mã trạng thái.
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

/** Bản cắt lát người dùng đang chỉnh tiếp; chỉ nhận bản cắt ra từ chính mô hình này. */
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
    meta.estimatedTime ? `ước tính ${Math.round(meta.estimatedTime / 60)} phút` : null,
    meta.filamentWeightG ? `${meta.filamentWeightG} g nhựa` : null,
  ]
    .filter(Boolean)
    .join(', ');
  return { name: file.name, detail };
}

/** Bảng dữ liệu gửi cho agent chat: mô hình, máy, bộ giá trị sẽ đem đi cắt lát. */
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
  // Không có bảng này thì mô hình không biết mình đang đổi từ đâu, và sẽ im lặng với cả tham số đang đặt sai.
  const profile = profileValues({ machine, process: processName, filament: filamentName });
  // Người dùng chỉnh tay vài ô rồi mới hỏi, nên phải so với thứ sắp đem đi cắt lát chứ không phải profile gốc.
  const edited = sanitizeOptions(input.options ?? input);
  const current = { ...profile.values, ...edited };
  const extra = sanitizeExtra(input.options?.extra ?? input.extra);
  const previous = previousSlice(input.sliceId, source.id);
  // Máy chưa kết nối thì không báo về vòi phun, lấy tạm theo profile máy đang chọn để mô hình còn biết giới hạn.
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
    'Giá trị các tham số sẽ dùng khi cắt lát (profile, đã gộp các ô người dùng chỉnh tay):',
    ...Object.entries(current).map(([key, value]) => {
      if (!(key in edited)) return `- ${key} = ${value}`;
      return key in profile.values && String(profile.values[key]) !== String(value)
        ? `- ${key} = ${value} (người dùng đã chỉnh, profile đặt ${profile.values[key]})`
        : `- ${key} = ${value} (người dùng đã chỉnh)`;
    }),
    ...(Object.keys(extra).length > 0
      ? ['', 'Tham số slicer người dùng thêm tay, giữ nguyên khi cắt lát và công cụ không đổi được:', ...Object.entries(extra).map(([key, value]) => `- ${key} = ${value}`)]
      : []),
    ...(previous ? ['', `Bản cắt lát gần nhất của mô hình này: "${previous.name}"${previous.detail ? ` (${previous.detail})` : ''}.`] : []),
  ];
  return { source, record, machine, process: profile.process, filament: profile.filament, nozzle: Number(nozzle) || null, edited, extra, current, lines };
}

const language = (locale) => `Trả lời bằng ngôn ngữ: ${locale === 'en' ? 'tiếng Anh' : 'tiếng Việt'}.`;

/** Lượt cũ gửi lại dạng chữ; thay đổi kèm phiên bản đã lưu để mô hình biết bảng hiện tại đến từ đâu. */
function historyText(message) {
  if (message.role === 'user') return message.text;
  const parts = message.text ? [message.text] : [];
  const suggestion = message.suggestion;
  const changes = [
    ...Object.entries(suggestion?.options ?? {}).map(([key, value]) => `${key} = ${value}`),
    ...Object.entries(suggestion?.extra ?? {}).map(([key, value]) => `${key} = ${value ?? '(bỏ, theo profile)'}`),
    ...Object.entries(suggestion?.profiles ?? {}).map(([kind, name]) => `${kind} = ${name}`),
  ];
  if (changes.length > 0) {
    const applied = message.appliedVersion ? `đã lưu và áp dụng thành phiên bản v${message.appliedVersion.number}` : 'người dùng chưa áp dụng';
    parts.push(`Thay đổi (${applied}): ${changes.join(', ')}. ${suggestion.reason ?? ''}`.trim());
  } else if (message.appliedVersion) {
    parts.push(`Đã lưu phiên bản v${message.appliedVersion.number}.`);
  }
  const actions = (message.actions ?? []).map((item) => `${item.tool}${item.error ? ' (lỗi)' : ''}`);
  if (actions.length > 0) parts.push(`Công cụ đã dùng: ${actions.join(', ')}.`);
  return parts.join('\n') || '(không có nội dung)';
}

function chatTools() {
  return [
    {
      name: 'update_slice_settings',
      description:
        'Đổi thông số sẽ dùng khi cắt lát. Cuối lượt agent tự lưu mọi thay đổi thành một phiên bản mới và áp ngay vào form của người dùng, nên chỉ đưa đúng thứ cần đổi.',
      input_schema: {
        type: 'object',
        properties: {
          options: { type: 'object', properties: optionSchema(), additionalProperties: false, description: 'Tham số có ô riêng trên form.' },
          extra: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description:
              'Khoá slicer gốc không có ô riêng trên form, ví dụ retraction_length hay fan_max_speed; tên viết thường nối bằng gạch dưới, giá trị là chuỗi đúng định dạng profile. Tra bằng read_profile_settings trước khi đặt.',
          },
          reset: { type: 'array', items: { type: 'string' }, description: 'Tên tham số trong options hoặc khoá extra cần bỏ giá trị đang đặt để quay về theo profile.' },
          process: { type: 'string', description: 'Đổi sang profile chất lượng in khác, tên đúng như list_profiles trả về.' },
          filament: { type: 'string', description: 'Đổi sang profile sợi nhựa khác, tên đúng như list_profiles trả về. Chỉ đổi khi người dùng nói rõ loại nhựa.' },
          reason: { type: 'string', description: 'Lý do ngắn gọn, tối đa ba câu.' },
        },
        required: ['reason'],
      },
    },
    {
      name: 'list_profiles',
      description: 'Liệt kê profile chất lượng in và sợi nhựa dùng được với máy đang chọn.',
      input_schema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['process', 'filament', 'all'] },
          search: { type: 'string', description: 'Lọc theo một phần tên, không phân biệt hoa thường.' },
        },
      },
    },
    {
      name: 'read_profile_settings',
      description: 'Đọc giá trị gốc trong bộ profile đang chọn (đã gộp máy, chất lượng in, sợi nhựa), kể cả các khoá không có ô riêng trên form.',
      input_schema: {
        type: 'object',
        properties: {
          keys: { type: 'array', items: { type: 'string' }, description: 'Tên khoá chính xác, ví dụ retraction_length.' },
          search: { type: 'string', description: 'Tìm các khoá có chứa chuỗi này, ví dụ retract hoặc fan.' },
        },
      },
    },
    {
      name: 'list_versions',
      description: 'Liệt kê các phiên bản thông số đã lưu của mô hình này, kèm thời gian in và lượng nhựa của phiên bản đã được cắt lát.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'restore_version',
      description: 'Đưa toàn bộ thông số về đúng một phiên bản cũ. Kết quả được lưu thành phiên bản mới ở cuối lượt.',
      input_schema: { type: 'object', properties: { number: { type: 'integer', minimum: 1 } }, required: ['number'] },
    },
    {
      name: 'list_presets',
      description: 'Liệt kê các preset người dùng đã lưu, dùng chung cho mọi mô hình, kèm profile và thông số trong từng preset.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'apply_preset',
      description:
        'Áp một preset đã lưu: thay toàn bộ thông số hiện tại (trừ tỉ lệ, góc xoay, số bản) bằng thông số trong preset, đổi cả profile nếu dùng được với máy đang chọn.',
      input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Tên preset, không phân biệt hoa thường.' } }, required: ['name'] },
    },
    {
      name: 'save_preset',
      description:
        'Lưu bộ thông số hiện tại (đã gồm thay đổi trong lượt) thành preset dùng chung cho mọi mô hình. Chỉ gọi khi người dùng yêu cầu lưu preset; trùng tên thì ghi đè preset cũ.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Tên ngắn, tối đa 60 ký tự, ví dụ "PETG chịu lực".' },
          description: { type: 'string', description: 'Một câu nói preset dùng cho việc gì.' },
        },
        required: ['name'],
      },
    },
    {
      name: 'slice_preview',
      description: `Cắt lát thử với thông số hiện tại để lấy thời gian in, lượng nhựa và cảnh báo thật của slicer. Mất từ vài giây tới vài phút và tạo một bản cắt lát trong thư viện; chỉ dùng khi người dùng quan tâm thời gian, lượng nhựa hoặc muốn so sánh, tối đa ${MAX_TURN_SLICES} lần mỗi lượt.`,
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

/** Công cụ của agent chat. Mọi thay đổi chỉ ghi vào state của lượt, hết lượt mới lưu thành phiên bản. */
function chatSession({ source, record, rootId, nozzle, state }) {
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
      // Khoá đã có ô riêng mà đặt qua extra thì hai chỗ giẫm lên nhau, bắt dùng options.
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
          ...(ignored.length > 0 ? { ignored, note: 'Các khoá bị bỏ qua vì sai tên, sai giá trị, hoặc là khoá đã có ô riêng nên phải đặt qua options.' } : {}),
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
        throw new Error(`Phiên bản v${version.number} dùng profile máy ${version.machine}, khác máy đang chọn nên không khôi phục được ở đây.`);
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
          ...(skipped.length > 0 ? { skipped, note: 'Profile trong preset không dùng được với máy đang chọn nên giữ nguyên profile hiện tại.' } : {}),
        },
      };
    },

    save_preset(input) {
      const preset = slicechat.savePreset({ ...state, name: input.name, description: input.description });
      return { params: { name: preset.name }, result: { ok: true, name: preset.name, overwritten: preset.createdAt !== preset.updatedAt } };
    },

    async slice_preview() {
      if (session.slices >= MAX_TURN_SLICES) throw new Error(`Mỗi lượt chỉ được cắt lát thử tối đa ${MAX_TURN_SLICES} lần.`);
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
    if (!handler) return { type: 'tool_result', tool_use_id: call.id, is_error: true, content: `Không có công cụ ${call.name}.` };
    try {
      const { params, result } = await handler(call.input ?? {});
      session.actions.push({ tool: call.name, params });
      return { type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(result) };
    } catch (error) {
      log.warn(`Công cụ ${call.name} lỗi: ${error.message}`);
      session.actions.push({ tool: call.name, params: {}, error: true });
      return { type: 'tool_result', tool_use_id: call.id, is_error: true, content: error.key ? t(error.key, error.params, 'vi') : error.message };
    }
  };
  return session;
}

/** So bảng giá trị đầu lượt với cuối lượt; đổi profile thì kéo theo cả loạt giá trị nên phải so cả bảng chứ không chỉ ô đã đặt. */
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

/** Chat nhiều lượt về thông số cắt lát. Agent tự dùng công cụ nhiều vòng, cuối lượt tự lưu phiên bản nếu thông số đổi. */
export async function chatSlice(input = {}) {
  const settings = aiSettings();
  const message = String(input.message ?? '').trim().slice(0, MAX_MESSAGE);
  if (!message) throw badRequest('error.field_required', { field: 'message' });
  const context = sliceContext(input);
  const { source, record, current, lines } = context;
  const rootId = slicechat.rootIdOf(source.id);
  const initial = { machine: context.machine, process: context.process, filament: context.filament, options: context.edited, extra: context.extra };
  const session = chatSession({ source, record, rootId, nozzle: context.nozzle, state: structuredClone(initial) });

  const history = slicechat.listMessages(rootId).slice(-MAX_HISTORY);
  if (history[0]?.role === 'assistant') history.shift();
  const presets = slicechat.listPresets().map((item) => item.name);
  const presetLine = presets.length > 0 ? `Preset đã lưu, dùng chung mọi mô hình: ${presets.join(', ')}.` : 'Người dùng chưa lưu preset nào.';
  const messages = [
    ...history.map((item) => ({ role: item.role, content: historyText(item) })),
    { role: 'user', content: [...lines, '', presetLine, '', language(input.locale), '', `Tin nhắn mới của người dùng: ${message}`].join('\n') },
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
      // Vòng cuối cấm gọi công cụ để mô hình buộc phải chốt câu trả lời.
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
  log.info(`Chat cắt lát ${source.name}: ${session.actions.length} lần dùng công cụ, ${version ? `lưu v${version.number}` : 'không đổi thông số'}, ${Date.now() - started}ms`);
  return { fileId: rootId, messages: saved, version: version ?? null };
}

function describePrinterState(record, status, recent) {
  const job = status?.job;
  const alerts = (status?.extra?.hms ?? []).map((item) =>
    item?.text ? `${item.code} (${item.severity ?? 'không rõ mức độ'}): ${item.text}` : `${item?.code ?? item} (chưa có mô tả)`,
  );
  return [
    `Máy in: ${record.name} (${driverClass(record.driver).label})`,
    record.connection?.model ? `Model: ${record.connection.model}` : null,
    status?.firmware ? `Firmware: ${status.firmware}` : null,
    `Trạng thái: ${status?.online ? status.state : 'mất kết nối'}`,
    status?.message ? `Thông báo của máy: ${status.message}` : null,
    status?.temps?.nozzle ? `Vòi phun: ${status.temps.nozzle.actual}C, đặt ${status.temps.nozzle.target}C` : null,
    status?.temps?.bed ? `Bàn in: ${status.temps.bed.actual}C, đặt ${status.temps.bed.target}C` : null,
    job ? `Bản in đang chạy: ${job.file}, ${job.progress}%, lớp ${job.layer}/${job.totalLayers}` : 'Không có bản in nào đang chạy',
    record.slicer?.filament ? `Sợi nhựa đang chọn: ${record.slicer.filament}` : null,
    status?.extra?.nozzleDiameter ? `Đường kính vòi phun: ${status.extra.nozzleDiameter} mm` : null,
    '',
    alerts.length > 0 ? `Cảnh báo HMS đang bật:\n${alerts.join('\n')}` : 'Máy không báo mã HMS nào.',
    '',
    recent.length > 0 ? `Các job gần đây:\n${recent.join('\n')}` : 'Chưa có job nào trong lịch sử.',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/** Đọc trạng thái máy cùng mã cảnh báo của hãng rồi nhờ mô hình chỉ ra nguyên nhân và cách xử lý. */
export async function diagnose(input = {}) {
  const settings = aiSettings();

  const record = printers.getRecord(input.printerId ?? input.printer);
  const status = printers.statusOf(record.id);
  const recent = jobs
    .listJobs({ printerId: record.id, limit: 5 })
    .map((job) => `- ${job.fileName ?? job.remoteName ?? job.id}: ${job.status}${job.error ? `, lỗi: ${job.error}` : ''}`);
  const note = String(input.note ?? '').trim().slice(0, MAX_PURPOSE);

  const history = insights.statsDigest({ printerId: record.id });
  const prompt = [
    describePrinterState(record, status, recent),
    '',
    history.length > 0 ? `Thống kê in của máy:\n${history.join('\n')}` : null,
    history.length > 0 ? '' : null,
    note ? `Người dùng mô tả thêm: ${note}` : 'Người dùng không mô tả thêm.',
    '',
    `Trả lời bằng ngôn ngữ: ${input.locale === 'en' ? 'tiếng Anh' : 'tiếng Việt'}.`,
  ].join('\n');

  const started = Date.now();
  const data = await callModel(settings, {
    system: systemPrompt('diagnose'),
    messages: [{ role: 'user', content: prompt }],
    tools: [
      {
        name: 'diagnose_printer',
        description: 'Kết luận về tình trạng máy in, nguyên nhân khả dĩ và các bước xử lý.',
        input_schema: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: 'Một đến hai câu tóm tắt máy đang gặp chuyện gì.' },
            causes: {
              type: 'array',
              description: 'Nguyên nhân khả dĩ, xếp từ dễ xảy ra nhất.',
              items: { type: 'string' },
            },
            steps: {
              type: 'array',
              description: 'Các bước xử lý cụ thể, theo thứ tự nên làm.',
              items: { type: 'string' },
            },
            severity: {
              type: 'string',
              enum: ['info', 'warning', 'critical'],
              description: 'info là không cần làm gì gấp, warning là nên xử lý trước khi in tiếp, critical là dừng máy ngay.',
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
  log.info(`Chẩn đoán ${record.name} trong ${Date.now() - started}ms`);
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
    `Máy in: ${record.name} (${driverClass(record.driver).label})`,
    record.connection?.model ? `Model: ${record.connection.model}` : null,
    `Trạng thái: ${status?.state ?? 'không rõ'}`,
    job ? `Đang in: ${job.file}` : 'Máy không báo bản in nào đang chạy',
    job?.layer ? `Lớp hiện tại: ${job.layer}${job.totalLayers ? `/${job.totalLayers}` : ''}` : null,
    job?.progress != null ? `Tiến độ: ${job.progress}%` : null,
    status?.temps?.nozzle ? `Vòi phun: ${status.temps.nozzle.actual}C` : null,
    status?.temps?.bed ? `Bàn in: ${status.temps.bed.actual}C` : null,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/** Gửi ảnh camera kèm trạng thái máy cho mô hình thị giác để nó nói bản in còn lành hay đã hỏng. */
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
    input.note ? `Người dùng mô tả thêm: ${String(input.note).trim().slice(0, MAX_PURPOSE)}` : null,
    `Trả lời bằng ngôn ngữ: ${input.locale === 'en' ? 'tiếng Anh' : 'tiếng Việt'}.`,
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
        description: 'Kết luận bản in trong ảnh đang bình thường hay đã hỏng.',
        input_schema: {
          type: 'object',
          properties: {
            verdict: {
              type: 'string',
              enum: INSPECT_VERDICTS,
              description: 'ok là đang in bình thường, suspect là có dấu hiệu đáng ngờ nhưng chưa chắc, failed là hỏng rõ ràng, unclear là ảnh không đủ để kết luận.',
            },
            issue: { type: 'string', enum: INSPECT_ISSUES, description: 'Kiểu hỏng nhìn thấy, không thấy gì thì none.' },
            confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Mức tin cậy của kết luận, từ 0 tới 1.' },
            summary: { type: 'string', description: 'Một tới hai câu mô tả đúng thứ nhìn thấy trong ảnh.' },
            advice: { type: 'array', items: { type: 'string' }, description: 'Việc nên làm ngay, bỏ trống nếu bản in bình thường.' },
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
  log.info(`Soi ảnh ${record.name}: ${result.verdict} trong ${Date.now() - started}ms`);
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

/** Diện tích và kích thước phần chạm bàn, tính từ đường đi thật của lớp đầu tiên. */
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
    // Rải điểm dọc từng đoạn rồi đếm ô lưới 1mm; đếm hai đầu đoạn thôi thì đường đổ đầy dài bị hụt diện tích.
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

/** Cảnh báo tính thẳng từ số liệu, không qua mô hình, nên luôn đúng và luôn có kể cả khi chưa cấu hình AI. */
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
    `File: ${file.name} (${file.format}${meta.sliced === false ? ', chưa cắt lát' : ''})`,
    meta.slicer ? `Cắt lát bằng: ${meta.slicer}` : null,
    size ? `Kích thước bao mô hình: ${size.x} x ${size.y} x ${size.z} mm` : null,
    meta.maxZ ? `Chiều cao bản in: ${meta.maxZ} mm` : null,
    footprint ? `Phần chạm bàn ở lớp đầu: khoảng ${footprint.areaMm2} mm2, trải rộng ${footprint.width} x ${footprint.depth} mm` : null,
    meta.layerCount ? `Số lớp: ${meta.layerCount}` : null,
    meta.layerHeight ? `Chiều cao lớp: ${meta.layerHeight} mm` : null,
    meta.nozzleDiameter ? `File cắt cho vòi phun: ${meta.nozzleDiameter} mm` : null,
    meta.estimatedTime ? `Thời gian in ước tính: ${hoursOf(meta.estimatedTime)} giờ` : null,
    meta.filamentWeightG ? `Nhựa cần dùng: ${round(meta.filamentWeightG, 0)} g` : null,
    meta.filamentType ? `Loại nhựa trong file: ${meta.filamentType}` : null,
    meta.nozzleTemp ? `Nhiệt độ vòi phun trong file: ${meta.nozzleTemp}C` : null,
    meta.bedTemp ? `Nhiệt độ bàn in trong file: ${meta.bedTemp}C` : null,
    meta.overhangRatio !== undefined && meta.overhangRatio !== null
      ? `Tỉ lệ diện tích mặt úp xuống dốc hơn 30 độ: ${Math.round(meta.overhangRatio * 100)}%`
      : null,
    '',
    record ? `Máy sẽ in: ${record.name} (${driverClass(record.driver).label})` : 'Chưa chọn máy in cụ thể.',
    status?.extra?.nozzleDiameter ? `Vòi phun đang lắp trên máy: ${status.extra.nozzleDiameter} mm` : null,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/** Soi file sắp in: số đo tự tính ra cảnh báo chắc chắn, mô hình bổ sung rủi ro khó thành luật. */
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
    history.length > 0 ? `Thống kê các lần in trước:\n${history.join('\n')}\n` : null,
    findings.length > 0
      ? `Cảnh báo agent đã tự tính được:\n${findings.map((item) => `- ${t(item.key, item.params, input.locale)}`).join('\n')}`
      : 'Agent không tự tính ra cảnh báo nào.',
    '',
    input.note ? `Người dùng mô tả thêm: ${String(input.note).trim().slice(0, MAX_PURPOSE)}` : null,
    `Trả lời bằng ngôn ngữ: ${input.locale === 'en' ? 'tiếng Anh' : 'tiếng Việt'}.`,
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
        description: 'Đánh giá file sắp in và nêu các rủi ro kèm cách xử lý.',
        input_schema: {
          type: 'object',
          properties: {
            verdict: {
              type: 'string',
              enum: REVIEW_VERDICTS,
              description: 'ok là in được ngay, warning là nên chỉnh vài thứ, risky là dễ hỏng nếu cứ in như vậy.',
            },
            summary: { type: 'string', description: 'Một tới hai câu chốt lại file này in được hay không.' },
            findings: {
              type: 'array',
              description: 'Các rủi ro đáng nói, xếp từ nặng nhất. Đừng lặp lại nguyên văn cảnh báo agent đã tính.',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: 'Tên rủi ro, ngắn gọn.' },
                  detail: { type: 'string', description: 'Vì sao nó đáng lo với chính file này.' },
                  severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
                  advice: { type: 'string', description: 'Cách xử lý cụ thể.' },
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
  log.info(`Soi file ${file.name} trong ${Date.now() - started}ms`);
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
