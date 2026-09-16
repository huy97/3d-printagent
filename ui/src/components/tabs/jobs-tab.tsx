import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ArrowDown, ArrowUp, Ban, ChevronsDown, ChevronsUp, Layers, LineChart, MoreHorizontal, Play, RotateCcw, Trash2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { JobTempChart } from '@/components/temp-chart'
import { SelectField } from '@/components/select-field'
import { StatusBadge } from '@/components/status-badge'
import { ProgressBar } from '@/components/progress-bar'
import { FileThumb } from '@/components/file-thumb'
import { CopyButton } from '@/components/copy-button'
import { PrintDialog } from '@/components/print-dialog'
import { useConfirm } from '@/components/confirm-dialog'
import { reportError, useAgent } from '@/hooks/use-agent'
import { useI18n, useT } from '@/i18n'
import { translateOptional } from '@/i18n/locale'
import { api, type Job, type LibraryFile } from '@/lib/api'
import { formatDayTime, formatDuration, formatEta, formatGrams, formatMoney, formatTime } from '@/lib/format'
import { cn } from '@/lib/utils'

const ACTIVE = new Set(['uploading', 'starting', 'printing', 'paused'])
const FINAL = new Set(['completed', 'failed', 'canceled'])
const FILTERS = ['all', 'active', 'queued', 'finished'] as const
type Filter = (typeof FILTERS)[number]

function matches(job: Job, filter: Filter) {
  if (filter === 'active') return ACTIVE.has(job.status)
  if (filter === 'queued') return job.status === 'queued'
  if (filter === 'finished') return FINAL.has(job.status)
  return true
}

/** Cùng thứ tự máy chủ dùng để lấy job tiếp theo: ưu tiên cao trước, cùng mức thì theo vị trí. */
function queueOrder(left: Job, right: Job) {
  return (right.priority ?? 0) - (left.priority ?? 0) || (left.position ?? Date.parse(left.createdAt)) - (right.position ?? Date.parse(right.createdAt))
}

function jobDuration(job: Job) {
  if (!job.startedAt) return null
  const end = job.finishedAt ? new Date(job.finishedAt).getTime() : Date.now()
  return (end - new Date(job.startedAt).getTime()) / 1000
}

export function JobRow({ job, file, onReprint }: { job: Job; file: LibraryFile | null; onReprint: (job: Job) => void }) {
  const t = useT()
  const { locale } = useI18n()
  const originLabel = translateOptional(locale, `jobs.origin.${job.origin}`)
  const { printers, upsertJob } = useAgent()
  const { confirm, dialog } = useConfirm()
  const [busy, setBusy] = useState(false)
  const [showTemps, setShowTemps] = useState(false)
  const printer = printers.find((item) => item.id === job.printerId)
  const forecastPrinter = job.forecast ? printers.find((item) => item.id === job.forecast?.printerId) : undefined
  const queued = job.status === 'queued'
  const pooled = !job.printerId
  const active = ACTIVE.has(job.status)
  const uploadPercent = job.upload && job.upload.total ? (job.upload.sent / job.upload.total) * 100 : null
  const duration = jobDuration(job)
  const planned = job.adjustedTime ?? job.estimatedTime
  const priority = job.priority ?? 0

  const act = async (action: () => Promise<Job | { deleted: boolean }>, success?: string) => {
    setBusy(true)
    try {
      const result = await action()
      if ('id' in result) upsertJob(result)
      if (success) toast.success(success)
    } catch (error) {
      reportError(error)
    } finally {
      setBusy(false)
    }
  }

  // Job ở hàng đợi chung chưa có máy thì bắt đầu trên máy mà dự báo đang xếp cho nó.
  const startPrinter = printer ?? forecastPrinter
  const start = () => {
    if (!startPrinter) {
      toast.error(t('jobs.no_printer_for_pool'))
      return
    }
    const target = pooled ? startPrinter.id : undefined
    if (!startPrinter.bedClear) {
      confirm({
        title: t('jobs.confirm_bed_title'),
        description: t('jobs.confirm_bed_description', { printer: startPrinter.name }),
        confirmLabel: t('jobs.start'),
        onConfirm: () => act(() => api.startJob(job.id, true, target), t('jobs.started')),
      })
      return
    }
    void act(() => api.startJob(job.id, false, target), t('jobs.started'))
  }

  const cancel = (force: boolean) =>
    confirm({
      title: force ? t('jobs.force_cancel_title') : t('jobs.cancel_title'),
      description: force ? t('jobs.force_cancel_description') : t('jobs.cancel_description', { file: job.fileName }),
      confirmLabel: force ? t('jobs.force_cancel') : t('jobs.cancel'),
      destructive: true,
      onConfirm: () => act(() => api.cancelJob(job.id, force), t('jobs.canceled')),
    })

  const remove = () => void act(() => api.deleteJob(job.id), t('jobs.deleted'))
  const move = (direction: 'up' | 'down' | 'top' | 'bottom') => void act(() => api.moveJob(job.id, direction))
  const bump = (delta: number) => void act(() => api.updateJob(job.id, { priority: priority + delta }))
  const cancelBatch = () =>
    confirm({
      title: t('jobs.cancel_batch_title'),
      description: t('jobs.cancel_batch_description', { file: job.fileName }),
      confirmLabel: t('jobs.cancel_batch'),
      destructive: true,
      onConfirm: async () => {
        if (!job.batch) return
        try {
          const result = await api.cancelBatch(job.batch.id)
          toast.success(t('jobs.batch_canceled', { count: result.canceled }))
          if (result.failed.length > 0) {
            toast.error(t('jobs.batch_cancel_failed', { names: result.failed.map((item) => item.printerName ?? item.jobId).join(', ') }))
          }
        } catch (error) {
          reportError(error)
        }
      },
    })

  return (
    <div className="flex flex-col gap-3 border-b px-4 py-3 last:border-b-0 sm:flex-row sm:items-center">
      {dialog}
      <Dialog open={showTemps} onOpenChange={setShowTemps}>
        <DialogContent className="flex max-h-[92dvh] flex-col sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t('jobs.temps_title', { file: job.fileName })}</DialogTitle>
            <DialogDescription>
              {printer?.name ?? job.printerName} · {formatTime(job.startedAt ?? job.createdAt)}
              {job.finishedAt ? ` - ${formatTime(job.finishedAt)}` : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>{showTemps ? <JobTempChart jobId={job.id} active={active} /> : null}</DialogBody>
        </DialogContent>
      </Dialog>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {file ? (
          <FileThumb file={file} className="size-11 shrink-0" />
        ) : (
          <div className="bg-muted text-muted-foreground flex size-11 shrink-0 items-center justify-center rounded-md">
            <Layers className="size-4" />
          </div>
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 truncate text-sm font-medium">{job.fileName}</span>
            <StatusBadge status={job.status} />
            {queued && priority !== 0 ? (
              <span className={cn('rounded-full px-1.5 text-[10px] font-medium', priority > 0 ? 'bg-brand/15 text-brand' : 'bg-muted text-muted-foreground')}>
                {t('jobs.priority_n', { n: priority > 0 ? `+${priority}` : String(priority) })}
              </span>
            ) : null}
            {job.batch ? (
              <span className="bg-muted text-muted-foreground rounded-full px-1.5 text-[10px] font-medium">
                {t('jobs.batch_n', { index: job.batch.index, total: job.batch.total })}
              </span>
            ) : null}
          </div>
          <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
            <span className="text-foreground/80">
              {printer?.name ?? job.printerName ?? (forecastPrinter ? t('jobs.pool_on', { printer: forecastPrinter.name }) : t('jobs.pool'))}
            </span>
            {job.options.plate ? <span>{t('print_dialog.plate_n', { n: job.options.plate })}</span> : null}
            <span>{formatTime(job.startedAt ?? job.createdAt)}</span>
            {duration !== null ? <span>{formatDuration(duration)}</span> : planned ? <span>~{formatDuration(planned)}</span> : null}
            {queued && job.forecast ? (
              <span>
                {t('jobs.forecast', {
                  start: job.forecast.startAt ? formatDayTime(Date.parse(job.forecast.startAt)) : t('jobs.forecast_now'),
                  finish: formatDayTime(Date.parse(job.forecast.finishAt)),
                })}
              </span>
            ) : null}
            {job.layer !== null && job.totalLayers ? (
              <span>{t('jobs.layer', { layer: job.layer, total: job.totalLayers })}</span>
            ) : null}
            {job.material && job.material.usedG > 0 ? (
              <span>{t('jobs.material_used', { used: formatGrams(job.material.usedG), waste: formatGrams(job.material.wasteG) })}</span>
            ) : null}
            {job.cost && job.cost.total > 0 ? <span>{formatMoney(job.cost.total, job.cost.currency)}</span> : null}
            <span className={originLabel ? undefined : 'font-mono'}>{originLabel ?? job.origin}</span>
          </div>
          {active ? (
            <div className="flex items-center gap-2 pt-0.5">
              <ProgressBar
                value={job.status === 'uploading' ? uploadPercent : job.progress}
                tone={job.status === 'uploading' ? 'info' : 'brand'}
                className="max-w-80"
              />
              <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                {job.status === 'uploading' ? `${Math.round(uploadPercent ?? 0)}%` : `${Math.round(job.progress ?? 0)}%`}
                {job.remaining ? ` · ${t('jobs.remaining', { time: formatDuration(job.remaining), eta: formatEta(job.remaining) ?? '' })}` : ''}
              </span>
            </div>
          ) : null}
          {job.error ? (
            <div className="text-destructive flex items-start gap-1 text-xs">
              <span className="min-w-0 flex-1 break-words">{job.error}</span>
              <CopyButton value={job.error} className="size-5 shrink-0" />
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-end gap-1.5">
        {queued ? (
          <>
            <Button size="icon-sm" variant="ghost" title={t('jobs.move_up')} aria-label={t('jobs.move_up')} disabled={busy} onClick={() => move('up')}>
              <ArrowUp />
            </Button>
            <Button size="icon-sm" variant="ghost" title={t('jobs.move_down')} aria-label={t('jobs.move_down')} disabled={busy} onClick={() => move('down')}>
              <ArrowDown />
            </Button>
            <Button size="sm" onClick={start} disabled={busy}>
              <Play /> {t('jobs.start')}
            </Button>
          </>
        ) : null}
        {queued || active ? (
          <Button size="sm" variant="outline" onClick={() => cancel(false)} disabled={busy}>
            <XCircle /> {t('jobs.cancel')}
          </Button>
        ) : null}
        {FINAL.has(job.status) && job.fileId ? (
          <Button size="sm" variant="outline" onClick={() => onReprint(job)} disabled={busy || !file}>
            <RotateCcw /> {t('jobs.reprint')}
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={t('common.more')} />}>
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {queued ? (
              <>
                <DropdownMenuItem onClick={() => move('top')}>
                  <ChevronsUp /> {t('jobs.move_top')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => move('bottom')}>
                  <ChevronsDown /> {t('jobs.move_bottom')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => bump(1)}>
                  <ArrowUp /> {t('jobs.priority_up')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => bump(-1)}>
                  <ArrowDown /> {t('jobs.priority_down')}
                </DropdownMenuItem>
              </>
            ) : null}
            <DropdownMenuItem disabled={!job.startedAt} onClick={() => setShowTemps(true)}>
              <LineChart /> {t('jobs.view_temps')}
            </DropdownMenuItem>
            {job.batch && (queued || active) ? (
              <DropdownMenuItem variant="destructive" onClick={cancelBatch}>
                <XCircle /> {t('jobs.cancel_batch')}
              </DropdownMenuItem>
            ) : null}
            {active ? (
              <DropdownMenuItem variant="destructive" onClick={() => cancel(true)}>
                <Ban /> {t('jobs.force_cancel')}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem variant="destructive" disabled={!FINAL.has(job.status) && !queued} onClick={remove}>
              <Trash2 /> {t('common.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

export function JobsTab() {
  const t = useT()
  const { jobs, files, printers } = useAgent()
  const { confirm, dialog } = useConfirm()
  const [filter, setFilter] = useState<Filter>('all')
  const [printerId, setPrinterId] = useState('all')
  const [reprint, setReprint] = useState<{ file: LibraryFile; printerId: string | null } | null>(null)

  const fileMap = useMemo(() => new Map(files.map((file) => [file.id, file])), [files])
  const filtered = jobs.filter(
    (job) => matches(job, filter) && (printerId === 'all' || (printerId === 'any' ? !job.printerId : job.printerId === printerId)),
  )
  const visible = filter === 'queued' ? [...filtered].sort(queueOrder) : filtered
  const counts = Object.fromEntries(FILTERS.map((item) => [item, jobs.filter((job) => matches(job, item)).length])) as Record<Filter, number>
  const pooled = jobs.some((job) => job.status === 'queued' && !job.printerId)

  const clear = () =>
    confirm({
      title: t('jobs.clear_title'),
      description: t('jobs.clear_description'),
      confirmLabel: t('jobs.clear'),
      destructive: true,
      onConfirm: async () => {
        try {
          const result = await api.clearJobs()
          toast.success(t('jobs.cleared', { count: result.removed }))
        } catch (error) {
          reportError(error)
        }
      },
    })

  return (
    <div className="space-y-4">
      {dialog}
      <Card className="gap-0 py-0">
        <CardHeader className="flex flex-wrap items-center gap-3 border-b py-4">
          <div className="min-w-0 flex-1">
            <CardTitle>{t('jobs.title')}</CardTitle>
            <CardDescription>{t('jobs.description')}</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="bg-muted/60 flex rounded-lg p-0.5">
              {FILTERS.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setFilter(item)}
                  className={cn(
                    'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors',
                    filter === item ? 'bg-card text-foreground font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t(`jobs.filter.${item}`)}
                  <span className="font-mono text-[10px] opacity-70">{counts[item]}</span>
                </button>
              ))}
            </div>
            <SelectField
              className="h-8 w-44"
              value={printerId}
              onChange={setPrinterId}
              options={[
                { value: 'all', label: t('jobs.all_printers') },
                ...(pooled || printerId === 'any' ? [{ value: 'any', label: t('jobs.pool') }] : []),
                ...printers.map((item) => ({ value: item.id, label: item.name })),
              ]}
            />
            <Button size="sm" variant="outline" onClick={clear} disabled={counts.finished === 0}>
              <Trash2 /> {t('jobs.clear')}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="px-0">
          {visible.length === 0 ? (
            <div className="text-muted-foreground flex flex-col items-center gap-2 py-14 text-sm">
              <Layers className="size-6 opacity-50" />
              {t('jobs.empty')}
            </div>
          ) : (
            visible.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                file={job.fileId ? (fileMap.get(job.fileId) ?? null) : null}
                onReprint={(item) => {
                  const file = item.fileId ? fileMap.get(item.fileId) : null
                  if (file) setReprint({ file, printerId: item.printerId })
                }}
              />
            ))
          )}
        </CardContent>
      </Card>

      <PrintDialog
        open={Boolean(reprint)}
        onOpenChange={(open) => !open && setReprint(null)}
        file={reprint?.file ?? null}
        printerId={reprint?.printerId}
      />
    </div>
  )
}
