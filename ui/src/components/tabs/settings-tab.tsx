import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { PlayCircle, Power, Save, Send, ShieldAlert, StopCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SelectField } from '@/components/select-field'
import { CopyButton } from '@/components/copy-button'
import { Field } from '@/components/field'
import { StatusBadge } from '@/components/status-badge'
import { LogView } from '@/components/log-view'
import { PromptsCard } from '@/components/prompts-card'
import { useAgent, reportError } from '@/hooks/use-agent'
import { LOCALE_LABELS, LOCALES, useT } from '@/i18n'
import {
  AI_AUTH_TYPES,
  NOTIFY_EVENTS,
  api,
  type AgentConfig,
  type AiAuthType,
  type NotifyEvent,
  type ServiceStatus,
  type SlicerStatus,
} from '@/lib/api'

const WATCH_ACTIONS = ['notify', 'pause'] as const

const splitList = (value: string) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

function SwitchField({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string
  hint?: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <Field label={label} hint={hint}>
      <div className="flex h-9 items-center">
        <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
      </div>
    </Field>
  )
}

export function SettingsTab() {
  const t = useT()
  const { config, logs, refreshConfig, refreshAll } = useAgent()
  const [draft, setDraft] = useState<AgentConfig | null>(config)
  const [source, setSource] = useState(config)
  const [busy, setBusy] = useState(false)
  const [service, setService] = useState<ServiceStatus | null>(null)
  const [slicer, setSlicer] = useState<SlicerStatus | null>(null)
  const [testing, setTesting] = useState(false)

  if (config !== source) {
    setSource(config)
    setDraft(config)
  }

  const loadService = useCallback(async () => {
    try {
      setService(await api.service())
    } catch (error) {
      reportError(error)
    }
  }, [])

  useEffect(() => {
    void loadService()
    api.slicer().then(setSlicer).catch(() => setSlicer(null))
  }, [loadService])

  if (!draft || !config) return <p className="text-muted-foreground text-sm">{t('common.loading')}</p>

  const local = config.local
  const dirty = JSON.stringify(draft) !== JSON.stringify(config)
  const patch = <K extends keyof AgentConfig>(section: K, values: Partial<AgentConfig[K]>) =>
    setDraft((prev) => (prev ? { ...prev, [section]: { ...(prev[section] as object), ...values } } : prev))
  const num = (value: string, fallback: number) => (value === '' ? fallback : Number(value))

  const persist = async () => {
    const body: Record<string, unknown> = {
      agent: { name: draft.agent.name, locale: draft.agent.locale },
      files: { maxUploadMb: Number(draft.files.maxUploadMb) },
      queue: { keepJobs: Number(draft.queue.keepJobs) },
      costs: {
        currency: draft.costs.currency,
        electricityPerKwh: Number(draft.costs.electricityPerKwh),
        defaultPowerW: Number(draft.costs.defaultPowerW),
        defaultPricePerKg: Number(draft.costs.defaultPricePerKg),
      },
      monitoring: {
        pollIntervalMs: Number(draft.monitoring.pollIntervalMs),
        historyDays: Number(draft.monitoring.historyDays),
      },
      watch: {
        enabled: draft.watch.enabled,
        intervalMin: Number(draft.watch.intervalMin),
        firstLayer: draft.watch.firstLayer,
        minConfidence: Number(draft.watch.minConfidence),
        onDetect: draft.watch.onDetect,
        autoDiagnose: draft.watch.autoDiagnose,
      },
      notify: {
        telegram: {
          enabled: draft.notify.telegram.enabled,
          chatId: draft.notify.telegram.chatId || null,
          events: draft.notify.telegram.events,
          includeSnapshot: draft.notify.telegram.includeSnapshot,
          // The bot token is a secret, so the server only accepts it from the machine running the agent.
          ...(local ? { botToken: draft.notify.telegram.botToken || null } : {}),
        },
      },
    }
    // Local-only fields sent from another machine are ignored by the server, so only send them from the agent host.
    if (local) {
      Object.assign(body, {
        server: { host: draft.server.host, port: Number(draft.server.port), corsOrigins: draft.server.corsOrigins },
        slicer: {
          binPath: draft.slicer.binPath || null,
          profilesDir: draft.slicer.profilesDir || null,
          userProfilesDir: draft.slicer.userProfilesDir || null,
          timeoutSec: Number(draft.slicer.timeoutSec),
        },
        ai: {
          authType: draft.ai.authType,
          apiKey: draft.ai.apiKey || null,
          model: draft.ai.model,
          baseUrl: draft.ai.baseUrl,
        },
        auth: { enabled: draft.auth.enabled, allowLocalhostWithoutKey: draft.auth.allowLocalhostWithoutKey },
        files: { ...draft.files, maxUploadMb: Number(draft.files.maxUploadMb) },
        safety: {
          ...draft.safety,
          maxNozzleTemp: Number(draft.safety.maxNozzleTemp),
          maxBedTemp: Number(draft.safety.maxBedTemp),
          maxChamberTemp: Number(draft.safety.maxChamberTemp),
          maxJogMm: Number(draft.safety.maxJogMm),
        },
      })
    }
    const result = await api.saveSettings(body)
    if (result.rejectedFields?.length) toast.warning(t('settings.rejected_fields', { fields: result.rejectedFields.join(', ') }))
    const restartNeeded = local && (draft.server.host !== config.server.host || Number(draft.server.port) !== config.server.port)
    await refreshConfig()
    await refreshAll()
    return { result, restartNeeded }
  }

  const save = async () => {
    setBusy(true)
    try {
      const { result, restartNeeded } = await persist()
      if (!result.rejectedFields?.length) toast.success(t('settings.saved'))
      if (restartNeeded) toast.info(t('settings.restart_needed'))
    } catch (error) {
      reportError(error)
    } finally {
      setBusy(false)
    }
  }

  const toggleEvent = (event: NotifyEvent, on: boolean) => {
    const events = draft.notify.telegram.events.filter((item) => item !== event)
    patch('notify', { telegram: { ...draft.notify.telegram, events: on ? [...events, event] : events } })
  }

  const testNotify = async () => {
    setTesting(true)
    try {
      // Save first, then send, so the token and chat id just entered are the ones being tested.
      if (dirty) await persist()
      const result = await api.testNotify({ chatId: draft.notify.telegram.chatId })
      toast.success(t('settings.notify_test_sent', { chat: String(result.chatId ?? '') }))
    } catch (error) {
      reportError(error)
    } finally {
      setTesting(false)
    }
  }

  const toggleService = async (action: 'install' | 'uninstall') => {
    setBusy(true)
    try {
      setService(await api.setService(action))
      toast.success(action === 'install' ? t('settings.service_installed') : t('settings.service_removed'))
    } catch (error) {
      reportError(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      {!local ? (
        <div className="border-warn/40 bg-warn/10 text-warn flex items-start gap-2 rounded-lg border p-3 text-xs">
          <ShieldAlert className="mt-px size-3.5 shrink-0" />
          {t('settings.remote_notice')}
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.agent_title')}</CardTitle>
          <CardDescription>{t('settings.agent_description')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t('settings.agent_name')}>
            <Input value={draft.agent.name} onChange={(event) => patch('agent', { name: event.target.value })} />
          </Field>
          <Field label={t('settings.agent_locale')} hint={t('settings.agent_locale_hint')}>
            <SelectField
              value={draft.agent.locale ?? 'vi'}
              onChange={(value) => patch('agent', { locale: value })}
              options={LOCALES.map((value) => ({ value, label: LOCALE_LABELS[value] }))}
            />
          </Field>
          <Field label={t('settings.host')} hint={local ? t('settings.host_hint') : t('settings.local_only')}>
            <Input value={draft.server.host} disabled={!local} onChange={(event) => patch('server', { host: event.target.value })} />
          </Field>
          <Field label={t('settings.port')} hint={local ? undefined : t('settings.local_only')}>
            <Input
              type="number"
              value={draft.server.port}
              disabled={!local}
              onChange={(event) => patch('server', { port: num(event.target.value, 7790) })}
            />
          </Field>
          <Field label={t('settings.cors')} hint={t('settings.cors_hint')} className="sm:col-span-2">
            <Input
              value={draft.server.corsOrigins.join(', ')}
              disabled={!local}
              placeholder="https://app.example.com"
              onChange={(event) => patch('server', { corsOrigins: splitList(event.target.value) })}
            />
          </Field>
          <Field label={t('settings.agent_id')} className="sm:col-span-2">
            <div className="text-muted-foreground flex h-9 items-center gap-1 font-mono text-xs">
              <span className="truncate">{draft.agent.id}</span>
              <CopyButton value={draft.agent.id} className="size-6 shrink-0" />
            </div>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.security')}</CardTitle>
          <CardDescription>{t('settings.security_description')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SwitchField
            label={t('settings.require_key')}
            hint={t('settings.require_key_hint')}
            checked={draft.auth.enabled}
            disabled={!local}
            onChange={(checked) => patch('auth', { enabled: checked })}
          />
          <SwitchField
            label={t('settings.skip_key_localhost')}
            hint={t('settings.skip_key_localhost_hint')}
            checked={draft.auth.allowLocalhostWithoutKey}
            disabled={!local}
            onChange={(checked) => patch('auth', { allowLocalhostWithoutKey: checked })}
          />
          <SwitchField
            label={t('settings.allow_url')}
            checked={draft.files.allowRemoteUrl}
            disabled={!local}
            onChange={(checked) => patch('files', { allowRemoteUrl: checked })}
          />
          <SwitchField
            label={t('settings.allow_private_url')}
            hint={t('settings.allow_private_url_hint')}
            checked={draft.files.allowPrivateNetworkUrl}
            disabled={!local}
            onChange={(checked) => patch('files', { allowPrivateNetworkUrl: checked })}
          />
          <SwitchField
            label={t('settings.allow_local_path')}
            hint={t('settings.allow_local_path_hint')}
            checked={draft.files.allowLocalFilePath}
            disabled={!local}
            onChange={(checked) => patch('files', { allowLocalFilePath: checked })}
          />
          <Field label={t('settings.allowed_roots')} className="sm:col-span-2">
            <Input
              value={draft.files.allowedFileRoots.join(', ')}
              disabled={!local}
              placeholder="/Users/me/3d-models"
              onChange={(event) => patch('files', { allowedFileRoots: splitList(event.target.value) })}
            />
          </Field>
          <Field label={t('settings.max_upload')}>
            <Input
              type="number"
              min={1}
              value={draft.files.maxUploadMb}
              onChange={(event) => patch('files', { maxUploadMb: num(event.target.value, 1024) })}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.safety')}</CardTitle>
          <CardDescription>{t('settings.safety_description')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t('settings.max_nozzle')}>
            <Input
              type="number"
              value={draft.safety.maxNozzleTemp}
              disabled={!local}
              onChange={(event) => patch('safety', { maxNozzleTemp: num(event.target.value, 300) })}
            />
          </Field>
          <Field label={t('settings.max_bed')}>
            <Input
              type="number"
              value={draft.safety.maxBedTemp}
              disabled={!local}
              onChange={(event) => patch('safety', { maxBedTemp: num(event.target.value, 120) })}
            />
          </Field>
          <Field label={t('settings.max_chamber')}>
            <Input
              type="number"
              value={draft.safety.maxChamberTemp}
              disabled={!local}
              onChange={(event) => patch('safety', { maxChamberTemp: num(event.target.value, 65) })}
            />
          </Field>
          <Field label={t('settings.max_jog')}>
            <Input
              type="number"
              value={draft.safety.maxJogMm}
              disabled={!local}
              onChange={(event) => patch('safety', { maxJogMm: num(event.target.value, 100) })}
            />
          </Field>
          <SwitchField
            label={t('settings.allow_gcode')}
            hint={t('settings.allow_gcode_hint')}
            checked={draft.safety.allowGcode}
            disabled={!local}
            onChange={(checked) => patch('safety', { allowGcode: checked })}
          />
          <Field label={t('settings.blocked_gcodes')} hint={t('settings.blocked_gcodes_hint')} className="sm:col-span-2 lg:col-span-3">
            <Input
              value={draft.safety.blockedGcodes.join(', ')}
              disabled={!local}
              placeholder="M502, M997"
              onChange={(event) => patch('safety', { blockedGcodes: splitList(event.target.value.toUpperCase()) })}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.slicer')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <Field label={t('settings.slicer_bin')} hint={t('settings.slicer_bin_hint')} className="sm:col-span-2">
            <Input
              value={draft.slicer.binPath ?? ''}
              disabled={!local}
              placeholder={slicer?.bin ?? '/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer'}
              onChange={(event) => patch('slicer', { binPath: event.target.value })}
            />
          </Field>
          <Field label={t('settings.slicer_profiles')} hint={t('settings.slicer_profiles_hint')}>
            <Input
              value={draft.slicer.profilesDir ?? ''}
              disabled={!local}
              placeholder={slicer?.profilesDir ?? ''}
              onChange={(event) => patch('slicer', { profilesDir: event.target.value })}
            />
          </Field>
          <Field label={t('settings.slicer_user_profiles')} hint={t('settings.slicer_user_profiles_hint')}>
            <Input
              value={draft.slicer.userProfilesDir ?? ''}
              disabled={!local}
              placeholder={slicer?.userProfilesDir ?? ''}
              onChange={(event) => patch('slicer', { userProfilesDir: event.target.value })}
            />
          </Field>
          <Field label={t('settings.slicer_timeout')}>
            <Input
              type="number"
              min={30}
              max={7200}
              value={draft.slicer.timeoutSec}
              disabled={!local}
              onChange={(event) => patch('slicer', { timeoutSec: num(event.target.value, 900) })}
            />
          </Field>
          <p className="text-muted-foreground text-xs sm:col-span-2">
            {slicer?.available
              ? t('settings.slicer_status', { kind: slicer.kind === 'orca' ? 'OrcaSlicer' : 'BambuStudio', bin: slicer.bin ?? '', count: slicer.machines })
              : t('settings.slicer_missing')}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.costs')}</CardTitle>
          <CardDescription>{t('settings.costs_description')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <Field label={t('settings.costs_currency')}>
            <Input value={draft.costs.currency} maxLength={8} onChange={(event) => patch('costs', { currency: event.target.value.toUpperCase() })} />
          </Field>
          <Field label={t('settings.costs_electricity')}>
            <Input
              type="number"
              min={0}
              value={draft.costs.electricityPerKwh}
              onChange={(event) => patch('costs', { electricityPerKwh: num(event.target.value, 0) })}
            />
          </Field>
          <Field label={t('settings.costs_power')} hint={t('settings.costs_power_hint')}>
            <Input
              type="number"
              min={0}
              max={10000}
              value={draft.costs.defaultPowerW}
              onChange={(event) => patch('costs', { defaultPowerW: num(event.target.value, 0) })}
            />
          </Field>
          <Field label={t('settings.costs_price')} hint={t('settings.costs_price_hint')}>
            <Input
              type="number"
              min={0}
              value={draft.costs.defaultPricePerKg}
              onChange={(event) => patch('costs', { defaultPricePerKg: num(event.target.value, 0) })}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.ai')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <Field label={t('settings.ai_auth_type')} hint={t('settings.ai_auth_type_hint')}>
            <SelectField
              value={draft.ai.authType}
              onChange={(value) => patch('ai', { authType: value as AiAuthType })}
              options={AI_AUTH_TYPES.map((value) => ({ value, label: t(`settings.ai_auth_${value}` as never) }))}
            />
          </Field>
          <Field label={t(`settings.ai_auth_${draft.ai.authType}` as never)} hint={t('settings.ai_key_hint')}>
            <Input
              type="password"
              value={draft.ai.apiKey ?? ''}
              disabled={!local}
              placeholder={draft.ai.authType === 'api_key' ? 'sk-ant-...' : undefined}
              onChange={(event) => patch('ai', { apiKey: event.target.value })}
            />
          </Field>
          <Field label={t('settings.ai_model')} hint={t('settings.ai_model_hint')}>
            <Input value={draft.ai.model} disabled={!local} onChange={(event) => patch('ai', { model: event.target.value })} />
          </Field>
          <Field label={t('settings.ai_base_url')} hint={t('settings.ai_base_url_hint')}>
            <Input value={draft.ai.baseUrl} disabled={!local} onChange={(event) => patch('ai', { baseUrl: event.target.value })} />
          </Field>
        </CardContent>
      </Card>

      <PromptsCard local={local} />

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.watch')}</CardTitle>
          <CardDescription>{t('settings.watch_description')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <SwitchField
            label={t('settings.watch_enabled')}
            hint={t('settings.watch_enabled_hint')}
            checked={draft.watch.enabled}
            onChange={(enabled) => patch('watch', { enabled })}
          />
          <SwitchField
            label={t('settings.watch_first_layer')}
            hint={t('settings.watch_first_layer_hint')}
            checked={draft.watch.firstLayer}
            onChange={(firstLayer) => patch('watch', { firstLayer })}
          />
          <Field label={t('settings.watch_interval')} hint={t('settings.watch_interval_hint')}>
            <Input
              type="number"
              min={1}
              max={120}
              value={draft.watch.intervalMin}
              onChange={(event) => patch('watch', { intervalMin: num(event.target.value, 10) })}
            />
          </Field>
          <Field label={t('settings.watch_action')} hint={t('settings.watch_action_hint')}>
            <SelectField
              value={draft.watch.onDetect}
              onChange={(value) => patch('watch', { onDetect: value as 'notify' | 'pause' })}
              options={WATCH_ACTIONS.map((value) => ({ value, label: t(`settings.watch_action_${value}` as never) }))}
            />
          </Field>
          <Field label={t('settings.watch_confidence')} hint={t('settings.watch_confidence_hint')}>
            <Input
              type="number"
              min={30}
              max={100}
              value={Math.round(draft.watch.minConfidence * 100)}
              onChange={(event) => patch('watch', { minConfidence: Math.min(1, Math.max(0.3, num(event.target.value, 75) / 100)) })}
            />
          </Field>
          <SwitchField
            label={t('settings.watch_diagnose')}
            hint={t('settings.watch_diagnose_hint')}
            checked={draft.watch.autoDiagnose}
            onChange={(autoDiagnose) => patch('watch', { autoDiagnose })}
          />
          <p className="text-muted-foreground text-xs sm:col-span-2">
            {draft.ai.apiKey ? t('settings.watch_cost') : t('settings.watch_needs_key')}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.notify')}</CardTitle>
          <CardDescription>{t('settings.notify_description')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <SwitchField
            label={t('settings.notify_enabled')}
            hint={t('settings.notify_enabled_hint')}
            checked={draft.notify.telegram.enabled}
            onChange={(enabled) => patch('notify', { telegram: { ...draft.notify.telegram, enabled } })}
          />
          <SwitchField
            label={t('settings.notify_snapshot')}
            hint={t('settings.notify_snapshot_hint')}
            checked={draft.notify.telegram.includeSnapshot}
            onChange={(includeSnapshot) => patch('notify', { telegram: { ...draft.notify.telegram, includeSnapshot } })}
          />
          <Field label={t('settings.notify_token')} hint={local ? t('settings.notify_token_hint') : t('settings.local_only')}>
            <Input
              type="password"
              value={draft.notify.telegram.botToken ?? ''}
              disabled={!local}
              placeholder="123456789:AA..."
              onChange={(event) => patch('notify', { telegram: { ...draft.notify.telegram, botToken: event.target.value } })}
            />
          </Field>
          <Field label={t('settings.notify_chat')} hint={t('settings.notify_chat_hint')}>
            <Input
              value={draft.notify.telegram.chatId ?? ''}
              placeholder="-1001234567890"
              onChange={(event) => patch('notify', { telegram: { ...draft.notify.telegram, chatId: event.target.value } })}
            />
          </Field>
          <Field label={t('settings.notify_events')} hint={t('settings.notify_events_hint')} className="sm:col-span-2">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              {NOTIFY_EVENTS.map((event) => (
                <label key={event} className="flex items-center gap-2 text-sm">
                  <Switch checked={draft.notify.telegram.events.includes(event)} onCheckedChange={(on) => toggleEvent(event, on)} />
                  {t(`settings.notify_event_${event}` as never)}
                </label>
              ))}
            </div>
          </Field>
          <div className="sm:col-span-2">
            <Button variant="outline" disabled={testing || !draft.notify.telegram.chatId} onClick={() => void testNotify()}>
              <Send /> {t('settings.notify_test')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.monitoring')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t('settings.poll_interval')} hint={t('settings.poll_interval_hint')}>
            <Input
              type="number"
              min={500}
              step={500}
              value={draft.monitoring.pollIntervalMs}
              onChange={(event) => patch('monitoring', { pollIntervalMs: num(event.target.value, 2000) })}
            />
          </Field>
          <Field label={t('settings.history_days')} hint={t('settings.history_days_hint')}>
            <Input
              type="number"
              min={1}
              max={3650}
              value={draft.monitoring.historyDays}
              onChange={(event) => patch('monitoring', { historyDays: num(event.target.value, 30) })}
            />
          </Field>
          <Field label={t('settings.keep_jobs')}>
            <Input
              type="number"
              min={20}
              value={draft.queue.keepJobs}
              onChange={(event) => patch('queue', { keepJobs: num(event.target.value, 500) })}
            />
          </Field>
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-3">
        {dirty ? <span className="text-warn text-xs">{t('common.unsaved')}</span> : null}
        <Button onClick={() => void save()} disabled={busy || !dirty}>
          <Save /> {t('common.save')}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Power className="size-4" /> {t('settings.service_title')}
          </CardTitle>
          <CardDescription>
            {service?.supported === false
              ? t('settings.service_unsupported')
              : t('settings.service_description', { manager: service?.manager ?? '-' })}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <StatusBadge status={service?.installed ? (service.running ? 'running' : 'stopped') : 'not_installed'} />
          {service?.unit ? (
            <span className="text-muted-foreground flex min-w-0 items-center gap-1 font-mono text-xs">
              <span className="min-w-0 truncate">{service.unit}</span>
              <CopyButton value={service.unit} className="size-6 shrink-0" />
            </span>
          ) : null}
          <div className="ml-auto flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy || !local || service?.supported === false || service?.installed}
              onClick={() => void toggleService('install')}
            >
              <PlayCircle /> {t('settings.service_install')}
            </Button>
            <Button variant="ghost" disabled={busy || !local || !service?.installed} onClick={() => void toggleService('uninstall')}>
              <StopCircle /> {t('settings.service_uninstall')}
            </Button>
          </div>
          {!local ? <p className="text-warn w-full text-xs">{t('settings.local_only')}</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.logs')}</CardTitle>
        </CardHeader>
        <CardContent>
          <LogView logs={logs} />
        </CardContent>
      </Card>
    </div>
  )
}
