import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Check,
  Combine,
  Download,
  Layers,
  LayoutGrid,
  Link2,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  Scissors,
  Search,
  SlidersHorizontal,
  Trash2,
  Upload,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field } from '@/components/field'
import { SelectField } from '@/components/select-field'
import { FileThumb } from '@/components/file-thumb'
import { PlatePreviewDialog } from '@/components/plate-preview'
import { PrintDialog } from '@/components/print-dialog'
import { SliceDialog } from '@/components/slice-dialog'
import { ProgressBar } from '@/components/progress-bar'
import { useConfirm } from '@/components/confirm-dialog'
import { reportError, useAgent } from '@/hooks/use-agent'
import { useT } from '@/i18n'
import { api, mediaUrl, uploadWithProgress, type LibraryFile } from '@/lib/api'
import { formatBytes, formatDuration, formatNumber, formatTime } from '@/lib/format'
import { isUnsliced, slicedDescendants } from '@/lib/library'
import { cn } from '@/lib/utils'

const ACCEPT = '.gcode,.gco,.g,.bgcode,.3mf,.stl,.obj'

interface Upload {
  id: number
  name: string
  progress: number
  error?: string
}

function RenameDialog({ file, onClose }: { file: LibraryFile | null; onClose: () => void }) {
  const t = useT()
  const { upsertFile } = useAgent()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [lastId, setLastId] = useState<string | null>(null)
  if (file && file.id !== lastId) {
    setLastId(file.id)
    setName(file.name)
  }

  const submit = async () => {
    if (!file || !name.trim()) return
    setBusy(true)
    try {
      upsertFile(await api.renameFile(file.id, name.trim()))
      toast.success(t('files.renamed'))
      onClose()
    } catch (error) {
      reportError(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={Boolean(file)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('files.rename_title')}</DialogTitle>
          <DialogDescription>{t('files.rename_description')}</DialogDescription>
        </DialogHeader>
        <Input
          value={name}
          autoFocus
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit()
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !name.trim()}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const isCombinable = (file: LibraryFile) => file.format === 'model' || (file.format === '3mf' && file.meta.sliced === false)

function CombineDialog({
  files,
  open,
  onOpenChange,
  onDone,
}: {
  files: LibraryFile[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: (file: LibraryFile) => void
}) {
  const t = useT()
  const { printers, upsertFile } = useAgent()
  const [copies, setCopies] = useState<Record<string, string>>({})
  const [printerId, setPrinterId] = useState('')
  const [autoRotate, setAutoRotate] = useState(true)
  const [busy, setBusy] = useState(false)
  const chosen = printerId || printers[0]?.id || ''
  const count = (file: LibraryFile) => Math.max(1, Math.round(Number(copies[file.id]) || 1))
  const total = files.reduce((sum, file) => sum + count(file), 0)

  const submit = async () => {
    setBusy(true)
    try {
      const result = await api.combineFiles({
        items: files.map((file) => ({ fileId: file.id, copies: count(file) })),
        printerId: chosen || undefined,
        autoRotate,
      })
      upsertFile(result.file)
      if (result.overflow > 0) {
        toast.warning(t('files.combine_overflow', { placed: result.placed, left: result.overflow, names: result.overflowNames.join(', ') }))
      } else {
        toast.success(t('files.combine_done', { count: result.placed }))
      }
      onDone(result.file)
    } catch (error) {
      reportError(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92dvh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('files.combine_title')}</DialogTitle>
          <DialogDescription>{t('files.combine_description')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="space-y-1.5">
            {files.map((file) => (
              <div key={file.id} className="flex items-center gap-2.5 rounded-lg border p-2">
                <FileThumb file={file} className="size-10 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-sm" title={file.name}>
                  {file.name}
                </span>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  className="h-8 w-20 shrink-0"
                  aria-label={t('files.combine_copies')}
                  value={copies[file.id] ?? '1'}
                  onChange={(event) => setCopies((prev) => ({ ...prev, [file.id]: event.target.value }))}
                />
              </div>
            ))}
          </div>
          {printers.length > 0 ? (
            <Field label={t('files.combine_printer')} hint={t('files.combine_printer_hint')}>
              <SelectField value={chosen} onChange={setPrinterId} options={printers.map((item) => ({ value: item.id, label: item.name }))} />
            </Field>
          ) : null}
          <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
            <span className="space-y-0.5">
              <span className="block text-sm">{t('files.arrange_rotate')}</span>
              <span className="text-muted-foreground block text-xs">{t('files.arrange_rotate_hint')}</span>
            </span>
            <Switch checked={autoRotate} onCheckedChange={setAutoRotate} />
          </label>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={busy || files.length === 0}>
            {busy ? <Loader2 className="animate-spin" /> : <Combine />} {t('files.combine_submit', { count: total })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FileCard({
  file,
  sliced,
  splitting,
  selecting,
  selected,
  onToggle,
  onPrint,
  onSlice,
  onSplit,
  onPlate,
  onRename,
  onDelete,
}: {
  file: LibraryFile
  sliced: LibraryFile | null
  splitting: boolean
  selecting: boolean
  selected: boolean
  onToggle: () => void
  onPrint: () => void
  onSlice: () => void
  onSplit: () => void
  onPlate: () => void
  onRename: () => void
  onDelete: () => void
}) {
  const t = useT()
  const meta = file.meta
  const plates = meta.plates ?? []
  const unsliced = isUnsliced(file)
  const printable = !unsliced || Boolean(sliced)
  // Any file that still has geometry can be shown in 3D on the bed, click the thumbnail to view it.
  const hasPlate = file.format === '3mf' || file.format === 'model'
  const facts = [
    meta.estimatedTime ? formatDuration(meta.estimatedTime) : null,
    meta.filamentType,
    meta.filamentWeightG ? `${formatNumber(meta.filamentWeightG, 1)} g` : null,
    meta.layerHeight ? `${meta.layerHeight} mm` : null,
    meta.nozzleDiameter ? `Ø${meta.nozzleDiameter}` : null,
    meta.triangles ? t('files.triangles', { count: formatNumber(meta.triangles, 0) }) : null,
    plates.length > 1 ? t('files.plates', { count: plates.length }) : null,
  ].filter(Boolean)

  return (
    <Card className={cn('group gap-0 overflow-hidden py-0', selecting && !isCombinable(file) && 'opacity-50', selected && 'ring-brand ring-2')}>
      {selecting ? (
        <button type="button" disabled={!isCombinable(file)} onClick={onToggle} className="relative block text-left">
          <FileThumb file={file} className="aspect-[4/3] w-full rounded-none border-0 border-b" />
          <span
            className={cn(
              'absolute top-2 left-2 flex size-5 items-center justify-center rounded-md border-2',
              selected ? 'border-brand bg-brand text-brand-foreground' : 'border-input bg-card/80',
            )}
          >
            {selected ? <Check className="size-3.5" /> : null}
          </span>
        </button>
      ) : (
        <Link to={`/files/${encodeURIComponent(file.id)}`} title={t('editor.open')} className="relative block text-left">
          <FileThumb file={file} className="aspect-[4/3] w-full rounded-none border-0 border-b" />
          <Badge variant="secondary" className="absolute top-2 left-2 font-mono text-[10px] uppercase">
            {file.format}
          </Badge>
          {file.printCount > 0 ? (
            <Badge variant="outline" className="bg-card/80 absolute top-2 right-2 text-[10px] backdrop-blur">
              {t('files.printed_count', { count: file.printCount })}
            </Badge>
          ) : null}
        </Link>
      )}
      <div className="space-y-2 p-3">
        <div className="flex items-start gap-1">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium" title={file.name}>
              {file.name}
            </div>
            <div className="text-muted-foreground truncate text-xs">
              {formatBytes(file.size)}
              {meta.slicer ? ` · ${meta.slicer}` : ''}
              {meta.printerModel ? ` · ${meta.printerModel}` : ''}
            </div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon" className="-mr-1.5 size-7" aria-label={t('common.more')} />}>
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem render={<Link to={`/files/${encodeURIComponent(file.id)}`} />}>
                <SlidersHorizontal /> {t('editor.open')}
              </DropdownMenuItem>
              {hasPlate ? (
                <DropdownMenuItem onClick={onPlate}>
                  <LayoutGrid /> {t('plate.title')}
                </DropdownMenuItem>
              ) : null}
              {unsliced ? (
                <>
                  <DropdownMenuItem onClick={onSlice}>
                    <Layers /> {t('files.slice')}
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={splitting} title={t('files.split_hint')} onClick={onSplit}>
                    <Scissors /> {t('files.split')}
                  </DropdownMenuItem>
                </>
              ) : null}
              <DropdownMenuItem onClick={onRename}>
                <Pencil /> {t('files.rename')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => window.open(mediaUrl(`/api/files/${encodeURIComponent(file.id)}/download`), '_blank')}>
                <Download /> {t('files.download')}
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 /> {t('common.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {facts.length > 0 ? (
          <div className="text-muted-foreground flex flex-wrap gap-x-2.5 gap-y-0.5 text-xs">
            {facts.map((fact, index) => (
              <span key={index}>{fact}</span>
            ))}
          </div>
        ) : null}
        {unsliced && sliced ? (
          <div className="text-muted-foreground flex items-start gap-1.5 text-xs" title={sliced.name}>
            <Layers className="mt-px size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{t('files.sliced_copy', { name: sliced.name })}</span>
          </div>
        ) : unsliced ? (
          <div className="text-muted-foreground flex items-start gap-1.5 text-xs">
            <AlertTriangle className="text-warn mt-px size-3.5 shrink-0" /> {t('files.not_sliced')}
          </div>
        ) : null}
        {meta.parseError ? <div className="text-muted-foreground text-xs">{t('files.parse_error')}</div> : null}
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-muted-foreground truncate text-[11px]">
            {file.lastPrintedAt ? t('files.last_printed', { time: formatTime(file.lastPrintedAt) }) : formatTime(file.uploadedAt)}
          </span>
          {!printable ? (
            <Button size="sm" variant="outline" disabled={splitting} render={<Link to={`/files/${encodeURIComponent(file.id)}`} />}>
              {splitting ? <Loader2 className="animate-spin" /> : <Layers />} {splitting ? t('files.split_running') : t('files.slice')}
            </Button>
          ) : (
            <Button size="sm" onClick={onPrint}>
              <Play /> {t('files.print')}
            </Button>
          )}
        </div>
      </div>
    </Card>
  )
}

export function FilesTab() {
  const t = useT()
  const { files, config, upsertFile } = useAgent()
  const { confirm, dialog } = useConfirm()
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const [search, setSearch] = useState('')
  const [url, setUrl] = useState('')
  const [addingUrl, setAddingUrl] = useState(false)
  const [uploads, setUploads] = useState<Upload[]>([])
  const [dragging, setDragging] = useState(false)
  const [printFile, setPrintFile] = useState<LibraryFile | null>(null)
  const [sliceFile, setSliceFile] = useState<LibraryFile | null>(null)
  const [renameFile, setRenameFile] = useState<LibraryFile | null>(null)
  const [splitting, setSplitting] = useState<string | null>(null)
  const [plateFile, setPlateFile] = useState<LibraryFile | null>(null)
  const [showDerived, setShowDerived] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [combineOpen, setCombineOpen] = useState(false)

  const query = search.trim().toLowerCase()
  // Versions produced by slicing or splitting live in the source file editor, this list only shows files the user uploaded.
  const own = files.filter((file) => !file.sourceId)
  const slicedOf = (id: string) => slicedDescendants(files, id)[0] ?? null
  const derivedCount = files.length - own.length
  const pool = showDerived ? files : own
  const visible = query ? pool.filter((file) => file.name.toLowerCase().includes(query)) : pool
  const totalBytes = pool.reduce((sum, file) => sum + file.size, 0)

  const announce = (created: LibraryFile, uploadedName: string) => {
    if (created.duplicate) toast.info(t('files.duplicate', { name: uploadedName, existing: created.name }))
    else toast.success(t('files.uploaded', { name: created.name }))
  }

  const pickedFiles = picked.map((id) => files.find((file) => file.id === id)).filter((file): file is LibraryFile => Boolean(file))
  const toggle = (id: string) => setPicked((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))
  const stopSelecting = () => {
    setSelecting(false)
    setPicked([])
  }

  const upload = async (list: FileList | File[]) => {
    for (const file of Array.from(list)) {
      const id = Date.now() + Math.random()
      setUploads((prev) => [...prev, { id, name: file.name, progress: 0 }])
      const form = new FormData()
      form.append('file', file, file.name)
      try {
        const created = await uploadWithProgress<LibraryFile>('/api/files', form, (progress) =>
          setUploads((prev) => prev.map((item) => (item.id === id ? { ...item, progress } : item))),
        )
        upsertFile(created)
        announce(created, file.name)
        setUploads((prev) => prev.filter((item) => item.id !== id))
      } catch (error) {
        const message = error instanceof Error ? error.message : t('common.error')
        setUploads((prev) => prev.map((item) => (item.id === id ? { ...item, error: message } : item)))
      }
    }
  }

  const addUrl = async () => {
    if (!url.trim()) return
    setAddingUrl(true)
    try {
      const created = await api.addFileFromUrl(url.trim())
      upsertFile(created)
      setUrl('')
      announce(created, created.name)
    } catch (error) {
      reportError(error)
    } finally {
      setAddingUrl(false)
    }
  }

  /** After a split, open the editor of the new file, since that is almost always the next step. */
  const split = async (file: LibraryFile) => {
    setSplitting(file.id)
    try {
      const result = await api.splitFile(file.id)
      upsertFile(result.file)
      toast.success(t('files.split_done', { count: result.parts.length }))
      navigate(`/files/${result.file.id}`)
    } catch (error) {
      reportError(error)
    } finally {
      setSplitting(null)
    }
  }

  const remove = (file: LibraryFile) =>
    confirm({
      title: t('files.delete_title', { name: file.name }),
      description: t('files.delete_description'),
      confirmLabel: t('common.delete'),
      destructive: true,
      onConfirm: async () => {
        try {
          await api.deleteFile(file.id)
          toast.success(t('files.deleted'))
        } catch (error) {
          reportError(error)
        }
      },
    })

  return (
    <div className="space-y-4">
      {dialog}
      <div
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          if (event.dataTransfer.files.length) void upload(event.dataTransfer.files)
        }}
        className={cn(
          'bg-card flex flex-col gap-4 rounded-xl border border-dashed p-4 transition-colors lg:flex-row lg:items-center',
          dragging && 'border-brand bg-brand/5',
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="bg-brand/10 text-brand flex size-10 shrink-0 items-center justify-center rounded-lg">
            <Upload className="size-5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium">{t('files.drop_title')}</div>
            <div className="text-muted-foreground text-xs">
              {t('files.drop_hint', { max: config?.files.maxUploadMb ?? 1024 })}
            </div>
          </div>
          <Button className="ml-auto shrink-0" onClick={() => inputRef.current?.click()}>
            <Upload /> {t('files.choose')}
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            multiple
            hidden
            onChange={(event) => {
              if (event.target.files?.length) void upload(event.target.files)
              event.target.value = ''
            }}
          />
        </div>
        {config?.files.allowRemoteUrl !== false ? (
          <form
            className="flex gap-2 lg:w-[28rem]"
            onSubmit={(event) => {
              event.preventDefault()
              void addUrl()
            }}
          >
            <Input value={url} placeholder="https://.../model.3mf" onChange={(event) => setUrl(event.target.value)} />
            <Button type="submit" variant="outline" disabled={addingUrl || !url.trim()}>
              {addingUrl ? <Loader2 className="animate-spin" /> : <Link2 />} {t('files.add_url')}
            </Button>
          </form>
        ) : null}
      </div>

      {uploads.length > 0 ? (
        <div className="space-y-2">
          {uploads.map((item) => (
            <div key={item.id} className="bg-card flex items-center gap-3 rounded-lg border px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-sm">{item.name}</span>
              {item.error ? (
                <>
                  <span className="text-destructive min-w-0 truncate text-xs">{item.error}</span>
                  <Button size="xs" variant="ghost" onClick={() => setUploads((prev) => prev.filter((entry) => entry.id !== item.id))}>
                    {t('common.close')}
                  </Button>
                </>
              ) : (
                <>
                  <ProgressBar value={item.progress * 100} tone="info" className="w-40" />
                  <span className="text-muted-foreground w-20 text-right text-xs tabular-nums">
                    {item.progress >= 1 ? t('files.processing') : `${Math.round(item.progress * 100)}%`}
                  </span>
                </>
              )}
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:w-80">
          <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input value={search} placeholder={t('files.search')} className="pl-8" onChange={(event) => setSearch(event.target.value)} />
        </div>
        <span className="text-muted-foreground text-xs">
          {t('files.summary', { count: pool.length, size: formatBytes(totalBytes) })}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {selecting ? (
            <>
              <span className="text-muted-foreground text-xs">{t('files.combine_picked', { count: picked.length })}</span>
              <Button size="xs" variant="outline" onClick={stopSelecting}>
                {t('common.cancel')}
              </Button>
              <Button size="xs" disabled={picked.length === 0} onClick={() => setCombineOpen(true)}>
                <Combine /> {t('files.combine_next')}
              </Button>
            </>
          ) : (
            <Button size="xs" variant="outline" title={t('files.combine_hint')} onClick={() => setSelecting(true)}>
              <Combine /> {t('files.combine')}
            </Button>
          )}
          {derivedCount > 0 ? (
            <Button size="xs" variant={showDerived ? 'default' : 'outline'} onClick={() => setShowDerived((prev) => !prev)}>
              {t('files.show_derived', { count: derivedCount })}
            </Button>
          ) : null}
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="text-muted-foreground bg-card rounded-xl border py-16 text-center text-sm">
          {pool.length === 0 ? t('files.empty') : t('files.no_match')}
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
          {visible.map((file) => (
            <FileCard
              key={file.id}
              file={file}
              sliced={isUnsliced(file) ? slicedOf(file.id) : null}
              splitting={splitting === file.id}
              selecting={selecting}
              selected={picked.includes(file.id)}
              onToggle={() => toggle(file.id)}
              onPrint={() => setPrintFile(isUnsliced(file) ? slicedOf(file.id) : file)}
              onSlice={() => setSliceFile(file)}
              onSplit={() => void split(file)}
              onPlate={() => setPlateFile(file)}
              onRename={() => setRenameFile(file)}
              onDelete={() => remove(file)}
            />
          ))}
        </div>
      )}

      <PrintDialog open={Boolean(printFile)} onOpenChange={(open) => !open && setPrintFile(null)} file={printFile} />
      <SliceDialog
        open={Boolean(sliceFile)}
        onOpenChange={(open) => !open && setSliceFile(null)}
        file={sliceFile}
        onSliced={(created) => setPrintFile(created)}
      />
      <PlatePreviewDialog file={plateFile} onClose={() => setPlateFile(null)} />
      <CombineDialog
        files={pickedFiles}
        open={combineOpen}
        onOpenChange={setCombineOpen}
        onDone={(created) => {
          setCombineOpen(false)
          stopSelecting()
          navigate(`/files/${encodeURIComponent(created.id)}`)
        }}
      />
      <RenameDialog file={renameFile} onClose={() => setRenameFile(null)} />
    </div>
  )
}
