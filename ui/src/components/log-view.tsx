import { useEffect, useRef } from 'react'
import { useT } from '@/i18n'
import type { LogEntry } from '@/lib/api'
import { formatClock } from '@/lib/format'
import { cn } from '@/lib/utils'

const LEVEL_CLASS: Record<string, string> = {
  error: 'text-red-400',
  warn: 'text-amber-300',
  info: 'text-sky-300',
  debug: 'text-zinc-500',
}

export function LogView({ logs, className }: { logs: LogEntry[]; className?: string }) {
  const t = useT()
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60
    if (nearBottom) box.scrollTop = box.scrollHeight
  }, [logs])

  return (
    <div
      ref={boxRef}
      className={cn(
        'h-64 overflow-y-auto rounded-lg bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-300',
        className,
      )}
    >
      {logs.length === 0 ? <div className="text-zinc-600">{t('common.no_logs')}</div> : null}
      {logs.map((entry, index) => (
        <div key={`${entry.time}-${index}`} className={cn('whitespace-pre-wrap', LEVEL_CLASS[entry.level])}>
          <span className="text-zinc-600">{formatClock(entry.time)} </span>
          <span className="text-zinc-500">[{entry.scope}] </span>
          {entry.message}
        </div>
      ))}
    </div>
  )
}
