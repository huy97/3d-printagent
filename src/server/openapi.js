import { VERSION } from '../util/version.js';
import { JOB_STATUSES } from '../core/jobs.js';
import { PRINTER_STATES, CAPABILITY_KEYS } from '../drivers/base.js';
import { DRIVERS } from '../drivers/index.js';
import { COMMAND_ACTIONS } from '../core/printers.js';
import { optionSchema } from '../core/advisor.js';
import { CALIBRATION_OPTIONS } from '../drivers/base.js';

const json = (schema) => ({ 'application/json': { schema } });
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const ERROR = { description: 'Lỗi', content: json(ref('Error')) };

const SCHEMAS = {
  Error: {
    type: 'object',
    properties: {
      error: {
        type: 'object',
        properties: {
          code: { type: 'string', example: 'conflict' },
          key: { type: 'string', description: 'Mã thông báo i18n, client dùng để tự dịch', example: 'error.printer_not_ready' },
          message: { type: 'string', description: 'Thông báo đã dịch theo x-locale / ?lang= / Accept-Language' },
          details: { type: ['object', 'null'] },
        },
      },
    },
  },
  Temperature: {
    type: ['object', 'null'],
    properties: { actual: { type: 'number' }, target: { type: ['number', 'null'] } },
  },
  PrinterStatus: {
    type: 'object',
    properties: {
      online: { type: 'boolean', description: 'Agent có kết nối được tới máy (hoặc host OctoPrint/Moonraker) không' },
      state: { type: 'string', enum: PRINTER_STATES },
      message: { type: ['string', 'null'] },
      temps: {
        type: 'object',
        properties: { nozzle: ref('Temperature'), bed: ref('Temperature'), chamber: ref('Temperature') },
      },
      job: {
        type: ['object', 'null'],
        properties: {
          file: { type: 'string' },
          progress: { type: 'number', description: '0-100' },
          elapsed: { type: ['integer', 'null'], description: 'Giây' },
          remaining: { type: ['integer', 'null'], description: 'Giây' },
          layer: { type: ['integer', 'null'] },
          totalLayers: { type: ['integer', 'null'] },
        },
      },
      fanSpeed: { type: ['number', 'null'], description: 'Phần trăm' },
      speedFactor: { type: ['number', 'null'], description: 'Phần trăm' },
      position: { type: ['object', 'null'] },
      light: { type: ['boolean', 'null'] },
      firmware: { type: ['string', 'null'] },
      extra: { type: 'object', description: 'Dữ liệu riêng của driver; với Bambu gồm AMS và hms là danh sách { code, severity, text } đã tra từ bảng mã của hãng' },
      updatedAt: { type: ['string', 'null'], format: 'date-time' },
    },
  },
  Printer: {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'prn_1a2b3c4d5e6f' },
      name: { type: 'string' },
      driver: { type: 'string', enum: Object.keys(DRIVERS) },
      driverLabel: { type: 'string' },
      enabled: { type: 'boolean' },
      connection: { type: 'object', description: 'Trường kết nối theo driver, secret trả về dạng ***' },
      notes: { type: 'string' },
      autoStartQueue: { type: 'boolean', description: 'Tự in job tiếp theo trong hàng đợi khi máy rảnh và bàn in trống' },
      bedClear: { type: 'boolean', description: 'Bàn in đã được xác nhận trống sau lần in trước' },
      formats: { type: 'array', items: { type: 'string', enum: ['gcode', 'bgcode', '3mf'] } },
      capabilities: { type: 'object', properties: Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, { type: 'boolean' }])) },
      status: ref('PrinterStatus'),
    },
  },
  PrinterInput: {
    type: 'object',
    required: ['driver', 'connection'],
    properties: {
      name: { type: 'string' },
      driver: { type: 'string', enum: Object.keys(DRIVERS) },
      connection: {
        type: 'object',
        description: 'Xem GET /api/drivers để biết trường của từng driver',
        example: { host: '192.168.1.80', serial: '01P00A123456789', accessCode: '12345678', model: 'P1S' },
      },
      enabled: { type: 'boolean' },
      notes: { type: 'string' },
      autoStartQueue: { type: 'boolean' },
      powerW: { type: ['number', 'null'], description: 'Công suất trung bình khi in (W), để tính tiền điện' },
      hourlyCost: { type: ['number', 'null'], description: 'Chi phí hao mòn mỗi giờ in' },
    },
  },
  SpoolInput: {
    type: 'object',
    properties: {
      name: { type: 'string', example: 'PLA Basic đen' },
      material: { type: 'string', example: 'PLA' },
      color: { type: ['string', 'null'], example: '#000000' },
      brand: { type: ['string', 'null'] },
      diameter: { type: 'number', default: 1.75 },
      density: { type: 'number', description: 'g/cm3, bỏ trống thì lấy theo loại nhựa' },
      pricePerKg: { type: ['number', 'null'] },
      totalG: { type: 'number', default: 1000 },
      remainingG: { type: 'number' },
      lowG: { type: 'number', default: 100, description: 'Còn dưới mức này thì cảnh báo' },
      printerId: { type: ['string', 'null'], description: 'Máy đang gắn cuộn này' },
      slot: { type: ['integer', 'null'], description: 'Khay AMS (0 là A1), bỏ trống với máy một cuộn' },
      notes: { type: ['string', 'null'] },
    },
  },
  File: {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'fil_1a2b3c4d5e6f' },
      name: { type: 'string', example: 'benchy.gcode.3mf' },
      size: { type: 'integer' },
      format: { type: 'string', enum: ['gcode', 'bgcode', '3mf', 'model'] },
      meta: {
        type: 'object',
        description: 'Metadata đọc từ file slicer, hoặc số đo hình học với mô hình chưa cắt lát',
        properties: {
          slicer: { type: ['string', 'null'] },
          estimatedTime: { type: ['integer', 'null'], description: 'Giây' },
          filamentType: { type: ['string', 'null'] },
          filamentWeightG: { type: ['number', 'null'] },
          layerCount: { type: ['integer', 'null'] },
          plates: { type: 'array', description: 'Chỉ có với 3MF' },
          sliced: { type: 'boolean', description: '3MF chưa slice thì không in được' },
          triangles: { type: ['integer', 'null'], description: 'Mô hình chưa cắt lát' },
          size: { type: ['object', 'null'], description: 'Kích thước bao theo mm', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
          volumeCm3: { type: ['number', 'null'] },
          overhangRatio: { type: ['number', 'null'], description: 'Tỉ lệ diện tích mặt úp xuống dốc hơn 30 độ, không tính mặt nằm trên bàn' },
        },
      },
      hasThumbnail: { type: 'boolean' },
      uploadedAt: { type: 'string', format: 'date-time' },
    },
  },
  FileSource: {
    type: 'object',
    description: 'Chọn một nguồn: url, content (text G-code), contentBase64 hoặc path (cần bật files.allowLocalFilePath)',
    properties: {
      url: { type: 'string', format: 'uri' },
      content: { type: 'string' },
      contentBase64: { type: 'string' },
      path: { type: 'string' },
      name: { type: 'string', description: 'Tên file kèm phần mở rộng .gcode/.bgcode/.3mf' },
    },
  },
  PrintOptions: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['now', 'queue'], default: 'now' },
      confirmBedClear: { type: 'boolean', description: 'Xác nhận bàn in đã trống (bắt buộc khi bedClear=false)' },
      plate: { type: 'integer', description: '3MF: số plate cần in' },
      useAms: { type: 'boolean' },
      amsMapping: { type: 'array', items: { type: 'integer' } },
      timelapse: { type: 'boolean' },
      bedLeveling: { oneOf: [{ type: 'boolean' }, { type: 'string', enum: ['auto'] }], description: 'Bambu: true bật, false tắt, "auto" để máy tự kiểm tra (mặc định)' },
      flowCalibration: { oneOf: [{ type: 'boolean' }, { type: 'string', enum: ['auto'] }], description: 'Bambu: true bật, false tắt, "auto" bỏ qua nếu nhựa vừa hiệu chỉnh (mặc định)' },
    },
  },
  Job: {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'job_1a2b3c4d5e6f' },
      printerId: { type: ['string', 'null'], description: 'null khi job nằm ở hàng đợi chung và chưa được giao máy' },
      printerName: { type: ['string', 'null'] },
      target: { type: ['object', 'null'], description: 'Hàng đợi chung: { any: true, printerIds }' },
      priority: { type: 'integer', description: 'Cao chạy trước, từ -100 tới 100' },
      fileId: { type: ['string', 'null'] },
      fileName: { type: 'string' },
      status: { type: 'string', enum: JOB_STATUSES },
      adjustedTime: { type: ['integer', 'null'], description: 'Thời gian dự kiến đã hiệu chỉnh theo lịch sử máy (giây)' },
      forecast: { type: 'object', description: 'Giờ bắt đầu và xong dự kiến', properties: { startAt: { type: ['string', 'null'] }, finishAt: { type: 'string' }, printerId: { type: 'string' } } },
      material: { type: ['object', 'null'], description: 'Nhựa đã dùng khi job kết thúc: usedG, productG, wasteG, grams{model,support,adhesion,purge}' },
      cost: { type: ['object', 'null'], description: 'Chi phí: filament, electricity, wear, total, currency' },
      progress: { type: 'number' },
      layer: { type: ['integer', 'null'] },
      totalLayers: { type: ['integer', 'null'] },
      remaining: { type: ['integer', 'null'] },
      upload: { type: ['object', 'null'], properties: { sent: { type: 'integer' }, total: { type: 'integer' } } },
      origin: { type: 'string', example: 'mcp' },
      error: { type: ['string', 'null'] },
      createdAt: { type: 'string', format: 'date-time' },
      startedAt: { type: ['string', 'null'], format: 'date-time' },
      finishedAt: { type: ['string', 'null'], format: 'date-time' },
    },
  },
};

const idParam = (name, description) => ({ name, in: 'path', required: true, schema: { type: 'string' }, description });
const PRINTER_ID = idParam('id', 'Id hoặc tên máy in');
const FILE_ID = idParam('id', 'Id file trong thư viện');
const JOB_ID = idParam('id', 'Id job');
const queryParam = (name, type, description) => ({ name, in: 'query', required: false, description, schema: { type } });
const POINTS = queryParam('points', 'integer', 'Số điểm tối đa (mặc định 1500), khoảng dài được gộp trung bình');
const HISTORY_QUERY = [
  queryParam('minutes', 'integer', 'N phút gần nhất khi không có from (mặc định 30)'),
  queryParam('from', 'string', 'ISO 8601 hoặc epoch ms'),
  queryParam('to', 'string', 'ISO 8601 hoặc epoch ms, mặc định hiện tại'),
  POINTS,
];

function op(summary, { tags, params, body, response, status = 200, multipart } = {}) {
  const operation = { summary, tags, responses: { [status]: { description: 'OK', ...(response ? { content: json(response) } : {}) }, default: ERROR } };
  if (params) operation.parameters = params;
  if (body || multipart) {
    operation.requestBody = {
      required: true,
      content: {
        ...(body ? json(body) : {}),
        ...(multipart ? { 'multipart/form-data': { schema: multipart } } : {}),
      },
    };
  }
  return operation;
}

const commandBody = (properties, required) => ({ type: 'object', properties, ...(required ? { required } : {}) });

function printerAction(summary, body) {
  return { post: op(summary, { tags: ['Điều khiển'], params: [PRINTER_ID], body }) };
}

export function buildOpenApi(baseUrl) {
  const multipartFile = {
    type: 'object',
    properties: {
      file: { type: 'string', format: 'binary' },
      name: { type: 'string' },
      printerId: { type: 'string', description: 'Kèm printerId + print=true để in luôn sau khi tải lên' },
      print: { type: 'boolean' },
    },
  };

  return {
    openapi: '3.1.0',
    info: {
      title: '3D PrintAgent API',
      version: VERSION,
      description:
        'Quản lý nhiều máy in 3D (OctoPrint, Klipper/Moonraker, PrusaLink, Bambu Lab LAN) qua REST. ' +
        'Sự kiện realtime qua WebSocket /ws, tác nhân AI dùng MCP tại /mcp.',
    },
    servers: [{ url: baseUrl }],
    security: [{ apiKey: [] }, { bearer: [] }],
    components: {
      securitySchemes: {
        apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' },
        bearer: { type: 'http', scheme: 'bearer' },
      },
      schemas: SCHEMAS,
    },
    paths: {
      '/api/health': { get: { ...op('Tình trạng agent', { tags: ['Hệ thống'] }), security: [] } },
      '/api/info': { get: op('Thông tin agent và endpoint', { tags: ['Hệ thống'] }) },
      '/api/logs': { get: op('Log gần đây', { tags: ['Hệ thống'], params: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 200 } }] }) },
      '/api/drivers': { get: op('Danh sách driver và trường kết nối', { tags: ['Máy in'] }) },
      '/api/printers': {
        get: op('Danh sách máy in kèm trạng thái', { tags: ['Máy in'], response: { type: 'object', properties: { printers: { type: 'array', items: ref('Printer') } } } }),
        post: op('Thêm máy in', { tags: ['Máy in'], body: ref('PrinterInput'), response: ref('Printer'), status: 201 }),
      },
      '/api/printers/test': { post: op('Thử kết nối trước khi lưu', { tags: ['Máy in'], body: ref('PrinterInput') }) },
      '/api/printers/detect': {
        post: op('Đoán loại máy theo địa chỉ IP', { tags: ['Máy in'], body: commandBody({ host: { type: 'string' }, port: { type: 'integer' } }, ['host']) }),
      },
      '/api/printers/discover': {
        get: op('Dò máy in trong LAN (SSDP Bambu, mDNS OctoPrint/Moonraker)', {
          tags: ['Máy in'],
          params: [{ name: 'timeout', in: 'query', schema: { type: 'integer', default: 12000 } }],
        }),
      },
      '/api/printers/{id}': {
        get: op('Chi tiết máy in', { tags: ['Máy in'], params: [PRINTER_ID], response: ref('Printer') }),
        put: op('Sửa máy in', { tags: ['Máy in'], params: [PRINTER_ID], body: ref('PrinterInput'), response: ref('Printer') }),
        delete: op('Xoá máy in', { tags: ['Máy in'], params: [PRINTER_ID] }),
      },
      '/api/printers/{id}/status': { get: op('Trạng thái realtime', { tags: ['Máy in'], params: [PRINTER_ID] }) },
      '/api/printers/{id}/history': {
        get: op('Lịch sử nhiệt độ, quạt, tốc độ, tiến độ lưu trong SQLite (mẫu 5 giây)', { tags: ['Máy in'], params: [PRINTER_ID, ...HISTORY_QUERY] }),
      },
      '/api/printers/{id}/reconnect': { post: op('Kết nối lại driver', { tags: ['Máy in'], params: [PRINTER_ID] }) },
      '/api/printers/{id}/snapshot': {
        get: {
          ...op('Ảnh camera hiện tại', { tags: ['Máy in'], params: [PRINTER_ID] }),
          responses: { 200: { description: 'Ảnh JPEG/PNG', content: { 'image/jpeg': {}, 'image/png': {} } }, default: ERROR },
        },
      },
      '/api/printers/{id}/camera': {
        get: {
          ...op('Luồng camera MJPEG liên tục, chỉ có ở máy hỗ trợ capability cameraStream', { tags: ['Máy in'], params: [PRINTER_ID] }),
          responses: { 200: { description: 'multipart/x-mixed-replace, mỗi phần là một ảnh JPEG', content: { 'multipart/x-mixed-replace': {} } }, default: ERROR },
        },
      },
      '/api/printers/{id}/diagnose': {
        post: op('AI đọc trạng thái máy, mã HMS đã dịch nghĩa và job gần đây để chỉ ra nguyên nhân và cách xử lý; cần ai.apiKey trong cấu hình', {
          tags: ['Máy in'],
          params: [PRINTER_ID],
          body: commandBody({ note: { type: 'string', description: 'Mô tả thêm của người dùng về hiện tượng' } }),
        }),
        get: op('Kết quả chẩn đoán tự động gần nhất, có khi bật watch.autoDiagnose', { tags: ['Máy in'], params: [PRINTER_ID] }),
      },
      '/api/printers/{id}/inspect': {
        post: op('AI soi ảnh camera hiện tại để nói bản in còn lành hay đã hỏng; cần ai.apiKey trong cấu hình', {
          tags: ['Máy in'],
          params: [PRINTER_ID],
          body: commandBody({ note: { type: 'string', description: 'Mô tả thêm của người dùng về hiện tượng' } }),
        }),
        get: op('Kết quả soi ảnh gần nhất của máy này, kèm trạng thái giám sát tự động', { tags: ['Máy in'], params: [PRINTER_ID] }),
      },
      '/api/printers/{id}/bed-cleared': {
        post: op('Xác nhận bàn in đã trống', { tags: ['Máy in'], params: [PRINTER_ID], body: commandBody({ clear: { type: 'boolean', default: true } }) }),
      },
      '/api/printers/{id}/files': {
        get: op('File đang có trên máy in', { tags: ['Máy in'], params: [PRINTER_ID] }),
        delete: op('Xoá file trên máy in', { tags: ['Máy in'], params: [PRINTER_ID, { name: 'name', in: 'query', required: true, schema: { type: 'string' } }] }),
      },
      '/api/printers/{id}/files/start': {
        post: op('In một file đã có sẵn trên máy', { tags: ['Máy in'], params: [PRINTER_ID], body: commandBody({ name: { type: 'string' } }, ['name']) }),
      },
      '/api/printers/{id}/print': {
        post: op('Tạo job in cho máy này', {
          tags: ['Job'],
          params: [PRINTER_ID],
          body: { allOf: [commandBody({ fileId: { type: 'string' } }, ['fileId']), ref('PrintOptions')] },
          response: ref('Job'),
          status: 201,
        }),
      },
      '/api/printers/{id}/command': printerAction(
        'Lệnh điều khiển tổng quát: action + params',
        commandBody({ action: { type: 'string', enum: COMMAND_ACTIONS }, params: { type: 'object', example: { heater: 'bed', target: 60 } } }, ['action']),
      ),
      '/api/printers/{id}/pause': printerAction('Tạm dừng in'),
      '/api/printers/{id}/resume': printerAction('Tiếp tục in'),
      '/api/printers/{id}/cancel': printerAction('Huỷ bản in đang chạy'),
      '/api/printers/{id}/gcode': printerAction('Gửi G-code (qua bộ lọc an toàn)', commandBody({ gcode: { type: 'string', example: 'G28\nM104 S200' } }, ['gcode'])),
      '/api/printers/{id}/temperature': printerAction(
        'Đặt nhiệt độ',
        commandBody({ heater: { type: 'string', enum: ['nozzle', 'bed', 'chamber'] }, target: { type: 'number' } }, ['heater', 'target']),
      ),
      '/api/printers/{id}/home': printerAction('Về gốc trục', commandBody({ axes: { type: 'array', items: { type: 'string', enum: ['x', 'y', 'z'] } } })),
      '/api/printers/{id}/jog': printerAction(
        'Di chuyển tương đối (mm)',
        commandBody({ x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, feedrate: { type: 'number' } }),
      ),
      '/api/printers/{id}/fan': printerAction('Tốc độ quạt làm mát (%)', commandBody({ percent: { type: 'number' } }, ['percent'])),
      '/api/printers/{id}/speed': printerAction('Tốc độ in (%)', commandBody({ percent: { type: 'number' } }, ['percent'])),
      '/api/printers/{id}/light': printerAction('Bật/tắt đèn', commandBody({ on: { type: 'boolean' } }, ['on'])),
      '/api/printers/{id}/load-filament': printerAction(
        'Nạp nhựa vào đầu phun',
        commandBody({ temperature: { type: 'number' }, length: { type: 'number' }, slot: { type: 'number', description: 'Bambu: khay AMS tính từ 0, 254 là cuộn ngoài' } }),
      ),
      '/api/printers/{id}/unload-filament': printerAction(
        'Rút nhựa khỏi đầu phun',
        commandBody({ temperature: { type: 'number' }, length: { type: 'number' } }),
      ),
      '/api/printers/{id}/calibrate': printerAction(
        'Chạy hiệu chỉnh máy (cân bàn, bù rung, khử ồn...). Hạng mục máy làm được nằm ở trường `calibrations` của máy in',
        commandBody(
          {
            options: {
              type: 'array',
              items: { type: 'string', enum: [...CALIBRATION_OPTIONS] },
              example: ['bedLeveling'],
            },
            confirmBedClear: { type: 'boolean', description: 'Xác nhận bàn in đã trống' },
          },
          ['options'],
        ),
      ),
      '/api/printers/{id}/emergency-stop': printerAction('Dừng khẩn cấp'),
      '/api/printers/{id}/connect': printerAction('Kết nối lại firmware (OctoPrint connect, Klipper firmware restart)'),
      '/api/files': {
        get: op('Thư viện file', {
          tags: ['File'],
          params: [
            { name: 'search', in: 'query', schema: { type: 'string' } },
            { name: 'format', in: 'query', schema: { type: 'string' } },
            {
              name: 'derived',
              in: 'query',
              description: 'false chỉ lấy file người dùng tự đưa vào, true chỉ lấy bản do cắt lát hoặc tách vật thể sinh ra',
              schema: { type: 'boolean' },
            },
            { name: 'sourceId', in: 'query', description: 'Chỉ lấy các bản sinh ra từ file gốc này', schema: { type: 'string' } },
          ],
        }),
        post: op('Tải file lên thư viện', { tags: ['File'], body: ref('FileSource'), multipart: multipartFile, response: ref('File'), status: 201 }),
      },
      '/api/files/{id}': {
        get: op('Chi tiết file', { tags: ['File'], params: [FILE_ID], response: ref('File') }),
        put: op('Đổi tên file', { tags: ['File'], params: [FILE_ID], body: commandBody({ name: { type: 'string' } }, ['name']) }),
        delete: op('Xoá file', { tags: ['File'], params: [FILE_ID] }),
      },
      '/api/files/{id}/analyze': {
        post: op('Soi file sắp in: số đo tự tính ra cảnh báo chắc chắn, AI bổ sung rủi ro khó thành luật; cần ai.apiKey trong cấu hình', {
          tags: ['File'],
          params: [FILE_ID],
          body: commandBody({
            printerId: { type: 'string', description: 'Máy sẽ in, để đối chiếu vòi phun và khay nhựa đang nạp' },
            plate: { type: 'integer', minimum: 1, description: 'Khay cần soi với file 3MF nhiều khay' },
            note: { type: 'string' },
          }),
        }),
      },
      '/api/files/{id}/split': {
        post: op('Tách các khối rời trong mô hình thành nhiều vật thể, trả về file 3MF mới', { tags: ['File'], params: [FILE_ID], status: 201 }),
      },
      '/api/files/{id}/arrange': {
        post: op('Xếp lại các khối của mô hình cho nằm gọn trên bàn in, trả về file 3MF mới', {
          tags: ['File'],
          params: [FILE_ID],
          body: commandBody({
            machine: { type: 'string' },
            printerId: { type: 'string' },
            gap: { type: 'number', description: 'Khoảng hở giữa hai vật thể tính bằng mm, mặc định 6' },
            margin: { type: 'number', description: 'Lề tính từ mép bàn bằng mm, mặc định 2' },
            separate: { type: 'boolean', description: 'Tách cả những khối đang dính bóng nhau ra xếp riêng' },
            autoRotate: { type: 'boolean', description: 'Lật từng cụm cho mặt phẳng rộng nhất úp xuống bàn' },
          }),
          status: 201,
        }),
      },
      '/api/files/{id}/layout': {
        post: op('Ghi lại vị trí mới của vật thể sau khi kéo thả trên bàn in, sửa ngay trên file đang xem', {
          tags: ['File'],
          params: [FILE_ID],
          body: commandBody(
            {
              moves: {
                type: 'array',
                description: 'Danh sách vật cần dời',
                items: {
                  type: 'object',
                  properties: {
                    item: { type: 'integer', description: 'Số thứ tự vật thể trên khay, lấy từ trường item của /mesh' },
                    dx: { type: 'number', description: 'Dời theo trục X, mm' },
                    dy: { type: 'number', description: 'Dời theo trục Y, mm' },
                  },
                },
              },
            },
            ['moves'],
          ),
        }),
      },
      '/api/files/{id}/plate': {
        get: op('Vị trí các vật thể trên khay in, đọc trực tiếp từ 3MF do slicer ghi', {
          tags: ['File'],
          params: [FILE_ID, { name: 'plate', in: 'query', schema: { type: 'integer' }, description: 'Số khay, mặc định lấy khay đầu tiên' }],
        }),
      },
      '/api/files/{id}/mesh': {
        get: op('Hình khối của mô hình theo toạ độ bàn in, dạng nhị phân cho khung xem 3D', {
          tags: ['File'],
          params: [
            FILE_ID,
            { name: 'plate', in: 'query', schema: { type: 'integer' } },
            {
              name: 'machine',
              in: 'query',
              schema: { type: 'string' },
              description: 'Tên profile máy, dùng lấy kích thước bàn chuẩn khi mô hình chưa cắt lát',
            },
            { name: 'printerId', in: 'query', schema: { type: 'string' }, description: 'Máy in đã khai báo, dùng để đoán profile máy' },
          ],
        }),
      },
      '/api/files/{id}/toolpath': {
        get: op('Đường đi vòi phun đọc từ G-code đã cắt lát, dạng nhị phân cho khung xem từng lớp', {
          tags: ['File'],
          params: [FILE_ID, { name: 'plate', in: 'query', schema: { type: 'integer' } }],
        }),
      },
      '/api/files/{id}/plate-image': {
        get: op('Ảnh nhìn từ trên xuống của khay in (PNG do slicer nhúng sẵn)', {
          tags: ['File'],
          params: [FILE_ID, { name: 'plate', in: 'query', schema: { type: 'integer' } }],
        }),
      },
      '/api/files/{id}/download': { get: op('Tải file gốc', { tags: ['File'], params: [FILE_ID] }) },
      '/api/files/{id}/thumbnail': { get: op('Ảnh xem trước do slicer nhúng', { tags: ['File'], params: [FILE_ID] }) },
      '/api/jobs': {
        get: op('Danh sách job', {
          tags: ['Job'],
          params: [
            { name: 'status', in: 'query', schema: { type: 'string' }, description: 'Một hoặc nhiều trạng thái, cách nhau dấu phẩy' },
            { name: 'printerId', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer' } },
          ],
        }),
        post: op('Tạo job in', {
          tags: ['Job'],
          body: { allOf: [commandBody({ printerId: { type: 'string' }, fileId: { type: 'string' } }, ['printerId', 'fileId']), ref('PrintOptions')] },
          response: ref('Job'),
          status: 201,
        }),
      },
      '/api/jobs/batch': {
        post: op('In cùng một file ngay trên nhiều máy, mỗi máy một bản; máy chưa sẵn sàng bị bỏ qua, không xếp hàng', {
          tags: ['Job'],
          body: {
            allOf: [
              commandBody(
                {
                  fileId: { type: 'string' },
                  printerIds: { type: 'array', items: { type: 'string' } },
                  confirmBedClear: { type: 'boolean' },
                },
                ['fileId'],
              ),
              ref('PrintOptions'),
            ],
          },
          status: 201,
        }),
      },
      '/api/jobs/batch/{batchId}/cancel': {
        post: op('Huỷ mọi bản chưa kết thúc của một lô', {
          tags: ['Job'],
          params: [{ name: 'batchId', in: 'path', required: true, schema: { type: 'string' } }],
          body: commandBody({ force: { type: 'boolean' } }),
        }),
      },
      '/api/jobs/clear': { post: op('Xoá các job đã kết thúc', { tags: ['Job'], body: commandBody({ printerId: { type: 'string' } }) }) },
      '/api/jobs/{id}': {
        get: op('Chi tiết job', { tags: ['Job'], params: [JOB_ID], response: ref('Job') }),
        put: op('Sửa job đang chờ: độ ưu tiên, ghi chú, nhóm máy của hàng đợi chung', {
          tags: ['Job'],
          params: [JOB_ID],
          body: commandBody({
            priority: { type: 'integer', minimum: -100, maximum: 100 },
            note: { type: ['string', 'null'] },
            printerIds: { type: 'array', items: { type: 'string' } },
          }),
        }),
        delete: op('Xoá job đã kết thúc', { tags: ['Job'], params: [JOB_ID] }),
      },
      '/api/jobs/{id}/history': { get: op('Lịch sử nhiệt độ trong thời gian job chạy', { tags: ['Job'], params: [JOB_ID, POINTS] }) },
      '/api/jobs/{id}/start': {
        post: op('Chạy job đang xếp hàng; job hàng đợi chung cần printerId của máy sẽ in', {
          tags: ['Job'],
          params: [JOB_ID],
          body: commandBody({ confirmBedClear: { type: 'boolean' }, printerId: { type: 'string' } }),
        }),
      },
      '/api/jobs/{id}/move': {
        post: op('Đổi thứ tự job đang chờ trong hàng đợi', {
          tags: ['Job'],
          params: [JOB_ID],
          body: commandBody({ direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] } }, ['direction']),
        }),
      },
      '/api/jobs/{id}/cancel': { post: op('Huỷ job', { tags: ['Job'], params: [JOB_ID], body: commandBody({ force: { type: 'boolean' } }) }) },
      '/api/jobs/{id}/reprint': { post: op('In lại', { tags: ['Job'], params: [JOB_ID], body: ref('PrintOptions'), status: 201 }) },
      '/api/print': {
        post: op('Một bước: đưa file vào thư viện rồi in', {
          tags: ['Job'],
          body: { allOf: [ref('FileSource'), commandBody({ printerId: { type: 'string' }, fileId: { type: 'string' } }, ['printerId']), ref('PrintOptions')] },
          multipart: { ...multipartFile, required: ['file', 'printerId'] },
          status: 201,
        }),
      },
      '/api/slicer': {
        get: op('Trạng thái slicer trên máy chạy agent, kèm advisor cho biết đã cấu hình khoá AI chưa', { tags: ['Slicer'] }),
        post: op('Cắt lát mô hình rồi đưa kết quả vào thư viện', {
          tags: ['Slicer'],
          body: commandBody(
            {
              fileId: { type: 'string', description: 'File mô hình STL/OBJ/3MF trong thư viện' },
              printerId: { type: 'string', description: 'Máy in đích, quyết định xuất 3MF hay G-code' },
              machine: { type: 'string', description: 'Tên profile máy, lấy từ /api/slicer/profiles' },
              process: { type: 'string' },
              filament: { type: 'string' },
              // Danh sách tham số ghi đè lấy thẳng từ bảng của slicer để tài liệu không lệch khi thêm khoá mới.
              ...optionSchema(),
              extra: {
                type: 'object',
                description: 'Khoá cấu hình bất kỳ của slicer, ví dụ {"reduce_crossing_wall": true, "top_surface_pattern": "monotonic"}',
                additionalProperties: { type: ['string', 'number', 'boolean'] },
              },
            },
            ['fileId', 'printerId', 'machine'],
          ),
          status: 201,
        }),
      },
      '/api/slicer/chat/{fileId}': {
        get: op('Lịch sử chat và các phiên bản thông số cắt lát, tính theo mô hình gốc của file', {
          tags: ['Slicer'],
          params: [idParam('fileId', 'Id mô hình, bản sắp khay hoặc bản cắt lát')],
        }),
        delete: op('Xoá lịch sử chat, giữ nguyên các phiên bản', { tags: ['Slicer'], params: [idParam('fileId', 'Id file')] }),
      },
      '/api/slicer/chat/{fileId}/messages': {
        post: op('Nhắn cho agent về thông số cắt lát; trả về lượt hỏi và lượt đáp đã lưu, lượt đáp có thể kèm đề xuất tham số', {
          tags: ['Slicer'],
          params: [idParam('fileId', 'Id mô hình chưa cắt lát')],
          status: 201,
          body: commandBody(
            {
              message: { type: 'string', description: 'Tối đa 2000 ký tự' },
              printerId: { type: 'string' },
              machine: { type: 'string' },
              process: { type: 'string' },
              filament: { type: 'string' },
              options: { type: 'object', description: 'Các ô đang chỉnh trên form, kèm extra là tham số slicer thêm tay' },
              sliceId: { type: 'string', description: 'Bản cắt lát gần nhất để agent biết đang chỉnh tiếp từ đâu' },
            },
            ['message', 'printerId', 'machine'],
          ),
        }),
      },
      '/api/slicer/chat/{fileId}/versions': {
        post: op('Lưu một phiên bản thông số cắt lát; cắt lát qua POST /api/slicer tự lưu phiên bản', {
          tags: ['Slicer'],
          params: [idParam('fileId', 'Id file')],
          status: 201,
          body: commandBody({
            source: { type: 'string', enum: ['ai', 'slice', 'manual'] },
            machine: { type: 'string' },
            process: { type: 'string' },
            filament: { type: 'string' },
            options: { type: 'object' },
            extra: { type: 'object' },
            sliceId: { type: 'string' },
            messageId: { type: 'string', description: 'Tin nhắn chứa đề xuất vừa áp dụng' },
          }),
        }),
      },
      '/api/slicer/presets': {
        get: op('Preset thông số cắt lát, dùng chung cho mọi mô hình', { tags: ['Slicer'] }),
        post: op('Lưu preset; trùng tên (không phân biệt hoa thường) thì ghi đè', {
          tags: ['Slicer'],
          status: 201,
          body: commandBody(
            {
              name: { type: 'string', description: 'Tối đa 60 ký tự' },
              description: { type: 'string' },
              machine: { type: 'string' },
              process: { type: 'string' },
              filament: { type: 'string' },
              options: { type: 'object', description: 'Tỉ lệ, góc xoay, số bản và sắp khay không được lưu vào preset' },
              extra: { type: 'object' },
            },
            ['name'],
          ),
        }),
      },
      '/api/slicer/presets/{id}': {
        delete: op('Xoá preset', { tags: ['Slicer'], params: [idParam('id', 'Id preset')] }),
      },
      '/api/slicer/profiles': {
        get: op('Profile máy, process và nhựa; truyền machine để lọc process/nhựa tương thích', {
          tags: ['Slicer'],
          params: [
            queryParam('printerId', 'string', 'Gợi ý profile máy khớp với máy in này'),
            queryParam('vendor', 'string', 'Lọc theo hãng'),
            queryParam('machine', 'string', 'Tên profile máy đã chọn'),
          ],
        }),
      },
      '/api/slicer/options': {
        get: op('Tham số ghi đè được khi cắt lát kèm kiểu, khoảng min/max và giá trị hợp lệ', { tags: ['Slicer'] }),
      },
      '/api/slicer/profile-settings': {
        get: op('Giá trị gốc trong bộ profile máy, process và nhựa đã gộp, tối đa 60 khoá', {
          tags: ['Slicer'],
          params: [
            queryParam('machine', 'string', 'Tên profile máy'),
            queryParam('process', 'string', 'Bỏ trống thì dùng mặc định của máy'),
            queryParam('filament', 'string', 'Bỏ trống thì dùng mặc định của máy'),
            queryParam('keys', 'string', 'Tên khoá chính xác, cách nhau dấu phẩy'),
            queryParam('search', 'string', 'Chuỗi con trong tên khoá'),
          ],
        }),
      },
      '/api/files/{id}/orient': {
        post: op('Xoay mô hình sang hướng ít phải in hỗ trợ nhất, trả 3MF mới (201) hoặc changed=false (200)', { tags: ['File'], params: [FILE_ID] }),
      },
      '/api/files/combine': {
        post: op('Gom nhiều mô hình chưa cắt lát (kèm số bản) lên cùng một khay, trả 3MF mới', {
          tags: ['File'],
          body: commandBody(
            {
              items: {
                type: 'array',
                items: { type: 'object', properties: { fileId: { type: 'string' }, copies: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['fileId'] },
              },
              printerId: { type: 'string', description: 'Máy sẽ in, để lấy kích thước bàn' },
              machine: { type: 'string' },
              gap: { type: 'number' },
              margin: { type: 'number' },
              autoRotate: { type: 'boolean' },
              name: { type: 'string' },
            },
            ['items'],
          ),
          status: 201,
        }),
      },
      '/api/files/{id}/material': {
        get: op('Lượng nhựa file cần theo nhóm (thành phẩm, hỗ trợ, viền, xả màu) và theo đầu nhựa', {
          tags: ['Nhựa'],
          params: [FILE_ID, queryParam('plate', 'integer', 'Số plate của 3MF')],
        }),
      },
      '/api/preflight': {
        post: op('Kiểm tra trước khi in: nhựa cần so với cuộn đang gắn, chi phí, giờ xong đã hiệu chỉnh theo lịch sử', {
          tags: ['Nhựa'],
          body: commandBody(
            {
              fileId: { type: 'string' },
              printerId: { type: 'string', description: 'Bỏ trống để agent chọn máy hợp đầu tiên' },
              printerIds: { type: 'array', items: { type: 'string' } },
              plate: { type: 'integer' },
              amsMapping: { type: 'array', items: { type: 'integer' } },
            },
            ['fileId'],
          ),
        }),
      },
      '/api/spools': {
        get: op('Danh sách cuộn nhựa và cấu hình chi phí', { tags: ['Nhựa'], params: [queryParam('printerId', 'string', 'Lọc theo máy đang gắn')] }),
        post: op('Thêm cuộn nhựa', { tags: ['Nhựa'], body: ref('SpoolInput'), status: 201 }),
      },
      '/api/spools/{id}': {
        put: op('Sửa cuộn nhựa', { tags: ['Nhựa'], params: [idParam('id', 'Id cuộn')], body: ref('SpoolInput') }),
        delete: op('Xoá cuộn nhựa', { tags: ['Nhựa'], params: [idParam('id', 'Id cuộn')] }),
      },
      '/api/spools/{id}/adjust': {
        post: op('Cân lại cuộn: đặt số gam còn lại hoặc cộng/trừ', {
          tags: ['Nhựa'],
          params: [idParam('id', 'Id cuộn')],
          body: commandBody({ remainingG: { type: 'number' }, deltaG: { type: 'number' } }),
        }),
      },
      '/api/stats': {
        get: op('Thống kê tỉ lệ thành công, giờ in, nhựa thải và chi phí theo máy, mô hình, nhựa, profile, ngày', {
          tags: ['Thống kê'],
          params: [queryParam('days', 'integer', 'Số ngày gần nhất, 0 là toàn bộ (mặc định 30)'), queryParam('printerId', 'string', 'Lọc theo máy')],
        }),
      },
      '/api/maintenance/due': { get: op('Các hạng mục bảo trì đã tới hạn trên mọi máy', { tags: ['Thống kê'] }) },
      '/api/printers/{id}/maintenance': {
        get: op('Hạng mục bảo trì theo giờ in của máy', { tags: ['Thống kê'], params: [PRINTER_ID] }),
        post: op('Thêm hạng mục bảo trì', {
          tags: ['Thống kê'],
          params: [PRINTER_ID],
          body: commandBody({ name: { type: 'string' }, intervalHours: { type: 'integer', minimum: 1 } }, ['name', 'intervalHours']),
          status: 201,
        }),
      },
      '/api/printers/{id}/maintenance/{taskId}': {
        put: op('Sửa hạng mục bảo trì', {
          tags: ['Thống kê'],
          params: [PRINTER_ID, idParam('taskId', 'Id hạng mục')],
          body: commandBody({ name: { type: 'string' }, intervalHours: { type: 'integer', minimum: 1 } }),
        }),
        delete: op('Xoá hạng mục bảo trì', { tags: ['Thống kê'], params: [PRINTER_ID, idParam('taskId', 'Id hạng mục')] }),
      },
      '/api/printers/{id}/maintenance/{taskId}/done': {
        post: op('Đánh dấu đã bảo trì, đếm lại giờ in', { tags: ['Thống kê'], params: [PRINTER_ID, idParam('taskId', 'Id hạng mục')] }),
      },
      '/api/settings': { get: op('Cấu hình', { tags: ['Hệ thống'] }), put: op('Cập nhật cấu hình', { tags: ['Hệ thống'], body: { type: 'object' } }) },
      '/api/apikeys': {
        get: op('Danh sách API key (đã che)', { tags: ['Hệ thống'] }),
        post: op('Tạo API key (chỉ từ máy local)', { tags: ['Hệ thống'], body: commandBody({ name: { type: 'string' } }), status: 201 }),
      },
      '/api/apikeys/{id}/reveal': { get: op('Xem đầy đủ API key (chỉ từ máy local)', { tags: ['Hệ thống'], params: [idParam('id', 'Id key')] }) },
      '/api/apikeys/{id}': { delete: op('Xoá API key (chỉ từ máy local)', { tags: ['Hệ thống'], params: [idParam('id', 'Id key')] }) },
      '/api/service': {
        get: op('Trạng thái chạy nền cùng hệ điều hành', { tags: ['Hệ thống'] }),
        post: op('Cài hoặc gỡ chạy nền (chỉ từ máy local)', { tags: ['Hệ thống'], body: commandBody({ action: { type: 'string', enum: ['install', 'uninstall'] } }) }),
      },
      '/api/notify/test': {
        post: op('Gửi một tin nhắn Telegram thử theo cấu hình đang lưu', {
          tags: ['Hệ thống'],
          body: commandBody({ chatId: { type: 'string' }, botToken: { type: 'string', description: 'Chỉ nhận khi gọi từ máy chạy agent' } }),
        }),
      },
      '/api/tunnel': { get: op('Trạng thái tunnel', { tags: ['Tunnel'] }) },
      '/api/tunnel/start': { post: op('Bật tunnel', { tags: ['Tunnel'], body: commandBody({ provider: { type: 'string', enum: ['cloudflare', 'ngrok'] } }) }) },
      '/api/tunnel/stop': { post: op('Tắt tunnel', { tags: ['Tunnel'] }) },
    },
  };
}
