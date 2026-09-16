# 3D PrintAgent

Agent chạy trên máy local để quản lý nhiều máy in 3D cùng lúc: theo dõi nhiệt độ và tiến độ, đưa file vào thư viện, cắt lát mô hình STL/OBJ, in ngay hoặc xếp hàng, điều khiển máy từ xa, xem camera. Hệ thống khác gọi tới qua REST, WebSocket hoặc MCP; người dùng quản lý qua web UI; mở ra Internet bằng Cloudflare Tunnel hoặc ngrok.

| Giao diện | Địa chỉ | Dùng cho |
| --- | --- | --- |
| Web UI | `http://<host>:7790` | Thêm máy in, thư viện file, hàng đợi, điều khiển, camera, tunnel, API key |
| REST API | `http://<host>:7790/api` | Ứng dụng web, backend, Home Assistant, script |
| WebSocket | `ws://<host>:7790/ws` | Nhận nhiệt độ, tiến độ, trạng thái job theo thời gian thực |
| MCP | `http://<host>:7790/mcp` (HTTP) hoặc stdio | Claude Code, Claude Desktop, Cursor và các agent AI khác |

## Máy in hỗ trợ

| Driver | Máy | Định dạng | Điều khiển |
| --- | --- | --- | --- |
| `octoprint` | Mọi máy chạy qua OctoPrint (OctoPi, Raspberry Pi) | G-code | Đầy đủ: nhiệt độ, di chuyển, quạt, tốc độ, G-code, nạp/rút nhựa, camera |
| `moonraker` | Klipper qua Moonraker (Mainsail, Fluidd, Creality K1 root, Voron...) | G-code | Đầy đủ |
| `prusalink` | Prusa MK4, MK3.9, XL, MINI, Core One | G-code, BGCode | Upload, in, tạm dừng, tiếp tục, huỷ; camera khi nhập `cameraUrl` |
| `bambu` | Bambu Lab X1, X2D, P1, P2S, A1, A2L, H2 (H2D, H2D Pro, H2S, H2C) qua mạng LAN | 3MF, G-code | Đầy đủ, kèm AMS (xem khay, nạp/rút nhựa), đèn, HMS, camera |
| `virtual` | Máy in mô phỏng | G-code, BGCode, 3MF | Đầy đủ, dùng để thử tích hợp khi chưa có máy thật |

Chưa hỗ trợ máy Marlin cắm trực tiếp qua USB/serial: hãy đặt OctoPrint hoặc Klipper phía trước. Không dùng Bambu Cloud, mọi kết nối Bambu đi qua LAN (MQTT cổng 8883, FTPS cổng 990).

## Yêu cầu

- Node.js >= 22.13 (dùng SQLite có sẵn trong Node qua `node:sqlite`, không cần module native)
- Tuỳ chọn: `cloudflared` hoặc `ngrok` để mở tunnel công khai
- Tuỳ chọn: `ffmpeg` để lấy ảnh camera của Bambu X1, X2D, P2S và dòng H2 (RTSPS). P1, A1, A2L không cần.

## Cài đặt và chạy

Từ mã nguồn:

```bash
yarn install
yarn build        # build web UI vào thư mục web/
yarn start        # hoặc: node bin/3d-printagent.js start --open
```

Khi gói đã được publish lên npm:

```bash
npx -y @hyydev/3d-printagent start --open
```

Lần chạy đầu agent tạo thư mục `~/.3d-printagent`, sinh một API key (`p3d_...`) và lắng nghe ở cổng 7790. Mở `http://127.0.0.1:7790`: trình duyệt trên chính máy chạy agent được vào thẳng không cần key.

Chưa có máy in thật thì bấm nút máy in mô phỏng ở tab Máy in để thử toàn bộ luồng upload, hàng đợi, điều khiển và camera.

### Lệnh CLI

```
3d-printagent start [--port 7790] [--host 0.0.0.0] [--open]
3d-printagent service install|uninstall|status   # chạy nền cùng hệ điều hành
3d-printagent mcp [--url URL] [--key KEY] [--standalone]
3d-printagent printers                           # liệt kê máy in và trạng thái
3d-printagent drivers                            # driver và trường kết nối
3d-printagent discover [--timeout 12000]         # dò máy in trong LAN
3d-printagent detect <ip> [--port 80]            # đoán loại máy theo IP
3d-printagent config                             # in cấu hình hiện tại
3d-printagent key                                # in API key
3d-printagent tunnel [check|cloudflare|ngrok]
3d-printagent version
```

Biến môi trường: `PRINTAGENT3D_DATA_DIR` (thư mục dữ liệu), `PRINTAGENT3D_LANG` (`vi` hoặc `en` cho log và CLI), `PORT`, `PRINTAGENT3D_LOG_LEVEL`.

## Thêm máy in

Trong web UI: tab Máy in, nút Thêm máy in. Có thể nhập IP rồi bấm nhận diện, hoặc dò máy trong mạng LAN, sau đó thử kết nối trước khi lưu. Qua API:

```bash
curl -X POST http://127.0.0.1:7790/api/printers \
  -H "x-api-key: p3d_xxx" -H "content-type: application/json" \
  -d '{"name":"Voron 2.4","driver":"moonraker","connection":{"host":"192.168.1.40"}}'
```

Thông tin cần cho từng loại máy:

- **OctoPrint**: `host`, `apiKey` (Settings → Application Keys hoặc API trong OctoPrint). Agent tự lấy địa chỉ ảnh camera từ cài đặt webcam của OctoPrint, chỉ nhập `cameraUrl` khi muốn ghi đè.
- **Klipper/Moonraker**: `host`. Bỏ trống cổng thì đi qua nginx của Mainsail/Fluidd (cổng 80), nhập 7125 để gọi thẳng Moonraker. Cần `apiKey` nếu Moonraker không để IP của agent trong `trusted_clients`. Camera lấy từ danh sách webcam của Moonraker.
- **PrusaLink**: `host`, `username` (mặc định `maker`) và `password` hiển thị trong menu Settings → Network → PrusaLink của máy, hoặc `apiKey` với firmware cũ.
- **Bambu Lab**: `host`, `serial` (trong phần thông tin máy trên màn hình hoặc Bambu Studio), `accessCode` (8 ký tự, trong phần cài đặt mạng/LAN trên màn hình máy). Bật chế độ LAN Only; với firmware mới có Authorization Control thì bật thêm Developer Mode để bên thứ ba được điều khiển. `model` giúp chọn đúng cách lấy camera.

Mỗi máy có hai tuỳ chọn quan trọng:

- **Bàn in đã trống** (`bedClear`): khi một bản in bắt đầu, agent đánh dấu bàn in chưa trống. Lệnh in ngay tiếp theo bị từ chối cho tới khi có người xác nhận đã lấy bản in cũ ra. Cơ chế này ngăn máy in đè lên vật đang nằm trên bàn.
- **Tự in hàng đợi** (`autoStartQueue`): khi máy rảnh và bàn in đã được xác nhận trống, agent tự chạy job tiếp theo trong hàng đợi.

## Giao diện web

- **Tổng quan**: số máy trực tuyến, hàng đợi, thư viện, tunnel, thẻ từng máy với tiến độ và nhiệt độ, lệnh in gần đây.
- **Máy in**: trạng thái realtime, biểu đồ nhiệt độ 30 phút (kèm bảng số liệu), camera tự làm mới, điều khiển nhiệt độ (có preset PLA/PETG/ABS/TPU), di chuyển trục, quạt, tốc độ in, đèn, nạp và rút nhựa, console G-code kèm thư viện lệnh có sẵn (lọc theo loại máy, mỗi lệnh có mô tả tiếng Việt), AMS và mã lỗi HMS của Bambu, file đang nằm trên máy.
- **Thư viện file**: kéo thả nhiều file, thêm từ URL, đọc metadata slicer (thời gian in, filament, độ cao lớp, đầu phun, số plate của 3MF) và ảnh xem trước nhúng trong file. Nhận cả mô hình STL, OBJ và 3MF chưa slice để cắt lát ngay trên agent.
- **Lệnh in**: lọc theo trạng thái và máy, huỷ, chạy job đang chờ, in lại. Job đang chờ đổi được thứ tự và độ ưu tiên, hiện giờ bắt đầu và giờ xong dự kiến; job đã in hiện số gam nhựa dùng, nhựa thải và chi phí.
- **Nhựa và thống kê**: cuộn nhựa gắn theo máy và khay, tự trừ khối lượng sau mỗi lần in; tỉ lệ thành công, nhựa dùng, nhựa thải (support, brim/skirt, xả màu, bản in hỏng), chi phí nhựa, điện, hao mòn theo ngày, theo máy, theo loại nhựa và theo file; việc bảo trì tới hạn.
- **Tunnel**, **API & MCP**, **Cài đặt**: xem các mục bên dưới.

Giao diện có tiếng Việt và tiếng Anh, chạy tốt trên điện thoại.

## Cắt lát

Agent gọi CLI của **OrcaSlicer** hoặc **BambuStudio** cài sẵn trên chính máy chạy agent, không cần đăng nhập tài khoản và không mở giao diện.

- Tự dò theo thứ tự OrcaSlicer rồi BambuStudio ở các đường dẫn quen thuộc của macOS, Linux và Windows. Muốn chỉ tay thì đặt `slicer.binPath` trong Cài đặt (chỉ sửa được từ máy chạy agent).
- Trên Linux không có màn hình, agent tự chạy lại qua `xvfb-run` khi slicer đòi display.
- Profile máy, chất lượng in và sợi nhựa đọc thẳng từ thư mục cài đặt của slicer, bao gồm cả các hãng ngoài Bambu (Creality, Prusa, Voron, Elegoo, Anycubic, Qidi...). Agent tự gộp chuỗi `inherits` và cả các file khai trong `include` trước khi gọi CLI, vì CLI không tự lần theo và sẽ rơi về thông số mặc định. Máy Bambu đời mới để G-code khởi động, kết thúc, đổi lớp trong các file `include` riêng, thiếu bước gộp này là máy in chạy bằng G-code khởi động mặc định của slicer: sai nhiệt độ lớp đầu, không cân bàn, không lau vòi. Preset tự lưu trong slicer cũng lần ngược đúng lên profile gốc của chính hãng máy đó, vì mười hai hãng cùng đặt tên profile gốc giống nhau (`fdm_filament_pet`).
- Máy nhận 3MF thì giữ nguyên `.gcode.3mf`, máy chỉ nhận G-code thì agent rút `Metadata/plate_1.gcode` ra thành `.gcode`.
- Kết quả vào thẳng thư viện kèm ảnh khay in, thời gian dự kiến và khối lượng nhựa, bấm In là chạy.
- Ngoài profile, hộp thoại cắt lát còn chỉnh được chiều cao lớp và lớp đầu, đường nối, là bề mặt, số vòng thành, số lớp mặt trên/dưới, tỉ lệ và kiểu đổ đầy, tốc độ thành ngoài/trong và đổ đầy (mm/s), hỗ trợ và kiểu hỗ trợ, nhiệt độ vòi phun và bàn nhiệt, viền bám, chế độ lọ hoa, tỉ lệ phóng, góc xoay, số bản trên khay.
- Thiết lập không có trong form thì nhập ở ô "Thiết lập khác" theo dạng `khoá = giá trị` (`extra` trong API), dùng đúng tên thiết lập của slicer, ví dụ `top_surface_pattern = monotonic`.
- Agent tự đo mô hình khi nhận file: kích thước bao, thể tích đặc, số tam giác và tỉ lệ diện tích mặt úp xuống dốc hơn 30 độ (không tính mặt nằm trên bàn). Đọc được STL nhị phân, STL chữ, OBJ và cả 3MF chưa cắt lát (theo đúng transform của build item).
- Nút "AI gợi ý" trong hộp thoại cắt lát gửi các số đo đó, thông tin máy in, profile đang chọn và mô tả mục đích in của người dùng tới Anthropic, nhận về bộ tham số kèm lý do, xem xong mới bấm Áp dụng. Cần nhập khoá xác thực ở Cài đặt trên máy chạy agent, chọn kiểu gửi là khoá API (`x-api-key`) hay auth token (`Authorization: Bearer`) tuỳ nhà cung cấp; giá trị nằm lại trên máy đó và chỉ gửi đi khi bấm nút.

## Hàng đợi, nhựa và bảo trì

- **Hàng đợi chung**: khi in chọn "Máy nào phù hợp rảnh trước" để job chạy trên máy tương thích rảnh đầu tiên, có đúng loại nhựa và bàn trống. Bật "In gấp" để chen lên trước các job thường.
- **In hàng loạt (farm)**: bật "In đồng thời trên nhiều máy" trong hộp thoại in, tích các máy rồi bấm In: mọi máy đã chọn bắt đầu in cùng file ngay lúc đó, mỗi máy một bản, không xếp hàng. Máy đang bận hoặc chưa xác nhận bàn trống bị bỏ qua (có công tắc xác nhận bàn trống cho cả nhóm). Mỗi job hiện "Lô 2/5", huỷ được cả lô một lần.
- **Thời gian dự kiến** được hiệu chỉnh theo lịch sử từng máy: agent so thời gian in thật với ước tính của slicer và dùng hệ số đó cho các job sau.
- **Đo nhựa**: agent đọc G-code để tách lượng nhựa thành sản phẩm và nhựa thải (support, brim/skirt/raft, xả khi đổi màu); bản in hỏng hoặc huỷ tính theo phần đã in tới lớp dừng.
- **Kiểm tra trước khi in**: hộp thoại in hiện số gam cần, phần thải, giờ xong, chi phí và cảnh báo khi cuộn nhựa đang gắn không đủ hoặc sai loại.
- **Chi phí**: đặt giá điện, công suất và giá nhựa mặc định ở Cài đặt; công suất và hao mòn mỗi giờ riêng của từng máy trong hộp thoại sửa máy.
- **Bảo trì** theo giờ in (tra dầu trục, vệ sinh vòi phun, thay PTFE...), mỗi máy có sẵn việc mặc định và thêm được việc riêng; tới hạn thì hiện ở trang máy, trang Tổng quan và gửi Telegram.
- **Tự xoay** mô hình về hướng cần ít support nhất, **gom khay** nhiều file (mỗi file nhiều bản) lên một bàn in theo kích thước máy.
- **Chống trùng**: file tải lên trùng nội dung (SHA-256) dùng lại file cũ; cắt lát lại cùng mô hình với cùng thông số thì lấy kết quả từ cache.

## Cảnh báo và chẩn đoán lỗi

- Máy Bambu báo mã HMS dạng `HMS_0300_1A00_0002_0001`. Agent tải bảng mã chính thức của hãng về `~/.3d-printagent/hms-catalog.json` (theo ngôn ngữ đang đặt, làm mới sau 30 ngày) rồi hiện thẳng câu mô tả kèm mức độ: nghiêm trọng, nặng, cần lưu ý, thông tin. Không tải được thì vẫn hiện mã trần, máy in không bị ảnh hưởng.
- Thẻ "Cảnh báo máy in" có nút Chẩn đoán: agent gửi trạng thái máy, nhiệt độ, bản in đang chạy, các mã HMS đã dịch nghĩa và kết quả vài job gần đây cho model, nhận về tóm tắt, danh sách nguyên nhân khả dĩ và các bước xử lý. Dùng chung khoá với AI gợi ý.
- Prompt hệ thống của bốn tính năng AI (gợi ý cắt lát, chẩn đoán máy, soi ảnh camera, xem lại file trước khi in) nằm trong `src/core/prompts/*.md`, sửa thẳng ở thẻ "Prompt AI" trong tab Cài đặt. Bản tự sửa lưu thành `.md` trong `~/.3d-printagent/prompts/`, agent đọc lại file ở mỗi lần hỏi nên có hiệu lực ngay; bấm "Về bản mặc định" hoặc xoá file là quay lại bản gốc. Chỉ sửa được từ chính máy chạy agent.

## Xác thực

- Mọi request cần header `x-api-key: p3d_xxx` hoặc `Authorization: Bearer p3d_xxx`. WebSocket và thẻ `<img>` dùng query `?apiKey=`.
- Request từ chính máy chạy agent (trình duyệt mở `http://127.0.0.1:7790`) được miễn key. Agent chỉ miễn khi địa chỉ, header `Host`, `Origin` đều là loopback và không có header proxy, nên request qua tunnel hoặc do website khác khởi tạo không lọt được.
- Tạo, xem đầy đủ, xoá API key và sửa các cài đặt nhạy cảm (giới hạn an toàn, nguồn file, `auth`, `server`) chỉ làm được từ máy local.
- Sai key 10 lần trong một phút thì địa chỉ đó bị chặn 5 phút.

## Giới hạn an toàn

Áp dụng cho mọi lệnh từ web UI, REST, WebSocket và MCP:

| Cài đặt | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `safety.maxNozzleTemp` | 300 | Nhiệt đầu phun tối đa (°C) |
| `safety.maxBedTemp` | 120 | Nhiệt bàn tối đa |
| `safety.maxChamberTemp` | 65 | Nhiệt buồng tối đa |
| `safety.maxJogMm` | 100 | Quãng di chuyển tối đa mỗi lệnh |
| `safety.allowGcode` | `true` | Cho gửi G-code tuỳ ý; tắt khi cho AI hoặc hệ thống bên ngoài điều khiển |
| `safety.blockedGcodes` | `M502`, `M997` | Lệnh bị chặn (reset EEPROM, cập nhật firmware) |

Nhiệt độ trong G-code gửi trực tiếp (`M104`, `M109`, `M140`, `M190`, `M141`, `M191`) cũng bị kiểm tra. Về gốc và di chuyển trục bị từ chối khi máy đang in.

## REST API

Đặc tả đầy đủ: `GET /openapi.json`. Bản rút gọn cho AI: [llms.txt](llms.txt) ([English](llms.en.txt)).

### In một file

```bash
# Upload và in ngay, một bước
curl -X POST http://127.0.0.1:7790/api/print \
  -H "x-api-key: p3d_xxx" \
  -F "printerId=prn_1a2b3c4d5e6f" -F "mode=now" -F "confirmBedClear=true" \
  -F "file=@benchy.gcode"

# Tải từ URL rồi xếp hàng
curl -X POST http://127.0.0.1:7790/api/print \
  -H "x-api-key: p3d_xxx" -H "content-type: application/json" \
  -d '{"printerId":"prn_1a2b3c4d5e6f","url":"https://example.com/benchy.gcode","mode":"queue"}'

# In một file đã có trong thư viện
curl -X POST http://127.0.0.1:7790/api/jobs \
  -H "x-api-key: p3d_xxx" -H "content-type: application/json" \
  -d '{"printerId":"prn_1a2b3c4d5e6f","fileId":"fil_7c1d2e3f4a5b","mode":"now"}'
```

Với Bambu Lab: gửi file `.gcode.3mf` đã slice, chọn `plate`, bật `useAms` và truyền `amsMapping` để ánh xạ filament sang khay AMS; các tuỳ chọn `timelapse`, `bedLeveling`, `flowCalibration`, `vibrationCalibration`.

Job đi theo trạng thái `queued` → `uploading` → `starting` → `printing` → `completed`, hoặc dừng ở `paused`, `failed`, `canceled`.

### Điều khiển máy

```bash
curl -X POST http://127.0.0.1:7790/api/printers/prn_1a2b3c4d5e6f/command \
  -H "x-api-key: p3d_xxx" -H "content-type: application/json" \
  -d '{"action":"temperature","params":{"heater":"bed","target":60}}'

curl http://127.0.0.1:7790/api/printers/prn_1a2b3c4d5e6f/snapshot \
  -H "x-api-key: p3d_xxx" -o snapshot.jpg
```

Các `action`: `pause`, `resume`, `cancel`, `temperature`, `home`, `jog`, `fan`, `speed`, `light`, `gcode`, `loadFilament`, `unloadFilament`, `emergencyStop`, `connect`. Mỗi lệnh cũng có endpoint riêng như `POST /api/printers/:id/pause`, `/temperature`, `/emergency-stop`.

Nạp và rút nhựa chạy khác nhau theo máy: Marlin (OctoPrint) và Klipper dùng lệnh đùn cơ bản nên chạy được trên mọi firmware, Klipper ưu tiên gọi macro `LOAD_FILAMENT`/`UNLOAD_FILAMENT` nếu máy có sẵn, Bambu dùng lệnh AMS riêng và nhận thêm `slot`. Máy tự gia nhiệt trước khi đùn nếu đầu phun còn nguội, và từ chối nếu nhiệt độ dưới 170°C hoặc máy đang in. PrusaLink không mở G-code tuỳ ý nên không hỗ trợ.

### Lỗi

```json
{ "error": { "code": "conflict", "key": "error.bed_not_clear", "message": "...", "details": null } }
```

`key` là mã ổn định để client tự dịch hoặc phân nhánh; `message` đã dịch theo `x-locale`, `?lang=` hoặc `accept-language`.

## WebSocket

```js
const ws = new WebSocket('ws://127.0.0.1:7790/ws?apiKey=p3d_xxx')
ws.onmessage = (event) => {
  const message = JSON.parse(event.data)
  if (message.type === 'event' && message.event === 'printer.status') console.log(message.payload)
}
ws.onopen = () => {
  ws.send(JSON.stringify({ type: 'subscribe', payload: { events: ['status', 'job'] } }))
  ws.send(JSON.stringify({ id: 1, type: 'printer.command', payload: { printerId: 'prn_1a2b3c4d5e6f', action: 'light', params: { on: true } } }))
}
```

Kênh sự kiện: `status` (`printer.status`), `printer` (`printer.changed`), `job` (`job.created`, `job.updated`, `job.finished`...), `file`, `tunnel`, `log`. Danh sách lệnh đầy đủ trong [llms.txt](llms.txt).

## MCP

### Streamable HTTP

```bash
claude mcp add --transport http 3d-printagent http://127.0.0.1:7790/mcp --header "x-api-key: p3d_xxx"
```

### stdio

```json
{
  "mcpServers": {
    "3d-printagent": {
      "command": "npx",
      "args": ["-y", "@hyydev/3d-printagent", "mcp"],
      "env": { "PRINTAGENT3D_URL": "http://127.0.0.1:7790", "PRINTAGENT3D_API_KEY": "p3d_xxx" }
    }
  }
}
```

Chạy từ mã nguồn thì thay bằng `"command": "node", "args": ["/đường/dẫn/3d-printagent/bin/3d-printagent.js", "mcp"]`. Mặc định stdio là cầu nối tới agent đang chạy; `--standalone` tự nạp máy in khi agent không chạy (không dùng song song với agent vì hai tiến trình sẽ cùng kết nối một máy).

34 tool: xem trạng thái máy, thêm/xoá máy, dò máy trong LAN, quản lý thư viện, in file, hàng đợi, lịch sử nhiệt độ của máy và của từng job, tạm dừng/tiếp tục/huỷ, nhiệt độ, G-code, về gốc, di chuyển, quạt, tốc độ, đèn, nạp/rút nhựa, dừng khẩn cấp, xác nhận bàn in trống, và `get_snapshot` trả ảnh camera để mô hình tự nhìn bản in.

## Tunnel công khai

Tab Tunnel trong web UI, hoặc `3d-printagent tunnel cloudflare|ngrok`.

- **Cloudflare**: không cần tài khoản thì dùng quick tunnel (địa chỉ `*.trycloudflare.com` đổi mỗi lần chạy). Có tài khoản thì nhập token của named tunnel và hostname cố định.
- **ngrok**: nhập authtoken, tuỳ chọn domain cố định và region.

Tunnel không bật được khi đang tắt yêu cầu API key hoặc chưa có key nào. Mọi request qua tunnel đều phải gửi key, kể cả khi mở web UI: trình duyệt sẽ hỏi key ở lần đầu.

## Cấu trúc dữ liệu

```
~/.3d-printagent/
├── config.json      # cấu hình, API key, tunnel
├── printers.json    # máy in, thông tin kết nối
├── data.db          # SQLite: lịch sử job, nhiệt độ/quạt/tốc độ mỗi 5 giây, cuộn nhựa, bảo trì
├── library/         # file G-code/3MF, ảnh xem trước, index.json
├── prompts/         # tuỳ chọn: prompt hệ thống ghi đè bản trong src/core/prompts
├── tmp/             # file tạm khi upload
└── logs/            # log theo ngày
```

## Chạy nền

`3d-printagent service install` đăng ký agent tự chạy khi đăng nhập: launchd trên macOS (`~/Library/LaunchAgents`), systemd user service trên Linux, Task Scheduler trên Windows. Gỡ bằng `service uninstall`. Cũng làm được ở tab Cài đặt khi mở UI trên chính máy chạy agent.

## Phát triển

```bash
yarn install
yarn dev          # agent với node --watch
yarn ui:dev       # Vite dev server, proxy /api, /ws, /mcp sang cổng 7790
yarn test         # test driver, hàng đợi, đọc metadata
yarn lint
yarn --cwd ui lint
```

Web UI dùng React 19, Vite, Tailwind CSS v4 và shadcn/ui, nằm trong `ui/` và build ra `web/`.

## Giấy phép

MIT
