import { Languages } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LOCALE_LABELS, LOCALE_SHORT, useI18n, type Locale } from '@/i18n'
import { cn } from '@/lib/utils'

export function LocaleSwitch({ className }: { className?: string }) {
  const { locale, setLocale, t } = useI18n()
  const next: Locale = locale === 'vi' ? 'en' : 'vi'
  const title = t('header.language_switch', { language: LOCALE_LABELS[next] })

  return (
    <Button
      variant="outline"
      size="sm"
      className={cn('gap-1.5 px-2.5', className)}
      onClick={() => setLocale(next)}
      title={title}
      aria-label={title}
    >
      <Languages className="size-3.5" />
      <span className="font-mono text-[11px] font-medium">{LOCALE_SHORT[locale]}</span>
    </Button>
  )
}
