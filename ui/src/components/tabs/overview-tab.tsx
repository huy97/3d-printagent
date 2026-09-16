import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Activity, Files, Layers, Printer as PrinterIcon, Globe, Wrench } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/status-badge'
import { ProgressBar } from '@/components/progress-bar'
import { FileThumb } from '@/components/file-thumb'
import { JobRow } from '@/components/tabs/jobs-tab'
import { StatFigure } from '@/components/tabs/filament-tab'
import { PrintDialog } from '@/components/print-dialog'
import { useAgent } from '@/hooks/use-agent'
import { useT } from '@/i18n'
import { api, type LibraryFile, type PrintStats, type Printer } from '@/lib/api'
import { formatBytes, formatDuration, formatEta, formatGrams, formatMoney, formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

function StatTile({ icon: Icon, label, value, detail, onClick }: { icon: typeof Activity; label: string; value: string; detail?: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="bg-card hover:bg-accent/40 flex items-start gap-3 rounded-xl border p-4 text-left transition-colors"
    >
      <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-lg">
        <Icon className="size-4.5" />
      </div>
      <div className="min-w-0">
        <div className="text-muted-foreground text-xs">{label}</div>
        <div className="text-2xl leading-tight font-semibold tabular-nums">{value}</div>
        {detail ? <div className="text-muted-foreground truncate text-xs">{detail}</div> : null}
      </div>
    </button>
  )
}

function PrinterCard({ printer, onOpen }: { printer: Printer; onOpen: () => void }) {
  const t = useT()
  const { files, jobs } = useAgent()
  const { status } = printer
  const job = status.job
  const active = status.state === 'printing' || status.state === 'paused'
  const agentJob = jobs.find((item) => item.printerId === printer.id && ['uploading', 'starting', 'printing', 'paused'].includes(item.status))
  const file = agentJob?.fileId ? files.find((item) => item.id === agentJob.fileId) : null
  const queued = jobs.filter((item) => item.printerId === printer.id && item.status === 'queued').length

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'bg-card hover:border-brand/50 flex flex-col gap-3 rounded-xl border p-4 text-left transition-colors',
        !printer.enabled && 'opacity-60',
      )}
    >
      <div className="flex w-full items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{printer.name}</div>
          <div className="text-muted-foreground truncate text-xs">{printer.driverLabel}</div>
        </div>
        <StatusBadge status={printer.enabled ? status.state : 'disabled'} />
      </div>

      {active && job ? (
        <div className="flex w-full gap-3">
          {file ? <FileThumb file={file} className="size-14" /> : null}
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-xs" title={job.file ?? ''}>
                {job.file}
              </span>
              <span className="text-lg font-semibold tabular-nums">{Math.round(job.progress ?? 0)}%</span>
            </div>
            <ProgressBar value={job.progress} />
            <div className="text-muted-foreground flex justify-between gap-2 text-[11px] tabular-nums">
              <span>
                {job.layer !== null && job.totalLayers ? t('jobs.layer', { layer: job.layer, total: job.totalLayers }) : formatDuration(job.elapsed)}
              </span>
              <span>{job.remaining ? `${formatDuration(job.remaining)} · ${formatEta(job.remaining)}` : ''}</span>
            </div>
          </div>
        </div>
      ) : (
        <p className={cn('w-full truncate text-xs', status.state === 'error' || !status.online ? 'text-destructive' : 'text-muted-foreground')}>
          {status.message ?? (printer.bedClear ? t('overview.ready_hint') : t('printer.bed_not_clear'))}
        </p>
      )}

      <div className="flex w-full flex-wrap gap-x-4 gap-y-1 border-t pt-2.5 text-xs">
        {(['nozzle', 'bed', 'chamber'] as const)
          .filter((key) => status.temps[key])
          .map((key) => {
            const temp = status.temps[key]!
            return (
              <span key={key} className="flex items-center gap-1.5">
                <span className="size-2 rounded-full" style={{ background: `var(--series-${key})` }} />
                <span className="text-muted-foreground">{t(`temp.${key}`)}</span>
                <span className="font-medium tabular-nums">
                  {Math.round(temp.actual)}°{temp.target ? <span className="text-muted-foreground font-normal">/{Math.round(temp.target)}°</span> : null}
                </span>
              </span>
            )
          })}
        {queued > 0 ? <span className="text-muted-foreground ml-auto">{t('overview.queued_count', { count: queued })}</span> : null}
      </div>
    </button>
  )
}

function PerformanceCard() {
  const t = useT()
  const navigate = useNavigate()
  const { jobs } = useAgent()
  const [stats, setStats] = useState<PrintStats | null>(null)
  const finished = jobs.filter((job) => job.finishedAt).length

  useEffect(() => {
    api
      .stats({ days: 30 })
      .then(setStats)
      .catch(() => setStats(null))
  }, [finished])

  if (!stats || (stats.totals.jobs === 0 && stats.maintenanceDue.length === 0)) return null
  const totals = stats.totals

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex flex-row items-center justify-between border-b py-4">
        <CardTitle>{t('overview.performance')}</CardTitle>
        <Button variant="ghost" size="sm" onClick={() => navigate('/filament')}>
          {t('overview.view_all')}
        </Button>
      </CardHeader>
      <CardContent className="grid gap-5 py-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatFigure
          label={t('filament.success_rate')}
          value={totals.successRate === null ? '-' : `${formatNumber(totals.successRate, 1)}%`}
          detail={t('filament.jobs_summary', { completed: totals.completed, failed: totals.failed, canceled: totals.canceled })}
        />
        <StatFigure
          label={t('filament.used')}
          value={formatGrams(totals.usedG)}
          detail={t('filament.used_detail', { product: formatGrams(totals.productG), time: formatDuration(totals.printSeconds) })}
        />
        <StatFigure
          label={t('filament.waste_rate')}
          value={totals.wasteRate === null ? '-' : `${formatNumber(totals.wasteRate, 1)}%`}
          detail={t('filament.waste_amount', { waste: formatGrams(totals.wasteG) })}
          tone={totals.wasteRate !== null && totals.wasteRate >= 25 ? 'warn' : undefined}
        />
        <StatFigure
          label={t('filament.cost')}
          value={formatMoney(totals.cost.total, stats.currency)}
          detail={t('filament.cost_detail', {
            filament: formatMoney(totals.cost.filament, stats.currency),
            electricity: formatMoney(totals.cost.electricity, stats.currency),
            wear: formatMoney(totals.cost.wear, stats.currency),
          })}
        />
      </CardContent>
      {stats.maintenanceDue.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-4 py-3 text-xs">
          <span className="text-warn flex items-center gap-1.5 font-medium">
            <Wrench className="size-3.5" /> {t('overview.maintenance_due', { count: stats.maintenanceDue.length })}
          </span>
          {stats.maintenanceDue.slice(0, 4).map((task) => (
            <button
              key={task.id}
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => navigate(`/printers/${encodeURIComponent(task.printerId)}`)}
            >
              {task.printerName}: {task.name}
            </button>
          ))}
        </div>
      ) : null}
    </Card>
  )
}

export function OverviewTab() {
  const t = useT()
  const navigate = useNavigate()
  const { printers, files, jobs, health, tunnel, queuedCount } = useAgent()
  const online = printers.filter((printer) => printer.status.online).length
  const printing = printers.filter((printer) => printer.status.state === 'printing').length
  const recent = useMemo(() => jobs.slice(0, 6), [jobs])
  const fileMap = useMemo(() => new Map(files.map((file) => [file.id, file])), [files])
  const librarySize = files.reduce((sum, file) => sum + file.size, 0)
  const tunnelStatus = tunnel?.status ?? health?.tunnel?.status ?? 'stopped'
  const [reprint, setReprint] = useState<{ file: LibraryFile; printerId: string | null } | null>(null)

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          icon={PrinterIcon}
          label={t('overview.printers_online')}
          value={`${online}/${printers.length}`}
          detail={t('overview.printing_now', { count: printing })}
          onClick={() => navigate('/printers')}
        />
        <StatTile
          icon={Layers}
          label={t('overview.queue')}
          value={String(queuedCount)}
          detail={t('overview.jobs_total', { count: jobs.length })}
          onClick={() => navigate('/jobs')}
        />
        <StatTile
          icon={Files}
          label={t('overview.library')}
          value={String(files.length)}
          detail={formatBytes(librarySize)}
          onClick={() => navigate('/files')}
        />
        <StatTile
          icon={Globe}
          label={t('overview.tunnel')}
          value={t(`status.${tunnelStatus === 'running' ? 'running' : 'stopped'}`)}
          detail={tunnel?.url ?? t('overview.tunnel_local')}
          onClick={() => navigate('/tunnel')}
        />
      </div>

      {printers.length === 0 ? (
        <Card className="items-center py-12 text-center">
          <PrinterIcon className="text-muted-foreground size-7" />
          <div className="space-y-1 px-4">
            <div className="font-medium">{t('printers.empty_title')}</div>
            <p className="text-muted-foreground text-sm">{t('printers.empty_description')}</p>
          </div>
          <Button onClick={() => navigate('/printers')}>{t('printers.add')}</Button>
        </Card>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-3">
          {printers.map((printer) => (
            <PrinterCard key={printer.id} printer={printer} onOpen={() => navigate(`/printers/${encodeURIComponent(printer.id)}`)} />
          ))}
        </div>
      )}

      <PerformanceCard />

      <Card className="gap-0 pb-0">
        <CardHeader className="flex flex-row items-center justify-between border-b pb-4">
          <CardTitle>{t('overview.recent_jobs')}</CardTitle>
          <Button variant="ghost" size="sm" onClick={() => navigate('/jobs')}>
            {t('overview.view_all')}
          </Button>
        </CardHeader>
        <CardContent className="px-0">
          {recent.length === 0 ? (
            <p className="text-muted-foreground py-10 text-center text-sm">{t('jobs.empty')}</p>
          ) : (
            recent.map((job) => (
              <JobRow key={job.id} job={job} file={job.fileId ? (fileMap.get(job.fileId) ?? null) : null} onReprint={(item) => {
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
