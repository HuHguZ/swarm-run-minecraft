// Сброс и подкоп конкурируют с обычной атакой: считаем оставшуюся работу и видимое движение, помним пустые попытки.
import type { PvpPlan } from './plan-frame'
import type { SwarmMember, SharedEnemy } from './types'
import { count } from './common'
import { memberFight } from './fight'
import { fixMaterials } from '../gamedata'
import { pvpState, type SwarmBoard } from './board'
import { MELEE_CAP } from './race'

const registry = require('minecraft-data')('1.21.11')
fixMaterials(registry)
const Block = require('prismarine-block')(registry)

// Модель обещает быстрый натиск, но подтверждённые удары съедает лечение: дорожает именно эта альтернатива.
export function attackSeconds(m: SwarmMember, foe: SharedEnemy, modeled = memberFight(m, foe).attackSeconds): number {
  const p = foe.pressure
  if (!p?.hits) return modeled
  const confidence = p.hits / (p.hits + MELEE_CAP)
  const progress = p.damageLow > 0 ? Math.max(0, p.damageLow - p.healing) / p.damageLow : 0
  return modeled / (1 - confidence + confidence * progress)
}

// shortcut: доска не сообщает эффективность кирки и эффекты копателя; оценка без них, тело берёт фактический инструмент.
export function digSeconds(m: SwarmMember, site: { blocks?: string[]; handMs?: number }, dug = 0): number {
  if (!site.blocks) return (site.handMs ?? Infinity) / 1000
  const tools = [null, ...Object.keys(m.inventory || {}).filter(n => count(m.inventory, n) > 0 && /_(pickaxe|axe|shovel|hoe|sword)$|^shears$/.test(n)).map(n => registry.itemsByName[n]?.id).filter(Number.isFinite)]
  return site.blocks.slice(dug).reduce((seconds, name) => {
    const data = registry.blocksByName[name.replace(/^minecraft:/, '').split('[')[0]]
    if (!data || !data.diggable || data.hardness < 0) return Infinity
    const block = Block.fromStateId(data.defaultState, 0)
    return seconds + Math.min(...tools.map(tool => block.digTime(tool, false, false, false, [], {}))) / 1000
  }, 0)
}

export function noteDigProgress(board: SwarmBoard, target: string, cell: string, dug: number): void {
  const attempt = pvpState(board).dislodgeWork?.get(`${target}:dig:${cell}`)
  if (attempt && dug > (attempt.dug || 0)) {
    attempt.dug = dug; attempt.progressAt = board.now()
  }
}

export function noteDigFailure(board: SwarmBoard, target: string, cell: string): void {
  const attempt = pvpState(board).dislodgeWork?.get(`${target}:dig:${cell}`)
  if (attempt) {
    attempt.failed = true; attempt.penalty = Math.max(attempt.work, attempt.alternative); attempt.penaltyAt = board.now()
  }
}

export function dislodgeSeconds(S: PvpPlan, foe: SharedEnemy, method: string, expectedSeconds: number, alternative = Math.min(...S.team.map(m => attackSeconds(m, foe)))): number {
  if (!(expectedSeconds >= 0) || !Number.isFinite(expectedSeconds)) return Infinity
  let seconds = expectedSeconds
  if (method === 'shove') {
    const edge = S.edgeAt(foe), norm = edge && Math.hypot(edge.x, edge.z)
    if (!norm) return Infinity
    // shoveHits уже учитывает начальную инерцию; здесь оплачивается продолжающийся бег ОТ края между ударами.
    const away = Math.max(0, -((foe.velocity?.x || 0) * edge!.x + (foe.velocity?.z || 0) * edge!.z) * 20 / norm)
    const path = Math.max(0, edge!.at ?? 0) + .3, speed = path / Math.max(.05, expectedSeconds)
    seconds = speed > away ? path / (speed - away) : Infinity
  } else if (method.startsWith('dig:')) {
    const [x, , z] = method.slice(4).split(',').map(Number)
    const here = Math.hypot(foe.position.x - x - .5, foe.position.z - z - .5)
    const future = Math.hypot(foe.position.x + (foe.velocity?.x || 0) * 20 * expectedSeconds - x - .5, foe.position.z + (foe.velocity?.z || 0) * 20 * expectedSeconds - z - .5)
    // Места подкопа ищутся в 6 блоках от цели (watch.digSites): уход из этой области снижает пользу готовой ямы.
    seconds *= 1 + (Math.max(0, future - here) / Math.max(1, 6 - here)) ** 2
  }
  if (!Number.isFinite(seconds)) return Infinity
  const now = S.board.now(), work = S.state.dislodgeWork ??= new Map(), key = `${foe.id}:${method}`
  const held = S.board.dislodging(foe.id, method)
  let attempt = work.get(key)
  if (!attempt) { attempt = { at: -Infinity, active: false, failed: false, work: seconds, alternative, deadline: 0, penalty: 0, penaltyAt: now }; work.set(key, attempt) }
  if (attempt.at !== now) {
    attempt.alternative = alternative
    if (held) {
      if (!attempt.active) {
        attempt.active = true; attempt.failed = false; attempt.work = seconds
        attempt.deadline = (attempt.progressAt ?? (Number.isFinite(attempt.at) ? attempt.at : now)) + (seconds + .5) * 1000
      } else if (!attempt.failed) {
        // Реально снятый слой получает остаток бюджета от квитанции; подход и повтор already_clear срок не продлевают.
        if (attempt.progressAt !== undefined) {
          attempt.deadline = attempt.progressAt + (seconds + .5) * 1000; attempt.work = seconds
        } else if (seconds < attempt.work) attempt.deadline = Math.min(attempt.deadline, now + (seconds + .5) * 1000)
        attempt.work = Math.min(attempt.work, seconds)
        if (now > attempt.deadline) {
          attempt.failed = true; attempt.penalty = Math.max(seconds, alternative); attempt.penaltyAt = now
        }
      }
      delete attempt.progressAt
    } else attempt.active = false
    attempt.at = now
  }
  return seconds + Math.max(0, attempt.penalty - (now - attempt.penaltyAt) / 1000)
}
