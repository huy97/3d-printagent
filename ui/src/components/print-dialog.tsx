import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, Loader2, Play, ListPlus, ShieldCheck, Shuffle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { Field } from '@/components/field'
import { SelectField } from '@/components/select-field'
import { StatusBadge } from '@/components/status-badge'
import { FileThumb } from '@/components/file-thumb'
import { reportError, useAgent } from '@/hooks/use-agent'
import { useT } from '@/i18n'
import { api, type LibraryFile, type Preflight, type PreflightWarning, type Printer, type PrintChoice, type PrintOptions, type PrintReview } from '@/lib/api'
import { formatDuration, formatGrams, formatHourMinute, formatMoney, formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

const READY = new Set(['idle', 'finished', 'cancelled'])
const ANY = 'any'
const HIGH_PRIORITY = 10

const REVIEW_TONE: Record<string, string> = {
  ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  warning: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  risky: 'border-destructive/40 bg-destructive/10 text-destructive',
}

const FINDING_TONE: Record<string, string> = {
  critical: 'text-destructive',
  warning: 'text-amber-600 dark:text-amber-400',
  info: 'text-muted-foreground',
}

const PRINT_CHOICES: PrintChoice[] = ['auto', 'on', 'off']

function choiceOf(value: boolean | 'auto' | undefined, choices: PrintChoice[]): PrintChoice {
  const wanted: PrintChoice = value === 'auto' || value === undefined ? 'auto' : value ? 'on' : 'off'
  return choices.includes(wanted) ? wanted : 'on'
}

function isPrinterReady(printer: Printer) {
  if (!printer.enabled || !printer.status.online) return false
  if (printer.driver === 'bambu' && printer.status.state === 'error') return true
  return READY.has(printer.status.state)
}

function amsTrays(printer: Printer | null) {
  return (printer?.status.extra.ams ?? []).flatMap((unit) =>
    unit.trays.map((tray) => {
      const [unitId, trayId] = tray.id.split('-').map(Number)
      return { index: unitId * 4 + trayId, label: `${String.fromCharCode(65 + unitId)}${trayId + 1}`, ...tray }
    }),
  )
}

/** Nhựa cần, phần sẽ thành rác, giờ xong và chi phí; cảnh báo khi cuộn đang gắn không đủ hoặc sai loại. */
function PreflightPanel({ data, anyMode, showFinish }: { data: Preflight; anyMode: boolean; showFinish: boolean }) {
  const t = useT()
  const { printers } = useAgent()
  const material = data.material
  const seconds = data.estimate.adjustedTime ?? data.estimate.estimatedTime
  const currency = data.cost.currency
  const adjusted = data.estimate.samples >= 2 && data.estimate.factor !== 1
  const matching = data.matchingPrinters ? printers.filter((item) => data.matchingPrinters?.includes(item.id)) : null

  const warningText = (warning: PreflightWarning) => {
    if (warning.code === 'spool_low') {
      return t('preflight.warn_spool_low', { spool: warning.spool ?? '', need: formatGrams(warning.needG), remaining: formatGrams(warning.remainingG) })
    }
    if (warning.code === 'material_mismatch') {
      return t('preflight.warn_mismatch', { spool: warning.spool ?? '', file: warning.file ?? '', loaded: warning.loaded ?? '' })
    }
    return t('preflight.warn_unassigned', { tool: warning.tool + 1 })
  }

  return (
    <div className="space-y-2.5 rounded-lg border p-3 text-xs">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="min-w-0">
          <div className="text-muted-foreground">{t('preflight.filament')}</div>
          <div className="text-sm font-medium tabular-nums">{material ? formatGrams(material.totalG) : '-'}</div>
          {material && !material.estimated ? (
            <div className="text-muted-foreground">{t('preflight.waste', { waste: formatGrams(material.wasteG) })}</div>
          ) : null}
        </div>
        <div className="min-w-0">
          <div className="text-muted-foreground">{t('preflight.time')}</div>
          <div className="text-sm font-medium">{formatDuration(seconds)}</div>
          <div className="text-muted-foreground">
            {adjusted ? t('preflight.adjusted', { percent: Math.round(data.estimate.factor * 100), samples: data.estimate.samples }) : null}
            {adjusted && showFinish && data.estimate.finishAt ? ' · ' : null}
            {showFinish && data.estimate.finishAt ? t('preflight.finish_at', { time: formatHourMinute(Date.parse(data.estimate.finishAt)) }) : null}
          </div>
        </div>
        <div className="min-w-0">
          <div className="text-muted-foreground">{t('preflight.cost')}</div>
          <div className="text-sm font-medium">{formatMoney(data.cost.total, currency)}</div>
          <div className="text-muted-foreground truncate">
            {t('preflight.cost_detail', { filament: formatMoney(data.cost.filament, currency), electricity: formatMoney(data.cost.electricity, currency) })}
          </div>
        </div>
      </div>
      {material && material.wasteG > 0 ? (
        <div className="text-muted-foreground">
          {t('preflight.waste_detail', {
            support: formatGrams(material.grams.support),
            adhesion: formatGrams(material.grams.adhesion),
            purge: formatGrams(material.grams.purge),
          })}
        </div>
      ) : null}
      {data.spools
        .filter((item) => item.spoolName)
        .map((item) => (
          <div key={item.tool} className="flex items-center gap-2">
            <span className="size-3 shrink-0 rounded-full border" style={{ background: item.spoolColor ?? 'transparent' }} />
            <span className="min-w-0 truncate">
              {t('preflight.spool_line', {
                tool: item.tool + 1,
                spool: item.spoolName ?? '',
                need: formatGrams(item.needG),
                remaining: formatGrams(item.remainingG),
              })}
            </span>
          </div>
        ))}
      {anyMode && matching ? (
        matching.length === 0 ? (
          <div className="text-warn flex items-start gap-1.5">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {t('preflight.no_matching')}
          </div>
        ) : (
          <div className="text-muted-foreground">{t('preflight.matching', { names: matching.map((item) => item.name).join(', ') })}</div>
        )
      ) : null}
      {data.warnings.map((warning, index) => (
        <div key={index} className="text-warn flex items-start gap-1.5">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {warningText(warning)}
        </div>
      ))}
    </div>
  )
}

export function PrintDialog({
  open,
  onOpenChange,
  file,
  printerId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  file: LibraryFile | null
  printerId?: string | null
}) {
  const t = useT()
  const { printers, upsertJob, config } = useAgent()
  const [selected, setSelected] = useState('')
  const [mode, setMode] = useState<'now' | 'queue'>('now')
  const [confirmBed, setConfirmBed] = useState(false)
  const [plate, setPlate] = useState(1)
  const [options, setOptions] = useState<PrintOptions>({ useAms: true, timelapse: false, bedLeveling: 'auto', flowCalibration: 'auto' })
  const [mapping, setMapping] = useState<Record<number, string>>({})
  const [priority, setPriority] = useState(false)
  const [busy, setBusy] = useState(false)
  const [review, setReview] = useState<PrintReview | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [preflight, setPreflight] = useState<Preflight | null>(null)
  const [multi, setMulti] = useState(false)
  const [picked, setPicked] = useState<string[]>([])

  const compatible = useMemo(() => printers.filter((printer) => file && printer.formats.includes(file.format)), [printers, file])
  const anyMode = !multi && selected === ANY
  const printer = multi || anyMode ? null : (printers.find((item) => item.id === selected) ?? null)
  const ready = printer ? isPrinterReady(printer) : false
  const plates = file?.meta.plates ?? []
  const currentPlate = plates.find((item) => item.index === plate) ?? plates[0]
  const isBambu = printer?.driver === 'bambu'
  const trays = amsTrays(printer)
  const hasAms = trays.length > 0
  const needsBedConfirm = mode === 'now' && printer ? !printer.bedClear : false
  const aiReady = Boolean(config?.ai?.apiKey)
  const queueing = !multi && (anyMode || mode === 'queue')
  const plateIndex = file?.format === '3mf' ? (currentPlate?.index ?? plate) : undefined
  const pickedPrinters = compatible.filter((item) => picked.includes(item.id))
  const readyPicked = pickedPrinters.filter(isPrinterReady)
  const unclearPicked = readyPicked.filter((item) => !item.bedClear)
  const busyPicked = pickedPrinters.filter((item) => !isPrinterReady(item))
  const startNow = readyPicked.length - (confirmBed ? 0 : unclearPicked.length)
  const pickedKey = picked.join(',')

  const amsMapping = useMemo(() => {
    if (!isBambu || !options.useAms || !currentPlate?.filaments.length) return undefined
    const maxId = Math.max(...currentPlate.filaments.map((item) => item.id))
    return Array.from({ length: maxId }, (_, index) => {
      const chosen = mapping[index + 1]
      return chosen !== undefined && chosen !== '' ? Number(chosen) : index
    })
  }, [isBambu, options.useAms, currentPlate, mapping])
  const mappingKey = amsMapping?.join(',') ?? ''

  useEffect(() => {
    if (!open || !file) return
    const preferred =
      compatible.find((item) => item.id === printerId) ?? compatible.find(isPrinterReady) ?? compatible[0] ?? null
    setSelected(preferred?.id ?? '')
    setMode(preferred && !isPrinterReady(preferred) ? 'queue' : 'now')
    setConfirmBed(false)
    setPlate(plates.find((item) => item.gcode)?.index ?? 1)
    setMapping({})
    setPriority(false)
    setMulti(false)
    setPicked([])
    setReview(null)
    setPreflight(null)
    // Chỉ khởi tạo khi mở hộp thoại, không reset lựa chọn mỗi lần trạng thái máy thay đổi.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, file?.id])

  // Máy chỉ có cuộn ngoài mà vẫn bảo lấy nhựa từ khay AMS thì nó nằm mãi ở bước chuẩn bị, nên tắt sẵn.
  useEffect(() => {
    setOptions((prev) => (prev.useAms === hasAms ? prev : { ...prev, useAms: hasAms }))
  }, [hasAms])

  useEffect(() => {
    if (!open || !file || (multi ? picked.length === 0 : !selected)) return
    let cancelled = false
    api
      .preflight({
        fileId: file.id,
        printerId: anyMode || multi ? undefined : selected,
        printerIds: multi ? picked : undefined,
        plate: plateIndex,
        amsMapping,
      })
      .then((result) => !cancelled && setPreflight(result))
      .catch(() => !cancelled && setPreflight(null))
    return () => {
      cancelled = true
    }
    // Bảng gán AMS đổi tham chiếu mỗi lần render, so theo chuỗi để không gọi lại liên tục.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, file?.id, selected, plateIndex, mappingKey, multi, pickedKey])

  const toggleMulti = (checked: boolean) => {
    setMulti(checked)
    setMapping({})
    setConfirmBed(false)
    if (!checked) return
    setPicked(compatible.filter(isPrinterReady).map((item) => item.id))
  }

  const submitBatch = async () => {
    if (!file || pickedPrinters.length === 0) return
    setBusy(true)
    try {
      const body: Parameters<typeof api.createBatch>[0] = {
        fileId: file.id,
        printerIds: pickedPrinters.map((item) => item.id),
        confirmBedClear: confirmBed,
      }
      if (plateIndex !== undefined) body.plate = plateIndex
      const result = await api.createBatch(body)
      result.jobs.forEach((job) => upsertJob(job))
      toast.success(t('print_dialog.batch_done', { count: result.started }))
      if (result.skipped.length > 0) {
        toast.warning(t('print_dialog.batch_skipped', { names: result.skipped.map((item) => item.printerName).join(', ') }))
      }
      onOpenChange(false)
    } catch (error) {
      reportError(error)
    } finally {
      setBusy(false)
    }
  }

  const submit = async () => {
    if (!file || (!printer && !anyMode)) return
    setBusy(true)
    try {
      const body: Parameters<typeof api.createJob>[0] = {
        printerId: printer?.id ?? ANY,
        fileId: file.id,
        mode: anyMode ? 'queue' : mode,
        confirmBedClear: confirmBed,
      }
      if (priority && queueing) body.priority = HIGH_PRIORITY
      if (plateIndex !== undefined) body.plate = plateIndex
      if (isBambu) {
        Object.assign(body, options)
        if (amsMapping) body.amsMapping = amsMapping
      }
      const job = await api.createJob(body)
      upsertJob(job)
      if (anyMode) toast.success(t('print_dialog.queued_any'))
      else toast.success(mode === 'now' ? t('print_dialog.started', { printer: printer?.name ?? '' }) : t('print_dialog.queued', { printer: printer?.name ?? '' }))
      onOpenChange(false)
    } catch (error) {
      reportError(error)
    } finally {
      setBusy(false)
    }
  }

  const analyze = async () => {
    if (!file) return
    setReviewing(true)
    try {
      setReview(await api.analyzeFile(file.id, { printerId: printer?.id ?? null, plate: currentPlate?.index ?? plate }))
    } catch (error) {
      reportError(error)
    } finally {
      setReviewing(false)
    }
  }

  const noMatch = (anyMode || multi) && preflight?.matchingPrinters?.length === 0
  const canSubmit = multi
    ? startNow > 0 && !noMatch
    : anyMode ? !noMatch : Boolean(printer) && (mode === 'queue' || (ready && (!needsBedConfirm || confirmBed)))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92dvh] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('print_dialog.title')}</DialogTitle>
          <DialogDescription>{t('print_dialog.description')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {file ? (
            <div className="flex items-center gap-3 rounded-lg border p-2.5">
              <FileThumb file={file} className="size-14" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{file.name}</div>
                <div className="text-muted-foreground flex flex-wrap gap-x-3 text-xs">
                  <span>{formatDuration(currentPlate?.estimatedTime ?? file.meta.estimatedTime)}</span>
                  {file.meta.filamentType ? <span>{file.meta.filamentType}</span> : null}
                  {file.meta.filamentWeightG ? <span>{formatNumber(file.meta.filamentWeightG, 1)} g</span> : null}
                  {file.meta.printerModel ? <span>{file.meta.printerModel}</span> : null}
                </div>
              </div>
            </div>
          ) : null}

          {compatible.length === 0 ? (
            <div className="border-warn/40 bg-warn/10 text-warn rounded-lg border p-2.5 text-xs">
              {t('print_dialog.no_compatible', { format: file?.format ?? '' })}
            </div>
          ) : (
            <div className="grid gap-1.5">
              {compatible.length > 1 ? (
                <label className="flex items-center justify-between gap-3 px-1 pb-1">
                  <span className="space-y-0.5">
                    <span className="block text-sm font-medium">{t('print_dialog.multi')}</span>
                    <span className="text-muted-foreground block text-xs">{t('print_dialog.multi_hint')}</span>
                  </span>
                  <Switch checked={multi} onCheckedChange={toggleMulti} />
                </label>
              ) : null}
              {compatible.length > 1 && !multi ? (
                <button
                  type="button"
                  onClick={() => {
                    setSelected(ANY)
                    setMapping({})
                  }}
                  className={cn(
                    'flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors',
                    anyMode ? 'border-brand bg-brand/5' : 'hover:bg-accent/50',
                  )}
                >
                  <span className={cn('size-3.5 shrink-0 rounded-full border-2', anyMode ? 'border-brand bg-brand' : 'border-input')} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{t('print_dialog.any_printer')}</span>
                    <span className="text-muted-foreground block text-xs">{t('print_dialog.any_printer_hint')}</span>
                  </span>
                  <Shuffle className="text-muted-foreground size-4 shrink-0" />
                </button>
              ) : null}
              {compatible.map((item) => {
                const itemReady = isPrinterReady(item)
                const checked = multi ? picked.includes(item.id) : item.id === selected
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      if (multi) {
                        setPicked((prev) => (prev.includes(item.id) ? prev.filter((id) => id !== item.id) : [...prev, item.id]))
                        return
                      }
                      setSelected(item.id)
                      setMode(itemReady ? 'now' : 'queue')
                      setMapping({})
                    }}
                    className={cn(
                      'flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors',
                      checked ? 'border-brand bg-brand/5' : 'hover:bg-accent/50',
                    )}
                  >
                    <span
                      className={cn('size-3.5 shrink-0 border-2', multi ? 'rounded-sm' : 'rounded-full', checked ? 'border-brand bg-brand' : 'border-input')}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{item.name}</span>
                      <span className="text-muted-foreground block text-xs">
                        {item.driverLabel}
                        {!item.bedClear ? ` · ${t('print_dialog.bed_not_clear_short')}` : ''}
                      </span>
                    </span>
                    <StatusBadge status={item.enabled ? item.status.state : 'disabled'} />
                  </button>
                )
              })}
            </div>
          )}

          {printer ? (
            <div className="grid grid-cols-2 gap-1.5 rounded-lg border p-1">
              {(['now', 'queue'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setMode(value)}
                  className={cn(
                    'flex h-8 items-center justify-center gap-1.5 rounded-md text-sm transition-colors',
                    mode === value ? 'bg-accent text-foreground font-medium' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {value === 'now' ? <Play className="size-3.5" /> : <ListPlus className="size-3.5" />}
                  {t(value === 'now' ? 'print_dialog.mode_now' : 'print_dialog.mode_queue')}
                </button>
              ))}
            </div>
          ) : null}

          {printer && mode === 'now' && !ready ? (
            <div className="border-warn/40 bg-warn/10 text-warn flex items-start gap-2 rounded-lg border p-2.5 text-xs">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {t('print_dialog.not_ready', { state: printer.enabled ? t(`status.${printer.status.state}`) : t('status.disabled') })}
            </div>
          ) : null}

          {printer && mode === 'queue' ? (
            <p className="text-muted-foreground text-xs">
              {printer.autoStartQueue ? t('print_dialog.queue_auto') : t('print_dialog.queue_manual')}
            </p>
          ) : null}
          {anyMode ? <p className="text-muted-foreground text-xs">{t('print_dialog.queue_any')}</p> : null}
          {multi && pickedPrinters.length > 0 ? (
            <p className="text-muted-foreground text-xs">
              {t('print_dialog.batch_now', { count: Math.max(0, startNow) })}
              {busyPicked.length > 0 ? ` ${t('print_dialog.batch_busy', { names: busyPicked.map((item) => item.name).join(', ') })}` : ''}
            </p>
          ) : null}

          {queueing && (printer || anyMode) ? (
            <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
              <span className="space-y-0.5">
                <span className="block text-sm">{t('print_dialog.priority')}</span>
                <span className="text-muted-foreground block text-xs">{t('print_dialog.priority_hint')}</span>
              </span>
              <Switch checked={priority} onCheckedChange={setPriority} />
            </label>
          ) : null}

          {(needsBedConfirm && ready) || (multi && unclearPicked.length > 0) ? (
            <label className="border-warn/40 bg-warn/5 flex items-start justify-between gap-3 rounded-lg border p-3">
              <span className="space-y-0.5">
                <span className="block text-sm font-medium">{t('print_dialog.confirm_bed')}</span>
                <span className="text-muted-foreground block text-xs">
                  {multi
                    ? t('print_dialog.confirm_bed_multi', { names: unclearPicked.map((item) => item.name).join(', ') })
                    : t('print_dialog.confirm_bed_hint')}
                </span>
              </span>
              <Switch checked={confirmBed} onCheckedChange={setConfirmBed} />
            </label>
          ) : null}

          {file?.format === '3mf' && plates.length > 1 ? (
            <Field label={t('print_dialog.plate')}>
              <SelectField
                value={String(currentPlate?.index ?? plate)}
                onChange={(value) => {
                  setPlate(Number(value))
                  setMapping({})
                }}
                options={plates.map((item) => ({
                  value: String(item.index),
                  label: `${t('print_dialog.plate_n', { n: item.index })}${item.estimatedTime ? ` · ${formatDuration(item.estimatedTime)}` : ''}`,
                }))}
              />
            </Field>
          ) : null}

          {preflight && (printer || anyMode || multi) ? (
            <PreflightPanel data={preflight} anyMode={anyMode || multi} showFinish={!queueing && !multi} />
          ) : null}
          {multi && preflight && startNow > 1 ? (
            <p className="text-muted-foreground text-xs">
              {t('print_dialog.batch_total', {
                count: startNow,
                filament: formatGrams((preflight.material?.totalG ?? 0) * startNow),
                cost: formatMoney(preflight.cost.total * startNow, preflight.cost.currency),
              })}
            </p>
          ) : null}

          {isBambu ? (
            <div className="space-y-3 rounded-lg border p-3">
              <div className="text-muted-foreground text-xs font-medium">{t('print_dialog.bambu_options')}</div>
              <div className="grid gap-2">
                {(['useAms', 'timelapse'] as const)
                  .filter((key) => key !== 'useAms' || hasAms)
                  .map((key) => (
                    <label key={key} className="flex items-center justify-between gap-2 text-sm">
                      {t(`print_dialog.option.${key}`)}
                      <Switch size="sm" checked={Boolean(options[key])} onCheckedChange={(checked) => setOptions((prev) => ({ ...prev, [key]: checked }))} />
                    </label>
                  ))}
                {/* Giống BambuStudio: chỉ hiện lựa chọn dòng máy cho phép, không có "tự động" thì chọn sẵn "bật". */}
                {(['bedLeveling', 'flowCalibration'] as const).map((key) => {
                  const choices = printer?.printChoices?.[key] ?? PRINT_CHOICES
                  if (choices.length === 0) return null
                  return (
                    <label key={key} className="flex items-center justify-between gap-2 text-sm">
                      {t(`print_dialog.option.${key}`)}
                      <SelectField
                        className="w-40"
                        value={choiceOf(options[key], choices)}
                        onChange={(value) => setOptions((prev) => ({ ...prev, [key]: value === 'auto' ? 'auto' : value === 'on' }))}
                        options={choices.map((value) => ({ value, label: t(`print_dialog.choice.${value}`) }))}
                      />
                    </label>
                  )
                })}
              </div>
              {options.useAms && currentPlate?.filaments.length ? (
                <div className="space-y-2">
                  <div className="text-muted-foreground text-xs">{t('print_dialog.ams_mapping')}</div>
                  {currentPlate.filaments.map((filament) => (
                    <div key={filament.id} className="flex items-center gap-2">
                      <span className="size-4 shrink-0 rounded-full border" style={{ background: filament.color ?? 'transparent' }} />
                      <span className="w-24 shrink-0 truncate text-xs">
                        #{filament.id} {filament.type ?? ''}
                      </span>
                      <SelectField
                        className="h-8"
                        value={mapping[filament.id] ?? ''}
                        onChange={(value) => setMapping((prev) => ({ ...prev, [filament.id]: value }))}
                        options={[
                          { value: '', label: t('print_dialog.ams_default') },
                          ...trays.map((tray) => ({
                            value: String(tray.index),
                            label: `${tray.label} · ${tray.type ?? '-'}${tray.remain !== null ? ` · ${tray.remain}%` : ''}`,
                          })),
                        ]}
                      />
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {file && aiReady ? (
            <div className="space-y-2">
              <Button variant="outline" size="sm" disabled={reviewing} onClick={() => void analyze()}>
                {reviewing ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                {t('print_dialog.review')}
              </Button>
              {review ? (
                <div className={cn('space-y-2 rounded-lg border p-2.5 text-xs', REVIEW_TONE[review.verdict] ?? 'border-border bg-muted/40')}>
                  <p className="leading-relaxed font-medium">{review.summary}</p>
                  {review.findings.length > 0 ? (
                    <ul className="space-y-1.5">
                      {review.findings.map((finding, index) => (
                        <li key={index} className="text-foreground/90 leading-relaxed">
                          <span className={cn('font-medium', FINDING_TONE[finding.severity])}>{finding.title}</span>
                          {finding.detail ? <span className="block opacity-80">{finding.detail}</span> : null}
                          {finding.advice ? <span className="block opacity-80">{t('print_dialog.review_advice', { advice: finding.advice })}</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="opacity-80">{t('print_dialog.review_clean')}</p>
                  )}
                </div>
              ) : (
                <p className="text-muted-foreground text-xs">{t('print_dialog.review_hint')}</p>
              )}
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void (multi ? submitBatch() : submit())} disabled={busy || !canSubmit}>
            {busy ? <Loader2 className="animate-spin" /> : queueing ? <ListPlus /> : <Play />}
            {multi ? t('print_dialog.submit_batch', { count: Math.max(0, startNow) }) : queueing ? t('print_dialog.submit_queue') : t('print_dialog.submit_now')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
