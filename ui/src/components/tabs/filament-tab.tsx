import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { AlertTriangle, Pencil, Plus, Trash2, Wrench } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Field } from '@/components/field'
import { SelectField } from '@/components/select-field'
import { ProgressBar } from '@/components/progress-bar'
import { useConfirm } from '@/components/confirm-dialog'
import { reportError, useAgent } from '@/hooks/use-agent'
import { useT } from '@/i18n'
import { api, type PrintStats, type Spool, type SpoolInput, type StatsBucket } from '@/lib/api'
import { formatDayTime, formatDuration, formatGrams, formatMoney, formatNumber, formatTime } from '@/lib/format'
import { cn } from '@/lib/utils'

const RANGES = [7, 30, 90, 0] as const
const MATERIALS = ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PA', 'PC', 'PVA']

type SpoolForm = Record<
  'name' | 'material' | 'color' | 'brand' | 'totalG' | 'remainingG' | 'lowG' | 'pricePerKg' | 'printerId' | 'slot' | 'density' | 'notes',
  string
>

function toForm(spool: Spool | null): SpoolForm {
  return {
    name: spool?.name ?? '',
    material: spool?.material ?? 'PLA',
    color: spool?.color ?? '',
    brand: spool?.brand ?? '',
    totalG: String(spool?.totalG ?? 1000),
    remainingG: spool ? String(spool.remainingG) : '',
    lowG: String(spool?.lowG ?? 100),
    pricePerKg: spool?.pricePerKg != null ? String(spool.pricePerKg) : '',
    printerId: spool?.printerId ?? '',
    slot: spool?.slot != null ? String(spool.slot) : '',
    density: spool ? String(spool.density) : '',
    notes: spool?.notes ?? '',
  }
}

const optional = (value: string) => (value.trim() === '' ? null : Number(value))

/** AMS trays are numbered from 0: 0-3 are A1-A4, 4-7 are B1-B4. */
export function slotLabel(slot: number | null) {
  if (slot === null) return null
  return `${String.fromCharCode(65 + Math.floor(slot / 4))}${(slot % 4) + 1}`
}

export function StatFigure({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: 'warn' }) {
  return (
    <div className="min-w-0">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className={cn('text-2xl leading-tight font-semibold tabular-nums', tone === 'warn' && 'text-warn')}>{value}</div>
      {detail ? <div className="text-muted-foreground truncate text-xs">{detail}</div> : null}
    </div>
  )
}

function SpoolDialog({ open, spool, onOpenChange, onSaved }: { open: boolean; spool: Spool | null; onOpenChange: (open: boolean) => void; onSaved: () => void }) {
  const t = useT()
  const { printers } = useAgent()
  const [form, setForm] = useState<SpoolForm>(() => toForm(spool))
  const [busy, setBusy] = useState(false)
  const [lastKey, setLastKey] = useState<string | null>(null)
  const key = open ? (spool?.id ?? 'new') : null
  if (key !== lastKey) {
    setLastKey(key)
    if (open) setForm(toForm(spool))
  }
  const set = (field: keyof SpoolForm) => (value: string) => setForm((prev) => ({ ...prev, [field]: value }))

  const submit = async () => {
    setBusy(true)
    try {
      const totalG = Number(form.totalG) || 1000
      const body: SpoolInput = {
        name: form.name.trim(),
        material: form.material.trim() || 'PLA',
        color: form.color.trim() || null,
        brand: form.brand.trim() || null,
        totalG,
        remainingG: form.remainingG.trim() === '' ? totalG : Number(form.remainingG),
        lowG: Number(form.lowG) || 0,
        pricePerKg: optional(form.pricePerKg),
        printerId: form.printerId || null,
        slot: optional(form.slot),
        density: optional(form.density),
        notes: form.notes.trim() || null,
      }
      await api.saveSpool(body, spool?.id)
      toast.success(t('filament.spool_saved'))
      onSaved()
      onOpenChange(false)
    } catch (error) {
      reportError(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92dvh] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{spool ? t('filament.edit_spool') : t('filament.add_spool')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="grid gap-3 sm:grid-cols-2">
          <Field label={t('filament.field.name')}>
            <Input value={form.name} placeholder="PLA Basic" onChange={(event) => set('name')(event.target.value)} />
          </Field>
          <Field label={t('filament.field.material')}>
            <Input value={form.material} list="spool-materials" onChange={(event) => set('material')(event.target.value.toUpperCase())} />
            <datalist id="spool-materials">
              {MATERIALS.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          </Field>
          <Field label={t('filament.field.color')}>
            <div className="flex items-center gap-2">
              <span className="size-8 shrink-0 rounded-md border" style={{ background: form.color || 'transparent' }} />
              <Input value={form.color} placeholder="#1A1A1A" onChange={(event) => set('color')(event.target.value)} />
            </div>
          </Field>
          <Field label={t('filament.field.brand')}>
            <Input value={form.brand} onChange={(event) => set('brand')(event.target.value)} />
          </Field>
          <Field label={t('filament.field.total')}>
            <Input type="number" min={1} value={form.totalG} onChange={(event) => set('totalG')(event.target.value)} />
          </Field>
          <Field label={t('filament.field.remaining')} hint={t('filament.field.remaining_hint')}>
            <Input type="number" min={0} value={form.remainingG} placeholder={form.totalG} onChange={(event) => set('remainingG')(event.target.value)} />
          </Field>
          <Field label={t('filament.field.low')}>
            <Input type="number" min={0} value={form.lowG} onChange={(event) => set('lowG')(event.target.value)} />
          </Field>
          <Field label={t('filament.field.price')} hint={t('filament.field.price_hint')}>
            <Input type="number" min={0} value={form.pricePerKg} onChange={(event) => set('pricePerKg')(event.target.value)} />
          </Field>
          <Field label={t('filament.field.printer')}>
            <SelectField
              value={form.printerId}
              onChange={set('printerId')}
              options={[{ value: '', label: t('filament.no_printer') }, ...printers.map((item) => ({ value: item.id, label: item.name }))]}
            />
          </Field>
          <Field label={t('filament.field.slot')} hint={t('filament.field.slot_hint')}>
            <Input type="number" min={0} max={254} value={form.slot} disabled={!form.printerId} onChange={(event) => set('slot')(event.target.value)} />
          </Field>
          <Field label={t('filament.field.density')} hint={t('filament.field.density_hint')}>
            <Input type="number" min={0.5} max={3} step={0.01} value={form.density} onChange={(event) => set('density')(event.target.value)} />
          </Field>
          <Field label={t('filament.field.notes')} className="sm:col-span-2">
            <Textarea rows={2} value={form.notes} onChange={(event) => set('notes')(event.target.value)} />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function BreakdownTable({
  title,
  rows,
  currency,
  showFactor,
}: {
  title: string
  rows: (StatsBucket & { estimate?: { factor: number; samples: number } })[]
  currency: string
  showFactor?: boolean
}) {
  const t = useT()
  const cell = 'px-3 py-2 text-right tabular-nums whitespace-nowrap'
  return (
    <Card className="gap-0 pb-0">
      <CardHeader className="border-b pb-4">
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto px-0">
        {rows.length === 0 ? (
          <p className="text-muted-foreground py-8 text-center text-sm">{t('filament.no_data')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-muted-foreground text-xs">
              <tr className="border-b">
                <th className="px-4 py-2 text-left font-normal">{t('filament.col.name')}</th>
                <th className={cn(cell, 'font-normal')}>{t('filament.col.jobs')}</th>
                <th className={cn(cell, 'font-normal')}>{t('filament.col.success')}</th>
                <th className={cn(cell, 'font-normal')}>{t('filament.col.used')}</th>
                <th className={cn(cell, 'font-normal')}>{t('filament.col.waste')}</th>
                <th className={cn(cell, 'font-normal')}>{t('filament.col.cost')}</th>
                {showFactor ? (
                  <th className={cn(cell, 'font-normal')} title={t('filament.col.time_factor_hint')}>
                    {t('filament.col.time_factor')}
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-b last:border-b-0">
                  <td className="max-w-64 truncate px-4 py-2" title={row.label}>
                    {row.label}
                  </td>
                  <td className={cell}>{row.jobs}</td>
                  <td className={cell}>{row.successRate === null ? '-' : `${formatNumber(row.successRate, 1)}%`}</td>
                  <td className={cell}>{formatGrams(row.usedG)}</td>
                  <td className={cell}>
                    {formatGrams(row.wasteG)}
                    {row.wasteRate !== null ? <span className="text-muted-foreground text-xs"> · {formatNumber(row.wasteRate, 0)}%</span> : null}
                  </td>
                  <td className={cell}>{formatMoney(row.cost.total, currency)}</td>
                  {showFactor ? <td className={cell}>{row.estimate && row.estimate.samples >= 2 ? `${Math.round(row.estimate.factor * 100)}%` : '-'}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  )
}

function DailyChart({ daily }: { daily: PrintStats['daily'] }) {
  const t = useT()
  const peak = Math.max(1, ...daily.map((day) => day.usedG))
  if (daily.length === 0) return <p className="text-muted-foreground py-8 text-center text-sm">{t('filament.no_data')}</p>
  return (
    <div className="space-y-2">
      <div className="flex h-36 items-end gap-1">
        {daily.map((day) => {
          const product = Math.max(0, day.usedG - day.wasteG)
          return (
            <div
              key={day.date}
              className="flex min-w-1 flex-1 flex-col justify-end"
              title={t('filament.daily_tip', {
                date: day.date,
                used: formatGrams(day.usedG),
                waste: formatGrams(day.wasteG),
                completed: day.completed,
                failed: day.failed,
              })}
            >
              <div className="bg-warn/80 rounded-t-sm" style={{ height: `${(day.wasteG / peak) * 100}%` }} />
              <div className={cn('bg-brand', day.wasteG > 0 ? '' : 'rounded-t-sm')} style={{ height: `${(product / peak) * 100}%` }} />
            </div>
          )
        })}
      </div>
      <div className="text-muted-foreground flex items-center justify-between text-[11px]">
        <span>{daily[0].date}</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="bg-brand size-2 rounded-sm" /> {t('filament.product')}
          </span>
          <span className="flex items-center gap-1">
            <span className="bg-warn/80 size-2 rounded-sm" /> {t('filament.waste')}
          </span>
        </span>
        <span>{daily[daily.length - 1].date}</span>
      </div>
    </div>
  )
}

export function FilamentTab() {
  const t = useT()
  const { jobs } = useAgent()
  const { confirm, dialog } = useConfirm()
  const [days, setDays] = useState<(typeof RANGES)[number]>(30)
  const [stats, setStats] = useState<PrintStats | null>(null)
  const [spools, setSpools] = useState<Spool[]>([])
  const [editing, setEditing] = useState<Spool | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const finished = jobs.filter((job) => job.finishedAt).length

  const load = useCallback(async () => {
    try {
      const [nextStats, nextSpools] = await Promise.all([api.stats({ days }), api.spools()])
      setStats(nextStats)
      setSpools(nextSpools.spools)
    } catch (error) {
      reportError(error)
    }
  }, [days])

  useEffect(() => {
    void load()
  }, [load, finished])

  const remove = (spool: Spool) =>
    confirm({
      title: t('filament.delete_title', { name: spool.name }),
      description: t('filament.delete_description'),
      confirmLabel: t('common.delete'),
      destructive: true,
      onConfirm: async () => {
        try {
          await api.deleteSpool(spool.id)
          toast.success(t('filament.spool_deleted'))
          await load()
        } catch (error) {
          reportError(error)
        }
      },
    })

  const totals = stats?.totals
  const currency = stats?.currency ?? 'VND'
  const waste = totals?.waste

  return (
    <div className="space-y-4">
      {dialog}
      <Card className="gap-0 py-0">
        <CardHeader className="flex flex-wrap items-center gap-3 border-b py-4">
          <div className="min-w-0 flex-1">
            <CardTitle>{t('filament.title')}</CardTitle>
            <CardDescription>{t('filament.description')}</CardDescription>
          </div>
          <div className="bg-muted/60 flex rounded-lg p-0.5">
            {RANGES.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setDays(item)}
                className={cn(
                  'flex h-7 items-center rounded-md px-2.5 text-xs transition-colors',
                  days === item ? 'bg-card text-foreground font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {item === 0 ? t('filament.range_all') : t('filament.range_days', { days: item })}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="grid gap-5 py-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatFigure
            label={t('filament.success_rate')}
            value={totals?.successRate == null ? '-' : `${formatNumber(totals.successRate, 1)}%`}
            detail={totals ? t('filament.jobs_summary', { completed: totals.completed, failed: totals.failed, canceled: totals.canceled }) : undefined}
          />
          <StatFigure
            label={t('filament.used')}
            value={formatGrams(totals?.usedG ?? 0)}
            detail={totals ? t('filament.used_detail', { product: formatGrams(totals.productG), time: formatDuration(totals.printSeconds) }) : undefined}
          />
          <StatFigure
            label={t('filament.waste_rate')}
            value={totals?.wasteRate == null ? '-' : `${formatNumber(totals.wasteRate, 1)}%`}
            detail={totals ? t('filament.waste_amount', { waste: formatGrams(totals.wasteG) }) : undefined}
            tone={totals?.wasteRate != null && totals.wasteRate >= 25 ? 'warn' : undefined}
          />
          <StatFigure
            label={t('filament.cost')}
            value={formatMoney(totals?.cost.total ?? 0, currency)}
            detail={
              totals
                ? t('filament.cost_detail', {
                    filament: formatMoney(totals.cost.filament, currency),
                    electricity: formatMoney(totals.cost.electricity, currency),
                    wear: formatMoney(totals.cost.wear, currency),
                  })
                : undefined
            }
          />
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>{t('filament.daily_title')}</CardTitle>
          </CardHeader>
          <CardContent>{stats ? <DailyChart daily={stats.daily} /> : null}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('filament.waste_title')}</CardTitle>
            <CardDescription>{t('filament.waste_hint')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {(['support', 'adhesion', 'purge', 'failed'] as const).map((group) => (
              <div key={group} className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span>{t(`filament.waste_${group}`)}</span>
                  <span className="text-muted-foreground tabular-nums">{formatGrams(waste?.[group] ?? 0)}</span>
                </div>
                <ProgressBar value={totals && totals.wasteG > 0 ? ((waste?.[group] ?? 0) / totals.wasteG) * 100 : 0} tone="muted" />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('filament.spools')}</CardTitle>
          <CardDescription>{t('filament.spools_hint')}</CardDescription>
          <CardAction>
            <Button
              size="sm"
              onClick={() => {
                setEditing(null)
                setDialogOpen(true)
              }}
            >
              <Plus /> {t('filament.add_spool')}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {spools.length === 0 ? (
            <p className="text-muted-foreground py-6 text-center text-sm">{t('filament.spool_empty')}</p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-2">
              {spools.map((spool) => (
                <div key={spool.id} className="space-y-2 rounded-lg border p-3">
                  <div className="flex items-start gap-2.5">
                    <span className="mt-0.5 size-7 shrink-0 rounded-full border" style={{ background: spool.color ?? 'transparent' }} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium" title={spool.name}>
                          {spool.name}
                        </span>
                        <Badge variant="secondary" className="shrink-0 text-[10px]">
                          {spool.material}
                        </Badge>
                        {spool.low ? (
                          <Badge variant="destructive" className="shrink-0 text-[10px]">
                            {t('filament.spool_low')}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="text-muted-foreground truncate text-xs">
                        {spool.printerName
                          ? `${spool.printerName}${spool.slot !== null ? ` · ${t('filament.slot_n', { slot: slotLabel(spool.slot) ?? '' })}` : ''}`
                          : t('filament.spool_unassigned')}
                        {spool.brand ? ` · ${spool.brand}` : ''}
                      </div>
                    </div>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={t('common.edit')}
                      onClick={() => {
                        setEditing(spool)
                        setDialogOpen(true)
                      }}
                    >
                      <Pencil />
                    </Button>
                    <Button size="icon-xs" variant="ghost" aria-label={t('common.delete')} onClick={() => remove(spool)}>
                      <Trash2 />
                    </Button>
                  </div>
                  <ProgressBar value={spool.remainingPercent} tone={spool.low ? 'muted' : 'brand'} />
                  <div className="text-muted-foreground flex justify-between gap-2 text-xs tabular-nums">
                    <span>{t('filament.remaining', { remaining: formatGrams(spool.remainingG), total: formatGrams(spool.totalG) })}</span>
                    <span>{spool.pricePerKg ? t('filament.price_per_kg', { price: formatMoney(spool.pricePerKg, currency) }) : ''}</span>
                  </div>
                  {spool.lastUsedAt ? <div className="text-muted-foreground text-[11px]">{t('filament.last_used', { time: formatTime(spool.lastUsedAt) })}</div> : null}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {stats && (stats.maintenanceDue.length > 0 || stats.recentFailures.length > 0) ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>{t('filament.maintenance_due')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {stats.maintenanceDue.length === 0 ? (
                <p className="text-muted-foreground text-sm">{t('filament.maintenance_ok')}</p>
              ) : (
                stats.maintenanceDue.map((task) => (
                  <Link
                    key={task.id}
                    to={`/printers/${encodeURIComponent(task.printerId)}`}
                    className="hover:bg-accent/50 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
                  >
                    <Wrench className="text-warn size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">
                      {task.printerName}: {task.name}
                    </span>
                    <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                      {t('maintenance.cycle', { used: formatNumber(task.usedHours, 1), interval: task.intervalHours })}
                    </span>
                  </Link>
                ))
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('filament.failures')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {stats.recentFailures.length === 0 ? (
                <p className="text-muted-foreground text-sm">{t('filament.no_failures')}</p>
              ) : (
                stats.recentFailures.map((failure) => (
                  <div key={failure.jobId} className="flex items-start gap-2 rounded-lg border px-3 py-2 text-sm">
                    <AlertTriangle className="text-destructive mt-0.5 size-4 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{failure.fileName}</div>
                      <div className="text-muted-foreground text-xs break-words">
                        {failure.printerName} · {formatDayTime(Date.parse(failure.finishedAt))}
                        {failure.error ? ` · ${failure.error}` : ''}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}

      {stats ? (
        <>
          <BreakdownTable title={t('filament.by_printer')} rows={stats.printers} currency={currency} showFactor />
          <div className="grid gap-4 xl:grid-cols-2">
            <BreakdownTable title={t('filament.by_material')} rows={stats.materials} currency={currency} />
            <BreakdownTable title={t('filament.by_file')} rows={stats.files} currency={currency} />
          </div>
        </>
      ) : null}

      <SpoolDialog open={dialogOpen} spool={editing} onOpenChange={setDialogOpen} onSaved={() => void load()} />
    </div>
  )
}
