import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Download, Grid2x2, Layers, Loader2, Play, RotateCw, Scissors, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field } from '@/components/field'
import { FileThumb } from '@/components/file-thumb'
import { PlateViewer } from '@/components/plate-preview'
import { PrintDialog } from '@/components/print-dialog'
import { SliceChat } from '@/components/slice-chat'
import { SliceAdvancedFields, SliceProfileFields, SliceUnavailable, useSliceForm } from '@/components/slice-form'
import { useConfirm } from '@/components/confirm-dialog'
import { reportError, useAgent } from '@/hooks/use-agent'
import { useT } from '@/i18n'
import { api, mediaUrl, type LibraryFile } from '@/lib/api'
import { slicedDescendants } from '@/lib/library'
import { formatBytes, formatDuration, formatNumber, formatTime } from '@/lib/format'

/** Bản cắt lát cũ chất đống rất nhanh, chỉ mở sẵn vài bản gần nhất. */
const RECENT = 4

/** Mặc định giống phần mềm cắt lát: hở 6 mm giữa hai vật, chừa 2 mm tính từ mép bàn. */
const ARRANGE_DEFAULTS = { gap: '6', margin: '2', separate: false, autoRotate: false }

type ArrangeOptions = typeof ARRANGE_DEFAULTS

/** Hộp tuỳ chọn trước khi xếp: khoảng hở, lề bàn, có rã cụm dính nhau và có tự lật mặt đáy hay không. */
function ArrangeDialog({
  open,
  onOpenChange,
  busy,
  onStart,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  busy: boolean
  onStart: (options: ArrangeOptions) => void
}) {
  const t = useT()
  const [options, setOptions] = useState<ArrangeOptions>(ARRANGE_DEFAULTS)
  const set = <Key extends keyof ArrangeOptions>(key: Key, value: ArrangeOptions[Key]) => setOptions((prev) => ({ ...prev, [key]: value }))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('files.arrange_title')}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('files.arrange_gap')}>
            <Input type="number" min="0" max="100" step="0.5" value={options.gap} onChange={(event) => set('gap', event.target.value)} />
          </Field>
          <Field label={t('files.arrange_margin')}>
            <Input type="number" min="0" max="100" step="0.5" value={options.margin} onChange={(event) => set('margin', event.target.value)} />
          </Field>
          <Field label={t('files.arrange_rotate')} hint={t('files.arrange_rotate_hint')} className="sm:col-span-2">
            <Switch checked={options.autoRotate} onCheckedChange={(next) => set('autoRotate', next)} />
          </Field>
          <Field label={t('files.arrange_separate')} hint={t('files.arrange_separate_hint')} className="sm:col-span-2">
            <Switch checked={options.separate} onCheckedChange={(next) => set('separate', next)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button disabled={busy} onClick={() => onStart(options)}>
            {busy ? <Loader2 className="animate-spin" /> : <Grid2x2 />} {busy ? t('files.arrange_running') : t('files.arrange')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Một bản đã cắt lát ra từ file gốc: xem đường in, xem nhanh thông số rồi in, tải hoặc xoá. */
function SlicedRow({
  file,
  active,
  onSelect,
  onPrint,
  onDelete,
}: {
  file: LibraryFile
  active: boolean
  onSelect: () => void
  onPrint: () => void
  onDelete: () => void
}) {
  const t = useT()
  const meta = file.meta
  const facts = [
    meta.estimatedTime ? formatDuration(meta.estimatedTime) : null,
    meta.filamentWeightG ? `${formatNumber(meta.filamentWeightG, 1)} g` : null,
    meta.layerHeight ? `${meta.layerHeight} mm` : null,
    meta.filamentType,
    formatBytes(file.size),
  ].filter(Boolean)

  return (
    <div className={`bg-card flex items-center gap-3 rounded-lg border p-2.5 ${active ? 'border-brand ring-brand/30 ring-1' : ''}`}>
      <FileThumb file={file} className="size-14 shrink-0" />
      <button type="button" onClick={onSelect} className="min-w-0 flex-1 text-left" title={t('editor.preview')}>
        <div className="truncate text-sm font-medium" title={file.name}>
          {file.name}
        </div>
        <div className="text-muted-foreground flex flex-wrap gap-x-2.5 text-xs">
          {facts.map((fact, index) => (
            <span key={index}>{fact}</span>
          ))}
        </div>
        <div className="text-muted-foreground text-[11px]">{formatTime(file.uploadedAt)}</div>
      </button>
      <div className="flex shrink-0 gap-1.5">
        <Button size="sm" onClick={onPrint}>
          <Play /> {t('files.print')}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label={t('files.download')}
          onClick={() => window.open(mediaUrl(`/api/files/${encodeURIComponent(file.id)}/download`), '_blank')}
        >
          <Download />
        </Button>
        <Button size="icon" variant="ghost" aria-label={t('common.delete')} onClick={onDelete}>
          <Trash2 />
        </Button>
      </div>
    </div>
  )
}

export function FileEditor() {
  const t = useT()
  const { fileId } = useParams()
  const navigate = useNavigate()
  const { files, upsertFile } = useAgent()
  const { confirm, dialog } = useConfirm()
  const [printFile, setPrintFile] = useState<LibraryFile | null>(null)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [splitting, setSplitting] = useState(false)
  const [arranging, setArranging] = useState(false)
  const [arrangeOpen, setArrangeOpen] = useState(false)
  const [orienting, setOrienting] = useState(false)
  const [showAll, setShowAll] = useState(false)

  const file = files.find((item) => item.id === fileId) ?? null
  // Cắt lát từ bản sắp khay thì bản in nằm dưới bản sắp khay, vẫn phải hiện ở file gốc; còn bản sắp khay chưa cắt thì không in được.
  const sliced = fileId ? slicedDescendants(files, fileId) : []
  const canSplit = file ? file.format === 'model' || (file.format === '3mf' && file.meta.sliced === false) : false

  // Xem khay của bản đã cắt lát nếu người dùng chọn, mặc định vẫn là mô hình gốc.
  const shown = sliced.find((item) => item.id === previewId) ?? file
  const form = useSliceForm({
    file,
    onSliced: (result) => {
      setPreviewId(result.file.id)
      setPrintFile(result.file)
    },
  })

  const split = async () => {
    if (!file) return
    setSplitting(true)
    try {
      const result = await api.splitFile(file.id)
      upsertFile(result.file)
      toast.success(t('files.split_done', { count: result.parts.length }))
      navigate(`/files/${result.file.id}`)
    } catch (error) {
      reportError(error)
    } finally {
      setSplitting(false)
    }
  }

  /** Xoay xong mà khác hướng cũ thì server tạo bản mới, mở luôn bản đó để cắt lát tiếp. */
  const orient = async () => {
    if (!file) return
    setOrienting(true)
    try {
      const result = await api.orientFile(file.id)
      if (!result.changed) {
        toast.info(t('files.orient_kept'))
        return
      }
      upsertFile(result.file)
      toast.success(
        t('files.orient_done', {
          before: formatNumber(result.before.supportCm3, 1),
          after: formatNumber(result.after.supportCm3, 1),
        }),
      )
      navigate(`/files/${result.file.id}`)
    } catch (error) {
      reportError(error)
    } finally {
      setOrienting(false)
    }
  }

  const arrange = async (options: ArrangeOptions) => {
    if (!file) return
    setArranging(true)
    try {
      const result = await api.arrangeFile(file.id, {
        machine: form.machine,
        printerId: form.printer,
        gap: Number(options.gap),
        margin: Number(options.margin),
        separate: options.separate,
        autoRotate: options.autoRotate,
      })
      upsertFile(result.file)
      if (result.overflow > 0) toast.warning(t('files.arrange_overflow', { count: result.clusters, left: result.overflow }))
      else toast.success(t('files.arrange_done', { count: result.clusters }))
      setArrangeOpen(false)
      navigate(`/files/${result.file.id}`)
    } catch (error) {
      reportError(error)
    } finally {
      setArranging(false)
    }
  }

  // Kéo thả trên khung 3D chỉ ghi được cho mô hình chưa cắt lát, vì file đã cắt lát đường in không còn khớp vị trí mới.
  const canMove = Boolean(shown && shown.format === '3mf' && shown.meta.sliced === false)
  const move = async (moves: { item: number; dx: number; dy: number }[]) => {
    if (!shown) return
    try {
      const result = await api.moveObjects(shown.id, moves)
      upsertFile(result.file)
    } catch (error) {
      reportError(error)
    }
  }

  const remove = (target: LibraryFile) =>
    confirm({
      title: t('files.delete_title', { name: target.name }),
      description: t('files.delete_description'),
      confirmLabel: t('common.delete'),
      destructive: true,
      onConfirm: async () => {
        try {
          await api.deleteFile(target.id)
          toast.success(t('files.deleted'))
          if (target.id === fileId) navigate('/files')
        } catch (error) {
          reportError(error)
        }
      },
    })

  if (!file) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" className="-ml-2" render={<Link to="/files" />}>
          <ArrowLeft /> {t('editor.back')}
        </Button>
        <div className="text-muted-foreground bg-card rounded-xl border py-16 text-center text-sm">{t('editor.missing')}</div>
      </div>
    )
  }

  const meta = file.meta
  const facts = [
    meta.size ? `${meta.size.x} × ${meta.size.y} × ${meta.size.z} mm` : null,
    meta.volumeCm3 ? `${formatNumber(meta.volumeCm3, 1)} cm³` : null,
    meta.triangles ? t('files.triangles', { count: formatNumber(meta.triangles, 0) }) : null,
    meta.overhangRatio ? t('slice.overhang', { percent: Math.round(meta.overhangRatio * 100) }) : null,
    formatBytes(file.size),
  ].filter(Boolean)

  return (
    <div className="space-y-4">
      {dialog}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" className="-ml-2 shrink-0" render={<Link to="/files" />}>
          <ArrowLeft /> {t('editor.back')}
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-base font-semibold" title={file.name}>
              {file.name}
            </h1>
            <Badge variant="secondary" className="font-mono text-[10px] uppercase">
              {file.format}
            </Badge>
          </div>
          <div className="text-muted-foreground flex flex-wrap gap-x-2.5 text-xs">
            {facts.map((fact, index) => (
              <span key={index}>{fact}</span>
            ))}
          </div>
        </div>
        {canSplit ? (
          <>
            <Button variant="outline" size="sm" disabled={splitting} title={t('files.split_hint')} onClick={() => void split()}>
              {splitting ? <Loader2 className="animate-spin" /> : <Scissors />} {t('files.split')}
            </Button>
            <Button variant="outline" size="sm" disabled={orienting} title={t('files.orient_hint')} onClick={() => void orient()}>
              {orienting ? <Loader2 className="animate-spin" /> : <RotateCw />} {t('files.orient')}
            </Button>
            <Button variant="outline" size="sm" disabled={arranging || !form.machine} title={t('files.arrange_hint')} onClick={() => setArrangeOpen(true)}>
              {arranging ? <Loader2 className="animate-spin" /> : <Grid2x2 />} {t('files.arrange')}
            </Button>
          </>
        ) : null}
      </div>

      <div className="grid gap-4 xl:grid-cols-[20rem_minmax(0,1fr)_24rem]">
        {form.status?.available ? (
          <SliceChat form={form} docked className="order-last h-128 xl:sticky xl:top-4 xl:order-first xl:h-[calc(100dvh-10rem)]" />
        ) : null}
        <div className="min-w-0 space-y-4">
          {shown && shown.id !== file.id ? (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground min-w-0 truncate">{t('editor.viewing', { name: shown.name })}</span>
              <Button size="xs" variant="outline" onClick={() => setPreviewId(null)}>
                {t('editor.view_model')}
              </Button>
            </div>
          ) : null}
          <PlateViewer key={shown?.id ?? ''} file={shown} machine={form.machine} onMove={canMove ? (moves) => void move(moves) : undefined} />

          {sliced.length > 0 ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">{t('editor.sliced', { count: sliced.length })}</p>
              {(showAll ? sliced : sliced.slice(0, RECENT)).map((item) => (
                <SlicedRow
                  key={item.id}
                  file={item}
                  active={item.id === shown?.id}
                  onSelect={() => setPreviewId(item.id)}
                  onPrint={() => setPrintFile(item)}
                  onDelete={() => remove(item)}
                />
              ))}
              {sliced.length > RECENT ? (
                <Button variant="ghost" size="sm" onClick={() => setShowAll((prev) => !prev)}>
                  {showAll ? t('editor.show_less') : t('editor.show_all', { count: sliced.length - RECENT })}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="bg-card flex h-fit flex-col gap-4 rounded-xl border p-4 xl:sticky xl:top-4 xl:h-[calc(100dvh-10rem)]">
          <div className="shrink-0">
            <p className="text-sm font-medium">{t('editor.settings')}</p>
            <p className="text-muted-foreground text-xs">{t('slice.advanced_hint')}</p>
          </div>

          <div className="-mx-4 min-h-0 flex-1 space-y-4 px-4 xl:overflow-y-auto">
            <SliceUnavailable form={form} />
            {form.status?.available ? (
              <>
                <SliceProfileFields form={form} columns={1} />
                <SliceAdvancedFields form={form} columns={1} />
              </>
            ) : null}
          </div>

          {form.status?.available ? (
            <Button className="w-full shrink-0" disabled={!form.canSlice} onClick={() => void form.submit()}>
              {form.busy ? <Loader2 className="animate-spin" /> : <Layers />}
              {form.busy ? t('slice.running') : t('slice.start')}
            </Button>
          ) : null}
        </div>
      </div>

      <ArrangeDialog open={arrangeOpen} onOpenChange={setArrangeOpen} busy={arranging} onStart={(options) => void arrange(options)} />
      <PrintDialog open={Boolean(printFile)} onOpenChange={(open) => !open && setPrintFile(null)} file={printFile} />
    </div>
  )
}
