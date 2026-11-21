// Рой (swarm.ts): приёмы — очки по обстановке, выбор и гистерезис — и места строя (formation, смена линий).
import type { SharedEnemy, SwarmPosition, SwarmMember, Doctrine } from './types'
import { type SwarmBoard, liveMembers, pvpState } from './board'
import { ratio, count, doctrines, distance, hasShield } from './common'
import { memberFight, TEAM_LINK } from './fight'

export const CONTACT_FRESH_MS = 1000

export function doctrineFocus(team: SwarmMember[], enemies: SharedEnemy[], now: number, reports = enemies) {
  const size = Math.max(1, team.length)
  const center = { x: team.reduce((s, m) => s + m.position.x, 0) / size,
    y: team.reduce((s, m) => s + m.position.y, 0) / size, z: team.reduce((s, m) => s + m.position.z, 0) / size }
  const rank = (e: SharedEnemy) => now - e.seenAt > CONTACT_FRESH_MS ? 2 : e.nametag || e.glowing ? 1 : 0
  const primary = [...enemies].sort((a, b) => rank(a) - rank(b) || distance(a.position, center) - distance(b.position, center))[0]
  return { center, primary, reports }
}

// Очки приёмов по обстановке. Взрывы и раненые — не жёсткие ворота, а цена (правило гибкости; ревью 13.10: в бою 20 на 20
// кто-то ранен всегда, и «стадо» выбиралось навсегда): фонтан против взрывов почти всегда первый, стадо — по доле раненых.
export function doctrineScores(board: SwarmBoard, members: SwarmMember[], focus?: ReturnType<typeof doctrineFocus>): Record<Doctrine, number> {
  const team = liveMembers(board, members)
  const now = board.now()
  const foes = focus?.reports ?? board.enemies(now - CONTACT_FRESH_MS)
  const stats = board.tacticStats()
  const builders = team.filter(m => m.role === 'miner-builder' && Object.entries(m.inventory || {}).some(([n, c]) => /stone|dirt|planks|netherrack/.test(n) && c > 0)).length
  const blocks = team.reduce((sum, m) => sum + Object.entries(m.inventory || {}).filter(([n]) => /stone|dirt|planks|netherrack/.test(n)).reduce((n, [, c]) => n + c, 0), 0)
  const scores: Record<Doctrine, number> = { ring: 0, line: 3, buffalo: team.length >= 4 ? 4 : 0, fountain: 0, 'weak-center': 0, cocoon: 0, wave: 0, hunt: 0, 'false-weakness': 0, 'false-retreat': 0 }
  if (!foes.length) delete pvpState(board).brawlUntil
  if (foes.length) {
    const healers = team.filter(m => m.role === 'healer' && m.canHeal).length
    // A defended healing ring competes with terrain/build/push opportunities; merely holding a bow cannot veto them.
    scores.ring = foes.some(e => e.threat === 'bow' || e.threat === 'aerial' || /^(bow|crossbow)$/.test(e.equipment?.weapon || '')) ? 3 + healers + team.filter(m => hasShield(m)).length * .5 : 0
    // Скорость окружения зависит от движения его цели. Начатый кокон допускает небольшой сдвиг.
    const { center, primary } = focus ?? doctrineFocus(team, foes, board.now())
    if (primary && !primary.nametag && !primary.glowing && now - primary.seenAt <= CONTACT_FRESH_MS && team.some(m => ratio(m) < .6)) {
      const state = pvpState(board)
      scores.line += lineRelief(team, state.lineDuty ?? 0, primary, lineOrder(team, primary, state.lineOrder))
    }
    const cur = board.doctrineState()?.doctrine
    const speed = Math.hypot(primary?.velocity?.x || 0, primary?.velocity?.z || 0)
    scores.cocoon = builders * 3 * Math.min(1, blocks / 23) - Math.max(0, speed - (cur === 'cocoon' ? .15 : 0)) * 20
    scores.hunt = builders * 2 * Math.min(1, blocks / 10) + team.filter(m => m.role === 'flank').length
    scores.wave = foes.some(e => e.position.y > center.y + (cur === 'wave' ? 1.5 : 2.5)) ? team.filter(m => count(m.inventory, 'wind_charge') > 0).length * 2 : 0
    scores['false-weakness'] = healers ? 3 + team.filter(m => m.role === 'flank').length : 0
    // Ложный отход — когда враг идёт на нас (к середине строя), а не просто движется: против убегающего отход к точке сбора
    // отдавал ему поле (стенд 21.10).
    const charging = (e: typeof foes[number]) => { const v = e.velocity || { x: 0, y: 0, z: 0 }, sp = Math.hypot(v.x, v.z), dx = center.x - e.position.x, dz = center.z - e.position.z, d = Math.hypot(dx, dz) || 1
      return sp > .1 && (v.x * dx + v.z * dz) / (sp * d) > .5 }
    // Начатый ложный отход — манёвр до схватки, а не отклик на скорость: «идёт на нас» дрожит с каждым шагом врага, и приём
    // мигал с ложной слабостью каждые полсекунды (стенд 15×15, 21.10: «goto ↔ засада» 104 раза за 2 мин).
    const feignedRally = board.factView('feigned-rally')
    const feignedActive = cur === 'false-retreat' && (!feignedRally || now - feignedRally.seenAt < 8000)
    scores['false-retreat'] = foes.some(charging) || feignedActive ? team.length * .8 : 0
    // Обманки (ложные отход и слабость) — до схватки: в свалке «враг движется» верно всегда, и приём мигал с ложной
    // слабостью каждые 1–3 с, обрывая походы и бой (стенд 15×15, 21.10: 109 + 100 смен фазы за раунд). Схватка (враг в
    // 6 бл. от любого своего) выключает их до конца эпизода — пока враги снова не пропадут из виду; иначе отскок за 6 бл.
    // возвращал обманку, и половина команды вставала в засаду посреди боя.
    const memory = pvpState(board)
    let fighting = (memory.brawlUntil ?? -Infinity) > now, lastSight = -Infinity
    for (const e of foes) {
      if (e.nametag || e.glowing || now - e.seenAt > CONTACT_FRESH_MS) continue
      lastSight = Math.max(lastSight, e.seenAt)
      if (!fighting) fighting = team.some(m => {
        if (distance(m.position, e.position) > 6) return false
        const own = board.visualSighting(e.id, m.id)
        return !!own && now - own.seenAt <= CONTACT_FRESH_MS && distance(m.position, own.position) <= 6
      })
    }
    if (fighting) {
      memory.brawlUntil = Math.max(memory.brawlUntil ?? -Infinity, lastSight + board.enemyTtlMs)
      scores['false-weakness'] = scores['false-retreat'] = 0
    }
  }
  if (foes.some(e => e.threat === 'blast' || /end_crystal|respawn_anchor/.test(e.equipment?.weapon || ''))) scores.fountain = 10 + team.length * .8
  const wounded = team.filter(m => ratio(m) < 0.5).length
  if (wounded) scores['weak-center'] = 4 + 12 * wounded / team.length
  for (const name of doctrines) {
    const learned = stats[name]
    if (!learned) continue
    scores[name] += 2 * (learned.successes - learned.failures) / Math.max(1, learned.successes + learned.failures)
    const wins = learned.roundWins ?? 0, losses = learned.roundLosses ?? 0
    scores[name] += 2 * (wins - losses) / (1 + wins + losses)
  }
  return scores
}
export function selectDoctrine(board: SwarmBoard, members: SwarmMember[]): Doctrine {
  const scores = doctrineScores(board, members)
  return doctrines.slice().sort((a, b) => scores[b] - scores[a])[0]
}
const PASSIVE: Doctrine[] = ['false-weakness', 'false-retreat', 'cocoon', 'line', 'ring', 'weak-center']
// Гистерезис по миру: начатый приём держится, пока он выполним (очки > 0) и другой не лучше заметно (на 1.5 очка) — иначе
// строй меняется каждые полсекунды от скорости цели и чужих хп (ревью 13.10). Прежний распад запаса за 15 с превращал
// гистерезис в таймер: после 15 с любая дрожь очков меняла приём (21.10).
export function keepDoctrine(board: SwarmBoard, members: SwarmMember[], aggressive = false, focus?: ReturnType<typeof doctrineFocus>): Doctrine {
  const scores = doctrineScores(board, members, focus)
  // Натиск — без стоячих приёмов: обманки (ложные отход и слабость), кокон (оцепление стоит и не бьёт, пока замуровывают),
  // линии, кольцо щитов, «слабый центр» — против людей это толпа, что стоит или бежит (соло-арена 14.10: «стояли рядом и
  // не били», «стоят толпой на открытом — вырезаю как дурачков»).
  if (aggressive) for (const d of PASSIVE) scores[d] = -Infinity
  const now = board.now()
  const cur = board.doctrineState()
  const state = pvpState(board)
  // Короткая память недавней взрывной угрозы убирает секундные переключения hunt ↔ fountain при смене слота кристалла.
  if (scores.fountain > 0) state.blastUntil = Math.max(state.blastUntil ?? -Infinity, now + 5000)
  else if (cur?.doctrine === 'fountain' && (state.blastUntil ?? -Infinity) > now) {
    scores.fountain = 10 + liveMembers(board, members).length * .8
  }
  const best = doctrines.slice().sort((a, b) => scores[b] - scores[a])[0]
  const age = cur ? Math.max(0, now - cur.since) : Infinity
  // Цена перестроения команды (обрыв походов, боя и сброса): выше сразу после смены, затухает за 6 с.
  // Смена линий (line) срабатывает сразу при реальной усталости переднего ранга, не задерживаясь гистерезисом.
  const switchCost = best === 'line' ? 1.5 : 2.5 + 4 * Math.max(0, 1 - age / 6000)
  const keepValid = cur && cur.doctrine !== best && scores[cur.doctrine] > 0 && scores[best] - scores[cur.doctrine] < switchCost
  // Мимолётный триггер (прыжок на 0.5 с → wave) не дёргает строй обратно через секунду, пока приём не запрещён и нет срочного взрыва/смены линий.
  const keepFresh = cur && cur.doctrine !== best && scores[cur.doctrine] >= 0 && age < 4000 && best !== 'fountain' && best !== 'line'
  const chosen = keepValid || keepFresh ? cur!.doctrine : best
  board.setDoctrine(chosen)
  return chosen
}

// Смена линий: до трёх рангов; ранг на смене уходит в тыл, когда устал (среднее хп ранга < 60 %), а следующий свежее
// его хотя бы на пятую часть хп — по миру, а не каждые 22.5 с (21.10: свежий ранг уходил, а раненый вставал в бой по часам).
export const lineRank = (index: number, size: number) => index % Math.max(1, Math.min(3, size))
// Slots run across the ranks in each file. The allies closest to the reported
// fight form the first rank. Equidistant allies retain their initial slots.
export function lineOrder(team: SwarmMember[], foe?: SharedEnemy, deployed?: string[]): string[] {
  const ids = team.map(m => m.id)
  if (deployed) {
    const joined = ids.filter(id => !deployed.includes(id))
    return joined.length ? [...deployed, ...joined] : deployed
  }
  if (!foe) return ids
  const slots = team.map((_, i) => i).sort((a, b) => lineRank(a, team.length) - lineRank(b, team.length) || a - b)
  const nearest = slots.map(i => ({ id: team[i].id, gap: distance(team[i].position, foe.position) })).sort((a, b) => a.gap - b.gap)
  for (const [i, slot] of slots.entries()) ids[slot] = nearest[i].id
  return ids
}
export function lineDuty(team: SwarmMember[], current: number, order: string[]): number {
  const lines = Math.max(1, Math.min(3, order.length)), duty = current % lines
  const health = Array.from({ length: lines }, () => ({ sum: 0, count: 0 }))
  for (const m of team) {
    const rank = health[lineRank(order.indexOf(m.id), order.length)]
    rank.sum += ratio(m); rank.count++
  }
  for (let i = 1; i < lines; i++) {
    const next = (duty + i) % lines
    if (!health[next].count) continue
    if (!health[duty].count) return next
    const front = health[duty].sum / health[duty].count
    return front < .6 && health[next].sum / health[next].count >= front + .2 ? next : duty
  }
  return duty
}

// Цена смены — сколько здоровья свежие бойцы возвращают в действующий ряд до потери старого.
function lineRelief(team: SwarmMember[], current: number, foe: SharedEnemy, order: string[]): number {
  if (team.length < 2) return 0
  const duty = current % Math.min(3, order.length), next = lineDuty(team, duty, order)
  const rankOf = (m: SwarmMember) => lineRank(order.indexOf(m.id), order.length)
  if (next === duty) return 0
  const front = team.filter(m => rankOf(m) === duty && ratio(m) < 1 && distance(m.position, foe.position) <= TEAM_LINK)
    .map(m => ({ m, time: memberFight(m, foe).survival }))
  let gain = 0
  for (const fresh of team) {
    if (!front.length) break
    if (rankOf(fresh) !== next || fresh.workingBlocks || fresh.antidote?.using) continue
    let best = -1, nearest = Infinity
    for (const [j, { m, time }] of front.entries()) {
      const travel = distance(fresh.position, m.position) / 5.6 + Math.max(0, m.position.y - fresh.position.y - 1)
      if (ratio(fresh) > ratio(m) && travel <= time && travel < nearest) { nearest = travel; best = j }
    }
    if (best < 0) continue
    const fight = memberFight(fresh, foe)
    if (fight.rearm || fight.damage[0] < 1 || fight.survival <= 0) continue
    gain += (ratio(fresh) - ratio(front[best].m)) * Math.min(1, fight.survival / fight.attackSeconds)
    front.splice(best, 1)
  }
  return gain
}
export function formation(m: SwarmMember, index: number, team: SwarmMember[], center: SwarmPosition, forward: SwarmPosition, doctrine: Doctrine, duty: number, lineSize = team.length): SwarmPosition {
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
    const lines = Math.min(3, lineSize)
    const depth = (lineRank(index, lineSize) - duty % lines + lines) % lines
    along = 4 - depth * 4; across = (Math.floor(index / lines) - (Math.ceil(lineSize / lines) - 1) / 2) * 2
  } else {
    along = rear ? -5 : 4 * ratio(m)
    across = (index - (team.length - 1) / 2) * 2.5
  }
  return { x: center.x + forward.x * along + side.x * across, y: m.position.y, z: center.z + forward.z * along + side.z * across }
}
