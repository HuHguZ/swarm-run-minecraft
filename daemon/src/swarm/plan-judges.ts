// Рой (swarm.ts): оценки плана боя (planPvp) — укрытие, насест, свои для слабого, «переигран», «слабый», нужда в луте,
// цена цели. Читают общее состояние вызова (PvpPlan) в момент вызова; plan-frame привязывает их к нему (S.weak(m) …).
import * as damage from '../pvp/damage-model'
import type { SwarmPosition, SwarmMember, SharedEnemy } from './types'
import type { PvpPlan } from './plan-frame'
import { distance, count } from './common'
import { visibleForce, ownDefense, assessTeamFight } from './fight'

// Укрытие для слабого: дальше от врагов, чем он сам (не навстречу), ближе к нему; занятые другими — дороже (расходятся).
export function hideoutFor(S: PvpPlan, m: SwarmMember): SwarmPosition | null {
  const { enemies, options, hidden } = S
  const near = (p: SwarmPosition) => Math.min(...enemies.map(e => distance(p, e.position)))
  const mine = near(m.position)
  let best = -1, bestScore = -Infinity
  for (const [i, h] of (options.hideouts || []).entries()) {
    if (enemies.length && near(h) <= mine + 2 && !(distance(h, m.position) < 3 && near(h) > 6)) continue
    // Укрытие за врагом не годится: путь к нему идёт мимо него (поле s13: прячусь → бег через красного → 24 → 14 бл.).
    const e0 = enemies.length ? [...enemies].sort((a, c) => distance(a.position, m.position) - distance(c.position, m.position))[0] : null
    if (e0 && distance(h, m.position) > 3 && (h.x - m.position.x) * (m.position.x - e0.position.x) + (h.z - m.position.z) * (m.position.z - e0.position.z) < 0) continue
    const score = Math.min(near(h), 30) - .5 * distance(h, m.position) - 6 * (hidden.get(i) || 0)
    if (score > bestScore) { bestScore = score; best = i }
  }
  if (best < 0) return null
  hidden.set(best, (hidden.get(best) || 0) + 1)
  return options.hideouts![best]
}
// Насест для бегства на элитрах (пользователь 14.10: «убегают плохо на элитре — только по арене внизу, хотя могут наверх
// улетать и там сидеть, кемперить или с лука палить»): элитры (надеты или в рюкзаке) и 3+ ракеты; насест (верх яруса,
// вершина колизея) — дальше 12 бл. от врагов; дальше от них, выше и ближе к нему — лучше, занятый другим — дороже.
export function perchFor(S: PvpPlan, m: SwarmMember): SwarmPosition | null {
  const { enemies, options, perched } = S
  const worn = (Array.isArray(m.armor) ? m.armor : Object.values(m.armor || {})).includes('elytra')
  if (!options.perches?.length || !(worn || count(m.inventory, 'elytra') > 0) || count(m.inventory, 'firework_rocket') < 3) return null
  let best = -1, bestScore = -Infinity
  for (const [i, p] of options.perches.entries()) {
    const near = Math.min(...enemies.map(e => distance(p, e.position)))
    if (near < 12) continue
    const score = Math.min(near, 28) + (p.y - m.position.y) * .3 - distance(p, m.position) * .15 - 8 * (perched.get(i) || 0)
    if (score > bestScore) { bestScore = score; best = i }
  }
  if (best < 0) return null
  perched.set(best, (perched.get(best) || 0) + 1)
  return options.perches[best]
}
// Свои для слабого: самая плотная кучка готовых (двое и больше в 8 бл.) в 24 бл. от него и не ближе к врагу, чем он сам
// (или 8 бл.): навстречу врагу — не к своим; точка — в 3 бл. за кучкой, по другую сторону от врага.
export function rallyFor(S: PvpPlan, m: SwarmMember, foe: SharedEnemy): SwarmPosition | null {
  const { team } = S
  const gap = distance(m.position, foe.position)
  // Свои — и слабые: толпа у него на пути бьёт со спины, а одиночку он догоняет (Codex 15.10, стенд rush).
  const ready = team.filter(a => a.id !== m.id && distance(a.position, foe.position) >= Math.min(gap, 8) && distance(a.position, m.position) <= 24)
  const packs = ready.map(a => ready.filter(o => distance(o.position, a.position) <= 8)).filter(pack => pack.length >= 2)
  const pack = packs.sort((p, q) => q.length * 3 - distance(q[0].position, m.position) * .2 - (p.length * 3 - distance(p[0].position, m.position) * .2))[0]
  if (!pack) return null
  const c = { x: pack.reduce((s, a) => s + a.position.x, 0) / pack.length, z: pack.reduce((s, a) => s + a.position.z, 0) / pack.length }
  // Свои за врагом — не убежище: путь к ним идёт мимо него (как с укрытиями, поле s14).
  if (Math.hypot(c.x - m.position.x, c.z - m.position.z) > 3 && (c.x - m.position.x) * (m.position.x - foe.position.x) + (c.z - m.position.z) * (m.position.z - foe.position.z) < 0) return null
  const d = Math.hypot(c.x - foe.position.x, c.z - foe.position.z) || 1
  return { x: c.x + (c.x - foe.position.x) / d * 3, y: m.position.y, z: c.z + (c.z - foe.position.z) / d * 3 }
}
// Слабый — нечем драться: improvementOf > 4 или брони меньше 8 очков (меньше железных шлема и нагрудника). С одним
// каменным топором improvementOf ровно 4 (8 − 9 → 0, броня 0 → 4), и такой бот голосовал за штурм и шёл на людей
// (пользователь 14.10: «у бота, который пришёл, ничего почти не было из вещей»).
// Порог мягче (15.10, лут по ярусам: внизу кожа и кольчуга — с «броня < 8» рой минуту лутался вместо атаки, «вяло идут»):
// нет оружия, броня < 3 или совсем пусто (improvementOf > 7). Каменный меч и кожаная куртка — уже боец; топор без брони — нет.
// Переигран (пользователь 15.10: «слабые вступают в бой с сильным, который к ним на спавн подбегает, — и помирают»): по
// видимому (шкала visibleForce — материал оружия и брони, как он видит нас и мы его) враг вдвое сильнее. После первого
// сундука (кожа, каменный меч) бот уже не слабый, а незерит убивает его за 2–4 удара (стенд rush 15.10: 8 из 8 убитых —
// так). Такой — как слабый: лут вдали, к своим; бой — загнанным (ближе 5 бл.) или в штурме.
export function outclassed(S: PvpPlan, m: SwarmMember, foe: SharedEnemy | undefined): boolean {
  const { enemies, groups, groupVictories } = S
  if (!foe || !m.inventory) return false
  const weapon = [m.weapon, ...Object.keys(m.inventory).filter(n => count(m.inventory, n) > 0 && damage.isMeleeWeapon(n))].filter(Boolean)
    .sort((a, b) => damage.attackDamage(b) - damage.attackDamage(a))[0]
  const armor = (Array.isArray(m.armor) ? m.armor : Object.values(m.armor || {})).filter(Boolean) as string[]
  if (visibleForce(foe) < 2 * visibleForce({ equipment: { weapon, armor } } as SharedEnemy)) return false
  const group = groups.find(g => g.includes(m))!
  let victories = groupVictories.get(group)
  if (!victories) {
    const ready = group.filter(a => !S.weak(a))
    const foes = enemies.filter(e => ready.some(a => distance(a.position, e.position) <= 40))
    const fight = assessTeamFight(ready, foes)
    victories = new Set(fight.wipedThem && !fight.wipedUs ? foes.map(e => e.id) : [])
    groupVictories.set(group, victories)
  }
  return !victories.has(foe.id)
}
export function weak(S: PvpPlan, m: SwarmMember): boolean { return !!m.inventory && (!Object.keys(m.inventory).some(n => count(m.inventory, n) > 0 && damage.isMeleeWeapon(n)) || ownDefense(m).armor < 3 || S.improvementOf(m) > 7) }
// Насколько боту нужен лут: оружие слабее незеритового меча и недостающая броня (0 — экипирован).
export function improvementOf(S: PvpPlan, m: SwarmMember): number {
  const weapon = Math.max(1, ...Object.keys(m.inventory || {}).filter(n => count(m.inventory, n) > 0 && damage.isMeleeWeapon(n)).map(n => damage.attackDamage(n)))
  return m.inventory ? Math.max(0, 8 - weapon) + Math.max(0, 20 - ownDefense(m).armor) / 5 : 0
}
export function targetCost(S: PvpPlan, m: SwarmMember, e: SharedEnemy): number {
  const { team, enemies, foeCenter, loads, meanStrength } = S
  const local = team.filter(a => distance(a.position, e.position) < 12).reduce((s, a) => s + a.strength, 0) / meanStrength
  const enemyCrowd = enemies.filter(o => distance(o.position, e.position) < 8).length
  const enemyCenterD = Math.hypot(e.position.x - foeCenter.x, e.position.z - foeCenter.z)
  const ranged = m.role === 'ranged' ? Math.abs(distance(m.position, e.position) - 12) : distance(m.position, e.position)
  return ranged + (loads.get(e.id) || 0) * 5 + enemyCrowd * 2 - local * 2 - (m.role === 'flank' ? Math.min(8, enemyCenterD) : 0)
}
