import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, Camera, CameraOff, FolderOpen, Pause, Play, Plus, RefreshCw, ScanEye, Square, Stethoscope, Trash2, OctagonX, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { ProgressBar } from '@/components/progress-bar'
import { TempChart } from '@/components/temp-chart'
import { useConfirm } from '@/components/confirm-dialog'
import { useCommand } from '@/hooks/use-command'
import { reportError, useAgent } from '@/hooks/use-agent'
import { useT } from '@/i18n'
import { api, mediaUrl, type MaintenanceInfo, type PrintInspection, type Printer, type PrinterDiagnosis, type PrinterFile, type WatchStatus } from '@/lib/api'
import { formatBytes, formatDuration, formatEta, formatNumber, formatTime } from '@/lib/format'
import { cn } from '@/lib/utils'

export const canCamera = (printer: Printer) => printer.capabilities.camera
export const canPrinterFiles = (printer: Printer) => printer.capabilities.files
export const hasAms = (printer: Printer) => (printer.status.extra.ams?.length ?? 0) > 0 || Boolean(printer.status.extra.externalSpool)
export const hasAlerts = (printer: Printer) => (printer.status.extra.hms?.length ?? 0) > 0 || printer.status.state === 'error'
export const canInspect = (printer: Printer) => printer.capabilities.camera

export function TemperatureCard({ printer }: { printer: Printer }) {
  const t = useT()
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('printer.temperatures')}</CardTitle>
      </CardHeader>
      <CardContent>
        <TempChart printerId={printer.id} status={printer.status} />
      </CardContent>
    </Card>
  )
}

export function CurrentJobCard({ printer }: { printer: Printer }) {
  const t = useT()
  const { jobs } = useAgent()
  const { run, pending } = useCommand(printer)
  const { confirm, dialog } = useConfirm()
  const { status, capabilities: caps } = printer
  const job = status.job
  const printing = status.state === 'printing'
  const paused = status.state === 'paused'
  const running = printing || paused || status.state === 'busy'
  const agentJob = jobs.find((item) => item.printerId === printer.id && ['uploading', 'starting', 'printing', 'paused'].includes(item.status))

  const stop = () =>
    confirm({
      title: t('printer.cancel_title'),
      description: t('printer.cancel_description', { file: job?.file ?? '' }),
      confirmLabel: t('printer.cancel_print'),
      destructive: true,
      onConfirm: async () => {
        // Job do agent tạo thì huỷ qua job để trạng thái hàng đợi khớp; job ngoài agent thì gửi thẳng lệnh huỷ.
        if (agentJob) {
          try {
            await api.cancelJob(agentJob.id)
            toast.success(t('jobs.canceled'))
          } catch (error) {
            reportError(error)
          }
        } else await run('cancel', {}, t('jobs.canceled'))
      },
    })

  const emergency = () =>
    confirm({
      title: t('printer.estop_title'),
      description: t('printer.estop_description'),
      confirmLabel: t('printer.estop'),
      destructive: true,
      onConfirm: async () => {
        await run('emergencyStop', {}, t('printer.estop_sent'))
      },
    })

  const uploadPercent = agentJob?.status === 'uploading' && agentJob.upload?.total ? (agentJob.upload.sent / agentJob.upload.total) * 100 : null

  return (
    <Card>
      {dialog}
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>{t('printer.current_job')}</CardTitle>
        {caps.emergencyStop && running ? (
          <Button size="sm" variant="destructive" onClick={emergency} disabled={!status.online || pending !== null}>
            <OctagonX /> {t('printer.estop')}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        {uploadPercent !== null ? (
          <div className="space-y-1.5">
            <div className="flex justify-between text-sm">
              <span className="truncate">{t('printer.uploading', { file: agentJob?.fileName ?? '' })}</span>
              <span className="tabular-nums">{Math.round(uploadPercent)}%</span>
            </div>
            <ProgressBar value={uploadPercent} tone="info" />
          </div>
        ) : null}
        {job?.file ? (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-sm font-medium" title={job.file}>
                {job.file}
              </span>
              <span className="text-2xl font-semibold tabular-nums">{Math.round(job.progress ?? 0)}%</span>
            </div>
            <ProgressBar value={job.progress} className="h-2" />
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
              <div>
                <dt className="text-muted-foreground">{t('printer.elapsed')}</dt>
                <dd className="font-medium tabular-nums">{formatDuration(job.elapsed)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('printer.remaining')}</dt>
                <dd className="font-medium tabular-nums">{formatDuration(job.remaining)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('printer.eta')}</dt>
                <dd className="font-medium tabular-nums">{formatEta(job.remaining) ?? '-'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('printer.layer')}</dt>
                <dd className="font-medium tabular-nums">
                  {job.layer ?? '-'}
                  {job.totalLayers ? ` / ${job.totalLayers}` : ''}
                </dd>
              </div>
            </dl>
            {job.stage ? <p className="text-muted-foreground text-xs">{t('printer.stage', { stage: job.stage })}</p> : null}
          </>
        ) : uploadPercent === null ? (
          <p className="text-muted-foreground text-sm">{t('printer.no_job')}</p>
        ) : null}
        {printing || paused ? (
          <div className="flex flex-wrap gap-2">
            {printing && caps.pause ? (
              <Button variant="outline" size="sm" onClick={() => void run('pause', {}, t('printer.paused'))} disabled={pending !== null}>
                <Pause /> {t('printer.pause')}
              </Button>
            ) : null}
            {paused && caps.resume ? (
              <Button size="sm" onClick={() => void run('resume', {}, t('printer.resumed'))} disabled={pending !== null}>
                <Play /> {t('printer.resume')}
              </Button>
            ) : null}
            {caps.cancel ? (
              <Button variant="outline" size="sm" className="text-destructive" onClick={stop} disabled={pending !== null}>
                <Square /> {t('printer.cancel_print')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

export function BedClearBanner({ printer }: { printer: Printer }) {
  const t = useT()
  const { upsertPrinter } = useAgent()
  const [busy, setBusy] = useState(false)
  if (printer.bedClear) return null
  const busyState = printer.status.state === 'printing' || printer.status.state === 'paused'
  if (busyState) return null

  return (
    <div className="border-warn/40 bg-warn/10 flex flex-wrap items-center gap-3 rounded-xl border p-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{t('printer.bed_not_clear')}</div>
        <div className="text-muted-foreground text-xs">
          {printer.autoStartQueue ? t('printer.bed_not_clear_queue') : t('printer.bed_not_clear_hint')}
        </div>
      </div>
      <Button
        size="sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          try {
            upsertPrinter(await api.bedCleared(printer.id))
            toast.success(t('printer.bed_cleared'))
          } catch (error) {
            reportError(error)
          } finally {
            setBusy(false)
          }
        }}
      >
        <CheckCircle2 /> {t('printer.mark_bed_clear')}
      </Button>
    </div>
  )
}

export function CameraCard({ printer }: { printer: Printer }) {
  const t = useT()
  const [shown, setShown] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [auto, setAuto] = useState(true)
  const [phase, setPhase] = useState<'loading' | 'ok' | 'failed'>('loading')
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  const [failures, setFailures] = useState(0)
  const [ratio, setRatio] = useState<number | null>(null)
  const online = printer.status.online
  const failed = phase === 'failed'
  // Máy có luồng liên tục thì xem trực tiếp, tab ẩn đi thì ngắt để không giữ kết nối camera của máy in.
  const streaming = printer.capabilities.cameraStream && auto && online && visible && !failed

  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  // Tải ảnh mới ngầm rồi mới thay ảnh đang hiện, nếu không khung sẽ co lại và chớp mỗi lần làm mới.
  useEffect(() => {
    if (!online || streaming) return
    const url = mediaUrl(`/api/printers/${encodeURIComponent(printer.id)}/snapshot`, { t: Date.now() })
    const image = new Image()
    let done = false
    setPhase('loading')
    image.onload = () => {
      done = true
      setShown(url)
      setFailures(0)
      setPhase('ok')
    }
    image.onerror = () => {
      done = true
      setFailures((count) => count + 1)
      setPhase('failed')
    }
    image.src = url
    return () => {
      if (done) return
      image.onload = null
      image.onerror = null
      image.src = ''
    }
  }, [online, streaming, printer.id, reload])

  // Chỉ hẹn lần chụp kế tiếp khi ảnh hiện tại đã xong. Camera không phản hồi thì mỗi request treo hàng chục giây,
  // hẹn giờ cố định sẽ chồng request lên nhau và trình duyệt quay vòng tải mãi không dứt; hỏng thì giãn dần tới 1 phút.
  useEffect(() => {
    if (!auto || !online || !visible || streaming || phase === 'loading') return
    const delay = failed ? Math.min(60000, 5000 * 2 ** Math.min(failures - 1, 3)) : 5000
    const timer = window.setTimeout(() => setReload((count) => count + 1), delay)
    return () => window.clearTimeout(timer)
  }, [auto, online, visible, streaming, phase, failed, failures])

  const refresh = () => {
    setFailures(0)
    setPhase('loading')
    setReload((count) => count + 1)
  }

  if (!canCamera(printer)) return null

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <Camera className="size-4" /> {t('printer.camera')}
        </CardTitle>
        <div className="flex items-center gap-2">
          <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <Switch size="sm" checked={auto} onCheckedChange={setAuto} />{' '}
            {t(printer.capabilities.cameraStream ? 'printer.camera_live' : 'printer.camera_auto')}
          </label>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            title={t('common.refresh')}
            onClick={refresh}
          >
            <RefreshCw />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div
          // Khung luồng ôm đúng tỉ lệ khung hình lấy được, giữ nguyên giữa các khung nên không co giật.
          style={streaming && ratio ? { aspectRatio: ratio, maxHeight: '26rem' } : undefined}
          className={cn(
            'bg-muted/50 relative mx-auto flex items-center justify-center overflow-hidden rounded-lg border',
            // Chưa có ảnh thì giữ khung 16:9 làm chỗ trống; có ảnh rồi thì khung ôm đúng tỉ lệ luồng của máy.
            !streaming && online && shown ? 'w-fit' : 'w-full',
            (!streaming || !ratio) && 'aspect-video',
          )}
        >
          {streaming ? (
            <img
              src={mediaUrl(`/api/printers/${encodeURIComponent(printer.id)}/camera`, { t: reload })}
              alt={t('printer.camera')}
              className="size-full object-contain"
              onLoad={(event) => {
                const { naturalWidth, naturalHeight } = event.currentTarget
                if (naturalWidth > 0 && naturalHeight > 0) setRatio(naturalWidth / naturalHeight)
              }}
              onError={() => {
                setFailures((count) => count + 1)
                setPhase('failed')
              }}
            />
          ) : null}
          {!streaming && online && shown ? (
            <img src={shown} alt={t('printer.camera')} className="max-h-[26rem] w-auto max-w-full object-contain" />
          ) : null}
          {!streaming && (!online || !shown) ? (
            <div className="text-muted-foreground absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-xs">
              <CameraOff className="size-5" />
              {!online ? t('printer.camera_offline') : failed ? t('printer.camera_failed') : t('common.loading')}
            </div>
          ) : null}
          {!streaming && online && shown && failed ? (
            <span className="bg-background/80 text-muted-foreground absolute right-1.5 bottom-1.5 rounded px-1.5 py-0.5 text-[11px]">
              {t('printer.camera_failed')}
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}

export function AmsCard({ printer }: { printer: Printer }) {
  const t = useT()
  const ams = printer.status.extra.ams ?? []
  const external = printer.status.extra.externalSpool
  if (!hasAms(printer)) return null
  const activeTray = printer.status.extra.amsActiveTray

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('printer.filament')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {ams.map((unit) => (
          <div key={unit.id} className="space-y-1.5">
            <div className="text-muted-foreground flex justify-between text-xs">
              <span>AMS {String.fromCharCode(65 + unit.id)}</span>
              <span>
                {unit.humidity ? t('printer.ams_humidity', { value: unit.humidity }) : ''}
                {unit.temp ? ` · ${unit.temp}°C` : ''}
              </span>
            </div>
            <div className="grid grid-cols-4 gap-1.5">
              {unit.trays.map((tray) => {
                const [unitId, trayId] = tray.id.split('-').map(Number)
                const globalIndex = String(unitId * 4 + trayId)
                const active = activeTray === globalIndex
                return (
                  <div
                    key={tray.id}
                    className={cn('flex flex-col items-center gap-1 rounded-lg border p-1.5 text-center', active && 'border-brand ring-brand/30 ring-2')}
                  >
                    <span className="size-6 rounded-full border" style={{ background: tray.color ?? 'transparent' }} />
                    <span className="w-full truncate text-[11px] font-medium">{tray.type ?? t('printer.tray_empty')}</span>
                    <span className="text-muted-foreground text-[10px] tabular-nums">{tray.remain !== null && tray.remain >= 0 ? `${tray.remain}%` : '-'}</span>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
        {external ? (
          <div className="flex items-center gap-2 text-xs">
            <span className="size-4 rounded-full border" style={{ background: external.color ?? 'transparent' }} />
            <span className="text-muted-foreground">{t('printer.external_spool')}</span>
            <span className="font-medium">{external.type ?? '-'}</span>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

const HMS_TONE: Record<string, string> = {
  fatal: 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400',
  serious: 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400',
  common: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  info: 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400',
}

const DIAGNOSIS_TONE: Record<string, string> = {
  critical: HMS_TONE.fatal,
  warning: HMS_TONE.common,
  info: HMS_TONE.info,
}

export function PrinterAlertsCard({ printer }: { printer: Printer }) {
  const t = useT()
  const { config } = useAgent()
  const [diagnosis, setDiagnosis] = useState<PrinterDiagnosis | null>(null)
  const [running, setRunning] = useState(false)
  const alerts = printer.status.extra.hms ?? []
  const failed = printer.status.state === 'error'
  const aiReady = Boolean(config?.ai?.apiKey)
  const auto = config?.watch?.autoDiagnose ?? false

  // Agent tự chẩn đoán ngay lúc máy báo lỗi, mở trang lên là thấy kết quả chứ không phải bấm lại.
  useEffect(() => {
    if (!auto || !aiReady) return
    let alive = true
    void api
      .lastDiagnosis(printer.id)
      .then((data) => {
        if (alive && data.diagnosis?.summary) setDiagnosis(data.diagnosis)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [auto, aiReady, printer.id, printer.status.state])

  const diagnose = async () => {
    setRunning(true)
    try {
      setDiagnosis(await api.diagnosePrinter(printer.id))
    } catch (error) {
      reportError(error)
    } finally {
      setRunning(false)
    }
  }

  if (!hasAlerts(printer)) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('printer.alerts')}</CardTitle>
        <CardAction>
          <Button size="sm" variant="outline" disabled={running || !aiReady} onClick={diagnose}>
            <Stethoscope className={cn(running && 'animate-pulse')} />
            {t('printer.diagnose')}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {alerts.map((alert) => (
          <div key={alert.code} className={cn('space-y-1 rounded-lg border p-2.5 text-xs', HMS_TONE[alert.severity ?? ''] ?? 'border-border bg-muted/40')}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{alert.severity ? t(`printer.hms_${alert.severity}` as never) : t('printer.hms')}</span>
              <span className="font-mono text-[11px] opacity-70">{alert.code}</span>
            </div>
            <p className="leading-relaxed">{alert.text ?? t('printer.hms_unknown')}</p>
          </div>
        ))}
        {failed && alerts.length === 0 ? <p className="text-muted-foreground text-xs">{t('printer.alerts_state_only')}</p> : null}
        {!aiReady ? <p className="text-muted-foreground text-xs">{t('printer.diagnose_off')}</p> : null}
        {diagnosis ? (
          <div className={cn('space-y-2 rounded-lg border p-2.5 text-xs', DIAGNOSIS_TONE[diagnosis.severity] ?? 'border-border bg-muted/40')}>
            <p className="leading-relaxed font-medium">{diagnosis.summary}</p>
            {diagnosis.causes.length > 0 ? (
              <div className="space-y-1">
                <div className="opacity-80">{t('printer.diagnose_causes')}</div>
                <ul className="list-disc space-y-0.5 pl-4">
                  {diagnosis.causes.map((cause) => (
                    <li key={cause} className="leading-relaxed">
                      {cause}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {diagnosis.steps.length > 0 ? (
              <div className="space-y-1">
                <div className="opacity-80">{t('printer.diagnose_steps')}</div>
                <ol className="list-decimal space-y-0.5 pl-4">
                  {diagnosis.steps.map((step) => (
                    <li key={step} className="leading-relaxed">
                      {step}
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-2 pt-0.5">
              <span className="text-[11px] opacity-70">{t('printer.diagnose_model', { model: diagnosis.model })}</span>
              <Button size="sm" variant="ghost" onClick={() => setDiagnosis(null)}>
                {t('common.close')}
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

export function PrinterFilesCard({ printer }: { printer: Printer }) {
  const t = useT()
  const { confirm, dialog } = useConfirm()
  const [files, setFiles] = useState<PrinterFile[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const online = printer.status.online
  const enabled = canPrinterFiles(printer)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setFiles((await api.printerFiles(printer.id)).files)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [printer.id])

  useEffect(() => {
    if (enabled && online && printer.driver !== 'bambu') void load()
  }, [enabled, online, load, printer.driver])

  if (!enabled) return null

  const start = (file: PrinterFile) =>
    confirm({
      title: t('printer.files_start_title', { file: file.name }),
      description: printer.bedClear ? t('printer.files_start_description') : t('printer.files_start_bed'),
      confirmLabel: t('printer.files_start'),
      onConfirm: async () => {
        try {
          await api.startPrinterFile(printer.id, file.name)
          toast.success(t('print_dialog.started', { printer: printer.name }))
        } catch (err) {
          reportError(err)
        }
      },
    })

  const remove = (file: PrinterFile) =>
    confirm({
      title: t('printer.files_delete_title', { file: file.name }),
      confirmLabel: t('common.delete'),
      destructive: true,
      onConfirm: async () => {
        try {
          await api.deletePrinterFile(printer.id, file.path || file.name)
          setFiles((prev) => prev?.filter((item) => item.name !== file.name) ?? null)
        } catch (err) {
          reportError(err)
        }
      },
    })

  return (
    <Card>
      {dialog}
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <FolderOpen className="size-4" /> {t('printer.files')}
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading || !online}>
          <RefreshCw className={loading ? 'animate-spin' : ''} /> {files ? t('common.refresh') : t('printer.files_load')}
        </Button>
      </CardHeader>
      <CardContent>
        {error ? <p className="text-destructive text-xs">{error}</p> : null}
        {!files && !error ? (
          <p className="text-muted-foreground text-xs">{online ? (loading ? t('common.loading') : t('printer.files_hint')) : t('printer.offline_hint')}</p>
        ) : null}
        {files && files.length === 0 ? <p className="text-muted-foreground text-xs">{t('printer.files_empty')}</p> : null}
        {files && files.length > 0 ? (
          <div className="-mx-2 max-h-80 overflow-y-auto">
            {files.map((file) => (
              <div key={file.path || file.name} className="hover:bg-accent/40 flex items-center gap-2 rounded-md px-2 py-1.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm" title={file.path}>
                    {file.name}
                  </div>
                  <div className="text-muted-foreground text-[11px]">
                    {formatBytes(file.size)}
                    {file.estimatedTime ? ` · ${formatDuration(file.estimatedTime)}` : ''}
                    {file.modifiedAt ? ` · ${formatTime(file.modifiedAt)}` : ''}
                  </div>
                </div>
                {printer.capabilities.start ? (
                  <Button variant="ghost" size="icon" className="size-7" title={t('printer.files_start')} onClick={() => start(file)}>
                    <Play />
                  </Button>
                ) : null}
                <Button variant="ghost" size="icon" className="text-destructive size-7" title={t('common.delete')} onClick={() => remove(file)}>
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

const VERDICT_TONE: Record<string, string> = {
  ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  suspect: HMS_TONE.common,
  failed: HMS_TONE.fatal,
  unclear: 'border-border bg-muted/40',
}

export function PrintInspectCard({ printer }: { printer: Printer }) {
  const t = useT()
  const { config } = useAgent()
  const [result, setResult] = useState<PrintInspection | null>(null)
  const [watch, setWatch] = useState<WatchStatus | null>(null)
  const [running, setRunning] = useState(false)
  const aiReady = Boolean(config?.ai?.apiKey)
  const printing = printer.status.state === 'printing' || printer.status.state === 'paused'

  useEffect(() => {
    let alive = true
    void api
      .lastInspection(printer.id)
      .then((data) => {
        if (!alive) return
        setWatch(data.watch)
        if (data.inspection) setResult(data.inspection)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [printer.id, printer.status.state])

  const inspect = async () => {
    setRunning(true)
    try {
      setResult(await api.inspectPrint(printer.id))
    } catch (error) {
      reportError(error)
    } finally {
      setRunning(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('printer.inspect')}</CardTitle>
        <CardAction>
          <Button size="sm" variant="outline" disabled={running || !aiReady || !printer.status.online} onClick={inspect}>
            <ScanEye className={cn(running && 'animate-pulse')} />
            {t('printer.inspect_now')}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-2.5">
        <p className="text-muted-foreground text-xs">
          {!aiReady
            ? t('printer.inspect_off')
            : watch?.enabled
              ? t('printer.inspect_watching', { minutes: watch.intervalMin })
              : t('printer.inspect_manual')}
        </p>
        {result ? (
          <div className={cn('space-y-2 rounded-lg border p-2.5 text-xs', VERDICT_TONE[result.verdict] ?? 'border-border bg-muted/40')}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{t(`printer.verdict_${result.verdict}` as never)}</span>
              <span className="text-[11px] opacity-70">{t('printer.inspect_confidence', { percent: Math.round(result.confidence * 100) })}</span>
            </div>
            <p className="leading-relaxed">{result.summary}</p>
            {result.advice.length > 0 ? (
              <ul className="list-disc space-y-0.5 pl-4">
                {result.advice.map((item) => (
                  <li key={item} className="leading-relaxed">
                    {item}
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex items-center justify-between gap-2 pt-0.5 text-[11px] opacity-70">
              <span>{result.layer ? t('printer.inspect_at_layer', { layer: result.layer }) : t('printer.inspect_at', { time: formatTime(result.at) })}</span>
              <span>{formatTime(result.at)}</span>
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">{printing ? t('printer.inspect_empty') : t('printer.inspect_idle')}</p>
        )}
      </CardContent>
    </Card>
  )
}

/** Việc bảo trì đếm theo giờ in thực tế; tới hạn thì agent nhắc qua Telegram một lần mỗi chu kỳ. */
export function MaintenanceCard({ printer }: { printer: Printer }) {
  const t = useT()
  const { jobs } = useAgent()
  const { confirm, dialog } = useConfirm()
  const [info, setInfo] = useState<MaintenanceInfo | null>(null)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [hours, setHours] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const finished = jobs.filter((job) => job.printerId === printer.id && job.finishedAt).length

  const load = useCallback(async () => {
    try {
      setInfo(await api.maintenance(printer.id))
    } catch (error) {
      reportError(error)
    }
  }, [printer.id])

  useEffect(() => {
    void load()
  }, [load, finished])

  const run = async (key: string, action: () => Promise<unknown>, success: string) => {
    setBusy(key)
    try {
      await action()
      toast.success(success)
      await load()
      return true
    } catch (error) {
      reportError(error)
      return false
    } finally {
      setBusy(null)
    }
  }

  const add = async () => {
    const interval = Number(hours)
    if (!name.trim() || !(interval >= 1)) return
    if (await run('add', () => api.addMaintenance(printer.id, { name: name.trim(), intervalHours: interval }), t('maintenance.added'))) {
      setName('')
      setHours('')
      setAdding(false)
    }
  }

  return (
    <Card>
      {dialog}
      <CardHeader>
        <CardTitle>{t('maintenance.title')}</CardTitle>
        <CardAction>
          <Button size="xs" variant="outline" onClick={() => setAdding((prev) => !prev)}>
            <Plus /> {t('maintenance.add')}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {info ? (
          <p className="text-muted-foreground text-xs">
            {t('maintenance.usage', { hours: formatNumber(info.usage.printHours, 1), jobs: info.usage.jobs })}
          </p>
        ) : null}
        {adding ? (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              void add()
            }}
          >
            <Input className="h-8" value={name} autoFocus placeholder={t('maintenance.name_placeholder')} onChange={(event) => setName(event.target.value)} />
            <Input
              className="h-8 w-28 shrink-0"
              type="number"
              min={1}
              value={hours}
              placeholder={t('maintenance.interval_placeholder')}
              onChange={(event) => setHours(event.target.value)}
            />
            <Button type="submit" size="sm" disabled={busy === 'add' || !name.trim() || !hours}>
              {t('common.save')}
            </Button>
          </form>
        ) : null}
        {info?.tasks.map((task) => (
          <div key={task.id} className="space-y-1.5">
            <div className="flex items-center gap-2 text-sm">
              {task.due ? <AlertTriangle className="text-warn size-3.5 shrink-0" /> : null}
              <span className="min-w-0 flex-1 truncate" title={task.name}>
                {task.name}
              </span>
              <span className={cn('shrink-0 text-xs tabular-nums', task.due ? 'text-warn' : 'text-muted-foreground')}>
                {task.due
                  ? t('maintenance.overdue', { hours: formatNumber(Math.max(0, -task.remainingHours), 1) })
                  : t('maintenance.remaining', { hours: formatNumber(task.remainingHours, 1) })}
              </span>
              <Button
                size="icon-xs"
                variant="ghost"
                title={t('maintenance.done')}
                aria-label={t('maintenance.done')}
                disabled={busy === task.id}
                onClick={() => void run(task.id, () => api.completeMaintenance(printer.id, task.id), t('maintenance.done_toast', { name: task.name }))}
              >
                <CheckCircle2 />
              </Button>
              {task.custom ? (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={t('common.delete')}
                  onClick={() =>
                    confirm({
                      title: t('maintenance.delete_title', { name: task.name }),
                      confirmLabel: t('common.delete'),
                      destructive: true,
                      onConfirm: () => void run(task.id, () => api.deleteMaintenance(printer.id, task.id), t('maintenance.deleted')),
                    })
                  }
                >
                  <Trash2 />
                </Button>
              ) : null}
            </div>
            <ProgressBar value={task.percent} tone={task.due ? 'muted' : 'brand'} />
            <div className="text-muted-foreground text-[11px]">
              {t('maintenance.cycle', { used: formatNumber(task.usedHours, 1), interval: task.intervalHours })}
              {task.doneAt ? ` · ${t('maintenance.last_done', { time: formatTime(task.doneAt) })}` : ''}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
