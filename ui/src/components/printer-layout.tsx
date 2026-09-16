import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react'
import { ArrowDown, ArrowUp, Check, Eye, EyeOff, GripVertical, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  AmsCard,
  CameraCard,
  CurrentJobCard,
  MaintenanceCard,
  PrinterAlertsCard,
  PrinterFilesCard,
  PrintInspectCard,
  TemperatureCard,
  canCamera,
  canInspect,
  canPrinterFiles,
  hasAlerts,
  hasAms,
} from '@/components/printer-panels'
import {
  FanSpeedControls,
  FilamentControls,
  CalibrationControls,
  GcodeConsole,
  MotionControls,
  TemperatureControls,
  canCalibrate,
  canFanSpeed,
  canFilament,
  canGcode,
  canMotion,
  canTemperature,
} from '@/components/printer-controls'
import { useT, type MessageKey } from '@/i18n'
import type { Printer } from '@/lib/api'
import { cn } from '@/lib/utils'

interface PanelDef {
  id: string
  titleKey: MessageKey
  available: (printer: Printer) => boolean
  Component: ComponentType<{ printer: Printer }>
}

const PANELS: PanelDef[] = [
  { id: 'job', titleKey: 'printer.current_job', available: () => true, Component: CurrentJobCard },
  { id: 'temperatures', titleKey: 'printer.temperatures', available: () => true, Component: TemperatureCard },
  { id: 'camera', titleKey: 'printer.camera', available: canCamera, Component: CameraCard },
  { id: 'alerts', titleKey: 'printer.alerts', available: hasAlerts, Component: PrinterAlertsCard },
  { id: 'inspect', titleKey: 'printer.inspect', available: canInspect, Component: PrintInspectCard },
  { id: 'files', titleKey: 'printer.files', available: canPrinterFiles, Component: PrinterFilesCard },
  { id: 'ams', titleKey: 'printer.filament', available: hasAms, Component: AmsCard },
  { id: 'maintenance', titleKey: 'maintenance.title', available: () => true, Component: MaintenanceCard },
  { id: 'control-temperature', titleKey: 'controls.temperature', available: canTemperature, Component: TemperatureControls },
  { id: 'control-motion', titleKey: 'controls.motion', available: canMotion, Component: MotionControls },
  { id: 'control-fan', titleKey: 'controls.fan_speed', available: canFanSpeed, Component: FanSpeedControls },
  { id: 'control-filament', titleKey: 'controls.filament', available: canFilament, Component: FilamentControls },
  { id: 'control-calibration', titleKey: 'controls.calibration', available: canCalibrate, Component: CalibrationControls },
  { id: 'control-gcode', titleKey: 'controls.gcode', available: canGcode, Component: GcodeConsole },
]

const STORAGE_KEY = 'printagent3d.printer-panels'

interface Layout {
  order: string[]
  hidden: string[]
}

function normalize(layout: Layout): Layout {
  const known = new Set(PANELS.map((panel) => panel.id))
  const order = layout.order.filter((id, index, list) => known.has(id) && list.indexOf(id) === index)
  // Panel mới thêm ở bản cập nhật sau chèn đúng vị trí mặc định thay vì dồn xuống cuối.
  PANELS.forEach((panel, index) => {
    if (!order.includes(panel.id)) order.splice(Math.min(index, order.length), 0, panel.id)
  })
  return { order, hidden: layout.hidden.filter((id) => known.has(id)) }
}

function readLayout(): Layout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Layout>
      return normalize({ order: parsed.order ?? [], hidden: parsed.hidden ?? [] })
    }
  } catch {
    // localStorage bị chặn hoặc dữ liệu cũ hỏng thì quay về bố cục mặc định
  }
  return normalize({ order: [], hidden: [] })
}

function writeLayout(layout: Layout) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout))
  } catch {
    // Không lưu được thì vẫn dùng cho phiên hiện tại
  }
}

function usePrinterLayout() {
  const [layout, setLayout] = useState<Layout>(readLayout)

  const apply = useCallback((next: Layout) => {
    setLayout(next)
    writeLayout(next)
  }, [])

  const toggle = useCallback(
    (id: string) =>
      apply({
        order: layout.order,
        hidden: layout.hidden.includes(id) ? layout.hidden.filter((item) => item !== id) : [...layout.hidden, id],
      }),
    [apply, layout],
  )

  // Kéo xuống thì thả vào sau thẻ đích, kéo lên thì thả vào trước, giống cảm giác của mọi danh sách sắp xếp được.
  const moveTo = useCallback(
    (id: string, targetId: string) => {
      const from = layout.order.indexOf(id)
      const to = layout.order.indexOf(targetId)
      if (from < 0 || to < 0 || from === to) return
      const order = layout.order.filter((item) => item !== id)
      order.splice(from < to ? order.indexOf(targetId) + 1 : order.indexOf(targetId), 0, id)
      apply({ ...layout, order })
    },
    [apply, layout],
  )

  // Đổi chỗ theo danh sách panel đang hiển thị để nút lên/xuống không nhảy qua panel máy này không có.
  const move = useCallback(
    (id: string, delta: number, sequence: string[]) => {
      const target = sequence[sequence.indexOf(id) + delta]
      if (!target) return
      moveTo(id, target)
    },
    [moveTo],
  )

  const reset = useCallback(() => apply(normalize({ order: [], hidden: [] })), [apply])

  return { layout, toggle, move, moveTo, reset }
}

const WIDE_QUERY = '(min-width: 1280px)'

// Chia cột cố định theo thứ tự thay vì dùng CSS columns: multi-column tự cân bằng chiều cao nên thẻ nhảy cột
// mỗi khi biểu đồ hay ảnh camera đổi kích thước.
function useColumnCount() {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE_QUERY).matches)

  useEffect(() => {
    const query = window.matchMedia(WIDE_QUERY)
    const sync = () => setWide(query.matches)
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])

  return wide ? 2 : 1
}

export function PrinterPanels({
  printer,
  editing,
  onEditingChange,
}: {
  printer: Printer
  editing: boolean
  onEditingChange: (editing: boolean) => void
}) {
  const t = useT()
  const columnCount = useColumnCount()
  const { layout, toggle, move, moveTo, reset } = usePrinterLayout()
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  const endDrag = () => {
    setDragId(null)
    setOverId(null)
  }

  const panels = useMemo(
    () =>
      layout.order
        .map((id) => PANELS.find((panel) => panel.id === id))
        .filter((panel) => panel !== undefined)
        .filter((panel) => panel.available(printer)),
    [layout.order, printer],
  )
  const sequence = panels.map((panel) => panel.id)
  const columns = Array.from({ length: columnCount }, (_, column) => panels.filter((_panel, index) => index % columnCount === column))

  const renderPanel = (panel: PanelDef) => {
    const index = sequence.indexOf(panel.id)
    const hidden = layout.hidden.includes(panel.id)
    if (hidden && !editing) return null
    const { Component } = panel
    return (
      <div
        key={panel.id}
        draggable={editing}
        onDragStart={(event) => {
          setDragId(panel.id)
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', panel.id)
        }}
        onDragEnd={endDrag}
        onDragOver={(event) => {
          if (!dragId) return
          event.preventDefault()
          setOverId(panel.id)
        }}
        onDrop={(event) => {
          if (!dragId) return
          event.preventDefault()
          if (dragId !== panel.id) moveTo(dragId, panel.id)
          endDrag()
        }}
        className={cn(
          'relative rounded-[10px]',
          editing && 'cursor-grab',
          dragId === panel.id && 'opacity-40',
          dragId && dragId !== panel.id && overId === panel.id && 'outline-brand outline-2 outline-offset-2',
        )}
      >
        {hidden ? (
          <div className="text-muted-foreground flex items-center gap-2 rounded-[10px] border-2 border-dashed p-3">
            <GripVertical className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-xs font-medium">{t(panel.titleKey)}</span>
            <Button size="xs" variant="outline" onClick={() => toggle(panel.id)}>
              <Eye /> {t('layout.show')}
            </Button>
          </div>
        ) : (
          <>
            {editing ? (
              <div className="border-brand/50 bg-background/70 absolute inset-0 z-10 rounded-[10px] border-2 border-dashed">
                <div className="bg-card flex items-center gap-1 border-b border-dashed px-2 py-1.5">
                  <GripVertical className="text-muted-foreground size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{t(panel.titleKey)}</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    title={t('layout.move_up')}
                    disabled={index === 0}
                    onClick={() => move(panel.id, -1, sequence)}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    title={t('layout.move_down')}
                    disabled={index === panels.length - 1}
                    onClick={() => move(panel.id, 1, sequence)}
                  >
                    <ArrowDown />
                  </Button>
                  <Button size="icon" variant="ghost" className="size-7" title={t('layout.hide')} onClick={() => toggle(panel.id)}>
                    <EyeOff />
                  </Button>
                </div>
              </div>
            ) : null}
            <div className={cn(editing && 'pointer-events-none select-none')}>
              <Component printer={printer} />
            </div>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {editing ? (
        <div className="border-brand/40 bg-brand/5 flex flex-wrap items-center gap-2 rounded-xl border border-dashed p-3">
          <p className="text-muted-foreground min-w-0 flex-1 text-xs">{t('layout.hint')}</p>
          <Button variant="ghost" size="sm" onClick={reset}>
            <RotateCcw /> {t('layout.reset')}
          </Button>
          <Button size="sm" onClick={() => onEditingChange(false)}>
            <Check /> {t('layout.done')}
          </Button>
        </div>
      ) : null}
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
        {columns.map((column, columnIndex) => (
          <div key={columnIndex} className="flex min-w-0 flex-1 flex-col gap-4">
            {column.map((panel) => renderPanel(panel))}
          </div>
        ))}
      </div>
    </div>
  )
}
