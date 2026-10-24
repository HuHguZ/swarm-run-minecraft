// Ловушка и подкоп под точкой жемчуга (пользователь 24.10: «чем дольше летит жемчуг, тем больше времени подготовиться: ловушку
// поставить, ваншотнуть или блоки сломать под местом, куда кинул, — даже обсидиан, если крутая кирка»). 1.21.11: жемчуг
// (ThrowableProjectile → ProjectileUtil, ClipContext COLLIDER, Fluid.NONE) пролетает сквозь паутину (нет коллизии) и жидкости
// и бьётся о первый твёрдый блок; хозяин появляется в oldPosition() жемчуга (pearl-watch). Отсюда три хода:
//  * лава в клетку над блоком удара — он появляется в ней (горит, 4 урона/тик в лаве + огонь);
//  * паутина туда же — появляется в паутине: ×0.05 по вертикали, ×0.25 вбок (Entity.makeStuckInBlock), уйти не успеет от булавы;
//  * подкоп — сломать блок удара (и под ним): жемчуг летит дальше вниз — он окажется в яме (выход прыжком закрыт), а под
//    пустотой жемчуг вовсе пропадёт (бросок впустую). Новое место — по живому жемчугу (pearlLanding), с учётом вскрытого.
// Что выбрать — по сроку: лава и паутина — ~0.3 с у блока, копка — время инструмента (tools.bestFor), всё плюс подбег.
import { Vec3 } from 'vec3'
import * as gameClock from '../game-clock'
import { pearlLanding } from './pearl-watch'

const REACH = 4.2, RUN = 5.6 // бл., бл./с (спринт)

/** What fits before arrival: [kind, ms] options in preference order (lava, web, dig), given items and dig time. */
export function trapOptions(left: number, runMs: number, kit: { lava: boolean; web: boolean; digMs: number; digOk: boolean }) {
  const out: [string, number][] = []
  const slack = 250 // руки: прицел, пакет, тик сервера
  if (kit.lava && runMs + 300 + slack <= left) out.push(['lava', runMs + 300])
  if (kit.web && runMs + 300 + slack <= left) out.push(['web', runMs + 300])
  if (kit.digOk && runMs + kit.digMs + slack <= left) out.push(['dig', runMs + kit.digMs])
  return out
}

export async function pearlTrap(session: any, ctl: any, p: any = {}) {
  const bot = session.require()
  const arrival = gameClock.now() + Number(p.eta) * 50, left = () => arrival - gameClock.now()
  if (!p.block) return { ok: false, why: 'нет блока удара' }
  const hitBlock = new Vec3(p.block.x, p.block.y, p.block.z)
  // Клетка появления — где жемчуг был в начале тика удара (p.at): под углом это соседняя с блоком удара (сцена: лава над блоком
  // удара — «он на полу» 2 из 3). Есть под ней пол — лава/паутина туда; нет — над блоком удара.
  const atCell = p.at ? new Vec3(Math.floor(p.at.x), Math.floor(p.at.y), Math.floor(p.at.z)) : null
  const cell = atCell && bot.blockAt(atCell.offset(0, -1, 0), false)?.boundingBox === 'block' ? atCell : hitBlock.offset(0, 1, 0)
  const items = bot.inventory.items(), has = (n: string) => items.some((i: any) => i.name === n)
  const tools: typeof import('../tools') = require('../tools')
  const b0 = bot.blockAt(hitBlock, false)
  if (!b0 || b0.boundingBox !== 'block') return { ok: false, why: 'блок удара не виден' }
  const below = bot.blockAt(hitBlock.offset(0, -1, 0), false)
  const plan0 = tools.bestFor(bot, b0), plan1 = below?.boundingBox === 'block' ? tools.bestFor(bot, below) : { ms: 0 }
  // Подкоп — только если не под ногами у меня и не у своих (своих не роняем), и пара блоков ломается вообще.
  const mine = bot.entity.position.floored()
  const digOk = p.dig !== false && Number.isFinite(plan0.ms) && Number.isFinite(plan1.ms) && !(mine.x === hitBlock.x && mine.z === hitBlock.z)
  const cellFree = bot.blockAt(cell, false)?.boundingBox === 'empty'
  const kit = { lava: has('lava_bucket') && cellFree && p.lava !== false, web: has('cobweb') && cellFree, digMs: plan0.ms + plan1.ms, digOk }
  const target = cell.offset(.5, -.5, .5), eye = () => bot.entity.position.offset(0, 1.62, 0)
  const runMs = () => Math.max(0, eye().distanceTo(target) - REACH) / RUN * 1000
  const opts = trapOptions(left(), runMs(), kit)
  if (!opts.length) return { ok: false, why: `не успеваю: до появления ${Math.round(left())} мс, до блока ${eye().distanceTo(target).toFixed(1)} бл., лава ${kit.lava}, паутина ${kit.web}, копка ${Number.isFinite(kit.digMs) ? Math.round(kit.digMs) + ' мс' : 'нет'}` }
  const kind = opts[0][0]
  bot._ndCombo = { kind: 'pearl_trap', until: gameClock.now() + left() + 1500 }
  try {
    // Подбег до руки — прямо (поле открытое), как засада.
    while (!ctl.aborted && eye().distanceTo(target) > REACH && left() > 0) {
      const me = bot.entity.position
      await bot.look(Math.atan2(-(target.x - me.x), -(target.z - me.z)), 0, true).catch(() => {})
      bot.setControlState('forward', true); bot.setControlState('sprint', true)
      bot.setControlState('jump', !!bot.entity.isCollidedHorizontally)
      await new Promise(r => gameClock.setTimeout(r, 50))
    }
    bot.clearControlStates()
    if (eye().distanceTo(target) > REACH + .3) return { ok: false, why: `не добежал: ${eye().distanceTo(target).toFixed(1)} бл.`, kind }
    if (kind === 'lava') {
      const r = await (require('../cast/bucket') as typeof import('../cast/bucket')).pour(bot, 'lava_bucket', cell.offset(0, -1, 0))
      return { ok: r.ok, kind, why: r.why, lateMs: -Math.round(left()) }
    }
    if (kind === 'web') {
      const r = await (require('../build') as typeof import('../build')).placeBlockAt(bot, cell, { item: 'cobweb', timeoutMs: Math.max(300, left()) })
      return { ok: !!r.ok, kind, why: r.reason, lateMs: -Math.round(left()) }
    }
    // Подкоп: блок удара, потом под ним; каждый — лучшим инструментом.
    let dug = 0
    for (const at of [hitBlock, hitBlock.offset(0, -1, 0)]) {
      if (ctl.aborted || left() < 100) break
      const b = bot.blockAt(at, false)
      if (!b || b.boundingBox !== 'block') continue
      const r = await tools.breakFast(bot, at, { maxMs: Math.max(200, left()) })
      if (!r.ok) break
      dug++
    }
    // Куда теперь упадёт: живой жемчуг, мир уже со вскрытым.
    const e = p.id != null ? bot.entities[p.id] : null
    const land = e?.position && e.velocity ? pearlLanding({ blockAt: (q: Vec3) => bot.blockAt(q, false) }, e.position, e.velocity) : null
    const drop = land ? +(p.at.y - land.at.y).toFixed(1) : null
    return { ok: dug > 0, kind, dug, lateMs: -Math.round(left()), newAt: land ? { x: +land.at.x.toFixed(2), y: +land.at.y.toFixed(2), z: +land.at.z.toFixed(2) } : null, drop, lost: !!e && !land }
  } finally { delete bot._ndCombo; bot.clearControlStates() }
}
