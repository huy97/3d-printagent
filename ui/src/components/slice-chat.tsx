import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ChevronDown, ChevronRight, Loader2, RotateCcw, Save, SendHorizontal, Trash2, Wrench } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useConfirm } from '@/components/confirm-dialog'
import { type SliceForm } from '@/components/slice-form'
import { reportError, useAgent } from '@/hooks/use-agent'
import { useT } from '@/i18n'
import {
  api,
  type SliceChat as SliceChatData,
  type SliceChatAction,
  type SliceChatMessage,
  type SliceOptions,
  type SlicePreset,
  type SliceVersion,
} from '@/lib/api'
import { formatDuration, formatTime } from '@/lib/format'
import { cn } from '@/lib/utils'

type Value = string | number | boolean

function actionParams(action: SliceChatAction) {
  const params: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(action.params)) params[key] = value ?? '?'
  if (action.tool === 'slice_preview') params.time = action.params.seconds ? formatDuration(Number(action.params.seconds)) : '?'
  return params
}

function AgentMessage({
  form,
  message,
  version,
  onRestore,
}: {
  form: SliceForm
  message: SliceChatMessage
  version: SliceVersion | undefined
  onRestore: (version: SliceVersion) => void
}) {
  const t = useT()
  const suggestion = message.suggestion
  const actions = message.actions ?? []
  const extra = Object.entries(suggestion?.extra ?? {})
  const profiles = Object.entries(suggestion?.profiles ?? {}) as ['process' | 'filament', string][]
  const hasChanges = Boolean(suggestion) && (Object.keys(suggestion?.options ?? {}).length > 0 || extra.length > 0 || profiles.length > 0)
  return (
    <div className="bg-muted/60 mr-6 space-y-1.5 rounded-lg px-2.5 py-2 text-xs">
      {actions.length > 0 ? (
        <div className="text-muted-foreground space-y-0.5">
          {actions.map((action, index) => (
            <div key={index} className={cn('flex items-center gap-1.5', action.error && 'text-destructive')}>
              <Wrench className="size-3 shrink-0" />
              <span className="truncate">
                {t(`slice.chat_tool_${action.tool}` as never, actionParams(action))}
                {action.error ? ` · ${t('slice.chat_tool_failed')}` : ''}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {message.text ? <p className="leading-relaxed whitespace-pre-wrap">{message.text}</p> : null}
      {suggestion && hasChanges ? (
        <div className="space-y-1 border-t pt-1.5">
          {profiles.map(([kind, name]) => (
            <div key={kind} className="flex items-baseline justify-between gap-2">
              <span className="text-muted-foreground">{t(`slice.${kind}`)}</span>
              <span className="truncate text-right font-medium" title={name}>
                {name}
              </span>
            </div>
          ))}
          {Object.entries(suggestion.options).map(([key, value]) => {
            const before = suggestion.before[key as keyof SliceOptions]
            return (
              <div key={key} className="flex items-baseline justify-between gap-2">
                <span className="text-muted-foreground">{form.optionLabel(key)}</span>
                <span className="flex items-baseline gap-1 text-right">
                  {before === undefined ? null : <span className="text-muted-foreground line-through">{form.valueLabel(key, before as Value)}</span>}
                  <span className="font-medium">{form.valueLabel(key, value as Value)}</span>
                </span>
              </div>
            )
          })}
          {extra.map(([key, value]) => (
            <div key={key} className="flex items-baseline justify-between gap-2">
              <span className="text-muted-foreground font-mono text-[11px]">{key}</span>
              <span className={cn('text-right', value === null ? 'text-muted-foreground italic' : 'font-medium')}>{value ?? t('slice.chat_extra_reset')}</span>
            </div>
          ))}
          {suggestion.reason && suggestion.reason !== message.text ? <p className="text-muted-foreground leading-relaxed">{suggestion.reason}</p> : null}
        </div>
      ) : null}
      {message.appliedVersion ? (
        <div className="flex items-center justify-end gap-2">
          <span className="text-muted-foreground">{t('slice.chat_applied', { number: message.appliedVersion.number })}</span>
          {version ? (
            <Button type="button" size="xs" variant="ghost" onClick={() => onRestore(version)}>
              <RotateCcw />
              {t('slice.version_restore')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** Chat with the agent about slice settings; history and versions are kept per source model. The docked variant fills the container height. */
export function SliceChat({ form, docked = false, className }: { form: SliceForm; docked?: boolean; className?: string }) {
  const t = useT()
  const { files } = useAgent()
  const { confirm, dialog } = useConfirm()
  const available = form.status?.advisor.available ?? false
  const fileId = form.rootId
  const [chat, setChat] = useState<SliceChatData | null>(null)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [showVersions, setShowVersions] = useState(false)
  const [showPresets, setShowPresets] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [savingPreset, setSavingPreset] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)

  // The agent saves another version after slicing, so reload to keep the list in sync.
  useEffect(() => {
    if (!fileId) return
    let stale = false
    api
      .sliceChat(fileId)
      .then((data) => !stale && setChat(data))
      .catch(reportError)
    return () => {
      stale = true
    }
  }, [fileId, form.latestId])

  const current = chat && chat.fileId === fileId ? chat : null
  const messages = current?.messages ?? []
  const versions = current?.versions ?? []
  const presets = current?.presets ?? []

  useEffect(() => {
    const element = scroller.current
    if (element) element.scrollTop = element.scrollHeight
  }, [messages.length, pending])

  const reload = async () => {
    if (fileId) setChat(await api.sliceChat(fileId))
  }

  const send = async () => {
    const message = draft.trim()
    if (!fileId || !message || pending || !form.printer || !form.machine) return
    setPending(message)
    setDraft('')
    try {
      const result = await api.sendSliceChat(fileId, { message, ...form.chatContext() })
      if (result.version) {
        form.restore(result.version)
        toast.success(t('slice.chat_auto_saved', { number: result.version.number }))
      }
      await reload()
    } catch (error) {
      setDraft(message)
      reportError(error)
    } finally {
      setPending(null)
    }
  }

  const saveVersion = async () => {
    if (!fileId) return
    try {
      const version = await api.saveSliceVersion(fileId, { source: 'manual', ...form.snapshot() })
      toast.success(t('slice.version_saved', { number: version.number }))
      setShowVersions(true)
      await reload()
    } catch (error) {
      reportError(error)
    }
  }

  const restore = (version: SliceVersion) => {
    form.restore(version)
    toast.success(t('slice.version_restored', { number: version.number }))
  }

  const writePreset = async (name: string) => {
    setSavingPreset(true)
    try {
      const preset = await api.saveSlicePreset({ name, ...form.snapshot() })
      toast.success(t('slice.preset_saved', { name: preset.name }))
      setPresetName('')
      await reload()
    } catch (error) {
      reportError(error)
    } finally {
      setSavingPreset(false)
    }
  }

  const savePreset = () => {
    const name = presetName.trim()
    if (!name || !form.machine || savingPreset) return
    const existing = presets.find((item) => item.name.toLowerCase() === name.toLowerCase())
    if (!existing) return void writePreset(name)
    confirm({
      title: t('slice.preset_overwrite_title', { name: existing.name }),
      description: t('slice.preset_overwrite_description'),
      confirmLabel: t('common.save'),
      onConfirm: () => writePreset(name),
    })
  }

  // Presets are shared across printers, so leave the selected machine profile alone.
  const applyPreset = (preset: SlicePreset) => {
    form.restore({ ...preset, machine: null, sliceId: null })
    toast.success(t('slice.preset_applied', { name: preset.name }))
  }

  const removePreset = (preset: SlicePreset) =>
    confirm({
      title: t('slice.preset_delete_title', { name: preset.name }),
      description: t('slice.preset_delete_description'),
      confirmLabel: t('common.delete'),
      destructive: true,
      onConfirm: async () => {
        try {
          await api.deleteSlicePreset(preset.id)
          await reload()
        } catch (error) {
          reportError(error)
        }
      },
    })

  const clear = () =>
    confirm({
      title: t('slice.chat_clear_title'),
      description: t('slice.chat_clear_description'),
      confirmLabel: t('common.delete'),
      destructive: true,
      onConfirm: async () => {
        if (!fileId) return
        try {
          await api.clearSliceChat(fileId)
          setChat((prev) => (prev ? { ...prev, messages: [] } : prev))
        } catch (error) {
          reportError(error)
        }
      },
    })

  const sliceName = (id: string | null) => (id ? (files.find((item) => item.id === id)?.name ?? null) : null)

  return (
    <div className={cn(docked ? 'bg-card flex min-h-0 flex-col gap-2 rounded-xl border p-4' : 'space-y-2 rounded-lg border p-3', className)}>
      {dialog}
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{t('slice.chat_title')}</p>
        {messages.length > 0 ? (
          <Button type="button" size="xs" variant="ghost" onClick={clear}>
            <Trash2 />
            {t('slice.chat_clear')}
          </Button>
        ) : null}
      </div>

      <div ref={scroller} className={cn('space-y-2 overflow-y-auto', docked ? 'min-h-0 flex-1' : 'max-h-96')}>
        {messages.length === 0 && !pending ? (
          <p className="text-muted-foreground text-xs">{available ? t('slice.chat_empty') : t('slice.advisor_off')}</p>
        ) : null}
        {messages.map((message) =>
          message.role === 'user' ? (
            <div key={message.id} className="bg-brand/10 ml-6 rounded-lg px-2.5 py-2 text-xs leading-relaxed whitespace-pre-wrap">
              {message.text}
            </div>
          ) : (
            <AgentMessage
              key={message.id}
              form={form}
              message={message}
              version={versions.find((item) => item.id === message.appliedVersion?.id)}
              onRestore={restore}
            />
          ),
        )}
        {pending ? (
          <>
            <div className="bg-brand/10 ml-6 rounded-lg px-2.5 py-2 text-xs leading-relaxed whitespace-pre-wrap">{pending}</div>
            <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <Loader2 className="size-3.5 animate-spin" />
              {t('slice.chat_thinking')}
            </div>
          </>
        ) : null}
      </div>

      {available ? (
        <div className="flex items-end gap-2">
          <Textarea
            value={draft}
            rows={2}
            placeholder={t('slice.chat_placeholder')}
            disabled={Boolean(pending)}
            className="min-h-0 resize-none text-sm"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void send()
              }
            }}
          />
          <Button type="button" size="icon" title={t('slice.chat_send')} disabled={!draft.trim() || Boolean(pending) || !form.machine} onClick={() => void send()}>
            {pending ? <Loader2 className="animate-spin" /> : <SendHorizontal />}
          </Button>
        </div>
      ) : null}

      <div className="border-t pt-2">
        <Button type="button" variant="ghost" size="xs" className="-ml-2" onClick={() => setShowPresets((prev) => !prev)}>
          {showPresets ? <ChevronDown /> : <ChevronRight />}
          {t('slice.presets', { count: presets.length })}
        </Button>
        {showPresets ? (
          <div className={cn('mt-1 space-y-1.5', docked && 'max-h-56 overflow-y-auto')}>
            {presets.length === 0 ? <p className="text-muted-foreground text-xs">{t('slice.presets_empty')}</p> : null}
            {presets.map((preset) => {
              const detail = [
                preset.description,
                preset.process,
                t('slice.version_changes', { count: Object.keys(preset.options).length + Object.keys(preset.extra).length }),
              ]
                .filter(Boolean)
                .join(' · ')
              return (
                <div key={preset.id} className="flex items-center gap-2 text-xs">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium" title={preset.name}>
                      {preset.name}
                    </div>
                    <div className="text-muted-foreground truncate" title={detail}>
                      {detail}
                    </div>
                  </div>
                  <Button type="button" size="xs" variant="outline" onClick={() => applyPreset(preset)}>
                    {t('slice.preset_apply')}
                  </Button>
                  <Button type="button" size="icon-xs" variant="ghost" aria-label={t('common.delete')} onClick={() => removePreset(preset)}>
                    <Trash2 />
                  </Button>
                </div>
              )
            })}
            <div className="flex gap-2 pt-1">
              <Input
                value={presetName}
                maxLength={60}
                placeholder={t('slice.preset_name_placeholder')}
                className="h-7 text-xs"
                onChange={(event) => setPresetName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    savePreset()
                  }
                }}
              />
              <Button type="button" size="xs" variant="secondary" className="h-7 shrink-0" disabled={!presetName.trim() || savingPreset || !form.machine} onClick={savePreset}>
                {savingPreset ? <Loader2 className="animate-spin" /> : <Save />}
                {t('slice.preset_save')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="border-t pt-2">
        <div className="flex items-center justify-between gap-2">
          <Button type="button" variant="ghost" size="xs" className="-ml-2" onClick={() => setShowVersions((prev) => !prev)}>
            {showVersions ? <ChevronDown /> : <ChevronRight />}
            {t('slice.versions', { count: versions.length })}
          </Button>
          <Button type="button" variant="ghost" size="xs" disabled={!fileId || !form.machine} onClick={() => void saveVersion()}>
            <Save />
            {t('slice.version_save')}
          </Button>
        </div>
        {showVersions ? (
          <div className={cn('mt-1 space-y-1.5', docked && 'max-h-48 overflow-y-auto')}>
            {versions.length === 0 ? <p className="text-muted-foreground text-xs">{t('slice.versions_empty')}</p> : null}
            {versions
              .slice()
              .reverse()
              .map((version) => {
                const name = sliceName(version.sliceId)
                const changes = Object.keys(version.options).length + Object.keys(version.extra).length
                return (
                  <div key={version.id} className="flex items-center gap-2 text-xs">
                    <span className="bg-muted shrink-0 rounded px-1.5 py-0.5 font-mono tabular-nums">v{version.number}</span>
                    <span className="min-w-0 flex-1 truncate" title={name ?? undefined}>
                      {[t(`slice.version_source_${version.source}` as never), formatTime(version.createdAt), t('slice.version_changes', { count: changes }), name]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                    <Button type="button" size="xs" variant="outline" onClick={() => restore(version)}>
                      <RotateCcw />
                      {t('slice.version_restore')}
                    </Button>
                  </div>
                )
              })}
          </div>
        ) : null}
      </div>
    </div>
  )
}
