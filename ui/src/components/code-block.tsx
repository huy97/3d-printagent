import { CopyButton } from '@/components/copy-button'
import { cn } from '@/lib/utils'

export function CodeBlock({ code, title, className }: { code: string; title?: string; className?: string }) {
  return (
    <div className={cn('relative min-w-0', className)}>
      {title ? <div className="text-muted-foreground mb-1.5 text-xs font-medium">{title}</div> : null}
      <CopyButton value={code} className="absolute top-1.5 right-1.5 z-10" />
      <pre className="bg-muted/50 overflow-x-auto rounded-lg border p-3 pr-10 font-mono text-xs leading-relaxed">
        {code}
      </pre>
    </div>
  )
}
