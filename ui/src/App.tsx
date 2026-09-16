import { useEffect, useRef, useState } from 'react'
import { BrowserRouter, NavLink, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { ArrowLeftRight, Box, Cylinder, Files, Globe, LayoutGrid, Layers, PanelLeftClose, PanelLeftOpen, Printer, RefreshCw, Settings, Wifi, WifiOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Toaster } from '@/components/ui/sonner'
import { AgentProvider, useAgent } from '@/hooks/use-agent'
import { OverviewTab } from '@/components/tabs/overview-tab'
import { PrintersTab } from '@/components/tabs/printers-tab'
import { FilesTab } from '@/components/tabs/files-tab'
import { FileEditor } from '@/components/tabs/file-editor'
import { JobsTab } from '@/components/tabs/jobs-tab'
import { FilamentTab } from '@/components/tabs/filament-tab'
import { TunnelTab } from '@/components/tabs/tunnel-tab'
import { ApiTab } from '@/components/tabs/api-tab'
import { SettingsTab } from '@/components/tabs/settings-tab'
import { LocaleSwitch } from '@/components/locale-switch'
import { I18nProvider, useI18n, useT, type MessageKey } from '@/i18n'
import { formatUptime } from '@/lib/format'
import { cn } from '@/lib/utils'

const TABS = [
  { value: 'overview', labelKey: 'nav.overview', icon: LayoutGrid },
  { value: 'printers', labelKey: 'nav.printers', icon: Printer },
  { value: 'files', labelKey: 'nav.files', icon: Files },
  { value: 'jobs', labelKey: 'nav.jobs', icon: Layers },
  { value: 'filament', labelKey: 'nav.filament', icon: Cylinder },
  { value: 'tunnel', labelKey: 'nav.tunnel', icon: Globe },
  { value: 'api', labelKey: 'nav.api', icon: ArrowLeftRight },
  { value: 'settings', labelKey: 'nav.settings', icon: Settings },
] satisfies { value: string; labelKey: MessageKey; icon: typeof LayoutGrid }[]

function KeyDialog() {
  const t = useT()
  const { needsKey, saveApiKey } = useAgent()
  const [value, setValue] = useState('')

  return (
    <Dialog open={needsKey}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('key_dialog.title')}</DialogTitle>
          <DialogDescription>{t('key_dialog.description')}</DialogDescription>
        </DialogHeader>
        <Input
          value={value}
          placeholder="p3d_..."
          autoFocus
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && value.trim()) saveApiKey(value)
          }}
        />
        <DialogFooter>
          <Button onClick={() => saveApiKey(value)} disabled={!value.trim()}>
            {t('key_dialog.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const SIDEBAR_STORAGE = 'printagent3d.sidebar-collapsed'

function readCollapsed() {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE) === '1'
  } catch {
    return false
  }
}

function NavItem({ to, label, icon: Icon, badge, collapsed }: { to: string; label: string; icon: typeof LayoutGrid; badge?: number; collapsed: boolean }) {
  return (
    <NavLink
      to={to}
      title={collapsed ? label : undefined}
      className={({ isActive }) =>
        cn(
          'relative flex h-8.5 w-full items-center gap-2.5 rounded-lg text-sm transition-colors',
          collapsed ? 'justify-center' : 'px-2.5',
          isActive ? 'bg-accent text-foreground font-medium' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive ? <span className="bg-brand absolute inset-y-1.5 left-0 w-0.5 rounded-full" /> : null}
          <Icon className={cn('size-4.5 shrink-0', isActive && 'text-brand')} />
          {collapsed ? (
            badge ? <span className={cn('absolute top-1.5 right-1.5 size-1.5 rounded-full', isActive ? 'bg-brand' : 'bg-muted-foreground')} /> : null
          ) : (
            <span className="truncate">{label}</span>
          )}
          {!collapsed && badge ? (
            <span
              className={cn(
                'ml-auto inline-flex h-4.5 min-w-5 items-center justify-center rounded-full px-1.5 font-mono text-[11px]',
                isActive ? 'bg-brand/15 text-brand' : 'bg-muted text-muted-foreground',
              )}
            >
              {badge}
            </span>
          ) : null}
        </>
      )}
    </NavLink>
  )
}

function Shell() {
  const { t } = useI18n()
  const { health, printers, files, queuedCount, activeCount, tunnel, wsConnected, wsReason, loading, refreshAll } = useAgent()
  const { pathname } = useLocation()
  const segment = pathname.split('/').filter(Boolean)[0]
  const current = TABS.find((tab) => tab.value === segment) ?? TABS[0]
  const online = printers.filter((printer) => printer.status.online).length
  const counts: Record<string, number | undefined> = {
    printers: printers.length || undefined,
    files: files.filter((file) => !file.sourceId).length || undefined,
    jobs: queuedCount + activeCount || undefined,
  }
  const reasonText = wsReason === 'auth_required' ? t('ws.auth_required') : wsReason
  const navRef = useRef<HTMLElement>(null)
  const [collapsed, setCollapsed] = useState(readCollapsed)

  const toggleSidebar = () => {
    const next = !collapsed
    setCollapsed(next)
    try {
      localStorage.setItem(SIDEBAR_STORAGE, next ? '1' : '0')
    } catch {
      // Storage blocked by the browser, so remember it for this session only
    }
  }

  useEffect(() => {
    navRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [pathname])

  return (
    <div className="bg-background text-foreground flex h-dvh overflow-hidden">
      <aside className={cn('bg-card hidden shrink-0 flex-col overflow-y-auto border-r lg:flex', collapsed ? 'w-15 p-2.5' : 'w-59 p-3.5')}>
        <div className={cn('flex items-center gap-2.5 pt-1 pb-4', collapsed ? 'justify-center' : 'px-1.5')}>
          <div className="bg-brand text-brand-foreground flex size-8 shrink-0 items-center justify-center rounded-lg" title={collapsed ? (health?.agent?.name ?? '3D PrintAgent') : undefined}>
            <Box className="size-4.5" />
          </div>
          {collapsed ? null : (
            <div className="min-w-0">
              <div className="truncate text-sm leading-tight font-semibold">{health?.agent?.name ?? '3D PrintAgent'}</div>
              <div className="text-muted-foreground font-mono text-[11px]">v{health?.version ?? '0.1.0'}</div>
            </div>
          )}
        </div>

        <nav className="flex flex-col gap-0.5 pb-4">
          {TABS.map((tab) => (
            <NavItem key={tab.value} to={`/${tab.value}`} label={t(tab.labelKey)} icon={tab.icon} badge={counts[tab.value]} collapsed={collapsed} />
          ))}
        </nav>

        {collapsed ? (
          <div className="mt-auto flex justify-center py-2" title={wsConnected ? t('header.agent_running') : t('header.disconnected')}>
            <span className={cn('size-1.75 rounded-full', wsConnected ? 'bg-ok ring-ok/20 ring-3' : 'bg-muted-foreground')} />
          </div>
        ) : (
        <div className="mt-auto flex flex-col gap-2.5 rounded-[10px] border p-3">
          <div className="flex items-center gap-2">
            <span className={cn('size-1.75 rounded-full', wsConnected ? 'bg-ok ring-ok/20 ring-3' : 'bg-muted-foreground')} />
            <span className="text-xs font-medium">{wsConnected ? t('header.agent_running') : t('header.disconnected')}</span>
          </div>
          <dl className="text-muted-foreground flex flex-col gap-1 text-[11px]">
            <div className="flex justify-between gap-2">
              <dt>{t('header.uptime')}</dt>
              <dd className="text-foreground/80 font-mono">{formatUptime(health?.uptimeSeconds)}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>{t('header.printers_online')}</dt>
              <dd className="text-foreground/80 font-mono">
                {online}/{printers.length}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>{t('header.tunnel')}</dt>
              <dd className={cn('font-mono', tunnel?.status === 'running' ? 'text-ok' : 'text-foreground/80')}>
                {tunnel?.status === 'running' ? t('status.running') : t('status.stopped')}
              </dd>
            </div>
          </dl>
        </div>
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="bg-card z-10 shrink-0 border-b">
          <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 sm:px-6">
            <Button
              variant="ghost"
              size="icon-sm"
              className="-ml-2 hidden lg:inline-flex"
              title={collapsed ? t('nav.expand') : t('nav.collapse')}
              aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
              onClick={toggleSidebar}
            >
              {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            </Button>
            <div className="min-w-0">
              <h1 className="text-[15px] leading-tight font-semibold tracking-tight">{t(current.labelKey)}</h1>
              <p className="text-muted-foreground truncate text-xs">
                {health?.platform ?? ''}
                {health?.node ? ` · Node ${health.node}` : ''}
              </p>
            </div>

            <div className="ml-auto flex items-center gap-2.5">
              <span
                className={cn(
                  'flex h-8 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium',
                  wsConnected ? 'bg-ok/10 text-ok' : 'bg-muted text-muted-foreground',
                )}
                title={reasonText ?? (wsConnected ? t('ws.connected') : t('ws.disconnected'))}
              >
                {wsConnected ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
                <span className="hidden sm:inline">{wsConnected ? t('header.realtime') : (reasonText ?? t('header.disconnected'))}</span>
              </span>
              <Button variant="outline" size="sm" disabled={loading} onClick={() => void refreshAll()}>
                <RefreshCw className={loading ? 'animate-spin' : ''} />
                <span className="hidden sm:inline">{t('common.refresh')}</span>
              </Button>
              <LocaleSwitch />
            </div>
          </div>

          <nav ref={navRef} className="flex gap-1 overflow-x-auto px-4 pb-2 sm:px-6 lg:hidden">
            {TABS.map((tab) => (
              <NavLink
                key={tab.value}
                to={`/${tab.value}`}
                className={({ isActive }) =>
                  cn(
                    'flex h-8 shrink-0 items-center rounded-full px-3 text-sm transition-colors',
                    isActive ? 'bg-brand text-brand-foreground font-medium' : 'text-muted-foreground hover:bg-accent',
                  )
                }
              >
                {t(tab.labelKey)}
              </NavLink>
            ))}
          </nav>
        </header>

        <main className="min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          <Outlet />
        </main>
      </div>

      <KeyDialog />
      <Toaster position="top-right" richColors />
    </div>
  )
}

export default function App() {
  return (
    <I18nProvider>
      <AgentProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<Shell />}>
              <Route index element={<Navigate to="/overview" replace />} />
              <Route path="overview" element={<OverviewTab />} />
              <Route path="printers" element={<PrintersTab />} />
              <Route path="printers/:printerId" element={<PrintersTab />} />
              <Route path="files" element={<FilesTab />} />
              <Route path="files/:fileId" element={<FileEditor />} />
              <Route path="jobs" element={<JobsTab />} />
              <Route path="filament" element={<FilamentTab />} />
              <Route path="tunnel" element={<TunnelTab />} />
              <Route path="api" element={<ApiTab />} />
              <Route path="settings" element={<SettingsTab />} />
              <Route path="*" element={<Navigate to="/overview" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AgentProvider>
    </I18nProvider>
  )
}
