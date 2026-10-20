'use strict'
// Бой (combat.ts): щит — левая рука, подтверждение подъёма сервером, makeShield, итог щита.
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { sleep } from '../movement'
import { itemNamed } from '../items'

// --------------------------------------------------------------- shield

// mineflayer keeps the off-hand at slot 45 (mineflayer/lib/plugins/
// simple_inventory.js:19, behind the shieldSlot feature that
// minecraft-data features.json:475 lists as 1.9..latest, so 45 on 1.21.11).
// The number has to be spelled out here because bot.inventory.items() is slots
// 9..44 and nothing else (prismarine-windows/index.js:44 sets the inventory
// window range, Window.js:414 items() = itemsRange over exactly that range).
// So a shield already on the arm is invisible to itemNamed() — which is how the
// previous version lost its own shield the instant it put it on: the first
// fight equipped it, and every fight after that decided the bot had none.
// armor.js:76 says the same thing about the four armour slots.
const OFF_HAND_SLOT = 45

// Bits of the player's `living_entity_flags` metadata: 0x01 "a hand is in use",
// 0x02 "and that hand is the off-hand". Both must be set for a raised shield.
const HAND_ACTIVE = 0x01
const HAND_IS_OFF = 0x02

// How long ONE raise is willing to block a fight tick waiting for the server to
// agree. It is a leash on the call, not a verdict on the shield: a raise that
// returns false here has still sent its packet, and the 100ms sampler below
// goes on listening for the whole fight. Confusing "I stopped listening" with
// "the server refused" cost this project a whole false diagnosis on block
// placement — that one was a 1200ms leash of ours against the 5000ms mineflayer
// itself waits. So the leash stays short (a fight tick is 650ms and the bot
// must not stand still inside it), and confirmMs/lateConfirms in the report are
// what say whether it is too short — measured, not argued.
const SHIELD_CONFIRM_MS = 600
// Items.SHIELD / BlocksAttacks.blockDelayTicks, native Java 1.21.11: round(.25 * 20).
const SHIELD_DELAY_TICKS = 5
// Two native age broadcasts (20 ticks each) plus the existing metadata ACK leash.
const SHIELD_NATIVE_CONFIRM_MS = 2 * 20 * 50 + SHIELD_CONFIRM_MS

// item.shield.block is played at the blocker's feet, so anything further than
// this is somebody else's shield.
const SHIELD_SOUND_RANGE = 3

// Полупериод чередования в режиме замера. Три секунды — это и заметно больше
// задержки подъёма (замерено 43мс), и достаточно, чтобы в каждую фазу попало
// несколько стрел.
const MEASURE_PHASE_MS = 3000

function offHandItem (bot) {
  try { return bot.inventory.slots[OFF_HAND_SLOT] || null } catch { return null }
}

// A shield wherever it is. `worn` is the whole difference between "put it on"
// and "leave it alone", and it is the case items() cannot see.
function findShield (bot) {
  const off = offHandItem(bot)
  if (off && off.name === 'shield') return { item: off, worn: true }
  const bag = itemNamed(bot, 'shield')
  return bag ? { item: bag, worn: false } : null
}

// mcData carries the metadata layout, so the index is read rather than
// remembered: entitiesByName.player.metadataKeys on 1.21.11 is
// [shared_flags, air_supply, custom_name, custom_name_visible, silent,
//  no_gravity, pose, ticks_frozen, living_entity_flags, ...] — 8 today, and the
// lookup keeps it right the day it is not.
function livingFlagsKey (bot) {
  try {
    const keys = bot.registry.entitiesByName.player.metadataKeys
    const i = keys.indexOf('living_entity_flags')
    if (i >= 0) return i
  } catch {}
  return 8
}

// The only server-confirmed answer to "is the shield actually up".
// bot.entity is registered in bot.entities under our own id (entities.js:105)
// and the entity_metadata handler (entities.js:449) writes every key into
// entity.metadata — ours included, because the server sends a player its own
// metadata. bot.usingHeldItem is NOT this: inventory.js:116 sets it before the
// packet is even written, so it records our intention and nothing else.
function shieldUp (bot) {
  try {
    const flags = bot.entity.metadata[livingFlagsKey(bot)]
    if (typeof flags !== 'number') return false
    return (flags & HAND_ACTIVE) !== 0 && (flags & HAND_IS_OFF) !== 0
  } catch { return false }
}

// A shield only stops what comes at the front, and this is the half of that
// rule the bot can check about itself: the cosine between where its head points
// and where the threat is, on the horizontal plane. yaw -> direction uses the
// same convention pathfinder writes at index.js:607
// (bot.look(Math.atan2(-dx, -dz), 0)), i.e. the view vector is (-sin, -cos).
// Positive means the threat is in the front half.
function facingCos (bot, point) {
  try {
    const p = bot.entity.position
    const dx = point.x - p.x
    const dz = point.z - p.z
    const len = Math.hypot(dx, dz)
    if (len < 1e-6) return 1
    const yaw = bot.entity.yaw
    return (dx / len) * -Math.sin(yaw) + (dz / len) * -Math.cos(yaw)
  } catch { return 0 }
}

// Everything the bot can learn about its own shield while a fight is running,
// in one object: whether it is on the arm, whether the server agrees it is up,
// what it stopped, and what holding it cost in swings. The last two are the
// reason this exists at all — "щит поднят" is not a result, and the brain
// cannot decide «драться или закрыться» without a price on the second option.
//
// policy:
//   'never'  — do not wear it, do not raise it. The control.
//   'ranged' — wear it, raise it only walking into a shooter. Old doctrine.
//   'always' — also hold it between swings in melee, through the sword cooldown.
//   'measure' — ДЛЯ СЦЕН, не доктрина: не преследовать вовсе и поднимать блок
//             циклом. Сравнение «со щитом против без» между прогонами тонет в
//             разбросе арены — 12 секунд обстрела дали 1.5 хп против 1, то есть
//             одну стрелу. Чередование внутри ОДНОГО боя даёт парное сравнение
//             под одними и теми же стрелами, и разброс арены сокращается сам.
//             Заодно снимает нужду в геометрии, удерживающей бота от сближения.
// Состояние щита одного боя: прежние let и слушатели замыкания makeShield — поля sh. Надевание, подъём, отчёт и
// закрытие — функции ниже; guard — объект боя поверх них.
interface ShieldState {
  session: any; ctl: any; bot: any; policy: string; on: boolean; st: any; census: Map<string, number> | null; blocking: () => boolean
  why: string | null; want: boolean; up: boolean; disabledUntil: number; lastAsk: number; target: any; reach: number
  lastHp: number; lastTick: number; closed: boolean; charge: any
  tick?: () => void; onRawSound?: (p: any) => void; onHealth?: () => void; onCooldown?: (pkt: any) => void; timer?: any
}

function makeShield (session, ctl, { shield: policy = 'ranged' }: any = {}) {
  const sh = shieldState(session, ctl, policy)
  const { bot, st, blocking } = sh
  shieldListen(sh)

  const phase0 = gameClock.now()
  const guard = {
    melee: policy === 'always',
    measure: policy === 'measure',
    // Ровно половину времени щит поднят, ровно половину опущен, фазами по три
    // секунды. Обе колонки урона набираются в одном бою под одним обстрелом.
    phase () { return Math.floor((gameClock.now() - phase0) / MEASURE_PHASE_MS) % 2 === 0 },
    stats: st,
    // Предполётный отчёт живёт здесь по той же причине, что и щитовой: это
    // единственный объект, переживающий все выходы из тела боя, а «что я
    // надел перед дракой» должно доехать до мозга и с трупа, и с таймаута.
    pre: null,
    // Сколько врагов было рядом: на входе и в худший момент. Пока это только
    // цифра в отчёте, а не политика, и намеренно. Единственный замер щита в
    // ближнем бою («платит за себя: хп 0.7 -> 0 ценой 6.2 -> 6.6с, боёв 6»)
    // снят против ОДНОГО зомби, а в своре арифметика переворачивается: пока
    // щит поднят, бот не бьёт, свора живёт дольше и бьёт дольше, и гасится
    // при этом только фронт. Менять доктрину по этому рассуждению нельзя —
    // сначала померить. Поле нужно, чтобы мерить стало на чем: теперь каждый
    // бой, живой в том числе, приносит своё число врагов рядом с исходом.
    mobs: null,
    sawMobs (n) {
      if (!this.mobs) this.mobs = { atStart: n, max: n }
      else if (n > this.mobs.max) this.mobs.max = n
    },

    // Every swing, so the report can say what the block cost in tempo rather
    // than in arithmetic: seconds of contact divided by swings landed is the
    // one number that is comparable between a run with a shield and one
    // without, and it is the only thing «щит стоит своей цены» can mean.
    swung () { st.swings++ },

    // Which mob the accounting is about. Without it upMs is still honest but
    // the tempo — what the block cost — has nothing to measure against.
    watch (entity, r) {
      sh.target = entity || null
      if (typeof r === 'number') sh.reach = r
    },
    blocking,
    nativeUse () { return sh.charge?.snapshot() ?? { useConfirmed: false, confirmedTicks: null } },
    failure () { return sh.charge?.why() || (gameClock.now() < Math.max(sh.disabledUntil, bot._ndShieldDisabledUntil || 0) ? 'shield_cooldown' : null) },
    get cancelled () { return sh.charge?.cancelled },

    // Put it on the arm and make the server say so. Returns false with a reason
    // in the report rather than throwing: a fight without a shield is a fight,
    // and this must never be the thing that ends one.
    async wear () { return shieldWear(sh) },

    // Raise or lower, and for a raise wait for the metadata to agree.
    // Re-sends when the server has dropped the block under us: `want` alone is
    // a memory of a packet, and an axe hit makes that memory wrong.
    async raise (raised) { return shieldRaise(sh, raised) },

    // Null when there was nothing to say, so an ordinary fistfight report does
    // not grow a paragraph about a shield nobody has.
    report () { return shieldReport(sh, guard) },

    close () { shieldClose(sh) }
  }
  return guard
}

function shieldState (session, ctl, policy): ShieldState {
  const bot = session.bot
  const on = policy !== 'never'
  const st = {
    policy,
    have: false,
    worn: false,
    raises: 0,
    confirmed: 0,
    blocked: 0,
    disabled: 0,
    // Worst observed lag between asking and the server agreeing, and how many
    // of those agreements landed after raise() had already given up waiting.
    confirmMs: 0,
    lateConfirms: 0,
    // Подъёмы, которых мы не просили. Раньше такой фронт списывался в
    // задержку последнего заказа и давал confirmMs 11827 при окне 600: это
    // не «сервер думал двенадцать секунд», это два разных события, сшитых
    // в одно. Заказ теперь ПОГАШАЕТСЯ первым же фронтом, а всё, что пришло
    // после, считается здесь и в задержку не попадает.
    spontaneous: 0,
    // Сколько звуков вообще долетело за бой. Один integer, который
    // отличает «сервер молчал» от «звуков было сорок, щитового ни одного» —
    // без него ноль погашенных не диагностируется вообще ничем.
    soundsHeard: 0,
    upMs: 0,
    openMs: 0,
    facingMs: 0,
    idleMs: 0,
    reachMs: 0,
    swings: 0,
    hpUp: 0,
    hpDown: 0
  }
  const sh: ShieldState = {
    session, ctl, bot, policy, on, st, census: null, blocking: null,
    why: null, want: false, up: false, disabledUntil: 0, lastAsk: 0, target: null, reach: 3.2,
    lastHp: bot && typeof bot.health === 'number' ? bot.health : 20, lastTick: 0, closed: false, charge: null
  }
  const blocking = () => !sh.closed && !ctl.aborted && offHandItem(bot)?.name === 'shield' &&
    gameClock.now() >= Math.max(sh.disabledUntil, bot._ndShieldDisabledUntil || 0) && shieldUp(bot) && !!sh.charge?.ready(SHIELD_DELAY_TICKS)
  const census = process.env.ND_SHIELD_SOUNDS ? new Map() : null
  Object.assign(sh, { blocking, census })
  return sh
}

// Слушатели боя: звук блока, откат щита топором, урон под щитом и без, выборка подъёма раз в 100 мс.
function shieldListen (sh: ShieldState) {
  const { bot, st, census, blocking } = sh
  // Server-confirmed proof that the block did something. Packet coordinates
  // are eighths, hence a plain distance check against our own feet.
  // Имя звука — через melee.soundName (2026-09-26): mineflayer (sound.js)
  // берёт bot.registry.sounds[id] без сдвига, а номера minecraft-data 1.21.11
  // на 1 меньше серверных (замер melee.js, SOUND_SHIFT) — по его
  // soundEffectHeard «item.shield.block» был выбитый щит (item.shield.break), а
  // настоящий блок приходил чужим именем, и счёт погашенных врал.
  const onSound = (name, pt) => {
    if (!pt || !name) return
    try {
      if (bot.entity.position.distanceTo(pt) > SHIELD_SOUND_RANGE) return
    } catch { return }
    st.soundsHeard++
    // Перепись имён — только по требованию: она нужна ровно один раз, когда
    // надо выяснить, под каким именем звук приходит и приходит ли. Держать
    // её в каждом отчёте боя — платить токенами за отладку, которая кончилась.
    if (census) census.set(String(name), (census.get(String(name)) || 0) + 1)
    if (String(name).endsWith('item.shield.block')) st.blocked++
  }

  // An axe hit knocks the shield out of use for a few seconds, and the only
  // thing said about it on the wire is a cooldown. mineflayer's own handler
  // (inventory.js:91) reads packet.itemID, which does not exist in 1.21.11 —
  // the field is cooldownGroup, a string like "minecraft:shield" — so it always
  // returns early and this has to be read off the raw packet.
  const onCooldown = (pkt) => {
    const group = String((pkt && pkt.cooldownGroup) || '')
    if (!/shield/.test(group)) return
    st.disabled++
    sh.disabledUntil = gameClock.now() + Math.max(0, (pkt.cooldownTicks || 0)) * 50
    bot._ndShieldDisabledUntil = sh.disabledUntil
  }

  // Damage split by whether the block was actually up when it landed. This is
  // the honest version of "сколько урона щит съел": the counterfactual is not
  // knowable, two columns are.
  const onHealth = () => {
    const now = typeof bot.health === 'number' ? bot.health : sh.lastHp
    const lost = sh.lastHp - now
    sh.lastHp = now
    if (lost <= 0) return
    if (blocking()) st.hpUp += lost
    else st.hpDown += lost
  }

  // Sampled rather than counted from our own raise/lower calls, because the
  // server drops the block under us (an axe does exactly that) and a tally of
  // what we asked for would never notice.
  const tick = () => {
    const now = gameClock.now()
    const dt = sh.lastTick ? now - sh.lastTick : 0
    sh.lastTick = now
    const nowUp = shieldUp(bot)
    // The rising edge is counted HERE and nowhere else. raise() waits only long
    // enough to answer its own caller; a confirmation that arrives after that is
    // still a confirmation, and this loop is the one that never stops listening.
    // That is the whole difference between «сервер отказал» and «я перестал
    // слушать», and only one of the two means the shield is not working.
    if (nowUp && !sh.up) {
      st.confirmed++
      if (sh.lastAsk) {
        const lag = now - sh.lastAsk
        // Гасим заказ: следующий фронт — это уже другое событие, и мерить
        // его от этого же lastAsk значит складывать время между событиями с
        // задержкой ответа.
        sh.lastAsk = 0
        if (lag > st.confirmMs) st.confirmMs = lag
        if (lag > SHIELD_CONFIRM_MS) st.lateConfirms++
      } else {
        st.spontaneous++
      }
    }
    sh.up = nowUp
    // A gap this long means the timer was starved, not that the shield was up
    // for a second: do not bill it.
    if (dt <= 0 || dt >= 1000) return
    let close = false
    if (sh.target && sh.target.isValid) {
      try { close = sh.target.position.distanceTo(bot.entity.position) <= sh.reach } catch {}
    }
    // Time in contact is billed whether or not the shield is up: it is the
    // denominator the tempo is measured against, and without it "щит стоил
    // ударов" has no number to be true or false against.
    if (close) st.reachMs += dt
    if (nowUp) {
      st.upMs += dt
      if (close) st.idleMs += dt
      if (sh.target && sh.target.isValid && facingCos(bot, sh.target.position) > 0) st.facingMs += dt
    } else {
      // Знаменатель для второй колонки урона. Без него hpUnderShield и hpOpen
      // сравнивать нельзя: 3 хп за секунду и 3 хп за минуту — это одно число.
      st.openMs += dt
    }
  }

  const onRawSound = (p) => {
    try {
      const n = (require('../melee') as typeof import('../melee')).soundName(bot, p)
      if (n) onSound(n, new Vec3(p.x / 8, p.y / 8, p.z / 8))
    } catch {}
  }
  try { bot._client.on('sound_effect', onRawSound) } catch {}
  bot.on('health', onHealth)
  try { bot._client.on('set_cooldown', onCooldown) } catch {}
  const timer = gameClock.setInterval(tick, 100)
  if (timer.unref) timer.unref()
  Object.assign(sh, { tick, onRawSound, onHealth, onCooldown, timer })
}

async function shieldWear (sh: ShieldState) {
  const { session, bot, on, st } = sh
  if (!on) return false
  const found = findShield(bot)
  if (!found) { sh.why = 'щита нет ни в руке, ни в рюкзаке'; return false }
  st.have = true
  if (found.worn) { st.worn = true; return true }
  // Тотем в левой руке на малом хп не менять на щит: в бою 2026-09-25 новый
  // бой надел щит поверх тотема, и бот умер на 7 хп с тотемом в рюкзаке.
  const offNow = bot.inventory.slots[45]
  if (offNow && offNow.name === 'totem_of_undying' && (bot.health ?? 20) <= 16) { sh.why = 'в левой руке тотем — хп мало, щит не надеваю'; return false }
  // The cursor is shared with the autopilot's eating and with armor.js.
  // Two click loops at once strand an item on it — armor.js:200 pays for
  // that lesson, and this is the same cursor.
  if (bot.currentWindow) { sh.why = 'открыт сундук — щит не трогаю'; return false }
  if (session.armorBusy) { sh.why = 'переодеваюсь — щит потом'; return false }
  if (bot.inventory.selectedItem) { sh.why = 'руки заняты другим кликом'; return false }
  session.armorBusy = true
  try {
    await bot.equip(found.item, 'off-hand')
  } catch (err) {
    sh.why = String((err && err.message) || err)
    return false
  } finally {
    session.armorBusy = false
  }
  // moveSlotItem applies the click to bot.inventory itself and only then
  // writes the packet (inventory.js:658), so reading slot 45 straight back
  // is our own guess wearing a hat. One settle window, then look — the same
  // rule armor.js:236 states for the armour slots.
  await sleep(250)
  const off = offHandItem(bot)
  st.worn = !!(off && off.name === 'shield')
  if (!st.worn) sh.why = 'сервер не подтвердил off-hand'
  return st.worn
}

async function shieldRaise (sh: ShieldState, raised) {
  const { ctl, bot, on, st, tick } = sh
  if (!on || !st.worn) return false
  if (!raised) {
    if (!sh.want) return false
    sh.want = false
    sh.charge?.close(); sh.charge = null
    try { bot.deactivateItem() } catch {}
    // Close the edge here rather than waiting for the sampler to notice.
    // Lower and raise sit 60ms apart in a melee cycle, the sampler runs
    // every 100ms, and a cycle that fits between two samples looked like no
    // edge at all: five raises came back as three confirmations. Damage
    // attribution does not suffer, because onHealth still reads the live
    // metadata and the server has not lowered anything yet.
    sh.up = false
    return false
  }
  if (sh.want) {
    if (shieldUp(bot)) return true
    // Re-asking is only safe once the server has been seen to answer at
    // least once. Every activateItem() writes a fresh use_item
    // (inventory.js:115-138) and a fresh use restarts the block from zero,
    // so a bot that re-sent every tick because it could not see its own
    // metadata would hold a shield that never finishes raising. If nothing
    // has ever been confirmed, ask once and leave it: the packet did go out.
    if (!st.confirmed || gameClock.now() - sh.lastAsk < 1000) return false
  }
  // Do not spam the packet at a shield the server is holding on cooldown;
  // the disable is timed and re-asking cannot shorten it.
  if (gameClock.now() < Math.max(sh.disabledUntil, bot._ndShieldDisabledUntil || 0)) return false
  sh.want = true
  sh.lastAsk = gameClock.now()
  st.raises++
  try {
    sh.charge?.close()
    sh.charge = (require('../bow') as typeof import('../bow')).observeCharge(bot, { item: 'shield', hand: 'off-hand' })
    if (!sh.charge.start()) { sh.why = sh.charge.why() || 'shield_native_use_not_started'; return false }
  } catch (err) {
    sh.why = String((err && err.message) || err)
    return false
  }
  const deadline = gameClock.now() + SHIELD_CONFIRM_MS
  let aborted
  const abort = new Promise(resolve => { aborted = () => resolve(null); if (ctl.aborted) aborted(); else ctl.onAbort?.push(aborted) })
  try { while (gameClock.now() < deadline && !ctl.aborted && !sh.closed && sh.charge) {
    // tick() and not a counter of our own: the rising edge has exactly one
    // owner, and polling at 40ms sees blocks that go up and back down
    // between two 100ms samples — five melee raises came back as three
    // confirmations before this line existed.
    if (shieldUp(bot)) { tick(); return true }
    if (sh.charge.why()) return false
    await Promise.race([sleep(40), sh.charge.cancelled, abort])
  } } finally {
    const i = ctl.onAbort?.indexOf(aborted)
    if (i >= 0) ctl.onAbort.splice(i, 1)
  }
  // Not «сервер отказал» — only «не в то окно, ради которого стоит держать
  // тик боя». The sampler keeps watching and will still count it.
  return false
}

function shieldReport (sh: ShieldState, guard) {
  const { policy, st, census, blocking } = sh
  if (!st.have && !st.raises && policy !== 'never') {
    const bare: any = { policy, worn: false, why: sh.why || 'щита нет' }
    bare.note = shieldNote(bare)
    return bare
  }
  const sec = ms => Math.round(ms / 100) / 10
  const out: any = {
    policy,
    worn: st.worn,
    raises: st.raises,
    confirmed: st.confirmed,
    confirmMs: st.confirmMs || undefined,
    lateConfirms: st.lateConfirms || undefined,
    spontaneous: st.spontaneous || undefined,
    // Погашенные удары считаются по звуку item.shield.block с сервера, и
    // это свидетель, которого может не быть: прогон 2026-09-01 дал
    // blocked 0 при щите, который урон явно резал. Поэтому ниже идёт
    // второй свидетель — урон в секунду под щитом и без, — и решать
    // «работает ли щит» надо по нему, а не по этому счётчику.
    blocked: st.blocked,
    soundsHeard: st.soundsHeard,
    sounds: census ? [...census.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12) : undefined,
    disabled: st.disabled || undefined,
    ...guard.nativeUse(),
    blocking: blocking(),
    upSeconds: sec(st.upMs),
    facingSeconds: sec(st.facingMs),
    // Time the block was up while the mob was inside sword reach: the only
    // stretch where holding it could have cost anything at all.
    closedSeconds: sec(st.idleMs),
    contactSeconds: sec(st.reachMs),
    swings: st.swings,
    // Seconds of contact per swing landed. The loop aims at 0.65; anything
    // above that is time the bot stood in melee dealing no damage, whatever
    // the reason, and that is the price the brain has to weigh.
    secondsPerSwing: st.swings ? Math.round((st.reachMs / st.swings) / 100) / 10 : null,
    hpUnderShield: Math.round(st.hpUp * 10) / 10,
    hpOpen: Math.round(st.hpDown * 10) / 10,
    openSeconds: sec(st.openMs),
    // Вот это и есть ответ на «работает ли щит», не требующий ни звука,
    // ни контрфактического прогона: урон в секунду, пока блок стоял,
    // против урона в секунду, пока он был опущен, в одном и том же бою.
    hpPerSecUnder: st.upMs > 500 ? Math.round((st.hpUp / (st.upMs / 1000)) * 100) / 100 : null,
    hpPerSecOpen: st.openMs > 500 ? Math.round((st.hpDown / (st.openMs / 1000)) * 100) / 100 : null,
    why: sh.why || undefined
  }
  out.note = shieldNote(out)
  return out
}

function shieldClose (sh: ShieldState) {
  const { bot, timer, onRawSound, onHealth, onCooldown } = sh
  if (sh.closed) return
  sh.closed = true
  sh.charge?.close(); sh.charge = null
  gameClock.clearInterval(timer)
  try { bot._client.removeListener('sound_effect', onRawSound) } catch {}
  bot.removeListener('health', onHealth)
  try { bot._client.removeListener('set_cooldown', onCooldown) } catch {}
  if (sh.want) { sh.want = false; try { bot.deactivateItem() } catch {} }
}

// One line for a person, and it has to be able to say the unwelcome thing:
// a shield that never went up is worse than no shield, because the code that
// thought it was up also stopped swinging.
function shieldNote (s) {
  if (s.policy === 'never') return 'щит не поднимался (велено без щита)'
  if (!s.worn) return `щит не надет: ${s.why || 'причина неизвестна'}`
  if (s.raises && !s.confirmed) {
    return 'поднимал ' + s.raises + ' раз, и за весь бой сервер не подтвердил ни разу ' +
      '(слушали всё время боя, а не только окно ожидания) — считай, что щита нет'
  }
  if (!s.raises) return 'щит на руке, поднимать не пришлось'
  const bits = [`щит был поднят ${s.upSeconds}с`]
  // Урон в секунду под щитом против урона в секунду без него. Это ведущая
  // цифра, а не счётчик погашенных: прогон 2026-09-01 дал ноль погашенных при
  // щите, который урон резал, — свидетель по звуку оказался тем, которого
  // может не быть, а этот считается из хп, которые видно всегда.
  const under = s.hpPerSecUnder
  const open = s.hpPerSecOpen
  if (under !== null && under !== undefined && open !== null && open !== undefined) {
    bits.push(`урон ${under}/с под щитом против ${open}/с без него`)
  } else {
    bits.push(`урон под щитом ${s.hpUnderShield}, без щита ${s.hpOpen}`)
  }
  if (s.blocked) bits.push(`сервер насчитал погашенных: ${s.blocked}`)
  else if (under !== null && under !== undefined && open) {
    bits.push(under < open
      ? 'по звуку сервер о блоках молчит, но урон под щитом ниже — щит работает'
      : 'погашенных нет и урон не ниже — щит тут не помог')
  }
  if (s.upSeconds > 0 && s.facingSeconds < s.upSeconds * 0.6) {
    bits.push(`но лицом к цели только ${s.facingSeconds}с — блок гасит только спереди`)
  }
  if (s.closedSeconds > 0) {
    bits.push(`в упор стоял под щитом ${s.closedSeconds}с из ${s.contactSeconds}с`)
  }
  if (s.secondsPerSwing !== null && s.secondsPerSwing !== undefined) {
    bits.push(`темп ${s.secondsPerSwing}с/удар при норме 0.65`)
  }
  if (s.lateConfirms) {
    bits.push(`подтверждение приходило до ${s.confirmMs}мс — щит работал, ` +
      'просто медленнее окна ожидания')
  }
  if (s.disabled) bits.push(`сбит топором ${s.disabled} раз`)
  return bits.join(', ')
}

export {
  OFF_HAND_SLOT, HAND_ACTIVE, HAND_IS_OFF, SHIELD_CONFIRM_MS, SHIELD_DELAY_TICKS, SHIELD_NATIVE_CONFIRM_MS, SHIELD_SOUND_RANGE, MEASURE_PHASE_MS, offHandItem, findShield, livingFlagsKey, shieldUp, facingCos, makeShield, shieldNote
}
