// Рой: гонка вооружений — кто лутает, а кто идёт убивать (пользователь 21.10: «как стал сильным — быстро бежать убивать
// оппонентов, пока не успели обаутиться»; «боты не стремятся к луту сильному»). Решает мир, а не фаза лута по таймеру:
// своё снаряжение против того, что видели на врагах в этом раунде (память снаряжения pvpState.equipment — только видимое:
// материал брони, оружие в руке, блеск). Слабее типичного врага — лут, пока он не вплотную; сильнее с запасом — натиск,
// даже если ещё есть что надеть: время работает на того, кто отстаёт.
import type { SwarmMember, SharedEnemy } from './types'
import type { PvpPlan } from './plan-frame'
import type { PvpMemory } from './board'
import * as damage from '../pvp/damage-model'
import { visibleForce, assessTeamFight } from './fight'
import { distance, count } from './common'

const BEHIND = 0.8 // слабее типичного врага — догонять лутом
const NEAR = 8 // враг ближе — не до лута (бой или отход решают другие)

// Своя сила — той же шкалой, что видим у врага (visibleForce): лучшее оружие (лук и арбалет — со стрелами) и броня.
export function memberForce(m: SwarmMember): number {
  const ranged = (n: string) => n === 'trident' || /^(bow|crossbow)$/.test(n) && count(m.inventory, 'arrow') > 0
  const weapons = [m.weapon, ...Object.keys(m.inventory || {}).filter(n => count(m.inventory, n) > 0 && (damage.isMeleeWeapon(n) || ranged(n)))].filter(Boolean) as string[]
  const armor = (Array.isArray(m.armor) ? m.armor : Object.values(m.armor || {})).filter(Boolean) as string[]
  return Math.max(...[null, ...weapons].map(weapon => visibleForce({ equipment: { weapon, armor } } as SharedEnemy)))
}

// Сила типичного врага (медиана по виденным в раунде); никого не видели — null (решает обычный план: поиск, лут).
export function typicalEnemyForce(S: Pick<PvpPlan, 'state' | 'enemies'>): number | null {
  const seen = new Map<string, number>()
  for (const [id, equipment] of S.state.equipment) seen.set(id, visibleForce({ equipment } as SharedEnemy))
  for (const e of S.enemies) seen.set(e.id, visibleForce(e))
  const forces = [...seen.values()].sort((a, b) => a - b)
  return forces.length ? forces[Math.floor(forces.length / 2)] : null
}

// Слабее типичного врага раунда (без учёта расстояния): врага не видно — догонять лутом, а не прочёсывать.
export function behindRace(S: Pick<PvpPlan, 'state' | 'enemies'>, m: SwarmMember): boolean {
  const theirs = typicalEnemyForce(S)
  return theirs !== null && memberForce(m) < BEHIND * theirs
}

// Лутать ли ему сейчас вместо боя: слабее типичного врага и враг не рядом.
export function racesForLoot(S: Pick<PvpPlan, 'state' | 'enemies'>, m: SwarmMember): { loot: boolean; mine: number; theirs: number | null } {
  const theirs = typicalEnemyForce(S), mine = memberForce(m)
  const near = S.enemies.some(e => distance(e.position, m.position) <= NEAR)
  return { loot: theirs !== null && !near && mine < BEHIND * theirs, mine, theirs }
}

// Сильное меньшинство (пользователь 21.10, один красный в незерите против 29 синих: «рой и так понимает, что против него
// сильный враг, мозг сам оценивает, как действовать», — без отдельной фазы): живых врагов по ленте смертей втрое меньше нас,
// а навалиться всей командой сразу — пустой размен (как groupVerdict: больше трёх своих за одного или нас выносят). Тогда
// бой — как против человека (натиск): штурм готовыми и вместе, голые и переигранные — лут и к своим, бег — только на хилку.
// По правилам «рой на рой» синие бежали от него по открытому («пустой размен») и гибли от лука в спину: 22 смерти за 5 мин,
// у него ни царапины. Навалиться можно — добивание (plan-frame endgame).
// Враг — с самым опасным оружием, что у него видели (арсенал раунда), а выход — с запасом (два своих за одного): оценка
// «вся команда разом» стоит у границы и мигала каждые 1–2 с, стоило ему сменить меч на лук. Врагов не видно — прежняя оценка.
// Модель видит только снаряжение (не хп сверх 20, не яблоки, шипы и разящий клинок): лента смертей поправляет её — враг
// убил двоих наших за раунд и жив — размен уже хуже трёх за одного (то же правило: больше 3 × ½; стенд 21.10: модель —
// «2 за 1», на деле 13 за 0).
export function strongFew(state: PvpMemory, team: SwarmMember[], enemies: SharedEnemy[], foesLeft?: number, killsBy: Record<string, number> = {}): boolean {
  if (foesLeft === undefined || foesLeft <= 0 || team.length < 3 * foesLeft) return state.strongFew = false
  if (!enemies.length) return !!state.strongFew
  const armed = enemies.map(e => {
    const weapon = [...(state.arsenal.get(e.id) || [])].sort((a, b) => visibleForce({ equipment: { ...e.equipment, weapon: b } } as SharedEnemy) - visibleForce({ equipment: { ...e.equipment, weapon: a } } as SharedEnemy))[0]
    return weapon ? { ...e, equipment: { ...e.equipment, weapon } } : e
  })
  const score = assessTeamFight(team, armed)
  const proven = enemies.some(e => (killsBy[e.id] || 0) >= 2)
  const futile = proven || score.wipedUs && score.theirLoss < score.theirs / 4 || score.ourLoss > (state.strongFew ? 2 : 3) * Math.max(score.theirLoss, .5)
  if (futile !== !!state.strongFew && process.env.ND_SWARM_TRACE) console.log(`[${new Date().toTimeString().slice(0, 8)}] 🦁 ${team[0].team}: сильное меньшинство ${futile ? 'да' : 'нет'} — нас ${team.length}, их ${foesLeft}; размен ${score.ourLoss.toFixed(1)} за ${score.theirLoss.toFixed(1)}; ${armed.map(e => `${e.id} ${e.equipment?.weapon ?? '—'} хп≈${e.hpEstimate ?? '?'} убил ${killsBy[e.id] || 0}`).join(', ')}`)
  return state.strongFew = futile
}

// Чем убить сильного, кроме ближнего боя (DeepSeek t7, стенд 21.10: оба убийства чемпиона — булава с падения и сброс в
// пустоту; удар по незериту с Защитой IV — 0.5–1.3 хп, а Шипы III отвечают каждому): булава с зарядом ветра (взлёт и удар
// с падения ~25 хп), зелья вреда (магия мимо брони, 4.3 хп за вред II), заряды ветра (сброс у края).
export function killMeans(m: SwarmMember): { smash: boolean; harm: number; wind: number; axe: boolean } {
  const wind = count(m.inventory, 'wind_charge')
  const harm = Object.entries(m.potions || {}).filter(([k]) => /^splash_(strong_)?harming$/.test(k)).reduce((s, [, n]) => s + (Number(n) || 0), 0)
  return { smash: count(m.inventory, 'mace') > 0 && wind > 0, harm, wind, axe: Object.keys(m.inventory || {}).some(n => /_axe$/.test(n) && count(m.inventory, n) > 0) }
}
// Ближний бой по одной цели: окно неуязвимости (10 тиков) пропускает два удара в секунду на всю команду, и двух мечей
// (зарядка 12 тиков) хватает занять каждое окно; третий и дальше урона не добавляют, а платят шипами и его мечом
// (стенд 21.10: шипы — 2136 хп урона синим, меч — 46 смертей из 131).
export const MELEE_CAP = Math.ceil(damage.ticksToCharge('iron_sword') / damage.IFRAME_TICKS)
