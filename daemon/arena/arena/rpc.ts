'use strict'
// Арена (часть arena.ts): связь с демонами бойцов (WebSocket RPC, часы — по первому) и команды в чат от первого
// бойца. Сокеты открывает только connect() из входа — после сторожа и замка; импорт части их не открывает.
import * as gameClock from '../../src/game-clock'
import WebSocket = require('ws')
import { A_URL, B_URL, HUMAN, sleep } from './config'

// Both bots share server ticks; keep the first connection as the time source.
let clockSource = null
// Отставание часов демона (lagTicks снимка) — максимум за раунд по каждому бойцу.
const lagMax: Record<string, number> = {}
function client (url) {
  clockSource ??= url
  const ws = new WebSocket(url)
  let id = 0
  const pending = new Map()
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString())
    const clk = m.clock || m.result?.state?.clock || m.result?.clock
    if (url === clockSource) gameClock.follow(clk)
    if (clk && typeof clk.lagTicks === 'number') lagMax[url] = Math.max(lagMax[url] || 0, clk.lagTicks)
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
  })
  const ready = new Promise<any>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  const call = (method, params: any = {} as Record<string, any>) => new Promise<any>((resolve, reject) => {
    const rid = ++id
    pending.set(rid, { resolve, reject })
    ws.send(JSON.stringify({ id: rid, method, params }))
  })
  return { ws, ready, call }
}

const humanStub = { ready: Promise.resolve(), ws: { close () {} }, call: async (m) => m === 'status' ? { state: { health: 20, inventory: { any: 1 } } } : { status: 'done', detail: {} as Record<string, any> } }
let A: ReturnType<typeof client> = null
let B: ReturnType<typeof client> | typeof humanStub = null
function connect () {
  A = client(A_URL)
  B = HUMAN ? humanStub : client(B_URL)
}

// Антиспам ванильного сервера: +20 за сообщение, −1 за тик, кик после 200 —
// и LAN-бот не оператор, так что его это касается (ECONNRESET 2026-09-25 на
// выдаче «арсенала»: 40 команд по 350 мс). Держим счётчик ниже 140.
//
// Но кикает он только не-операторов, а в LAN с читами оператор каждый
// (allowCommandsForAllPlayers): в логе хоста за 2026-09-25 ни одного кика за
// спам — отключения были от удара по себе. Счётчик растягивал выдачу арсенала
// до минут («ждёшь полчаса, пока предметы выдаются»), так что он включается
// только ARENA_THROTTLE=1 — на чужом сервере, где бот не оп.
const THROTTLE = !!process.env.ARENA_THROTTLE
let spam = 0
let spamAt = gameClock.now()
async function cmd (text) {
  if (THROTTLE) {
    const decay = () => { const now = gameClock.now(); spam = Math.max(0, spam - (now - spamAt) / 50); spamAt = now }
    decay()
    if (spam + 20 > 185) { await sleep((spam + 20 - 185) * 50); decay() }
  }
  await A.call('say', { text })
  spam += 20
  if (THROTTLE) await sleep(60)
}

export { lagMax, client, connect, A, B, cmd }
