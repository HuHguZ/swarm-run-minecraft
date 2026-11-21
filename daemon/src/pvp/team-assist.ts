'use strict'
// Помощь союзнику в командном бою (показ 10.10, 6 на 6): взрывное зелье лечения ему под ноги и стенка прикрытия —
// два блока между ним и тем, кто его бьёт. Только честно: зелье — взглядом на его ноги и бросок (use_item), блок —
// на видимую грань опоры (pick.faceAim, как кристалл и лодка), не сквозь стену.
import { Vec3 } from './vec3'
import type { Vec3 as Position } from 'vec3'
import * as pick from '../pick'
import { seesPlayer } from './last-seen'
import { observedCollision } from './search'
import type { HealReports } from '../swarm/combos/ideas'
import * as gameClock from '../game-clock'
// Отход дарителя и подбор — честным шагом с проверкой опоры, границ арены и killY (Codex 15.10: «назад 8 тиков» и сырой
// pathfinder.goto уводили в дыры и за упавшей вниз вещью).
import { executeJump, ROUTE_FRAMES, visibleLanding, withinArena, type Cancellation } from '../navigation/parkour'
import { worldOf } from '../navigation/parkour/model'
import { HAZARD, standPositions } from '../navigation/geometry'
import { inPickup, REACH_DOWN, REACH_UP, REACH_XZ } from '../drops'
import { fits, makeRoom, tossPlan, worth } from '../pack'

// Только лечение и регенерация по содержимому (13.10, соло-арена: «зельки неправильно кидают и сами себе урон наносят» —
// бралось любое взрывное зелье, а в сундуках соло лежат и вред, и яд: «лечение под ноги» вредом себе и своим).
const HEAL_KIND = /^(strong_)?healing$|^(long_|strong_)?regeneration$/
const healPot = (bot: any) => {
  const potionOf = (require('./potions') as typeof import('./potions')).potionOf
  return bot.inventory.items().find((i: any) => i.name === 'splash_potion' && HEAL_KIND.test(potionOf(i) || ''))
}
// В руке — то самое зелье (у одноимённых зелий equip мог взять соседний слот, pvp/equipment.holdItem).
const heldIsHeal = (bot: any) => bot.heldItem?.name === 'splash_potion' && HEAL_KIND.test((require('./potions') as typeof import('./potions')).potionOf(bot.heldItem) || '')
const BLOCK = /^(cobblestone|stone|dirt|obsidian|sandstone|smooth_sandstone|netherrack|.*_planks)$/

async function hold (bot: any, item: any) {
  if (bot.heldItem?.name === item.name && bot.heldItem?.slot === item.slot) return
  await bot.equip(item, 'hand')
}

export async function healAlly (bot: any, ally: any, ctl = { aborted: false }, reports?: HealReports, clockId?: string) {
  if (!ally?.position) return { ok: false, why: 'союзника не видно' }
  const was = bot.heldItem
  const allies = reports ? Object.keys(reports).map(name => bot.players[name]?.entity).filter(Boolean) : [ally]
  try {
    const { splashMedic } = require('../swarm/combos/ideas') as typeof import('../swarm/combos/ideas')
    const result = await splashMedic(bot, allies, [], { ctl, care: { patient: ally, reports, clockId } })
    return { ok: result.thrown, why: result.why, ...('threat' in result && { threat: result.threat }),
      ...(result.thrown && 'land' in result && { land: result.land }) }
  } finally {
    if (!ctl.aborted && was && was.name !== 'splash_potion' && (heldIsHeal(bot) || !bot.heldItem)) {
      const back = bot.inventory.items().find((i: any) => i.slot === was.slot && i.name === was.name) || bot.inventory.items().find((i: any) => i.name === was.name)
      if (back) await hold(bot, back).catch(() => {})
    }
  }
}

// Use an existing side face for an immediate screen, or build its support first.
export async function wallFor (bot: any, ally: any, foe: any, ctl: Cancellation = { aborted: false }, p: any = {}, session: any = { bot }) {
  const build = require('../build') as typeof import('../build')
  const { swarmWork } = require('../swarm-work') as typeof import('../swarm-work')
  const bow = require('../bow/ballistics') as typeof import('../bow/ballistics')
  const allies = p.allies ?? bot._ndSwarmAllies ?? []
  const cells: Position[] = []
  const result = (why: string, ok = false) => ({ ok, why, placed: cells.length, cells })
  if (!ally?.username || !foe?.username || ally === foe || !Array.isArray(allies) || allies.includes(foe.username)) return result('invalid_team')
  const team = allies.includes(ally.username) ? allies : [...allies, ally.username]
  let forecast: { from: Position; origin: Position; point: (step: number) => Position; flat: number; solution: ReturnType<typeof bow.aim> } | null = null
  const lane = () => {
    if (ctl.aborted || [ally, foe].some(e => bot.players?.[e.username]?.gamemode === 3 || bot.players?.[e.username]?.entity !== e) || !seesPlayer(bot, ally)) return null
    if (p.whileDraw) {
      const { aims } = require('../threats') as typeof import('../threats')
      if (!aims(bot, null, null, { toward: ally.position, candidates: [foe] }).some(a => a.weapon === 'bow')) return null
    } else if (!seesPlayer(bot, foe)) return null
    const from = ally.position.offset(0, Math.min(1.3, pick.eyeHeight(bot, ally)), 0)
    const origin = foe.position.offset(0, pick.eyeHeight(bot, foe) - .1, 0)
    if (forecast?.from.equals(from) && forecast.origin.equals(origin)) return forecast
    const delta = origin.minus(from), flat = Math.hypot(delta.x, delta.z)
    if (flat <= 1) return null
    const solution = p.whileDraw ? bow.aim(origin, () => from) : null
    if (p.whileDraw && !solution) return null
    const point = (step: number) => {
      const at = from.plus(delta.scaled(step / flat))
      if (solution) at.y = origin.y + bow.flight(solution.pitch, flat - step)!.y
      return at
    }
    return (forecast = { from, origin, flat, point, solution })
  }
  const shot = lane()
  if (!shot) return result('no_visible_threat')
  const stock = bot.inventory.items().filter(i => BLOCK.test(i.name) && i.count > 0)
  if (!stock.length) return result('блоков нет')
  const supply = stock.reduce((n, i) => n + i.count, 0)
  const observed = observedCollision(bot), bodies = pick.hitboxOf(bot, bot.entity)
  const open = at => /^(air|cave_air|void_air)$/.test(observed.blockAt(at)?.name) &&
    !(bodies.lo.x < at.x + 1 && bodies.hi.x > at.x && bodies.lo.y < at.y + 1 && bodies.hi.y > at.y && bodies.lo.z < at.z + 1 && bodies.hi.z > at.z) &&
    !build.occupiedByEntity(bot, at, { visibleOnly: true }) && (!p.arena || withinArena(bot, at.offset(.5, 0, .5), p.arena))
  if (shot.solution) {
    const solids = { blockAt: pos => bot.blockAt(pos, false)?.boundingBox === 'block' ? observed.blockAt(pos) : null }
    const world = { raycast: (start, dir, length) => pick.blockOnRay(solids, start, dir, length)?.block }
    if (bow.blockedAt({ world }, shot.origin, shot.solution)) return result('прострел уже закрыт')
  }
  const face = (world, at) => build.FACES.some(n => world.blockAt(at.minus(n))?.boundingBox === 'block' && pick.faceAim(world, at.minus(n), n))
  const closesExit = (world, at) => build.alliedExitBlocked(world, at, stock[0].name, team)
  const was = bot.heldItem
  try {
    let plan: Position[] | undefined
    for (const step of [1, 2]) {
      if (step >= shot.flat) break
      const cap = shot.point(step).floored()
      if (!open(cap)) continue
      const base = cap.offset(0, -1, 0)
      if (face(bot, cap) && (p.whileDraw || !open(base)) && !closesExit(bot, cap)) { plan = [cap]; break }
      if (plan || supply < 2 || !open(base) || !face(bot, base) || closesExit(bot, base)) continue
      const solid = { position: base, boundingBox: 'block', name: 'stone', shapes: [[0, 0, 0, 1, 1, 1]] }
      const preview = Object.create(bot)
      preview.blockAt = pos => pos.equals(base) ? solid : bot.blockAt(pos)
      if (face(preview, cap) && !closesExit(preview, cap)) plan = [base, cap]
    }
    if (!plan) return result('нет открытой грани для заслона')
    const cap = plan.at(-1)!
    for (const at of plan) {
      const relevant = () => {
        const ray = lane()
        return ray && [1, 2].some(step => step < ray.flat && ray.point(step).floored().equals(cap))
      }
      const item = bot.inventory.items().find(i => BLOCK.test(i.name) && i.count > 0)?.name
      if (!item || !relevant() || build.alliedExitBlocked(bot, at, item, team)) return result('заслон больше не подходит')
      // A confirmed screen can hide the archer. Let the placement executor consume its receipt.
      const local = { onAbort: ctl.onAbort, get aborted () { return ctl.aborted || (bot.blockAt(at)?.name !== item && !relevant()) } }
      const work = await swarmWork(session, local, { kind: 'place', at, item, allies: team, timeoutSeconds: 1 })
      if (!work.ok) return { ...result(work.why), ...(work.safety && { safety: work.safety, retreat: work.retreat }) }
      if (!work.already) cells.push(at)
    }
    return result('прострел закрыт', true)
  } finally {
    if (!ctl.aborted && was && BLOCK.test(bot.heldItem?.name || '') && bot.heldItem?.slot !== was.slot) {
      const back = bot.inventory.items().find(i => i.name === was.name && i.slot === was.slot)
      if (back) await hold(bot, back).catch(() => {})
    }
  }
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
export async function tossTo (bot: any, ally: any, name: string, count = 1, arena?: any, ctl = { aborted: false }) {
  if (!ally?.position) return { ok: false, why: 'союзника не видно' }
  const visible = (gap: number) => pick.canHit(bot, ally, { range: Math.max(4.5, gap + 1) })
  const d = bot.entity.position.distanceTo(ally.position)
  // ≤ 3 бл. и в ноги: с 4 бл. стак ложился мимо (показ 10.10: 7 бросков, подобрано 0) — подбор только вплотную.
  if (!visible(d)) return { ok: false, why: 'не вижу его' }
  if (d > 3) return { ok: false, outOfReach: true, why: `далеко ${d.toFixed(1)} бл.` }
  const it = bot.inventory.items().find((i: any) => i.name === name)
  if (!it) return { ok: false, why: 'нет ' + name }
  await bot.lookAt(ally.position.offset(0, 0.2, 0), true)
  if (ctl.aborted || !bot.entity?.position || !ally?.position || ally.isValid === false) return { ok: false, why: 'передача отменена или союзник ушёл' }
  const gap = bot.entity.position.distanceTo(ally.position)
  if (!visible(gap)) return { ok: false, why: 'не вижу его' }
  if (gap > 3) return { ok: false, outOfReach: true, why: `далеко ${gap.toFixed(1)} бл.` }
  // Всё число сразу (из нескольких стопок): первой стопки не хватало на заявку — «подобрал», а дельта не набрана (Codex 15.10).
  const total = bot.inventory.items().filter((i: any) => i.name === name).reduce((n: number, i: any) => n + i.count, 0)
  await bot.toss(it.type, null, Math.min(count, total))
  // Шаг назад: брошенное подбирается через 40 тиков ближайшим — стоя рядом, донор забирал вещь обратно (14.10).
  // Отказ отхода — не отказ броска: вещь уже брошена.
  if (!ctl.aborted) {
    const at = bot.entity.position.offset(Math.sin(bot.entity.yaw) * 1.5, 0, Math.cos(bot.entity.yaw) * 1.5)
    await executeJump(bot, ctl, at, { allowWalk: true, maxFallDamage: 0, arena, maxFrames: ROUTE_FRAMES }).catch(() => null)
  }
  return { ok: true, why: `кинул ${name}×${Math.min(count, total)} с ${d.toFixed(1)} бл.` }
}

// Подобрать брошенное своим: вещь на земле видна глазами (сущность item) — встать на неё и дождаться задержки подбора
// (брошенное игроком — 40 тиков). Без этого бросок «ложился рядом»: гонка 10.10 — 7 передач каптёра, подобрано 0.
function floorSurvey(bot: any, site: any, arena: any) {
  const me = bot.entity?.position
  if (!me || !site || ![site.x, site.y, site.z].every(Number.isFinite) || !bot.entity.onGround ||
      Math.hypot(me.x - site.x, me.z - site.z) > 3 || Math.abs(me.y - site.y) > 1.25 || !Number.isInteger(me.y)) return
  // A visible item awaiting stack metadata is a reason to keep looking.
  if (Object.values<any>(bot.entities || {}).some(e => e?.name === 'item' && e.position && e.isValid !== false &&
    Math.hypot(e.position.x - site.x, e.position.z - site.z) <= 6 && Math.abs(e.position.y - site.y) <= 6 && seesPlayer(bot, e))) return
  const cx = Math.floor(site.x), cz = Math.floor(site.z), y = Math.abs(me.y - site.y) <= .25 ? me.y : Math.floor(site.y)
  const view = observedCollision(bot, worldOf(bot).getBlock, true)
  const column = (x: number, feet: number, z: number, stance = false) => {
    const base = new Vec3(x, feet - 1, z), floor = view.blockAt(base)
    if (!floor && !stance) return undefined
    if (floor && (HAZARD.test(floor.name) || !floor.shapes?.some(s => s[0] === 0 && s[1] === 0 && s[2] === 0 && s[3] === 1 && s[4] === 1 && s[5] === 1))) return null
    let clear = true
    for (const dy of [1, 2]) {
      const block = view.blockAt(base.offset(0, dy, 0))
      if (!block) {
        if (!stance) return undefined
        clear = false
      } else if (!['air', 'cave_air', 'void_air'].includes(block.name)) return null
    }
    return clear ? floor ?? undefined : undefined
  }
  if (!column(cx, y, cz)) return
  let whole = Math.hypot(me.x - site.x, me.z - site.z) <= 2 && Math.abs(me.y - site.y) <= .25, uneven = false
  for (let x = cx - 6; x <= cx + 6 && !uneven; x++) for (let z = cz - 6; z <= cz + 6; z++) {
    const dx = Math.max(x - site.x, site.x - x - 1, 0), dz = Math.max(z - site.z, site.z - z - 1, 0)
    if (dx * dx + dz * dz > 36) continue
    const floor = column(x, y, z)
    if (!floor) whole = false
    if (floor === null) { uneven = true; break } // a visible obstruction or change in floor, as opposed to missing geometry
  }
  const at = { x: site.x, y: site.y, z: site.z }
  if (whole) return { inspected: at }
  if (!uneven) return
  // Four possible sides, all from the current body's sight. A one-block rise can offer a view over the slope.
  const options = [], ruledOut = []
  for (const [dx, dz] of [[-2, 0], [2, 0], [0, -2], [0, 2]]) for (const feet of [y + 1, y]) {
    const x = cx + dx, z = cz + dz, floor = column(x, feet, z, true), stand = new Vec3(x + .5, feet, z + .5)
    if (floor && withinArena(bot, stand, arena)) { options.push(stand); break }
    if (floor === null) ruledOut.push(stand)
  }
  return { partial: { site: at, from: { x: me.x, y: me.y, z: me.z }, options, ruledOut } }
}

export async function pickup (bot: any, name: string | null, maxD = 6, arena?: any, ctl = { aborted: false }, ownedTarget?: number, surveySite?: any) {
  const generic = !name
  // Slots 5..45 include equipped armor, storage, hotbar and offhand. A delivered item can already be equipped.
  const count = (item = name) => {
    let n = 0
    for (let slot = 5; slot <= 45; slot++) {
      const it = bot.inventory.slots[slot]
      if (it && (!item || it.name === item)) n += it.count
    }
    return n
  }
  let before = count()
  const target = name && Number.isSafeInteger(ownedTarget) && ownedTarget! > 0 ? ownedTarget : undefined
  let previous: { name: string; before: number } | undefined
  const received = () => count() >= (target ?? before + 1) ? name || 'вещь' :
    previous && count(previous.name) > previous.before ? previous.name : null
  const stackOf = (e: any) => { try { return e.getDroppedItem() ?? null } catch { return null } }
  const find = (accept = (stack: any) => !name || stack.name === name, site?: Position) => {
    let nearest, distance = Infinity
    for (const e of Object.values<any>(bot.entities || {})) {
      if (e?.name !== 'item' || !e.position || e.isValid === false) continue
      const d = e.position.distanceTo(bot.entity.position)
      if (d > maxD || d >= distance || site && e.position.distanceTo(site) > maxD || !seesPlayer(bot, e)) continue
      const stack = stackOf(e)
      if (stack?.name && accept(stack)) { nearest = e; distance = d }
    }
    return nearest
  }
  // Entity spawn, stack metadata, merge/despawn and the recipient's slot update arrive separately.
  let missed: Position | undefined
  const waitForDrop = async (limit: number, replaceLost = false) => {
    const canSwitch = replaceLost && generic && surveySite && [surveySite.x, surveySite.y, surveySite.z].every(Number.isFinite)
    for (let tick = 0; !ctl.aborted && !received(); tick++) {
      // A thief, a merge and our own pickup can all remove the selected entity. The next visible
      // stack in a corpse search is actionable while a delayed inventory receipt still counts.
      const it = canSwitch ? find(stack => stack.name === name ||
        fits(bot, stack.name) || tossPlan(bot, { below: worth(stack.name) }).length > 0, surveySite) : find()
      if (it && canSwitch) {
        const next = stackOf(it)?.name
        if (next && name && next !== name) {
          previous = { name, before }
          name = next; before = count(); missed = undefined
        }
      }
      if (it || tick >= limit) return it
      await bot.waitForTicks(1)
    }
  }
  let it = await waitForDrop(20)
  const noCandidate = !it
  if (!name && it) { name = stackOf(it)?.name; before = count() }
  let why = it ? 'не подобрал' : 'не вижу вещи'
  for (let tries = 0; it && tries < 2 && !ctl.aborted && !received(); tries++) {
    const gone = () => it.isValid === false || bot.entities[it.id] !== it
    const there = () => inPickup(bot.entity.position, it.position)
    if (gone() || !seesPlayer(bot, it)) { it = await waitForDrop(10, tries === 0); continue }
    const amount = generic ? 1 : Math.min(stackOf(it)?.count || 1, target ? target - count() : Infinity)
    if (!fits(bot, name, amount)) {
      await makeRoom(bot, { forItem: name, away: it.position, ctl })
      if (ctl.aborted || received()) break
      if (!fits(bot, name, amount)) {
        why = 'нет места для ' + name
        if (!generic || tries > 0) break
        it = find(stack => stack.name !== name && (fits(bot, stack.name) || tossPlan(bot, { below: worth(stack.name) }).length > 0))
        const nextName = it && stackOf(it)?.name
        if (!nextName) break
        name = nextName
        before = count()
        continue
      }
    }
    for (let t = 0; t < 10 && !bot.entity.onGround && !ctl.aborted && !received() && !gone(); t++) await bot.waitForTicks(1)
    if (!ctl.aborted && !received() && !gone() && seesPlayer(bot, it) && !there()) {
      if (bot.entity.position.distanceTo(it.position) > maxD) { why = 'вещь вне досягаемости'; break }
      if (!bot.entity.onGround || bot.entity.isInWater || bot.entity.isInLava) { why = 'нет опоры для подхода'; continue }
      // Подбирает вся рамка игрока: центр предмета может свисать с опоры.
      const pos = it.position, stands: Position[] = []
      const view = observedCollision(bot, worldOf(bot).getBlock, true)
      const geometry = { ...view, entity: bot.entity }
      for (let x = Math.floor(pos.x - REACH_XZ); x <= Math.floor(pos.x + REACH_XZ); x++) {
        for (let z = Math.floor(pos.z - REACH_XZ); z <= Math.floor(pos.z + REACH_XZ); z++) {
          for (const p of standPositions(geometry, { x, y: pos.y, z }, { rise: REACH_DOWN, drop: REACH_UP })) {
            if ((!missed || !p.equals(missed)) && inPickup(p, pos) && withinArena(bot, p, arena)) stands.push(p)
          }
        }
      }
      const at = stands.sort((a, b) => a.distanceSquared(bot.entity.position) - b.distanceSquared(bot.entity.position)).find(p => visibleLanding(bot, p, geometry))
      if (!at) { if (!missed) why = 'у вещи нет безопасной опоры'; break }
      // A late slot can settle the first attempt during the short diversion. Finish an airborne leg safely.
      const route = previous ? { ...ctl, get aborted() { return ctl.aborted || bot.entity.onGround && !!received() } } : ctl
      const move = await executeJump(bot, route, at, { allowWalk: true, maxFallDamage: 0, arena, maxTicks: 60, maxFrames: ROUTE_FRAMES }).catch((e: any) => ({ ok: false, why: e.message }))
      if (!there()) missed = at
      if (!move.ok) why = move.why || why
    }
    for (let t = 0; t < 45 && !ctl.aborted && !received() && !gone() && there(); t++) await bot.waitForTicks(1)
    if (gone() || !seesPlayer(bot, it)) {
      if (tries === 0) it = await waitForDrop(10, true)
      else for (let t = 0; t < 10 && !ctl.aborted && !received(); t++) await bot.waitForTicks(1)
    }
  }
  if (ctl.aborted) return { ok: false, why: 'прервано' }
  const got = received(), ok = !!got
  const survey = !ok && generic && noCandidate && surveySite && maxD === 6 ? floorSurvey(bot, surveySite, arena) : undefined
  return { ok, why: ok ? `подобрал ${got}` : why, ...survey }
}

// Уничтожить чужой лут на земле (гонка 10.10: «вещи врага, что нам не нужны, — в лаву или сжечь, чтобы не достались им»):
// лава из ведра на кучу и забрать ведром обратно, иначе огонь огнивом/огненным зарядом. Сам — не ближе 2 бл. к клетке
// (огонь и лава растекаются), опора — видимая грань (pick, как всё остальное). Незерит не горит — его не трогаем.
export async function denyLoot (bot: any, at: any, maxD = 4, arena?: any, ctl = { aborted: false }) {
  const me = () => bot.entity.position
  const area = at ? new Vec3(at.x, at.y, at.z) : me()
  const items = Object.values<any>(bot.entities || {}).filter(e => e?.name === 'item' && e.position &&
    e.position.distanceTo(area) <= maxD && seesPlayer(bot, e))
  if (!items.length) return { ok: false, why: 'на земле нет вещей' }
  const tool = ['lava_bucket', 'flint_and_steel', 'fire_charge'].map(n => bot.inventory.items().find((i: any) => i.name === n)).find(Boolean)
  if (!tool) return { ok: false, why: 'нечем уничтожить' }
  const c = items.sort((a, b) => a.position.distanceSquared(area) - b.position.distanceSquared(area))[0].position
  const view = observedCollision(bot)
  let floor = view.blockAt(c.floored().offset(0, -1, 0))
  if (floor && floor.boundingBox !== 'block') floor = view.blockAt(c.floored().offset(0, -2, 0))
  if (!floor || floor.boundingBox !== 'block') return { ok: false, why: 'под вещами нет опоры' }
  const cell = floor.position.offset(0, 1, 0)
  const centre = cell.offset(0.5, 0.5, 0.5)
  if (me().distanceTo(centre) < 2 || me().distanceTo(centre) > 4) {
    const away = me().minus(centre); away.y = 0
    const dir = away.norm() > 0.1 ? away.scaled(1 / away.norm()) : new Vec3(1, 0, 0)
    const spot = centre.plus(dir.scaled(3))
    const stand = standPositions(view, spot).filter(p => p.distanceTo(centre) >= 2 && withinArena(bot, p, arena))
      .sort((a, b) => a.distanceSquared(me()) - b.distanceSquared(me())).find(p => visibleLanding(bot, p, view))
    if (stand && !ctl.aborted) await executeJump(bot, ctl, stand, { allowWalk: true, maxFallDamage: 0, arena, maxFrames: ROUTE_FRAMES })
  }
  const gap = () => me().distanceTo(centre)
  const localPile = () => items.filter(e => bot.entities[e.id] === e && e.position.floored().equals(cell) && seesPlayer(bot, e))
  if (ctl.aborted || gap() < 2 || gap() > 4.5 || !localPile().length) return { ok: false, why: 'нет доступной кучи' }
  await hold(bot, tool)
  const up = new Vec3(0, 1, 0), aim = () => pick.faceAim(bot, floor.position, up)
  const point = aim()
  if (!point) return { ok: false, why: 'не вижу грани под вещами' }
  await bot.lookAt(point, true)
  const pile = localPile()
  if (ctl.aborted || bot.heldItem?.name !== tool.name || gap() < 2 || !pile.length || !aim()?.equals(point)) return { ok: false, why: 'цель поджога изменилась' }
  let how = ''
  if (tool.name === 'lava_bucket') {
    bot.activateItem()
    await bot.waitForTicks(30)
    how = 'лава'
    const empty = bot.inventory.items().find((i: any) => i.name === 'bucket')
    if (empty && !ctl.aborted && aim()) {
      await hold(bot, empty); await bot.lookAt(point, true)
      if (!ctl.aborted && bot.heldItem?.name === 'bucket' && aim()?.equals(point) && bot.blockAt(cell)?.name === 'lava') { bot.activateItem(); await bot.waitForTicks(5) }
    }
  } else {
    try { await bot._genericPlace(floor, up, { delta: point.minus(floor.position), forceLook: 'ignore', swingArm: 'right' }) } catch (e: any) { return { ok: false, why: 'не поджёг: ' + e.message } }
    how = 'огонь'
    await bot.waitForTicks(30)
  }
  const after = pile.filter(e => bot.entities[e.id] === e).length
  return { ok: after < pile.length, how, burned: pile.length - after, left: after }
}

// RPC assist: { mode: 'heal' (ally | at) | 'wall' | 'pincer' | 'pickup' | 'deny', ally, foe, at }.
export async function assist (session: any, p: any = {}, ctl: Cancellation = { aborted: false }) {
  const bot = session.require()
  const ent = (name: string) => name && bot.players[name]?.entity
  const ally = ent(p.ally)
  if (p.mode === 'heal') return p.at ? healAt(bot, p.at) : healAlly(bot, ally, ctl, p.reports, p.clockId)
  if (p.mode === 'wall') return wallFor(bot, ally, ent(p.foe), ctl, p, session)
  if (p.mode === 'toss') return tossTo(bot, ally, p.item, p.count || 1, p.arena, ctl)
  if (p.mode === 'prepare_pickup') {
    if (!p.item || ctl.aborted || bot.currentWindow || !ally?.position || bot.entity.position.distanceTo(ally.position) > 3 || !pick.canHit(bot, ally, { range: 4.5 })) return { ok: false, why: 'не готов к передаче' }
    const { freed } = await makeRoom(bot, { forItem: p.item, away: ally.position, ctl })
    return { ok: freed > 0, why: freed ? 'освободил место' : 'нечего менять' }
  }
  if (p.mode === 'pickup') return pickup(bot, p.item || null, p.maxD || 6, p.arena, ctl, p.ownedTarget, p.surveySite)
  if (p.mode === 'deny') return denyLoot(bot, p.at || null, p.maxD || 4, p.arena, ctl)
  return { ok: false, why: 'режим?' }
}

// RPC team_hint (не прерывает бой): клещи в воздухе — напарник бьёт ту же цель из from, таран заходит с другой стороны.
export function hint (session: any, p: any = {}) {
  const bot = session.require()
  if (!Object.hasOwn(p, 'lanceWeb') || Object.hasOwn(p, 'target') || Object.hasOwn(p, 'from')) {
    bot._ndPincer = p.target && p.from ? { target: p.target, from: p.from, until: gameClock.now() + 6000 } : null
  }
  if (Object.hasOwn(p, 'lanceWeb')) {
    const target = p.lanceWeb?.target, previous = bot._ndLanceWeb?.target ?? null
    bot._ndLanceWeb = typeof target === 'string' && target ? { target, until: gameClock.now() + 2000 } : null
    if (process.env.ND_LANCE_WEB_TRACE === '1' && previous !== (bot._ndLanceWeb?.target ?? null))
      console.log('[lance-web]', JSON.stringify({ stage: 'receive', helper: bot.username, target: bot._ndLanceWeb?.target ?? null }))
  }
  return { pincer: !!bot._ndPincer, lanceWeb: !!bot._ndLanceWeb }
}
