import { cn } from '@/lib/utils'

export function ProgressBar({
  value,
  className,
  tone = 'brand',
}: {
  value: number | null | undefined
  className?: string
  tone?: 'brand' | 'info' | 'muted'
}) {
  const percent = Math.max(0, Math.min(100, Number(value) || 0))
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      className={cn('h-1.5 w-full overflow-hidden rounded-full', tone === 'brand' ? 'bg-brand/15' : 'bg-muted', className)}
    >
      <div
        className={cn(
          'h-full rounded-full transition-[width] duration-500',
          tone === 'brand' ? 'bg-brand' : tone === 'info' ? 'bg-sky-500' : 'bg-muted-foreground',
        )}
        style={{ width: `${percent}%` }}
      />
    </div>
  )
}
