import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ChevronDown, Loader2, PlugZap, Radar, ScanSearch } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Field } from '@/components/field'
import { SelectField } from '@/components/select-field'
import { reportError, useAgent } from '@/hooks/use-agent'
import { useI18n } from '@/i18n'
import { translateOptional } from '@/i18n/locale'
import { api, type DetectResult, type DiscoveredPrinter, type DriverField, type Printer } from '@/lib/api'
import { cn } from '@/lib/utils'

type FormValue = string | boolean
type Form = {
  name: string
  driver: string
  notes: string
  enabled: boolean
  autoStartQueue: boolean
  powerW: string
  hourlyCost: string
  connection: Record<string, FormValue>
}

const optionalNumber = (value: string) => (value.trim() === '' ? null : Number(value))

export interface PrinterDraft {
  name?: string
  driver: string
  connection: Record<string, unknown>
}

function emptyConnection(fields: DriverField[], source: Record<string, unknown> = {}) {
  const connection: Record<string, FormValue> = {}
  for (const field of fields) {
    const value = source[field.key] ?? field.default
    if (field.type === 'boolean') connection[field.key] = value === true
    else if (field.secret && value === '***') connection[field.key] = ''
    else connection[field.key] = value === null || value === undefined ? '' : String(value)
  }
  return connection
}

export function PrinterDialog({
  open,
  onOpenChange,
  printer,
  draft,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  printer?: Printer | null
  draft?: PrinterDraft | null
}) {
  const { t, locale } = useI18n()
  const { drivers, upsertPrinter } = useAgent()
  const editing = Boolean(printer)
  const [form, setForm] = useState<Form>({
    name: '',
    driver: 'octoprint',
    notes: '',
    enabled: true,
    autoStartQueue: false,
    powerW: '',
    hourlyCost: '',
    connection: {},
  })
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [busy, setBusy] = useState<'save' | 'test' | 'detect' | 'discover' | null>(null)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [detectHost, setDetectHost] = useState('')
  const [detected, setDetected] = useState<DetectResult | null>(null)
  const [discovered, setDiscovered] = useState<DiscoveredPrinter[] | null>(null)

  const driver = drivers.find((item) => item.id === form.driver) ?? drivers[0]
  const savedSecrets = new Set(
    Object.entries(printer?.connection ?? {})
      .filter(([, value]) => value === '***')
      .map(([key]) => key),
  )

  useEffect(() => {
    if (!open) return
    const driverId = printer?.driver ?? draft?.driver ?? drivers[0]?.id ?? 'octoprint'
    const fields = drivers.find((item) => item.id === driverId)?.fields ?? []
    setForm({
      name: printer?.name ?? draft?.name ?? '',
      driver: driverId,
      notes: printer?.notes ?? '',
      enabled: printer?.enabled ?? true,
      autoStartQueue: printer?.autoStartQueue ?? false,
      powerW: printer?.powerW != null ? String(printer.powerW) : '',
      hourlyCost: printer?.hourlyCost != null ? String(printer.hourlyCost) : '',
      connection: emptyConnection(fields, printer?.connection ?? draft?.connection),
    })
    setShowAdvanced(false)
    setTestResult(null)
    setDetected(null)
    setDiscovered(null)
    setDetectHost('')
  }, [open, printer, draft, drivers])

  const applyDraft = (next: PrinterDraft) => {
    const fields = drivers.find((item) => item.id === next.driver)?.fields ?? []
    setForm((prev) => ({
      ...prev,
      driver: next.driver,
      name: prev.name || next.name || '',
      connection: emptyConnection(fields, { ...prev.connection, ...next.connection }),
    }))
    setTestResult(null)
  }

  const changeDriver = (driverId: string) => {
    const fields = drivers.find((item) => item.id === driverId)?.fields ?? []
    setForm((prev) => ({ ...prev, driver: driverId, connection: emptyConnection(fields, { host: prev.connection.host }) }))
    setTestResult(null)
  }

  const connectionPayload = () => {
    const result: Record<string, unknown> = {}
    for (const field of driver?.fields ?? []) {
      const value = form.connection[field.key]
      if (field.secret && value === '' && savedSecrets.has(field.key)) result[field.key] = '***'
      else if (field.type === 'number') result[field.key] = value === '' ? null : Number(value)
      else result[field.key] = value === '' ? null : value
    }
    return result
  }

  const test = async () => {
    setBusy('test')
    setTestResult(null)
    try {
      const result = await api.testPrinter({ id: printer?.id, driver: form.driver, connection: connectionPayload() })
      setTestResult({ ok: true, text: t('printer_dialog.test_ok', { info: result.firmware ?? result.state ?? 'OK' }) })
    } catch (error) {
      setTestResult({ ok: false, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(null)
    }
  }

  const detect = async () => {
    if (!detectHost.trim()) return
    setBusy('detect')
    setDetected(null)
    try {
      const result = await api.detectPrinter(detectHost.trim())
      setDetected(result)
      if (result.candidates.length === 1) applyDraft(result.candidates[0])
    } catch (error) {
      reportError(error)
    } finally {
      setBusy(null)
    }
  }

  const discover = async () => {
    setBusy('discover')
    try {
      setDiscovered((await api.discoverPrinters()).found)
    } catch (error) {
      reportError(error)
    } finally {
      setBusy(null)
    }
  }

  const save = async () => {
    setBusy('save')
    try {
      const body = {
        name: form.name.trim(),
        driver: form.driver,
        notes: form.notes,
        enabled: form.enabled,
        autoStartQueue: form.autoStartQueue,
        powerW: optionalNumber(form.powerW),
        hourlyCost: optionalNumber(form.hourlyCost),
        connection: connectionPayload(),
      }
      const saved = printer ? await api.updatePrinter(printer.id, body) : await api.addPrinter(body)
      upsertPrinter(saved)
      toast.success(printer ? t('printer_dialog.updated') : t('printer_dialog.added', { name: saved.name }))
      onOpenChange(false)
    } catch (error) {
      reportError(error)
    } finally {
      setBusy(null)
    }
  }

  const fieldLabel = (field: DriverField) => translateOptional(locale, `field.${field.key}`) ?? field.key
  const fieldHint = (field: DriverField) => translateOptional(locale, `field.${form.driver}.${field.key}_hint`) ?? translateOptional(locale, `field.${field.key}_hint`) ?? undefined
  const primaryFields = (driver?.fields ?? []).filter((field) => !field.advanced)
  const advancedFields = (driver?.fields ?? []).filter((field) => field.advanced)
  const driverHint = translateOptional(locale, `driver.${form.driver}.hint`)

  const renderField = (field: DriverField) => {
    const value = form.connection[field.key]
    const setValue = (next: FormValue) => setForm((prev) => ({ ...prev, connection: { ...prev.connection, [field.key]: next } }))
    const label = `${fieldLabel(field)}${field.required ? ' *' : ''}`
    if (field.type === 'boolean') {
      return (
        <Field key={field.key} label={label} hint={fieldHint(field)}>
          <div className="flex h-9 items-center">
            <Switch checked={value === true} onCheckedChange={(checked) => setValue(checked)} />
          </div>
        </Field>
      )
    }
    if (field.type === 'select') {
      return (
        <Field key={field.key} label={label} hint={fieldHint(field)}>
          <SelectField
            value={String(value ?? '')}
            onChange={setValue}
            options={(field.options ?? []).map((option) => ({
              ...option,
              label: translateOptional(locale, `field.${form.driver}.${field.key}.${option.value}`) ?? option.label,
            }))}
          />
        </Field>
      )
    }
    const secretSaved = field.secret && savedSecrets.has(field.key)
    return (
      <Field key={field.key} label={label} hint={secretSaved ? t('printer_dialog.secret_saved') : fieldHint(field)}>
        <Input
          type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
          value={String(value ?? '')}
          min={field.min}
          max={field.max}
          placeholder={secretSaved ? '••••••••' : field.placeholder}
          autoComplete="off"
          onChange={(event) => setValue(event.target.value)}
        />
      </Field>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92dvh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? t('printer_dialog.edit_title', { name: printer?.name ?? '' }) : t('printer_dialog.add_title')}</DialogTitle>
          <DialogDescription>{t('printer_dialog.description')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {!editing ? (
            <div className="bg-muted/30 space-y-2.5 rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={detectHost}
                  placeholder={t('printer_dialog.detect_placeholder')}
                  className="min-w-40 flex-1"
                  onChange={(event) => setDetectHost(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void detect()
                  }}
                />
                <Button variant="outline" onClick={() => void detect()} disabled={busy !== null || !detectHost.trim()}>
                  {busy === 'detect' ? <Loader2 className="animate-spin" /> : <ScanSearch />} {t('printer_dialog.detect')}
                </Button>
                <Button variant="outline" onClick={() => void discover()} disabled={busy !== null}>
                  {busy === 'discover' ? <Loader2 className="animate-spin" /> : <Radar />} {t('printer_dialog.discover')}
                </Button>
              </div>
              {busy === 'discover' ? <p className="text-muted-foreground text-xs">{t('printer_dialog.discovering')}</p> : null}
              {detected ? (
                detected.candidates.length === 0 ? (
                  <p className="text-muted-foreground text-xs">{t('printer_dialog.detect_none', { host: detected.host })}</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {detected.candidates.map((candidate) => (
                      <Button
                        key={candidate.driver}
                        size="sm"
                        variant={form.driver === candidate.driver ? 'secondary' : 'outline'}
                        onClick={() => applyDraft(candidate)}
                      >
                        {drivers.find((item) => item.id === candidate.driver)?.label ?? candidate.driver}
                        <span className="text-muted-foreground">({t(`confidence.${candidate.confidence}`)})</span>
                      </Button>
                    ))}
                  </div>
                )
              ) : null}
              {discovered ? (
                discovered.length === 0 ? (
                  <p className="text-muted-foreground text-xs">{t('printer_dialog.discover_none')}</p>
                ) : (
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {discovered.map((item) => (
                      <button
                        key={`${item.driver}-${item.host}-${item.port ?? ''}`}
                        type="button"
                        className="hover:bg-accent/60 flex flex-col items-start rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors"
                        onClick={() => applyDraft(item)}
                      >
                        <span className="font-medium">{item.name}</span>
                        <span className="text-muted-foreground font-mono">
                          {drivers.find((entry) => entry.id === item.driver)?.label ?? item.driver}
                          {item.details.model ? ` ${String(item.details.model)}` : ''} · {item.host}
                          {item.port ? `:${item.port}` : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                )
              ) : null}
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('printer_dialog.name')}>
              <Input value={form.name} placeholder={driver?.label} onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))} />
            </Field>
            <Field label={t('printer_dialog.driver')}>
              <SelectField
                value={form.driver}
                onChange={changeDriver}
                options={drivers.map((item) => ({ value: item.id, label: item.label }))}
              />
            </Field>
          </div>

          {driverHint ? <p className="text-muted-foreground -mt-1 text-xs leading-relaxed">{driverHint}</p> : null}

          <div className="grid gap-3 sm:grid-cols-2">{primaryFields.map(renderField)}</div>

          {advancedFields.length > 0 ? (
            <div className="space-y-3">
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
                onClick={() => setShowAdvanced((value) => !value)}
              >
                <ChevronDown className={cn('size-3.5 transition-transform', showAdvanced && 'rotate-180')} />
                {t('printer_dialog.advanced')}
              </button>
              {showAdvanced ? <div className="grid gap-3 sm:grid-cols-2">{advancedFields.map(renderField)}</div> : null}
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
              <span className="space-y-0.5">
                <span className="block text-sm">{t('printer_dialog.auto_queue')}</span>
                <span className="text-muted-foreground block text-xs">{t('printer_dialog.auto_queue_hint')}</span>
              </span>
              <Switch checked={form.autoStartQueue} onCheckedChange={(checked) => setForm((prev) => ({ ...prev, autoStartQueue: checked }))} />
            </label>
            <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
              <span className="space-y-0.5">
                <span className="block text-sm">{t('printer_dialog.enabled')}</span>
                <span className="text-muted-foreground block text-xs">{t('printer_dialog.enabled_hint')}</span>
              </span>
              <Switch checked={form.enabled} onCheckedChange={(checked) => setForm((prev) => ({ ...prev, enabled: checked }))} />
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('printer_dialog.power')} hint={t('printer_dialog.power_hint')}>
              <Input
                type="number"
                min={0}
                max={10000}
                value={form.powerW}
                placeholder="150"
                onChange={(event) => setForm((prev) => ({ ...prev, powerW: event.target.value }))}
              />
            </Field>
            <Field label={t('printer_dialog.hourly_cost')} hint={t('printer_dialog.hourly_cost_hint')}>
              <Input
                type="number"
                min={0}
                value={form.hourlyCost}
                placeholder="0"
                onChange={(event) => setForm((prev) => ({ ...prev, hourlyCost: event.target.value }))}
              />
            </Field>
          </div>

          <Field label={t('printer_dialog.notes')}>
            <Textarea
              value={form.notes}
              rows={2}
              placeholder={t('printer_dialog.notes_placeholder')}
              onChange={(event) => setForm((prev) => ({ ...prev, notes: event.target.value }))}
            />
          </Field>

          {testResult ? (
            <div
              className={cn(
                'rounded-lg border p-2.5 text-xs',
                testResult.ok
                  ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300'
                  : 'border-destructive/40 bg-destructive/5 text-destructive',
              )}
            >
              {testResult.text}
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => void test()} disabled={busy !== null}>
            {busy === 'test' ? <Loader2 className="animate-spin" /> : <PlugZap />} {t('printer_dialog.test')}
          </Button>
          <Button onClick={() => void save()} disabled={busy !== null}>
            {busy === 'save' ? <Loader2 className="animate-spin" /> : null}
            {editing ? t('common.save') : t('printer_dialog.add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
