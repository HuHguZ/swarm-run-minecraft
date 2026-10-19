'use strict'
// Автопилот: номера урона 1.21.11, аварийные пороги, крипер; нужда в аварийном уходе и в бегстве от крипера.
import * as gameClock from '../game-clock'
import * as survival from '../combat-safety'

// Сырое, у чего в печи есть жареная пара (рецепты smelting 1.21.11:
// beef, porkchop, mutton, chicken, rabbit, cod, salmon, potato).
export const COOKABLE = /^(beef|porkchop|mutton|chicken|rabbit|cod|salmon|potato)$/

// Номер урона in_wall (удушье в блоке) в реестре damage_type 1.21.11 — реестр по
export const IN_WALL_DAMAGE = 22

export const SELF_GUARDED = new Set([
  'fight', 'retaliate', 'defend', // бой (pvp.js): крепость, отход, лечение — свои
  // shelter (нора) — не здесь: её копка 8–15 с, урон её не рвёт, и под мобом тело теряло 14 хп за копку (разбор
  // смертей fresh-A1..A4: 17 из 98 — в норе у бьющего моба). Отход (коробка/бег) эту копку перехватывает.
  'flee', 'refuge', 'escape_fire', 'sleep', // уже уходит
  'blaze', 'pearls', 'bastion', 'nether_tunnel', // долгие дела Ада со своей защитой (штрек, окоп, яма)
  'dragon'
])
// Урон, за которым стоит моб (тип damage_event 1.21.11, gamedata.DAMAGE_TYPES).
export const MOB_DAMAGE = /^(mob_attack|mob_attack_no_aggro|arrow|mob_projectile|player_attack|trident|sting|spit|fireball|unattributed_fireball|explosion|player_explosion|wither_skull|sonic_boom|thrown|indirect_magic|spear|mace_smash|wind_charge)$/
export const EMERGENCY = {
  // Не чаще раза в 30 с от начала прошлого отхода (он сам длится 15–120 с);
  // дребезг без лечения отсекает взвод на 16 хп.
  cooldownMs: 30000,
  // Гистерезис: после отхода ветка снова взводится, только когда хп
  // поднялось до 16 (там же refuge считает «вылечился»).
  rearmHp: 16,
  // Нижняя граница порога отхода (lowHealth для combat-safety.inspect): см. emergency().
  minHp: 12,
  mobHurtMs: 15000,
  contact: 8,
  // Ходячий дойдёт, если он на нашем уровне (±4) и не дальше 12 бл.
  walkDy: 4,
  walkDist: 12
}

// отбежать (survival.dodgeCreeper). Механика 1.21.11 (Creeper.SwellGoal): шипеть начинает с < 3 бл., гаснет дальше
export const CREEPER = { swellDist: 7, closeDist: 3.3, cooldownMs: 2500, everyTicks: 2 }
// Дела, которые урон не рвёт (session.js HOLDING): у печи, верстака, сундука тело стоит и не отвечает.
export const HOLD_INTENTS = new Set(['smelt', 'craft', 'chest_put', 'chest_take', 'pack', 'sort', 'stash', 'enchant', 'brew', 'cook'])
// Эти сами отвечают за крипера (бой pvp.js — удар и отход) или уже уходят.
export const CREEPER_GUARDED = new Set(['fight', 'retaliate', 'defend', 'flee', 'refuge', 'escape_fire', 'dragon'])
// flee — один раз, не require() на каждый тик у крипера (S9).
let fleeMod
const fleeLazy = () => fleeMod || (fleeMod = (require('../flee') as typeof import('../flee')))
let fightkitMod
export const fightkitLazy = () => fightkitMod || (fightkitMod = (require('../fightkit') as typeof import('../fightkit')))
export function creeperNeed (bot) {
  if (!bot.entity || (bot.health ?? 0) <= 0) return null
  const gm = bot.game && bot.game.gameMode
  if (gm === 'creative' || gm === 'spectator') return null
  const me = bot.entity.position
  let best = null
  for (const e of (Object.values(bot.entities || {}) as any)) {
    if (!e || e.name !== 'creeper' || !e.position || e.isValid === false) continue
    const d = e.position.distanceTo(me)
    if (d > CREEPER.swellDist) continue
    let swelling = false
    try { swelling = fleeLazy().creeperSwelling(bot, e) } catch {}
    if (!swelling && d > CREEPER.closeDist) continue
    // Шипящий в зоне урона (≤ 5 бл.: normal 43/16.75/5.1 на 0/3/5 бл., MOBS.md) — раньше ближнего нешипящего (ревью Codex
    // surv-camp-deaths 02.10); дальше 5 шипящий бьёт ~1 хп — тогда ближний (он вот-вот зашипит вплотную).
    const hot = x => x.swelling && x.d <= 5
    const cand = { e, d, swelling }
    if (!best || (hot(cand) && !hot(best)) || (hot(cand) === hot(best) && d < best.d)) best = cand
  }
  return best
}

// Имя типа урона по номеру: одна копия реестра в gamedata (dev-A, H1); пока её
// нет — та же таблица боя (dragon.DAMAGE_TYPES, тест сверяет номер in_wall).
export function damageTypeName (id) {
  try { const g: typeof import('../gamedata') = require('../gamedata'); if (typeof g.damageTypeName === 'function') return g.damageTypeName(id) } catch {}
  try { return (require('../dragon') as typeof import('../dragon')).DAMAGE_TYPES[id] || null } catch { return null }
}

// Нужен ли отход прямо сейчас. Чистая функция по телу и последнему урону:
// null — нет, иначе { hp, threshold, from, dist, why }.
export function emergencyNeed (bot, { lastHurt = null, lowHealth = 8, now = gameClock.now() }: any = {}) {
  const hp = bot.health ?? 20
  if (!bot.entity || hp <= 0 || hp >= EMERGENCY.rearmHp) return null
  // Горим или в лаве — это огонь, не моб: тушение и огнестойкость (fightkit,
  // extinguish), escape_fire кампании.
  let burning = false
  try { burning = !!bot.entity.isInLava || (bot.entity.metadata && (bot.entity.metadata[0] & 0x01) !== 0) } catch {}
  if (burning) return null
  const mobHurt = !!(lastHurt && lastHurt.byMob && now - lastHurt.at < EMERGENCY.mobHurtMs)
  let safety
  try { safety = survival.inspect(bot, { minHealth: lowHealth }) } catch { return null }
  if (!safety || safety.action === 'dead' || !safety.threats.length || hp > safety.threshold) return null
  const DOC = (require('../flee') as typeof import('../flee')).DOCTRINE
  const me = bot.entity.position
  const reach = []
  for (const t of safety.threats) {
    if (t.anticipated) continue
    const e = bot.entities && bot.entities[t.id]
    if (!e || !e.position) continue
    const doc: { range?: number; radius?: number } = DOC[e.name] || {}
    const shoots = doc.range && t.distance <= doc.range
    const walks = doc.radius > 0 && Math.abs(e.position.y - me.y) <= EMERGENCY.walkDy && t.distance <= EMERGENCY.walkDist
    if (shoots || walks) reach.push({ e, t })
  }
  if (!reach.length) return null
  reach.sort((a, b) => a.t.distance - b.t.distance)
  const first = reach[0]
  // Контакт: ходячий вплотную или стрелок, который нас видит и достаёт (inspect
  // берёт только тех, кто в прямой видимости) — следующий размен уже идёт.
  const contact = first.t.distance <= EMERGENCY.contact ||
    reach.some(x => (DOC[x.e.name] || {}).range >= x.t.distance)
  // Хп ушло не от моба (голод, падение, огонь) и моб ещё не рядом — не повод.
  if (!mobHurt && !contact) return null
  return {
    hp: Math.round(hp),
    threshold: safety.threshold,
    from: first.e.name,
    dist: Math.round(first.t.distance * 10) / 10,
    foes: reach.length,
    why: mobHurt ? `бьёт ${lastHurt.source || first.e.name} (${lastHurt.type})` : `${first.e.name} в ${Math.round(first.t.distance)} бл.`
  }
}
