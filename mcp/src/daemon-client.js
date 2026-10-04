import WebSocket from 'ws'

// Thin RPC client. The MCP server keeps no game state — the daemon owns the
// body, so this reconnects freely and never caches anything.
export class DaemonClient {
  constructor (url) {
    this.url = url
    this.ws = null
    this.pending = new Map()
    this.nextId = 0
    this.connecting = null
  }

  async ensure () {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return this.ws
    if (this.connecting) return this.connecting

    this.connecting = new Promise((resolve, reject) => {
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
        let msg
        try { msg = JSON.parse(raw.toString()) } catch { return }
        const waiter = this.pending.get(msg.id)
        if (!waiter) return
        this.pending.delete(msg.id)
        msg.ok ? waiter.resolve(msg.result) : waiter.reject(new Error(msg.error))
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

  // Only here so a lost message cannot wedge the tool call forever — the daemon
  // enforces its own per-intent budget and always answers it with a full
  // envelope (state header, events, report). So this ceiling has to sit ABOVE
  // every budget the daemon can hand out. At 300s it sat below nine of them and
  // fired first: mc_tunnel came back as «демон не ответил на tunnel за 300с» —
  // no state, no events, no report — while the body went on digging for another
  // five minutes with nobody watching.
  //
  // The budgets are computed in daemon/src/session.js from the schema maxima in
  // index.js, and the largest is smelt at min(600, timeoutSeconds) + 30 = 630s;
  // then surface 625, tunnel / mine_seen / base / dig_down 620, goto 615, mine
  // 600. Lowering the schemas instead would have been the wrong end: a 600s
  // drift is a legitimate thing to ask for, and the transport should not be what
  // decides how long a body may work.
  //
  // There is a second wall above this one and it is not ours: Claude Code's own
  // MCP timeout, "timeout": 660000 in .mcp.json. 645s leaves fifteen seconds of
  // clearance on both sides. Raising the daemon's budgets past 630s means
  // raising both numbers, in that order.
  async call (method, params = {}, timeoutMs = 645000) {
    const ws = await this.ensure()
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
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
