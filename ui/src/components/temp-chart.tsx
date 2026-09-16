import { useEffect, useMemo, useRef, useState } from 'react'
import { Table2, LineChart } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useT, type MessageKey } from '@/i18n'
import { api, type HistoryResult, type HistorySample, type PrinterStatus } from '@/lib/api'
import { formatClock, formatDayTime, formatHourMinute } from '@/lib/format'
import { cn } from '@/lib/utils'

const SAMPLE_MS = 5000
const HEIGHT = 208
const MAX_FILL_HEIGHT = 560
const PAD = { top: 12, right: 14, bottom: 24, left: 38 }
const DAY_MS = 86400 * 1000
const TICK_STEPS = [2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].map((minutes) => minutes * 60000)
const RANGES: { minutes: number; labelKey: MessageKey }[] = [
  { minutes: 30, labelKey: 'temp.range_30m' },
  { minutes: 120, labelKey: 'temp.range_2h' },
  { minutes: 360, labelKey: 'temp.range_6h' },
  { minutes: 1440, labelKey: 'temp.range_24h' },
  { minutes: 10080, labelKey: 'temp.range_7d' },
]

type SeriesKey = 'nozzle' | 'bed' | 'chamber'

const SERIES: { key: SeriesKey; actual: 'n' | 'b' | 'c'; target: 'nt' | 'bt' | null; color: string; labelKey: MessageKey }[] = [
  { key: 'nozzle', actual: 'n', target: 'nt', color: 'var(--series-nozzle)', labelKey: 'temp.nozzle' },
  { key: 'bed', actual: 'b', target: 'bt', color: 'var(--series-bed)', labelKey: 'temp.bed' },
  { key: 'chamber', actual: 'c', target: null, color: 'var(--series-chamber)', labelKey: 'temp.chamber' },
]

function sampleFrom(status: PrinterStatus, t: number): HistorySample {
  const { nozzle, bed, chamber } = status.temps
  return {
    t,
    n: nozzle?.actual ?? null,
    nt: nozzle?.target ?? null,
    b: bed?.actual ?? null,
    bt: bed?.target ?? null,
    c: chamber?.actual ?? null,
    f: status.fanSpeed,
    s: status.speedFactor,
    p: status.job?.progress ?? null,
    l: status.job?.layer ?? null,
  }
}

function visibleSeries(samples: HistorySample[]) {
  return SERIES.filter((series) => samples.some((sample) => sample[series.actual] !== null))
}

function niceStep(range: number) {
  const steps = [10, 20, 25, 50, 100]
  return steps.find((step) => range / step <= 5) ?? 100
}

function linePath(points: [number, number][]) {
  return points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join('')
}

/** Break the line where data is missing (printer offline) instead of drawing straight across the gap. */
function segments(
  samples: HistorySample[],
  pick: (sample: HistorySample) => number | null,
  x: (t: number) => number,
  y: (v: number) => number,
  gapMs: number,
) {
  const result: [number, number][][] = []
  let current: [number, number][] = []
  let lastT = 0
  for (const sample of samples) {
    const value = pick(sample)
    const gap = lastT && sample.t - lastT > gapMs
    if (value === null || gap) {
      if (current.length > 1) result.push(current)
      current = []
    }
    if (value !== null) current.push([x(sample.t), y(value)])
    lastT = sample.t
  }
  if (current.length > 1) result.push(current)
  return result
}

/** Time axis ticks align to local time so 00:00, 06:00 and so on land exactly on a tick. */
function timeTicks(start: number, end: number) {
  const step = TICK_STEPS.find((item) => (end - start) / item <= 6) ?? DAY_MS
  const shift = -new Date(start).getTimezoneOffset() * 60000
  const ticks: number[] = []
  for (let tick = Math.ceil((start + shift) / step) * step - shift; tick <= end; tick += step) ticks.push(tick)
  return ticks
}

function TempPlot({ samples, bucketMs, emptyText, fill }: { samples: HistorySample[]; bucketMs: number; emptyText: string; fill?: boolean }) {
  const t = useT()
  const boxRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)
  // In fill mode the container sets the height, so the chart takes up the leftover space in the column.
  const [height, setHeight] = useState(HEIGHT)
  const [hover, setHover] = useState<number | null>(null)
  const visible = visibleSeries(samples)
  const gapMs = Math.max(SAMPLE_MS, bucketMs) * 4

  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.max(280, Math.round(entry.contentRect.width)))
      if (fill) setHeight(Math.min(MAX_FILL_HEIGHT, Math.max(HEIGHT, Math.round(entry.contentRect.height))))
    })
    observer.observe(box)
    return () => observer.disconnect()
  }, [fill])

  const geometry = useMemo(() => {
    const now = samples.at(-1)?.t ?? 0
    const start = Math.min(samples[0]?.t ?? now, now - 5 * 60 * 1000)
    let max = 50
    for (const sample of samples) {
      for (const key of ['n', 'nt', 'b', 'bt', 'c'] as const) {
        const value = sample[key]
        if (value !== null && value > max) max = value
      }
    }
    const step = niceStep(max)
    const top = Math.ceil((max + 5) / step) * step
    const plotW = width - PAD.left - PAD.right
    const plotH = height - PAD.top - PAD.bottom
    const x = (time: number) => PAD.left + ((time - start) / Math.max(1, now - start)) * plotW
    const y = (value: number) => PAD.top + plotH - (value / top) * plotH
    const yTicks = Array.from({ length: Math.floor(top / step) + 1 }, (_, index) => index * step)
    const multiDay = now - start > DAY_MS
    return { start, now, x, y, yTicks, xTicks: timeTicks(start, now), plotW, plotH, multiDay }
  }, [samples, width, height])

  const hovered = hover !== null ? samples[hover] : null
  const tickLabel = (tick: number) => (geometry.multiDay ? formatDayTime(tick) : formatHourMinute(tick))

  const onPointer = (event: React.PointerEvent<SVGRectElement>) => {
    if (samples.length === 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    const time = geometry.start + ((event.clientX - rect.left) / rect.width) * (geometry.now - geometry.start)
    let best = 0
    for (let index = 1; index < samples.length; index += 1) {
      if (Math.abs(samples[index].t - time) < Math.abs(samples[best].t - time)) best = index
    }
    setHover(best)
  }

  return (
    <div ref={boxRef} className={cn('relative', fill && 'h-full')}>
      {/* In fill mode the drawing layer leaves the flow so the svg cannot grow the column; the spacer keeps a minimum height
          for the single-column layout, where the container has no height to stretch into. */}
      {fill ? <div style={{ height: HEIGHT }} aria-hidden /> : null}
      <div className={cn(fill && 'absolute inset-0')}>
      {samples.length < 2 ? (
        <div className="text-muted-foreground flex items-center justify-center text-xs" style={{ height }}>
          {emptyText}
        </div>
      ) : (
        <svg width={width} height={height} className="block overflow-visible" role="img" aria-label={t('temp.chart_label')}>
          {geometry.yTicks.map((tick) => (
            <g key={tick}>
              <line x1={PAD.left} x2={width - PAD.right} y1={geometry.y(tick)} y2={geometry.y(tick)} stroke="var(--grid)" strokeWidth={1} />
              <text x={PAD.left - 8} y={geometry.y(tick)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[10px] tabular-nums">
                {tick}°
              </text>
            </g>
          ))}
          {geometry.xTicks.map((tick) => (
            <text key={tick} x={geometry.x(tick)} y={height - 6} textAnchor="middle" className="fill-muted-foreground text-[10px] tabular-nums">
              {tickLabel(tick)}
            </text>
          ))}

          {visible.map((series) => {
            const target = series.target
            return (
              <g key={series.key}>
                {target
                  ? segments(samples, (sample) => (sample[target] ? sample[target] : null), geometry.x, geometry.y, gapMs).map((points, index) => (
                      <path
                        key={`t${index}`}
                        d={linePath(points)}
                        fill="none"
                        stroke={series.color}
                        strokeOpacity={0.7}
                        strokeWidth={1.5}
                        strokeDasharray="4 3"
                      />
                    ))
                  : null}
                {segments(samples, (sample) => sample[series.actual], geometry.x, geometry.y, gapMs).map((points, index) => (
                  <path
                    key={`a${index}`}
                    d={linePath(points)}
                    fill="none"
                    stroke={series.color}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                ))}
              </g>
            )
          })}

          {visible.map((series) => {
            const last = samples.at(-1)
            const value = last?.[series.actual]
            if (!last || value === null || value === undefined) return null
            return <circle key={series.key} cx={geometry.x(last.t)} cy={geometry.y(value)} r={4} fill={series.color} stroke="var(--card)" strokeWidth={2} />
          })}

          {hovered ? (
            <g pointerEvents="none">
              <line
                x1={geometry.x(hovered.t)}
                x2={geometry.x(hovered.t)}
                y1={PAD.top}
                y2={height - PAD.bottom}
                stroke="var(--muted-foreground)"
                strokeWidth={1}
              />
              {visible.map((series) => {
                const value = hovered[series.actual]
                return value === null ? null : (
                  <circle
                    key={series.key}
                    cx={geometry.x(hovered.t)}
                    cy={geometry.y(value)}
                    r={4}
                    fill={series.color}
                    stroke="var(--card)"
                    strokeWidth={2}
                  />
                )
              })}
            </g>
          ) : null}

          <rect
            x={PAD.left}
            y={PAD.top}
            width={geometry.plotW}
            height={geometry.plotH}
            fill="transparent"
            onPointerMove={onPointer}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
      )}
      </div>

      {hovered ? (
        <div
          className="bg-popover text-popover-foreground pointer-events-none absolute top-2 z-10 min-w-36 rounded-lg border px-2.5 py-2 text-xs shadow-md"
          style={geometry.x(hovered.t) > width / 2 ? { right: width - geometry.x(hovered.t) + 12 } : { left: geometry.x(hovered.t) + 12 }}
        >
          <div className="text-muted-foreground mb-1.5 tabular-nums">{geometry.multiDay ? formatDayTime(hovered.t) : formatClock(hovered.t)}</div>
          {visible.map((series) => {
            const value = hovered[series.actual]
            const target = series.target ? hovered[series.target] : null
            return (
              <div key={series.key} className="flex items-center gap-2 py-0.5">
                <span className="h-0.5 w-3 rounded-full" style={{ background: series.color }} />
                <span className="font-semibold tabular-nums">
                  {value === null ? '-' : `${value.toFixed(1)}°`}
                  {target ? <span className="text-muted-foreground font-normal"> / {Math.round(target)}°</span> : null}
                </span>
                <span className="text-muted-foreground ml-auto pl-2">{t(series.labelKey)}</span>
              </div>
            )
          })}
          {hovered.f !== null && hovered.f !== undefined ? (
            <div className="text-muted-foreground flex justify-between gap-3 border-t pt-1 mt-1 tabular-nums">
              <span>{t('temp.fan_short')}</span>
              <span className="text-foreground">{Math.round(hovered.f)}%</span>
            </div>
          ) : null}
          {hovered.s !== null && hovered.s !== undefined ? (
            <div className="text-muted-foreground flex justify-between gap-3 tabular-nums">
              <span>{t('temp.speed_short')}</span>
              <span className="text-foreground">{Math.round(hovered.s)}%</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function TempTable({ samples, limit }: { samples: HistorySample[]; limit: number }) {
  const t = useT()
  const visible = visibleSeries(samples)
  const hasFan = samples.some((sample) => sample.f !== null && sample.f !== undefined)
  const hasSpeed = samples.some((sample) => sample.s !== null && sample.s !== undefined)
  const multiDay = samples.length > 1 && samples.at(-1)!.t - samples[0].t > DAY_MS
  return (
    <div className="max-h-52 overflow-auto rounded-lg border">
      <table className="w-full text-xs tabular-nums">
        <thead className="bg-muted/50 text-muted-foreground sticky top-0">
          <tr>
            <th className="px-2.5 py-1.5 text-left font-medium">{t('temp.time')}</th>
            {visible.map((series) => (
              <th key={series.key} className="px-2.5 py-1.5 text-right font-medium">
                {t(series.labelKey)}
              </th>
            ))}
            {hasFan ? <th className="px-2.5 py-1.5 text-right font-medium">{t('temp.fan_short')}</th> : null}
            {hasSpeed ? <th className="px-2.5 py-1.5 text-right font-medium">{t('temp.speed_short')}</th> : null}
          </tr>
        </thead>
        <tbody>
          {samples
            .slice(-limit)
            .reverse()
            .map((sample) => (
              <tr key={sample.t} className="border-t">
                <td className="px-2.5 py-1">{multiDay ? formatDayTime(sample.t) : formatClock(sample.t)}</td>
                {visible.map((series) => {
                  const value = sample[series.actual]
                  const target = series.target ? sample[series.target] : null
                  return (
                    <td key={series.key} className="px-2.5 py-1 text-right">
                      {value === null ? '-' : `${value.toFixed(1)}°`}
                      {target ? <span className="text-muted-foreground"> / {Math.round(target)}°</span> : null}
                    </td>
                  )
                })}
                {hasFan ? <td className="px-2.5 py-1 text-right">{sample.f === null || sample.f === undefined ? '-' : `${Math.round(sample.f)}%`}</td> : null}
                {hasSpeed ? <td className="px-2.5 py-1 text-right">{sample.s === null || sample.s === undefined ? '-' : `${Math.round(sample.s)}%`}</td> : null}
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  )
}

function Legend({ samples, readout }: { samples: HistorySample[]; readout: (key: SeriesKey) => string }) {
  const t = useT()
  const visible = visibleSeries(samples)
  return (
    <>
      {visible.map((series) => (
        <div key={series.key} className="flex items-center gap-2 text-xs">
          <span className="h-0.5 w-3.5 rounded-full" style={{ background: series.color }} />
          <span className="text-muted-foreground">{t(series.labelKey)}</span>
          <span className="text-foreground font-medium tabular-nums">{readout(series.key)}</span>
        </div>
      ))}
      {visible.some((series) => series.target) ? (
        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          <svg width="14" height="2" aria-hidden>
            <line x1="0" y1="1" x2="14" y2="1" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2" />
          </svg>
          {t('temp.target')}
        </div>
      ) : null}
    </>
  )
}

function TableToggle({ showTable, onToggle }: { showTable: boolean; onToggle: () => void }) {
  const t = useT()
  return (
    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onToggle} title={showTable ? t('temp.show_chart') : t('temp.show_table')}>
      {showTable ? <LineChart className="size-3.5" /> : <Table2 className="size-3.5" />}
      {showTable ? t('temp.show_chart') : t('temp.show_table')}
    </Button>
  )
}

export function TempChart({ printerId, status, fill }: { printerId: string; status: PrinterStatus; fill?: boolean }) {
  const t = useT()
  const [minutes, setMinutes] = useState(30)
  const [data, setData] = useState<HistoryResult | null>(null)
  const [showTable, setShowTable] = useState(false)

  useEffect(() => {
    let cancelled = false
    api
      .history(printerId, minutes)
      .then((result) => {
        if (!cancelled) setData(result)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [printerId, minutes])

  useEffect(() => {
    if (!status.online || (!status.temps.nozzle && !status.temps.bed)) return
    const now = Date.now()
    setData((current) => {
      if (!current) return current
      const last = current.samples.at(-1)
      if (last && now - last.t < Math.max(SAMPLE_MS, current.bucketMs)) return current
      const windowStart = now - minutes * 60000
      return { ...current, to: now, samples: [...current.samples.filter((sample) => sample.t >= windowStart), sampleFrom(status, now)] }
    })
  }, [status, minutes])

  const samples = data?.samples ?? []
  const readout = (key: SeriesKey) => {
    const value = status.temps[key]
    if (!value) return '-'
    return value.target ? `${Math.round(value.actual)}° / ${Math.round(value.target)}°` : `${Math.round(value.actual)}°`
  }

  return (
    <div className={cn('space-y-3', fill && 'flex h-full flex-col')}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <Legend samples={samples} readout={readout} />
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {RANGES.map((range) => (
            <Button
              key={range.minutes}
              size="xs"
              variant={range.minutes === minutes ? 'secondary' : 'ghost'}
              aria-pressed={range.minutes === minutes}
              onClick={() => setMinutes(range.minutes)}
            >
              {t(range.labelKey)}
            </Button>
          ))}
          <TableToggle showTable={showTable} onToggle={() => setShowTable((value) => !value)} />
        </div>
      </div>
      <div className={cn(showTable ? 'hidden' : fill && 'min-h-0 flex-1')}>
        <TempPlot samples={samples} bucketMs={data?.bucketMs ?? SAMPLE_MS} emptyText={status.online ? t('temp.collecting') : t('temp.no_data')} fill={fill} />
      </div>
      {showTable ? <TempTable samples={samples} limit={200} /> : null}
    </div>
  )
}

/** Printer temperatures over exactly the window the job ran, read from SQLite. */
export function JobTempChart({ jobId, active }: { jobId: string; active: boolean }) {
  const t = useT()
  const [data, setData] = useState<HistoryResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [showTable, setShowTable] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = () =>
      api
        .jobHistory(jobId)
        .then((result) => {
          if (!cancelled) setData(result)
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    void load()
    const timer = active ? window.setInterval(load, 15000) : undefined
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [jobId, active])

  const samples = data?.samples ?? []
  const readout = (key: SeriesKey) => {
    const series = SERIES.find((item) => item.key === key)!
    const values = samples.map((sample) => sample[series.actual]).filter((value): value is number => value !== null)
    return values.length ? t('temp.peak', { value: Math.round(Math.max(...values)) }) : '-'
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <Legend samples={samples} readout={readout} />
        <div className="ml-auto">
          <TableToggle showTable={showTable} onToggle={() => setShowTable((value) => !value)} />
        </div>
      </div>
      <div className={cn(showTable && 'hidden')}>
        <TempPlot samples={samples} bucketMs={data?.bucketMs ?? SAMPLE_MS} emptyText={loading ? t('common.loading') : t('temp.job_no_data')} />
      </div>
      {showTable ? <TempTable samples={samples} limit={2000} /> : null}
    </div>
  )
}
