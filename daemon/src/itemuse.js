'use strict'
const gameClock = require('./game-clock')
// Честность (просьба 2026-09-26: «бот должен играть с людьми честно»): пока
// предмет «в ходу» — ест, пьёт, тянет лук, заряжает арбалет, держит щит, —
// ванильный клиент режет ввод движения и не даёт начать спринт. Сервер этого
// не проверяет, а физика mineflayer (prismarine-physics) об этом не знает:
// бот ел яблоко и держал щит на полной скорости (замер tempo, 2026-09-25).
//
// Декомпилированный клиент 1.21.11 (github extremeheat/extracted_minecraft_data,
// ветка client1.21.11, пути от net/minecraft/):
//  * client/player/LocalPlayer.modifyInput: ввод × 0.98; пока isUsingItem() и
//    не верхом — × itemUseSpeedMultiplier() (UseEffects.speedMultiplier); при
//    приседе × SNEAKING_SPEED; потом modifyInputSpeedForSquareMovement (круг в
//    квадрат: по диагонали длина × √(1 + tg²), не больше 1);
//  * world/item/component/UseEffects.DEFAULT = (canSprint=false, …, 0.2F) —
//    еда, зелья, лук, арбалет, щит, трезубец; копьё (world/item/Item.java,
//    Properties.spear) — UseEffects(true, false, 1.0F): ход и спринт как есть;
//  * LocalPlayer.canStartSprinting: … && !isSlowDueToUsingItem() — спринт с
//    предметом в ходу не начать; уже идущий спринт это не гасит
//    (shouldStopRunSprinting предмет не проверяет);
//  * LocalPlayer.isUsingItem() = startedUsingItem: ставится своим use_item с
//    предметом, у которого есть «использование», снимается отпусканием
//    (release_use_item), концом (событие сущности 9) и сменой предмета;
//    метаданные сервера (DATA_LIVING_ENTITY_FLAGS, бит 1) правят его по фронту
//    (LocalPlayer.onSyncedDataUpdated).
//
// Спринт без «вперёд» (2026-09-26, тот же клиент, LocalPlayer.aiStep):
//  * canStartSprinting: не бежит, input.hasForwardImpulse() (ClientInput:
//    moveVector.y > 1e-5 — «вперёд» нажат, «назад» нет), isSprintingPossible
//    (сытость > 6 — Player.hasEnoughFoodToDoExhaustiveManoeuvres; не в мелкой
//    воде), !isSlowDueToUsingItem, не присел (isMovingSlowly);
//  * shouldStopRunSprinting: спринт гаснет, как только нет «вперёд» или спринт
//    невозможен; клавиша спринта зажата — снова начнётся, когда «вперёд»
//    вернётся (canStartSprinting с keyPresses.sprint).
// prismarine-physics смотрит только на клавишу спринта: бот бежал спринтом
// вбок и назад (скорость ×1.3, +0.2 к прыжку), а сервер получал START без
// «вперёд» — спринт-удар стрейфом, чего ванильный клиент не может.
//
// Спринт в стену (2026-09-26, тот же клиент 1.21.11):
//  * LocalPlayer.shouldStopRunSprinting: … || horizontalCollision &&
//    !minorHorizontalCollision — упёрся в стену не вскользь — спринт гаснет;
//    в том же aiStep canStartSprinting его сперва зажигает, а эта проверка
//    сразу гасит: пока упираемся, спринта нет и пакета START тоже нет
//    (sendIsSprintingIfNeeded сверяет итог тика с прошлым);
//  * флаги — от хода ПРОШЛОГО тика: aiStep проверяет спринт до своего
//    travel → Entity.move, а move пишет horizontalCollision = !Mth.equal(хотел.x,
//    вышло.x) || !Mth.equal(хотел.z, вышло.z) и minorHorizontalCollision =
//    isHorizontalCollisionMinor(вышло);
//  * LocalPlayer.isHorizontalCollisionMinor(вышло): угол между вводом (xxa, zza,
//    повёрнутые на yRot) и тем, куда реально сдвинулись по горизонтали,
//    меньше 0.13962634 рад (8°) — «вскользь»; ввода нет или сдвига нет (оба
//    квадрата < 1e-5) — не вскользь: лбом в стену спринт гаснет всегда;
//  * этот же флаг клиент шлёт в каждом пакете движения
//    (ServerboundMovePlayerPacket.horizontalCollision; сервер кладёт его в
//    Entity.setOnGroundWithMovement — им, например, кончается рывок «Тягуна»,
//    LivingEntity.checkAutoSpinAttack). mineflayer шлёт undefined — ставим свой.
// prismarine-physics свой флаг столкновения считает (moveEntity:
// isCollidedHorizontally = dx !== хотел.x || dz !== хотел.z — то же, что
// !Mth.equal, без допуска 1e-5), а «вскользь» — нет: считаем здесь.
//
// Куда встаёт: самый внутренний слой physics.simulatePlayer (под рефлексом
// края edges.guard, который берёт bot._ndSimOrig), и только на настоящем тике
// тела — прогнозы (edges, pathfinder) не трогаются.

const FLAGS_INDEX = 8
// Attributes.SNEAKING_SPEED по умолчанию 0.3; prismarine-physics умножает на
// свой physics.sneakSpeed (тоже 0.3) сам — здесь его делим обратно.
const SNEAK_SPEED = 0.3
// Сервер не подтвердил начало за это время — использования не было (еда при
// полной сытости, лук без стрел): сервер тогда молчит.
const UNCONFIRMED_MS = 300

// Предметы, у которых use_item начинает «использование» (ItemStack.use →
// startUsingItem). Еда — при сытости < 20, кроме «всегда съедобных»
// (FoodProperties.canAlwaysEat: золотые яблоки, хорус, подозрительное рагу, мёд).
const ALWAYS_EAT = /^(golden_apple|enchanted_golden_apple|chorus_fruit|suspicious_stew|honey_bottle)$/
const DRINKS = /^(potion|milk_bucket|ominous_bottle|honey_bottle)$/
function usable (bot, item) {
  if (!item) return false
  const n = item.name
  if (DRINKS.test(n) || n === 'shield' || n === 'trident' || /_spear$/.test(n) || n === 'spyglass' || n === 'goat_horn' || n === 'brush') return true
  if (n === 'bow') return bot.inventory.items().some(i => /arrow$/.test(i.name))
  if (n === 'crossbow') {
    // Заряженный стреляет сразу (CrossbowItem.use), «использования» нет.
    try { const c = item.componentMap && item.componentMap.get('charged_projectiles'); if (c && c.data && (c.data.projectiles || c.data.items || []).length) return false } catch {}
    return bot.inventory.items().some(i => /arrow$|firework_rocket/.test(i.name))
  }
  let food = false
  try { food = !!(bot.registry.foodsByName && bot.registry.foodsByName[n]) } catch {}
  if (!food) return false
  return ALWAYS_EAT.test(n) || (bot.food ?? 20) < 20
}
// UseEffects: копьё — (can_sprint, 1.0); остальное — DEFAULT (нет, 0.2).
function effectsOf (name) {
  if (/_spear$/.test(name || '')) return { canSprint: true, mult: 1.0 }
  return { canSprint: false, mult: 0.2 }
}

// LocalPlayer.modifyInput для клавиш prismarine (right − left, forward − back),
// и обратно — в числа, которые prismarine умножит на 0.98 (и на sneakSpeed).
function scaledControl (c, mult, sneakSpeed) {
  const x0 = (c.right ? 1 : 0) - (c.left ? 1 : 0)
  const z0 = (c.forward ? 1 : 0) - (c.back ? 1 : 0)
  if (!x0 && !z0) return null
  const sneak = c.sneak ? SNEAK_SPEED : 1
  let x = x0 * 0.98 * mult * sneak
  let z = z0 * 0.98 * mult * sneak
  const len = Math.hypot(x, z)
  if (len <= 0) return null
  const ux = x / len; const uz = z / len
  const ax = Math.abs(ux); const az = Math.abs(uz)
  const tg = az > ax ? ax / az : az / ax
  const k = Math.min(len * Math.sqrt(1 + tg * tg), 1)
  x = ux * k; z = uz * k
  const denom = 0.98 * (c.sneak ? (sneakSpeed || SNEAK_SPEED) : 1)
  return { right: x > 0 ? x / denom : 0, left: x < 0 ? -x / denom : 0, forward: z > 0 ? z / denom : 0, back: z < 0 ? -z / denom : 0 }
}

function flagsOf (bot) {
  try { const f = bot.entity.metadata[FLAGS_INDEX]; return typeof f === 'number' ? f : 0 } catch { return 0 }
}

// LocalPlayer.isHorizontalCollisionMinor: ввод — клавиши prismarine, повёрнутые
// так же, как их поворачивает её applyHeading (yaw' = π − yaw); сдвиг — куда
// реально ушли за тик (dx, dz). Угол < 8° — вскользь.
const MINOR_RAD = 0.13962633907794952
const MTH_EPS = 9.999999747378752E-6
function minorCollision (control, yaw, dx, dz) {
  const strafe = ((control.right || 0) - (control.left || 0)) * 0.98
  const fwd = ((control.forward || 0) - (control.back || 0)) * 0.98
  const y = Math.PI - yaw
  const s = Math.sin(y); const c = Math.cos(y)
  const ix = -(strafe * c + fwd * s)
  const iz = fwd * c - strafe * s
  const i2 = ix * ix + iz * iz
  const m2 = dx * dx + dz * dz
  if (i2 < MTH_EPS || m2 < MTH_EPS) return false
  const cos = (ix * dx + iz * dz) / Math.sqrt(i2 * m2)
  return Math.acos(Math.max(-1, Math.min(1, cos))) < MINOR_RAD
}

function install (bot) {
  if (!bot || bot._ndUse) return bot && bot._ndUse
  const ph = bot.physics
  if (!ph || typeof ph.simulatePlayer !== 'function' || !bot._client) return null
  const U = {
    cur: null, // { hand, name, since, mult, canSprint, confirmed, why }
    realWorld: null,
    // Столкновение прошлого настоящего тика: hc — horizontalCollision, wall —
    // не вскользь (гасит спринт).
    hc: false,
    wall: false,
    stats: { uses: 0, slowTicks: 0, sprintBlocked: 0, sprintNoFwd: 0, sprintStops: 0, sprintStarts: 0, wallStops: 0, wallTicks: 0, ended: {} },
    using: () => !!U.cur
  }
  bot._ndUse = U
  const end = (why) => {
    if (!U.cur) return
    U.stats.ended[why] = (U.stats.ended[why] || 0) + 1
    U.cur = null
    U.endedAt = gameClock.now()
    // Спринт, который хотели начать, пока ели, начнётся на ближайшем тике
    // (canStartSprinting в обёртке физики ниже) — если есть «вперёд».
  }
  const start = (hand, item, why, confirmed = false) => {
    const fx = effectsOf(item && item.name)
    U.cur = { hand, name: item ? item.name : null, since: gameClock.now(), mult: fx.mult, canSprint: fx.canSprint, confirmed, why }
    U.stats.uses++
  }

  // Что уходит на сервер: начало, отпускание, смена слота.
  const w0 = bot._client.write
  bot._client.write = function (name, params) {
    try {
      if (name === 'use_item') {
        const hand = params && params.hand === 1 ? 1 : 0
        const item = hand === 1 ? bot.inventory.slots[45] : bot.heldItem
        if (!U.cur && usable(bot, item)) start(hand, item, 'use_item')
      } else if (name === 'block_dig' && params && params.status === 5) {
        end('отпустил')
      } else if (name === 'held_item_slot') {
        slotMoved = true
      } else if ((name === 'position' || name === 'position_look' || name === 'look' || name === 'flying') && params && params.flags && typeof params.flags === 'object') {
        // ServerboundMovePlayerPacket.horizontalCollision — как у ванильного клиента.
        params.flags.hasHorizontalCollision = !!U.hc
      }
    } catch {}
    return w0.apply(this, arguments)
  }
  let slotMoved = false

  // Сервер: конец глотка (событие 9 себе, ServerPlayer.completeUsingItem) и
  // фронты бита «рука занята» в своих метаданных.
  let lastFlag = 0
  bot._client.on('entity_status', (p) => {
    try { if (bot.entity && p.entityId === bot.entity.id && p.entityStatus === 9) end('доел') } catch {}
  })
  bot.on('entityUpdate', (e) => {
    try {
      if (!bot.entity || e !== bot.entity) return
      const f = flagsOf(bot) & 1
      if (f && !lastFlag) {
        if (U.cur) U.cur.confirmed = true
        else {
          const hand = (flagsOf(bot) & 2) ? 1 : 0
          start(hand, hand === 1 ? bot.inventory.slots[45] : bot.heldItem, 'сервер', true)
        }
      } else if (!f && lastFlag) end('сервер снял')
      lastFlag = f
    } catch {}
  })

  // Спринт не начинается с предметом в ходу и без «вперёд» (canStartSprinting);
  // клавишу помним (wantSprint) — спринт начнётся на тике, когда станет можно.
  const origSet = bot.setControlState
  let wantSprint = false
  const fwdImpulse = (c) => !!(c && c.forward && !c.back)
  const eyesWet = () => { try { const b = bot.blockAt(bot.entity.position.offset(0, 1.62, 0)); return !!b && b.name === 'water' } catch { return false } }
  // isSprintingPossible(false): сытость > 6 (или творческий) и не мелкая вода
  // (в воде, а глаза над ней: isInShallowWater).
  const possible = () => (bot.food ?? 20) > 6 || (bot.game && bot.game.gameMode === 'creative')
  const shallow = () => !!(bot.entity && bot.entity.isInWater && !eyesWet())
  const slowUse = () => !!(U.cur && !U.cur.canSprint)
  const keysNow = () => ({ forward: bot.getControlState('forward'), back: bot.getControlState('back'), sneak: bot.getControlState('sneak') })
  const canStart = (c) => fwdImpulse(c) && possible() && !shallow() && !slowUse() && !c.sneak
  bot.setControlState = function (control, state) {
    if (control === 'sprint') {
      wantSprint = !!state
      if (state && !bot.getControlState('sprint')) {
        if (slowUse()) { U.stats.sprintBlocked++; return }
        if (!canStart(keysNow())) { U.stats.sprintNoFwd++; return }
        // Упёрлись в стену (флаги прошлого тика): canStartSprinting зажёг бы,
        // shouldStopRunSprinting тут же погасил — START не уходит; клавиша
        // помнится, спринт начнётся на тике без стены (обёртка ниже).
        if (U.wall) { U.stats.wallStops++; return }
      }
    }
    return origSet.apply(this, arguments)
  }

  // Самый внутренний слой физики.
  const inner0 = bot._ndSimOrig || ph.simulatePlayer
  let lastState = null
  let lastWorld = null
  const wrapped = function (state, world) {
    lastState = state
    lastWorld = world
    const real = !!(world && world === U.realWorld && state && state.control && state.pos)
    let x0 = 0; let z0 = 0
    try {
      // Спринт на настоящем тике — как LocalPlayer.aiStep до хода: нет
      // «вперёд», спринт невозможен или упёрлись в стену не вскользь (флаги
      // хода прошлого тика) — STOP (shouldStopRunSprinting); клавиша спринта
      // зажата и стало можно — START (canStartSprinting; у стены его гасит та
      // же проверка в том же тике — не начинаем вовсе).
      // Клавиши этого тика подменил рефлекс края (edges.guard) — их спринт
      // не трогаем, только гасим.
      if (real) {
        x0 = state.pos.x; z0 = state.pos.z
        const c = state.control
        const run = bot.getControlState('sprint')
        if (U.wall) U.stats.wallTicks++
        if (run && (!fwdImpulse(c) || !possible() || shallow() || U.wall)) {
          origSet.call(bot, 'sprint', false)
          if (U.wall && fwdImpulse(c) && possible() && !shallow()) U.stats.wallStops++
          else U.stats.sprintStops++
          if (state.control.sprint) state.control = { ...state.control, sprint: false }
        } else if (!run && wantSprint && !c._ndGuard && canStart(c) && !U.wall) {
          origSet.call(bot, 'sprint', true)
          U.stats.sprintStarts++
          if (!state.control.sprint) state.control = { ...state.control, sprint: true }
        }
      }
      if (U.cur && world && world === U.realWorld && state && state.control) {
        const sc = scaledControl(state.control, U.cur.mult, ph.sneakSpeed)
        if (sc) {
          state.control = { ...state.control, ...sc }
          U.stats.slowTicks++
        }
      }
    } catch {}
    const out = inner0.call(this, state, world)
    // Entity.move этого тика: столкнулись ли по горизонтали и вскользь ли —
    // для спринта следующего тика и для флага в пакете движения.
    if (real) {
      try {
        const hc = !!state.isCollidedHorizontally
        U.hc = hc
        U.wall = hc && !minorCollision(state.control, state.yaw, state.pos.x - x0, state.pos.z - z0)
      } catch { U.hc = false; U.wall = false }
    }
    return out
  }
  bot._ndSimOrig = wrapped
  if (ph.simulatePlayer === inner0) ph.simulatePlayer = wrapped
  // Настоящий тик: mineflayer зовёт simulatePlayer(new PlayerState(bot, …))
  // и сразу .apply(bot) — после него bot.entity.position и есть state.pos
  // этого вызова (прогнозы копируют позицию и к телу не применяются). Первый
  // слушатель physicsTick видит это раньше всех.
  bot.prependListener('physicsTick', () => {
    try {
      if (lastState && bot.entity && lastState.pos === bot.entity.position) U.realWorld = lastWorld
      else if (ph.simulatePlayer === inner0) ph.simulatePlayer = wrapped // рефлекс края вернул голый оригинал
      lastState = null
      if (slotMoved) {
        slotMoved = false
        // Player.tick/LivingEntity.updatingUsingItem: другой предмет в руке — конец.
        if (U.cur && U.cur.hand === 0 && (!bot.heldItem || bot.heldItem.name !== U.cur.name)) end('сменил предмет')
      }
      if (U.cur && !U.cur.confirmed && gameClock.now() - U.cur.since > UNCONFIRMED_MS) end('сервер не начал')
    } catch {}
  })
  return U
}

module.exports = { install, usable, effectsOf, scaledControl, minorCollision }
