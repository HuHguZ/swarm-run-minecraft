// Рой (swarm.ts): приёмы — очки по обстановке, выбор и гистерезис — и места строя (formation, смена линий).
import type { SwarmPosition, SwarmMember, Doctrine } from './types'
import { type SwarmBoard, liveMembers } from './board'
import { ratio, count, doctrines } from './common'

// Очки приёмов по обстановке. Взрывы и раненые — не жёсткие ворота, а цена (правило гибкости; ревью 13.10: в бою 20 на 20
// кто-то ранен всегда, и «стадо» выбиралось навсегда): фонтан против взрывов почти всегда первый, стадо — по доле раненых.
export function doctrineScores(board: SwarmBoard, members: SwarmMember[]): Record<Doctrine, number> {
  const team = liveMembers(board, members)
  const foes = board.enemies()
  const stats = board.tacticStats()
  const builders = team.filter(m => m.role === 'miner-builder' && Object.entries(m.inventory || {}).some(([n, c]) => /stone|dirt|planks|netherrack/.test(n) && c > 0)).length
  const blocks = team.reduce((sum, m) => sum + Object.entries(m.inventory || {}).filter(([n]) => /stone|dirt|planks|netherrack/.test(n)).reduce((n, [, c]) => n + c, 0), 0)
  const scores: Record<Doctrine, number> = { ring: 0, line: 3, buffalo: team.length >= 4 ? 4 : 0, fountain: 0, 'weak-center': 0, cocoon: 0, wave: 0, hunt: 0, 'false-weakness': 0, 'false-retreat': 0 }
  if (foes.length) {
    const healers = team.filter(m => m.role === 'healer' && m.canHeal).length
    // A defended healing ring competes with terrain/build/push opportunities; merely holding a bow cannot veto them.
    scores.ring = foes.some(e => e.threat === 'bow' || e.threat === 'aerial' || /^(bow|crossbow)$/.test(e.equipment?.weapon || '')) ? 3 + healers + team.filter(m => count(m.inventory, 'shield') > 0).length * .5 : 0
    scores.cocoon = builders * 3 * Math.min(1, blocks / 23) - Math.max(...foes.map(e => Math.hypot(e.velocity?.x || 0, e.velocity?.z || 0))) * 20
    scores.hunt = builders * 2 * Math.min(1, blocks / 10) + team.filter(m => m.role === 'flank').length
    scores.wave = foes.some(e => e.position.y > team[0]?.position.y + 2) ? team.filter(m => count(m.inventory, 'wind_charge') > 0).length * 2 : 0
    scores['false-weakness'] = healers ? 3 + team.filter(m => m.role === 'flank').length : 0
    scores['false-retreat'] = foes.some(e => Math.hypot(e.velocity?.x || 0, e.velocity?.z || 0) > .1) ? team.length * .8 : 0
  }
  if (foes.some(e => e.threat === 'blast' || /end_crystal|respawn_anchor/.test(e.equipment?.weapon || ''))) scores.fountain = 10 + team.length * .8
  const wounded = team.filter(m => ratio(m) < 0.5).length
  if (wounded) scores['weak-center'] = 4 + 12 * wounded / team.length
  for (const name of doctrines) scores[name] += ((stats[name]?.successes ?? 0) - (stats[name]?.failures ?? 0)) / Math.max(1, (stats[name]?.successes ?? 0) + (stats[name]?.failures ?? 0)) * 2
  return scores
}
export function selectDoctrine(board: SwarmBoard, members: SwarmMember[]): Doctrine {
  const scores = doctrineScores(board, members)
  return doctrines.slice().sort((a, b) => scores[b] - scores[a])[0]
}
const PASSIVE: Doctrine[] = ['false-weakness', 'false-retreat', 'cocoon', 'line', 'ring', 'weak-center']
// Гистерезис: начатый приём держится, пока другой не лучше заметно (на 1.5 очка) — иначе строй меняется каждые полсекунды
// от скорости цели и чужих хп (ревью 13.10); через 15 с хватает и простого перевеса.
export function keepDoctrine(board: SwarmBoard, members: SwarmMember[], aggressive = false): Doctrine {
  const scores = doctrineScores(board, members)
  // Натиск — без стоячих приёмов: обманки (ложные отход и слабость), кокон (оцепление стоит и не бьёт, пока замуровывают),
  // линии, кольцо щитов, «слабый центр» — против людей это толпа, что стоит или бежит (соло-арена 14.10: «стояли рядом и
  // не били», «стоят толпой на открытом — вырезаю как дурачков»).
  if (aggressive) for (const d of PASSIVE) scores[d] = -Infinity
  const best = doctrines.slice().sort((a, b) => scores[b] - scores[a])[0]
  const cur = board.doctrineState()
  const keep = cur && cur.doctrine !== best && scores[best] - scores[cur.doctrine] < (board.now() - cur.since < 15000 ? 1.5 : 1e-9)
  const chosen = keep ? cur!.doctrine : best
  board.setDoctrine(chosen)
  return chosen
}

// Смена линий: до трёх рангов, ранг на смене меняется каждые 22.5 с; в команде из одного-двух рангов столько же.
export const LINE_SHIFT_MS = 22500
export const lineRank = (index: number, size: number) => index % Math.max(1, Math.min(3, size))
export const lineDuty = (now: number, size: number) => Math.floor(now / LINE_SHIFT_MS) % Math.max(1, Math.min(3, size))
export function formation(m: SwarmMember, index: number, team: SwarmMember[], center: SwarmPosition, forward: SwarmPosition, doctrine: Doctrine, now: number): SwarmPosition {
  const side = { x: -forward.z, y: 0, z: forward.x }
  let along = 0; let across = 0
  const rear = m.role === 'healer' || m.role === 'ranged' || m.role === 'miner-builder'
  if (doctrine === 'ring' || doctrine === 'weak-center') {
    const a = index * 2 * Math.PI / Math.max(1, team.length)
    const radius = m.role === 'healer' ? .5 : rear ? 2 : 3
    along = Math.cos(a) * radius; across = Math.sin(a) * radius
  } else if (doctrine === 'buffalo' || doctrine === 'hunt') {
    along = rear ? -5 : m.role === 'flank' ? 7 : 4
    across = m.role === 'flank' ? (team.filter(a => a.role === 'flank').findIndex(a => a.id === m.id) % 2 ? 1 : -1) * 8 : (index - (team.length - 1) / 2) * 2
  } else if (doctrine === 'fountain') {
    along = -4 - (index % 2) * 3; across = (index % 2 ? 1 : -1) * (5 + Math.floor(index / 2) * 3)
  } else if (doctrine === 'cocoon') {
    const a = index * 2 * Math.PI / team.length
    along = Math.cos(a) * 4; across = Math.sin(a) * 4
  } else if (doctrine === 'false-weakness' || doctrine === 'false-retreat') {
    along = -6; across = (index % 2 ? 1 : -1) * (rear ? 2 : 5)
  } else if (doctrine === 'line') {
    const lines = Math.min(3, team.length)
    const depth = (lineRank(index, team.length) - lineDuty(now, team.length) + lines) % lines
    along = 4 - depth * 4; across = (Math.floor(index / lines) - (Math.ceil(team.length / lines) - 1) / 2) * 2
  } else {
    along = rear ? -5 : 4 * ratio(m)
    across = (index - (team.length - 1) / 2) * 2.5
  }
  return { x: center.x + forward.x * along + side.x * across, y: m.position.y, z: center.z + forward.z * along + side.z * across }
}
