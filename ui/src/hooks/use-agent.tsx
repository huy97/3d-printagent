import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import {
  api,
  ApiError,
  apiKeyStore,
  type AgentConfig,
  type DriverInfo,
  type Health,
  type Job,
  type LibraryFile,
  type LogEntry,
  type Printer,
  type PrinterStatus,
  type TunnelStatus,
} from '@/lib/api'
import { connectAgentSocket } from '@/lib/ws'
import { getLocale, translate } from '@/i18n/locale'

const ACTIVE_JOB = new Set(['uploading', 'starting', 'printing', 'paused'])
const JOB_LIMIT = 150

interface AgentState {
  health: Health | null
  config: AgentConfig | null
  drivers: DriverInfo[]
  printers: Printer[]
  files: LibraryFile[]
  jobs: Job[]
  queuedCount: number
  activeCount: number
  logs: LogEntry[]
  tunnel: TunnelStatus | null
  wsConnected: boolean
  wsReason?: string
  needsKey: boolean
  loading: boolean
  refreshAll: () => Promise<void>
  refreshPrinters: () => Promise<void>
  refreshFiles: () => Promise<void>
  refreshJobs: () => Promise<void>
  refreshConfig: () => Promise<void>
  setTunnel: (status: TunnelStatus) => void
  upsertPrinter: (printer: Printer) => void
  upsertFile: (file: LibraryFile) => void
  upsertJob: (job: Job) => void
  saveApiKey: (key: string) => void
}

const AgentContext = createContext<AgentState | null>(null)

export function reportError(error: unknown, fallback?: string) {
  const message = error instanceof Error ? error.message : (fallback ?? translate(getLocale(), 'common.error'))
  toast.error(message)
}

function upsert<T extends { id: string }>(list: T[], item: T, { prepend = true, limit }: { prepend?: boolean; limit?: number } = {}) {
  const index = list.findIndex((entry) => entry.id === item.id)
  if (index >= 0) {
    const next = [...list]
    next[index] = item
    return next
  }
  const next = prepend ? [item, ...list] : [...list, item]
  return limit ? next.slice(0, limit) : next
}

export function AgentProvider({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<Health | null>(null)
  const [config, setConfig] = useState<AgentConfig | null>(null)
  const [drivers, setDrivers] = useState<DriverInfo[]>([])
  const [printers, setPrinters] = useState<Printer[]>([])
  const [files, setFiles] = useState<LibraryFile[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [tunnel, setTunnel] = useState<TunnelStatus | null>(null)
  const [wsConnected, setWsConnected] = useState(false)
  const [wsReason, setWsReason] = useState<string>()
  const [needsKey, setNeedsKey] = useState(false)
  const [loading, setLoading] = useState(true)

  const refreshPrinters = useCallback(async () => {
    setPrinters((await api.printers()).printers)
  }, [])

  const refreshFiles = useCallback(async () => {
    setFiles((await api.files()).files)
  }, [])

  const refreshJobs = useCallback(async () => {
    setJobs((await api.jobs({ limit: JOB_LIMIT })).jobs)
  }, [])

  const refreshConfig = useCallback(async () => {
    setConfig(await api.settings())
  }, [])

  const refreshAll = useCallback(async () => {
    setLoading(true)
    try {
      setHealth(await api.health())
      await Promise.all([
        refreshConfig(),
        refreshPrinters(),
        refreshFiles(),
        refreshJobs(),
        api.drivers().then((result) => setDrivers(result.drivers)),
        api.logs().then((result) => setLogs(result.logs)),
        api.tunnel().then((result) => setTunnel(result.status)),
      ])
      setNeedsKey(false)
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        if (apiKeyStore.get()) toast.error(translate(getLocale(), 'agent.key_rejected'))
        setNeedsKey(true)
      } else reportError(error, translate(getLocale(), 'agent.connect_failed'))
    } finally {
      setLoading(false)
    }
  }, [refreshConfig, refreshFiles, refreshJobs, refreshPrinters])

  useEffect(() => {
    void refreshAll()
  }, [refreshAll])

  useEffect(() => {
    let firstWelcome = true
    return connectAgentSocket({
      onStatus: (connected, reason) => {
        setWsConnected(connected)
        setWsReason(reason)
        if (reason === 'auth_required') setNeedsKey(true)
      },
      onWelcome: (payload) => {
        const snapshot = payload as { printers?: Printer[] }
        if (snapshot.printers) setPrinters(snapshot.printers)
        // Mất kết nối rồi nối lại thì có thể đã lỡ sự kiện job/file, tải lại cho khớp.
        if (!firstWelcome) {
          void refreshJobs().catch(() => {})
          void refreshFiles().catch(() => {})
        }
        firstWelcome = false
      },
      onEvent: (event, payload) => {
        if (event === 'printer.status') {
          const { printerId, status } = payload as { printerId: string; status: PrinterStatus }
          setPrinters((current) => current.map((item) => (item.id === printerId ? { ...item, status } : item)))
          return
        }
        if (event === 'printer.changed') {
          const { event: kind, printer } = payload as { event: string; printer: Printer }
          setPrinters((current) =>
            kind === 'removed' ? current.filter((item) => item.id !== printer.id) : upsert(current, printer, { prepend: false }),
          )
          return
        }
        if (event === 'log') {
          setLogs((current) => [...current.slice(-300), payload as LogEntry])
          return
        }
        if (event === 'job.cleared') {
          void refreshJobs().catch(() => {})
          return
        }
        if (event === 'job.removed') {
          const { id } = payload as { id: string }
          setJobs((current) => current.filter((item) => item.id !== id))
          return
        }
        if (event.startsWith('job.')) {
          setJobs((current) => upsert(current, payload as Job, { limit: JOB_LIMIT }))
          return
        }
        if (event === 'file.removed') {
          const { id } = payload as { id: string }
          setFiles((current) => current.filter((item) => item.id !== id))
          return
        }
        if (event.startsWith('file.')) {
          setFiles((current) => upsert(current, payload as LibraryFile))
          return
        }
        if (event === 'tunnel.changed') setTunnel(payload as TunnelStatus)
      },
    })
  }, [refreshFiles, refreshJobs])

  useEffect(() => {
    const timer = window.setInterval(() => {
      api
        .health()
        .then(setHealth)
        .catch(() => {})
    }, 15000)
    return () => window.clearInterval(timer)
  }, [])

  const saveApiKey = useCallback(
    (key: string) => {
      apiKeyStore.set(key.trim())
      setNeedsKey(false)
      void refreshAll()
    },
    [refreshAll],
  )

  const upsertPrinter = useCallback((printer: Printer) => setPrinters((current) => upsert(current, printer, { prepend: false })), [])
  const upsertFile = useCallback((file: LibraryFile) => setFiles((current) => upsert(current, file)), [])
  const upsertJob = useCallback((job: Job) => setJobs((current) => upsert(current, job, { limit: JOB_LIMIT })), [])

  const queuedCount = jobs.filter((job) => job.status === 'queued').length
  const activeCount = jobs.filter((job) => ACTIVE_JOB.has(job.status)).length

  const value = useMemo<AgentState>(
    () => ({
      health,
      config,
      drivers,
      printers,
      files,
      jobs,
      queuedCount,
      activeCount,
      logs,
      tunnel,
      wsConnected,
      wsReason,
      needsKey,
      loading,
      refreshAll,
      refreshPrinters,
      refreshFiles,
      refreshJobs,
      refreshConfig,
      setTunnel,
      upsertPrinter,
      upsertFile,
      upsertJob,
      saveApiKey,
    }),
    [
      health,
      config,
      drivers,
      printers,
      files,
      jobs,
      queuedCount,
      activeCount,
      logs,
      tunnel,
      wsConnected,
      wsReason,
      needsKey,
      loading,
      refreshAll,
      refreshPrinters,
      refreshFiles,
      refreshJobs,
      refreshConfig,
      upsertPrinter,
      upsertFile,
      upsertJob,
      saveApiKey,
    ],
  )

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>
}

export function useAgent() {
  const context = useContext(AgentContext)
  if (!context) throw new Error('useAgent must be used within AgentProvider')
  return context
}

export function usePrinter(id: string | null | undefined) {
  const { printers } = useAgent()
  return printers.find((printer) => printer.id === id) ?? null
}
