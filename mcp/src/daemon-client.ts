import WebSocket from 'ws'

export interface DaemonResult {
  status?: string
  state?: Record<string, unknown>
  detail?: unknown
  image?: string
  mime?: string
  [field: string]: unknown
}

interface PendingCall {
  resolve: (result: DaemonResult) => void
  reject: (error: Error) => void
}

export class DaemonClient {
  private ws: WebSocket | null = null
  private readonly pending = new Map<number, PendingCall>()
  private nextId = 0
  private connecting: Promise<WebSocket> | null = null

  constructor (private readonly url: string) {}

  async ensure (): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return this.ws
    if (this.connecting) return this.connecting

    this.connecting = new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(this.url)
      const onError = () => {
        reject(new Error(
          `демон не отвечает на ${this.url}. Запусти его: powershell -File "${'C:\\Users\\user\\Desktop\\work\\minecraft-claude\\restart-daemon.ps1'}"`
        ))
      }
      ws.once('error', onError)
      ws.once('open', () => {
        ws.removeListener('error', onError)
        this.ws = ws
        resolve(ws)
      })
      ws.on('message', raw => {
        let msg: { id?: unknown; ok?: unknown; result?: DaemonResult; error?: unknown }
        try { msg = JSON.parse(raw.toString()) } catch { return }
        if (!msg || typeof msg.id !== 'number') return
        const waiter = this.pending.get(msg.id)
        if (!waiter) return
        this.pending.delete(msg.id)
        msg.ok ? waiter.resolve(msg.result || {}) : waiter.reject(new Error(String(msg.error)))
      })
      ws.on('close', () => {
        this.ws = null
        for (const waiter of this.pending.values()) {
          waiter.reject(new Error('соединение с демоном разорвано'))
        }
        this.pending.clear()
      })
    }).finally(() => { this.connecting = null })

    return this.connecting
  }

  // Keep above the longest daemon budget (630s) and below the MCP ceiling (660s).
  async call (method: string, params: Record<string, unknown> = {}, timeoutMs = 645000): Promise<DaemonResult> {
    const ws = await this.ensure()
    const id = ++this.nextId
    return new Promise<DaemonResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`демон не ответил на ${method} за ${Math.round(timeoutMs / 1000)}с`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v) },
        reject: e => { clearTimeout(timer); reject(e) }
      })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }
}
