'use strict'
// Ход по сетке Ада (nether-route.ts): один шаг плана по живым блокам — копка, мост, спрыгивание, сверка с сеткой.
import * as gameClock from '../game-clock'
import * as NG from '../nether-grid'
import { Vec3 } from 'vec3'
import { C, DIG, feetCell, log, receiptCostFor, sleep, xyz } from './base'
import { liveClass } from './fight'
import { goldPicks } from './hazards'


// Клетки, которые ход вскрывает (копка по живым блокам), — сверху вниз.
function moveCells (mv) {
  const t = mv.to; const f = mv.from
  switch (mv.kind) {
    case 'flat': case 'bridge': return [[t.x, t.y + 1, t.z], [t.x, t.y, t.z]]
    case 'up': return [[f.x, f.y + 2, f.z], [t.x, t.y + 1, t.z], [t.x, t.y, t.z]]
    case 'down': return [[t.x, t.y + 2, t.z], [t.x, t.y + 1, t.z], [t.x, t.y, t.z]]
    case 'vdown': return [[t.x, t.y, t.z]]
    case 'vup': return [[f.x, f.y + 2, f.z]]
    default: return []
  }
}

function routeFrame (bot, ctl, deadline) {
  return new Promise<boolean>(resolve => {
    const wall = gameClock.wall
    let timer
    const finish = (observed: boolean) => {
      bot.removeListener('physicsTick', observedFrame)
      bot.removeListener('end', stopped)
      bot.removeListener('death', stopped)
      if (timer) wall.clearTimeout(timer)
      if (ctl.onAbort) { const index = ctl.onAbort.indexOf(stopped); if (index >= 0) ctl.onAbort.splice(index, 1) }
      resolve(observed)
    }
    const observedFrame = () => finish(!ctl.aborted && (bot.health ?? 20) > 0)
    const stopped = () => finish(false)
    if (ctl.aborted || (bot.health ?? 20) <= 0 || wall.now() >= deadline) return resolve(false)
    bot.on('physicsTick', observedFrame)
    bot.on('end', stopped)
    bot.on('death', stopped)
    ctl.onAbort?.push(stopped)
    timer = wall.setTimeout(stopped, Math.max(1, deadline - wall.now()))
  })
}

async function exposeBridgeFace (bot, ctl, support, destination) {
  const face = destination.minus(support)
  if (Math.abs(face.x) + Math.abs(face.z) !== 1 || face.y !== 0) return false
  const pick: typeof import('../pick') = require('../pick')
  const deadline = gameClock.wall.now() + 3000
  try {
    for (let frames = 0; frames < 24 && !ctl.aborted; frames++) {
      if (ctl.waitReflex) await ctl.waitReflex()
      const p = bot.entity.position
      const half = (bot.entity.width || 0.6) / 2
      if (ctl.aborted || !bot.entity.onGround || Math.abs(p.y - support.y - 1) > 0.02 ||
        bot.blockAt(support)?.boundingBox !== 'block' ||
        p.x + half <= support.x || p.x - half >= support.x + 1 ||
        p.z + half <= support.z || p.z - half >= support.z + 1) return false
      if (pick.faceAim(bot, support, face)) return true
      // Sneak keeps the native body supported while its eyes cross the outward face.
      await bot.lookAt(destination.offset(0.5, 2.6, 0.5), true)
      bot.setControlState('forward', true)
      if (!await routeFrame(bot, ctl, deadline)) return false
    }
    return false
  } finally { bot.setControlState('forward', false) }
}

async function dropInto (bot, ctl, to) {
  if (ctl.waitReflex) await ctl.waitReflex()
  if (ctl.aborted || !bot.physics || !bot.entity.onGround) return false
  const result = await (require('../navigation/parkour') as typeof import('../navigation/parkour')).executeJump(bot, ctl, to.offset(0.5, 0, 0.5),
    { allowWalk: true, planningMs: 180 })
  return result.ok && !ctl.aborted && bot.entity.onGround && feetCell(bot).equals(to)
}

// Один ход: проверить живые блоки, вскрыть клетки, шагнуть. Итог: 'ok' | 'replan' | 'stop:<почему>'.
export async function stepOne (session, ctl, g, mv, st) {
  const bot = session.bot
  const SL: typeof import('../sealed') = require('../sealed')
  if (ctl.aborted) return 'stop:прервано'
  const describe = () => ({ at: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
    velocity: bot.entity.velocity ? { x: bot.entity.velocity.x, y: bot.entity.velocity.y, z: bot.entity.velocity.z } : null,
    grounded: bot.entity.onGround, jumpTicks: bot.jumpTicks, pose: bot.entity.pose,
    keys: Object.fromEntries(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].map(key => [key, bot.getControlState?.(key) ?? bot.controlState?.[key] ?? null])) })
  const beforeStep = describe()
  // A route owns the next movement; movement inherited from a previous escape cancels its forward vector.
  for (const key of ['forward', 'back', 'left', 'right', 'jump']) bot.setControlState(key, false)
  const cells = moveCells(mv)
  const timing = st.timing || (st.timing = { digMs: 0, moveMs: 0, receiptMs: 0, receiptWallMs: 0, receiptServerWallMs: 0, receiptNotificationWallMs: 0, receiptSingle: 0, receiptSection: 0 })
  const digOptions = { interrupted: () => ctl.aborted, onReceipt: receipt => {
    timing.receiptMs += receipt.gameMs; timing.receiptWallMs += receipt.wallMs
    timing.receiptServerWallMs += receipt.serverWaitWallMs; timing.receiptNotificationWallMs += receipt.notificationDelayWallMs
    if (receipt.packet === 'single') timing.receiptSingle++
    if (receipt.packet === 'section') timing.receiptSection++
    if (ctl.aborted || session.bot !== bot) return
    const history = receiptCostFor(session)
    history.costs.observe(history.context, receipt)
    if (receipt.result !== 'confirmed') {
      st.digIssues ||= []
      if (st.digIssues.length < 8) st.digIssues.push({ result: receipt.result, wallMs: receipt.wallMs, ...receipt.dig })
    }
  } }
  const isDrop = mv.kind === 'drop2' || mv.kind === 'drop3'
  // Живое расхождение с сеткой: лава, огонь, коренное и т. п. — пометить и перепланировать.
  for (const c of cells) {
    const lc = liveClass(bot, c)
    if (lc === C.UNKNOWN) return 'stop:не прогружено'
    if (lc === C.LAVA || lc === C.HOT || DIG[lc] === Infinity) { g.mark(c[0], c[1], c[2], lc); st.mismatch++; return 'replan' }
    if (NG.passable(lc)) continue
    // Вскрываемая клетка у лавы по живым блокам (сбоку/сверху; сетка не знала: натекла) — пометить.
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]) {
      if (liveClass(bot, [c[0] + dx, c[1] + dy, c[2] + dz]) === C.LAVA) { g.mark(c[0] + dx, c[1] + dy, c[2] + dz, C.LAVA); st.mismatch++; return 'replan' }
    }
  }
  if (isDrop) {
    // Колонна прыжка — проходима по живым блокам, под ней — пол.
    for (let y = mv.from.y + 1; y >= mv.to.y; y--) {
      const lc = liveClass(bot, [mv.to.x, y, mv.to.z])
      if (!NG.passable(lc)) { g.mark(mv.to.x, y, mv.to.z, lc); st.mismatch++; return 'replan' }
    }
  }
  if (mv.kind !== 'vup' && mv.kind !== 'bridge') {
    const fl = liveClass(bot, [mv.to.x, mv.to.y - 1, mv.to.z])
    if (fl === C.LAVA || fl === C.HOT || (fl === C.MAGMA && !st.fireproof) || (NG.passable(fl) && mv.kind !== 'vdown')) {
      g.mark(mv.to.x, mv.to.y - 1, mv.to.z, fl); st.mismatch++; return 'replan'
    }
  }
  for (const c of cells) {
    const lc = liveClass(bot, c)
    if (NG.passable(lc)) continue
    const digStarted = gameClock.now()
    let r = await SL.digCell(bot, new Vec3(c[0], c[1], c[2]), digOptions)
    if (ctl.aborted || session.bot !== bot) return 'stop:прервано'
    // Не докопал (рукой — долго, кирок нет): сделать каменные и ещё раз; не вышло — обойти (пометка «твёрдое»).
    if (/^failed|^left/.test(r) && !ctl.aborted) {
      if (!bot.inventory.items().some(i => /_pickaxe$/.test(i.name))) { const made = await (require('../tunnel') as typeof import('../tunnel')).restockPicks(session, ctl, 3).catch(() => 0); st.crafted = (st.crafted || 0) + (made || 0) }
      if (ctl.aborted || session.bot !== bot) return 'stop:прервано'
      if (!bot.inventory.items().some(i => /_pickaxe$/.test(i.name))) st.crafted = (st.crafted || 0) + await goldPicks(session, ctl, 2)
      if (ctl.aborted || session.bot !== bot) return 'stop:прервано'
      r = await SL.digCell(bot, new Vec3(c[0], c[1], c[2]), digOptions)
      if (ctl.aborted || session.bot !== bot) return 'stop:прервано'
    }
    timing.digMs += Math.max(0, gameClock.now() - digStarted)
    if (r === 'ok' || r === 'air') { st.dug++; g.mark(c[0], c[1], c[2], C.AIR); continue }
    st.digFails++
    if (st.digFails > 12) return 'stop:копка ' + r
    g.mark(c[0], c[1], c[2], C.HARD)
    return 'replan'
  }
  const to = new Vec3(mv.to.x, mv.to.y, mv.to.z)
  const moveStarted = gameClock.now()
  if (mv.kind !== 'bridge') bot.setControlState('sneak', false)
  if (mv.kind === 'bridge') {
    const fc = to.offset(0, -1, 0)
    const fb = bot.blockAt(fc)
    if (fb && fb.boundingBox !== 'block') {
      if (!bot.entity.onGround || /lava|water|fire/.test(fb.name)) return 'replan'
      const { placeBlockAt }: typeof import('../build') = require('../build')
      bot.setControlState('sprint', false)
      bot.setControlState('sneak', true)
      try {
        const support = feetCell(bot).offset(0, -1, 0)
        const below = bot.blockAt(support)
        const prop = below?.boundingBox === 'empty' && /^(air|cave_air|void_air)$/.test(below.name) &&
          Math.abs(bot.entity.position.y - support.y - 1) < 0.02 &&
          Math.abs(support.x - fc.x) + Math.abs(support.z - fc.z) === 1 && support.y === fc.y ? support : null
        let r = await placeBlockAt(bot, fc, { timeoutMs: 2000, steady: true, honest: true, prop })
        if (prop && r?.prop?.placed && bot.blockAt(prop)?.boundingBox === 'block') {
          st.placed = (st.placed || 0) + 1
          g.mark(prop.x, prop.y, prop.z, C.SOFT)
        }
        if (!r?.ok && !ctl.aborted && (r?.noFooting || r?.prop?.placed) &&
          await exposeBridgeFace(bot, ctl, support, fc)) {
          r = await placeBlockAt(bot, fc, { timeoutMs: 2000, steady: true, honest: true })
        }
        if (ctl.aborted) return 'stop:прервано'
        if (!r || !r.ok) {
          st.placeFails = (st.placeFails || 0) + 1
          // Сущность в клетке (блейз пролетал) — подождать и заново; прочее — несколько раз и стоп.
          if (/стоит/.test(String(r && r.reason)) && st.placeFails < 8) { await sleep(600); return 'replan' }
          if (st.placeFails < 4) return 'replan'
          return 'stop:мост: ' + String((r && r.reason) || 'не поставил').slice(0, 80)
        }
        if (!r.already) st.placed = (st.placed || 0) + 1
        g.mark(fc.x, fc.y, fc.z, C.SOFT)
        await (require('../bridge') as typeof import('../bridge')).stepOnto(bot, ctl, fc)
      } finally { bot.setControlState('sneak', false) }
    } else await SL.stepMove(bot, ctl, { kind: 'flat', to })
  } else if (isDrop) {
    await dropInto(bot, ctl, to)
  } else {
    const kind = mv.kind === 'down' ? 'flat' : mv.kind
    let ok = await SL.stepMove(bot, ctl, { kind, to })
    if (!ok && !feetCell(bot).equals(to)) { await sleep(250); ok = await SL.stepMove(bot, ctl, { kind, to }) }
  }
  timing.moveMs += Math.max(0, gameClock.now() - moveStarted)
  if (mv.kind === 'vup') g.mark(mv.from.x, mv.from.y, mv.from.z, C.SOFT)
  if (!feetCell(bot).equals(to)) {
    st.stepFails++
    if (st.stepFails <= 8) log('шаг не подтверждён', { kind: mv.kind, from: mv.from, to: mv.to,
      before: beforeStep, after: describe(), aborted: ctl.aborted, reflex: !!session.reflex,
      floor: bot.blockAt(to.offset(0, -1, 0))?.name, feet: bot.blockAt(to)?.name, head: bot.blockAt(to.offset(0, 1, 0))?.name,
      shapes: [-1, 0, 1].map(dy => { const b = bot.blockAt(to.offset(0, dy, 0)); return { dy, name: b?.name, box: b?.boundingBox, shapes: b?.shapes } }) })
    // Не шагнул туда дважды — клетка «непроходима» для плана (живая геометрия: забор, ступени, сущность).
    const k = `${to.x},${to.y},${to.z}`
    st.badStep = st.badStep || new Map()
    const n = (st.badStep.get(k) || 0) + 1
    st.badStep.set(k, n)
    if (n >= 2) { g.mark(to.x, to.y, to.z, C.BLOCK); st.blocked = st.blocked || new Set(); st.blocked.add(k); log('не шагнул — клетку в обход', { kind: mv.kind, to: mv.to, from: mv.from, at: xyz(bot.entity.position) }) }
    return 'replan'
  }
  return 'ok'
}

// Живые блоки вокруг тела — в сетку (портал прибытия, своя рама, натёкшая лава — в копии мира их не было:
// neF-B2f25-1 03.10 — у портала прибытия 3 плана подряд «расхождение» на первом шаге и «на месте»).
export function syncAround (bot, g, r = 6) {
  const f = bot.entity.position.floored()
  let n = 0
  for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
    const x = f.x + dx; const y = f.y + dy; const z = f.z + dz
    if (!g.inside(x, y, z)) continue
    const b = bot.blockAt(new Vec3(x, y, z))
    if (!b) continue
    const c = /lava/.test(b.name) ? C.LAVA : NG.classOfName(b.name)
    if (g.get(x, y, z) !== c) { g.mark(x, y, z, c); n++ }
  }
  return n
}
