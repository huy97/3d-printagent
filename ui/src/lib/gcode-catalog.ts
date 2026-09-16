import type { Locale } from '@/i18n'

export type GcodeGroup = 'info' | 'motion' | 'temperature' | 'fan' | 'filament' | 'calibration' | 'control'

export interface GcodeCommand {
  code: string
  group: GcodeGroup
  vi: string
  en: string
  /** Chỉ hiện với các driver này, bỏ trống nghĩa là mọi máy */
  drivers?: string[]
  caution?: boolean
}

export const GCODE_GROUPS: GcodeGroup[] = ['info', 'motion', 'temperature', 'fan', 'filament', 'calibration', 'control']

const MARLIN = ['octoprint', 'virtual']
const KLIPPER = ['moonraker']
/** Chỉ máy ảo trả lại đúng nội dung máy in đáp; các driver khác gửi lệnh xong là thôi nên lệnh tra cứu vô nghĩa. */
const REPLY = ['virtual']
/** Bambu tự quản chế độ toạ độ và giới hạn mềm khi nhích trục, quạt chi tiết phải chỉ rõ P1; các mẫu thô này không dành cho nó. */
const GENERIC = [...MARLIN, ...KLIPPER]
const BAMBU = ['bambu']

export const GCODE_CATALOG: GcodeCommand[] = [
  {
    code: 'M105',
    group: 'info',
    vi: 'Đọc nhiệt độ hiện tại của đầu phun và bàn nhiệt',
    en: 'Read current nozzle and bed temperatures',
    drivers: REPLY,
  },
  {
    code: 'M114',
    group: 'info',
    vi: 'Đọc toạ độ hiện tại của đầu in',
    en: 'Read the current toolhead position',
    drivers: REPLY,
  },

  {
    code: 'G28',
    group: 'motion',
    vi: 'Đưa cả ba trục X, Y, Z về gốc',
    en: 'Home all three axes',
  },
  {
    code: 'G28 X Y',
    group: 'motion',
    vi: 'Đưa trục X và Y về gốc, giữ nguyên trục Z',
    en: 'Home X and Y only, leaving Z where it is',
    drivers: GENERIC,
  },
  {
    code: 'G28 Z',
    group: 'motion',
    vi: 'Đưa riêng trục Z về gốc',
    en: 'Home the Z axis only',
    drivers: GENERIC,
  },
  {
    code: 'G90',
    group: 'motion',
    vi: 'Chuyển sang chế độ toạ độ tuyệt đối',
    en: 'Switch to absolute positioning',
    drivers: GENERIC,
  },
  {
    code: 'G91',
    group: 'motion',
    vi: 'Chuyển sang chế độ toạ độ tương đối, hợp khi cần nhích từng chút',
    en: 'Switch to relative positioning, handy for small nudges',
    drivers: GENERIC,
  },
  {
    code: 'G1 Z10 F600',
    group: 'motion',
    vi: 'Đưa trục Z tới cao độ 10 mm với tốc độ 600 mm/phút',
    en: 'Move Z to 10 mm at 600 mm/min',
    drivers: GENERIC,
  },
  {
    code: 'G1 X100 Y100 F3000',
    group: 'motion',
    vi: 'Đưa đầu in tới toạ độ X100 Y100',
    en: 'Move the toolhead to X100 Y100',
    drivers: GENERIC,
  },
  {
    code: 'M400',
    group: 'motion',
    vi: 'Chờ mọi lệnh di chuyển trong hàng đợi chạy xong',
    en: 'Wait until every queued move has finished',
  },
  {
    code: 'M84',
    group: 'motion',
    vi: 'Ngắt điện động cơ để đẩy các trục bằng tay',
    en: 'Disable the steppers so the axes can be moved by hand',
  },

  {
    code: 'M104 S200',
    group: 'temperature',
    vi: 'Đặt đầu phun 200°C rồi chạy tiếp ngay, không chờ đủ nhiệt',
    en: 'Set the nozzle to 200°C and continue without waiting',
  },
  {
    code: 'M109 S200',
    group: 'temperature',
    vi: 'Đặt đầu phun 200°C và chờ đủ nhiệt mới chạy lệnh sau',
    en: 'Set the nozzle to 200°C and wait until it is reached',
  },
  {
    code: 'M140 S60',
    group: 'temperature',
    vi: 'Đặt bàn nhiệt 60°C, không chờ',
    en: 'Set the bed to 60°C without waiting',
  },
  {
    code: 'M190 S60',
    group: 'temperature',
    vi: 'Đặt bàn nhiệt 60°C và chờ đủ nhiệt',
    en: 'Set the bed to 60°C and wait until it is reached',
  },
  {
    code: 'M141 S40',
    group: 'temperature',
    vi: 'Đặt nhiệt độ buồng in 40°C, chỉ máy có buồng kín mới nhận',
    en: 'Set the chamber to 40°C, only on printers with an enclosure',
  },
  {
    code: 'M104 S0',
    group: 'temperature',
    vi: 'Tắt gia nhiệt đầu phun',
    en: 'Turn the nozzle heater off',
  },
  {
    code: 'M140 S0',
    group: 'temperature',
    vi: 'Tắt gia nhiệt bàn',
    en: 'Turn the bed heater off',
  },
  {
    code: 'TURN_OFF_HEATERS',
    group: 'temperature',
    vi: 'Tắt toàn bộ bộ gia nhiệt',
    en: 'Turn off every heater',
    drivers: KLIPPER,
  },

  {
    code: 'M106 S255',
    group: 'fan',
    vi: 'Chạy quạt làm mát chi tiết ở mức tối đa',
    en: 'Run the part cooling fan at full speed',
    drivers: GENERIC,
  },
  {
    code: 'M106 S128',
    group: 'fan',
    vi: 'Chạy quạt làm mát chi tiết ở khoảng 50%',
    en: 'Run the part cooling fan at about 50%',
    drivers: GENERIC,
  },
  {
    code: 'M107',
    group: 'fan',
    vi: 'Tắt quạt làm mát chi tiết',
    en: 'Turn the part cooling fan off',
    drivers: GENERIC,
  },
  {
    code: 'M106 P1 S255',
    group: 'fan',
    vi: 'Chạy quạt làm mát chi tiết ở mức tối đa',
    en: 'Run the part cooling fan at full speed',
    drivers: BAMBU,
  },
  {
    code: 'M106 P1 S0',
    group: 'fan',
    vi: 'Tắt quạt làm mát chi tiết',
    en: 'Turn the part cooling fan off',
    drivers: BAMBU,
  },

  {
    code: 'M83',
    group: 'filament',
    vi: 'Chuyển trục đùn sang chế độ tương đối, cần chạy trước khi đùn tay',
    en: 'Put the extruder in relative mode before extruding by hand',
  },
  {
    code: 'G1 E10 F100',
    group: 'filament',
    vi: 'Đùn ra 10 mm nhựa, chỉ chạy khi đầu phun đã đủ nóng',
    en: 'Extrude 10 mm of filament, only with a hot nozzle',
  },
  {
    code: 'G1 E-10 F300',
    group: 'filament',
    vi: 'Rút ngược 10 mm nhựa',
    en: 'Retract 10 mm of filament',
  },
  {
    code: 'M600',
    group: 'filament',
    vi: 'Tạm dừng bản in để thay cuộn nhựa',
    en: 'Pause the print for a filament change',
    drivers: MARLIN,
    caution: true,
  },
  {
    code: 'M701',
    group: 'filament',
    vi: 'Nạp nhựa tự động vào đầu phun',
    en: 'Load filament into the nozzle',
    drivers: MARLIN,
  },
  {
    code: 'M702',
    group: 'filament',
    vi: 'Rút nhựa tự động ra khỏi đầu phun',
    en: 'Unload filament from the nozzle',
    drivers: MARLIN,
  },

  {
    code: 'G29',
    group: 'calibration',
    vi: 'Chạy dò mặt phẳng bàn tự động, máy phải có cảm biến',
    en: 'Run auto bed levelling, requires a probe',
    drivers: MARLIN,
  },
  {
    code: 'M851 Z-1.200',
    group: 'calibration',
    vi: 'Đặt khoảng bù Z offset cho cảm biến, sai số nhỏ cũng làm hỏng bàn',
    en: 'Set the probe Z offset, a wrong value can damage the bed',
    drivers: MARLIN,
    caution: true,
  },
  {
    code: 'M92 E420',
    group: 'calibration',
    vi: 'Đặt số bước trên mỗi mm cho trục đùn',
    en: 'Set extruder steps per mm',
    drivers: MARLIN,
    caution: true,
  },
  {
    code: 'M500',
    group: 'calibration',
    vi: 'Lưu cấu hình hiện tại vào bộ nhớ máy',
    en: 'Save the current settings to EEPROM',
    drivers: MARLIN,
    caution: true,
  },
  {
    code: 'M501',
    group: 'calibration',
    vi: 'Nạp lại cấu hình đã lưu trong bộ nhớ máy',
    en: 'Reload the settings stored in EEPROM',
    drivers: MARLIN,
  },
  {
    code: 'BED_MESH_CALIBRATE',
    group: 'calibration',
    vi: 'Quét lại lưới cao độ mặt bàn',
    en: 'Re-probe the bed mesh',
    drivers: KLIPPER,
  },
  {
    code: 'SCREWS_TILT_CALCULATE',
    group: 'calibration',
    vi: 'Tính số vòng cần xoay từng ốc chỉnh bàn',
    en: 'Calculate how far to turn each bed screw',
    drivers: KLIPPER,
  },
  {
    code: 'PROBE_ACCURACY',
    group: 'calibration',
    vi: 'Đo độ lặp lại của cảm biến Z',
    en: 'Measure Z probe repeatability',
    drivers: KLIPPER,
  },
  {
    code: 'PID_CALIBRATE HEATER=extruder TARGET=200',
    group: 'calibration',
    vi: 'Hiệu chỉnh PID cho đầu phun ở 200°C, nhớ chạy SAVE_CONFIG sau khi xong',
    en: 'Tune the nozzle PID at 200°C, run SAVE_CONFIG afterwards',
    drivers: KLIPPER,
    caution: true,
  },
  {
    code: 'SET_GCODE_OFFSET Z=0.05 MOVE=1',
    group: 'calibration',
    vi: 'Chỉnh Z offset thêm 0.05 mm, dùng được ngay khi đang in',
    en: 'Shift the Z offset by 0.05 mm, usable mid-print',
    drivers: KLIPPER,
  },

  {
    code: 'M117 Ready',
    group: 'control',
    vi: 'Hiển thị một dòng chữ lên màn hình máy',
    en: 'Show a line of text on the printer display',
    drivers: [...MARLIN, ...KLIPPER],
  },
  {
    code: 'M300 S440 P200',
    group: 'control',
    vi: 'Kêu một tiếng bíp để báo hiệu',
    en: 'Beep once',
    drivers: MARLIN,
  },
  {
    code: 'M24',
    group: 'control',
    vi: 'Bắt đầu hoặc in tiếp file đang chọn trên thẻ nhớ',
    en: 'Start or resume the selected file on the SD card',
    drivers: MARLIN,
  },
  {
    code: 'M25',
    group: 'control',
    vi: 'Tạm dừng bản in đang chạy từ thẻ nhớ',
    en: 'Pause the print running from the SD card',
    drivers: MARLIN,
  },
  {
    code: 'FIRMWARE_RESTART',
    group: 'control',
    vi: 'Khởi động lại firmware sau khi máy báo lỗi, bản in đang chạy sẽ mất',
    en: 'Restart the firmware after an error, any running print is lost',
    drivers: KLIPPER,
    caution: true,
  },
  {
    code: 'M112',
    group: 'control',
    vi: 'Dừng khẩn cấp, máy tắt gia nhiệt và phải khởi động lại mới dùng tiếp',
    en: 'Emergency stop, heaters off and the printer needs a restart',
    drivers: [...MARLIN, ...KLIPPER],
    caution: true,
  },
]

export function describeGcode(command: GcodeCommand, locale: Locale) {
  return locale === 'en' ? command.en : command.vi
}

export function filterGcodes(driver: string, locale: Locale, keyword: string) {
  const needle = keyword.trim().toLowerCase()
  return GCODE_CATALOG.filter((command) => {
    if (command.drivers && !command.drivers.includes(driver)) return false
    if (!needle) return true
    return command.code.toLowerCase().includes(needle) || describeGcode(command, locale).toLowerCase().includes(needle)
  })
}
