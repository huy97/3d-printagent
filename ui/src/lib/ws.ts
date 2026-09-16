import { apiKeyStore } from './api'

type WsMessage =
  | { type: 'event'; event: string; payload: unknown; at: string }
  | { type: 'welcome'; payload: unknown }
  | { type: 'auth_required'; message: string }
  | { type: 'result'; id?: string; payload: unknown }
  | { type: 'error'; id?: string; payload: { message: string } }

interface WsHandlers {
  onEvent: (event: string, payload: unknown) => void
  onStatus: (connected: boolean, reason?: string) => void
  onWelcome?: (payload: unknown) => void
}

const CHANNELS = ['status', 'printer', 'job', 'file', 'tunnel', 'log']

export function connectAgentSocket({ onEvent, onStatus, onWelcome }: WsHandlers) {
  let socket: WebSocket | null = null
  let retryTimer: number | undefined
  let closed = false

  const open = () => {
    if (closed) return
    socket = new WebSocket(new URL('/ws', location.origin.replace(/^http/, 'ws')))

    socket.addEventListener('message', (raw) => {
      const message = JSON.parse(raw.data as string) as WsMessage
      if (message.type === 'auth_required') {
        const apiKey = apiKeyStore.get()
        if (apiKey) socket?.send(JSON.stringify({ id: 'auth', type: 'auth', payload: { apiKey } }))
        else {
          onStatus(false, 'auth_required')
          socket?.close()
        }
        return
      }
      if (message.type === 'welcome') {
        socket?.send(JSON.stringify({ type: 'subscribe', payload: { events: CHANNELS } }))
        onStatus(true)
        onWelcome?.(message.payload)
        return
      }
      if (message.type === 'event') onEvent(message.event, message.payload)
    })

    socket.addEventListener('close', () => {
      onStatus(false)
      if (closed) return
      retryTimer = window.setTimeout(open, 3000)
    })

    socket.addEventListener('error', () => socket?.close())
  }

  open()

  return () => {
    closed = true
    window.clearTimeout(retryTimer)
    socket?.close()
  }
}
