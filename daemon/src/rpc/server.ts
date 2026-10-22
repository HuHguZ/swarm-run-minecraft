'use strict'
// Подключения мозгов к демону по WebSocket: часы (тик и пульс), опасности для арены, вызовы RPC-методов.
// Часы (gameClock) и методы передаёт src/index.ts — тест подменяет часы, не поднимая порта и бота.
import type { RpcState } from './context'

function attachClients (wss, { session, gameClock, methods, log, state }: { session: any, gameClock: any, methods: Record<string, any>, log: (...args: any[]) => void, state: RpcState }) {
  let clients = 0
  wss.on('connection', (ws) => {
    clients++
    session.brainAttached = clients > 0
    const sendClock = (clock = gameClock.snapshot()) => {
      if (clock && ws.readyState === 1 && (ws.bufferedAmount || 0) < 65536) ws.send(JSON.stringify({ type: 'clock', clock }))
    }
    // Опасности — каждый игровой тик (на ускоренном сервере стенные 50 мс — несколько тиков опоздания уворота).
    const pushDanger = () => {
      if (!state.dangerWatch || ws.readyState !== 1 || !session.bot?.entity) return
      try {
        const d = require('../threats').dangers(session.bot, { foes: state.dangerWatch.foes })
        // Кемпер в своей коробке: откуда летит (зелье, стрела) — запомнить для выхода прочь; уворот драйвера не дёргать (он рвал бы
        // ремонт и выход из коробки; Codex 15.10).
        const box = session.bot._ndCampBox
        if (box && box.cell.equals(require('../fortify').feetCell(session.bot))) {
          const shot = [...d.potions, ...d.arrows].filter(s => s.from).sort((a, b) => a.ticks - b.ticks)[0]
          if (shot) box.shot = { from: { ...shot.from }, at: gameClock.now() }
          d.potions = []; d.arrows = []; d.aims = []
        }
        if (d.potions.length || d.clouds.length || d.smashes.length || d.arrows.length || d.aims.length || d.lava.length || d.floor.length || d.blasts.length || d.web.length) ws.send(JSON.stringify({ type: 'danger', dangers: { potions: d.potions, clouds: d.clouds, smashes: d.smashes, arrows: d.arrows, aims: d.aims, lava: d.lava, floor: d.floor, blasts: d.blasts, web: d.web }, pos: session.bot.entity.position }))
      } catch {}
    }
    let sourceClock
    let lastPublished = 0
    // Followers have no independent prediction loop. Publish every five game
    // ticks so short game sleeps don't wait 250 wall ms at an accelerated rate.
    const onTick = ticks => {
      try { pushDanger() } catch {}
      if (sourceClock.frozen || ticks - lastPublished >= 5) { lastPublished = ticks; sendClock() }
    }
    const bindClock = clock => {
      sourceClock?.off('tick', onTick)
      sourceClock?.off('state', sendClock)
      sourceClock = clock
      lastPublished = clock?.ticks ?? 0
      sourceClock?.on('tick', onTick)
      sourceClock?.on('state', sendClock)
      if (sourceClock) sendClock(sourceClock.snapshot())
    }
    gameClock.changes.on('bound', bindClock)
    bindClock(session.bot?.ndClock)
    // Wall heartbeat is deliberate: freeze must be observable while there are
    // zero gameplay ticks, and campaigns must see stalls and rate changes.
    const clockTimer = gameClock.wall.setInterval(sendClock, 250)
    ws.on('close', () => {
      gameClock.wall.clearInterval(clockTimer)
      gameClock.changes.off('bound', bindClock)
      bindClock(null)
    })
    ws.on('close', () => { clients--; session.brainAttached = clients > 0 })
    log('brain attached')
    ws.on('message', async (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      const { id, method, params } = msg
      const fn = methods[method]
      if (!fn) {
        ws.send(JSON.stringify({ id, ok: false, error: `неизвестный метод: ${method}` }))
        return
      }
      try {
        const result = await fn(params || {})
        if (result && typeof result === 'object' && !result.state) result.clock = gameClock.snapshot()
        ws.send(JSON.stringify({ id, ok: true, result }))
      } catch (err) {
        ws.send(JSON.stringify({ id, ok: false, error: String((err && err.message) || err) }))
      }
    })
    ws.on('close', () => log('brain detached'))
  })
}

export { attachClients }
