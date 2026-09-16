import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { RotateCcw, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { SelectField } from '@/components/select-field'
import { Field } from '@/components/field'
import { reportError } from '@/hooks/use-agent'
import { useT } from '@/i18n'
import { api, type PromptDoc } from '@/lib/api'

/** Sửa thẳng prompt hệ thống của các tính năng AI; bỏ trống hoặc bấm khôi phục là quay về bản mặc định. */
export function PromptsCard({ local }: { local: boolean }) {
  const t = useT()
  const [prompts, setPrompts] = useState<PromptDoc[] | null>(null)
  const [dir, setDir] = useState('')
  const [name, setName] = useState('chat')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api
      .prompts()
      .then((result) => {
        setPrompts(result.prompts)
        setDir(result.dir)
        setName(result.prompts[0]?.name ?? 'chat')
        setText(result.prompts[0]?.text ?? '')
      })
      .catch(reportError)
  }, [])

  const current = prompts?.find((item) => item.name === name) ?? null

  const select = (value: string) => {
    setName(value)
    setText(prompts?.find((item) => item.name === value)?.text ?? '')
  }

  const apply = (saved: PromptDoc) => {
    setPrompts((prev) => (prev ?? []).map((item) => (item.name === saved.name ? saved : item)))
    setText(saved.text)
  }

  const save = async () => {
    setBusy(true)
    try {
      apply(await api.savePrompt(name, text))
      toast.success(t('settings.prompt_saved'))
    } catch (error) {
      reportError(error)
    } finally {
      setBusy(false)
    }
  }

  const reset = async () => {
    setBusy(true)
    try {
      apply(await api.resetPrompt(name))
      toast.success(t('settings.prompt_reset_done'))
    } catch (error) {
      reportError(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.prompts')}</CardTitle>
        <CardDescription>{t('settings.prompts_description')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <Field label={t('settings.prompt_name')} hint={t(`settings.prompt_${name}_hint` as never)}>
          <SelectField
            value={name}
            onChange={select}
            options={(prompts ?? []).map((item) => ({
              value: item.name,
              label: `${t(`settings.prompt_${item.name}` as never)}${item.custom ? ` · ${t('settings.prompt_custom')}` : ''}`,
            }))}
          />
        </Field>
        <Textarea
          value={text}
          rows={12}
          disabled={!local || !prompts || busy}
          className="font-mono text-xs"
          onChange={(event) => setText(event.target.value)}
        />
        <p className="text-muted-foreground text-xs">
          {local ? t('settings.prompts_hint', { dir }) : t('settings.prompts_local_only')}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!local || busy || !current?.custom}
            onClick={() => void reset()}
          >
            <RotateCcw className="size-4" />
            {t('settings.prompt_reset')}
          </Button>
          <Button type="button" size="sm" disabled={!local || busy || text.trim() === (current?.text ?? '')} onClick={() => void save()}>
            <Save className="size-4" />
            {t('settings.prompt_save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
