'use strict'
// Помощь союзнику в командном бою (показ 10.10, 6 на 6): взрывное зелье лечения ему под ноги и стенка прикрытия —
// два блока между ним и тем, кто его бьёт. Только честно: зелье — взглядом на его ноги и бросок (use_item), блок —
// на видимую грань опоры (pick.faceAim, как кристалл и лодка), не сквозь стену.
const Vec3 = require('vec3')
const pick = require('../pick')

// Только лечение и регенерация по содержимому (13.10, соло-арена: «зельки неправильно кидают и сами себе урон наносят» —
// бралось любое взрывное зелье, а в сундуках соло лежат и вред, и яд: «лечение под ноги» вредом себе и своим).
const HEAL_KIND = /^(strong_)?healing$|^(long_|strong_)?regeneration$/
const healPot = (bot: any) => {
  const potionOf = require('../pvp').potionOf
  return bot.inventory.items().find((i: any) => i.name === 'splash_potion' && HEAL_KIND.test(potionOf(i) || ''))
}
// В руке — то самое зелье (у одноимённых зелий equip мог взять соседний слот, pvp/equipment.holdItem).
const heldIsHeal = (bot: any) => bot.heldItem?.name === 'splash_potion' && HEAL_KIND.test(require('../pvp').potionOf(bot.heldItem) || '')
const BLOCK = /^(cobblestone|oak_planks|stone|dirt|obsidian|netherrack)$/

async function hold (bot: any, item: any) {
  if (bot.heldItem?.name === item.name && bot.heldItem?.slot === item.slot) return
  await bot.equip(item, 'hand')
}

// Бросить зелье лечения ему под ноги. Радиус всплеска 4 бл. — бросаю с ≤ 5 бл. (меня тоже заденет, не беда).
export async function healAlly (bot: any, ally: any) {
  if (!ally?.position) return { ok: false, why: 'союзника не видно' }
  const d = bot.entity.position.distanceTo(ally.position)
  if (d > 5) return { ok: false, why: `далеко ${d.toFixed(1)} бл.` }
  const pot = healPot(bot)
  if (!pot) return { ok: false, why: 'зелий лечения нет' }
  const was = bot.heldItem
  await hold(bot, pot)
  if (!heldIsHeal(bot)) return { ok: false, why: 'в руке не лечение' }
  await bot.lookAt(ally.position.offset(0, 0.1, 0), true)
  bot.activateItem()
  await bot.waitForTicks(2)
  if (was && was.name !== pot.name) { const back = bot.inventory.items().find((i: any) => i.name === was.name); if (back) await hold(bot, back).catch(() => {}) }
  return { ok: true, why: `зелье ${ally.username || ally.name} с ${d.toFixed(1)} бл.` }
}

// Стенка: клетка рядом с ним в сторону врага (по главной оси), два блока — ноги и голова. Опора — блок под клеткой
// (верхняя грань) или уже поставленный нижний.
export async function wallFor (bot: any, ally: any, foe: any) {
  if (!ally?.position || !foe?.position) return { ok: false, why: 'не вижу обоих' }
  const blk = bot.inventory.items().find((i: any) => BLOCK.test(i.name))
  if (!blk) return { ok: false, why: 'блоков нет' }
  const a = ally.position.floored(); const dx = foe.position.x - ally.position.x; const dz = foe.position.z - ally.position.z
  const step = Math.abs(dx) >= Math.abs(dz) ? new Vec3(Math.sign(dx), 0, 0) : new Vec3(0, 0, Math.sign(dz))
  const me = bot.entity.position.floored()
  const fp = foe.position.floored()
  // Клетка вплотную к нему, а занята телом (враг, я) — на шаг дальше (показ 10.10: 0 стенок из 8 — «грань не видно»).
  const cells = [a.plus(step), a.plus(step.scaled(2))].filter(c => !c.equals(me) && !c.offset(0, 1, 0).equals(me) && !c.equals(fp) && !c.offset(0, 1, 0).equals(fp))
  if (!cells.length) return { ok: false, why: 'клетки заняты телами' }
  // Опора — любая видимая грань соседа: верх блока снизу или бок соседа по горизонтали (тела заслоняют верх пола).
  const FACES = [new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
  const placeAt = async (at: any) => {
    for (const n of FACES) {
      const base = at.minus(n)
      const ref = bot.blockAt(base)
      if (!ref || ref.boundingBox !== 'block') continue
      const pt = pick.faceAim(bot, base, n)
      if (!pt) continue
      await bot._genericPlace(ref, n, { forceLook: true, delta: pt.minus(base), swingArm: 'right' })
      await bot.waitForTicks(1)
      if (bot.blockAt(at)?.boundingBox === 'block') return true
    }
    return false
  }
  const was = bot.heldItem
  let placed = 0
  try {
    await hold(bot, blk)
    for (const cell of cells) {
      for (const y of [0, 1]) {
        const at = cell.offset(0, y, 0)
        const here = bot.blockAt(at)
        if (!here) break
        if (here.boundingBox !== 'empty') continue
        if (await placeAt(at)) placed++
        else break
      }
      if (placed) break
    }
  } catch (e: any) { return { ok: placed > 0, placed, why: 'клик: ' + e.message } } finally {
    if (was && was.name !== blk.name) { const back = bot.inventory.items().find((i: any) => i.name === was.name); if (back) await hold(bot, back).catch(() => {}) }
  }
  return { ok: placed > 0, placed, why: placed ? `стенка ${placed} бл. у ${ally.username || ally.name}` : 'грань не видно' }
}

// Бросок в точку (crowd.healPlan: место, где всплеск вылечит больше своих): взгляд на точку пола, use_item.
export async function healAt (bot: any, at: any) {
  let d = bot.entity.position.distanceTo(new Vec3(at.x, at.y, at.z))
  // Точку отнесло (взрыв отбросил лекаря на 12–22 бл., показ 10.10) — себе под ноги: на сбор бегут ко мне.
  if (d > 5.5) { at = bot.entity.position; d = 0 }
  const pot = healPot(bot)
  if (!pot) return { ok: false, why: 'зелий лечения нет' }
  const was = bot.heldItem
  await hold(bot, pot)
  if (!heldIsHeal(bot)) return { ok: false, why: 'в руке не лечение' }
  await bot.lookAt(new Vec3(at.x, at.y + 0.1, at.z), true)
  bot.activateItem()
  await bot.waitForTicks(2)
  if (was && was.name !== pot.name) { const back = bot.inventory.items().find((i: any) => i.name === was.name); if (back) await hold(bot, back).catch(() => {}) }
  return { ok: true, why: `зелье в точку с ${d.toFixed(1)} бл.` }
}

// Кинуть союзнику вещь в бою (Q): он ≤ 4 бл. и виден — взгляд на его грудь, выброс стака (скорость броска — от
// взгляда). Без похода к нему: give (handover) искал пеший путь и в бою на рельефе/в полёте не дошёл ни разу (0/32).
export async function tossTo (bot: any, ally: any, name: string, count = 1) {
  if (!ally?.position) return { ok: false, why: 'союзника не видно' }
  const d = bot.entity.position.distanceTo(ally.position)
  // ≤ 3 бл. и в ноги: с 4 бл. стак ложился мимо (показ 10.10: 7 бросков, подобрано 0) — подбор только вплотную.
  if (d > 3) return { ok: false, why: `далеко ${d.toFixed(1)} бл.` }
  if (!pick.canHit(bot, ally, { range: 4.5 })) return { ok: false, why: 'не вижу его' }
  const it = bot.inventory.items().find((i: any) => i.name === name)
  if (!it) return { ok: false, why: 'нет ' + name }
  await bot.lookAt(ally.position.offset(0, 0.2, 0), true)
  await bot.toss(it.type, null, Math.min(count, it.count))
  return { ok: true, why: `кинул ${name}×${Math.min(count, it.count)} с ${d.toFixed(1)} бл.` }
}

// Подобрать брошенное своим: вещь на земле видна глазами (сущность item) — встать на неё и дождаться задержки подбора
// (брошенное игроком — 40 тиков). Без этого бросок «ложился рядом»: гонка 10.10 — 7 передач каптёра, подобрано 0.
export async function pickup (bot: any, name: string | null, maxD = 6) {
  const me = bot.entity.position
  const seen = (e: any) => { try { return pick.canHit(bot, e, { range: maxD + 1 }) || e.position.distanceTo(me) < 2 } catch { return false } }
  const items = Object.values(bot.entities || {}).filter((e: any) => e && e.name === 'item' && e.position && e.position.distanceTo(me) <= maxD &&
    (!name || (() => { try { return e.getDroppedItem()?.name === name } catch { return true } })()) && seen(e)) as any[]
  const it = items.sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0]
  // Нет на земле, а в рюкзаке есть — уже подобрал сам по дороге (до проверки).
  if (!it) return (name && bot.inventory.items().some((i: any) => i.name === name)) ? { ok: true, why: `уже подобрал ${name}` } : { ok: false, why: 'не вижу вещи' }
  const before = bot.inventory.items().filter((i: any) => !name || i.name === name).reduce((a: number, i: any) => a + i.count, 0)
  const { goals } = require('mineflayer-pathfinder')
  try {
    await Promise.race([bot.pathfinder.goto(new goals.GoalNear(it.position.x, it.position.y, it.position.z, 0.6)), bot.waitForTicks(60)])
  } catch {}
  try { bot.pathfinder.setGoal(null) } catch {}
  for (let t = 0; t < 50 && it.isValid !== false && bot.entities[it.id]; t++) await bot.waitForTicks(1)
  const after = bot.inventory.items().filter((i: any) => !name || i.name === name).reduce((a: number, i: any) => a + i.count, 0)
  return { ok: after > before, why: after > before ? `подобрал ${name || 'вещь'}` : 'не подобрал' }
}

// Уничтожить чужой лут на земле (гонка 10.10: «вещи врага, что нам не нужны, — в лаву или сжечь, чтобы не достались им»):
// лава из ведра на кучу и забрать ведром обратно, иначе огонь огнивом/огненным зарядом. Сам — не ближе 2 бл. к клетке
// (огонь и лава растекаются), опора — видимая грань (pick, как всё остальное). Незерит не горит — его не трогаем.
export async function denyLoot (bot: any, at: any, maxD = 4) {
  const items = Object.values(bot.entities || {}).filter((e: any) => e && e.name === 'item' && e.position &&
    (!at || e.position.distanceTo(new Vec3(at.x, at.y, at.z)) <= maxD)) as any[]
  if (!items.length) return { ok: false, why: 'на земле нет вещей' }
  const tool = ['lava_bucket', 'flint_and_steel', 'fire_charge'].map(n => bot.inventory.items().find((i: any) => i.name === n)).find(Boolean)
  if (!tool) return { ok: false, why: 'нечем уничтожить' }
  const c = items.reduce((a: any, e: any) => a.plus(e.position), new Vec3(0, 0, 0)).scaled(1 / items.length)
  let floor = bot.blockAt(c.floored().offset(0, -1, 0))
  if (floor && floor.boundingBox !== 'block') floor = bot.blockAt(c.floored().offset(0, -2, 0))
  if (!floor || floor.boundingBox !== 'block') return { ok: false, why: 'под вещами нет опоры' }
  const cell = floor.position.offset(0, 1, 0)
  const centre = cell.offset(0.5, 0.5, 0.5)
  const { goals } = require('mineflayer-pathfinder')
  const me = () => bot.entity.position
  if (me().distanceTo(centre) < 2 || me().distanceTo(centre) > 4) {
    const away = me().minus(centre); away.y = 0
    const dir = away.norm() > 0.1 ? away.scaled(1 / away.norm()) : new Vec3(1, 0, 0)
    const spot = centre.plus(dir.scaled(3))
    try { await Promise.race([bot.pathfinder.goto(new goals.GoalNear(spot.x, cell.y, spot.z, 1)), bot.waitForTicks(60)]) } catch {}
    try { bot.pathfinder.setGoal(null) } catch {}
  }
  if (me().distanceTo(centre) > 4.5) return { ok: false, why: 'не подошёл к вещам' }
  const before = items.filter((e: any) => bot.entities[e.id]).length
  await hold(bot, tool)
  let how = ''
  if (tool.name === 'lava_bucket') {
    await bot.lookAt(cell.offset(0.5, 0.05, 0.5), true)
    bot.activateItem()
    await bot.waitForTicks(30)
    how = 'лава'
    const empty = bot.inventory.items().find((i: any) => i.name === 'bucket')
    if (empty) { await hold(bot, empty); await bot.lookAt(cell.offset(0.5, 0.5, 0.5), true); bot.activateItem(); await bot.waitForTicks(5) }
  } else {
    try { await bot._genericPlace(floor, new Vec3(0, 1, 0), { forceLook: true, swingArm: 'right' }) } catch (e: any) { return { ok: false, why: 'не поджёг: ' + e.message } }
    how = 'огонь'
    await bot.waitForTicks(30)
  }
  const after = items.filter((e: any) => bot.entities[e.id]).length
  return { ok: after < before, how, burned: before - after, left: after }
}

// RPC assist: { mode: 'heal' (ally | at) | 'wall' | 'pincer' | 'pickup' | 'deny', ally, foe, at }.
export async function assist (session: any, p: any = {}) {
  const bot = session.require()
  const ent = (name: string) => name && bot.players[name]?.entity
  const ally = ent(p.ally)
  if (p.mode === 'heal') return p.at ? healAt(bot, p.at) : healAlly(bot, ally)
  if (p.mode === 'wall') return wallFor(bot, ally, ent(p.foe))
  if (p.mode === 'toss') return tossTo(bot, ally, p.item, p.count || 1)
  if (p.mode === 'pickup') return pickup(bot, p.item || null, p.maxD || 6)
  if (p.mode === 'deny') return denyLoot(bot, p.at || null, p.maxD || 4)
  return { ok: false, why: 'режим?' }
}

// RPC team_hint (не прерывает бой): клещи в воздухе — напарник бьёт ту же цель из from, таран заходит с другой стороны.
export function hint (session: any, p: any = {}) {
  const bot = session.require()
  bot._ndPincer = p.target && p.from ? { target: p.target, from: p.from, until: Date.now() + 6000 } : null
  return { pincer: !!bot._ndPincer }
}
