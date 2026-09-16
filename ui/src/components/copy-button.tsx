import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { useT } from '@/i18n'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

async function writeClipboard(value: string) {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    // Trình duyệt chặn clipboard khi không chạy trên HTTPS hoặc localhost.
    const area = document.createElement('textarea')
    area.value = value
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  }
}

export function CopyButton({
  value,
  label,
  className,
  variant = 'ghost',
  size = 'icon',
  children,
}: {
  value: string
  label?: string
  className?: string
  variant?: 'ghost' | 'outline' | 'secondary'
  size?: 'icon' | 'sm'
  children?: React.ReactNode
}) {
  const t = useT()
  const title = label ?? t('common.copy')
  const [copied, setCopied] = useState(false)

  const copy = async (event: React.MouseEvent) => {
    event.stopPropagation()
    if (!value) return
    if (!(await writeClipboard(value))) {
      toast.error(t('common.copy_failed'))
      return
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const Icon = copied ? Check : Copy

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={cn('text-muted-foreground', size === 'icon' && 'size-7', className)}
      onClick={copy}
      title={title}
      aria-label={title}
    >
      <Icon className={cn('size-3.5', copied && 'text-ok')} />
      {children}
    </Button>
  )
}

export function CopyRow({
  value,
  label,
  className,
  mono = true,
}: {
  value: string
  label?: string
  className?: string
  mono?: boolean
}) {
  return (
    <div className={cn('group/copy flex min-w-0 items-center gap-1', className)}>
      <span className={cn('min-w-0 flex-1 truncate', mono && 'font-mono text-xs')}>{value}</span>
      <CopyButton
        value={value}
        label={label}
        className="size-6 shrink-0 opacity-0 transition-opacity group-hover/copy:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
      />
    </div>
  )
}
