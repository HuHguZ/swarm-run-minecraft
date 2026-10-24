// Командир роя (пользователь 24.10: «сделай себе апи, чтобы ты роем мог управлять в бою против меня»): приказы — JSON-файл
// SWARM_ORDERS, состояние боя для командира — SWARM_STATUS (раз в секунду). Без SWARM_ORDERS модуль молчит.
// Приказ: { do: 'auto' | 'fight' | 'goto' | 'flee' | 'hold', target?, at?: [x,y,z], range? } и/или разовый вызов тела
// { rpc: { m, p }, id } (повторяется только с новым id). Кому — orders.bots[имя] ?? orders.teams[команда] ?? orders.all.
// Новая версия файла обрывает текущее дело затронутых ботов (stop), дальше ходит автопилот по приказу.
import * as fs from 'fs'
import { distance } from './common'
import type { SwarmDriverCtx } from './common'

export function swarmCommand (sw: SwarmDriverCtx) {
  const file = process.env.SWARM_ORDERS, statusFile = process.env.SWARM_STATUS
  if (!file) return { commanded: () => null, commandTurn: async () => false }
  const { bots, pos, alive, log, now } = sw
  let orders: any = {}, mtime = 0, version = 0
  const orderOf = b => orders.bots?.[b.name] ?? orders.teams?.[sw.teamOf(b)] ?? orders.all ?? null
  const load = () => {
    let st: fs.Stats
    try { st = fs.statSync(file) } catch { return }
    if (st.mtimeMs === mtime) return
    mtime = st.mtimeMs
    try { orders = JSON.parse(fs.readFileSync(file, 'utf8')) || {} } catch (e: any) { log(`🎖 приказы: не разобрал ${file} — ${e.message}`); return }
    version++
    log(`🎖 приказы v${version}: ${JSON.stringify(orders).slice(0, 300)}`)
    for (const b of bots) {
      const key = JSON.stringify(orderOf(b))
      if (key === (b.commandKey ?? 'null')) continue
      b.commandKey = key
      if (alive(b.name)) { b.c.call('stop').catch(() => {}); delete b.swarmTask }
    }
  }
  const status = () => {
    if (!statusFile) return
    const teams: Record<string, any> = {}
    for (const b of bots) {
      const m = pos[b.name], team = sw.teamOf(b)
      const t = (teams[team] ||= { bots: [], enemies: sw.boardOf(b).enemies().map(e => ({ id: e.id, at: [e.position.x, e.position.y, e.position.z].map(v => Math.round(v * 10) / 10), seenS: Math.round((now() - e.seenAt) / 100) / 10, hp: e.health, weapon: e.equipment?.weapon })) })
      t.bots.push({ name: b.name, alive: alive(b.name), hp: m?.hp, at: m?.p ? [m.p.x, m.p.y, m.p.z].map(v => Math.round(v * 10) / 10) : null,
        task: b.swarmTask ? `${b.swarmTask.kind}${b.swarmTask.data?.target ? ' → ' + b.swarmTask.data.target : ''}` : null, doing: b.last?.m, order: orderOf(b),
        kit: Object.keys(m?.inv || {}).filter(n => /sword|axe|spear|mace|trident|bow|pearl|wind_charge|potion|cobweb|elytra|lava|totem|apple/.test(n)) })
    }
    try { fs.writeFileSync(statusFile, JSON.stringify({ at: new Date().toISOString(), version, round: sw.generation, teams }, null, 1)) } catch {}
  }
  setInterval(() => { load(); status() }, 1000)
  load()
  // Задача по приказу вместо плана; null — автопилот (нет приказа, auto, hold, или цель боя неизвестна доске).
  const commanded = (b, context) => {
    const o = orderOf(b), m = pos[b.name]
    if (!o?.do || o.do === 'auto' || o.do === 'hold' || !m?.p) return null
    const at = Array.isArray(o.at) ? { x: o.at[0], y: o.at[1], z: o.at[2] } : null
    const enemies = context.board.enemies()
    if (o.do === 'fight') {
      const foe = enemies.find(e => e.id === o.target) || (!o.target && [...enemies].sort((a, c) => distance(a.position, m.p) - distance(c.position, m.p))[0])
      if (foe) return { kind: 'fight', position: foe.position, data: { target: foe.id, committed: true, commanded: true } }
      return at ? { kind: 'goto', position: at, data: { range: o.range ?? 2, commanded: true } } : null
    }
    if (o.do === 'goto' && at) return { kind: 'goto', position: at, data: { range: o.range ?? 2, commanded: true } }
    if (o.do === 'flee') {
      const foe = [...enemies].sort((a, c) => distance(a.position, m.p) - distance(c.position, m.p))[0]
      if (!foe) return null
      const d = Math.hypot(m.p.x - foe.position.x, m.p.z - foe.position.z) || 1, k = (o.range ?? 20) / d
      return { kind: 'goto', position: sw.bounded ? sw.bounded({ x: m.p.x + (m.p.x - foe.position.x) * k, y: m.p.y, z: m.p.z + (m.p.z - foe.position.z) * k }) : m.p, data: { range: 3, commanded: true } }
    }
    return null
  }
  // Ход по приказу, который не задача плана: разовый вызов тела и стойка на месте. true — ход занят.
  const commandTurn = async b => {
    const o = orderOf(b)
    if (!o) return false
    if (o.rpc?.m && o.id != null && b.commandDone !== o.id) {
      b.commandDone = o.id
      const r: any = await b.c.call(o.rpc.m, o.rpc.p || {}).catch(e => ({ error: e.message }))
      log(`🎖 ${b.name}: ${o.rpc.m} #${o.id} — ${JSON.stringify(r?.detail ?? r).slice(0, 200)}`)
      return true
    }
    // Поход по приказу — прямо, мимо привычек автопилота (сундук рядом, передача, позиция стрелка).
    if ((o.do === 'goto' || o.do === 'flee') && pos[b.name]?.p) {
      const t = commanded(b, { board: sw.boardOf(b) })
      if (!t) return false
      await sw.go(b, t.position, t.data.range).catch(() => {})
      return true
    }
    if (o.do === 'hold') {
      const enemies = sw.boardOf(b).enemies().map(e => e.id)
      await b.c.call('swarm_hold', { sneak: !!o.sneak, enemies, allies: bots.filter(x => sw.teamOf(x) === sw.teamOf(b)).map(x => x.name), timeoutSeconds: 2 }).catch(() => {})
      return true
    }
    return false
  }
  return { commanded, commandTurn }
}
