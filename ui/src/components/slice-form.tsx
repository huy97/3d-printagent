import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Field } from '@/components/field'
import { SelectField } from '@/components/select-field'
import { reportError, useAgent } from '@/hooks/use-agent'
import { useT } from '@/i18n'
import {
  api,
  type LibraryFile,
  type SliceChatContext,
  type SliceOptions,
  type SliceResult,
  type SliceSettings,
  type SliceSnapshot,
  type SliceVersion,
  type SlicerProfiles,
  type SlicerStatus,
} from '@/lib/api'
import { rootOf, slicedDescendants } from '@/lib/library'
import { formatDuration, formatNumber } from '@/lib/format'

type NumberField = { key: string; kind: 'number'; step?: string; min?: string; max?: string; placeholder?: string; unit?: string }
type SelectSpec = { key: string; kind: 'select'; values: string[]; required?: boolean; labels?: string; empty?: string }
type SwitchSpec = { key: string; kind: 'switch' }
// Khác switch: ba trạng thái, ô trống nghĩa là giữ nguyên giá trị của profile thay vì tắt hẳn.
type BoolSpec = { key: string; kind: 'bool' }
type TextSpec = { key: string; kind: 'text'; placeholder?: string }
type OptionField = NumberField | SelectSpec | SwitchSpec | BoolSpec | TextSpec

const PLATE_TYPES = ['Cool Plate', 'Engineering Plate', 'High Temp Plate', 'Textured PEI Plate', 'Supertack Plate']

const SURFACE_PATTERNS = ['concentric', 'zig-zag', 'monotonic', 'monotonicline', 'alignedrectilinear', 'hilbertcurve', 'archimedeanchords', 'octagramspiral']

const FIELDS: Record<string, OptionField> = {
  layerHeight: { key: 'layerHeight', kind: 'number', step: '0.02', min: '0.04', max: '0.8', placeholder: '0.2', unit: 'mm' },
  firstLayerHeight: { key: 'firstLayerHeight', kind: 'number', step: '0.02', min: '0.04', max: '1', placeholder: '0.2', unit: 'mm' },
  seam: { key: 'seam', kind: 'select', values: ['nearest', 'aligned', 'back', 'random'] },
  ironing: { key: 'ironing', kind: 'select', values: ['no ironing', 'top', 'topmost', 'solid'] },
  wallLoops: { key: 'wallLoops', kind: 'number', min: '1', max: '10', placeholder: '2' },
  topLayers: { key: 'topLayers', kind: 'number', min: '0', max: '50', placeholder: '5' },
  bottomLayers: { key: 'bottomLayers', kind: 'number', min: '0', max: '50', placeholder: '3' },
  infill: { key: 'infill', kind: 'number', min: '0', max: '100', placeholder: '15', unit: '%' },
  infillPattern: {
    key: 'infillPattern',
    kind: 'select',
    values: ['grid', 'gyroid', 'cubic', 'crosshatch', 'honeycomb', 'lightning', 'concentric', 'line', 'triangles', 'tri-hexagon', 'adaptivecubic', '3dhoneycomb'],
  },
  outerWallSpeed: { key: 'outerWallSpeed', kind: 'number', min: '1', max: '1000', placeholder: '200', unit: 'mm/s' },
  innerWallSpeed: { key: 'innerWallSpeed', kind: 'number', min: '1', max: '1000', placeholder: '300', unit: 'mm/s' },
  infillSpeed: { key: 'infillSpeed', kind: 'number', min: '1', max: '1000', placeholder: '270', unit: 'mm/s' },
  support: { key: 'support', kind: 'switch' },
  supportType: { key: 'supportType', kind: 'select', values: ['normal(auto)', 'tree(auto)', 'normal', 'tree', 'hybrid(auto)'] },
  supportThreshold: { key: 'supportThreshold', kind: 'number', min: '0', max: '90', placeholder: '30', unit: '°' },
  brim: { key: 'brim', kind: 'select', values: ['auto_brim', 'outer_only', 'inner_only', 'outer_and_inner', 'no_brim'], required: true },
  brimWidth: { key: 'brimWidth', kind: 'number', step: '0.5', min: '0', max: '50', placeholder: '5', unit: 'mm' },
  nozzleTemp: { key: 'nozzleTemp', kind: 'number', min: '150', max: '350', placeholder: '220', unit: '°C' },
  bedTemp: { key: 'bedTemp', kind: 'number', min: '0', max: '120', placeholder: '55', unit: '°C' },
  plateType: { key: 'plateType', kind: 'select', values: PLATE_TYPES, empty: 'slice.plate_auto' },
  spiralMode: { key: 'spiralMode', kind: 'switch' },
  scale: { key: 'scale', kind: 'number', step: '0.1', min: '0.05', max: '20', placeholder: '1' },
  rotate: { key: 'rotate', kind: 'number', min: '-360', max: '360', placeholder: '0', unit: '°' },
  copies: { key: 'copies', kind: 'number', min: '1', max: '50', placeholder: '1' },
  arrange: { key: 'arrange', kind: 'switch' },
  allowRotations: { key: 'allowRotations', kind: 'switch' },

  alternateExtraWall: { key: 'alternateExtraWall', kind: 'bool' },
  embedWallIntoInfill: { key: 'embedWallIntoInfill', kind: 'bool' },
  detectThinWall: { key: 'detectThinWall', kind: 'bool' },
  ensureVerticalShell: { key: 'ensureVerticalShell', kind: 'select', values: ['enabled', 'disabled'] },
  detectFloatingShell: { key: 'detectFloatingShell', kind: 'bool' },

  topSurfacePattern: { key: 'topSurfacePattern', kind: 'select', values: SURFACE_PATTERNS, labels: 'surfacePattern' },
  topSurfaceDensity: { key: 'topSurfaceDensity', kind: 'number', min: '0', max: '100', placeholder: '100', unit: '%' },
  topShellThickness: { key: 'topShellThickness', kind: 'number', step: '0.1', min: '0', max: '20', placeholder: '0.8', unit: 'mm' },
  topPaintLayers: { key: 'topPaintLayers', kind: 'number', min: '0', max: '50', placeholder: '5' },
  subTopSurfacePattern: { key: 'subTopSurfacePattern', kind: 'select', values: SURFACE_PATTERNS, labels: 'surfacePattern' },
  bottomSurfacePattern: { key: 'bottomSurfacePattern', kind: 'select', values: SURFACE_PATTERNS, labels: 'surfacePattern' },
  bottomSurfaceDensity: { key: 'bottomSurfaceDensity', kind: 'number', min: '0', max: '100', placeholder: '100', unit: '%' },
  bottomShellThickness: { key: 'bottomShellThickness', kind: 'number', step: '0.1', min: '0', max: '20', placeholder: '0', unit: 'mm' },
  bottomPaintLayers: { key: 'bottomPaintLayers', kind: 'number', min: '0', max: '50', placeholder: '3' },
  solidInfillPattern: { key: 'solidInfillPattern', kind: 'select', values: SURFACE_PATTERNS, labels: 'surfacePattern' },

  fillMultiline: { key: 'fillMultiline', kind: 'number', min: '1', max: '5', placeholder: '1' },
  infillAnchor: { key: 'infillAnchor', kind: 'text', placeholder: '400%' },
  infillAnchorMax: { key: 'infillAnchorMax', kind: 'text', placeholder: '20' },
  infillWallOverlap: { key: 'infillWallOverlap', kind: 'number', min: '0', max: '100', placeholder: '15', unit: '%' },
  infillDirection: { key: 'infillDirection', kind: 'number', min: '0', max: '360', placeholder: '45', unit: '°' },
  bridgeAngle: { key: 'bridgeAngle', kind: 'number', min: '0', max: '360', placeholder: '0', unit: '°' },
  minSparseInfillArea: { key: 'minSparseInfillArea', kind: 'number', min: '0', max: '1000', placeholder: '15', unit: 'mm²' },
  infillCombination: { key: 'infillCombination', kind: 'bool' },
  detectNarrowSolidInfill: { key: 'detectNarrowSolidInfill', kind: 'bool' },
}

const BASIC = ['layerHeight', 'infill', 'brim', 'support']
const GROUPS: { key: string; fields: string[] }[] = [
  { key: 'quality', fields: ['firstLayerHeight', 'seam', 'ironing'] },
  { key: 'strength', fields: ['wallLoops', 'topLayers', 'bottomLayers', 'infillPattern'] },
  { key: 'walls', fields: ['alternateExtraWall', 'detectThinWall', 'embedWallIntoInfill', 'ensureVerticalShell', 'detectFloatingShell'] },
  {
    key: 'shell',
    fields: [
      'topSurfacePattern',
      'topSurfaceDensity',
      'topShellThickness',
      'topPaintLayers',
      'subTopSurfacePattern',
      'bottomSurfacePattern',
      'bottomSurfaceDensity',
      'bottomShellThickness',
      'bottomPaintLayers',
      'solidInfillPattern',
    ],
  },
  {
    key: 'infill',
    fields: [
      'fillMultiline',
      'infillAnchor',
      'infillAnchorMax',
      'infillWallOverlap',
      'infillDirection',
      'bridgeAngle',
      'minSparseInfillArea',
      'infillCombination',
      'detectNarrowSolidInfill',
    ],
  },
  { key: 'speed', fields: ['outerWallSpeed', 'innerWallSpeed', 'infillSpeed'] },
  { key: 'support', fields: ['supportType', 'supportThreshold'] },
  { key: 'filament', fields: ['nozzleTemp', 'bedTemp', 'plateType'] },
  { key: 'model', fields: ['scale', 'rotate', 'copies', 'arrange', 'allowRotations', 'brimWidth', 'spiralMode'] },
]

const NUMBERS = new Set(Object.values(FIELDS).filter((field) => field.kind === 'number').map((field) => field.key))
const SWITCHES = new Set(Object.values(FIELDS).filter((field) => field.kind === 'switch').map((field) => field.key))
const BOOLS = new Set(Object.values(FIELDS).filter((field) => field.kind === 'bool').map((field) => field.key))
const DEFAULTS: Record<string, string> = { brim: 'auto_brim' }

/** Kiểu bool phải giữ được lựa chọn tắt, khác switch dùng chuỗi rỗng làm "theo profile". */
function formValues(options: SliceOptions) {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(options)) {
    if (key === 'extra' || value === undefined || value === null) continue
    next[key] = typeof value !== 'boolean' ? String(value) : value ? 'true' : BOOLS.has(key) ? 'false' : ''
  }
  return next
}

/** Ô nhập nâng cao nhận "khoá = giá trị" mỗi dòng, mở đường tới mọi thiết lập slicer chưa có sẵn trong form. */
function parseExtra(text: string) {
  const extra: Record<string, string | number | boolean> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const at = trimmed.search(/[=:]/)
    if (at < 1) continue
    const key = trimmed.slice(0, at).trim()
    const value = trimmed.slice(at + 1).trim()
    if (!key) continue
    extra[key] = value === 'true' ? true : value === 'false' ? false : value
  }
  return extra
}

export type SliceForm = ReturnType<typeof useSliceForm>

/**
 * Toàn bộ trạng thái của việc cắt lát một file: chọn máy, profile, tham số và gọi slicer.
 * Dùng chung cho hộp thoại cắt nhanh và màn chỉnh sửa file.
 */
export function useSliceForm({
  file,
  printerId,
  active = true,
  onSliced,
}: {
  file: LibraryFile | null
  printerId?: string | null
  active?: boolean
  onSliced?: (result: SliceResult) => void
}) {
  const t = useT()
  const { printers, files, upsertFile, upsertPrinter } = useAgent()
  const [status, setStatus] = useState<SlicerStatus | null>(null)
  const [profiles, setProfiles] = useState<SlicerProfiles | null>(null)
  const [printer, setPrinter] = useState('')
  const [machine, setMachine] = useState('')
  const [process, setProcess] = useState('')
  const [filament, setFilament] = useState('')
  const [values, setValues] = useState<Record<string, string>>(DEFAULTS)
  const [extra, setExtra] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)

  const selectedPrinter = printers.find((item) => item.id === printer) ?? null
  // Mảng printers được tạo lại mỗi lần agent đẩy trạng thái, chỉ phụ thuộc vào giá trị nguyên thuỷ
  // để effect không chạy lại liên tục và xoá lựa chọn đang có.
  const firstPrinterId = printers[0]?.id ?? ''
  const savedMachine = selectedPrinter?.slicer?.machine ?? null
  const savedProcess = selectedPrinter?.slicer?.process ?? null
  const savedFilament = selectedPrinter?.slicer?.filament ?? null

  const rootId = file ? rootOf(files, file).id : null
  const latestId = rootId ? (slicedDescendants(files, rootId).find((item) => item.format === '3mf')?.id ?? null) : null
  const [preferred, setPreferred] = useState<SliceSettings | null>(null)
  const loadedKey = useRef<string | null>(null)

  useEffect(() => {
    if (!active) return
    loadedKey.current = null
    setStatus(null)
    setProfiles(null)
    setPrinter(printerId ?? firstPrinterId)
    setPreferred(null)
    setValues(DEFAULTS)
    setExtra('')
    setAdvanced(false)
    api.slicer().then(setStatus).catch(reportError)
  }, [active, printerId, firstPrinterId, rootId])

  // Mở lại file đã từng cắt lát thì lấy tham số từ chính bản cắt lát mới nhất, file đó mới là thứ đã đem đi in.
  // Chỉ nạp một lần mỗi lần mở, cắt xong ra bản mới cũng không đè lên thứ người dùng đang chỉnh.
  useEffect(() => {
    const key = `${rootId}|${printerId ?? firstPrinterId}`
    if (!active || !rootId || loadedKey.current === key) return
    loadedKey.current = key
    if (!latestId) return
    let stale = false
    api
      .sliceSettings(latestId)
      .then((settings) => {
        if (stale || !settings) return
        const next = formValues(settings.options)
        setPreferred(settings)
        setValues({ ...DEFAULTS, ...next })
        setExtra(Object.entries(settings.extra).map(([name, value]) => `${name} = ${value}`).join('\n'))
        setAdvanced(Object.keys(next).some((name) => !BASIC.includes(name)) || Object.keys(settings.extra).length > 0)
      })
      .catch(reportError)
    return () => {
      stale = true
    }
  }, [active, rootId, latestId, printerId, firstPrinterId])

  const preferredMachine = preferred?.machine ?? null
  const preferredProcess = preferred?.process ?? null
  const preferredFilament = preferred?.filament ?? null

  // Đổi máy in thì tải lại danh sách profile và chọn sẵn theo model máy.
  useEffect(() => {
    if (!active || !printer || !status?.available) return
    let stale = false
    setLoading(true)
    api
      .slicerProfiles({ printerId: printer })
      .then((data) => {
        if (stale) return
        setProfiles(data)
        const chosen = [preferredMachine, savedMachine, ...data.suggestedMachines].find((name) => name && data.machines.some((item) => item.name === name))
        setMachine(chosen ?? '')
      })
      .catch(reportError)
      .finally(() => !stale && setLoading(false))
    return () => {
      stale = true
    }
  }, [active, printer, status?.available, savedMachine, preferredMachine])

  // Chọn máy xong mới biết process và nhựa nào tương thích.
  useEffect(() => {
    if (!active || !machine) return
    let stale = false
    setLoading(true)
    api
      .slicerProfiles({ printerId: printer, machine })
      .then((data) => {
        if (stale) return
        setProfiles(data)
        const pick = (list: { name: string }[], ...names: (string | null | undefined)[]) =>
          names.find((name) => name && list.some((item) => item.name === name)) ?? list[0]?.name ?? ''
        setProcess(pick(data.processes, preferredProcess, savedProcess, data.defaults?.process))
        setFilament(pick(data.filaments, preferredFilament, savedFilament, data.defaults?.filament))
      })
      .catch(reportError)
      .finally(() => !stale && setLoading(false))
    return () => {
      stale = true
    }
  }, [active, machine, printer, savedProcess, savedFilament, preferredProcess, preferredFilament])

  const machineOptions = useMemo(() => {
    if (!profiles) return []
    const suggested = new Set(profiles.suggestedMachines)
    return profiles.machines
      .slice()
      .sort((a, b) => Number(suggested.has(b.name)) - Number(suggested.has(a.name)) || a.name.localeCompare(b.name))
      .map((item) => ({ value: item.name, label: suggested.has(item.name) ? `${item.name} · ${t('slice.suggested')}` : item.name }))
  }, [profiles, t])

  const set = (key: string, value: string) => setValues((prev) => ({ ...prev, [key]: value }))

  const optionLabel = (key: string) => t(`slice.opt_${key}` as never)
  const valueLabel = (key: string, value: string | number | boolean) => {
    const field = FIELDS[key]
    if (!field) return String(value)
    if (field.kind === 'switch' || field.kind === 'bool') return value ? t('slice.on') : t('slice.off')
    if (field.kind === 'select') return t(`slice.${field.labels ?? key}_${String(value).replace(/[^a-z0-9]+/gi, '_').replace(/_$/, '')}` as never)
    if (field.kind === 'text') return String(value)
    return field.unit ? `${value} ${field.unit}` : String(value)
  }

  const collectOptions = () => {
    const options: SliceOptions = {}
    for (const [key, raw] of Object.entries(values)) {
      if (raw === '' || raw === undefined) continue
      if (SWITCHES.has(key) || BOOLS.has(key)) Object.assign(options, { [key]: raw === 'true' })
      else if (NUMBERS.has(key)) Object.assign(options, { [key]: Number(raw) })
      else Object.assign(options, { [key]: raw })
    }
    return options
  }

  // Gửi kèm mấy ô đã chỉnh tay, tham số thêm tay và bản cắt lát gần nhất để agent chỉnh tiếp chứ không làm lại từ profile.
  const chatContext = (): SliceChatContext => ({
    printerId: printer,
    machine,
    process: process || undefined,
    filament: filament || undefined,
    options: { ...collectOptions(), extra: parseExtra(extra) },
    sliceId: latestId ?? undefined,
  })

  const snapshot = (): SliceSnapshot => ({
    machine,
    process: process || undefined,
    filament: filament || undefined,
    options: collectOptions(),
    extra: parseExtra(extra),
  })

  // Đặt làm bộ ưu tiên để các effect chọn profile không đè lại máy, process và nhựa của phiên bản.
  const restore = (version: Pick<SliceVersion, 'machine' | 'process' | 'filament' | 'options' | 'extra' | 'sliceId'>) => {
    const next = formValues(version.options)
    setPreferred({ fileId: version.sliceId ?? '', machine: version.machine, process: version.process, filament: version.filament, options: version.options, extra: version.extra })
    if (version.machine) setMachine(version.machine)
    if (version.process) setProcess(version.process)
    if (version.filament) setFilament(version.filament)
    setValues({ ...DEFAULTS, ...next })
    setExtra(Object.entries(version.extra).map(([name, value]) => `${name} = ${value}`).join('\n'))
    if (Object.keys(next).some((name) => !BASIC.includes(name)) || Object.keys(version.extra).length > 0) setAdvanced(true)
  }

  const submit = async () => {
    if (!file || !printer || !machine) return
    const options: SliceOptions = collectOptions()
    const parsed = parseExtra(extra)
    if (Object.keys(parsed).length > 0) options.extra = parsed
    setBusy(true)
    try {
      const result = await api.slice({
        fileId: file.id,
        printerId: printer,
        machine,
        process: process || undefined,
        filament: filament || undefined,
        ...options,
      })
      upsertFile(result.file)
      toast.success(
        t('slice.done', {
          name: result.file.name,
          time: formatDuration(result.stats?.estimatedTime ?? null),
          weight: result.stats?.filamentWeightG ? `${formatNumber(result.stats.filamentWeightG, 1)} g` : '-',
        }),
      )
      if (result.stats?.warning) toast.warning(result.stats.warning)
      try {
        upsertPrinter(await api.updatePrinter(printer, { slicer: { machine, process, filament } }))
      } catch {
        // Nhớ profile mặc định chỉ là tiện lợi, lỗi ở đây không ảnh hưởng file vừa cắt.
      }
      onSliced?.(result)
    } catch (error) {
      reportError(error)
    } finally {
      setBusy(false)
    }
  }

  return {
    status,
    preferred,
    profiles,
    printers,
    printer,
    setPrinter,
    selectedPrinter,
    machine,
    setMachine,
    machineOptions,
    process,
    setProcess,
    filament,
    setFilament,
    values,
    set,
    extra,
    setExtra,
    advanced,
    setAdvanced,
    rootId,
    latestId,
    chatContext,
    snapshot,
    restore,
    optionLabel,
    valueLabel,
    loading,
    busy,
    submit,
    canSlice: Boolean(file) && Boolean(machine) && Boolean(status?.available) && !busy && !loading,
  }
}

export function SliceField({ form, name }: { form: SliceForm; name: string }) {
  const t = useT()
  const field = FIELDS[name]
  const value = form.values[name] ?? ''
  const label = t(`slice.opt_${name}` as never)

  if (field.kind === 'switch') {
    return (
      <Field label={label}>
        <div className="flex h-9 items-center">
          <Switch checked={value === 'true'} onCheckedChange={(next) => form.set(name, next ? 'true' : '')} />
        </div>
      </Field>
    )
  }
  if (field.kind === 'bool') {
    return (
      <Field label={label}>
        <SelectField
          value={value}
          onChange={(next) => form.set(name, next)}
          options={[
            { value: '', label: t('slice.from_profile') },
            { value: 'true', label: t('slice.on') },
            { value: 'false', label: t('slice.off') },
          ]}
          placeholder={t('slice.from_profile')}
        />
      </Field>
    )
  }
  if (field.kind === 'text') {
    return (
      <Field label={label}>
        <Input value={value} placeholder={field.placeholder} onChange={(event) => form.set(name, event.target.value)} />
      </Field>
    )
  }
  if (field.kind === 'select') {
    const options = field.values.map((item) => ({
      value: item,
      label: t(`slice.${field.labels ?? name}_${item.replace(/[^a-z0-9]+/gi, '_').replace(/_$/, '')}` as never),
    }))
    return (
      <Field label={label}>
        <SelectField
          value={value}
          onChange={(next) => form.set(name, next)}
          options={field.required ? options : [{ value: '', label: t((field.empty ?? 'slice.from_profile') as never) }, ...options]}
          placeholder={t((field.empty ?? 'slice.from_profile') as never)}
        />
      </Field>
    )
  }
  return (
    <Field label={field.unit ? `${label} (${field.unit})` : label}>
      <Input
        type="number"
        step={field.step}
        min={field.min}
        max={field.max}
        value={value}
        placeholder={field.placeholder}
        onChange={(event) => form.set(name, event.target.value)}
      />
    </Field>
  )
}

export function SliceUnavailable({ form }: { form: SliceForm }) {
  const t = useT()
  if (!form.status || form.status.available) return null
  return (
    <div className="text-warn flex items-start gap-2 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <div>
        <p>{t('slice.unavailable')}</p>
        <p className="text-muted-foreground text-xs">{t('slice.unavailable_hint')}</p>
      </div>
    </div>
  )
}

/** Chọn máy in, profile máy, chất lượng in và sợi nhựa, kèm bốn tham số hay đổi nhất. */
export function SliceProfileFields({ form, columns = 2 }: { form: SliceForm; columns?: 1 | 2 }) {
  const t = useT()
  const span = columns === 2 ? 'sm:col-span-2' : undefined
  return (
    <div className={columns === 2 ? 'grid gap-3 sm:grid-cols-2' : 'grid gap-3'}>
      <Field label={t('slice.printer')} className={span}>
        <SelectField
          value={form.printer}
          onChange={form.setPrinter}
          options={form.printers.map((item) => ({ value: item.id, label: `${item.name} · ${item.driverLabel}` }))}
        />
      </Field>
      <Field
        label={t('slice.machine')}
        className={span}
        hint={form.selectedPrinter ? t('slice.output_hint', { format: form.selectedPrinter.formats.includes('3mf') ? '3MF' : 'G-code' }) : undefined}
      >
        <SelectField value={form.machine} onChange={form.setMachine} options={form.machineOptions} placeholder={t('slice.machine')} />
      </Field>
      <Field label={t('slice.process')}>
        <SelectField
          value={form.process}
          onChange={form.setProcess}
          options={(form.profiles?.processes ?? []).map((item) => ({ value: item.name, label: item.name }))}
        />
      </Field>
      <Field label={t('slice.filament')}>
        <SelectField
          value={form.filament}
          onChange={form.setFilament}
          options={(form.profiles?.filaments ?? []).map((item) => ({ value: item.name, label: item.name }))}
        />
      </Field>
      {BASIC.map((key) => (
        <SliceField key={key} form={form} name={key} />
      ))}
    </div>
  )
}

/** Bỏ dấu để gõ "do day" cũng tìm ra "Đổ đầy", khỏi phải bật bộ gõ tiếng Việt. */
function plain(text: string) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
}

/** Toàn bộ tham số ghi đè profile, chia nhóm gập lại theo đúng cách slicer trình bày. */
export function SliceAdvancedFields({ form, collapsible = true, columns = 2 }: { form: SliceForm; collapsible?: boolean; columns?: 1 | 2 }) {
  const t = useT()
  const grid = columns === 2 ? 'grid gap-3 sm:grid-cols-2' : 'grid gap-3'
  const [query, setQuery] = useState('')
  // Nhóm nào đang có giá trị riêng thì mở sẵn, còn lại để đóng cho bảng khỏi dài lê thê.
  const withValues = () => GROUPS.filter((group) => group.fields.some((key) => form.values[key])).map((group) => group.key)
  const [open, setOpen] = useState<string[]>(withValues)
  // Tham số của bản đã cắt lát về sau khi form đã hiện, phải mở lại theo bộ vừa nạp.
  const [openedFor, setOpenedFor] = useState(form.preferred)
  if (openedFor !== form.preferred) {
    setOpenedFor(form.preferred)
    setOpen(withValues())
  }

  const needle = plain(query.trim())
  const groups = useMemo(
    () =>
      GROUPS.map((group) => ({
        key: group.key,
        fields: needle ? group.fields.filter((name) => plain(t(`slice.opt_${name}` as never)).includes(needle) || plain(name).includes(needle)) : group.fields,
        changed: group.fields.filter((name) => form.values[name]).length,
      })).filter((group) => group.fields.length > 0),
    [needle, t, form.values],
  )

  const toggle = (key: string) => setOpen((prev) => (prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]))

  return (
    <>
      {collapsible ? (
        <Button type="button" variant="ghost" size="sm" className="-ml-2" onClick={() => form.setAdvanced(!form.advanced)}>
          {form.advanced ? <ChevronDown /> : <ChevronRight />}
          {t('slice.advanced')}
        </Button>
      ) : null}
      <div className="space-y-3" hidden={collapsible && !form.advanced}>
        <p className="text-muted-foreground text-xs">{t('slice.advanced_hint')}</p>

        <div className="flex items-center gap-2">
          <Input value={query} placeholder={t('slice.search')} onChange={(event) => setQuery(event.target.value)} className="h-8" />
          {open.length > 0 && !needle ? (
            <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => setOpen([])}>
              {t('slice.collapse_all')}
            </Button>
          ) : null}
        </div>

        {groups.length === 0 ? <p className="text-muted-foreground text-xs">{t('slice.search_empty')}</p> : null}

        <div className="divide-y rounded-lg border">
          {groups.map((group) => {
            const expanded = Boolean(needle) || open.includes(group.key)
            return (
              <div key={group.key}>
                <button
                  type="button"
                  onClick={() => toggle(group.key)}
                  className="hover:bg-muted/50 flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium"
                >
                  {expanded ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
                  <span className="min-w-0 flex-1 truncate">{t(`slice.group_${group.key}` as never)}</span>
                  {group.changed > 0 ? <span className="bg-brand/10 text-brand-strong rounded px-1.5 py-0.5 text-[10px] tabular-nums">{group.changed}</span> : null}
                </button>
                {expanded ? (
                  <div className={`${grid} border-t px-3 py-3`}>
                    {group.fields.map((key) => (
                      <SliceField key={key} form={form} name={key} />
                    ))}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>

        <Field label={t('slice.extra')} hint={t('slice.extra_hint')}>
          <Textarea
            rows={3}
            value={form.extra}
            placeholder={'reduce_crossing_wall = true\ntop_surface_pattern = monotonic'}
            onChange={(event) => form.setExtra(event.target.value)}
          />
        </Field>
      </div>
    </>
  )
}
