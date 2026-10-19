'use strict'
// Подручное (utility.ts): ловушки — застрял ли он, наковальня над ним, коробка 1×2, лава на застрявшего.
import * as gameClock from '../game-clock'
import * as read from '../read'
import * as hazards from '../hazards'
import { raySees } from '../perception'
import { placeBlockAt, pickFiller } from '../build'
import { sleep } from '../movement'
import { EYE, USE_RANGE, TICK_MS, findItem, countOf, hpOf, solidAt, nameAt, airAt } from './common'

// ================================================================ ловушки

// Застрял ли он: паутина у ног или головы, яма в клетку шириной, коробка.
function stuckOf (bot, e) {
  const f = e.position.floored()
  let walls = 0
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (solidAt(bot, f.offset(dx, 0, dz)) && solidAt(bot, f.offset(dx, 1, dz))) walls++
  if (walls >= 4) return 'коробка'
  if (nameAt(bot, f) === 'cobweb' || nameAt(bot, f.offset(0, 1, 0)) === 'cobweb') return 'паутина'
  try { if (hazards.pitTrap(bot, e.position)) return 'яма' } catch {}
  return null
}

// Наковальня над ним: самая высокая клетка его столба (до +6 над ногами), куда
// дотянуться (≤ 4.4 от глаз), путь вниз свободен, есть к чему прислонить (блок
// сбоку или сверху). Нет опоры — столбик рядом из заполнителя. Урон при посадке
// на пол его клетки: floor(2·ceil(h − 1)) до брони и шлема (×0.75).
function anvilPlan (bot, e, { build = true }: any = {}) {
  if (!findItem(bot, i => /anvil$/.test(i.name))) return null
  const f = e.position.floored()
  const eye = bot.entity.position.offset(0, EYE, 0)
  const filler = build ? pickFiller(bot) : null
  const fillN = filler ? countOf(bot, filler.name) : 0
  for (let k = 6; k >= 2; k--) {
    const cell = f.offset(0, k, 0)
    if (cell.offset(0.5, 0.5, 0.5).distanceTo(eye) > USE_RANGE) continue
    let clear = true
    for (let y = 2; y <= k; y++) if (!airAt(bot, f.offset(0, y, 0))) { clear = false; break }
    if (!clear) continue
    const dmg = Math.min(40, Math.floor(2 * Math.ceil(k - 1)))
    const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    if (solidAt(bot, cell.offset(0, 1, 0)) || sides.some(([dx, dz]) => solidAt(bot, cell.offset(dx, 0, dz)))) return { cell, k, dmg, support: [] }
    if (!filler) continue
    // Столбик опоры: соседняя колонка ближе к нам, снизу до высоты k.
    const me = bot.entity.position
    const side = sides.map(([dx, dz]) => f.offset(dx, 0, dz)).sort((a, b) => Math.hypot(a.x + 0.5 - me.x, a.z + 0.5 - me.z) - Math.hypot(b.x + 0.5 - me.x, b.z + 0.5 - me.z))
    for (const col of side) {
      if (col.equals(bot.entity.position.floored())) continue
      const need = []
      let ok = true
      for (let y = 0; y <= k; y++) {
        const c = col.offset(0, y, 0)
        if (solidAt(bot, c)) continue
        if (!airAt(bot, c) || c.offset(0.5, 0.5, 0.5).distanceTo(eye) > USE_RANGE) { ok = false; break }
        need.push(c)
      }
      if (ok && need.length <= fillN && need.length <= 6) return { cell, k, dmg, support: need }
    }
  }
  return null
}

async function dropAnvil (bot, ctl, e, plan) {
  for (const c of plan.support) {
    if (ctl.aborted) return { ok: false, why: 'прервали' }
    const r = await placeBlockAt(bot, c, { timeoutMs: 600, honest: true }).catch(() => ({ ok: false }))
    if (!r.ok) return { ok: false, why: 'опора не встала: ' + (r.reason || '?') }
  }
  // Паутина в его столбе обнуляет падение и наковальне (WebBlock.entityInside →
  // makeStuckInBlock у любой сущности: resetFallDistance) — замер 2026-09-26:
  // наковальня с 6 бл. сквозь паутину сняла 0. Срезать мечом (0.4 с), потом ронять.
  const f = e.position.floored()
  for (const c of [f.offset(0, 1, 0), f]) {
    const b = bot.blockAt(c)
    if (!b || b.name !== 'cobweb') continue
    const sw = findItem(bot, i => /_sword$|^shears$/.test(i.name))
    if (!sw) return { ok: false, why: 'паутину в его клетке нечем срезать' }
    try { await bot.equip(sw, 'hand'); await Promise.race([bot.dig(b, true), sleep(1500)]) } catch {}
    if (nameAt(bot, c) === 'cobweb') return { ok: false, why: 'паутина в его клетке не срезалась' }
  }
  const anvil = findItem(bot, i => /anvil$/.test(i.name))
  if (!anvil) return { ok: false, why: 'наковальни нет' }
  const hp0 = hpOf(bot, e)
  const r = await placeBlockAt(bot, plan.cell, { item: anvil.name, timeoutMs: 600, honest: true }).catch(() => ({ ok: false }))
  if (!r.ok) return { ok: false, why: 'наковальня не встала: ' + (r.reason || '?') }
  // Падает через 2 тика (FallingBlock: delay after place), летит ~k блоков.
  let hpMin = hp0
  const t0 = gameClock.now()
  while (gameClock.now() - t0 < 1300) { const h = hpOf(bot, e); if (h != null && (hpMin == null || h < hpMin)) hpMin = h; await sleep(TICK_MS) }
  return { ok: true, k: plan.k, dmg: plan.dmg, dealt: hp0 != null && hpMin != null ? Math.round((hp0 - hpMin) * 10) / 10 : null, built: plan.support.length }
}

// Запереть в коробке 1×2: четыре стороны на уровне ног и головы. Он в паутине
// (вчетверо медленнее) — успеваем; крыши нет — сверху наковальня.
function blockInPlan (bot, e) {
  const filler = pickFiller(bot)
  if (!filler) return null
  const f = e.position.floored()
  const eye = bot.entity.position.offset(0, EYE, 0)
  const cells = []
  for (const dy of [0, 1]) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const c = f.offset(dx, dy, dz)
      if (solidAt(bot, c)) continue
      if (!airAt(bot, c) || c.offset(0.5, 0.5, 0.5).distanceTo(eye) > USE_RANGE) return null
      if (c.equals(bot.entity.position.floored()) || c.equals(bot.entity.position.floored().offset(0, 1, 0))) return null
      cells.push(c)
    }
  }
  if (!cells.length || cells.length > countOf(bot, filler.name)) return null
  // Больше трёх блоков не ставить: один встаёт за 3–4 тика, а из паутины он
  // выходит за 0.3–0.5 с (водой) — восемь блоков вокруг открытого поля не
  // успевают никогда (живая арена 2026-09-26: «коробка не сомкнулась» 23 раза
  // из 27, и каждая оставляла на арене мусор, который потом ломали и обходили).
  // Коробка — когда он уже почти заперт: в углу, у стены, в своей же стенке.
  if (cells.length > 3) return null
  return { cells }
}
async function blockIn (bot, ctl, e, plan) {
  let placed = 0
  for (const c of plan.cells) {
    if (ctl.aborted) break
    const r = await placeBlockAt(bot, c, { timeoutMs: 500, honest: true }).catch(() => ({ ok: false }))
    if (r.ok) placed++
  }
  return { ok: stuckOf(bot, e) === 'коробка', placed }
}

// Лава на того, кто застрял: в паутине — в верхнюю грань паутины (клетка его
// головы, стечёт вниз, паутину сожжёт); в яме — в верхнюю грань блока под ним.
function lavaPlan (bot, e) {
  if (!findItem(bot, i => i.name === 'lava_bucket')) return null
  if (read.effectsOf(bot, e).has('fire_resistance')) return null
  const f = e.position.floored()
  const eye = bot.entity.position.offset(0, EYE, 0)
  const me = bot.entity.position
  if (Math.hypot(f.x + 0.5 - me.x, f.z + 0.5 - me.z) < 2.2) return null
  let aim = null
  if (nameAt(bot, f) === 'cobweb') aim = { pt: f.offset(0.5, 1, 0.5), cell: f.offset(0, 1, 0) }
  else if (nameAt(bot, f.offset(0, 1, 0)) === 'cobweb') aim = { pt: f.offset(0.5, 2, 0.5), cell: f.offset(0, 2, 0) }
  else if (solidAt(bot, f.offset(0, -1, 0)) && airAt(bot, f)) aim = { pt: f.offset(0.5, 0, 0.5), cell: f }
  if (!aim || aim.pt.distanceTo(eye) > USE_RANGE || aim.pt.y > eye.y) return null
  // Луч не должен упереться раньше (в блок между нами).
  if (!raySees(bot, eye, aim.pt)) return null
  return aim
}
async function pourLava (bot, e, plan) {
  const lava = findItem(bot, i => i.name === 'lava_bucket')
  if (!lava) return { ok: false }
  try { await bot.equip(lava, 'hand') } catch { return { ok: false } }
  await bot.lookAt(plan.pt, true).catch(() => {})
  await sleep(60)
  try { bot.activateItem() } catch {}
  await sleep(100)
  const b = bot.blockAt(plan.cell)
  return { ok: !!(b && b.name === 'lava'), cell: plan.cell }
}

export { stuckOf, anvilPlan, dropAnvil, blockInPlan, blockIn, lavaPlan, pourLava }
