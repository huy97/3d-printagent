import { Layers, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FileThumb } from '@/components/file-thumb'
import { SliceChat } from '@/components/slice-chat'
import { SliceAdvancedFields, SliceProfileFields, SliceUnavailable, useSliceForm } from '@/components/slice-form'
import { useT } from '@/i18n'
import { type LibraryFile } from '@/lib/api'
import { formatNumber } from '@/lib/format'

export function SliceDialog({
  open,
  onOpenChange,
  file,
  printerId,
  onSliced,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  file: LibraryFile | null
  printerId?: string | null
  onSliced?: (file: LibraryFile) => void
}) {
  const t = useT()
  const form = useSliceForm({
    file,
    printerId,
    active: open,
    onSliced: (result) => {
      onOpenChange(false)
      onSliced?.(result.file)
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92dvh] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('slice.title')}</DialogTitle>
          <DialogDescription>{t('slice.description')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {file ? (
            <div className="flex items-center gap-3 rounded-lg border p-2.5">
              <FileThumb file={file} className="size-14" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{file.name}</div>
                <div className="text-muted-foreground flex flex-wrap gap-x-3 text-xs">
                  {file.meta.size ? <span>{`${file.meta.size.x} x ${file.meta.size.y} x ${file.meta.size.z} mm`}</span> : null}
                  {file.meta.volumeCm3 ? <span>{`${formatNumber(file.meta.volumeCm3, 1)} cm3`}</span> : null}
                  {file.meta.overhangRatio ? <span>{t('slice.overhang', { percent: Math.round(file.meta.overhangRatio * 100) })}</span> : null}
                  {file.meta.triangles ? <span>{t('slice.triangles', { count: formatNumber(file.meta.triangles, 0) })}</span> : null}
                  {file.meta.size ? null : <span>{file.format.toUpperCase()}</span>}
                </div>
              </div>
            </div>
          ) : null}

          <SliceUnavailable form={form} />

          {form.status?.available ? (
            <div className="space-y-4">
              <SliceProfileFields form={form} />
              <SliceChat form={form} />
              <SliceAdvancedFields form={form} />
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={form.busy}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void form.submit()} disabled={!form.canSlice}>
            {form.busy ? <Loader2 className="animate-spin" /> : <Layers />}
            {form.busy ? t('slice.running') : t('slice.start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
