// Рой (swarm.ts): кадр плана боя (planPvp). PvpPlan — общее состояние одного вызова: вход, строй, группы и то, что
// посчитали прежние фазы (plan-assault, plan-flee, plan-doctrines, plan-jobs, plan-assign); фазы читают его по порядку
// и дописывают своё. Оценки plan-judges привязываются к нему здесь.
import type { SwarmPosition, SwarmMember, SharedEnemy, SwarmFact, SwarmTask, SwarmKind, Doctrine } from './types'
import type { SwarmBoard, PvpMemory } from './board'
import { groupOf, groupVerdict } from './fight'
import { formation } from './doctrine'
import { hideoutFor, perchFor, rallyFor, outclassed, weak, improvementOf, targetCost } from './plan-judges'

export type PvpOptions = { doctrine?: Doctrine; quorum?: number; leaseMs?: number; aggressive?: boolean; hideouts?: SwarmPosition[]; perches?: SwarmPosition[]; gather?: { item: string; deficit: number; spot: SwarmPosition }; edgeOf?: (p: SwarmPosition) => { x: number; z: number } | null; digSites?: (p: SwarmPosition) => SwarmPosition[]; campSpots?: SwarmPosition[]; ladderSites?: { key: string; x: number; y: number; z: number; top: number; face: { x: number; z: number } }[] }
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
  lineClock: number
  spots: Map<string, SwarmPosition>
  put: (m: SwarmMember, kind: SwarmKind, data: Record<string, any>, at?: SwarmPosition) => void
  perched: Map<number, number>
  groups: SwarmMember[][]
  groupVictories: Map<SwarmMember[], Set<string>>
  futile: Set<string>
  outnumbered: Set<string>
  hopeless: Set<string>
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
  ringAt: (foe: SharedEnemy, k: number, r: number) => SwarmPosition
  gatherers: Set<string>
  lastEnemy: SwarmFact | undefined
  held: (key: string) => Map<string, SwarmPosition>
  diggers: Map<string, { site: SwarmPosition; foe: SharedEnemy }>
  ladderers: Map<string, LadderSite>
  campers: Map<string, SwarmPosition>
  // оценки plan-judges, привязанные к этому вызову
  hideoutFor: (m: SwarmMember) => SwarmPosition | null
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
  const quorum = options.quorum ?? Math.ceil(team.length / 2)
  if (!Number.isInteger(quorum) || quorum < 1) throw new Error('Invalid swarm quorum')
  // Натиск: цель, которую видит хоть один свой, — общая (доска), ждать второго наблюдателя незачем.
  const committed = observers.size >= quorum || team.length < 3 || !!options.aggressive
  const formationCenter = doctrine === 'cocoon' && enemies[0] ? enemies[0].position : center
  // Смена линий — такт от начала приёма, а не от эпохи (первая смена выпадала через случайные 0–22 с).
  let lineClock = board.now()
  if (doctrine === 'line' && enemies.length && team.length) {
    let start = board.facts().find(f => f.id === 'line-start')
    if (!start) { board.recordFact(team[0].id, board.now(), { id: 'line-start', kind: 'mark', position: { ...center } }, 600000); start = board.facts().find(f => f.id === 'line-start') }
    if (start) lineClock = board.now() - start.seenAt
  }
  const spots = new Map(team.map((m, i) => [m.id, formation(m, i, team, formationCenter, forward, doctrine, lineClock)]))
  const put = (m: SwarmMember, kind: SwarmKind, data: Record<string, any>, at = spots.get(m.id)!) => {
    const alarm = enemies.some(e => e.threat === 'blast') ? 'scatter' : enemies.some(e => e.threat === 'aerial') ? 'above' : enemies.some(e => e.threat === 'bow') ? 'cover' : null
    const task: SwarmTask = { id: `pvp:${m.id}`, kind, assignedTo: m.id, position: at, priority: kind === 'flee' ? 120 : kind === 'recover' ? 100 : kind === 'heal' ? 90 : data.cover ? 80 : 50, data: { ...data, doctrine, role: m.role, committed, alarm } }
    plan.set(m.id, task)
  }
  // Занятые насесты (perchFor): двое на один не летят.
  const perched = new Map<number, number>()
  // Бой держат всей командой (assessTeamFight), если поле остаётся за нами (наших в конце не меньше, чем их) и размен
  // не хуже ровного (наши потери не больше их). Одно поле — мало: девять голых за одного незеритового «выигрывают» поле
  // (тест Codex); один размен — мало: трое против шестерых меняются 3 на 3 и проигрывают поле. Начатый бой держится с
  // запасом в десятую часть всех тел боя (6 на 6 — 1.2 бота): оценка между пересчётами гуляет на бота, и бой мигал
  // «держим / не держим» каждые полсекунды (арена 14.10; в равной мясорубке «у них остался один» — монетка).
  // Приговор каждой группы своих (groupVerdict); остальное — бой: «врага нужно уничтожить любой ценой» (14.10).
  const groups: SwarmMember[][] = []
  for (const m of team) if (!groups.some(g => g.includes(m))) groups.push(groupOf(team, m))
  const groupVictories = new Map<SwarmMember[], Set<string>>()
  const futile = new Set<string>(), outnumbered = new Set<string>()
  // Натиск: размен не считается — группа не бросает бой и не уходит готовиться (бегут только раненые).
  if (!aggressive) for (const group of groups) {
    const verdict = groupVerdict(group, enemies)
    for (const a of group) if (verdict.futile) futile.add(a.id); else if (verdict.outnumbered) outnumbered.add(a.id)
  }
  const hopeless = new Set([...futile, ...outnumbered])
  Object.assign(S, { center, foeCenter, forward, committed, lineClock, spots, put, perched, groups, groupVictories, futile, outnumbered, hopeless })
  return S
}
