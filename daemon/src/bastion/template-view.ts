'use strict'
// Мир для плана закрытого штрека вслепую (координатор 14.10: «бот знает устройство построек, как спидраннер» — план по блокам,
// которые предсказывает шаблон узнанного бастиона, а не по настоящим скрытым блокам). Клетка, которую видно сейчас (луч глаз,
// до 6 бл.), — как в мире; остальное — символ шаблона гипотезы (кусок jigsaw jar 1.21.11, bastion-pieces), вне кусков — незерак.
// Расхождение видимого с шаблоном ловит исполнитель (sealed.execute с S.honest) и сверка целей (bastion).
const { Vec3 } = require('vec3')
const SL = require('../sealed')
const bp = require('../bastion-pieces')

// Символ шаблона → блок того же класса для планировщика (sealed.classOf, digSecondsOf).
const NAME = { '.': 'air', L: 'lava', G: 'gold_block', C: 'chest', g: 'gilded_blackstone', s: 'polished_blackstone_brick_stairs',
  b: 'basalt', M: 'magma_block', B: 'polished_blackstone_bricks', o: 'blackstone' }
const SEE_R = 6

// Куски гипотез из целей: st.pred (wall — размещённый кусок), st.pieces (rememberStarts).
function piecesOf (st) {
  const out = new Map()
  const add = c => { if (c && c.piece && c.t && bp.lib()[c.piece]) out.set(`${c.piece}@${c.t.x},${c.t.y},${c.t.z}r${c.r}`, c) }
  for (const v of (st.pred ? st.pred.values() : [])) add(v.wall)
  for (const c of (st.pieces || [])) add(c)
  return [...out.values()]
}

function templateView (bot, pieces) {
  const Block = require('prismarine-block')(bot.registry)
  const eyes = require('../perception/eyes')
  const fake = new Map()
  const fakeOf = n => {
    if (!fake.has(n)) { const d = bot.registry.blocksByName[n]; fake.set(n, d ? Block.fromStateId(d.defaultState, 0) : null) }
    return fake.get(n)
  }
  const speed = (() => { let s = 1; const P = { stone_pickaxe: 4, iron_pickaxe: 6, diamond_pickaxe: 8, netherite_pickaxe: 9, golden_pickaxe: 12 }; for (const it of bot.inventory.items()) if (P[it.name] > s) s = P[it.name]; return s })()
  const cache = new Map()
  if (bot._ndTemplateObserved?.world !== bot.world) bot._ndTemplateObserved = { world: bot.world, cells: new Map() }
  const observed = bot._ndTemplateObserved.cells
  const get = (x, y, z) => {
    const k = SL.key(x, y, z)
    let v = cache.get(k)
    if (v) return v
    let b = null
    const p = new Vec3(x, y, z)
    if (p.distanceTo(bot.entity.position) <= SEE_R && eyes.seesNow(bot, p)) b = bot.blockAt(p, false)
    if (b) observed.set(k, b)
    else b = observed.get(k)
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
    cls: (x, y, z) => get(x, y, z).c,
    dig: (x, y, z) => get(x, y, z).s,
    name: (x, y, z) => get(x, y, z).name,
    forget: () => cache.clear(),
    template: true
  }
}

module.exports = { templateView, piecesOf, NAME }
