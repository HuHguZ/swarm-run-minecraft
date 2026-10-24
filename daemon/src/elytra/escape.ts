'use strict'
// Элитры (elytra.ts): уход с фейерверками — куда, на какой высоте, лечение в воздухе.
const gameClock: typeof import('../game-clock') = require('../game-clock')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const { BODY_H, sleep, yawTo, r2, nextTick }: typeof import('./consts') = require('./consts')
const { worldOf }: typeof import('./physics') = require('./physics')
const { findItem, countOf, offName, rocketCount, toHotbar }: typeof import('./kit') = require('./kit')
const { install, arenaAround }: typeof import('./install') = require('./install')
const { fly, takeoff, landingSpot, land, chestDown }: typeof import('./flight') = require('./flight')

// ---------------------------------------------------------------- тактики

// Куда уходить: из 16 сторон вокруг себя — где дальше от него и есть место до
// стены (arenaAround), на высоте cruiseY.
function farPoint (bot, W, foe, cruiseY) {
  const me = bot.entity.position
  const ar = arenaAround(bot, W, new Vec3(me.x, cruiseY, me.z))
  let best = null
  for (const d of ar.dirs) {
    const reach = Math.max(0, d.d - 5)
    for (const k of [0.4, 0.7, 1]) {
      const run = reach * k
      const x = me.x - Math.sin(d.yaw) * run
      const z = me.z - Math.cos(d.yaw) * run
      const sc = Math.hypot(x - foe.x, z - foe.z)
      if (!best || sc > best.sc) best = { sc, at: new Vec3(x, cruiseY, z) }
    }
  }
  return best ? best.at : new Vec3(me.x, cruiseY, me.z)
}

// Высота круга: под потолком с запасом (рамка 1.8 и крен) и не выше, чем
// нужно, чтобы его рука и прыжок не достали: его ноги + 6.
function cruiseAlt (bot, W, foe) {
  const me = bot.entity.position
  const ar = arenaAround(bot, W, me)
  const top = ar.ceilY - BODY_H - 1.6
  return Math.min(top, Math.max(foe.y + 7, me.y + 4))
}

// Съесть или выпить в воздухе: предмет в правую, «использовать», ждать, пока
// его станет меньше (32 тика), руль — у полёта (он крутит взгляд на тике).
async function consumeAir (bot, ctl, item, { maxMs = 2600, safe = () => true }: any = {}) {
  if (!item) return false
  const name = item.name
  const had = countOf(bot, name) + (offName(bot) === name ? bot.inventory.slots[45].count : 0)
  const before = offName(bot)
  const offhand = !bot.usingHeldItem && /(?:_sword|_axe|_spear)$|^mace$/.test(bot.heldItem?.name ?? '')
  try {
    if (offhand) await bot.equip(item, 'off-hand')
    else {
      const idx = await toHotbar(bot, (it) => !!it && it.name === name)
      if (idx < 0) await bot.equip(item, 'hand')
      else if (bot.quickBarSlot !== idx) bot.setQuickBarSlot(idx)
    }
  } catch { return false }
  try {
  await nextTick(bot)
  if (ctl.aborted || !safe() || (offhand ? offName(bot) !== name : bot.heldItem?.name !== name)) return false
  bot.activateItem(offhand)
  const t0 = gameClock.now()
  while (gameClock.now() - t0 < maxMs && !ctl.aborted && countOf(bot, name) + (offName(bot) === name ? bot.inventory.slots[45].count : 0) >= had) {
    if (!bot.entity || !bot.entity.elytraFlying || !safe()) break
    await sleep(50)
  }
  const ok = countOf(bot, name) + (offName(bot) === name ? bot.inventory.slots[45].count : 0) < had
  if (!ok) { try { bot.deactivateItem() } catch {} }
  return ok
  } finally {
    if (offhand && before && before !== name && !ctl.aborted) {
      const previous = findItem(bot, before)
      if (previous) await bot.equip(previous, 'off-hand').catch(() => {})
    }
  }
}

// Уход с фейерверками: взлёт прочь от него, круг под потолком, лечение в
// воздухе (яблоко, питьё — 32 тика), посадка подальше от него, нагрудник
// обратно. Его меч в воздухе не достаёт, стрела по цели 0.6×0.6 на 1–1.7 б/т —
// редко. heal() — чем лечиться сейчас (или null), enough() — хватит ли.
async function escape (bot, ctl, e, { heal, enough = () => (bot.health ?? 0) >= 16, stats = {}, used = () => {}, maxMs = 16000, allow = null, arena = null }: any = {}) {
  const W = worldOf(bot, { observed: !!arena })
  const S = install(bot)
  const out: any = { ok: false, ate: [], hp0: r2(bot.health ?? 0), note: '' }
  const t0 = gameClock.now()
  const foe = () => (e && e.isValid !== false && e.position) ? e.position : bot.entity.position
  const away = yawTo(foe(), bot.entity.position)
  // Арена (живой прогон 2026-09-27): жуя в планировании, бот провалился в
  // дыру пола и сел на землю под Колизеем, в 56 блоках ниже поля. Над полем —
  // не ниже пола + 5, жевать — только с запасом высоты, просел к полу — глоток
  // бросить (ракеты при занятой руке нет), садиться — на поле.
  const floorRef = () => arena ? arena.y : foe().y
  const onField = (x, z) => !arena || (Math.abs(x - arena.x) <= arena.r - 1 && Math.abs(z - arena.z) <= arena.r - 1)
  if (allow) allow()
  const to = await takeoff(bot, ctl, { pitch: 1.05, yaw: away, stats, arena })
  if (!to.ok) { out.note = 'уход на элитрах: не взлетел — ' + to.why; await chestDown(bot, ctl, { stats, arena }); return out }
  stats.escapes = (stats.escapes || 0) + 1
  used('элитры: взлёт — ухожу лечиться в воздух')
  let target = farPoint(bot, W, foe(), cruiseAlt(bot, W, foe()))
  let pickAt = gameClock.now()
  let phase = 'climb'
  let eating = null
  let hurtAir = 0
  let hpPrev = bot.health ?? 20
  const onHp = () => { const h = bot.health ?? 20; if (h < hpPrev) hurtAir += hpPrev - h; hpPrev = h }
  bot.on('health', onHp)
  const alt = () => cruiseAlt(bot, W, foe())
  const r: any = await fly(bot, ctl, { arena,
    maxMs, phase: 'уход',
    stats,
    goal: () => {
      if (gameClock.now() - pickAt > 500) { target = farPoint(bot, W, foe(), alt()); pickAt = gameClock.now() }
      return { kind: 'point', at: target, minY: Math.max(foe().y + 4.5, arena ? arena.y + 5 : -1e9), maxY: alt() + 1.5, gap: 3.5, speedMin: 0.55, away: foe(), awayR: 10 }
    },
    // Во время глотка рука занята — ракет нет; до него — когда низко или медленно.
    noRocket: () => !!eating,
    rocketIf: (st) => (st.p.y < Math.max(foe().y, floorRef()) + 5 || Math.hypot(st.v.x, st.v.z) < 0.45) ? true : null,
    onTick: () => {
      if (allow) allow()
      const me = bot.entity.position
      const dh = Math.hypot(me.x - foe().x, me.z - foe().z)
      if (phase === 'climb' && ((me.y > foe().y + 5 && dh > 7) || gameClock.now() - t0 > 2500)) phase = 'heal'
      if (arena && eating && me.y < floorRef() + 3) { try { bot.deactivateItem() } catch {} }
      if (phase === 'heal' && !eating && !(arena && me.y < floorRef() + 5)) {
        const it = heal ? heal() : null
        if (!it || enough()) { phase = 'land'; return }
        eating = consumeAir(bot, ctl, it, { safe: () => bot.entity.position.distanceTo(foe()) > 8 && !bot._ndDescend }).then(ok => { if (ok) { out.ate.push(it.name); used('элитры: ' + (/potion/.test(it.name) ? 'выпил' : 'съел') + ' в воздухе ' + it.name) } eating = null; if (!ok) phase = 'land' })
      }
    },
    until: () => (phase === 'land' && !eating) ? 'лечение' : (rocketCount(bot) === 0 && bot.entity.position.y < foe().y + 3 ? 'ракеты кончились' : null)
  })
  if (eating) { try { await eating } catch {} }
  // Посадка: подальше от него, на целый пол.
  let l: any = { ok: !!bot.entity.onGround, why: r.why }
  if (bot.entity.elytraFlying) {
    const inside = arena ? onField : null
    const fy = arena ? arena.y : foe().y
    const spot = landingSpot(bot, W, { near: target, away: foe(), floorY: fy, radius: 16, minFromAway: 8, inside }) || landingSpot(bot, W, { near: bot.entity.position, away: foe(), floorY: fy, inside })
    l = await land(bot, ctl, { at: spot, away: foe(), stats, arena })
  }
  bot.removeListener('health', onHp)
  const sw = await chestDown(bot, ctl, { stats, away: foe(), arena })
  out.ok = !!l.ok
  out.hp1 = r2(bot.health ?? 0)
  out.hurtAir = r2(hurtAir)
  out.ms = gameClock.now() - t0
  out.chest = sw.ok
  stats.escapeMs = (stats.escapeMs || 0) + out.ms
  stats.escapeHp = r2((stats.escapeHp || 0) + ((bot.health ?? 0) - out.hp0))
  stats.hurtAir = r2((stats.hurtAir || 0) + hurtAir)
  out.note = `элитры: уход ${Math.round(out.ms / 100) / 10} с, хп ${out.hp0}→${out.hp1}${out.ate.length ? ', ' + out.ate.join(' + ') : ''}${hurtAir ? `, в воздухе −${out.hurtAir}` : ''}, посадка ${l.ok ? 'цела' : (l.why || '?')}${l.lost ? ' −' + l.lost : ''}${sw.ok ? '' : ', нагрудник не надел: ' + sw.why}`
  void S
  return out
}

export {
  farPoint, cruiseAlt, consumeAir, escape
}
