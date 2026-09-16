import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ArrowDown, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUp, ArrowUpFromLine, BookOpen, Flame, Home, Lightbulb, LightbulbOff, Ruler, Send, Spool, TriangleAlert, Wind, Gauge } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SelectField } from '@/components/select-field'
import { useConfirm } from '@/components/confirm-dialog'
import { useAgent } from '@/hooks/use-agent'
import { useCommand } from '@/hooks/use-command'
import { useI18n, useT } from '@/i18n'
import { CALIBRATION_OPTIONS, type CalibrationOption, type Printer } from '@/lib/api'
import { GCODE_GROUPS, describeGcode, filterGcodes, type GcodeCommand } from '@/lib/gcode-catalog'
import { formatDuration } from '@/lib/format'

const PRESETS = [
  { name: 'PLA', nozzle: 210, bed: 60 },
  { name: 'PETG', nozzle: 240, bed: 80 },
  { name: 'ABS', nozzle: 250, bed: 100 },
  { name: 'TPU', nozzle: 225, bed: 50 },
]
const JOG_STEPS = [0.1, 1, 10, 50]
const MOTION_LOCKED = new Set(['printing', 'paused', 'busy'])
// Cân bàn nóng 80 độ tốn hơn nửa tiếng nên để người dùng tự bật, giống màn hiệu chỉnh trên máy.
const CALIBRATION_OFF_BY_DEFAULT = new Set<CalibrationOption>(['highTempBed'])
const FAN_PRESETS = [0, 25, 50, 75, 100]
const BAMBU_SPEEDS = [
  { key: 'silent', percent: 50 },
  { key: 'standard', percent: 100 },
  { key: 'sport', percent: 124 },
  { key: 'ludicrous', percent: 166 },
] as const

export const canTemperature = (printer: Printer) => printer.capabilities.temperature
export const canMotion = (printer: Printer) => printer.capabilities.home || printer.capabilities.jog
export const canFanSpeed = (printer: Printer) => printer.capabilities.fan || printer.capabilities.speed || printer.capabilities.light
export const canFilament = (printer: Printer) => printer.capabilities.filament
export const canGcode = (printer: Printer) => printer.capabilities.gcode
export const canCalibrate = (printer: Printer) => printer.capabilities.calibrate && printer.calibrations.length > 0

function Section({ printer, title, icon: Icon, children }: { printer: Printer; title: string; icon: typeof Flame; children: React.ReactNode }) {
  const t = useT()
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="size-4" /> {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {printer.status.online ? null : <p className="text-muted-foreground text-xs">{t('printer.offline_hint')}</p>}
        {children}
      </CardContent>
    </Card>
  )
}

export function TemperatureControls({ printer }: { printer: Printer }) {
  const t = useT()
  const { run, pending } = useCommand(printer)
  const [values, setValues] = useState({ nozzle: '', bed: '', chamber: '' })
  const enabled = printer.capabilities.temperature && printer.status.online
  const heaters = (['nozzle', 'bed', 'chamber'] as const).filter((heater) => heater !== 'chamber' || printer.status.temps.chamber)

  const set = async (heater: 'nozzle' | 'bed' | 'chamber', target: number) => {
    const result = await run('temperature', { heater, target }, t('controls.temp_set', { heater: t(`temp.${heater}`), target }))
    if (result) setValues((prev) => ({ ...prev, [heater]: '' }))
  }

  if (!canTemperature(printer)) return null
  return (
    <Section printer={printer} title={t('controls.temperature')} icon={Flame}>
      <div className="grid gap-2 sm:grid-cols-2">
        {heaters.map((heater) => (
          <form
            key={heater}
            className="flex items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault()
              if (values[heater] !== '') void set(heater, Number(values[heater]))
            }}
          >
            <span className="text-muted-foreground w-16 shrink-0 text-xs">{t(`temp.${heater}`)}</span>
            <Input
              type="number"
              min={0}
              className="h-8"
              placeholder={String(Math.round(printer.status.temps[heater]?.target ?? 0))}
              value={values[heater]}
              disabled={!enabled}
              onChange={(event) => setValues((prev) => ({ ...prev, [heater]: event.target.value }))}
            />
            <Button type="submit" size="sm" variant="outline" disabled={!enabled || values[heater] === '' || pending !== null}>
              {t('controls.set')}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={!enabled || pending !== null} onClick={() => void set(heater, 0)}>
              {t('controls.off')}
            </Button>
          </form>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((preset) => (
          <Button
            key={preset.name}
            size="xs"
            variant="outline"
            disabled={!enabled || pending !== null}
            onClick={async () => {
              await set('nozzle', preset.nozzle)
              await set('bed', preset.bed)
            }}
          >
            {preset.name} {preset.nozzle}/{preset.bed}
          </Button>
        ))}
        <Button
          size="xs"
          variant="ghost"
          disabled={!enabled || pending !== null}
          onClick={async () => {
            await set('nozzle', 0)
            await set('bed', 0)
          }}
        >
          {t('controls.cooldown')}
        </Button>
      </div>
    </Section>
  )
}

export function MotionControls({ printer }: { printer: Printer }) {
  const t = useT()
  const { run, pending } = useCommand(printer)
  const [step, setStep] = useState(10)
  const locked = MOTION_LOCKED.has(printer.status.state) || !printer.status.online
  const caps = printer.capabilities
  // Firmware Bambu chỉ về gốc cả ba trục một lượt, nút về gốc từng trục sẽ làm sai kỳ vọng.
  const homeAxes = caps.home && printer.driver !== 'bambu'
  if (!canMotion(printer)) return null

  const jog = (axis: 'x' | 'y' | 'z', direction: 1 | -1) => void run('jog', { [axis]: step * direction })
  const pad = 'size-9'

  return (
    <Section printer={printer} title={t('controls.motion')} icon={Home}>
      {locked && printer.status.online ? <p className="text-muted-foreground text-xs">{t('controls.motion_locked')}</p> : null}
      <div className="flex flex-wrap items-start gap-4">
        {caps.jog ? (
          <div className="grid grid-cols-3 gap-1">
            <span />
            <Button variant="outline" size="icon" className={pad} disabled={locked || pending !== null} onClick={() => jog('y', 1)} title="Y+">
              <ArrowUp />
            </Button>
            <span />
            <Button variant="outline" size="icon" className={pad} disabled={locked || pending !== null} onClick={() => jog('x', -1)} title="X-">
              <ArrowLeft />
            </Button>
            <Button variant="outline" size="icon" className={pad} disabled={locked || pending !== null || !homeAxes} onClick={() => void run('home', { axes: ['x', 'y'] })} title={t('controls.home_xy')}>
              <Home />
            </Button>
            <Button variant="outline" size="icon" className={pad} disabled={locked || pending !== null} onClick={() => jog('x', 1)} title="X+">
              <ArrowRight />
            </Button>
            <span />
            <Button variant="outline" size="icon" className={pad} disabled={locked || pending !== null} onClick={() => jog('y', -1)} title="Y-">
              <ArrowDown />
            </Button>
            <span />
          </div>
        ) : null}
        {caps.jog ? (
          <div className="grid gap-1">
            <Button variant="outline" size="sm" className="h-9 w-14" disabled={locked || pending !== null} onClick={() => jog('z', 1)}>
              Z+
            </Button>
            <Button variant="outline" size="sm" className="h-9 w-14" disabled={locked || pending !== null || !homeAxes} onClick={() => void run('home', { axes: ['z'] })}>
              <Home className="size-3.5" /> Z
            </Button>
            <Button variant="outline" size="sm" className="h-9 w-14" disabled={locked || pending !== null} onClick={() => jog('z', -1)}>
              Z-
            </Button>
          </div>
        ) : null}
        <div className="space-y-2">
          {caps.jog ? (
            <div className="flex gap-1">
              {JOG_STEPS.map((value) => (
                <Button key={value} size="xs" variant={value === step ? 'secondary' : 'ghost'} onClick={() => setStep(value)}>
                  {value} mm
                </Button>
              ))}
            </div>
          ) : null}
          {caps.home ? (
            <Button size="sm" variant="outline" disabled={locked || pending !== null} onClick={() => void run('home', {}, t('controls.homing'))}>
              <Home /> {t('controls.home_all')}
            </Button>
          ) : null}
          {printer.status.position ? (
            <div className="text-muted-foreground font-mono text-xs tabular-nums">
              X {printer.status.position.x ?? '-'} · Y {printer.status.position.y ?? '-'} · Z {printer.status.position.z ?? '-'}
            </div>
          ) : null}
        </div>
      </div>
    </Section>
  )
}

function PercentControl({
  icon: Icon,
  label,
  current,
  min,
  max,
  slider = true,
  presets,
  disabled,
  onCommit,
  hint,
  children,
}: {
  icon: typeof Flame
  label: string
  current: number | null
  min: number
  max: number
  slider?: boolean
  presets?: number[]
  disabled: boolean
  onCommit: (value: number) => Promise<unknown>
  hint?: string
  children?: React.ReactNode
}) {
  const t = useT()
  const [dragValue, setDragValue] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const shown = dragValue ?? current
  const commit = async (value: number) => {
    await onCommit(Math.round(Math.min(max, Math.max(min, value))))
    setDragValue(null)
    setDraft('')
  }
  const commitDrag = () => void (dragValue !== null && commit(dragValue))

  return (
    <div className="space-y-1.5">
      <span className="text-muted-foreground flex justify-between text-xs">
        <span className="flex items-center gap-1">
          <Icon className="size-3" /> {label}
        </span>
        <span className="text-foreground tabular-nums">{shown === null ? '-' : `${shown}%`}</span>
      </span>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (draft !== '' && Number.isFinite(Number(draft))) void commit(Number(draft))
        }}
      >
        {slider ? (
          <input
            type="range"
            min={min}
            max={max}
            step={5}
            value={shown ?? min}
            disabled={disabled}
            aria-label={label}
            className="accent-brand min-w-0 flex-1"
            onChange={(event) => setDragValue(Number(event.target.value))}
            onPointerUp={commitDrag}
            onKeyUp={commitDrag}
          />
        ) : (
          <div className="flex min-w-0 flex-1 flex-wrap gap-1">{children}</div>
        )}
        <div className="relative w-20 shrink-0">
          <Input
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            className="h-8 pr-6"
            placeholder={current === null ? '' : String(current)}
            value={draft}
            disabled={disabled}
            aria-label={label}
            onChange={(event) => setDraft(event.target.value)}
          />
          <span className="text-muted-foreground pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs">%</span>
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={disabled || draft === ''}>
          {t('controls.set')}
        </Button>
      </form>
      {presets ? (
        <div className="flex flex-wrap gap-1">
          {presets.map((value) => (
            <Button
              key={value}
              type="button"
              size="xs"
              variant={current === value ? 'secondary' : 'outline'}
              disabled={disabled}
              onClick={() => void commit(value)}
            >
              {value === 0 ? t('controls.off') : `${value}%`}
            </Button>
          ))}
        </div>
      ) : null}
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  )
}

const AMS_EXTERNAL_SPOOL = 254

export function FilamentControls({ printer }: { printer: Printer }) {
  const t = useT()
  const { run, pending } = useCommand(printer)
  const [values, setValues] = useState({ temperature: '', length: '' })
  const [slot, setSlot] = useState(String(AMS_EXTERNAL_SPOOL))
  if (!canFilament(printer)) return null

  const ams = printer.status.extra.ams ?? []
  const bambu = printer.driver === 'bambu'
  const locked = MOTION_LOCKED.has(printer.status.state) || !printer.status.online
  const trayOptions = [
    ...ams.flatMap((unit) =>
      unit.trays.map((tray) => {
        const [unitId, trayId] = tray.id.split('-').map(Number)
        return {
          value: String(unitId * 4 + trayId),
          label: `AMS ${String.fromCharCode(65 + unitId)}${trayId + 1} · ${tray.type ?? t('printer.tray_empty')}`,
        }
      }),
    ),
    { value: String(AMS_EXTERNAL_SPOOL), label: t('printer.external_spool') },
  ]

  const send = (action: 'loadFilament' | 'unloadFilament') => {
    const params: Record<string, unknown> = {}
    if (values.temperature !== '') params.temperature = Number(values.temperature)
    if (!bambu && values.length !== '') params.length = Number(values.length)
    if (bambu && action === 'loadFilament') params.slot = Number(slot)
    void run(action, params, t(action === 'loadFilament' ? 'controls.filament_loading' : 'controls.filament_unloading'))
  }

  return (
    <Section printer={printer} title={t('controls.filament')} icon={Spool}>
      {locked && printer.status.online ? <p className="text-muted-foreground text-xs">{t('controls.filament_locked')}</p> : null}
      <div className="flex flex-wrap items-end gap-2">
        {bambu ? (
          <label className="min-w-44 flex-1 space-y-1">
            <span className="text-muted-foreground text-xs">{t('controls.filament_slot')}</span>
            <SelectField value={slot} onChange={setSlot} options={trayOptions} />
          </label>
        ) : (
          <label className="w-28 space-y-1">
            <span className="text-muted-foreground text-xs">{t('controls.filament_length')}</span>
            <Input
              type="number"
              min={10}
              max={1000}
              className="h-8"
              placeholder="100"
              value={values.length}
              disabled={locked}
              onChange={(event) => setValues((prev) => ({ ...prev, length: event.target.value }))}
            />
          </label>
        )}
        <label className="w-28 space-y-1">
          <span className="text-muted-foreground text-xs">{t('controls.filament_temp')}</span>
          <Input
            type="number"
            min={0}
            className="h-8"
            placeholder={String(Math.round(printer.status.temps.nozzle?.target || 220))}
            value={values.temperature}
            disabled={locked}
            onChange={(event) => setValues((prev) => ({ ...prev, temperature: event.target.value }))}
          />
        </label>
        <Button size="sm" variant="outline" disabled={locked || pending !== null} onClick={() => send('loadFilament')}>
          <ArrowDownToLine /> {t('controls.filament_load')}
        </Button>
        <Button size="sm" variant="outline" disabled={locked || pending !== null} onClick={() => send('unloadFilament')}>
          <ArrowUpFromLine /> {t('controls.filament_unload')}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">{t(bambu ? 'controls.filament_hint_bambu' : 'controls.filament_hint')}</p>
    </Section>
  )
}

export function FanSpeedControls({ printer }: { printer: Printer }) {
  const t = useT()
  const { run, pending } = useCommand(printer)
  const caps = printer.capabilities
  const disabled = !printer.status.online || pending !== null
  if (!canFanSpeed(printer)) return null
  const bambu = printer.driver === 'bambu'

  const setSpeed = async (percent: number) => {
    const result = await run('speed', { percent })
    if (result && bambu && result.percent !== undefined && result.percent !== percent) {
      toast.info(t('controls.speed_snapped', { percent: Number(result.percent) }))
    }
  }

  return (
    <Section printer={printer} title={t('controls.fan_speed')} icon={Wind}>
      <div className="grid gap-4">
        {caps.fan ? (
          <PercentControl
            icon={Wind}
            label={t('controls.fan')}
            current={printer.status.fanSpeed}
            min={0}
            max={100}
            presets={FAN_PRESETS}
            disabled={disabled}
            onCommit={(percent) => run('fan', { percent })}
          />
        ) : null}
        {caps.speed ? (
          <PercentControl
            icon={Gauge}
            label={t('controls.speed')}
            current={printer.status.speedFactor}
            min={bambu ? 50 : 10}
            max={bambu ? 166 : 300}
            slider={!bambu}
            disabled={disabled}
            onCommit={setSpeed}
            hint={bambu ? `${t('controls.speed_hint')} ${t('controls.speed_bambu_hint')}` : t('controls.speed_hint')}
          >
            {BAMBU_SPEEDS.map((item) => (
              <Button
                key={item.percent}
                type="button"
                size="xs"
                variant={printer.status.speedFactor === item.percent ? 'secondary' : 'outline'}
                disabled={disabled}
                onClick={() => void setSpeed(item.percent)}
              >
                {t(`controls.speed_${item.key}`)}
                <span className="text-muted-foreground tabular-nums">{item.percent}%</span>
              </Button>
            ))}
          </PercentControl>
        ) : null}
      </div>
      {caps.light ? (
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => void run('light', { on: !printer.status.light })}
        >
          {printer.status.light ? <LightbulbOff /> : <Lightbulb />}
          {printer.status.light ? t('controls.light_off') : t('controls.light_on')}
        </Button>
      ) : null}
    </Section>
  )
}

function GcodeCatalogDialog({
  printer,
  open,
  onOpenChange,
  onInsert,
  onSend,
  busy,
}: {
  printer: Printer
  open: boolean
  onOpenChange: (open: boolean) => void
  onInsert: (code: string) => void
  onSend: (code: string) => void
  busy: boolean
}) {
  const t = useT()
  const { locale } = useI18n()
  const { config } = useAgent()
  const [keyword, setKeyword] = useState('')
  const blocked = useMemo(
    () => new Set((config?.safety.blockedGcodes ?? []).map((code) => code.toUpperCase())),
    [config],
  )
  const matches = filterGcodes(printer.driver, locale, keyword)
  const groups = GCODE_GROUPS.map((group) => ({ group, items: matches.filter((item) => item.group === group) })).filter(
    (entry) => entry.items.length > 0,
  )
  const isBlocked = (command: GcodeCommand) => blocked.has(command.code.split(/\s+/)[0].toUpperCase())
  // Xoá từ khoá khi đóng để lần mở sau không thấy danh sách đã lọc từ trước
  const close = (next: boolean) => {
    if (!next) setKeyword('')
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('controls.gcode_catalog_title')}</DialogTitle>
          <DialogDescription>{t('controls.gcode_catalog_description')}</DialogDescription>
        </DialogHeader>
        <Input autoFocus value={keyword} placeholder={t('controls.gcode_search')} onChange={(event) => setKeyword(event.target.value)} />
        <div className="-mx-1 max-h-[55vh] space-y-3 overflow-y-auto px-1">
          {groups.length === 0 ? <p className="text-muted-foreground text-xs">{t('controls.gcode_catalog_empty')}</p> : null}
          {groups.map(({ group, items }) => (
            <div key={group} className="space-y-1">
              <div className="text-muted-foreground text-xs font-medium">{t(`gcode.group.${group}`)}</div>
              {items.map((command) => {
                const denied = isBlocked(command)
                return (
                  <div key={command.code} className="hover:bg-accent/40 flex items-start gap-2 rounded-md px-2 py-1.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <code className="font-mono text-sm font-medium">{command.code}</code>
                        {command.caution ? (
                          <span className="text-warn inline-flex items-center gap-1 text-[11px]">
                            <TriangleAlert className="size-3" /> {t('controls.gcode_caution')}
                          </span>
                        ) : null}
                        {denied ? <span className="text-destructive text-[11px]">{t('controls.gcode_blocked')}</span> : null}
                      </div>
                      <p className="text-muted-foreground text-xs">{describeGcode(command, locale)}</p>
                    </div>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        onInsert(command.code)
                        close(false)
                      }}
                    >
                      {t('controls.gcode_insert')}
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={denied || busy || !printer.status.online}
                      onClick={() => {
                        onSend(command.code)
                        close(false)
                      }}
                    >
                      <Send /> {t('controls.send')}
                    </Button>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function CalibrationControls({ printer }: { printer: Printer }) {
  const t = useT()
  const { run, pending } = useCommand(printer)
  const { confirm, dialog } = useConfirm()
  const [chosen, setChosen] = useState<CalibrationOption[] | null>(null)
  if (!canCalibrate(printer)) return null

  const available = printer.calibrations
  const picked = chosen ?? available.filter((item) => !CALIBRATION_OFF_BY_DEFAULT.has(item))
  const running = printer.status.extra.calibration ?? null
  const locked = !printer.status.online || MOTION_LOCKED.has(printer.status.state)

  // Máy Bambu báo tên bước bằng chữ của firmware, máy ảo báo bằng mã hạng mục nên dịch lại được.
  const stageLabel = (stage: string | null) =>
    stage && (CALIBRATION_OPTIONS as readonly string[]).includes(stage) ? t(`controls.cali_${stage}` as never) : stage

  const toggle = (option: CalibrationOption, on: boolean) =>
    setChosen(available.filter((item) => (item === option ? on : picked.includes(item))))

  const start = () =>
    confirm({
      title: t('controls.calibrate_title'),
      description: t('controls.calibrate_confirm', { items: picked.map((item) => t(`controls.cali_${item}` as never)).join(', ') }),
      confirmLabel: t('controls.calibrate_start'),
      // Người dùng vừa xác nhận bàn in trống, gửi kèm để không vướng lại chính cảnh báo đó.
      onConfirm: async () => void (await run('calibrate', { options: picked, confirmBedClear: true }, t('controls.calibrate_started'))),
    })

  return (
    <Section printer={printer} title={t('controls.calibration')} icon={Ruler}>
      {running ? (
        <p className="text-sm">
          {stageLabel(running.stage) ?? t('controls.calibrate_running')}
          {running.step && running.steps ? ` (${running.step}/${running.steps})` : ''}
          {running.remaining ? ` - ${formatDuration(running.remaining)}` : ''}
        </p>
      ) : (
        <>
          <p className="text-muted-foreground text-xs">{t('controls.calibrate_hint')}</p>
          <div className="space-y-2">
            {available.map((option) => (
              <label key={option} className="flex items-start gap-3 text-sm">
                <Switch
                  className="mt-0.5"
                  checked={picked.includes(option)}
                  disabled={locked || pending !== null}
                  onCheckedChange={(on) => toggle(option, on)}
                />
                <span className="min-w-0">
                  <span className="block">{t(`controls.cali_${option}` as never)}</span>
                  <span className="text-muted-foreground block text-xs">{t(`controls.cali_${option}_hint` as never)}</span>
                </span>
              </label>
            ))}
          </div>
          <Button size="sm" disabled={locked || pending !== null || picked.length === 0} onClick={start}>
            <Ruler /> {t('controls.calibrate_start')}
          </Button>
        </>
      )}
      {dialog}
    </Section>
  )
}

export function GcodeConsole({ printer }: { printer: Printer }) {
  const t = useT()
  const { run, pending } = useCommand(printer)
  const [value, setValue] = useState('')
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [history, setHistory] = useState<{ command: string; output: string[] }[]>([])
  if (!canGcode(printer)) return null

  const send = async (input?: string) => {
    const command = (input ?? value).trim()
    if (!command) return
    const result = await run('gcode', { gcode: command })
    if (result) {
      setHistory((prev) => [...prev.slice(-30), { command, output: result.responses ?? [] }])
      if (input === undefined) setValue('')
    }
  }

  return (
    <Section printer={printer} title={t('controls.gcode')} icon={Send}>
      <GcodeCatalogDialog
        printer={printer}
        open={catalogOpen}
        onOpenChange={setCatalogOpen}
        onInsert={setValue}
        onSend={(code) => void send(code)}
        busy={pending !== null}
      />
      {history.length > 0 ? (
        <div className="max-h-40 overflow-y-auto rounded-lg bg-zinc-950 p-2.5 font-mono text-xs leading-relaxed text-zinc-300">
          {history.map((entry, index) => (
            <div key={index}>
              <div className="text-brand">&gt; {entry.command}</div>
              {entry.output.length > 0 ? (
                entry.output.map((line, lineIndex) => (
                  <div key={lineIndex} className="whitespace-pre-wrap text-zinc-400">
                    {line}
                  </div>
                ))
              ) : (
                <div className="text-zinc-500 italic">{t('controls.gcode_no_reply')}</div>
              )}
            </div>
          ))}
        </div>
      ) : null}
      <form
        className="flex gap-1.5"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <Input
          value={value}
          placeholder="G28"
          className="h-8 font-mono"
          disabled={!printer.status.online}
          onChange={(event) => setValue(event.target.value)}
        />
        <Button type="submit" size="sm" variant="outline" disabled={!printer.status.online || !value.trim() || pending !== null}>
          <Send /> {t('controls.send')}
        </Button>
      </form>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button type="button" size="sm" variant="outline" onClick={() => setCatalogOpen(true)}>
          <BookOpen /> {t('controls.gcode_catalog')}
        </Button>
        <p className="text-muted-foreground min-w-0 flex-1 text-xs">{t('controls.gcode_hint')}</p>
      </div>
    </Section>
  )
}
