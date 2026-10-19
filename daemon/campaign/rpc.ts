'use strict'
// Связь с демоном: WebSocket-клиент и вызов RPC. Сокет открывает только connect() из входа — импорт части без побочных действий.
const WebSocket: typeof import('ws') = require('ws')
const gameClock: typeof import('../src/game-clock') = require('../src/game-clock')
let ws: any = null
let rid = 0
const pending = new Map()
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++rid
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
})
// Открыть сокет к демону (ND_WS) и разбирать ответы. Зовёт только вход daemon/campaign.ts.
function connect (url: string) {
  ws = new WebSocket(url)
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString())
    gameClock.follow(m.clock || m.result?.state?.clock || m.result?.clock)
    if (m.type === 'clock') return
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
  })
  return ws
}
const sleep = ms => gameClock.sleep(ms)

export { ws, call, sleep, connect }
