'use strict'
// Ведро воды при падении (installFallGuard, mlgDrop) и цена спуска прыжком (priceDrops).
// ---------------------------------------------------------------- ведро воды
import { PlayerState, SAFE_FALL, USE_RANGE, EYE, HALF, CORNERS } from './forecast'
import * as gameClock from '../game-clock'
import * as clutch from '../clutch'
import { blockReference, replaceable, othersOf, occupied } from '../clutch/blocks'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
// Сторож падения — всегда, не только в бою. Вода под ноги в последний тик до
// земли (BucketItem.use: луч от глаз на 4.5 блока; сервер считает от позиции
// последнего пакета движения, поэтому use_item уходит ПОСЛЕ пакета этого
// тика — setImmediate из physicsTick), вода гасит падение (LivingEntity.
// checkFallDamage: сначала updateInWaterState → fallDistance = 0, потом fallOn).
// Потом — обратно в ведро. В Аду вода испаряется — там не пробуем.
//
// Рука — сторожу (2026-09-26). Спуск 7–9 бл. с крыши коробки и со столба на
// арене: ведро «срабатывало», а воды не было. use_item несёт свой поворот
// (ServerGamePacketListenerImpl.handleUseItem: absSnapRotationTo по углам из
// пакета) и берёт предмет выбранного слота; сторож ставил слот и взгляд на
// тике физики, а use_item слал из setImmediate — между ними успевали чужой
// взгляд (спуск булавы mace.descend смотрит на цель каждый тик, таймер
// прицела), смена слота и bot.equip меча (перекладывает слоты кликами). Теперь
// слот, взгляд и use_item — одним синхронным куском после пакета позиции
// (afterPacket ниже, как в mace.js), а пока сторож взведён и три тика после
// броска, чужие смены слота, equip в руку и «использовать» правой ждут или
// отменяются (lockHand).
function afterPacket (bot, fn) {
  // The clock adapter emits after movement/tick_end, in this physical frame.
  // Retain the legacy fallback for unadapted clients and callers between ticks.
  let done = false
  const act = (require('node:async_hooks') as typeof import('node:async_hooks')).AsyncResource.bind(fn)
  const run = () => {
    if (done) return
    done = true
    bot.removeListener('physicsTick', run)
    bot.removeListener('ndMovementSent', run)
    try { act() } catch {}
  }
  bot.on('ndMovementSent', run)
  bot.prependListener('physicsTick', run)
  setImmediate(run)
}

function lockHand (bot) {
  if (bot._ndHandLock) return bot._ndHandLock
  const L: any = { until: 0, own: false, blocked: { slot: 0, equip: 0, use: 0 } }
  bot._ndHandLock = L
  L.on = () => !L.own && gameClock.now() < L.until
  L.hold = (ms) => { L.until = Math.max(L.until, gameClock.now() + ms) }
  L.as = (fn) => { const was = L.own; L.own = true; try { return (require("../reflex-lock") as typeof import('../reflex-lock')).emergency(bot._ndReflexSession, fn, Math.max(200, L.until - gameClock.now())) } finally { L.own = was } }
  // Слот, который ставит сервер (held_item_slot), — всегда: иначе рассинхрон.
  let srv = false
  try { bot._client.prependListener('held_item_slot', () => { srv = true; setImmediate(() => { srv = false }) }) } catch {}
  const origSlot = bot.setQuickBarSlot
  bot.setQuickBarSlot = function (slot) {
    if (L.on() && !srv && slot !== bot.quickBarSlot) { L.blocked.slot++; return }
    return origSlot.apply(this, arguments)
  }
  const wait = async () => { const t0 = gameClock.now(); while (L.on() && gameClock.now() - t0 < 2500) await new Promise<any>(r => gameClock.setTimeout(r, 25)) }
  const origEquip = bot.equip
  bot.equip = async function (item, dest) {
    if ((dest == null || dest === 'hand') && L.on()) { L.blocked.equip++; await wait() }
    return origEquip.apply(this, arguments)
  }
  const origAct = bot.activateItem
  bot.activateItem = function (offHand) {
    if (!offHand && L.on()) { L.blocked.use++; if (process.env.ND_DROP_LOG) console.log('[hand-lock] use_item не отправлен: рука у края/клатча'); return }
    return origAct.apply(this, arguments)
  }
  const origConsume = bot.consume
  if (typeof origConsume === 'function') {
    bot.consume = async function () {
      if (L.on()) { L.blocked.use++; await wait() }
      return origConsume.apply(this, arguments)
    }
  }
  return L
}

// Сторож падения (installFallGuard): публичное состояние st (bot._ndFallGuard) и прежние `let` замыкания — поля fg;
// прежние внутренние стрелки — функции с fg первым аргументом, тик физики — fallTick.
interface FallGuard {
  session: any
  bot: any
  minFall: number
  st: any
  hand: any
  blockClutch: any
  waterPlan: any
}

function installFallGuard (session, { minFall = 6 }: any = {}) {
  const bot = session.bot
  if (!bot || bot._ndFallGuard) return bot && bot._ndFallGuard
  const st: any = { peak: null, placed: null, moving: false, fired: 0, saved: 0, picked: 0, missed: 0, busy: false }
  const hand = lockHand(bot)
  const fg: FallGuard = { session, bot, minFall, st, hand, blockClutch: null, waterPlan: null }
  const blockClutch = fg.blockClutch = installClutch(fg)
  st.clutch = blockClutch
  if (!blockClutch && process.env.ND_CLUTCH !== '0') console.log('[clutch] нет: registry/world/_genericPlace', !!bot.registry, !!bot.world, typeof bot._genericPlace)
  st.hand = hand.blocked
  // Readiness for an explicitly priced fall is physical; mlgDrop's HP/height
  // budget remains the ordinary pathfinder policy. Planning does not take the hand.
  st.waterReady = () => waterReady(fg)
  st.webReady = () => webReady(fg)
  st.planWater = (plan) => planWater(fg, plan)
  const onTick = () => fallTick(fg)
  bot.on('physicsTick', onTick)
  st.toHotbar = () => toHotbar(fg)
  // Когда ведро легло в хотбар: перекладку кликами сервер принимает не сразу,
  // и прыжок в первые мгновения — вода из пустой руки (ферма 30.09, mlg-drop-1:
  // перекладка и прыжок за 1.3 с — промах, −5 хп).
  try {
    bot.inventory.on('updateSlot', (slot, was, now) => {
      if (slot >= 36 && slot <= 44 && now && now.name === 'water_bucket' && !(was && was.name === 'water_bucket')) st.barAt = gameClock.now()
    })
  } catch {}
  bot._ndFallGuard = st
  return st
}

function installClutch (fg: FallGuard) {
  const { session, bot, hand, minFall } = fg
  // Блочный клатч (clutch.js, 30.09.2026): там, где воду не поставить или посадка
  // «плохая» (Ад, ведра нет в хотбаре, листва/полублок, лава, пустота), — блок на
  // видимую грань в первые тики падения. Его решение — первым в тике: 'water' —
  // дальше как было (ведро), 'clutch' — ведро молчит, 'none' — как было.
  // ND_CLUTCH=0 — выключить.
  let blockClutch = null
  if (process.env.ND_CLUTCH !== '0' && bot.registry && bot.world && typeof bot._genericPlace === 'function') {
    try {
      const Block = (require('prismarine-block') as typeof import('prismarine-block'))(bot.registry)
      blockClutch = clutch.install(session, {
        listen: false, Vec3, PlayerState, hand, afterPacket,
        faceAim: (require('../pick') as typeof import('../pick')).faceAim,
        mlgDrop, mlgLandingBad, waterMinFall: minFall,
        makeBlock (p, stateId = bot.registry.blocksByName.cobblestone.defaultState) {
          const b = Block.fromStateId(stateId, 0)
          b.position = p.floored()
          return b
        }
      })
      bot.on('nd_clutch', (e) => {
        if (/^(placed|saved|denied|timeout|damaged_or_unconfirmed|stale|send_error|to_bar_failed|no_bar_slot)$/.test(e.what) || (e.what === 'no_face' && !blockClutch._noFaceSaid)) {
          if (e.what === 'no_face') blockClutch._noFaceSaid = true
          const p = bot.entity && bot.entity.position
          console.log('[clutch]', JSON.stringify({ ...e, cell: e.cell && [e.cell.x, e.cell.y, e.cell.z], ref: undefined, face: undefined, y: p && Math.round(p.y * 100) / 100, hp: bot.health }))
        }
        if (e.what === 'landed' || e.what === 'saved' || e.what === 'damaged_or_unconfirmed') blockClutch._noFaceSaid = false
      })
    } catch (err) { console.log('[clutch] не подключён:', err.message) }
  }
  return blockClutch
}

const hotbar = (fg: FallGuard, name) => {
  const { bot } = fg
  for (let s = 36; s <= 44; s++) { const it = bot.inventory.slots[s]; if (it && it.name === name) return s }
  return -1
}
const emit = (fg: FallGuard, what, extra: any = {}) => { const { bot } = fg; try { bot.emit('nd_mlg', { what, ...extra }) } catch {} }
const toHotbar = async (fg: FallGuard) => {
  const { bot, st } = fg
  // Перекладка не дольше 3 с: зависший флаг навсегда оставил бы ведро в
  // рюкзаке, а прыжки — выключенными.
  if (st.moving && gameClock.now() - st.moving < 3000) return
  // В творческом клики по рюкзаку сервер ведёт иначе, и ведро «в хотбаре»
  // было только у клиента (ферма 30.09, mlg-final-1: первый заход, −5 хп).
  if (!survivalMode(bot)) return
  const wb = bot.inventory.items().find(i => i.name === 'water_bucket')
  if (!wb || (wb.slot >= 36 && wb.slot <= 44)) return
  st.moving = gameClock.now()
  try {
    // Свободный слот хотбара или самый дешёвый — не оружие и не то, что в руке.
    const sel = 36 + bot.quickBarSlot
    const keep = /sword|_axe|bow|crossbow|trident|mace|totem|golden_apple/
    let dest = -1
    for (let k = 36; k <= 44; k++) if (k !== sel && !bot.inventory.slots[k]) { dest = k; break }
    if (dest < 0) for (let k = 36; k <= 44; k++) if (k !== sel && !keep.test(bot.inventory.slots[k].name)) { dest = k; break }
    if (dest >= 0) await bot.moveSlotItem(wb.slot, dest)
    else emit(fg, 'no_bar_slot')
  } catch (e) { emit(fg, 'to_bar_failed', { err: e.message }) } finally { st.moving = false }
}
const inWaterNow = (fg: FallGuard) => {
  const { bot } = fg
  const p = bot.entity.position
  for (const dy of [0, 0.5]) { const b = bot.blockAt(p.offset(0, dy, 0), false); if (b && b.name === 'water') return true }
  return !!bot.entity.isInWater
}
function waterReady (fg: FallGuard) {
  const { session, bot, st } = fg
  if (!bot.entity || (bot.health ?? 20) <= 0) return { ok: false, why: 'нет живого тела' }
  if (process.env.ND_MLG === '0' || session.mlgOff) return { ok: false, why: 'выключено' }
  if (/nether/.test(String(bot.game?.dimension || ''))) return { ok: false, why: 'Ад: вода испаряется' }
  if (session.current?.name === 'dragon' || !survivalMode(bot)) return { ok: false, why: 'другой режим' }
  if (st.placed) return { ok: false, why: 'предыдущее ведро ещё не подобрано' }
  if (hotbar(fg, 'water_bucket') < 0) return { ok: false, why: 'ведро не в хотбаре', toBar: !!bot.inventory.items().some(i => i.name === 'water_bucket') }
  const left = MLG_SETTLE - (gameClock.now() - (st.barAt ?? -Infinity))
  if (left > 0) return { ok: false, why: 'ведро только что в хотбаре', retryMs: left }
  return { ok: true }
}
function webReady (fg: FallGuard) {
  const { session, bot, st } = fg
  if (!bot.entity || (bot.health ?? 20) <= 0) return { ok: false, why: 'нет живого тела' }
  if (process.env.ND_MLG === '0' || process.env.ND_CLUTCH === '0' || session.mlgOff) return { ok: false, why: 'выключено' }
  if (session.current?.name === 'dragon' || !survivalMode(bot)) return { ok: false, why: 'другой режим' }
  if (st.placed || typeof bot._genericPlace !== 'function') return { ok: false, why: 'рука не готова' }
  return hotbar(fg, 'cobweb') >= 0 ? { ok: true } : { ok: false, why: 'паутина не в хотбаре' }
}
function planWater (fg: FallGuard, { owner, until, material = 'water' }) {
  const { bot, st } = fg
  if (material !== 'water' && material !== 'cobweb') return null
  if (owner == null || !Number.isFinite(until) || until <= gameClock.now() || !(material === 'cobweb' ? st.webReady() : st.waterReady()).ok) return null
  const token = { owner, until, material, startY: bot.entity.position.y, airborne: false }
  fg.waterPlan = token
  return () => {
    if (fg.waterPlan !== token) return
    // Cancelling the caller on the ground retracts the plan immediately.
    // Once airborne, finish this safety action through landing or its deadline.
    if (!bot.entity || bot.entity.onGround || inWaterNow(fg) || material === 'cobweb' && inWebNow(fg)) fg.waterPlan = null
    else token.airborne = true
  }
}
const activeWaterPlan = (fg: FallGuard) => {
  const { bot } = fg
  if (!fg.waterPlan) return null
  const landed = bot.entity && (bot.entity.onGround || inWaterNow(fg) || fg.waterPlan.material === 'cobweb' && inWebNow(fg))
  if (!bot.entity || (bot.health ?? 20) <= 0 || gameClock.now() >= fg.waterPlan.until || (fg.waterPlan.airborne && landed)) fg.waterPlan = null
  // На самом краю физика чередует onGround при той же высоте: это ещё не прыжок.
  else if (!landed && Math.abs(bot.entity.position.y - fg.waterPlan.startY) > 1e-7) fg.waterPlan.airborne = true
  return fg.waterPlan
}
const inWebNow = (fg: FallGuard) => !!(fg.bot.entity?.isInWeb || fg.bot.entity && fg.bot.blockAt(fg.bot.entity.position, false)?.name === 'cobweb')

// Тик сторожа: шаг клатча, своя лужа (подобрать), ведро под ноги.
function fallTick (fg: FallGuard) {
  const { session, bot, st } = fg
  try {
    const plannedWater = activeWaterPlan(fg)
    // Явный план уже оценил падение: каменный клатч не должен занять его руку.
    const clutchChoice = plannedWater ? { action: 'none' } : clutchStep(fg)
    const e = bot.entity
    if (!e || !e.position || (bot.health ?? 20) <= 0) { st.peak = null; return }
    // У дракона свой сторож (dragon.js fallGuard) — не драться с ним за руку.
    if (session.current && session.current.name === 'dragon') { st.peak = null; return }
    // В творческом падение не ранит, а вылитое ведро «промахом» уводило
    // прыжки в осторожный режим (ферма 30.09, mlg-final-3: телепорты сцены).
    if (!survivalMode(bot)) { st.peak = null; st.placed = null; return }
    const p = e.position
    // Уже приземлялись, а тело снова высоко в воздухе (подбросили,
    // телепорт) — новое падение важнее старой лужи.
    if (st.placed && st.placed.landed && !e.onGround && !inWaterNow(fg) && p.y > st.placed.pos.y + 3) st.placed = null
    // Приземлились в свою воду — через пару тиков забрать её.
    if (st.placed) { pickUpWater(fg, e); return }
    dropWater(fg, e, clutchChoice, plannedWater)
  } catch (err) {
    if (process.env.ND_DEBUG_EDGES) console.log('[edges] fall', err.message)
  }
}

// Шаг блочного клатча — первым в тике; его решение и журнал «молчит»/ошибок.
function clutchStep (fg: FallGuard) {
  const { bot, blockClutch } = fg
  let clutchChoice: any = { action: 'none' }
  if (blockClutch) {
    try {
      clutchChoice = blockClutch.step()
      const ee = bot.entity
      // Падаем быстро, а клатч молчит не из-за воды/безопасной посадки — раз за полёт в журнал.
      if (ee && !ee.onGround && ee.velocity && ee.velocity.y < -0.5 && clutchChoice.action === 'none' && !/^(safe_landing|natural_water|on_ground)$/.test(clutchChoice.why) && survivalMode(bot) && !blockClutch._whySaid) {
        blockClutch._whySaid = true
        console.log('[clutch] молчит', JSON.stringify({ ...clutchChoice, y: Math.round(ee.position.y * 100) / 100, peak: blockClutch.peak, dbg: blockClutch._dbg }))
      }
      if (ee && ee.onGround) blockClutch._whySaid = false
    } catch (err) {
      // Ошибка клатча не должна молчать (и не должна валить ведро): раз в 10 с — в журнал.
      if (gameClock.now() - (blockClutch._errAt || 0) > 10000) { blockClutch._errAt = gameClock.now(); console.log('[clutch] ошибка', err && err.stack ? err.stack.split(String.fromCharCode(10)).slice(0, 3).join(' | ') : err) }
    }
  }
  return clutchChoice
}

// Своя лужа после посадки: итог по здоровью и ведро обратно.
function pickUpWater (fg: FallGuard, e) {
  const { bot, st, hand } = fg
  const pl = st.placed
  const web = pl.material === 'cobweb'
  if (web && inWebNow(fg)) pl.contact = true
  if (e.onGround || inWaterNow(fg) || pl.contact) {
    if (!pl.landed) { pl.landed = gameClock.now(); pl.hpLand = bot.health ?? 20 }
    const since = gameClock.now() - pl.landed
    // Спасло ли — по здоровью: блок воды приходит клиенту позже, чем
    // сервер уже погасил им падение (прогон 2026-09-26: «промах» без урона).
    if (!pl.said && since >= 300) {
      pl.said = true
      if ((!web || pl.contact) && (bot.health ?? 0) >= pl.hpAir - 0.5) { st.saved++; emit(fg, 'saved', { fall: pl.fall, hp: bot.health }) } else { st.missed++; st.missedAt = gameClock.now(); emit(fg, 'missed', { fall: pl.fall, hp: bot.health }) }
    }
    if (web) { if (pl.said) st.placed = null; return }
    if (since < 150) return
    // Вода — в клетке посадки или внутри залитого блока под ней (нижний
    // полублок: ведро заливает его, а не клетку над ним — ферма 30.09,
    // mlg-surf-1: урона нет, а вода оставалась в полублоке 8 из 8).
    const w = waterAt(bot, pl.pos)
    if (w && !w.position.equals(pl.pos)) pl.pos = w.position
    if (!w) {
      // A fast pickup must not erase the pending 300 ms health receipt.
      if (pl.tries && hotbar(fg, 'water_bucket') >= 0 && !pl.said) return
      if (pl.tries && hotbar(fg, 'water_bucket') >= 0) { st.picked++; emit(fg, 'picked'); st.placed = null } else if (since > 1200) { emit(fg, pl.tries ? 'pickup_failed' : 'no_water_block'); st.placed = null }
      return
    }
    if (gameClock.now() - (pl.lastTry || 0) < 250) return
    if (pl.tries >= 6) { st.placed = null; emit(fg, 'pickup_failed'); return }
    if (hotbar(fg, 'bucket') < 0) { st.placed = null; return }
    pl.tries = (pl.tries || 0) + 1
    pl.lastTry = gameClock.now()
    // reflex-lock делает даже force-look асинхронным: клик ждёт поворота.
    hand.hold(200)
    setImmediate(() => hand.as(async () => {
      try {
        const q = bot.entity.position
        const c = pl.pos.offset(0.5, 0.3, 0.5)
        const eye = q.offset(0, EYE, 0)
        const yaw = Math.atan2(-(c.x - eye.x), -(c.z - eye.z))
        const pitch = Math.atan2(c.y - eye.y, Math.hypot(c.x - eye.x, c.z - eye.z))
        await bot.look(yaw, pitch, true)
        if (st.placed !== pl) return
        hand.as(() => {
          const b = hotbar(fg, 'bucket')
          if (b < 0) return
          if (bot.quickBarSlot !== b - 36) bot.setQuickBarSlot(b - 36)
          bot.activateItem()
          hand.hold(150)
        })
      } catch {}
    }))
    return
  }
  if (gameClock.now() - pl.t > 3000) { st.placed = null; st.missed++; st.missedAt = gameClock.now(); emit(fg, 'missed') }
}

// Куда садимся: самая высокая опора под хитбоксом (до 80 блоков).
function landingTop (bot, p) {
  let top = -Infinity; let wet = false; let cell = null
  for (const [sx, sz] of CORNERS) {
    const bx = Math.floor(p.x + sx * (HALF - 1e-3)); const bz = Math.floor(p.z + sz * (HALF - 1e-3))
    for (let y = Math.floor(p.y); y >= Math.floor(p.y) - 80; y--) {
      const b = bot.blockAt(new Vec3(bx, y, bz), false)
      if (!b) break
      if (b.name === 'water' || b.name === 'bubble_column') { if (y + 1 > top) { top = y + 1; wet = true; cell = null } break }
      if (b.boundingBox === 'block') { if (y + 1 > top) { top = y + 1; wet = false; cell = new Vec3(bx, y + 1, bz) } break }
    }
  }
  return { top, wet, cell }
}

// В воздухе: пик падения, решение «ведро сейчас» и выстрел водой после пакета позиции.
function dropWater (fg: FallGuard, e, clutchChoice, plannedWater) {
  const { bot, st, hand, minFall } = fg
  const p = e.position
  if (e.onGround || inWaterNow(fg) || e.isInLava) { st.peak = null; st.busy = false; return }
  if (st.peak === null || p.y > st.peak) st.peak = p.y
  // Клатч взял падение на себя — ведро не трогает руку.
  if (clutchChoice.action === 'clutch') return
  if (e.velocity.y > -0.2) return
  if (plannedWater?.material === 'cobweb') { dropWeb(fg, e, plannedWater); return }
  const dim = String((bot.game && bot.game.dimension) || '')
  if (/nether/.test(dim)) return
  const { top, wet, cell } = landingTop(bot, p)
  if (!Number.isFinite(top) || wet) return
  // Свой заряд ветра (mace.js, 2026-09-26): урон от падения — только ниже
  // точки всплеска (Player.causeFallDamage); сядем не ниже неё — ведро не
  // нужно, а смена слота на ведро сорвала бы удар булавой на спуске.
  if (typeof bot._ndWindFall === 'function' && bot._ndWindFall(top)) return
  const fall = st.peak - top
  const hp = bot.health ?? 20
  // Урон = floor(высота − 3); ведро — когда это 3+ хп или смерть.
  if (fall - SAFE_FALL < Math.min((plannedWater ? SAFE_FALL : minFall) - SAFE_FALL, hp - 1)) return
  st.busy = true
  if (hotbar(fg, 'water_bucket') < 0) { toHotbar(fg); return }
  // Взведён: рука — сторожу до броска (чужой equip ждёт, слот не меняется).
  hand.hold(250)
  const h = p.y - top
  // Сервер кинет луч от глаз этой позиции (пакет этого тика уйдёт раньше
  // use_item): дотянуться — h + 1.62 ≤ 4.5. Выше — ждём следующий тик,
  // если он ещё не земля; иначе — сейчас, другого не будет.
  const next = h + e.velocity.y
  if (h + EYE > USE_RANGE - 0.08 && next > 0.05) return
  if (h <= 0) return
  // Спуск булавы (mace.descend) — ведро в последний тик: удар с падения
  // обнуляет падение (MaceItem.postHurtEnemy), и он бьёт у самой земли;
  // раньше ведро отнимало у него руку и взгляд (2026-09-26).
  if (bot._ndDescend && next > 0.05) return
  throwWater(fg, p, top, cell, fall, hp, h)
}

function dropWeb (fg: FallGuard, e, plan) {
  const { bot, st, hand } = fg
  if (plan.scheduled || !st.webReady().ok) return
  const { top, wet, cell } = landingTop(bot, e.position)
  if (!cell || wet || st.peak - top <= SAFE_FALL || e.position.y <= top) return
  const ref = cell.offset(0, -1, 0); const face = new Vec3(0, 1, 0)
  const faceAim = (require('../pick') as typeof import('../pick')).faceAim
  if (!faceAim(bot, ref, face, { range: USE_RANGE })) return
  const snapshot = e.position.clone()
  plan.scheduled = true; st.busy = true; hand.hold(250)
  afterPacket(bot, () => hand.as(() => {
    plan.scheduled = false
    if (activeWaterPlan(fg) !== plan || !st.webReady().ok || bot.entity.onGround || bot.entity.position.distanceTo(snapshot) > 1e-7) return
    const rb = bot.blockAt(ref, false)
    const point = faceAim(bot, ref, face, { range: USE_RANGE })
    if (!point || !blockReference(rb) || !replaceable(bot.blockAt(cell, false)) || occupied(cell, othersOf(bot.entities, bot.entity.id))) return
    const eye = snapshot.offset(0, EYE, 0); const d = point.minus(eye)
    const yaw = Math.atan2(-d.x, -d.z); const pitch = Math.atan2(d.y, Math.hypot(d.x, d.z))
    bot.look(yaw, pitch, true)?.catch?.(() => {})
    // Как блочный клатч: точный поворот и щелчок после пакета позиции, без await.
    bot._client.write('look', { yaw: 180 - yaw * 180 / Math.PI, pitch: -pitch * 180 / Math.PI,
      onGround: false, flags: { onGround: false, hasHorizontalCollision: !!bot.entity.isCollidedHorizontally } })
    const slot = hotbar(fg, 'cobweb')
    if (slot < 0) return
    if (bot.quickBarSlot !== slot - 36) bot.setQuickBarSlot(slot - 36)
    const pl = st.placed = { t: gameClock.now(), pos: cell, fall: Math.round(st.peak - top), hpAir: bot.health, material: 'cobweb' }
    try {
      const sent = bot._genericPlace(rb, face, { delta: point.minus(ref), forceLook: 'ignore', swingArm: 'right' })
      Promise.resolve(sent).catch(() => { if (st.placed === pl) { st.placed = null; st.missed++; st.missedAt = gameClock.now(); emit(fg, 'missed', { material: 'cobweb' }) } })
      st.fired++; emit(fg, 'fired', { material: 'cobweb', fall: pl.fall }); hand.hold(150)
    } catch { st.placed = null; st.missed++; st.missedAt = gameClock.now(); emit(fg, 'missed', { material: 'cobweb' }) }
  }))
}

function throwWater (fg: FallGuard, p, top, cell, fall, hp, h) {
  const { bot, st, hand } = fg
  // Куда ляжет вода: луч прямо вниз — в колонку под центром; её верх
  // дальше руки (центр над ямой, опора — под углом) — целим в верх той
  // клетки, на которую сядем.
  let aim = null
  const cx = Math.floor(p.x); const cz = Math.floor(p.z)
  let land = null
  for (let y = Math.floor(p.y); y >= Math.floor(p.y + EYE - USE_RANGE); y--) {
    const b = bot.blockAt(new Vec3(cx, y, cz), false)
    if (b && b.boundingBox !== 'empty') { land = new Vec3(cx, y + 1, cz); break }
  }
  if (!land && cell) { land = cell; aim = cell.offset(0.5, 0, 0.5) }
  const landCell = land || new Vec3(cx, top, cz)
  st.fired++
  st.placed = { t: gameClock.now(), pos: landCell, fall: Math.round(fall), hpAir: hp }
  const pl = st.placed
  emit(fg, 'fired', { fall: Math.round(fall), h: Math.round(h * 100) / 100 })
  afterPacket(bot, () => hand.as(async () => {
    try {
      // Удар булавы этого же тика (mace.descend) — первым: он с высоты.
      hand.as(() => {
        const smash = bot._ndSmashNow
        if (typeof smash === 'function') { bot._ndSmashNow = null; try { smash() } catch {} }
      })
      if (hotbar(fg, 'water_bucket') < 0) return
      const q = bot.entity.position
      if (aim) {
        const eye = q.offset(0, EYE, 0)
        await bot.look(Math.atan2(-(aim.x - eye.x), -(aim.z - eye.z)), Math.atan2(aim.y - eye.y, Math.hypot(aim.x - eye.x, aim.z - eye.z)), true)
      } else await bot.look(bot.entity.yaw, -Math.PI / 2, true)
      if (st.placed !== pl) return
      hand.as(() => {
        const s = hotbar(fg, 'water_bucket')
        if (s < 0) return
        const slot0 = bot.quickBarSlot
        if (bot.quickBarSlot !== s - 36) bot.setQuickBarSlot(s - 36)
        if (process.env.ND_DEBUG_MLG) console.log('[mlg-dbg] выстрел', JSON.stringify({ dt: gameClock.now() - pl.t, y: Math.round(q.y * 100) / 100, vy: Math.round(bot.entity.velocity.y * 100) / 100, slot0, slot: bot.quickBarSlot, want: s - 36, held: bot.heldItem && bot.heldItem.name, aim: !!aim, barAgo: st.barAt ? gameClock.now() - st.barAt : null }))
        bot.activateItem()
        hand.hold(150)
      })
    } catch {}
  }))
}

// Прыжок с ведром как ход, а не только спасение (пользователь 30.09.2026:
// спидраннеры прыгают с высоты и гасят падение водой вместо лестниц, обходов
// и столбов; «даже блоков с 50»). Сторож выше ловит любое падение; здесь — на
// сколько блоков pathfinder'у можно планировать спуск.
// Ферма 30.09 (mlg-drop-4, mlg-surf-1/2): 40 из 40 с 8–60 блоков без урона,
// вода возвращена всегда; трава, снег, песок — так же; листва и заборы воду
// в себя забирают — туда прыжок не планируется (mlgLandingBad ниже).
// Смело — до MLG_MAX при хп от MLG_BOLD_HP. Промах за последние 30 мин —
// осторожно: не глубже, чем промах оставит MLG_SAFE_RESERVE хп.
// Ад — нет (вода испаряется), у дракона свой сторож и свои ходы.
// ND_MLG_RESERVE — постоянный запас хп вместо смелого режима, ND_MLG_MAX —
// предел, ND_MLG=0 — выключить.
const MLG_MIN = 6
const MLG_SETTLE = 300
const MLG_SAFE_RESERVE = 4
const MLG_BOLD_HP = 8
const MLG_MISS_MS = 30 * 60 * 1000
function survivalMode (bot) {
  const m = bot && bot.game && bot.game.gameMode
  return m == null || m === 'survival' || m === 'adventure'
}
function envNum (name) {
  const v = process.env[name]
  return v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null
}
function mlgDrop (session) {
  const bot = session && session.bot
  if (!bot || !bot.entity || !bot.inventory) return { ok: false, why: 'нет тела' }
  if (process.env.ND_MLG === '0' || session.mlgOff) return { ok: false, why: 'выключено' }
  const st = bot._ndFallGuard
  if (!st) return { ok: false, why: 'нет сторожа падения' }
  if (/nether/.test(String((bot.game && bot.game.dimension) || ''))) return { ok: false, why: 'Ад: вода испаряется' }
  if (session.current && session.current.name === 'dragon') return { ok: false, why: 'бой с драконом' }
  if (!survivalMode(bot)) return { ok: false, why: 'не выживание' }
  if (!bot.inventory.items().some(i => i.name === 'water_bucket')) return { ok: false, why: 'нет ведра воды' }
  // Только из хотбара, и не в первые MLG_SETTLE мс после перекладки (см. barAt).
  const inBar = bot.inventory.slots.some((it, k) => k >= 36 && k <= 44 && it && it.name === 'water_bucket')
  if (!inBar) return { ok: false, why: 'ведро не в хотбаре', toBar: true }
  if (st.barAt && gameClock.now() - st.barAt < MLG_SETTLE) return { ok: false, why: 'ведро только что в хотбаре', retryMs: MLG_SETTLE - (gameClock.now() - st.barAt) + 20 }
  const hp = Math.floor(bot.health ?? 20)
  const max = envNum('ND_MLG_MAX') > 0 ? envNum('ND_MLG_MAX') : 60
  const reserve = envNum('ND_MLG_RESERVE')
  const recentMiss = !!(st.missedAt && gameClock.now() - st.missedAt < MLG_MISS_MS)
  const bold = reserve == null && !recentMiss && hp >= MLG_BOLD_HP
  const drop = bold ? max : Math.min(max, hp + SAFE_FALL - (reserve == null ? MLG_SAFE_RESERVE : reserve))
  if (drop < MLG_MIN) return { ok: false, why: 'мало хп', drop }
  return { ok: true, drop, bold }
}

// Блок держит воду в себе (waterlogged): ведро заливает его, а не клетку над
// ним. Лист, ступень, забор, верхний полублок — тело садится сверху мимо воды:
// ферма 30.09, mlg-surf-1, листва — 0 из 8, с 40 блоков смерть. Нижний
// полублок спас (тело стоит внутри залитой половины), но прыжок на него
// планировать незачем.
function waterloggable (b) {
  if (!b || typeof b.getProperties !== 'function') return false
  try { return 'waterlogged' in (b.getProperties() || {}) } catch { return false }
}
function waterAt (bot, pos) {
  for (const p of [pos, pos.offset(0, -1, 0)]) {
    const b = bot.blockAt(p, false)
    if (!b) continue
    if (b.name === 'water') return b
    try { if (b.getProperties && b.getProperties().waterlogged === true) return b } catch {}
  }
  return null
}
// Куда прыгать с ведром нельзя: вода не встанет над опорой, или сама опора ранит.
const MLG_BAD_FLOOR = /^(cactus|magma_block|campfire|soul_campfire|pointed_dripstone|sweet_berry_bush|powder_snow)$/
function mlgLandingBad (bot, x, y, z) {
  const Vec = Vec3
  const under = bot.blockAt(new Vec(x, y - 1, z), false)
  const feet = bot.blockAt(new Vec(x, y, z), false)
  if (!under) return true
  if (waterloggable(under) || MLG_BAD_FLOOR.test(under.name)) return true
  if (feet && (waterloggable(feet) || MLG_BAD_FLOOR.test(feet.name))) return true
  return false
}

// Спуск глубже обычного стоит времени: вылить воду, забрать её — ~1 с, это
// ~4 шага. Без надбавки pathfinder прыгал бы с 20 блоков ради одного шага.
// Ноги вниз на 4–5 — без воды (сторож ставит её с 6), это 1–2 хп, и урон
// рвёт само намерение (ферма 30.09, mlg-surf-2: goto «interrupted» у подножия
// столба). Такие спуски не планировать вовсе — как до ведра (maxDropDown 4
// пускал ноги лишь на 3).
const MLG_COST = 4
// Урон отрастёт: сытость ≥ 18 (регенерация) или съедобное в рюкзаке.
const NOT_A_MEAL = /^(rotten_flesh|spider_eye|poisonous_potato|pufferfish|suspicious_stew)$/
function canHeal (bot) {
  if ((bot.food ?? 20) >= 18) return true
  const foods = (bot.registry && bot.registry.foodsByName) || {}
  return !!bot.inventory?.items?.().some(i => foods[i.name] && !NOT_A_MEAL.test(i.name))
}

function priceDrops (movements, surface = () => false) {
  if (!movements || movements._ndMlgPriced) return movements
  movements._ndMlgPriced = true
  for (const name of ['getMoveDropDown', 'getMoveDown']) {
    const orig = movements[name]
    if (typeof orig !== 'function') continue
    movements[name] = function (node, ...rest: any[]) {
      const neighbors = rest[rest.length - 1]
      const n0 = Array.isArray(neighbors) ? neighbors.length : 0
      const out = orig.call(this, node, ...rest)
      if (Array.isArray(neighbors)) {
        for (let i = neighbors.length - 1; i >= n0; i--) {
          const m = neighbors[i]
          if (!m) continue
          const d = node.y - m.y
          // XZ overland travel still needs to get out after a cave shortcut. Price that
          // ascent with the pathfinder's own jump/place cost; it remains a finite option.
          const landing = surface() && d > 0 && this.getBlock && this.getBlock(m, 0, 0, 0)
          if (landing && typeof landing.skyLight === 'number' && landing.skyLight <= 7) m.cost += d * (1 + (this.placeCost ?? 1))
          if (d >= MLG_MIN) {
            if (this.bot && mlgLandingBad(this.bot, m.x, m.y, m.z)) { neighbors.splice(i, 1); continue }
            m.cost += MLG_COST
          } else if (d > SAFE_FALL) {
            // Без воды — прыжок с уроном, если урон (высота − 3) ≤ четверти хп (пользователь 10.10: «убирай лимит
            // глобально — пусть прыгают и подхиливаются»); цена — урон в шагах. ND_FREE_DROP=0 — по-старому (не планировать).
            const hp = this.bot ? (this.bot.health ?? 20) : 0
            // «Подхиливаются» — когда есть чем: без еды и при сытости < 18 урон не восстанавливается, а спуск по горам
            // прыжками снял 12 хп за 20 с (cl-g 14.10, хп 20 → 8 на тайге без еды). Тогда — без урона, по-старому.
            if (process.env.ND_FREE_DROP === '0' || d - SAFE_FALL > hp / 4 || (this.bot && !canHeal(this.bot))) neighbors.splice(i, 1)
            else m.cost += d - SAFE_FALL
          }
        }
      }
      return out
    }
  }
  return movements
}

// Тело в долгом падении и ведро наготове — бою не мешать руке.
function falling (bot) {
  const g = bot && bot._ndFallGuard
  return !!(g && (g.busy || (g.placed && !g.placed.landed)))
}

export { afterPacket, installFallGuard, mlgDrop, waterloggable, mlgLandingBad, priceDrops, falling }
