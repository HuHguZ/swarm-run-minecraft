// Рой (swarm.ts): кадр плана боя (planPvp). PvpPlan — общее состояние одного вызова: вход, строй, группы и то, что
// посчитали прежние фазы (plan-assault, plan-flee, plan-doctrines, plan-jobs, plan-assign); фазы читают его по порядку
// и дописывают своё. Оценки plan-judges привязываются к нему здесь.
import type { SwarmPosition, SwarmMember, SharedEnemy, SwarmTask, SwarmKind, Doctrine, DigSite } from './types'
import type { SwarmBoard, PvpMemory } from './board'
import type { Edge } from './shove'
import { groupOf, groupVerdict, TEAM_LINK, REINFORCE_LINK } from './fight'
import { CONTACT_FRESH_MS, doctrineFocus, formation, lineDuty, lineOrder } from './doctrine'
import { hideoutFor, perchFor, rallyFor, outclassed, weak, improvementOf, targetCost, archer, threatReach } from './plan-judges'

// foesLeft — сколько врагов живо (лента смертей в чате — открытое знание, не зрение); нет — неизвестно (соло против людей).
// killsBy — та же лента: сколько наших убил каждый враг за раунд.
export type PvpOptions = { foesLeft?: number; killsBy?: Record<string, number>; doctrine?: Doctrine; quorum?: number; leaseMs?: number; aggressive?: boolean; hideouts?: SwarmPosition[]; lootZones?: (SwarmPosition & { tier: number })[]; lootOffer?: (m: SwarmMember) => { position: SwarmPosition; tier: number; seconds: number } | null; travelSeconds?: (m: SwarmMember, from: SwarmPosition, to: SwarmPosition) => number; perches?: SwarmPosition[]; gather?: { item: string; deficit: number; spot: SwarmPosition }; edgeOf?: (p: SwarmPosition, foe?: SharedEnemy) => Edge | null; digSites?: (p: SwarmPosition) => DigSite[]; campSpots?: SwarmPosition[]; ladderSites?: { key: string; x: number; y: number; z: number; top: number; face: { x: number; z: number } }[]
  canCoverWall?: (helper: SwarmMember, ward: SwarmMember, aim: { name: string; at: SwarmPosition }) => boolean
  canCoverShield?: PvpOptions['canCoverWall']
  assaultShotBeforeLoot?: (m: SwarmMember, foe: SharedEnemy, offer: { position: SwarmPosition; seconds: number; tier: number }, improvement: number, enemies: SharedEnemy[]) =>
    { at: SwarmPosition; position: SwarmPosition; signature: string } | null
}
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
  witnesses: Map<string, Set<string>>
  confirmed: (id: string) => boolean
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
export function pvpFrame(S: PvpPlan, { center, primary } = doctrineFocus(S.team, S.enemies, S.board.now())): PvpPlan {
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
  const foeCenter = enemies.length ? { x: enemies.reduce((s, e) => s + e.position.x, 0) / enemies.length, z: enemies.reduce((s, e) => s + e.position.z, 0) / enemies.length } : { x: center.x + 1, z: center.z }
  const d = Math.hypot(foeCenter.x - center.x, foeCenter.z - center.z)
  let forward = { x: (foeCenter.x - center.x) / (d || 1), y: 0, z: (foeCenter.z - center.z) / (d || 1) }
  // Враги вокруг строя (кольцо) или строй вокруг врага (кокон) — направление «на врага» вырождается и прыгает каждые
  // полсекунды, а с ним и все места строя (ревью 13.10). Ближе 2 бл. — прежнее направление, пока оно свежее.
  const kept = board.facts().find(f => f.id === 'forward')
  if (d < 2 && kept && Math.hypot(kept.position.x, kept.position.z) > .5) forward = { x: kept.position.x, y: 0, z: kept.position.z }
  else if (d >= 2 && enemies.length && team.length) board.recordFact(team[0].id, board.now(), { id: 'forward', kind: 'mark', position: { ...forward } }, 10000)
  const witnesses = new Map(enemies.map(e => [e.id, board.directWitnesses(e.id)]))
  const endgame = options.foesLeft !== undefined && options.foesLeft > 0 &&
    (options.foesLeft <= 3 || team.length <= 3 || team.length >= 3 * options.foesLeft)
  const quorum = options.quorum ?? Math.max(2, Math.ceil(team.length / 2))
  if (!Number.isInteger(quorum) || quorum < 1) throw new Error('Invalid swarm quorum')
  const confirmed = (id: string) => (witnesses.get(id)?.size ?? 0) >= (team.length === 1 ? 1 : quorum) || board.assault?.target === id
  const committed = !!primary && confirmed(primary.id)
  const formationCenter = doctrine === 'cocoon' && primary ? primary.position : center
  // Ранг на смене — в памяти раунда; меняется по усталости рангов (doctrine.lineDuty), не по часам.
  if (doctrine !== 'line' || !enemies.length) { delete S.state.lineOrder; delete S.state.lineDuty }
  else if (S.state.lineOrder || primary && !primary.nametag && !primary.glowing && board.now() - primary.seenAt <= CONTACT_FRESH_MS) {
    S.state.lineOrder = lineOrder(team, primary, S.state.lineOrder)
    S.state.lineDuty = lineDuty(team, S.state.lineDuty ?? 0, S.state.lineOrder)
  }
  const order = S.state.lineOrder, lineDutyNow = S.state.lineDuty ?? 0
  const spots = new Map(team.map((m, i) => [m.id, formation(m, order ? order.indexOf(m.id) : i, team, formationCenter, forward, doctrine, lineDutyNow, order?.length)]))
  const put = (m: SwarmMember, kind: SwarmKind, data: Record<string, any>, at = spots.get(m.id)!) => {
    const alarm = enemies.some(e => e.threat === 'blast') ? 'scatter' : enemies.some(e => e.threat === 'aerial') ? 'above' : enemies.some(e => e.threat === 'bow') ? 'cover' : null
    const engage = data.target ? confirmed(data.target) || (kind === 'fight' && (witnesses.get(data.target)?.has(m.id) || !!data.cover || !!data.turned)) : committed
    const task: SwarmTask = { id: `pvp:${m.id}`, kind, assignedTo: m.id, position: at, priority: kind === 'flee' ? 120 : kind === 'recover' ? 100 : kind === 'heal' ? 90 : data.cover ? 80 : 50, data: { ...data, doctrine, role: m.role, committed: !!engage, alarm } }
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
  Object.assign(S, { endgame, center, primary, foeCenter, forward, confirmed, witnesses, committed, lineDuty: lineDutyNow, spots, put, perched, hidden, groups, groupVictories, futile, outnumbered, hopeless })
  return S
}
