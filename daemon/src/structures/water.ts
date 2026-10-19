'use strict'
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { sleep, v3, WET, NO_DIG } from './common'
import { canReach, digAt } from './site'

// Под водой: голова в воде и воздуха мало — всплыть и отдышаться.
// Воздух 0..20. mineflayer 4.37 кладёт в oxygenLevel то сырые тики
// метаданных (0..300), то уже делённые на 15 — приводим к 0..20.
function air (bot) {
  const v = bot.oxygenLevel ?? 20
  return v > 20 ? v / 15 : v
}

function headWet (bot) {
  const b = bot.blockAt((require('../pick') as typeof import('../pick')).eyeOf(bot))
  return !!b && (b.name === 'water' || b.name === 'bubble_column' || b.name === 'kelp' || b.name === 'kelp_plant' || b.name === 'seagrass' || b.name === 'tall_seagrass' || b.getProperties?.().waterlogged === true)
}

// Где голова последний раз была над водой — путь наверх из трюма (прыжок упирается в палубу: ферма 14.10, корабль
// 115,-89 — утонул под палубой у сундука карты).
// Под водой — след пути (точка раз в 5 тиков, через 0.8 бл.): наверх тем же путём, каким пришёл (он проходим).
function trackAir (bot) {
  if (!bot || bot._ndAirTrack || typeof bot.on !== 'function') return
  bot._ndAirTrack = true
  let n = 0
  bot.on('physicsTick', () => {
    try {
      if (!bot.entity) return
      const p = bot.entity.position
      if (!headWet(bot)) {
        bot._ndLastAir = p.clone()
        bot._ndTrail = []
        // Над водой по-настоящему (голова в воздухе, не в двери кармана) — поверхность.
        const head = bot.blockAt(p.offset(0, bot.entity.eyeHeight || 1.62, 0))
        if (head && /air$/.test(head.name)) bot._ndSurface = p.clone()
        return
      }
      if (++n % 5) return
      const t = bot._ndTrail || (bot._ndTrail = [])
      if (!t.length || t[t.length - 1].distanceTo(p) > 0.8) t.push(p.clone())
      if (t.length > 240) t.shift()
    } catch {}
  })
}
// Над глазами до последней сухой точки — только вода (видно: столб прямо над головой) — всплыть можно отвесно.
function openAbove (bot) {
  const top = bot._ndLastAir ? bot._ndLastAir.y + 1.62 : null
  if (top === null) return false
  const e = (require('../pick') as typeof import('../pick')).eyeOf(bot)
  for (let y = Math.floor(e.y) + 1; y <= Math.floor(top); y++) {
    const b = bot.blockAt(new Vec3(Math.floor(e.x), y, Math.floor(e.z)))
    if (!b || !(WET.test(b.name) || /air$/.test(b.name))) return false
  }
  return true
}
// Длина обратного пути по следу до воздуха (бл.).
function trailLength (bot) {
  const t = bot._ndTrail || []
  let s = t.length && bot._ndLastAir ? t[0].distanceTo(bot._ndLastAir) : 0 // первый отрезок — от последней сухой точки
  for (let i = 1; i < t.length; i++) s += t[i].distanceTo(t[i - 1])
  return s + (t.length ? t[t.length - 1].distanceTo(bot.entity.position) : 0)
}
// По следу назад: к каждой точке — взглядом и шагом (вверх — прыжок, вниз — присед), пока голова под водой.
async function retrace (bot, ctl, ms) {
  // С последней сухой точкой: след начинается уже под водой, до воздуха — ещё отрезок (ревью Codex q2).
  const t = [...(bot._ndLastAir ? [bot._ndLastAir.clone()] : []), ...(bot._ndTrail || [])]
  const t0 = gameClock.now()
  try {
    for (let i = t.length - 1; i >= 0 && !ctl.aborted && headWet(bot) && gameClock.now() - t0 < ms; i--) {
      const q = t[i]
      const ts = gameClock.now()
      while (!ctl.aborted && headWet(bot) && bot.entity.position.distanceTo(q) > 0.3 && gameClock.now() - ts < 1500 && gameClock.now() - t0 < ms) {
        const p = bot.entity.position
        try { await bot.lookAt(q.offset(0, 1.6, 0), true) } catch {}
        bot.setControlState('forward', Math.hypot(q.x - p.x, q.z - p.z) > 0.3)
        bot.setControlState('jump', q.y > p.y - 0.2)
        bot.setControlState('sneak', q.y < p.y - 0.8)
        await sleep(100, ctl)
      }
    }
  } finally { for (const k of ['forward', 'jump', 'sneak']) bot.setControlState(k, false) }
}
async function breathe (bot, ctl, ms = 15000, session = null) {
  if (ctl.aborted) return false
  try { bot.pathfinder.setGoal(null) } catch {}
  trackAir(bot)
  const t0 = gameClock.now()
  // Свой карман (дверь) рядом и след ведёт к нему — туда, а не наверх через всю толщу.
  const pk = bot._ndPocket
  if (pk && headWet(bot) && bot.entity.position.distanceTo(pk) < 10 && /_door$/.test((bot.blockAt(pk) || {}).name || '') && (bot._ndTrail || []).length) {
    await retrace(bot, ctl, Math.min(ms, 6000))
    if (!headWet(bot)) {
      const t1 = gameClock.now()
      while (!ctl.aborted && gameClock.now() - t1 < 5000 && air(bot) < 19 && !headWet(bot)) await sleep(150, ctl)
      return !ctl.aborted && air(bot) >= 17
    }
  }
  if (ctl.aborted) return false
  bot.setControlState('jump', true)
  try {
    let lastY = bot.entity.position.y
    let still = gameClock.now()
    let retraced = false
    while (!ctl.aborted && gameClock.now() - t0 < ms && headWet(bot)) {
      await sleep(100, ctl)
      if (ctl.aborted) break
      if (bot.entity.position.y > lastY + 0.1) { lastY = bot.entity.position.y; still = gameClock.now() }
      // Вверх не идёт — над головой палуба: назад по следу (им пришёл), не вышло — плыть к месту, где голова была над
      // водой (swimTo копает, что на пути).
      if (gameClock.now() - still > 600) {
        bot.setControlState('jump', false)
        if (!retraced && (bot._ndTrail || []).length) { retraced = true; await retrace(bot, ctl, Math.max(0, ms - (gameClock.now() - t0))) }
        else if (session && bot._ndLastAir) await swimTo(session, ctl, bot._ndLastAir.offset(0, 1, 0), { reach: 1.2, ms: Math.max(0, ms - (gameClock.now() - t0)) })
        if (ctl.aborted) break
        bot.setControlState('jump', true)
        still = gameClock.now()
        lastY = bot.entity.position.y
      }
    }
    const t1 = gameClock.now()
    // Ждать воздух у поверхности. На плаву голова качается — то над водой, то под ней (ферма 14.10, корабль −220,−952:
    // «прервано» на каждом нырке); под водой дольше 1 с — снова тонем, ждать нечего (ревью Codex q2: удушье в ожидании).
    let wetSince = null
    while (!ctl.aborted && gameClock.now() - t1 < 5000 && air(bot) < 19) {
      if (!headWet(bot)) wetSince = null
      else if (wetSince === null) wetSince = gameClock.now()
      else if (gameClock.now() - wetSince > 1000) break
      await sleep(200, ctl)
    }
    if (process.env.ND_DEBUG_AIR) console.log('[breathe]', JSON.stringify({ air: air(bot), aborted: !!ctl.aborted, wet: headWet(bot), waited: gameClock.now() - t1, total: gameClock.now() - t0 }))
  } finally { bot.setControlState('jump', false) }
  return !ctl.aborted && air(bot) >= 17
}
function wetAt (bot, p) { const b = bot.blockAt(p); return !!b && WET.test(b.name) }
// Цель под водой: вода рядом с ней или в столбе над ней (сундук в трюме —
// над ним палуба, а выше вода). Мы в воде: по щиколотку, по пояс, по голову.
function underwater (bot, pos) {
  const p = v3(pos).floored()
  // Только видимое (ревью Codex q2: соседи цели и столб над ней читались сквозь палубу).
  const eyes: typeof import('../perception/eyes') = require('../perception/eyes')
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const q = p.offset(dx, 0, dz); if (eyes.seesNow(bot, q) && wetAt(bot, q)) return true }
  for (let dy = 1; dy <= 16; dy++) {
    const q = p.offset(0, dy, 0)
    if (!eyes.seesNow(bot, q)) continue
    if (wetAt(bot, q)) return true
    const b = bot.blockAt(q)
    if (!b || b.name === 'air' || b.name === 'cave_air') return false
  }
  return false
}
function swimming (bot) { const f = bot.entity.position.floored(); return wetAt(bot, f) || wetAt(bot, f.offset(0, 1, 0)) || headWet(bot) || !!bot.entity.isInWater }

// Плыть к точке без pathfinder'а: под водой он не находит путь («Took to
// long to decide path», корабль 2026-09-25). Смотреть на цель, вперёд;
// ниже — присесть (тонуть), выше — прыжок (всплывать). Упёрся — сломать,
// что между нами (обшивка корабля).
async function swimTo (session, ctl, pos, { reach = 4, ms = 25000 }: any = {}) {
  const bot = session.bot
  trackAir(bot)
  const aim = v3(pos).floored()
  const target = aim.offset(0.5, 0.5, 0.5)
  const t0 = gameClock.now()
  let best = Infinity
  let bestAt = gameClock.now()
  const off = () => { for (const c of ['forward', 'sneak', 'jump']) bot.setControlState(c, false) }
  // Присесть в воде — тонуть быстрее (ванильный LivingEntity.goDownInWater:
  // -0.04 к скорости за тик); prismarine-physics этого не умеет, добавляем.
  const dive = () => { if (bot.controlState.sneak && bot.entity.isInWater) bot.entity.velocity.y -= 0.04 }
  bot.on('physicsTick', dive)
  let orig = null
  if (process.env.ND_DEBUG_STRUCT) {
    orig = bot.setControlState
    bot.setControlState = function (c, v) { if (c === 'jump' && v) console.log('[swim] jump by', new Error().stack.split(String.fromCharCode(10)).slice(2, 5).join(' | ')); return orig.call(this, c, v) }
  }
  try {
    while (!ctl.aborted && gameClock.now() - t0 < ms) {
      const eye = bot.entity.position.offset(0, 1.62, 0)
      if (eye.distanceTo(target) <= reach) return true
      try { await bot.lookAt(target, true) } catch {}
      const dy = target.y - eye.y
      const flatD = Math.hypot(target.x - eye.x, target.z - eye.z)
      // Как человек: поверху — до точки над целью (воздух не тратится),
      // потом отвесно вниз. Под водой плывём ~0.6 бл/с, воздуха на 15 с. Уже на глубине — прямо к цели, не
      // всплывая (ферма 14.10: между сундуками корабля в 20 бл. вверх-вниз — воздух кончился на полпути).
      const surf = bot._ndSurface || bot._ndLastAir
      const deep = !!surf && surf.y - bot.entity.position.y > 3 && dy < 3
      const above = flatD <= 2.5 || deep
      bot.setControlState('forward', flatD > 0.7)
      bot.setControlState('sneak', above && dy < -0.8)
      bot.setControlState('jump', (!above && headWet(bot)) || dy > 0.3)
      await sleep(250, ctl)
      const now = bot.entity.position
      const d = now.offset(0, 1.62, 0).distanceTo(target)
      if (process.env.ND_DEBUG_STRUCT) console.log('[swim]', now.x.toFixed(1), now.y.toFixed(1), now.z.toFixed(1), 'dy', dy.toFixed(1), 'flat', flatD.toFixed(1), 'air', air(bot).toFixed(1))
      if (d < best - 0.4) { best = d; bestAt = gameClock.now() }
      // Полторы секунды без продвижения — упёрся: сломать, что между нами
      // (луч к цели), а нет — что перед ногами/головой по курсу.
      if (gameClock.now() - bestAt > 1500) {
        off()
        bestAt = gameClock.now()
        const dir = target.minus(eye).normalize()
        let hit = null
        try { const h = (require('../pick') as typeof import('../pick')).blockOnRay(bot, (require('../pick') as typeof import('../pick')).eyeOf(bot), dir, 4.5); hit = h && !h.pos.equals(aim) ? h.block : null } catch {}
        if (!hit || !canReach(bot, hit.position, 4.5)) {
          const yaw = Math.atan2(target.x - now.x, target.z - now.z)
          const ahead = now.offset(Math.sin(yaw) * 0.9, 0, Math.cos(yaw) * 0.9).floored()
          for (const q of [ahead.offset(0, 1, 0), ahead, dy < -0.8 ? now.floored().offset(0, -1, 0) : null]) {
            const b = q && (require('../pick') as typeof import('../pick')).blockSeen(bot, q, { range: 4.5 }) ? bot.blockAt(q) : null
            if (b && b.boundingBox === 'block' && !b.position.equals(aim)) { hit = b; break }
          }
        }
        if (hit && NO_DIG.test(hit.name)) return false
        if (hit && canReach(bot, hit.position, 4.5)) {
          // Под водой копается впятеро дольше (без «Подводника»), а на плаву — ещё впятеро (Player.getDestroySpeed:
          // в воде ×0.2, не на земле ×0.2): сперва осесть на дно или палубу (присесть — тонуть), потом копать.
          // Присед держать и всю копку: отпущенный — тело всплывает с опоры (ферма 14.10, палуба на 51: y 52 → 52.4).
          const wetDig = bot.entity.isInWater
          if (wetDig) {
            bot.setControlState('sneak', true)
            const ts = gameClock.now()
            while (!ctl.aborted && !bot.entity.onGround && gameClock.now() - ts < 1500) await sleep(100, ctl)
          }
          // Копка — в остаток времени и воздуха (1 из 20 ≈ 0.75 с; ревью Codex q2: спасательный заплыв копал 20 с без сторожа).
          const budget = Math.min(20000, ms - (gameClock.now() - t0), headWet(bot) ? Math.max(0, (air(bot) - 2) * 750) : Infinity)
          if (ctl.aborted || budget <= 0) { bot.setControlState('sneak', false); return false }
          const r = await digAt(session, ctl, hit.position, { maxMs: budget, walkMs: 0 })
          if (wetDig) bot.setControlState('sneak', false)
          if (process.env.ND_DEBUG_STRUCT) console.log('[swim] dig', hit.name, hit.position.toString(), JSON.stringify(r))
        } else { bot.setControlState('jump', true); await sleep(400, ctl) }
      }
    }
  } finally {
    off()
    bot.removeListener('physicsTick', dive)
    if (orig) bot.setControlState = orig
  }
  return bot.entity.position.offset(0, 1.62, 0).distanceTo(target) <= reach
}

// Дочернее «прервать»: снаружи рвёт родитель, изнутри — сторож воздуха.
function childCtl (ctl) {
  const sub: any = { aborted: false, onAbort: [] }
  sub.abort = () => {
    if (sub.aborted) return
    sub.aborted = true
    for (const fn of sub.onAbort) { try { fn() } catch {} }
  }
  ctl.onAbort.push(() => sub.abort())
  if (ctl.aborted) sub.abort()
  return sub
}

// Работа под водой нырками: воздуха (300 тиков = 15 с, LivingEntity.decreaseAirSupply) осталось на подъём с запасом —
// сторож рвёт работу, всплыть, отдышаться, снова (до dives раз). Тактика Surface на это время — последний рубеж (≤ 4 из
// 20, флаг session._airManaged; без него ≤ 8 рвала навык целиком: ферма 14.10, корабли 115,-89 и −224,−960). fn(sub) —
// сама работа; итог — последней попытки.
async function withAir (session, ctl, fn, dives = 3) {
  const was = session._airManaged
  try { return await withAirBody(session, ctl, fn, dives) } finally { session._airManaged = was || false }
}
async function withAirBody (session, ctl, fn, dives) {
  const bot = session.bot
  trackAir(bot)
  let lastErr = null
  for (let dive = 0; dive < dives && !ctl.aborted; dive++) {
    // Нырок — только с полным воздухом (всплыл на 12 из 20 и сразу вниз — ферма 14.10: тактика Surface на полпути).
    // Не набрал воздух — работу не начинать (ревью Codex q2: после неудачного breathe нырок шёл с пустыми лёгкими).
    if (air(bot) < 17 && (headWet(bot) || swimming(bot)) && !await breathe(bot, ctl, 15000, session)) return null
    if (ctl.aborted) return null
    const sub: any = childCtl(ctl)
    let drowning = false
    // Порог — по глубине: подъём прыжком ~3.2 бл/с (ферма 14.10: 52 → 62 за 3.1 с; 1 из 20 воздуха = 0.75 с), на реакцию
    // 0.5 с, наверх — с запасом над последним рубежом тактики. Пока нырок под этим сторожем, тактика Surface ждёт до ≤ 4
    // (session._airManaged, tactics/minecraft.ts; без флага — ≤ 8 и обрыв навыка: на 9–13 бл. оставалось ~1.5 с работы).
    session._airManaged = true
    const guard = gameClock.setInterval(() => {
      if (process.env.ND_DEBUG_AIR) console.log('[air]', JSON.stringify({ air: air(bot), raw: bot.oxygenLevel, wet: headWet(bot), y: Math.round(bot.entity.position.y * 10) / 10, last: bot._ndLastAir && Math.round(bot._ndLastAir.y) }))
      if (!headWet(bot)) return
      const depth = bot._ndLastAir ? Math.max(0, bot._ndLastAir.y - bot.entity.position.y) : 8
      // С дверью — раньше на 2.5 (≈2 с): поставить карман, пока до порога тактики далеко.
      const door = depth >= 5 && process.env.ND_AIR_POCKET === '1' && bot.inventory.items().some(i => /_door$/.test(i.name) && i.name !== 'iron_door')
      // Обратный путь по следу (под палубой он длиннее глубины): ~2.5 бл/с.
      // Над головой до поверхности открытая вода — наверх отвесно (порог по глубине); нет — назад по следу. По следу
      // для отвесного нырка — та же глубина, но по 0.53 за блок: у сундука на 12 бл. сторож рвал копку палубы сразу
      // по прибытии (ферма 14.10, корабль −220,49,−952: 4 нырка — «прервано»).
      const back = openAbove(bot) ? 0 : Math.min(17, 6 + 0.53 * trailLength(bot))
      if (air(bot) < Math.max(7, 6 + 0.42 * depth, back) + (door ? 2.5 : 0)) {
        drowning = true
        sub.abort()
        try { bot.stopDigging() } catch {} // копка под водой — секунды; бросить сразу
      }
    }, 200)
    let res
    try {
      res = await fn(sub)
    } catch (e) {
      lastErr = e
      if (!drowning) throw e
    } finally { gameClock.clearInterval(guard) }
    if (ctl.aborted) return null
    // Дело сделано под водой — наверх сразу, пока воздуха больше порога тактики.
    if (!drowning) { if (air(bot) < 16 && (headWet(bot) || swimming(bot))) await breathe(bot, ctl, 15000, session); return res }
    // Глубоко и есть дверь — карман воздуха на месте (дверь в воде не заливается: голова в её клетке дышит), не подъём.
    if (!await airPocket(session, ctl) && !await breathe(bot, ctl, 15000, session)) return null
    if (dive === dives - 1 && res !== undefined) return res
  }
  if (lastErr) throw lastErr
  return null
}

// Карман воздуха под водой: дверь в соседнюю клетку на дне (DoorBlock не заливается водой: в его клетках воды нет, и
// голова в них дышит — LivingEntity.isEyeInFluid), открыть (закрытая — стенка между нами), шагнуть в неё и отдышаться.
// Только стоя на твёрдом и глубже 5 бл.: мельче — быстрее всплыть. Клетки соседей: вода в обеих (видны — рядом с телом),
// твёрдое под ними. true — воздух набран.
async function airPocket (session, ctl) {
  const bot = session.bot
  // ND_AIR_POCKET=1 — включить (ферма 14.10: карман дверью вышел 1 раз из 3, два раза — смерть под водой; без него глубже 16 не ныряю).
  if (ctl.aborted || process.env.ND_AIR_POCKET !== '1') return false
  const door = bot.inventory.items().find(i => /_door$/.test(i.name) && i.name !== 'iron_door')
  const surf = bot._ndSurface || bot._ndLastAir
  const depth = surf ? surf.y - bot.entity.position.y : 0
  if (!door || !bot.entity.onGround || !headWet(bot) || depth < 5) return false
  // Свой карман рядом — к нему (breathe идёт по следу), новую дверь не тратить.
  const pk = bot._ndPocket
  if (pk && bot.entity.position.distanceTo(pk) < 10 && (!(require('../perception/eyes') as typeof import('../perception/eyes')).seesNow(bot, pk) || /_door$/.test((bot.blockAt(pk) || {}).name || ''))) return false
  const feet = bot.entity.position.floored()
  const isWater = p => { const b = bot.blockAt(p); return !!b && b.name === 'water' }
  const cells = []
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const q = feet.offset(dx, 0, dz)
    // Соседние клетки и опора под ними — только видимые (ревью Codex q2).
    if (!(require('../perception/eyes') as typeof import('../perception/eyes')).seesNow(bot, q) || !(require('../perception/eyes') as typeof import('../perception/eyes')).seesNow(bot, q.offset(0, 1, 0))) continue
    if (!(require('../pick') as typeof import('../pick')).faceAim(bot, q.offset(0, -1, 0), new Vec3(0, 1, 0))) continue
    const under = bot.blockAt(q.offset(0, -1, 0))
    if (isWater(q) && isWater(q.offset(0, 1, 0)) && under && under.boundingBox === 'block' && !NO_DIG.test(under.name)) cells.push({ q, under })
  }
  if (!cells.length) return false
  let placed = false
  let cell = null
  try {
    await bot.equip(door, 'hand')
    // Стенка закрытой двери встаёт у ближнего края её клетки (DoorBlock.getShape по взгляду ставящего): тело — в середину
    // своей клетки, иначе рамка задевает стенку и сервер дверь не ставит.
    const mid = feet.offset(0.5, 0, 0.5)
    for (let i = 0; i < 10 && Math.hypot(bot.entity.position.x - mid.x, bot.entity.position.z - mid.z) > 0.12; i++) {
      await bot.lookAt(mid.offset(0, 1.5, 0), true)
      bot.setControlState('forward', true); await sleep(60); bot.setControlState('forward', false); await sleep(60)
    }
    for (const c of cells) {
      await bot.lookAt(c.under.position.offset(0.5, 1, 0.5), true)
      const ok = await Promise.race([bot.placeBlock(c.under, new Vec3(0, 1, 0)).then(() => true, () => false), sleep(1200).then(() => false)])
      const d = bot.blockAt(c.q)
      if (ok || (d && /_door$/.test(d.name))) { placed = true; cell = c; break }
    }
    if (!placed) return false
    const d = bot.blockAt(cell.q)
    if (d && /_door$/.test(d.name) && String(d.getProperties().open) === 'false') { await bot.activateBlock(d); await sleep(250) }
    // В клетку двери: шаг к её середине, пока голова не в ней.
    const c = cell.q.offset(0.5, 0, 0.5)
    const t1 = gameClock.now()
    while (!ctl.aborted && gameClock.now() - t1 < 2500 && headWet(bot)) {
      await bot.lookAt(c.offset(0, 1.6, 0), true)
      bot.setControlState('forward', Math.hypot(bot.entity.position.x - c.x, bot.entity.position.z - c.z) > 0.15)
      await sleep(100)
    }
  } catch {} finally { bot.setControlState('forward', false) }
  const t0 = gameClock.now()
  while (!ctl.aborted && gameClock.now() - t0 < 6000 && air(bot) < 19) await sleep(150)
  const ok = air(bot) >= 19
  if (ok) bot._ndPocket = cell.q.clone()
  try { session.journal.append('под водой', `карман воздуха дверью на ${cell.q.x},${cell.q.y},${cell.q.z} (глубина ${Math.round(depth)}): ${placed ? '' : 'дверь не встала, '}${ok ? 'воздух набран' : 'не помогло'}`, bot.entity.position) } catch {}
  return ok
}

export { air, headWet, breathe, underwater, swimming, swimTo, withAir }
