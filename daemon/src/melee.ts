'use strict'
import * as gameClock from './game-clock'
// Ядро ближнего боя (просьба 2026-09-26: «все приёмы про-игроков, по максимуму
// того, что даёт версия»). В арене боты делали 30–60 критов и 0–5 спринт-ударов
// за раунд и «ездили» от каждого чужого удара. Здесь:
//  · заряд удара — по тикам сервера, а не «625 мс + 50 запаса»;
//  · выбор спринт-удара или крита по ситуации, «спринт-крит»;
//  · W-tap и S-tap с тиковой точностью (на physicsTick, не на таймере цикла);
//  · ×0.6 себе после своего спринт-удара — как делает ванильный клиент;
//  · ответный удар по приходу его отброса (hit-select) и jump-reset;
//  · атрибут-свап меч → топор по щиту (щит выключен на 100 тиков без потери
//    заряда меча);
//  · поднять щит за 5 тиков до его удара, бить в окно подъёма его щита;
//  · счёт — по звукам сервера, а не по своим флагам.
//
// Числа — декомпилированный клиент 1.21.11 (github extremeheat/
// extracted_minecraft_data, ветка client1.21.11, пути от net/minecraft/):
//  * world/entity/player/Player.attack: заряд c = clamp((t + 0.5)/T, 0, 1),
//    T = 20/attack_speed (getAttackStrengthScale(0.5), getCurrentItemAttack-
//    StrengthDelay); c > 0.9 — крит и спринт-удар; спринт-удар — это
//    isSprinting() СЕРВЕРА; onAttack обнуляет t;
//  * Player.tick: ++t каждый тик; другой предмет в главной руке (сверка после
//    пакетов тика) — t = 0; «слот Б, удар, слот А» в одном тике заряд не
//    трогает (атрибут-свап, MC-28289, PVP-RESEARCH б.3);
//  * Player.causeExtraKnockback (сила > 0; спринт даёт +0.5): жертве knockback
//    по взгляду бьющего, бьющему скорость ×(0.6, 1, 0.6) и setSprinting(false).
//    Клиент зовёт тот же Player.attack у себя (MultiPlayerGameMode.attack), и по
//    игроку (client/player/RemotePlayer.hurtClient = true) делает ×0.6 и себе;
//  * Player.canCriticalAttack: fallDistance > 0, не на земле, не в воде, не
//    верхом, цель живая, !isSprinting() (сервера);
//  * LivingEntity.jumpFromGround: vy = max(0.42, vy), спринт — +0.2 по взгляду;
//  * LivingEntity.getSecondsToDisableBlocking: Weapon у getWeaponItem() (у
//    топора 5 с) — и только если он же getActiveItem(): свой поднятый щит
//    выбивание гасит, его опускаем до удара;
//  * LivingEntity.getItemBlockingWith: щит держит с blockDelayTicks = 5
//    (Items.SHIELD: BlocksAttacks(0.25F, …)) после начала использования;
//  * server/network/ServerGamePacketListenerImpl.handleSetCarriedItem: смена
//    слота при щите в левой руке щит не опускает;
//  * звуки сервера (Player.attack, attackVisualEffects) — по позиции бьющего:
//    entity.player.attack.knockback — спринт-удар, .crit, .strong, .weak,
//    .sweep, .nodamage.

const EYE = 1.62
const TICK_MS = 50
// Номер звука сервера → номер в minecraft-data (см. install: сдвиг замерен).
const SOUND_SHIFT = { '1.21.11': 1 }
// Топор по щиту сменой слота в одном тике (слот топора, удар, слот меча).
// Замер try-swap.js на тестовом Paper 1.21.11 (2026-09-26): щит выбит —
// set_cooldown minecraft:shield на 100 тиков, как и полагается; но Paper
// (paper-global.yml unsupported-settings.update-equipment-on-player-actions:
// true) берёт атрибуты нового предмета сразу и обнуляет заряд: свап-удар по
// открытому — 1.8 урона (топор при нулевом заряде) вместо 7 мечом. То есть на
// Paper это просто быстрая смена (не хуже прежней: equip, удар, equip), а
// «удар с зарядом меча» — только на ванильном сервере (мир по LAN) — там
// ND_ATTR_SWAP=1, как у mace.js. ND_FAST_AXE=0 — прежняя смена через equip.
const FAST_AXE = process.env.ND_FAST_AXE !== '0'
const SWAP_KEEPS_CHARGE = process.env.ND_ATTR_SWAP === '1'
// Запас на доставку пакета по LAN и джиттер таймера Windows (15.6 мс).
const SEND_MARGIN_MS = 8

// T = 20 / attack_speed, тиков (атрибуты предметов, world/item/Items.java;
// PVP-RESEARCH б.1). Кулак и прочее — 4.0 игрока.
function cooldownTicks (name) {
  if (!name) return 5
  if (/_sword$/.test(name)) return 12.5
  if (/^(wooden|stone|copper)_axe$/.test(name)) return 25
  if (name === 'iron_axe') return 20 / 0.9
  if (/_axe$/.test(name)) return 20
  if (/_pickaxe$/.test(name)) return 20 / 1.2
  if (/_shovel$/.test(name)) return 20
  if (name === 'wooden_hoe' || name === 'golden_hoe') return 20
  if (name === 'stone_hoe' || name === 'copper_hoe') return 10
  if (name === 'iron_hoe') return 20 / 3
  if (/_hoe$/.test(name)) return 5
  if (name === 'trident') return 20 / 1.1
  if (name === 'mace') return 20 / 0.6
  const spear = { wooden_spear: 13, stone_spear: 15, copper_spear: 17, iron_spear: 19, golden_spear: 19, diamond_spear: 21, netherite_spear: 23 }
  if (spear[name]) return spear[name]
  return 5
}
// Сколько тиков после сброса нужно, чтобы заряд был ≥ need: (t + 0.5)/T ≥ need.
function ticksFor (T, need) {
  // c > 0.9 строго (крит, спринт-удар): t > 0.9T − 0.5.
  if (need < 1) return Math.floor(need * T - 0.5) + 1
  return Math.ceil(T - 0.5)
}

// Имя звука из пакета sound_effect с поправкой SOUND_SHIFT (замер — в install
// ниже). Общее для всех, кто сверяет звук по имени: soundEffectHeard mineflayer
// берёт bot.registry.sounds[id] без сдвига и называет выбитый щит
// (item.shield.break) «item.shield.block» (combat.js, read.js; 2026-09-26).
// Звук, заданный в пакете именем (data.soundName), — как есть.
function soundName (bot, p) {
  const s = p && p.sound
  if (s && s.data && s.data.soundName) return String(s.data.soundName).replace(/^minecraft:/, '')
  const id = s ? s.soundId : (p && p.soundId)
  if (id == null) return ''
  const e = bot.registry && bot.registry.sounds && bot.registry.sounds[id + (SOUND_SHIFT[bot.version] || 0)]
  return e && e.name ? String(e.name) : ''
}

function heldName (bot) { return bot.heldItem ? bot.heldItem.name : null }
function isPlayer (e) { return !!e && (e.type === 'player' || !!e.username) }
function hotbarIndex (bot, test) {
  for (let i = 0; i < 9; i++) { const it = bot.inventory.slots[36 + i]; if (it && test(it)) return i }
  return -1
}

// ---------------------------------------------------------------- на бота

// Взгляд тела не принимает NaN/бесконечность (s7-arms 06.10: yaw=pitch=NaN у тела → каждый ход с NaN →
// Paper кикает «Invalid move player packet received»). Остаётся прежний взгляд; откуда пришло — в лог со стеком.
function guardAngles (bot) {
  const e = bot.entity
  if (!e || e._ndAngleGuard) return
  const val = { yaw: Number.isFinite(e.yaw) ? e.yaw : 0, pitch: Number.isFinite(e.pitch) ? e.pitch : 0 }
  let at = -Infinity
  for (const k of ['yaw', 'pitch']) {
    Object.defineProperty(e, k, {
      configurable: true, enumerable: true, get: () => val[k],
      set: (v) => {
        if (Number.isFinite(v)) { val[k] = v; return }
        e._ndAngleRejects = (e._ndAngleRejects || 0) + 1
        if (gameClock.wall.now() - at > 2000) { at = gameClock.wall.now(); console.log(`[nan-guard] ${k}=${v} отвергнут (${e._ndAngleRejects})\n${String(new Error().stack).split('\n').slice(2, 16).join('\n')}`) }
      }
    })
  }
  e._ndAngleGuard = true
  // bot.look(NaN) кладёт NaN ещё и в lastSentYaw физики (мимо entity) — тогда NaN во всех следующих ходах.
  // Отсекаем на входе; кто звал — в лог (взгляд lookAt на точку с NaN).
  if (!bot._ndLookGuard && typeof bot.look === 'function') {
    const look0 = bot.look
    bot.look = function (yaw, pitch, ...rest) {
      if (Number.isFinite(yaw) && Number.isFinite(pitch)) return look0.call(this, yaw, pitch, ...rest)
      e._ndAngleRejects = (e._ndAngleRejects || 0) + 1
      if (gameClock.wall.now() - at > 2000) { at = gameClock.wall.now(); console.log(`[nan-guard] look(${yaw}, ${pitch}) отвергнут\n${String(new Error().stack).split('\n').slice(2, 16).join('\n')}`) }
      return Promise.resolve()
    }
    // lookAt(точка с NaN) — снаружи reflex-lock, чтобы в стеке был настоящий вызывающий (внутри очереди он теряется).
    const lookAt0 = bot.lookAt
    if (typeof lookAt0 === 'function') {
      bot.lookAt = function (point, ...rest) {
        if (!point || [point.x, point.y, point.z].every(Number.isFinite)) return lookAt0.call(this, point, ...rest)
        e._ndAngleRejects = (e._ndAngleRejects || 0) + 1
        if (gameClock.wall.now() - at > 2000) { at = gameClock.wall.now(); console.log(`[nan-guard] lookAt(${JSON.stringify(point)}) отвергнут\n${String(new Error().stack).split('\n').slice(2, 12).join('\n')}`) }
        return Promise.resolve()
      }
    }
    bot._ndLookGuard = true
  }
}

// Один раз на бота: часы заряда, спринт сервера, скорость тиков сервера,
// звуки ударов. Всё — по пакетам, которые уходят и приходят.
function install (bot) {
  if (bot._ndMelee) return bot._ndMelee
  const M: any = {
    resetAt: 0, // когда сервер обнулил t (наш удар или смена предмета)
    held: heldName(bot),
    srvSprint: false, // что сервер думает о нашем спринте
    lastAttack: null, // { t, id, c, sprint, local }
    msPerTick: TICK_MS,
    listeners: new Set()
  }
  // Producer catch-up may include ticks from before our packet. Preserve the
  // public gameplay timestamp, but bound charge by continuous time since reset.
  let resetAt = 0, resetObservedAt = -Infinity
  Object.defineProperty(M, 'resetAt', { configurable: true, enumerable: true, get: () => resetAt,
    set: at => { resetAt = at; resetObservedAt = gameClock.observationNow() } })
  const elapsed = () => Math.min(gameClock.now() - M.resetAt, gameClock.observationNow() - resetObservedAt)
  bot._ndMelee = M
  // Сервер — Paper/Spigot (бренд minecraft:brand) или ванильный (мир по LAN):
  // у них разное со сбросом заряда (взмах в воздух — см. ниже).
  M.paperLike = () => /paper|spigot|bukkit|purpur|folia/i.test(String((bot.game && bot.game.serverBrand) || ''))
  guardAngles(bot)
  bot.on('spawn', () => guardAngles(bot))
  const w0 = bot._client.write
  let heldSlot = bot.quickBarSlot
  let nanAt = -Infinity
  bot._client.write = function (name, params) {
    // Ход с NaN/бесконечностью сервер не прощает: Paper кикает «Invalid move player packet received»
    // (s7-arms 06.10: 6 киков за 20 минут гонки вооружений). Не слать и сказать, откуда взялся.
    if ((name === 'position' || name === 'position_look' || name === 'look') && params &&
        ['x', 'y', 'z', 'yaw', 'pitch'].some(k => k in params && (!Number.isFinite(params[k]) || k !== 'yaw' && k !== 'pitch' && Math.abs(params[k]) > 3e7))) {
      M.nanDropped = (M.nanDropped || 0) + 1
      if (gameClock.wall.now() - nanAt > 2000) {
        nanAt = gameClock.wall.now()
        const e = bot.entity || {}
        console.log(`[nan-guard] ${name} ${JSON.stringify(params)} pos=${JSON.stringify(e.position)} vel=${JSON.stringify(e.velocity)} yaw=${e.yaw} pitch=${e.pitch} dropped=${M.nanDropped}\n${String(new Error().stack).split('\n').slice(2, 9).join('\n')}`)
      }
      return
    }
    try {
      if (name === 'use_entity' && params && (params.mouse === 1 || params.type === 1 || params.mouse === 'attack')) {
        const now = gameClock.now()
        const c = M.charge(0)
        M.lastAttack = { t: now, id: params.target, c, sprint: M.srvSprint, local: bot.getControlState('sprint') }
        M.resetAt = now
        // Спринт-удар снимает спринт на сервере (causeExtraKnockback), если
        // удар прошёл; прошёл ли — скажет звук или урон цели (ниже).
        if (M.srvSprint && c > 0.9) M.lastAttack.sprintTry = true
        for (const f of (M.listeners as any)) { try { f('attack', M.lastAttack) } catch {} }
      } else if (name === 'held_item_slot' && Number.isInteger(params?.slotId) && params.slotId >= 0 && params.slotId < 9) {
        const changed = params.slotId !== heldSlot
        heldSlot = params.slotId
        // Paper detects equipment on a real slot change, even sword→wind→sword within one physics tick.
        // Player.detectEquipmentUpdates resets only for a different item type, not another stack of the same sword.
        const held = bot.inventory?.slots?.[36 + heldSlot]?.name || null
        if (changed && M.paperLike() && held !== M.held) { M.held = held; M.resetAt = gameClock.now() }
      } else if (name === 'entity_action' && params) {
        const a = params.actionId
        if (a === 'start_sprinting' || a === 3) M.srvSprint = true
        else if (a === 'stop_sprinting' || a === 4) M.srvSprint = false
      } else if (name === 'arm_animation') {
        // Взмах без удара (в воздух, жест, резка паутины мечом, копание) на
        // Paper обнуляет свой заряд: замер human-агента 2026-09-26 — железный
        // меч с полным зарядом 5/4/4 урона, после трёх взмахов в воздух
        // 0.39/0/1.39. Ванильный сервер (мир по LAN) — нет:
        // ServerGamePacketListenerImpl.handleAnimate только resetLastActionTime и
        // swing. Взмах самого удара (bot.attack шлёт use_entity, потом взмах) —
        // не в счёт: удар и так обнулил.
        if (M.paperLike() && !(M.lastAttack && gameClock.now() - M.lastAttack.t < 5)) { M.resetAt = gameClock.now(); M.airSwings = (M.airSwings || 0) + 1 }
      }
    } catch {}
    return w0.apply(this, arguments)
  }
  // Player.tick: другой предмет в руке к концу тика — заряд с нуля.
  // И сдвиг по высоте за тик: крит — только когда ПОСЛЕДНИЙ пакет позиции уже
  // ниже прошлого (ServerPlayer.doCheckFallDamage копит fallDistance лишь при
  // dy < 0). По скорости «падаем» уже на вершине (тик 6: сдвиг +0.003, а vy уже
  // −0.076) — удар на этом тике шёл без крита: в арене 2026-09-26 сервер
  // насчитал 0 критов на 86 ударов старого кода (critcheck: по скорости — 7
  // урона и attack.strong, по позиции — 10.5 и attack.crit).
  M.y = null
  M.dy = 0
  bot.on('physicsTick', () => {
    const h = heldName(bot)
    if (h !== M.held) { M.held = h; M.resetAt = gameClock.now() }
    const y = bot.entity && bot.entity.position ? bot.entity.position.y : null
    M.dy = y != null && M.y != null ? y - M.y : 0
    M.y = y
  })
  M.critNow = () => !!bot.entity && !bot.entity.onGround && M.dy < -1e-3 && !bot.entity.isInWater
  // Tempo and server stalls are handled once by game-clock. A game tick is
  // always 50 nominal ms; estimating it again would stretch attack cooldowns.
  M.msPerTick = TICK_MS
  // Заряд, каким его увидит сервер, если удар уйдёт через aheadMs.
  M.ticksSince = (aheadMs = 0) => Math.max(0, Math.floor((elapsed() + aheadMs - SEND_MARGIN_MS) / M.msPerTick))
  M.T = () => cooldownTicks(heldName(bot))
  M.charge = (aheadMs = 0) => Math.min(1, (M.ticksSince(aheadMs) + 0.5) / M.T())
  // Через сколько мс заряд дойдёт до need (1 — полный, 0.91 — крит/спринт).
  M.leftMs = (need = 1) => {
    const k = ticksFor(M.T(), need)
    return Math.max(0, SEND_MARGIN_MS + k * M.msPerTick - elapsed())
  }
  // Звуки удара — правда сервера: чей удар — по тому, у кого ноги ближе к точке.
  // Имя — по номеру в реестре со сдвигом: в minecraft-data 1.21.11 номера
  // звуков на 1 больше, чем у сервера (замер 2026-09-26 на Paper 1.21.11: удар
  // мечом с полным зарядом на земле, 7 урона, приходил как «attack.strong»
  // вместо «attack.sweep», удар в кадры неуязвимости — «attack.knockback»
  // вместо «attack.nodamage», крик раненого — «entity.player.death»). Сдвиг
  // ниже 1241-го номера этим замером не проверен — нам нужны только эти.
  bot._client.on('sound_effect', (p) => {
    try {
      const n = soundName(bot, p)
      if (!/entity\.player\.attack\.|item\.shield\.(block|break)|item\.totem\.use/.test(n)) return
      const pt: any = { x: p.x / 8, y: p.y / 8, z: p.z / 8 }
      pt.distanceTo = (v) => Math.hypot(v.x - pt.x, v.y - pt.y, v.z - pt.z)
      for (const f of (M.listeners as any)) { try { f('sound', { n, pt }) } catch {} }
    } catch {}
  })
  return M
}

// ---------------------------------------------------------------- на бой

function fight (bot, { target, style = {}, stepSafe = null, keyDir = null, jumpOk = null }: any = {}) {
  const mf = fightState(bot, { target, style, jumpOk })
  fightListen(mf)
  fightKnockback(mf)
  const { st, skill, M } = mf
  return {
    st,
    skill,
    clock: M,
    hit: (e, opts?) => meleeHit(mf, e, opts),
    rearm: () => meleeRearm(mf),
    override: (keys) => meleeOverride(mf, keys),
    choose: (ctx) => meleeChoose(mf, ctx),
    shield: (opts) => meleeShield(mf, opts),
    planning: () => !!mf.plan,
    setCounter: (fn) => { mf.counterFn = fn },
    close: () => meleeClose(mf),
    report: () => meleeReport(mf)
  }
}

// Один ближний бой (прежние let и const замыкания fight): часы удара M, счёт st, характер skill, тиковый план клавиш,
// ожидание звука крита (pend), размены, серия спринт-ударов, ответный удар (counterFn).
interface MeleeFight {
  bot: any; target: any; jumpOk: any; M: any; st: any; HIT_SELECT: boolean; skill: any; kbMeasures: any[]; conv: any
  plan: any // { steps: [{…клавиши}], i, cur, why }
  pend: any; lastHurtAt: number; myHitAt: number; swingAt: number; serie: number; counterFn: any
  applyStep: (s: any) => void; startPlan: (steps: any[], why: string) => void; convMiss: (why: string) => void
  convResolve: (tail: any) => void; ent: () => any
  onTick?: () => void; onHurt?: (victim: any, source: any) => void; onMelee?: (kind: string, x: any) => void; onRawVel?: (buf: any) => void
}

function fightState (bot, { target, style, jumpOk }: any): MeleeFight {
  const M = install(bot)
  const st = {
    swings: 0, sprintTries: 0, sprintHits: 0, crits: 0, strong: 0, weak: 0, sweeps: 0, nodamage: 0,
    his: { sprintHits: 0, crits: 0, strong: 0, weak: 0 },
    slow06: 0, wtaps: 0, staps: 0, rearms: 0, sprintCrit: 0,
    swaps: 0, shieldBreaks: 0, freshShieldHits: 0,
    jumpResets: 0, knocks: 0, counterHits: 0, kbPlain: [], kbReset: [],
    combos: [], combo: 0, shieldBlocks: 0, choice: { sprint: 0, crit: 0 },
    // S7d (хит-селект, пункт H): размены — серия ударов с паузой ≤ 1.5 с; кто попал первым, попадания сторон;
    // отлёт после своего ответного удара; взмахи без попадания и в его кадры неуязвимости (≤ 10 тиков после нашего).
    ex: { n: 0, first: 0, mine: 0, his: 0 }, kbCounter: [], empty: 0, iframeSwings: 0
  }
  // ND_HIT_SELECT=0 — без ответного удара по приходу его отброса и без ожидания его удара (сравнение на снимках).
  const HIT_SELECT = process.env.ND_HIT_SELECT !== '0'
  const skill = {
    jumpReset: style.jumpReset ?? (0.65 + Math.random() * 0.3),
    counter: process.env.ND_HIT_SELECT === '0' ? 0 : style.counter ?? (0.6 + Math.random() * 0.35),
    sprintBias: style.sprintBias ?? (0.25 + Math.random() * 0.2)
  }
  const mf: MeleeFight = { bot, target, jumpOk, M, st, HIT_SELECT, skill, kbMeasures: null, conv: null, plan: null, pend: null,
    lastHurtAt: -1e9, myHitAt: -1e9, swingAt: 0, serie: 0, counterFn: null,
    applyStep: null, startPlan: null, convMiss: null, convResolve: null, ent: null }
  // Тиковый план клавиш: шаг 0 — сейчас, шаг i — на i-м тике физики после;
  // поверх решений цикла (override). cur — шаг, что в силе сейчас: цикл не
  // должен перескочить через отпущенный на тик «вперёд» (иначе STOP и START
  // уйдут в одном тике — так ванильный клиент не умеет).
  const applyStep = (s) => { for (const [k, v] of (Object.entries(s) as [string, any][])) { try { bot.setControlState(k, v) } catch {} } }
  const startPlan = (steps, why) => {
    mf.plan = { steps, i: 1, cur: steps[0], why }
    applyStep(steps[0])
  }
  // Замер отброса: где были в тик удара, где через 12 тиков, по его направлению.
  const kbMeasures = []

  // Конверсия крита (2026-09-26: 23 выбора крита — 5 критов по звуку сервера).
  // На каждый удар «критом» — что было в момент пакета (земля, сдвиг последнего
  // пакета позиции, спринт сервера, вода, заряд) и какой звук сервер вернул:
  // причина промаха — по первому нарушенному условию Player.canCriticalAttack.
  const conv = { tries: 0, hits: 0, miss: {} }
  const convMiss = (why) => { conv.miss[why] = (conv.miss[why] || 0) + 1 }
  const convResolve = (tail) => {
    const p = mf.pend
    mf.pend = null
    if (!p) return
    if (tail === 'crit') { conv.hits++; return }
    if (tail === 'nodamage') return convMiss('не прошёл (щит, кадры)')
    if (tail == null) return convMiss('звука нет')
    if (p.c <= 0.9) return convMiss('заряд')
    if (p.srv || tail === 'knockback') return convMiss('спринт сервера')
    if (p.ground) return convMiss('на земле')
    if (!(p.dy < -1e-3)) return convMiss(p.diag && p.diag.race ? 'не падал: гонка' : p.diag && !p.diag.jumped ? 'не падал: подбросило' : 'не падал')
    if (p.water) return convMiss('вода')
    if (p.web) return convMiss('паутина')
    convMiss('прочее: ' + tail)
  }

  // Попадание и серия: наши удары подряд без его ответа.
  const ent = () => { try { return typeof target === 'function' ? target() : target } catch { return null } }
  Object.assign(mf, { kbMeasures, conv, applyStep, startPlan, convMiss, convResolve, ent })
  return mf
}

// Слушатели боя: тик (план клавиш, замер отброса, звук крита не пришёл), попадания сторон, звуки удара сервера.
function fightListen (mf: MeleeFight) {
  const { bot, M, st, kbMeasures, applyStep, convResolve, ent } = mf
  const onTick = () => {
    if (mf.pend && gameClock.now() - mf.pend.t > 400) convResolve(null)
    if (mf.plan) {
      if (mf.plan.i >= mf.plan.steps.length) mf.plan = null
      else {
        mf.plan.cur = mf.plan.steps[mf.plan.i++]
        applyStep(mf.plan.cur)
      }
    }
    for (let i = kbMeasures.length - 1; i >= 0; i--) {
      const m = kbMeasures[i]
      if (--m.left > 0) continue
      kbMeasures.splice(i, 1)
      const p = bot.entity.position
      const d = (p.x - m.p.x) * m.dx + (p.z - m.p.z) * m.dz
      ;(m.counter ? st.kbCounter : m.reset ? st.kbReset : st.kbPlain).push(Math.round(d * 100) / 100)
    }
  }
  bot.on('physicsTick', onTick)

  const onHurt = (victim, source) => {
    const e = ent()
    if (!e || !victim) return
    const mine = victim.id === e.id && source && bot.entity && source.id === bot.entity.id
    const his = victim === bot.entity && source && source.id === e.id
    if (mine || his) {
      const now = gameClock.now()
      if (now - mf.lastHurtAt > 1500) { st.ex.n++; if (mine) st.ex.first++ }
      mf.lastHurtAt = now
      if (mine) { st.ex.mine++; mf.myHitAt = now; mf.swingAt = 0 } else st.ex.his++
    }
    if (mine) st.combo++
    if (victim === bot.entity && source && source.id === e.id) {
      if (st.combo) st.combos.push(st.combo)
      st.combo = 0
    }
  }
  bot.on('entityHurt', onHurt)

  const onMelee = (kind, x) => {
    const e = ent()
    if (kind === 'sound' && bot.entity) {
      const mine = bot.entity.position.distanceTo(x.pt) < 1.2
      const his = e && e.position && e.position.distanceTo(x.pt) < 1.2
      const tail = x.n.replace(/^.*\./, '')
      if (/item\.shield\.block/.test(x.n)) { if (mine) st.shieldBlocks++; return }
      if (/item\.shield\.break/.test(x.n)) { if (his) st.shieldBreaks++; return }
      if (/item\.totem/.test(x.n)) return
      if (mine) {
        if (mf.pend && gameClock.now() - mf.pend.t < 400) convResolve(tail)
        if (tail === 'knockback') { st.sprintHits++; M.srvSprint = false } else if (tail === 'crit') st.crits++
        else if (tail === 'strong') st.strong++
        else if (tail === 'weak') st.weak++
        else if (tail === 'sweep') st.sweeps++
        else if (tail === 'nodamage') st.nodamage++
      } else if (his) {
        if (tail === 'knockback') st.his.sprintHits++
        else if (tail === 'crit') st.his.crits++
        else if (tail === 'strong') st.his.strong++
        else if (tail === 'weak') st.his.weak++
      }
    }
  }
  M.listeners.add(onMelee)
  Object.assign(mf, { onTick, onHurt, onMelee })
}

// ---------------------------------------------------------------- отброс

// Его удар пришёл (скорость себе в пакете; edges.fixSelfKnockback уже
// поставил её верно — слушаем после него): jump-reset и ответный удар.
// counterFn(e) — решает бой (заряд, досягаемость, щит): вернуть true, если
// ударил.
function fightKnockback (mf: MeleeFight) {
  const { bot, jumpOk, st, HIT_SELECT, skill, kbMeasures, startPlan, ent } = mf
  const onVel = () => {
    try {
      const e = ent()
      const me = bot.entity
      if (!e || !me || !e.position || !me.onGround) return
      const v = me.velocity
      const h = Math.hypot(v.x, v.z)
      if (h < 0.2 || v.y < 0.2) return
      // От него ли: толчок направлен от него к нам.
      const ax = me.position.x - e.position.x; const az = me.position.z - e.position.z
      const an = Math.hypot(ax, az) || 1
      if ((v.x * ax + v.z * az) / (h * an) < 0.3 || an > 5) return
      st.knocks++
      let reset = false
      // Jump-reset: прыжок в этот же тик с зажатым спринтом, лицом к нему —
      // +0.2 к нему (LivingEntity.jumpFromGround) против его толчка.
      // jumpOk (pvp.js, 2026-09-26): прыжок к нему уносит в яму между нами — нет.
      if (Math.random() < skill.jumpReset && (bot.food ?? 20) > 6 && (!jumpOk || jumpOk(e))) {
        reset = true
        st.jumpResets++
        startPlan([{ jump: true, forward: true, sprint: true, back: false }, { jump: false }], 'jump-reset')
      }
      const kb = { p: me.position.clone(), dx: ax / an, dz: az / an, left: 12, reset, counter: false }
      kbMeasures.push(kb)
      // Ответный удар (hit-select): наш спринт-удар в этот же тик — ×0.6
      // гасит 40% его толчка, а он получает полный.
      if (HIT_SELECT && mf.counterFn && Math.random() < skill.counter) {
        if (mf.counterFn(e)) { st.counterHits++; kb.counter = true }
      }
    } catch {}
  }
  // Разбор скорости — у edges.fixSelfKnockback (слушает раньше, ставит
  // bot.entity.velocity); здесь только «это нам?» по id в начале пакета (с
  // номером пакета впереди или без него — как там же).
  const varint = (buf, off) => { let v = 0; let s = 0; let b; do { b = buf[off++]; v |= (b & 0x7f) << s; s += 7 } while (b & 0x80 && s < 35); return { v, off } }
  const onRawVel = (buf) => {
    try {
      if (!bot.entity || !buf) return
      const mine = [varint(buf, 0).off, 0].some(o => varint(buf, o).v === bot.entity.id)
      if (mine) setImmediate(onVel)
    } catch {}
  }
  bot._client.on('raw.entity_velocity', onRawVel)
  mf.onRawVel = onRawVel
}

// ---------------------------------------------------------------- удар

// Удар сейчас: свап (топор по щиту), ×0.6 себе после спринт-удара по игроку,
// тиковый план после удара. opts.swapTo — индекс хотбара предмета Б.
function meleeHit (mf: MeleeFight, e, { swapTo = -1, after = null, kind = null, diag = null }: any = {}) {
  const { bot, M, st, conv, startPlan, convResolve } = mf
  if (!e || !bot.entity) return null
  const c = M.charge(0)
  const local = bot.getControlState('sprint')
  const srv = M.srvSprint
  const back = bot.quickBarSlot
  let swapped = false
  if (swapTo >= 0 && swapTo !== back && bot.inventory.slots[36 + swapTo]) {
    bot.setQuickBarSlot(swapTo)
    swapped = true
  }
  try { bot.attack(e) } catch {}
  {
    const now = gameClock.now()
    if (mf.swingAt && now - mf.swingAt > 300) st.empty++ // прошлый взмах так и не попал
    mf.swingAt = now
    if (now - mf.myHitAt < 500) st.iframeSwings++
  }
  if (kind === 'crit') {
    if (mf.pend) convResolve(null)
    conv.tries++
    mf.pend = { t: gameClock.now(), c, srv, ground: !!bot.entity.onGround, dy: M.dy, water: !!bot.entity.isInWater, web: !!bot.entity.isInWeb, diag }
  }
  if (swapped) { bot.setQuickBarSlot(back); st.swaps++ }
  st.swings++
  if (srv && c > 0.9) st.sprintTries++
  if (kind) st.choice[kind] = (st.choice[kind] || 0) + 1
  if (!srv && local && c > 0.9 && !bot.entity.onGround) st.sprintCrit++
  // Player.causeExtraKnockback на клиенте: сила > 0 (спринт при c > 0.9 —
  // клиент судит по своему спринту) — ×0.6 себе и спринт клиента снят.
  if (isPlayer(e) && local && c > 0.9) {
    const v = bot.entity.velocity
    v.x *= 0.6; v.z *= 0.6
    st.slow06++
  }
  if (after === 'wtap') { st.wtaps++; startPlan([{ forward: false, sprint: false }, { forward: true, sprint: true }], 'wtap') } else if (after === 'stap') { st.staps++; startPlan([{ forward: false, sprint: false, back: true }, { back: true }, { back: false }], 'stap') }
  return { c, srv, local, swapped }
}

// Перевзвести спринт сервера (STOP, тик, START) — если он снят чужим
// (нашим спринт-ударом), а спринт-удар нужен: ванильный клиент шлёт не больше
// одного из них за тик (LocalPlayer.sendIsSprintingIfNeeded).
function meleeRearm (mf: MeleeFight) {
  const { st, startPlan } = mf
  if (mf.plan) return false
  st.rearms++
  startPlan([{ sprint: false }, { sprint: true, forward: true }], 'rearm')
  return true
}

// Клавиши цикла — поверх них тиковый план (W-tap, S-tap, прыжок-сброс).
function meleeOverride (mf: MeleeFight, keys) {
  if (!mf.plan) return keys
  const s = mf.plan.cur || {}
  const out = { ...keys }
  for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) if (k in s) out[k] = s[k]
  return out
}

// ---------------------------------------------------------------- выбор

// Спринт-удар или крит (Tutorial:PvP; PVP-RESEARCH в.4 п.1). Спринт-удар —
// когда отброс решает: первый удар, толчок к краю, он бежит на нас, я слабее
// (уйти из размена), ответ на его удар, продолжение серии. Крит — когда он
// беззащитен (урон ×1.5 важнее отброса) и в остальных случаях по характеру.
// «Бежит на нас» — рывок издалека (d > 3.2), а не колебание сближения в
// размене вплотную: первая арена с этим правилом дала 90% спринт-ударов и
// ни одного крита. Серия спринт-ударов — не длиннее трёх: дальше крит.
function meleeChoose (mf: MeleeFight, ctx) {
  const { M, skill } = mf
  let k = 'crit'
  if (ctx.meInWeb) k = 'plain'
  else if (ctx.creeper || ctx.defenseless) k = 'crit'
  else if (ctx.edgeSprint || ctx.first || ctx.counter) k = 'sprint'
  // Окно для крита в прыжке — пока его удар не готов (вершина на 6-м тике,
  // падение с 7-го): он не успеет ответить, пока мы в воздухе. Готов —
  // прыжок дарит ему первый удар. Крит падает на него через тик-два после
  // нашей готовности (прыжок за 6 тиков до неё, спуск с 7-го тика) — его
  // удар должен быть не готов и тогда.
  // Готов раньше, и он достаёт — крита не будет: бить придётся на подъёме в
  // гонке (арена 2026-09-26: 27 из 36 промахов крита — удар на подъёме в
  // гонке). Спринт-удар: кто первый, тот с отбросом.
  else if (ctx.hisReadyMs != null && ctx.hisReadyMs > (ctx.myReadyMs || 0) + 2 * M.msPerTick) k = 'crit'
  else if (ctx.hisReadyMs != null && ctx.close) k = 'sprint'
  else if (ctx.charging && mf.serie < 2) k = 'sprint'
  else if (ctx.weaker && mf.serie < 2 && Math.random() < 0.6) k = 'sprint'
  else if (mf.serie === 1 && ctx.comboOn) k = 'sprint'
  else k = Math.random() < skill.sprintBias ? 'sprint' : 'crit'
  mf.serie = k === 'sprint' ? mf.serie + 1 : 0
  return k
}

// ---------------------------------------------------------------- щит

// Поднять за ≥ 5 тиков (blockDelayTicks) до того, как его удар может
// прийти: он в досягаемости (или войдёт в неё за это время) и его заряд
// будет готов; опустить, когда бьём сами или его удара не будет.
// Топор у него в руке (S7d, пункт H): по jar удар топором по поднятому щиту гасится ЦЕЛИКОМ (blocks_attacks), а щит
// выключается на 5 с (weapon.disable_blocking_for_seconds). Прежде — запрет «под топором щит не поднимать»: в «топор
// против щита» щит не поднимался ни разу, сторона с топором — 20 из 20 (s7d-b-27, s7d-p-27). Теперь — цена: щит не
// держится заранее (подъём ровно на задержку блока, 5 т, и сразу вниз после его взмаха), взмах топора гасится, его
// ход — 5 с без щита, мой — без его урона топором. ND_SHIELD_AXE=0 — прежний запрет.
function meleeShield (mf: MeleeFight, { theirR, closing = 0, hisReadyMs = 0, hisHand = '', myLeftMs = 999, inMyReach = false }: any) {
  const { M } = mf
  const axe = /_axe$/.test(hisHand)
  if (axe && process.env.ND_SHIELD_AXE === '0') return 'lower'
  // Запас 6 тиков и против топора (ревью Codex: 5 т задержки блока + доставка пакета и шаг цикла).
  const leadMs = 6 * M.msPerTick
  const soon = theirR <= 3.3 + Math.max(0, closing) * (leadMs / TICK_MS)
  if (inMyReach && myLeftMs <= M.msPerTick) return 'lower'
  if (soon && hisReadyMs <= leadMs) return 'raise'
  if (theirR > 4.8 || hisReadyMs > leadMs + (axe ? 1 : 4) * M.msPerTick) return 'lower'
  return null
}

function meleeClose (mf: MeleeFight) {
  const { bot, M, st, onTick, onHurt, onMelee, onRawVel } = mf
  bot._client.removeListener('raw.entity_velocity', onRawVel)
  bot.removeListener('physicsTick', onTick)
  bot.removeListener('entityHurt', onHurt)
  M.listeners.delete(onMelee)
  mf.counterFn = null
  mf.plan = null
  if (st.combo) { st.combos.push(st.combo); st.combo = 0 }
}

function meleeReport (mf: MeleeFight) {
  const { st, HIT_SELECT, skill, conv } = mf
  const avg = (a) => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 100) / 100 : undefined
  return {
    swings: st.swings,
    sprintHits: st.sprintHits,
    sprintTries: st.sprintTries,
    crits: st.crits,
    strong: st.strong || undefined,
    weak: st.weak || undefined,
    choice: st.choice,
    critConv: conv.tries ? { tries: conv.tries, hits: conv.hits, miss: Object.keys(conv.miss).length ? conv.miss : undefined } : undefined,
    combo: st.combos.length || st.combo ? { max: Math.max(st.combo, ...st.combos), avg: avg(st.combos.concat(st.combo ? [st.combo] : [])), n: st.combos.length } : undefined,
    wtaps: st.wtaps || undefined,
    staps: st.staps || undefined,
    rearms: st.rearms || undefined,
    slow06: st.slow06 || undefined,
    sprintCrit: st.sprintCrit || undefined,
    swaps: st.swaps || undefined,
    shieldBreaks: st.shieldBreaks || undefined,
    shieldBlocks: st.shieldBlocks || undefined,
    knocks: st.knocks || undefined,
    jumpResets: st.jumpResets || undefined,
    counterHits: st.counterHits || undefined,
    kbPlain: avg(st.kbPlain),
    kbReset: avg(st.kbReset),
    kbCounter: avg(st.kbCounter),
    ex: st.ex.n ? st.ex : undefined,
    empty: st.empty || undefined,
    iframeSwings: st.iframeSwings || undefined,
    hitSelect: HIT_SELECT,
    hsWait: HIT_SELECT && process.env.ND_HS_WAIT !== '0',
    his: st.his,
    skill: { jumpReset: Math.round(skill.jumpReset * 100) / 100, counter: Math.round(skill.counter * 100) / 100, sprintBias: Math.round(skill.sprintBias * 100) / 100 }
  }
}

// Топор в хотбаре — для свапа (из рюкзака свап не достанет).
function axeSlot (bot) {
  return hotbarIndex(bot, i => /_axe$/.test(i.name))
}

export { install, guardAngles, fight, cooldownTicks, ticksFor, axeSlot, hotbarIndex, soundName, EYE, FAST_AXE, SWAP_KEEPS_CHARGE }
