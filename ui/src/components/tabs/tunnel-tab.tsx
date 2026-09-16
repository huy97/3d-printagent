import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { CheckCircle2, Globe, Play, ShieldAlert, ShieldCheck, Square, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SelectField } from '@/components/select-field'
import { Field } from '@/components/field'
import { StatusBadge } from '@/components/status-badge'
import { CodeBlock } from '@/components/code-block'
import { CopyButton, CopyRow } from '@/components/copy-button'
import { useAgent, reportError } from '@/hooks/use-agent'
import { useT } from '@/i18n'
import { api, type TunnelInfo } from '@/lib/api'
import { cn } from '@/lib/utils'

const EMPTY_FORM = {
  provider: 'none',
  autoStart: false,
  cloudflareBin: 'cloudflared',
  cloudflareToken: '',
  cloudflareHostname: '',
  ngrokBin: 'ngrok',
  ngrokAuthtoken: '',
  ngrokDomain: '',
  ngrokRegion: '',
}

function ClearSecretButton({ onClear }: { onClear: () => void }) {
  const t = useT()
  return (
    <button type="button" className="text-muted-foreground hover:text-foreground text-xs underline" onClick={onClear}>
      {t('tunnel.token_clear')}
    </button>
  )
}

export function TunnelTab() {
  const t = useT()
  const { tunnel, setTunnel, config } = useAgent()
  const [info, setInfo] = useState<TunnelInfo | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [busy, setBusy] = useState(false)
  const [clearSecret, setClearSecret] = useState(false)
  const savedToken = info?.config.cloudflare.token === '***' && !clearSecret
  const savedAuthtoken = info?.config.ngrok.authtoken === '***' && !clearSecret
  const local = config?.local ?? false

  const load = async () => {
    try {
      const result = await api.tunnel()
      setInfo(result)
      setTunnel(result.status)
      setForm({
        provider: result.config.provider ?? 'none',
        autoStart: Boolean(result.config.autoStart),
        cloudflareBin: result.config.cloudflare.binPath ?? 'cloudflared',
        cloudflareToken: result.config.cloudflare.token === '***' ? '' : (result.config.cloudflare.token ?? ''),
        cloudflareHostname: result.config.cloudflare.hostname ?? '',
        ngrokBin: result.config.ngrok.binPath ?? 'ngrok',
        ngrokAuthtoken: result.config.ngrok.authtoken === '***' ? '' : (result.config.ngrok.authtoken ?? ''),
        ngrokDomain: result.config.ngrok.domain ?? '',
        ngrokRegion: result.config.ngrok.region ?? '',
      })
    } catch (error) {
      reportError(error)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const update = (patch: Partial<typeof EMPTY_FORM>) => setForm((prev) => ({ ...prev, ...patch }))

  const persist = async () => {
    await api.saveSettings({
      tunnel: {
        provider: form.provider,
        autoStart: form.autoStart,
        cloudflare: {
          ...(local ? { binPath: form.cloudflareBin } : {}),
          token: form.cloudflareToken || (savedToken ? '***' : null),
          hostname: form.cloudflareHostname || null,
        },
        ngrok: {
          ...(local ? { binPath: form.ngrokBin } : {}),
          authtoken: form.ngrokAuthtoken || (savedAuthtoken ? '***' : null),
          domain: form.ngrokDomain || null,
          region: form.ngrokRegion || null,
        },
      },
    })
    setClearSecret(false)
  }

  const save = async () => {
    setBusy(true)
    try {
      await persist()
      toast.success(t('tunnel.saved'))
      await load()
    } catch (error) {
      reportError(error)
    } finally {
      setBusy(false)
    }
  }

  const control = async (kind: 'start' | 'stop') => {
    setBusy(true)
    try {
      // Starting the tunnel always uses the config currently in the form, so the old config is never used by mistake.
      if (kind === 'start') await persist()
      const status = kind === 'start' ? await api.startTunnel(form.provider) : await api.stopTunnel()
      setTunnel(status)
      toast.success(kind === 'start' ? t('tunnel.starting') : t('tunnel.stopped'))
      await load()
    } catch (error) {
      reportError(error)
    } finally {
      setBusy(false)
    }
  }

  const dirty = info
    ? form.provider !== (info.config.provider ?? 'none') ||
      form.autoStart !== Boolean(info.config.autoStart) ||
      form.cloudflareBin !== (info.config.cloudflare.binPath ?? 'cloudflared') ||
      form.cloudflareHostname !== (info.config.cloudflare.hostname ?? '') ||
      form.ngrokBin !== (info.config.ngrok.binPath ?? 'ngrok') ||
      form.ngrokDomain !== (info.config.ngrok.domain ?? '') ||
      form.ngrokRegion !== (info.config.ngrok.region ?? '') ||
      form.cloudflareToken !== '' ||
      form.ngrokAuthtoken !== '' ||
      clearSecret
    : false

  const exposure = info?.exposureIssue ?? null
  const status = tunnel ?? info?.status ?? null
  const running = status?.status === 'running' || status?.status === 'starting'
  const providers = [
    { value: 'none', label: t('tunnel.provider_none') },
    { value: 'cloudflare', label: 'Cloudflare Tunnel' },
    { value: 'ngrok', label: 'ngrok' },
  ]

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="min-w-0 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('tunnel.title')}</CardTitle>
            <CardDescription>{t('tunnel.description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('tunnel.provider')}>
                <SelectField value={form.provider} onChange={(value) => update({ provider: value })} options={providers} />
              </Field>
              <Field label={t('tunnel.autostart')} hint={t('tunnel.autostart_hint')}>
                <div className="flex h-9 items-center">
                  <Switch checked={form.autoStart} onCheckedChange={(checked) => update({ autoStart: checked })} />
                </div>
              </Field>
            </div>

            {form.provider === 'cloudflare' ? (
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label={t('tunnel.cloudflare_bin')} hint={local ? undefined : t('settings.local_only')}>
                  <Input value={form.cloudflareBin} disabled={!local} onChange={(event) => update({ cloudflareBin: event.target.value })} />
                </Field>
                <Field
                  label={t('tunnel.cloudflare_token')}
                  hint={savedToken ? t('tunnel.token_saved') : t('tunnel.cloudflare_token_hint')}
                  action={savedToken ? <ClearSecretButton onClear={() => setClearSecret(true)} /> : null}
                >
                  <Input
                    type="password"
                    placeholder={savedToken ? '••••••••' : undefined}
                    value={form.cloudflareToken}
                    onChange={(event) => update({ cloudflareToken: event.target.value })}
                  />
                </Field>
                <Field
                  label={t('tunnel.cloudflare_hostname')}
                  hint={form.cloudflareHostname && !form.cloudflareToken && !savedToken ? t('tunnel.hostname_needs_token') : undefined}
                >
                  <Input
                    value={form.cloudflareHostname}
                    placeholder="print3d.example.com"
                    onChange={(event) => update({ cloudflareHostname: event.target.value })}
                  />
                </Field>
              </div>
            ) : null}

            {form.provider === 'ngrok' ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label={t('tunnel.ngrok_bin')} hint={local ? undefined : t('settings.local_only')}>
                  <Input value={form.ngrokBin} disabled={!local} onChange={(event) => update({ ngrokBin: event.target.value })} />
                </Field>
                <Field
                  label={t('tunnel.ngrok_authtoken')}
                  hint={savedAuthtoken ? t('tunnel.token_saved') : undefined}
                  action={savedAuthtoken ? <ClearSecretButton onClear={() => setClearSecret(true)} /> : null}
                >
                  <Input
                    type="password"
                    placeholder={savedAuthtoken ? '••••••••' : undefined}
                    value={form.ngrokAuthtoken}
                    onChange={(event) => update({ ngrokAuthtoken: event.target.value })}
                  />
                </Field>
                <Field label={t('tunnel.ngrok_domain')}>
                  <Input value={form.ngrokDomain} onChange={(event) => update({ ngrokDomain: event.target.value })} />
                </Field>
                <Field label={t('tunnel.ngrok_region')}>
                  <Input value={form.ngrokRegion} placeholder="ap" onChange={(event) => update({ ngrokRegion: event.target.value })} />
                </Field>
              </div>
            ) : null}

            <div
              className={cn(
                'flex items-start gap-2 rounded-lg border p-2.5 text-xs',
                exposure ? 'border-destructive/40 bg-destructive/5 text-destructive' : 'border-ok/30 bg-ok/5 text-ok',
              )}
            >
              {exposure ? <ShieldAlert className="mt-px size-3.5 shrink-0" /> : <ShieldCheck className="mt-px size-3.5 shrink-0" />}
              <span>
                {exposure === 'auth_disabled'
                  ? t('tunnel.protection_auth_off')
                  : exposure === 'no_api_key'
                    ? t('tunnel.protection_no_key')
                    : t('tunnel.protection_ok', { count: config?.auth.apiKeys.length ?? 0 })}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => void save()} disabled={busy}>
                {t('common.save')}
              </Button>
              <Button variant="outline" onClick={() => void control('start')} disabled={busy || form.provider === 'none' || Boolean(exposure)}>
                <Play /> {running ? t('tunnel.restart') : t('tunnel.start')}
              </Button>
              <Button variant="outline" onClick={() => void control('stop')} disabled={busy || !running}>
                <Square /> {t('tunnel.stop')}
              </Button>
              {dirty ? <span className="text-warn text-xs">{t('common.unsaved')}</span> : null}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>{t('tunnel.logs')}</CardTitle>
            <CopyButton value={(status?.logs ?? []).join('\n')} label={t('tunnel.copy_logs')} />
          </CardHeader>
          <CardContent>
            <ScrollArea className="bg-muted/40 h-55 rounded-lg border p-3">
              <pre className="font-mono text-xs whitespace-pre-wrap">{(status?.logs ?? []).join('\n') || t('tunnel.logs_empty')}</pre>
            </ScrollArea>
          </CardContent>
        </Card>
      </div>

      <div className="min-w-0 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Globe className="size-4" /> {t('tunnel.status')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t('tunnel.status')}</span>
              <StatusBadge status={status?.status} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t('tunnel.provider')}</span>
              <span>{providers.find((item) => item.value === (status?.provider ?? 'none'))?.label ?? status?.provider}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">PID</span>
              {status?.pid ? (
                <CopyRow value={String(status.pid)} label={t('common.copy')} className="max-w-32 justify-end" />
              ) : (
                <span className="font-mono text-xs">-</span>
              )}
            </div>
            {status?.error ? (
              <div className="text-destructive flex items-start gap-1 text-xs">
                <span className="min-w-0 flex-1">{status.error}</span>
                <CopyButton value={status.error} className="size-6 shrink-0" />
              </div>
            ) : null}
            {status?.warning ? (
              <div className="border-warn/40 bg-warn/10 text-warn flex items-start gap-1 rounded-lg border p-2 text-xs">
                <span className="min-w-0 flex-1">{status.warning}</span>
                <CopyButton value={status.warning} className="size-6 shrink-0" />
              </div>
            ) : null}
            {status?.url ? (
              <div className="space-y-1.5">
                <span className="text-muted-foreground text-xs">{t('tunnel.public_url')}</span>
                <CodeBlock code={status.url} />
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                  <a href={status.url} target="_blank" rel="noreferrer" className="text-brand underline">
                    {t('tunnel.open_ui')}
                  </a>
                  <a href={`${status.url}/api/health`} target="_blank" rel="noreferrer" className="text-brand underline">
                    {t('tunnel.open_health')}
                  </a>
                </div>
                <p className="text-muted-foreground text-xs">{t('tunnel.public_hint')}</p>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('tunnel.binaries')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {Object.entries(info?.binaries ?? {}).map(([name, item]) => (
              <div key={name} className="space-y-1 rounded-lg border p-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {item.installed ? <CheckCircle2 className="text-ok size-4" /> : <XCircle className="text-muted-foreground size-4" />}
                  {name}
                  {item.version ? <span className="text-muted-foreground truncate text-xs">{item.version}</span> : null}
                </div>
                {item.installed ? (
                  <div className="text-muted-foreground flex items-center gap-1">
                    <p className="min-w-0 flex-1 truncate font-mono text-xs">{item.path}</p>
                    <CopyButton value={item.path ?? ''} className="size-6 shrink-0" />
                  </div>
                ) : (
                  <CodeBlock code={item.install} />
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
