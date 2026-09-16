import type { ReactNode } from 'react'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

export function Field({
  label,
  hint,
  className,
  action,
  children,
}: {
  label: string
  hint?: string
  className?: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex min-h-6 items-center justify-between gap-2">
        <Label className="text-xs text-muted-foreground">{label}</Label>
        {action}
      </div>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}
