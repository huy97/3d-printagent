import { useCallback, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useT } from '@/i18n'

type ConfirmRequest = {
  title: string
  description?: string
  confirmLabel?: string
  destructive?: boolean
  onConfirm: () => void | Promise<void>
}

export function useConfirm(): { confirm: (request: ConfirmRequest) => void; dialog: ReactNode } {
  const t = useT()
  const [request, setRequest] = useState<ConfirmRequest | null>(null)
  const [busy, setBusy] = useState(false)

  const confirm = useCallback((next: ConfirmRequest) => setRequest(next), [])

  const accept = async () => {
    if (!request) return
    setBusy(true)
    try {
      await request.onConfirm()
      setRequest(null)
    } finally {
      setBusy(false)
    }
  }

  const dialog = (
    <Dialog open={Boolean(request)} onOpenChange={(open) => !open && setRequest(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{request?.title}</DialogTitle>
          {request?.description ? <DialogDescription>{request.description}</DialogDescription> : null}
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setRequest(null)} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant={request?.destructive ? 'destructive' : 'default'}
            onClick={() => void accept()}
            disabled={busy}
          >
            {request?.confirmLabel ?? t('common.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  return { confirm, dialog }
}
