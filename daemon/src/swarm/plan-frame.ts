// Рой (swarm.ts): кадр плана боя (planPvp). PvpPlan — общее состояние одного вызова: вход, строй, группы и то, что
// посчитали прежние фазы (plan-assault, plan-flee, plan-doctrines, plan-jobs, plan-assign); фазы читают его по порядку
// и дописывают своё. Оценки plan-judges привязываются к нему здесь.
import type { SwarmPosition, SwarmMember, SharedEnemy, SwarmFact, SwarmTask, SwarmKind, Doctrine, DigSite } from './types'
import type { SwarmBoard, PvpMemory } from './board'
import type { Edge } from './shove'
import { groupOf, groupVerdict, TEAM_LINK, REINFORCE_LINK } from './fight'
import { formation, lineDuty } from './doctrine'
import { hideoutFor, perchFor, rallyFor, outclassed, weak, improvementOf, targetCost, archer, threatReach } from './plan-judges'

// foesLeft — сколько врагов живо (лента смертей в чате — открытое знание, не зрение); нет — неизвестно (соло против людей).
// killsBy — та же лента: сколько наших убил каждый враг за раунд.
export type PvpOptions = { foesLeft?: number; killsBy?: Record<string, number>; doctrine?: Doctrine; quorum?: number; leaseMs?: number; aggressive?: boolean; hideouts?: SwarmPosition[]; perches?: SwarmPosition[]; gather?: { item: string; deficit: number; spot: SwarmPosition }; edgeOf?: (p: SwarmPosition, foe?: SharedEnemy) => Edge | null; digSites?: (p: SwarmPosition) => DigSite[]; campSpots?: SwarmPosition[]; ladderSites?: { key: string; x: number; y: number; z: number; top: number; face: { x: number; z: number } }[] }
type LadderSite = { key: string; x: number; y: number; z: number; top: number; face: { x: number; z: number } }

export interface PvpPlan {
  // вход (planPvp)
  board: SwarmBoard
  options: PvpOptions
  team: SwarmMember[]
  state: PvpMemory
  enemies: SharedEnemy[]
  aggressive: boolean
  doctrine: Doctrine
  plan: Map<string, SwarmTask>
  // строй и группы (pvpFrame)
  center: SwarmPosition
  foeCenter: { x: number; z: number }
  forward: SwarmPosition
  committed: boolean
  lineDuty: number
  spots: Map<string, SwarmPosition>
  put: (m: SwarmMember, kind: SwarmKind, data: Record<string, any>, at?: SwarmPosition) => void
  perched: Map<number, number>
  groups: SwarmMember[][]
  groupVictories: Map<SwarmMember[], Set<string>>
  futile: Set<string>
  outnumbered: Set<string>
  hopeless: Set<string>
  // Добивание по живым из ленты смертей: последние 1–3 с любой стороны или прежнее тройное превосходство.
  endgame: boolean
  // штурм (pvpAssault)
  assault: SwarmBoard['assault']
  regroup: boolean
  losing: boolean
  // ва-банк (pvpFlee), раненые (pvpRecover)
  prey: SharedEnemy | undefined
  hunting: (m: SwarmMember) => boolean
  hurt: SwarmMember[]
  // цели (pvpTargets)
  loads: Map<string, number>
  untouchable: Set<string>
  available: SwarmMember[]
  now: number
  primary: SharedEnemy | undefined
  // окружение и работа на команду (plan-jobs)
  meanStrength: number
  hidden: Map<number, number>
  sectorOf: (m: SwarmMember, foe: SharedEnemy) => number
  shoveOf: (foe: SharedEnemy) => number
  edgeAt: (foe: SharedEnemy) => Edge | null
  ringAt: (foe: SharedEnemy, k: number, r: number, occupied?: SwarmPosition[]) => SwarmPosition
  gatherers: Set<string>
  lastEnemy: SwarmFact | undefined
  held: (key: string) => Map<string, SwarmPosition>
  diggers: Map<string, { site: DigSite; foe: SharedEnemy }>
  digAvoid: SwarmPosition[]
  digVacate: Map<string, SwarmPosition>
  ladderers: Map<string, LadderSite>
  campers: Map<string, SwarmPosition>
  // оценки plan-judges, привязанные к этому вызову
  hideoutFor: (m: SwarmMember) => SwarmPosition | null
  archer: (e: SharedEnemy) => boolean
  threatReach: (e: SharedEnemy) => number
  perchFor: (m: SwarmMember) => SwarmPosition | null
  rallyFor: (m: SwarmMember, foe: SharedEnemy) => SwarmPosition | null
  outclassed: (m: SwarmMember, foe: SharedEnemy | undefined) => boolean
  weak: (m: SwarmMember) => boolean
  improvementOf: (m: SwarmMember) => number
  targetCost: (m: SwarmMember, e: SharedEnemy) => number
}

// Строй и группы: середина своих и врагов, направление «на врага», такт смены линий, места строя, постановка задачи (put),
// приговор каждой группы своих.
export function pvpFrame(S: PvpPlan): PvpPlan {
  const { board, options, team, enemies, aggressive, doctrine, plan } = S
  S.hideoutFor = m => hideoutFor(S, m)
  S.archer = e => archer(S, e)
  S.threatReach = e => threatReach(S, e)
  S.perchFor = m => perchFor(S, m)
  S.rallyFor = (m, foe) => rallyFor(S, m, foe)
  S.outclassed = (m, foe) => outclassed(S, m, foe)
  S.weak = m => weak(S, m)
  S.improvementOf = m => improvementOf(S, m)
  S.targetCost = (m, e) => targetCost(S, m, e)
  const center = { x: team.reduce((s, m) => s + m.position.x, 0) / team.length, y: team.reduce((s, m) => s + m.position.y, 0) / team.length, z: team.reduce((s, m) => s + m.position.z, 0) / team.length }
  const foeCenter = enemies.length ? { x: enemies.reduce((s, e) => s + e.position.x, 0) / enemies.length, z: enemies.reduce((s, e) => s + e.position.z, 0) / enemies.length } : { x: center.x + 1, z: center.z }
  const d = Math.hypot(foeCenter.x - center.x, foeCenter.z - center.z)
  let forward = { x: (foeCenter.x - center.x) / (d || 1), y: 0, z: (foeCenter.z - center.z) / (d || 1) }
  // Враги вокруг строя (кольцо) или строй вокруг врага (кокон) — направление «на врага» вырождается и прыгает каждые
  // полсекунды, а с ним и все места строя (ревью 13.10). Ближе 2 бл. — прежнее направление, пока оно свежее.
  const kept = board.facts().find(f => f.id === 'forward')
  if (d < 2 && kept && Math.hypot(kept.position.x, kept.position.z) > .5) forward = { x: kept.position.x, y: 0, z: kept.position.z }
  else if (d >= 2 && enemies.length && team.length) board.recordFact(team[0].id, board.now(), { id: 'forward', kind: 'mark', position: { ...forward } }, 10000)
  const observers = new Set(enemies.flatMap(e => e.sources.filter(id => board.alive(id))))
  const endgame = options.foesLeft !== undefined && options.foesLeft > 0 &&
    (options.foesLeft <= 3 || team.length <= 3 || team.length >= 3 * options.foesLeft)
  const quorum = options.quorum ?? Math.ceil(team.length / 2)
  if (!Number.isInteger(quorum) || quorum < 1) throw new Error('Invalid swarm quorum')
  // Натиск: цель, которую видит хоть один свой, — общая (доска), ждать второго наблюдателя незачем.
  const committed = observers.size >= quorum || team.length < 3 || !!options.aggressive || endgame
  const formationCenter = doctrine === 'cocoon' && enemies[0] ? enemies[0].position : center
  // Ранг на смене — в памяти раунда; меняется по усталости рангов (doctrine.lineDuty), не по часам.
  const lineDutyNow = doctrine === 'line' && enemies.length && team.length ? (S.state.lineDuty = lineDuty(team, S.state.lineDuty ?? 0)) : S.state.lineDuty ?? 0
  const spots = new Map(team.map((m, i) => [m.id, formation(m, i, team, formationCenter, forward, doctrine, lineDutyNow)]))
  const put = (m: SwarmMember, kind: SwarmKind, data: Record<string, any>, at = spots.get(m.id)!) => {
    const alarm = enemies.some(e => e.threat === 'blast') ? 'scatter' : enemies.some(e => e.threat === 'aerial') ? 'above' : enemies.some(e => e.threat === 'bow') ? 'cover' : null
    const task: SwarmTask = { id: `pvp:${m.id}`, kind, assignedTo: m.id, position: at, priority: kind === 'flee' ? 120 : kind === 'recover' ? 100 : kind === 'heal' ? 90 : data.cover ? 80 : 50, data: { ...data, doctrine, role: m.role, committed, alarm } }
    plan.set(m.id, task)
  }
  // Занятые насесты (perchFor) и укрытия (hideoutFor — и в фазе бегства): двое на один не идут.
  const perched = new Map<number, number>(), hidden = new Map<number, number>()
  // Бой держат всей командой (assessTeamFight), если поле остаётся за нами (наших в конце не меньше, чем их) и размен
  // не хуже ровного (наши потери не больше их). Одно поле — мало: девять голых за одного незеритового «выигрывают» поле
  // (тест Codex); один размен — мало: трое против шестерых меняются 3 на 3 и проигрывают поле. Начатый бой держится с
  // запасом в десятую часть всех тел боя (6 на 6 — 1.2 бота): оценка между пересчётами гуляет на бота, и бой мигал
  // «держим / не держим» каждые полсекунды (арена 14.10; в равной мясорубке «у них остался один» — монетка).
  // Приговор каждой группы своих (groupVerdict); остальное — бой: «врага нужно уничтожить любой ценой» (14.10).
  const groups: SwarmMember[][] = []
  const link = aggressive ? undefined : TEAM_LINK
  for (const m of team) if (!groups.some(g => g.includes(m))) groups.push(groupOf(team, m, link))
  const groupVictories = new Map<SwarmMember[], Set<string>>()
  const futile = new Set<string>(), outnumbered = new Set<string>()
  // Натиск: размен не считается — группа не бросает бой и не уходит готовиться (бегут только раненые).
  if (!aggressive) for (const group of groups) {
    const verdict = groupVerdict(groupOf(team, group[0], REINFORCE_LINK), enemies, link)
    for (const a of group) if (verdict.futile) futile.add(a.id); else if (verdict.outnumbered) outnumbered.add(a.id)
  }
  const hopeless = new Set([...futile, ...outnumbered])
  // В финале цель — полный вайп: strongFew/натиск не отменяют добивание последних живых (пользователь 25.10).
  Object.assign(S, { endgame, center, foeCenter, forward, committed, lineDuty: lineDutyNow, spots, put, perched, hidden, groups, groupVictories, futile, outnumbered, hopeless })
  return S
}
