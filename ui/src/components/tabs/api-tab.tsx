import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { BookOpen, ExternalLink, Eye, KeyRound, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { CodeBlock } from '@/components/code-block'
import { CopyButton } from '@/components/copy-button'
import { useConfirm } from '@/components/confirm-dialog'
import { useAgent, reportError } from '@/hooks/use-agent'
import { useT, type MessageKey } from '@/i18n'
import { api, apiKeyStore, type ApiKey } from '@/lib/api'
import { formatTime } from '@/lib/format'

const AI_DOCS: { path: string; hintKey: MessageKey }[] = [
  { path: '/.well-known/3d-printagent.json', hintKey: 'api.doc.discovery' },
  { path: '/openapi.json', hintKey: 'api.doc.openapi' },
  { path: '/llms.txt', hintKey: 'api.doc.llms' },
]

export function ApiTab() {
  const t = useT()
  const { tunnel, config, printers, saveApiKey } = useAgent()
  const { confirm, dialog } = useConfirm()
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [name, setName] = useState('')
  const [created, setCreated] = useState<ApiKey | null>(null)
  const [busy, setBusy] = useState(false)
  const [localKey, setLocalKey] = useState(apiKeyStore.get())
  const local = config?.local ?? false

  const load = async () => {
    try {
      setKeys((await api.apiKeys()).apiKeys)
    } catch (error) {
      reportError(error)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const create = async () => {
    if (!name.trim()) {
      toast.error(t('api.key_name_required'))
      return
    }
    setBusy(true)
    try {
      setCreated(await api.createApiKey(name.trim()))
      setName('')
      await load()
    } catch (error) {
      reportError(error)
    } finally {
      setBusy(false)
    }
  }

  const reveal = async (id: string) => {
    try {
      setCreated(await api.revealApiKey(id))
    } catch (error) {
      reportError(error)
    }
  }

  const remove = (item: ApiKey) =>
    confirm({
      title: t('api.delete_key_title', { name: item.name }),
      description: t('api.delete_key_description'),
      confirmLabel: t('common.delete'),
      destructive: true,
      onConfirm: async () => {
        try {
          await api.deleteApiKey(item.id)
          await load()
          toast.success(t('api.key_deleted'))
        } catch (error) {
          reportError(error)
        }
      },
    })

  const base = tunnel?.url ?? location.origin
  const key = localKey || '<API_KEY>'
  const printerId = printers[0]?.id ?? '<PRINTER_ID>'

  return (
    <div className="space-y-4">
      {dialog}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4" /> API key
          </CardTitle>
          <CardDescription>{t('api.key_description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {local ? (
            <div className="flex flex-wrap gap-2">
              <Input
                value={name}
                placeholder={t('api.key_name_placeholder')}
                className="sm:w-72"
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void create()
                }}
              />
              <Button onClick={() => void create()} disabled={busy}>
                <Plus /> {t('api.create_key')}
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">{t('api.local_only')}</p>
          )}

          {created?.key ? (
            <Alert>
              <AlertTitle>{t('api.key_of', { name: created.name })}</AlertTitle>
              <AlertDescription className="block space-y-2">
                <CodeBlock code={created.key} />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    saveApiKey(created.key as string)
                    setLocalKey(created.key as string)
                    toast.success(t('api.key_applied'))
                  }}
                >
                  {t('api.use_for_ui')}
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('api.col.name')}</TableHead>
                  <TableHead>{t('api.col.key')}</TableHead>
                  <TableHead>{t('api.col.created')}</TableHead>
                  <TableHead>{t('api.col.last_used')}</TableHead>
                  <TableHead className="text-right">{t('common.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-medium">{item.name}</TableCell>
                    <TableCell className="font-mono text-xs">{item.preview ?? '***'}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{formatTime(item.createdAt)}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{formatTime(item.lastUsedAt)}</TableCell>
                    <TableCell className="text-right">
                      {local ? (
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="icon" title={t('api.reveal_key')} onClick={() => void reveal(item.id)}>
                            <Eye />
                          </Button>
                          <Button variant="ghost" size="icon" title={t('common.delete')} className="text-destructive" onClick={() => remove(item)}>
                            <Trash2 />
                          </Button>
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
                {keys.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-muted-foreground text-center text-sm">
                      {t('api.keys_empty')}
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div className="w-full space-y-1.5 sm:w-96">
              <span className="text-muted-foreground text-xs">{t('api.ui_key')}</span>
              <Input value={localKey} placeholder={t('api.ui_key_placeholder')} onChange={(event) => setLocalKey(event.target.value)} />
            </div>
            <Button
              variant="outline"
              disabled={!localKey.trim()}
              onClick={() => {
                saveApiKey(localKey)
                toast.success(t('api.key_applied'))
              }}
            >
              {t('common.save')}
            </Button>
            {localKey ? <CopyButton value={localKey} variant="outline" /> : null}
            <Button
              variant="ghost"
              onClick={() => {
                apiKeyStore.clear()
                setLocalKey('')
                toast.success(t('api.ui_key_cleared'))
              }}
            >
              {t('api.clear_ui_key')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BookOpen className="size-4" /> {t('api.ai_docs')}
          </CardTitle>
          <CardDescription>{t('api.ai_docs_description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {AI_DOCS.map((doc) => (
            <div key={doc.path} className="flex items-center gap-2 rounded-lg border p-3">
              <div className="min-w-0 flex-1">
                <code className="block truncate font-mono text-xs">{base + doc.path}</code>
                <p className="text-muted-foreground mt-0.5 text-xs">{t(doc.hintKey)}</p>
              </div>
              <CopyButton value={base + doc.path} className="shrink-0" />
              <Button variant="ghost" size="icon" title={t('api.open_new_tab')} onClick={() => window.open(base + doc.path, '_blank')}>
                <ExternalLink />
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('api.quickstart')}</CardTitle>
          <CardDescription className="flex items-center gap-1">
            <span className="min-w-0 truncate">{t('api.base_url', { url: base })}</span>
            <CopyButton value={base} className="size-6 shrink-0" />
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-2">
          <CodeBlock
            title={t('api.snippet.printers')}
            code={`curl ${base}/api/printers \\
  -H "x-api-key: ${key}"`}
          />
          <CodeBlock
            title={t('api.snippet.print')}
            code={`curl -X POST ${base}/api/print \\
  -H "x-api-key: ${key}" \\
  -F "printerId=${printerId}" \\
  -F "mode=now" -F "confirmBedClear=true" \\
  -F "file=@benchy.gcode"`}
          />
          <CodeBlock
            title={t('api.snippet.command')}
            code={`curl -X POST ${base}/api/printers/${printerId}/command \\
  -H "x-api-key: ${key}" \\
  -H "content-type: application/json" \\
  -d '{"action":"temperature","params":{"heater":"bed","target":60}}'`}
          />
          <CodeBlock
            title={t('api.snippet.snapshot')}
            code={`curl ${base}/api/printers/${printerId}/snapshot \\
  -H "x-api-key: ${key}" -o snapshot.jpg`}
          />
          <CodeBlock
            title="WebSocket"
            code={`const socket = new WebSocket("${base.replace(/^http/, 'ws')}/ws?apiKey=${key}")
socket.onopen = () => socket.send(JSON.stringify({
  type: "subscribe", payload: { events: ["printer", "job"] }
}))
socket.onmessage = (event) => console.log(JSON.parse(event.data))`}
          />
          <CodeBlock
            title="MCP (Streamable HTTP)"
            code={`{
  "mcpServers": {
    "3d-printagent": {
      "type": "http",
      "url": "${base}/mcp",
      "headers": { "x-api-key": "${key}" }
    }
  }
}`}
          />
          <CodeBlock
            title="MCP (stdio)"
            className="lg:col-span-2"
            code={`npx @hyydev/3d-printagent mcp
# ${t('api.snippet.stdio_hint')}
PRINTAGENT3D_URL=${base} PRINTAGENT3D_API_KEY=${key} npx @hyydev/3d-printagent mcp`}
          />
        </CardContent>
      </Card>
    </div>
  )
}
