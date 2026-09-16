import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { FlaskConical, LayoutGrid, MoreHorizontal, Pencil, Plug, Plus, Printer as PrinterIcon, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { StatusBadge } from '@/components/status-badge'
import { ProgressBar } from '@/components/progress-bar'
import { PrinterDialog, type PrinterDraft } from '@/components/printer-dialog'
import { PrinterPanels } from '@/components/printer-layout'
import { BedClearBanner } from '@/components/printer-panels'
import { useConfirm } from '@/components/confirm-dialog'
import { reportError, useAgent } from '@/hooks/use-agent'
import { useT } from '@/i18n'
import { api, type Printer } from '@/lib/api'
import { formatTemp } from '@/lib/format'
import { cn } from '@/lib/utils'

const VIRTUAL_DRAFT: PrinterDraft = { name: 'Virtual MK4', driver: 'virtual', connection: {} }

function printerStatus(printer: Printer) {
  return printer.enabled ? printer.status.state : 'disabled'
}

function PrinterListItem({ printer, active, onSelect }: { printer: Printer; active: boolean; onSelect: () => void }) {
  const { status } = printer
  const printing = status.state === 'printing' || status.state === 'paused'
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'w-full space-y-1.5 rounded-lg border px-3 py-2.5 text-left transition-colors',
        active ? 'border-brand/60 bg-brand/5' : 'bg-card hover:bg-accent/50',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{printer.name}</span>
        <StatusBadge status={printerStatus(printer)} />
      </div>
      <div className="text-muted-foreground flex justify-between gap-2 text-xs">
        <span className="truncate">{printer.driverLabel}</span>
        <span className="shrink-0 tabular-nums">
          {status.temps.nozzle ? `${Math.round(status.temps.nozzle.actual)}°` : ''}
          {status.temps.bed ? ` / ${Math.round(status.temps.bed.actual)}°` : ''}
        </span>
      </div>
      {printing ? <ProgressBar value={status.job?.progress} /> : null}
    </button>
  )
}

function PrinterHeader({
  printer,
  onEdit,
  layoutEditing,
  onToggleLayout,
}: {
  printer: Printer
  onEdit: () => void
  layoutEditing: boolean
  onToggleLayout: () => void
}) {
  const t = useT()
  const { upsertPrinter, refreshPrinters } = useAgent()
  const { confirm, dialog } = useConfirm()
  const [busy, setBusy] = useState(false)
  const { status } = printer

  const run = async (action: () => Promise<Printer>, success?: string) => {
    setBusy(true)
    try {
      upsertPrinter(await action())
      if (success) toast.success(success)
    } catch (error) {
      reportError(error)
    } finally {
      setBusy(false)
    }
  }

  const remove = () =>
    confirm({
      title: t('printer.delete_title', { name: printer.name }),
      description: t('printer.delete_description'),
      confirmLabel: t('common.delete'),
      destructive: true,
      onConfirm: async () => {
        try {
          await api.removePrinter(printer.id)
          await refreshPrinters()
          toast.success(t('printer.deleted'))
        } catch (error) {
          reportError(error)
        }
      },
    })

  const temps = (['nozzle', 'bed', 'chamber'] as const).filter((key) => status.temps[key])

  return (
    <Card>
      {dialog}
      <CardContent className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-0 basis-full items-start gap-4 sm:basis-0 sm:flex-1">
          <div className="bg-brand/10 text-brand flex size-11 shrink-0 items-center justify-center rounded-xl">
            <PrinterIcon className="size-5" />
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-lg font-semibold">{printer.name}</h2>
              <StatusBadge status={printerStatus(printer)} />
            </div>
            <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
              <span>{printer.driverLabel}</span>
              {printer.connection.host ? <span className="font-mono">{String(printer.connection.host)}</span> : null}
              {status.firmware ? <span>{status.firmware}</span> : null}
              {printer.formats.length ? <span className="uppercase">{printer.formats.join(' · ')}</span> : null}
            </div>
            {status.message ? (
              <p className={cn('text-xs', status.state === 'error' || !status.online ? 'text-destructive' : 'text-muted-foreground')}>{status.message}</p>
            ) : null}
            {printer.notes ? <p className="text-muted-foreground text-xs italic">{printer.notes}</p> : null}
          </div>
        </div>
        {temps.length > 0 ? (
          <dl className="flex gap-4">
            {temps.map((key) => (
              <div key={key} className="text-right">
                <dt className="text-muted-foreground text-[11px]">{t(`temp.${key}`)}</dt>
                <dd className="text-sm font-medium tabular-nums">{formatTemp(status.temps[key])}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <div className="flex items-center gap-2">
          <label className="text-muted-foreground flex items-center gap-1.5 text-xs" title={t('printer_dialog.enabled_hint')}>
            <Switch
              size="sm"
              checked={printer.enabled}
              disabled={busy}
              onCheckedChange={(checked) => void run(() => api.updatePrinter(printer.id, { enabled: checked }))}
            />
            {t('printer_dialog.enabled')}
          </label>
          <Button variant="outline" size="sm" onClick={() => void run(() => api.reconnect(printer.id), t('printer.reconnecting'))} disabled={busy || !printer.enabled}>
            <RefreshCw className={busy ? 'animate-spin' : ''} /> {t('printer.reconnect')}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={t('common.more')} />}>
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onEdit}>
                <Pencil /> {t('common.edit')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onToggleLayout}>
                <LayoutGrid /> {t(layoutEditing ? 'layout.done' : 'layout.customize')}
              </DropdownMenuItem>
              {printer.capabilities.connect ? (
                <DropdownMenuItem onClick={() => void api.command(printer.id, 'connect').then(() => toast.success(t('printer.connect_sent')), reportError)}>
                  <Plug /> {t('printer.connect')}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={remove}>
                <Trash2 /> {t('common.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardContent>
    </Card>
  )
}

function PrinterDetail({ printer, onEdit }: { printer: Printer; onEdit: () => void }) {
  const [layoutEditing, setLayoutEditing] = useState(false)

  return (
    <div className="min-w-0 space-y-4">
      <PrinterHeader printer={printer} onEdit={onEdit} layoutEditing={layoutEditing} onToggleLayout={() => setLayoutEditing((value) => !value)} />
      <BedClearBanner printer={printer} />
      <PrinterPanels printer={printer} editing={layoutEditing} onEditingChange={setLayoutEditing} />
    </div>
  )
}

export function PrintersTab() {
  const t = useT()
  const navigate = useNavigate()
  const { printerId } = useParams()
  const { printers, loading } = useAgent()
  const [dialog, setDialog] = useState<{ printer?: Printer | null; draft?: PrinterDraft | null } | null>(null)
  const selected = printers.find((item) => item.id === printerId) ?? printers[0] ?? null

  const dialogElement = (
    <PrinterDialog open={Boolean(dialog)} onOpenChange={(open) => !open && setDialog(null)} printer={dialog?.printer} draft={dialog?.draft} />
  )

  if (printers.length === 0) {
    return (
      <>
        {dialogElement}
        <Card className="items-center py-14 text-center">
          <div className="bg-brand/10 text-brand flex size-12 items-center justify-center rounded-xl">
            <PrinterIcon className="size-6" />
          </div>
          <div className="space-y-1 px-4">
            <div className="font-medium">{loading ? t('common.loading') : t('printers.empty_title')}</div>
            <p className="text-muted-foreground text-sm">{t('printers.empty_description')}</p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={() => setDialog({})}>
              <Plus /> {t('printers.add')}
            </Button>
            <Button variant="outline" onClick={() => setDialog({ draft: VIRTUAL_DRAFT })}>
              <FlaskConical /> {t('printers.add_virtual')}
            </Button>
          </div>
        </Card>
      </>
    )
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
      {dialogElement}
      <div className="space-y-2">
        <div className="flex gap-2">
          <Button className="flex-1" onClick={() => setDialog({})}>
            <Plus /> {t('printers.add')}
          </Button>
          <Button variant="outline" size="icon" title={t('printers.add_virtual')} onClick={() => setDialog({ draft: VIRTUAL_DRAFT })}>
            <FlaskConical />
          </Button>
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
          {printers.map((printer) => (
            <div key={printer.id} className="min-w-60 flex-1 lg:min-w-0">
              <PrinterListItem printer={printer} active={printer.id === selected?.id} onSelect={() => navigate(`/printers/${encodeURIComponent(printer.id)}`)} />
            </div>
          ))}
        </div>
      </div>
      {selected ? <PrinterDetail key={selected.id} printer={selected} onEdit={() => setDialog({ printer: selected })} /> : null}
    </div>
  )
}
