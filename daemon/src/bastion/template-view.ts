'use strict'
// Мир для плана закрытого штрека вслепую (координатор 14.10: «бот знает устройство построек, как спидраннер» — план по блокам,
// которые предсказывает шаблон узнанного бастиона, а не по настоящим скрытым блокам). Клетка, которую видно сейчас (луч глаз,
// до 6 бл.), — как в мире; остальное — символ шаблона гипотезы (кусок jigsaw jar 1.21.11, bastion-pieces), вне кусков — незерак.
// Расхождение видимого с шаблоном ловит исполнитель (sealed.execute с S.honest) и сверка целей (bastion).
import { Vec3 } from 'vec3'
import SL = require('../sealed')
import bp = require('../bastion-pieces')

// Символ шаблона → блок того же класса для планировщика (sealed.classOf, digSecondsOf).
const NAME = { '.': 'air', L: 'lava', G: 'gold_block', C: 'chest', g: 'gilded_blackstone', s: 'polished_blackstone_brick_stairs',
  b: 'basalt', M: 'magma_block', B: 'polished_blackstone_bricks', o: 'blackstone' }
const SEE_R = 6

// Куски гипотез из целей: st.pred (wall — размещённый кусок), st.pieces (rememberStarts).
function piecesOf (st) {
  const out = new Map()
  const focus = process.env.ND_BASTION_HYP_FOCUS !== '0' ? st.focusHyp : null
  const add = c => { if (c && c.piece && c.t && bp.lib()[c.piece] && (!focus || c.hyp === focus)) out.set(`${c.piece}@${c.t.x},${c.t.y},${c.t.z}r${c.r}`, c) }
  for (const v of (st.pred ? st.pred.values() : [])) add(v.wall)
  for (const c of (st.pieces || [])) add(c)
  return [...out.values()]
}

function templateView (bot, pieces, state: any = null) {
  const terrain = process.env.ND_BASTION_TERRAIN_MEMORY === '1'
  const Block = (require('prismarine-block') as typeof import('prismarine-block'))(bot.registry)
  const eyes: typeof import('../perception/eyes') = require('../perception/eyes')
  const fake = new Map()
  const fakeOf = n => {
    if (!fake.has(n)) { const d = bot.registry.blocksByName[n]; fake.set(n, d ? Block.fromStateId(d.defaultState, 0) : null) }
    return fake.get(n)
  }
  const speed = (() => { let s = 1; const P = { stone_pickaxe: 4, iron_pickaxe: 6, diamond_pickaxe: 8, netherite_pickaxe: 9, golden_pickaxe: 12 }; for (const it of bot.inventory.items()) if (P[it.name] > s) s = P[it.name]; return s })()
  const cache = new Map()
  if (bot._ndTemplateObserved?.world !== bot.world || (terrain && bot._ndTemplateObserved?.dimension !== bot.game?.dimension))
    bot._ndTemplateObserved = { world: bot.world, dimension: bot.game?.dimension, cells: new Map() }
  const observed = bot._ndTemplateObserved.cells
  const remember = (k, b) => {
    observed.set(k, b)
    if (process.env.ND_SEALED_OPENING_MEMORY === '1') {
      const cls = SL.classOf(b)
      if (state?.openingFacts?.has(k)) {
        if ([SL.AIR, SL.PARTIAL, SL.FLUID].includes(cls)) state.openingFacts.set(k, cls)
        else state.openingFacts.delete(k)
      }
      if (state?.openings?.has(k) && [SL.SOLID, SL.HARD, SL.GUARD, SL.HOT].includes(cls)) {
        state.openings.delete(k)
        state.own?.delete(k)
        ;(state.filled || (state.filled = new Set())).add(k)
      }
    }
    if (terrain) {
      if (SL.classOf(b) === SL.AIR) state?.filled?.delete(k)
      else state?.own?.delete(k)
    }
  }
  // Only a visible support is remembered; own-air never invents a solid floor.
  const floor = () => {
    if (!terrain || !bot.entity?.onGround) return
    const p = SL.bodyCells(bot)[0].offset(0, -1, 0)
    if (!eyes.seesNow(bot, p)) return
    const b = bot.blockAt(p, false)
    if (b) remember(SL.key(p.x, p.y, p.z), b)
  }
  // Revalidate only previously observed facts, by a fresh nearby ray, once
  // per view/forget. The A* callback itself does not perform extra ray scans.
  const refreshOpenings = () => {
    if (process.env.ND_SEALED_OPENING_MEMORY !== '1') return
    const keys = new Set<string>([...(state?.openings || []), ...(state?.openingFacts?.keys() || [])])
    for (const k of keys) {
      const p = new Vec3(...(k.split(',').map(Number) as [number, number, number]))
      if (p.distanceTo(bot.entity.position) > SEE_R || !eyes.seesNow(bot, p)) continue
      const b = bot.blockAt(p, false)
      if (b) remember(k, b)
    }
  }
  floor()
  refreshOpenings()
  const get = (x, y, z) => {
    const k = SL.key(x, y, z)
    let v = cache.get(k)
    if (v) return v
    let b = null
    const p = new Vec3(x, y, z)
    if (p.distanceTo(bot.entity.position) <= SEE_R && eyes.seesNow(bot, p)) b = bot.blockAt(p, false)
    if (b) remember(k, b)
    else if (terrain && state?.own?.has(k)) b = fakeOf('air')
    else {
      b = observed.get(k)
      if (terrain && state?.filled?.has(k) && (!b || SL.classOf(b) === SL.AIR)) {
        v = { c: SL.UNKNOWN, s: 99, name: '?' }
        cache.set(k, v)
        return v
      }
    }
    if (!b) {
      let sym = ' '
      for (const c of pieces) {
        const [tx, ty, tz] = bp.toTemplate(c, p)
        const s = bp.cellOf(bp.lib()[c.piece], tx, ty, tz)
        if (s !== ' ') { sym = s; break }
      }
      b = fakeOf(NAME[sym] || 'netherrack')
    }
    v = { c: SL.classOf(b), s: b ? SL.digSecondsOf(b, speed) : 99, name: b ? b.name : '?' }
    cache.set(k, v)
    return v
  }
  return {
    cls: (x, y, z) => SL.openingClass(state, x, y, z) ?? get(x, y, z).c,
    dig: (x, y, z) => get(x, y, z).s,
    name: (x, y, z) => get(x, y, z).name,
    forget: () => { cache.clear(); floor(); refreshOpenings() },
    template: true
  }
}

export { templateView, piecesOf, NAME }
