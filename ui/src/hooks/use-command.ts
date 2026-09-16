import { useState } from 'react'
import { toast } from 'sonner'
import { reportError } from '@/hooks/use-agent'
import { useT } from '@/i18n'
import { api, type CommandAction, type Printer } from '@/lib/api'

export function useCommand(printer: Printer) {
  const t = useT()
  const [pending, setPending] = useState<string | null>(null)
  const run = async (action: CommandAction, params: Record<string, unknown> = {}, success?: string) => {
    setPending(action)
    try {
      const result = await api.command(printer.id, action, params)
      if (success) toast.success(success)
      return result
    } catch (error) {
      reportError(error, t('common.error'))
      return null
    } finally {
      setPending(null)
    }
  }
  return { run, pending }
}
