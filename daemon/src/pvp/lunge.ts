// Рывок копьём с «Выпадом» при бегстве (пользователь 21.10: «игроки просто машут им и ускоряются»). Сверка с 1.21.11
// (research/claude-1006/combat-calc-javap, enchantment-json/lunge.json):
//  * укол (STAB, PiercingWeapon.attack) зовёт LivingEntity.lungeForwardMaybe ВСЕГДА, попал он в кого-то или нет —
//    укол в воздух тоже даёт рывок; Player.lungeForwardMaybe — только при hasEnoughFoodToDoExhaustiveManoeuvres
//    (FoodData.hasEnoughFood: сытость > 6, как для спринта);
//  * post_piercing_attack: apply_impulse 0.458 × уровень по взгляду, только по горизонтали (coordinate_scale [1,0,1]);
//    цена — 4 × уровень истощения (≈ уровень единиц сытости) и 1 прочности; нельзя верхом, на элитрах и в воде;
//  * укол — только с полным зарядом (MINIMUM_ATTACK_CHARGE 1.0): раз в swing копья (железное 0.95 с), смена предмета
//    заряд сбрасывает (spear.readyIn ведёт часы).
// Цена против выгоды: рывок 0.458·L бл/т на земле (трение 0.546 за тик) — ≈ L × 1 бл. за укол; спринт-прыжок даёт +0.2
// за прыжок бесплатно. Колоть — когда погоня близко (бегство, а не прогулка) и сытости хватает с запасом.
import * as gameClock from '../game-clock'
import * as read from '../read'
import * as spear from '../spear'

export const IMPULSE = 0.458
const FRICTION = 0.546 // 0.6 (камень) × 0.91 — LivingEntity.travel на земле

// Уровень «Выпада» у копья (0 — нет).
export function lungeLevel (bot, item) {
  if (!item || !spear.isSpear(item.name)) return 0
  return read.enchLevel(bot, item, 'lunge') || 0
}

// Сколько блоков даёт один укол на земле: импульс v = 0.458·L, потом трение (геометрический ряд v·f/(1−f)) плюс сам тик.
export function lungeGain (level: number, friction = FRICTION) {
  const v = IMPULSE * level
  return v + v * friction / (1 - friction)
}

// Стоит ли колоть сейчас: есть чем, сытость > 6 и после укола останется выше 6 (иначе сам рывок и спринт кончатся),
// не в воде, не на элитрах, не верхом; погоня — ближний враг в chase бл.
export function lungeWorth ({ level, food, inWater = false, flying = false, riding = false, chaseD = Infinity, chase = 8 }: any) {
  if (!level || inWater || flying || riding) return false
  if (food - level <= 6) return false
  return chaseD <= chase
}

// Укол в воздух по взгляду yaw (тик физики → взгляд уйдёт в пакете позиции → STAB и взмах, как spear.jab). Копьё уже в
// руке и заряжено (spear.readyIn = 0); иначе — false.
export function lungeJab (bot, yaw: number) {
  return new Promise<boolean>(resolve => {
    const held = bot.heldItem
    if (!held || !spear.isSpear(held.name) || spear.readyIn(bot, held.name) > 0) return resolve(false)
    const S = spear.install(bot)
    let done = false
    const onT = () => {
      if (done) return
      done = true
      gameClock.clearTimeout(timer)
      bot.removeListener('physicsTick', onT)
      bot.look(yaw, 0, true).catch(() => {})
      spear.afterPacket(bot, () => {
        if (!spear.teamSafe(bot)) return resolve(false)
        try {
          bot._client.write('block_dig', { status: 7, location: { x: 0, y: 0, z: 0 }, face: 0, sequence: 0 })
          bot.swingArm('right')
        } catch {}
        S.lastJab = gameClock.now()
        S.lunges = (S.lunges || 0) + 1
        resolve(true)
      })
    }
    bot.on('physicsTick', onT)
    const timer = gameClock.setTimeout(() => { if (!done) { done = true; bot.removeListener('physicsTick', onT); resolve(false) } }, 400)
  })
}

// Копьё с «Выпадом» из рюкзака — в руку (один раз на бегство: смена предмета сбрасывает заряд).
export async function holdLungeSpear (bot) {
  const held = bot.heldItem
  if (held && lungeLevel(bot, held)) return held
  const sp = bot.inventory.items().filter(i => lungeLevel(bot, i)).sort((a, b) => lungeLevel(bot, b) - lungeLevel(bot, a))[0]
  if (!sp) return null
  try { await bot.equip(sp, 'hand') } catch { return null }
  return bot.heldItem && lungeLevel(bot, bot.heldItem) ? bot.heldItem : null
}

// Укол-рывок на бегу: копьё с «Выпадом» в руке (берёт из рюкзака один раз — смена предмета сбрасывает заряд), заряд
// готов, рывок того стоит (lungeWorth) и по ходу свободно на рывок + 1 бл. (clear(n) — пробег без обрыва/лавы/стены у
// вызывающего: flee.runLength). Возвращает 'jab' | 'hold' (взял копьё, заряд копится) | null.
// Пока выключено (ND_LUNGE=1 — включить): сцена try-escape lunge (45 бл., погоня с мечом, «Выпад III», 8+8): 9.0 → 8.6 с,
// отрыв через 8 с 13.4 → 12.1 бл. при 1–7 уколах — выгоды не видно, а сытость и прочность тратятся. Проверить: доходит
// ли импульс до клиента mineflayer (пакет скорости) и не сбрасывает ли укол спринт.
// take — брать копьё из рюкзака (бегство); в коротком отходе толпы — нет: обратная смена на меч сбросит заряд удара.
export async function lungeFlee (bot, yaw: number, { chaseD = Infinity, clear = (n: number) => true, take = true }: any = {}) {
  if (process.env.ND_LUNGE !== '1' || !bot.entity) return null
  const items = bot.inventory.items()
  const best = Math.max(0, ...items.map(i => lungeLevel(bot, i)), lungeLevel(bot, bot.heldItem))
  const ok = lungeWorth({ level: best, food: bot.food ?? 20, inWater: !!bot.entity.isInWater, flying: !!bot.entity.elytraFlying, riding: !!bot.vehicle, chaseD })
  if (!ok) return null
  if (!lungeLevel(bot, bot.heldItem)) return take && (await holdLungeSpear(bot)) ? 'hold' : null
  if (spear.readyIn(bot, bot.heldItem.name) > 0) return 'hold'
  if (!clear(Math.ceil(lungeGain(lungeLevel(bot, bot.heldItem))) + 1)) return null
  return (await lungeJab(bot, yaw)) ? 'jab' : null
}
