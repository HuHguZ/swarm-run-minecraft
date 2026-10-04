'use strict'
// Тотем (PVP-RESEARCH в.2, просьба 2026-09-26): проверка «тотем в левую руку
// при ≤ 14 хп» стояла в главном цикле боя, а тот бывает занят по 1–1.6 с
// (натяжение, еда, коробка) — бот мог умереть с тотемом в рюкзаке. Здесь:
//  · новый тотем в левую руку в тот же миг, как сработал прежний (событие 35
//    себе): три пакета в одном тике — слот тотема, «поменять руки», слот
//    оружия; заряд оружия не сбрасывается (Player.tick сверяет руку после);
//  · заранее, когда удар может убить: мало хп при его заряженном оружии,
//    булава сверху, взрывчатка рядом;
//  · щит или тотем в левой руке — по угрозе: щит, пока его удар не смертелен
//    и угроза ему по силам; тотем, когда смертельно.
// Числа — декомпилированный клиент 1.21.11 (extremeheat/extracted_minecraft_data,
// ветка client1.21.11):
//  * world/entity/LivingEntity.checkTotemDeathProtection: сперва правая рука,
//    потом левая; здоровье 1, эффекты (поглощение II — +4 сердца), событие 35
//    всем, включая самого игрока; от #bypasses_invulnerability (пустота, /kill)
//    не спасает;
//  * network/protocol/game/ServerboundPlayerActionPacket.Action
//    SWAP_ITEM_WITH_OFFHAND = 6 (в mineflayer это block_dig со status 6);
//  * урон после брони — world/damagesource/CombatRules.getDamageAfterAbsorb
//    (assess.afterArmor), крит ×1.5 (Player.attack), сила +3 за уровень.

const assess = require('./assess')
const read = require('./read')

const OFF = 45
// Урон оружия (атрибут руки, с базовой 1 игрока) — PVP-RESEARCH б.1.
const WEAPON = {
  wooden_sword: 4, golden_sword: 4, stone_sword: 5, copper_sword: 5, iron_sword: 6, diamond_sword: 7, netherite_sword: 8,
  wooden_axe: 7, golden_axe: 7, stone_axe: 9, copper_axe: 9, iron_axe: 9, diamond_axe: 9, netherite_axe: 10,
  trident: 9, mace: 6
}

function hotbarTotem (bot) {
  for (let i = 0; i < 9; i++) { const it = bot.inventory.slots[36 + i]; if (it && it.name === 'totem_of_undying') return i }
  return -1
}
function anyTotem (bot) { return bot.inventory.items().find(i => i.name === 'totem_of_undying') || null }
function offName (bot) { const o = bot.inventory.slots[OFF]; return o ? o.name : null }

function absorption (bot) {
  try {
    const keys = bot.registry.entitiesByName.player.metadataKeys
    const i = keys.indexOf('player_absorption')
    const v = bot.entity.metadata[i >= 0 ? i : 17]
    return typeof v === 'number' ? v : 0
  } catch { return 0 }
}

// Самый сильный его удар по нам сейчас: оружие × 1.5 (крит) + сила, после
// нашей брони.
// Чары (арена с чарами, 2026-09-26): «Острота» его оружия (компоненты его
// руки сервер присылает целиком — obfuscation в paper-global выключена)
// прибавляется уже после крита, не множится с ним (Player.attack 1.21.11:
// бонус чар var6 = заряд × (getEnchantedDamage − урон), итог var2 × 1.5 + var6;
// +1 за I и +0.5 за каждый уровень выше). Наша «Защита» режет после брони —
// 4% за уровень на каждом куске, сумма не больше 20
// (CombatRules.getDamageAfterMagicAbsorb; от удара рукой — только она, не
// огне-, взрыво- и снарядостойкость). Без этого тотем вставал поздно против
// острого меча и рано в зачарованной броне.
function burstOf (bot, e) {
  if (!e) return 0
  const weapon = e.equipment && e.equipment[0]
  const held = weapon ? weapon.name : null
  let dmg = WEAPON[held] || 1
  try {
    // Частицы эффектов не читаем (цвет); силу видно только своим — берём худшее
    // для оружия в руке, если он пил (этого не знаем) — без силы.
  } catch {}
  dmg *= 1.5
  const sharp = weapon ? read.enchLevel(bot, weapon, 'sharpness') : 0
  if (sharp > 0) dmg += 1 + 0.5 * (sharp - 1)
  const worn = [5, 6, 7, 8].map(s => bot.inventory.slots[s])
  const g = assess.gearOf(worn)
  const epf = Math.min(20, worn.reduce((s, it) => s + (it ? read.enchLevel(bot, it, 'protection') : 0), 0))
  return assess.afterArmor(dmg, g.armor, g.tough) * (1 - epf / 25)
}

function install (bot) {
  if (bot._ndTotem) return bot._ndTotem
  const T = { pops: 0, reequips: 0, reequipFails: 0, preempt: 0, shieldBack: 0, lastPop: 0, lastSwitch: 0, fast: 0, slow: 0, why: {} }
  bot._ndTotem = T
  let busy = false
  // Надеть тотем в левую руку: из хотбара — пакетами в одном тике; из
  // рюкзака — кликами (bot.equip).
  T.equip = (why) => {
    if (busy) return false
    const hb = hotbarTotem(bot)
    if (hb >= 0 && !bot.currentWindow) {
      const back = bot.quickBarSlot
      try {
        if (hb !== back) bot.setQuickBarSlot(hb)
        bot._client.write('block_dig', { status: 6, location: { x: 0, y: 0, z: 0 }, face: 0, sequence: 0 })
        if (hb !== back) bot.setQuickBarSlot(back)
        T.fast++
        T.why[why] = (T.why[why] || 0) + 1
        T.lastSwitch = Date.now()
        return true
      } catch { return false }
    }
    const it = anyTotem(bot)
    if (!it) return false
    busy = true
    T.slow++
    T.why[why] = (T.why[why] || 0) + 1
    T.lastSwitch = Date.now()
    bot.equip(it, 'off-hand').catch(() => { T.reequipFails++ }).finally(() => { busy = false })
    return true
  }
  bot._client.on('entity_status', (p) => {
    try {
      if (!bot.entity || p.entityId !== bot.entity.id || p.entityStatus !== 35) return
      T.pops++
      T.lastPop = Date.now()
      // Сервер уже списал сработавший тотем (shrink до события): левая рука
      // пуста — новый из хотбара встаёт на её место тем же тиком.
      if (T.equip('сработал')) T.reequips++
      else T.reequipFails++
    } catch {}
  })
  return T
}

// Угроза прямо сейчас — нужен ли тотем в левой руке вместо щита.
// ctx: { entity, maceThreat, hisReadyMs, theirR }
function wantTotem (bot, ctx = {}) {
  const hp = (bot.health ?? 20) + absorption(bot)
  const e = ctx.entity
  // Взрывчатка рядом: кристалл, TNT, якорь — удар в десятки хп (PVP-RESEARCH б.10).
  let boom = null
  try {
    const me = bot.entity.position
    boom = bot.nearestEntity(x => x && x.position && (x.name === 'end_crystal' || x.name === 'tnt' || x.name === 'tnt_minecart') && x.position.distanceTo(me) < 8)
    if (!boom) {
      const anchor = bot.findBlock({ matching: b => b && b.name === 'respawn_anchor', maxDistance: 6 })
      if (anchor) boom = anchor
    }
  } catch {}
  if (boom) return { yes: true, why: 'взрывчатка рядом' }
  if (ctx.maceThreat) return { yes: true, why: 'булава сверху' }
  const burst = burstOf(bot, e)
  // Два крита до смерти — уже тотем: между ними 12 тиков, и лечиться некогда.
  const near = ctx.theirR == null || ctx.theirR < 6
  if (near && hp <= Math.max(6, 2 * burst + 1)) return { yes: true, why: `хп ${Math.round(hp)} при его крите ${burst.toFixed(1)}` }
  if (hp <= 6) return { yes: true, why: 'хп на исходе' }
  return { yes: false, burst, hp }
}

module.exports = { install, wantTotem, burstOf, absorption, hotbarTotem, offName, WEAPON }
