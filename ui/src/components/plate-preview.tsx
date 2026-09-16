import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useT } from '@/i18n'
import { api, fetchPlateMesh, fetchToolpath, mediaUrl, type LibraryFile, type PlateLayout, type PlateMesh, type PlateToolpath } from '@/lib/api'
import { formatNumber } from '@/lib/format'

// three.js chỉ nạp khi người dùng thật sự mở khung 3D, không kéo theo vào gói chính.
const PlateView3D = lazy(() => import('@/components/plate-view-3d'))
const ToolpathView3D = lazy(() => import('@/components/toolpath-view-3d'))

const MINOR = 10
const MAJOR = 50

function ticks(from: number, to: number, step: number) {
  const values: number[] = []
  for (let value = Math.ceil(from / step) * step; value <= to; value += step) values.push(value)
  return values
}

/**
 * Khay in vẽ theo đúng toạ độ máy: viewBox tính bằng mm, gốc toạ độ ở góc trái dưới của bàn.
 * Ảnh `top_N.png` do slicer render là hình vuông phủ đúng cạnh dài của bàn và căn theo tâm bàn.
 */
function PlateCanvas({ layout }: { layout: PlateLayout }) {
  const t = useT()
  const { bed, objects } = layout
  const frame = bed ?? boundsFrame(layout)
  if (!frame) return <div className="text-muted-foreground py-10 text-center text-sm">{t('plate.empty')}</div>

  const width = frame.maxX - frame.minX
  const height = frame.maxY - frame.minY
  const span = Math.max(width, height)
  const toX = (value: number) => value - frame.minX
  const toY = (value: number) => frame.maxY - value
  const label = Math.max(3, width / 45)

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="bg-card mx-auto block w-full rounded-lg border"
      // Giới hạn theo chiều cao màn hình, bề rộng tự co theo tỉ lệ bàn để khay luôn nằm gọn trong hộp thoại.
      style={{ aspectRatio: `${width} / ${height}`, maxWidth: `calc(55vh * ${width} / ${height})` }}
    >
      <rect x={0} y={0} width={width} height={height} fill="var(--muted)" />
      {ticks(frame.minX, frame.maxX, MINOR).map((value) => (
        <line
          key={`x${value}`}
          x1={toX(value)}
          x2={toX(value)}
          y1={0}
          y2={height}
          stroke="var(--grid)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
          opacity={value % MAJOR === 0 ? 1 : 0.45}
        />
      ))}
      {ticks(frame.minY, frame.maxY, MINOR).map((value) => (
        <line
          key={`y${value}`}
          x1={0}
          x2={width}
          y1={toY(value)}
          y2={toY(value)}
          stroke="var(--grid)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
          opacity={value % MAJOR === 0 ? 1 : 0.45}
        />
      ))}
      {bed && bed.exclude.length > 2 ? (
        <polygon
          points={bed.exclude.map(([x, y]) => `${toX(x)},${toY(y)}`).join(' ')}
          fill="var(--destructive)"
          opacity={0.12}
          stroke="var(--destructive)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      {layout.hasImage ? (
        <image
          href={mediaUrl(`/api/files/${encodeURIComponent(layout.fileId)}/plate-image`, { plate: layout.plate })}
          x={width / 2 - span / 2}
          y={height / 2 - span / 2}
          width={span}
          height={span}
        />
      ) : null}
      {objects.map((object, index) => {
        const [x0, y0, x1, y1] = object.bbox
        return (
          <g key={index}>
            <rect
              x={toX(x0)}
              y={toY(y1)}
              width={x1 - x0}
              height={y1 - y0}
              fill={layout.hasImage ? 'none' : 'var(--brand)'}
              fillOpacity={0.2}
              stroke="var(--brand)"
              strokeOpacity={0.85}
              strokeWidth={1.5}
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={toX((x0 + x1) / 2)}
              y={toY((y0 + y1) / 2)}
              fontSize={label}
              textAnchor="middle"
              dominantBaseline="central"
              fill="var(--brand-strong)"
              fontWeight={600}
            >
              {index + 1}
            </text>
          </g>
        )
      })}
      <rect x={0} y={0} width={width} height={height} fill="none" stroke="var(--border)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/** File không ghi kích thước bàn thì vẽ tạm theo vùng bao các vật thể, chừa 10 mm mỗi phía. */
function boundsFrame(layout: PlateLayout) {
  if (!layout.bounds) return null
  const [minX, minY, maxX, maxY] = layout.bounds
  return { minX: minX - 10, minY: minY - 10, maxX: maxX + 10, maxY: maxY + 10 }
}

function outsideBed(layout: PlateLayout) {
  const { bed } = layout
  if (!bed) return false
  return layout.objects.some((object) => {
    const [x0, y0, x1, y1] = object.bbox
    return x0 < bed.minX || y0 < bed.minY || x1 > bed.maxX || y1 > bed.maxY
  })
}

type ViewMode = '3d' | 'top' | 'path'

function Spinner({ label }: { label: string }) {
  return (
    <div className="text-muted-foreground flex items-center justify-center gap-2 py-16 text-sm">
      <Loader2 className="size-4 animate-spin" /> {label}
    </div>
  )
}

/** Khung xem khay in dùng chung cho hộp thoại xem nhanh và màn chỉnh sửa file. */
export function PlateViewer({
  file,
  machine,
  compact = false,
  onMove,
}: {
  file: LibraryFile | null
  machine?: string
  compact?: boolean
  onMove?: (moves: { item: number; dx: number; dy: number }[]) => void
}) {
  const t = useT()
  // File đã cắt lát mới có G-code để dựng đường đi vòi phun, và mở ra là xem ngay đường in.
  const hasPath = Boolean(file && (file.format === 'gcode' || (file.format === '3mf' && file.meta.sliced !== false)))
  const [layout, setLayout] = useState<PlateLayout | null>(null)
  const [mesh, setMesh] = useState<PlateMesh | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [meshError, setMeshError] = useState<string | null>(null)
  const [plate, setPlate] = useState<number | undefined>(undefined)
  const [mode, setMode] = useState<ViewMode>(hasPath ? 'path' : '3d')
  const [selected, setSelected] = useState<number | null>(null)
  const [path, setPath] = useState<PlateToolpath | null>(null)
  const [pathError, setPathError] = useState<string | null>(null)

  const fileId = file?.id ?? null
  const format = file?.format ?? null
  // Mốc sửa đổi chỉ dùng để phá bộ nhớ đệm lúc nạp, không nằm trong phụ thuộc: kéo thả xong không phải dựng lại cảnh.
  const version = useRef<string | undefined>(undefined)
  useEffect(() => {
    version.current = file?.updatedAt
  }, [file])
  // Chỉ nạp lại mesh khi đổi file hay đổi khay; kéo thả xong máy chủ có báo file đổi thì cũng đừng dựng lại cảnh.
  useEffect(() => {
    if (!fileId || format === 'gcode') return
    let active = true
    setMesh(null)
    setMeshError(null)
    setSelected(null)
    fetchPlateMesh(fileId, plate, machine, version.current).then(
      (result) => active && setMesh(result),
      (reason: unknown) => active && setMeshError(reason instanceof Error ? reason.message : t('common.error')),
    )
    return () => {
      active = false
    }
  }, [fileId, format, machine, plate, t])

  useEffect(() => {
    if (!file || !hasPath || mode !== 'path') return
    let active = true
    setPath(null)
    setPathError(null)
    fetchToolpath(file.id, plate).then(
      (result) => active && setPath(result),
      (reason: unknown) => active && setPathError(reason instanceof Error ? reason.message : t('common.error')),
    )
    return () => {
      active = false
    }
  }, [file, hasPath, mode, plate, t])

  useEffect(() => {
    if (!file || file.format !== '3mf') {
      setLayout(null)
      setError(null)
      return
    }
    let active = true
    setLayout(null)
    setError(null)
    api.platePreview(file.id, plate).then(
      (result) => active && setLayout(result),
      (reason: unknown) => active && setError(reason instanceof Error ? reason.message : t('common.error')),
    )
    return () => {
      active = false
    }
  }, [file, plate, t])

  // Mô hình chưa cắt lát không có ảnh chiếu từ trên lẫn đường đi; G-code trần thì ngược lại, không dựng được khối.
  const hasMesh = Boolean(file && file.format !== 'gcode')
  const view: ViewMode = mode === 'path' && hasPath ? 'path' : mode === 'top' && layout ? 'top' : hasMesh ? '3d' : 'path'
  const bed = mesh?.bed ?? layout?.bed ?? null
  const plates = mesh?.plates?.length ? mesh.plates : (layout?.plates ?? [])
  const current = mesh?.plate ?? layout?.plate
  const objects =
    mesh?.objects.map((object) => ({
      name: object.name,
      size: [object.bbox[3] - object.bbox[0], object.bbox[4] - object.bbox[1], object.bbox[5] - object.bbox[2]] as const,
    })) ??
    layout?.objects.map((object) => ({
      name: object.name,
      size: [object.bbox[2] - object.bbox[0], object.bbox[3] - object.bbox[1], null] as const,
    })) ??
    []

  const facts = [
    bed?.model,
    bed ? `${formatNumber(bed.maxX - bed.minX, 0)} × ${formatNumber(bed.maxY - bed.minY, 0)}${bed.maxZ ? ` × ${formatNumber(bed.maxZ, 0)}` : ''} mm` : null,
    objects.length > 0 ? t('plate.objects', { count: objects.length }) : null,
    mesh ? t('plate.triangles', { count: mesh.objects.reduce((sum, object) => sum + object.triangles, 0) }) : null,
  ].filter(Boolean)

  const loading = view === 'path' ? !path && !pathError : view === '3d' ? !mesh && !meshError : !layout && !error
  const failure = view === 'path' ? pathError : view === '3d' ? meshError : error

  if (!file) return null

  return (
    <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {layout || hasPath ? (
            <div className="flex gap-1.5">
              {hasMesh ? (
                <Button size="xs" variant={view === '3d' ? 'default' : 'outline'} onClick={() => setMode('3d')}>
                  {t('plate.view_3d')}
                </Button>
              ) : null}
              {hasPath ? (
                <Button size="xs" variant={view === 'path' ? 'default' : 'outline'} onClick={() => setMode('path')}>
                  {t('plate.view_path')}
                </Button>
              ) : null}
              {layout ? (
                <Button size="xs" variant={view === 'top' ? 'default' : 'outline'} onClick={() => setMode('top')}>
                  {t('plate.view_2d')}
                </Button>
              ) : null}
            </div>
          ) : null}
          {plates.length > 1 ? (
            <div className="ml-auto flex flex-wrap gap-1.5">
              {plates.map((index) => (
                <Button key={index} size="xs" variant={index === current ? 'default' : 'outline'} onClick={() => setPlate(index)}>
                  {t('plate.index', { index })}
                </Button>
              ))}
            </div>
          ) : null}
        </div>

        {failure ? <div className="text-destructive text-sm">{failure}</div> : null}
        {loading ? <Spinner label={t('common.loading')} /> : null}

        {!loading && !failure ? (
          <div className="space-y-3">
            {view === '3d' && mesh ? (
              <Suspense fallback={<Spinner label={t('common.loading')} />}>
                <PlateView3D mesh={mesh} selected={selected} onSelect={setSelected} onMove={onMove} className={compact ? undefined : 'h-[62vh] min-h-80'} />
              </Suspense>
            ) : null}
            {view === 'path' && path ? (
              <Suspense fallback={<Spinner label={t('common.loading')} />}>
                <ToolpathView3D path={path} className={compact ? undefined : 'h-[62vh] min-h-80'} />
              </Suspense>
            ) : null}
            {view === 'top' && layout ? <PlateCanvas layout={layout} /> : null}

            {facts.length > 0 ? (
              <div className="text-muted-foreground flex flex-wrap gap-x-3 text-xs">
                {facts.map((fact, index) => (
                  <span key={index}>{fact}</span>
                ))}
              </div>
            ) : null}
            {!bed ? (
              <div className="text-muted-foreground flex items-start gap-1.5 text-xs">
                <AlertTriangle className="text-warn mt-px size-3.5 shrink-0" /> {t('plate.unknown_bed')}
              </div>
            ) : null}
            {layout && outsideBed(layout) ? (
              <div className="text-destructive flex items-start gap-1.5 text-xs">
                <AlertTriangle className="mt-px size-3.5 shrink-0" /> {t('plate.outside')}
              </div>
            ) : null}
            {mesh && mesh.dropped > 0 && view !== 'path' ? (
              <div className="text-muted-foreground flex items-start gap-1.5 text-xs">
                <AlertTriangle className="text-warn mt-px size-3.5 shrink-0" /> {t('plate.mesh_partial')}
              </div>
            ) : null}

            {view === 'path' ? null : objects.length > 0 ? (
              <ul className="grid gap-1 sm:grid-cols-2">
                {objects.map((object, index) => (
                  <li key={index}>
                    <button
                      type="button"
                      onClick={() => setSelected(selected === index ? null : index)}
                      className={`flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left text-xs ${selected === index ? 'bg-brand/10' : 'hover:bg-muted'}`}
                    >
                      <span className="bg-brand/10 text-brand-strong flex size-5 shrink-0 items-center justify-center rounded font-medium">{index + 1}</span>
                      <span className="min-w-0 flex-1 truncate">{object.name ?? t('plate.unnamed')}</span>
                      <span className="text-muted-foreground shrink-0 tabular-nums">
                        {formatNumber(object.size[0], 1)} × {formatNumber(object.size[1], 1)}
                        {object.size[2] === null ? '' : ` × ${formatNumber(object.size[2], 1)}`} mm
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-muted-foreground text-xs">{t('plate.empty')}</div>
            )}
          </div>
        ) : null}
    </div>
  )
}

export function PlatePreviewDialog({ file, onClose }: { file: LibraryFile | null; onClose: () => void }) {
  const t = useT()
  return (
    <Dialog open={Boolean(file)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('plate.title')}</DialogTitle>
          <DialogDescription>{file?.name}</DialogDescription>
        </DialogHeader>
        <PlateViewer file={file} />
      </DialogContent>
    </Dialog>
  )
}
