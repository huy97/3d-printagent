import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { AlertTriangle, Maximize2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { createPlateScene } from '@/components/plate-scene'
import { useT, type MessageKey } from '@/i18n'
import type { PlateToolpath } from '@/lib/api'
import { cn } from '@/lib/utils'
import { formatNumber } from '@/lib/format'

/** Màu và tên từng loại đường, đặt theo cách phần mềm cắt lát trình bày để nhìn quen mắt. */
const FEATURES: Record<string, { color: number; label: MessageKey }> = {
  'Outer wall': { color: 0xff7a45, label: 'plate.feature_outer_wall' },
  'Inner wall': { color: 0xffd24d, label: 'plate.feature_inner_wall' },
  'Overhang wall': { color: 0x2f7fe0, label: 'plate.feature_overhang_wall' },
  'Sparse infill': { color: 0xd0453f, label: 'plate.feature_sparse_infill' },
  'Internal solid infill': { color: 0xb05fd6, label: 'plate.feature_internal_solid_infill' },
  'Top surface': { color: 0xe8514b, label: 'plate.feature_top_surface' },
  'Bottom surface': { color: 0x3fbf8f, label: 'plate.feature_bottom_surface' },
  Bridge: { color: 0x4aa8ff, label: 'plate.feature_bridge' },
  'Internal Bridge': { color: 0x7fc4ff, label: 'plate.feature_internal_bridge' },
  'Gap infill': { color: 0xe6e6e6, label: 'plate.feature_gap_infill' },
  Support: { color: 0x00b5a5, label: 'plate.feature_support' },
  'Support interface': { color: 0x59d3c8, label: 'plate.feature_support_interface' },
  'Support transition': { color: 0x8fe0d8, label: 'plate.feature_support_transition' },
  'Prime tower': { color: 0x7d8590, label: 'plate.feature_prime_tower' },
  Skirt: { color: 0x8fd14f, label: 'plate.feature_skirt' },
  Brim: { color: 0x6fbf3f, label: 'plate.feature_brim' },
  Ironing: { color: 0xc9b5ff, label: 'plate.feature_ironing' },
  'Floating vertical shell': { color: 0xbf7fd6, label: 'plate.feature_floating_vertical_shell' },
  Custom: { color: 0x9aa4b2, label: 'plate.feature_custom' },
  Other: { color: 0x9aa4b2, label: 'plate.feature_other' },
}

const OTHER = FEATURES.Other

type Group = { name: string; lines: THREE.LineSegments; starts: Uint32Array }

/**
 * Mỗi loại đường một đối tượng riêng: bật tắt được từng loại như bảng chú giải của phần mềm cắt lát,
 * và vì điểm trong mỗi nhóm vẫn xếp theo thứ tự lớp nên kéo thanh trượt chỉ cần đổi khoảng vẽ.
 */
function buildGroups(path: PlateToolpath) {
  const layers = Math.max(1, path.layers.length)
  const bound = (index: number) => (index >= path.layers.length ? path.points : path.layers[index].point)
  const counts = new Uint32Array(path.features.length)
  for (let at = 0; at < path.points; at += 1) counts[path.feature[at]] += 1

  const buffers = path.features.map((_, index) => (counts[index] > 0 ? new Float32Array(counts[index] * 3) : null))
  const starts = path.features.map((_, index) => (counts[index] > 0 ? new Uint32Array(layers + 1) : null))
  const filled = new Uint32Array(path.features.length)

  const mark = (layer: number) => {
    for (let index = 0; index < starts.length; index += 1) {
      const offsets = starts[index]
      if (offsets) offsets[layer] = filled[index]
    }
  }

  for (let layer = 0; layer < layers; layer += 1) {
    mark(layer)
    for (let at = bound(layer); at < bound(layer + 1); at += 1) {
      const index = path.feature[at]
      const buffer = buffers[index]
      if (!buffer) continue
      const to = filled[index] * 3
      buffer[to] = path.positions[at * 3]
      buffer[to + 1] = path.positions[at * 3 + 1]
      buffer[to + 2] = path.positions[at * 3 + 2]
      filled[index] += 1
    }
  }
  mark(layers)

  const groups: Group[] = []
  path.features.forEach((name, index) => {
    const buffer = buffers[index]
    const offsets = starts[index]
    if (!buffer || !offsets) return
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(buffer, 3))
    const color = (FEATURES[name] ?? OTHER).color
    groups.push({ name, starts: offsets, lines: new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color })) })
  })
  return groups
}

export default function ToolpathView3D({ path, className }: { path: PlateToolpath; className?: string }) {
  const t = useT()
  const host = useRef<HTMLDivElement>(null)
  const api = useRef<{ frame: (top: boolean) => void; range: (from: number, to: number) => void; show: (hidden: string[]) => void } | null>(null)
  const total = path.layers.length
  const [top, setTop] = useState(total)
  const [single, setSingle] = useState(false)
  const [hidden, setHidden] = useState<string[]>([])

  // Chỉ liệt kê loại đường thật sự có trong bản cắt này, giữ đúng thứ tự máy chủ khai báo.
  const used = useMemo(() => {
    const seen = new Set<number>()
    for (const value of path.feature) seen.add(value)
    return path.features.filter((_, index) => seen.has(index))
  }, [path])

  useEffect(() => {
    const container = host.current
    if (!container) return

    const bounds = new THREE.Box3()
    if (path.bbox) {
      bounds.expandByPoint(new THREE.Vector3(path.bbox[0], path.bbox[1], path.bbox[2]))
      bounds.expandByPoint(new THREE.Vector3(path.bbox[3], path.bbox[4], path.bbox[5]))
    }
    if (bounds.isEmpty()) bounds.expandByPoint(new THREE.Vector3(100, 100, 100))

    // Đường in tự phát màu riêng, thêm đèn chỉ làm nhạt màu đi; khung ôm sát đường in để nhìn rõ từng nét.
    const view = createPlateScene(container, path.bed, bounds, { lights: false, fitBed: false })
    const groups = buildGroups(path)
    for (const group of groups) view.scene.add(group.lines)

    view.frame(false)
    api.current = {
      frame: view.frame,
      range: (from, to) => {
        for (const group of groups) {
          const start = group.starts[Math.min(from, group.starts.length - 1)]
          const end = group.starts[Math.min(to, group.starts.length - 1)]
          group.lines.geometry.setDrawRange(start, Math.max(0, end - start))
        }
        view.invalidate()
      },
      show: (off) => {
        for (const group of groups) group.lines.visible = !off.includes(group.name)
        view.invalidate()
      },
    }

    return () => {
      view.dispose()
      api.current = null
    }
  }, [path])

  useEffect(() => {
    api.current?.range(single ? Math.max(0, top - 1) : 0, top)
  }, [path, top, single])

  useEffect(() => {
    api.current?.show(hidden)
  }, [path, hidden])

  const current = path.layers[Math.max(0, top - 1)]
  const facts = [t('plate.path_layers', { count: total }), t('plate.path_segments', { count: formatNumber(path.points / 2, 0) })]

  return (
    <div className="space-y-2.5">
      <div className="relative">
        <div ref={host} className={cn('bg-card relative h-[52vh] min-h-60 w-full overflow-hidden rounded-lg border', className)} />
        <div className="absolute top-2 right-2 flex gap-1">
          <Button size="xs" variant="outline" onClick={() => api.current?.frame(false)}>
            <Maximize2 /> {t('plate.view_fit')}
          </Button>
          <Button size="xs" variant="outline" onClick={() => api.current?.frame(true)}>
            {t('plate.view_top')}
          </Button>
          <Button size="xs" variant={single ? 'default' : 'outline'} onClick={() => setSingle((prev) => !prev)}>
            {t('plate.single_layer')}
          </Button>
        </div>
      </div>

      {total > 0 ? (
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={1}
            max={total}
            value={top}
            onChange={(event) => setTop(Number(event.target.value))}
            className="accent-brand h-1.5 min-w-0 flex-1 cursor-pointer"
            aria-label={t('plate.layer_slider')}
          />
          <span className="text-muted-foreground w-36 shrink-0 text-right text-xs tabular-nums">
            {t('plate.layer_of', { index: top, total })}
            {current ? ` · ${formatNumber(current.z, 2)} mm` : ''}
          </span>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-x-3 gap-y-1.5">
        {used.map((name) => {
          const off = hidden.includes(name)
          return (
            <button
              key={name}
              type="button"
              onClick={() => setHidden((prev) => (prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name]))}
              className={cn('flex items-center gap-1.5 text-[11px]', off ? 'text-muted-foreground/50' : 'text-muted-foreground')}
            >
              <span
                className={cn('size-2.5 rounded-xs', off && 'opacity-25')}
                style={{ backgroundColor: `#${(FEATURES[name] ?? OTHER).color.toString(16).padStart(6, '0')}` }}
              />
              <span className={cn(off && 'line-through')}>{t((FEATURES[name] ?? OTHER).label)}</span>
            </button>
          )
        })}
      </div>

      <div className="text-muted-foreground flex flex-wrap gap-x-3 text-xs">
        {facts.map((fact, index) => (
          <span key={index}>{fact}</span>
        ))}
      </div>

      {path.truncated ? (
        <div className="text-muted-foreground flex items-start gap-1.5 text-xs">
          <AlertTriangle className="text-warn mt-px size-3.5 shrink-0" /> {t('plate.path_partial')}
        </div>
      ) : null}
    </div>
  )
}
