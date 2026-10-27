// Рой (swarm.ts): план боя (planPvp) — сектора окружения и работа на команду: добыча блоков, прикрытие раненых,
// ямы-ловушки, лестницы, кемперы.
import { aimingAt } from '../pvp/crowd'
import type { SwarmPosition, SwarmMember, SharedEnemy, DigSite } from './types'
import type { PvpPlan } from './plan-frame'
import { distance, cellKey, count, ratio } from './common'
import { shoveValue, SHOVE, type Edge } from './shove'
import { MELEE_CAP } from './race'
import { attackSeconds, digSeconds, dislodgeSeconds } from './dislodge'
import { memberFight } from './fight'

const under = (q: SwarmPosition, s: SwarmPosition) => s.y === Math.floor(q.y - .01) && q.x + .3 > s.x && q.x - .3 < s.x + 1 && q.z + .3 > s.z && q.z - .3 < s.z + 1
// Origin/key and blocks stay unchanged while confirmed upper layers disappear.
export const digCells = (s: DigSite): SwarmPosition[] => (s.blocks || [0, 1]).map((_, k) => ({ x: s.x, y: s.y - k, z: s.z })).slice(s.dug || 0)
const underDig = (q: SwarmPosition, s: DigSite) => digCells(s).some(c => under(q, c))

export function pvpSectors(S: PvpPlan): void {
  const { team, options } = S
  const meanStrength = team.reduce((s, m) => s + m.strength, 0) / team.length || 1
  // Окружение (пользователь 14.10: «окружать по всей карте — делиться на части, заходить с разных сторон, сужаться и
  // добивать»; «кучкуются в точке, когда пытаются ко мне пройти, — зельями и молнией их толпой»): у каждого, кто идёт на
  // цель, свой из 8 секторов вокруг неё — ближайший к его пеленгу свободный (занятый — дороже), так кольцо ровное и маршруты
  // разные (с крыши к нему лезут с восьми сторон, а не одной кучей у подножия). Обрыв у цели (edgeOf — сторона, где падение)
  // — сектора напротив него дешевле: удар отбрасывает от бьющего, то есть в обрыв (пользователь 14.10: «если рядом обрыв —
  // всегда пытаться скинуть, это приоритетный способ убить»).
  const SECTORS = 8
  const sectorsTaken = new Map<string, number[]>()
  const edges = new Map<string, Edge | null>()
  const edgeAt = (foe: SharedEnemy) => { if (!edges.has(foe.id)) edges.set(foe.id, options.edgeOf?.(foe.position, foe) ?? null); return edges.get(foe.id)! }
  // Смертельный обрыв (shove.ts) тянет бьющих на другую сторону сильнее: втрое против прежнего веса «просто край».
  const shoveOf = (foe: SharedEnemy) => shoveValue(foe, edgeAt(foe))
  function sectorOf(m: SwarmMember, foe: SharedEnemy): number {
    const own = sectorsTaken.get(foe.id) || []; sectorsTaken.set(foe.id, own)
    const edge = edgeAt(foe), pull = 4 + 12 * shoveOf(foe), shove = shoveOf(foe) >= SHOVE
    const bearing = Math.atan2(m.position.z - foe.position.z, m.position.x - foe.position.x)
    let best = 0, bestCost = Infinity
    for (let k = 0; k < SECTORS; k++) {
      const a = k * 2 * Math.PI / SECTORS
      const turn = Math.abs(((a - bearing) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI)
      const toward = edge ? Math.cos(a) * edge.x + Math.sin(a) * edge.z : 0
      // Сброс: со стороны обрыва не бить вовсе — удар оттуда отбрасывает его от края (DeepSeek, разбор сброса 21.10).
      const cost = turn + toward * pull + (shove && toward > -.5 ? 100 : 0) + own.filter(x => x === k).length * 3
      if (cost < bestCost) { bestCost = cost; best = k }
    }
    own.push(best)
    return best
  }
  const ringAt = (foe: SharedEnemy, k: number, r: number, occupied: SwarmPosition[] = []): SwarmPosition => {
    const at = (j: number, radius: number) => ({ x: foe.position.x + Math.cos(j * 2 * Math.PI / SECTORS) * radius, y: foe.position.y, z: foe.position.z + Math.sin(j * 2 * Math.PI / SECTORS) * radius })
    const clear = (q: SwarmPosition) => !occupied.some(s => distance(q, s) < .6) && !(S.digAvoid || []).some(s => under(q, s)) && ![...(S.diggers?.values() || [])].some(d => (d.site as any).stands?.some(s => distance(q, s) < .8))
    for (const radius of [r, r + 1, r + 2]) for (const turn of [0, 1, -1, 2, -2, 3, -3, 4]) { const q = at(k + turn, radius); if (clear(q)) return q }
    return at(k, r + 6)
  }
  Object.assign(S, { meanStrength, sectorOf, ringAt, shoveOf, edgeAt })
}

export function pvpGather(S: PvpPlan): void {
  const { board, team, enemies, aggressive, options, weak } = S
  // Работа на команду (пользователь 14.10: «блоков нет — слабых, необутанных отправить добывать песок, несколько, чтобы
  // быстрее; любая задача оценивается в число игроков, которые будут её решать»): цель наверху, лезущим не хватает блоков
  // (дефицит считает драйвер по их нуждам) — рабочих дефицит / 32, до 4; из слабых, кто дальше 10 бл. от врагов, ближние к
  // месту добычи. Добытое разносят передачи (нужды бойцов).
  const gatherers = new Set(aggressive && options.gather && options.gather.deficit > 0
    ? team.filter(m => weak(m) && enemies.every(e => distance(e.position, m.position) > 10)).sort((a, b) => distance(a.position, options.gather!.spot) - distance(b.position, options.gather!.spot))
      .slice(0, Math.min(4, Math.ceil(options.gather.deficit / 32))).map(m => m.id) : [])
  // Охота (пользователь 14.10: бой должен кончаться): врагов не видно — к месту, где их видели последним (60 с), а там
  // прочёсывать; лут — только тому, кому нечем драться.
  // Последнее место врага — с его высотой (по ней прокоп к замуровавшемуся; высота своих уводила прокоп в пол) и на 3 мин.:
  // человек в коробке сидит дольше минуты (пользователь 15.10: «уничтожение кемпера с поиском»).
  // Место — самого свежего врага, а не середина нескольких (Codex 15.10: враги по бокам — середина под ботом, прокоп под себя).
  if (enemies.length) board.recordFact(team[0].id, board.now(), { id: 'last-enemy', kind: 'mark', position: { ...[...enemies].sort((a, c) => c.seenAt - a.seenAt)[0].position } }, 180000)
  const lastEnemy = enemies.length ? undefined : board.facts().find(f => f.id === 'last-enemy')
  Object.assign(S, { gatherers, lastEnemy })
}

export function coverHurt(S: PvpPlan): void {
  const { board, team, enemies, plan, aggressive, hurt, untouchable, meanStrength, spots, loads, put, weak } = S
  // Прижатый (враг в 4 бл., хп < 80 %) — тоже под прикрытие: в натиске раненым он не считается, и в углу его забивали в
  // одиночку (пользователь 25.10: «союзники прикрывать должны»).
  const pinned = S.doctrine === 'line' ? [] : team.filter(m => !hurt.includes(m) && ratio(m) < .8 && enemies.some(e => !untouchable.has(e.id) && distance(e.position, m.position) <= 4))
  for (const ally of [...hurt, ...pinned]) {
    const foe = enemies.filter(e => !untouchable.has(e.id) && (aimingAt({ name: e.id, p: e.position, v: e.velocity }, { name: ally.id, p: ally.position }) || distance(e.position, ally.position) < 12)).sort((a, b) => distance(a.position, ally.position) - distance(b.position, ally.position))[0]
    // Защитник — другой: сам себе прикрытием он не бывает (Kimi AUDIT 27.10: «31v → 31i для 31v #cover»); свой бой
    // без защитника решает общая оценка, без метки cover.
    const guard = foe && team.filter(m => m.id !== ally.id && !plan.has(m.id) && !(aggressive && weak(m))).sort((a, b) => (b.strength / meanStrength) * 6 - distance(b.position, ally.position) - ((a.strength / meanStrength) * 6 - distance(a.position, ally.position)))[0]
    if (guard && foe) {
      const search = board.now() - foe.seenAt > 500
      put(guard, search ? 'goto' : 'fight', { target: foe.id, enemyPosition: foe.position, cover: ally.id, search }, search ? foe.position : spots.get(guard.id))
      loads.set(foe.id, (loads.get(foe.id) || 0) + guard.strength / meanStrength)
    }
  }
}

// Грубый отбор; видимую грань и опору своих проверяет swarm_work.
export function canDigTrap(p: SwarmPosition, s: DigSite): boolean {
  const levels = s.stands ? s.stands.filter(q => !q.requiresClear?.length).map(q => q.y) : [s.feetY ?? s.y + 1]
  return levels.some(y => Math.abs(p.y - y) <= .6) &&
    (p.x + .3 <= s.x || p.x - .3 >= s.x + 1 || p.z + .3 <= s.z || p.z - .3 >= s.z + 1) &&
    Math.hypot(s.x + .5 - p.x, s.y - p.y - 1.62, s.z + .5 - p.z) <= 4.5
}

let digTraceAt = 0
export function pvpDiggers(S: PvpPlan): void {
  const { board, team, enemies, plan, aggressive, options, weak } = S
  // shortcut: greedy allocation is quadratic in actors×targets; use matching only if farm profiling calls for it.
  // Ямы-ловушки (пользователь 14.10: «разбирать колизей — наделать дырок алмазной и незеритовой киркой, скидывать туда
  // врагов; пока одни копают, другие прикрывают, потом у дыр стоять и поджидать»): враг на полу над пустотой (галерея,
  // крыша-терраса — места даёт драйвер по модели, digSites) — двое с кирками (незерит, алмаз первыми), не в схватке,
  // вскрывают пол в 2–5 бл. от него; прикрывают все остальные (бой идёт), а дыры драйвер отдаёт в edgeOf — сектор удара
  // ставит бьющих так, чтобы отбросило в дыру.
  // Кто уже на деле (прошлый план): тот и остаётся, пока дело живо — иначе каждые полсекунды копатель становился кемпером,
  // потом бойцом, потом снова копателем («смена фазы — обрываю дело», арена 36: пользователь «рой тупее прошлого»).
  const held = (key: string) => new Map(board.tasks().filter(t => t.assignedTo && t.data?.[key] !== undefined && t.position).map(t => [t.assignedTo!, t.position!]))
  // Цели — свежие, быстрые первыми; по 1–2 копателя на цель (несколько целей), ямы впереди его хода, разнос 3 бл. (Codex 15.10:
  // все копатели доставались первой цели — 4/0/0 вместо 1/1/2).
  const diggers = new Map<string, { site: DigSite; foe: SharedEnemy }>()
  const vacate = new Map<string, SwarmPosition>()
  // Снятый верх больше не опора, но оставшийся нижний слой остаётся кандидатом на копку.
  const clearedTop = [...(S.state.dislodgeWork || [])].filter(([key, work]) => (work.dug || 0) > 0 && key.includes(':dig:')).flatMap(([key, work]) => {
    const [x, y, z] = key.slice(key.lastIndexOf(':') + 1).split(',').map(Number)
    return Array.from({ length: work.dug! }, (_, k) => ({ x, y: y - k, z }))
  })
  const cleared = new Set(clearedTop.map(cellKey))
  const taken: DigSite[] = []
  // Рой на рой — ямы под тем, на кого навалились (наших у него вдвое больше, чем его своих): групповой сброс одного
  // (пользователь 21.10: «включая поломку блоков под ногами врага»); против человека (натиск) — под любым.
  const ganged = (e: SharedEnemy) => team.filter(m => distance(m.position, e.position) <= 12).length >= 2 * Math.max(1, enemies.filter(o => distance(o.position, e.position) <= 12).length)
  if (options.digSites && (aggressive || enemies.some(ganged))) {
    const speed = (e: SharedEnemy) => Math.hypot(e.velocity?.x || 0, e.velocity?.z || 0)
    const goals = enemies.filter(e => board.now() - e.seenAt < 5000 && (aggressive || ganged(e))).sort((a, b) => speed(b) - speed(a) || b.seenAt - a.seenAt || a.id.localeCompare(b.id))
    const pickTier = (m: SwarmMember) => Math.max(0, ...Object.keys(m.inventory || {}).filter(n => count(m.inventory, n) > 0).map(n => n === 'netherite_pickaxe' ? 3 : n === 'diamond_pickaxe' ? 2 : /_pickaxe$/.test(n) ? 1 : 0))
    // Смертельный пол разбирают все свободные кирки, которым это выгодно; обычные ловушки — 4–6 копателей.
    // Кто уже копает — остаётся у своей ямы и цели (иначе «смена фазы — обрываю дело» каждые полсекунды).
    const was = new Map(board.tasks().filter(t => t.assignedTo && t.data?.dig && t.position).map(t => [t.assignedTo!, t]))
    const stands: SwarmPosition[] = []
    const jobs = goals.map(foe => {
      const v = foe.velocity
      const ahead = (s: SwarmPosition) => (s.x + .5 - foe.position.x) * (v?.x || 0) + (s.z + .5 - foe.position.z) * (v?.z || 0)
      // Смертельная яма (пустота под землёй за полем; по его хп и глубине — shove.ts) — первой: упал — умер. Из смертельных —
      // без обсидиана (алмазной киркой 9.4 с на блок: стенд 22.10, 29 из 35 подкопов бросили — он подходил, direct_threat).
      const deadly = (s: any) => Number(shoveValue(foe, { x: 0, z: 0, drop: s.drop ?? 7 }) >= SHOVE)
      const slow = (s: any) => Number(!!s.tier)
      const sites = options.digSites!(foe.position).map(s => {
        let dug = 0
        while (dug < (s.blocks?.length ?? 2) && cleared.has(cellKey({ x: s.x, y: s.y - dug, z: s.z }))) dug++
        const stands = s.stands?.filter(q => (q.requiresClear || []).every(c => cleared.has(cellKey(c))) && (!q.support || !cleared.has(cellKey(q.support))))
          .map(q => ({ x: q.x, y: q.y, z: q.z }))
        return { ...s, dug, ...(stands ? { stands } : {}) }
      }).filter(s => digCells(s).length).sort((a, b) => deadly(b) - deadly(a) || slow(a) - slow(b) || ahead(b) - ahead(a) || distance(a, foe.position) - distance(b, foe.position))
      // Выгодный подкоп не ждёт попаданий: его цену и бюджет сравнивает fits ниже.
      const undermine = sites.some(s => deadly(s))
      // Двое в упор прикрывают копку; остальные кирки вскрывают смертельный пол, даже когда цель рядом.
      const guards = new Set(undermine ? team.filter(m => !plan.has(m.id) && distance(m.position, foe.position) <= 3.5).sort((a, b) => Number(was.has(a.id)) - Number(was.has(b.id)) || distance(a.position, foe.position) - distance(b.position, foe.position) || b.strength - a.strength || a.id.localeCompare(b.id)).slice(0, MELEE_CAP).map(m => m.id) : [])
      return { foe, sites, deadly, undermine, guards }
    })
    const demolition = jobs.some(j => j.undermine)
    const safeFloor: SwarmPosition[] = [...new Map(jobs.flatMap(j => j.sites.flatMap(s => (s as any).stands || [])).map(q => [cellKey(q), q] as const)).values()]
    const floorOrder = new Map<string, SwarmPosition[]>()
    const floorsFor = (a: SwarmMember) => {
      if (!floorOrder.has(a.id)) floorOrder.set(a.id, [...safeFloor].sort((q, r) => distance(a.position, q) - distance(a.position, r)))
      return floorOrder.get(a.id)!
    }
    const reserved = new Map<string, { site: DigSite; stand: SwarmPosition }>()
    // Резервируем прежние рабочие пары до новой раздачи: движущийся сосед ещё не дошёл до своей стойки.
    for (const m of team) {
      const old = was.get(m.id), job = jobs.find(j => j.undermine && j.foe.id === old?.data?.target)
      const site = job?.sites.find(s => cellKey(s) === cellKey(old!.position!))
      const stand = old?.data?.stands?.find(q => (site as any)?.stands?.some(t => cellKey(q) === cellKey(t)) && canDigTrap(q, site!) && !clearedTop.some(s => under(q, s)))
      if (site && stand && !plan.has(m.id) && !job!.guards.has(m.id) && pickTier(m) >= ((site as any).tier || 0)) reserved.set(m.id, { site, stand })
    }
    const freeStand = (q: SwarmPosition, id: string) => !clearedTop.some(s => under(q, s)) && !taken.some(t => underDig(q, t)) && !stands.some(t => distance(q, t) < .6) &&
      ![...reserved].some(([who, r]) => underDig(q, r.site) || who !== id && distance(q, r.stand) < .6) && ![...vacate].some(([who, t]) => who !== id && distance(q, t) < .6)
    const picks = team.filter(m => pickTier(m) > 0).length
    const normalLimit = S.state.strongFew ? 6 : Math.min(4, 2 + Math.floor(picks / 10))
    const passes = [{ jobs, limit: demolition ? picks : normalLimit, demolition }]
    // Непригодный смертельный пол не отменяет обычные ямы; сначала распределяем всю полезную смертельную работу.
    if (demolition) passes.push({ jobs: jobs.filter(j => j.undermine).map(j => ({ ...j, undermine: false, sites: j.sites.filter(s => !j.deadly(s)) })), limit: normalLimit, demolition: false })
    for (const pass of passes) for (let round = 0; round < (!pass.demolition && pass.jobs.length > 1 ? 2 : pass.limit); round++) for (const { foe, sites, deadly, undermine, guards } of pass.jobs) {
      if (diggers.size >= pass.limit) break
      // Обычную яму копаем с места вне контакта; смертельную при сбросе — и с подходом на проверенную стойку.
      const pool = team.filter(m => !plan.has(m.id) && !diggers.has(m.id) && (undermine ? pickTier(m) > 0 && !guards.has(m.id) : (was.has(m.id) || !weak(m)) && enemies.every(e => distance(e.position, m.position) > 3.5)))
        .sort((a, b) => Number(was.get(b.id)?.data?.target === foe.id) - Number(was.get(a.id)?.data?.target === foe.id) || pickTier(b) - pickTier(a) || distance(a.position, foe.position) - distance(b.position, foe.position))
      for (const m of pool) {
        // Без кирки — руками (песчаник 0.8: 4 с на блок, яма в два — 8 с): кирки первыми, но яма не ждёт кирку. Обсидиан
        // фундамента — только алмазной и лучше (tier 2; железной — 40 с, swarm_work откажет).
        const oldStand = reserved.get(m.id)?.stand, standPrices = new Map<string, number>()
        const retain = (q: SwarmPosition, s: DigSite) => !!oldStand && cellKey(q) === cellKey(oldStand) && !S.state.dislodgeWork?.get(`${foe.id}:dig:${cellKey(s)}`)?.failed
        const threats = enemies.map(e => ({ foe: e, survival: memberFight(m, e).survival }))
        const standPrice = (q: SwarmPosition, s: DigSite) => {
          const key = cellKey(s) + ':' + cellKey(q)
          if (!standPrices.has(key)) {
            const work = digSeconds(m, s, s.dug || 0)
            const risk = threats.reduce((cost, t) => {
              const e = t.foe, dx = q.x - e.position.x, dz = q.z - e.position.z
              const gap = Math.hypot(Math.max(0, Math.abs(dx) - .3), Math.max(0, q.y - e.position.y - 1.62, e.position.y + 1.62 - q.y - 1.8), Math.max(0, Math.abs(dz) - .3))
              const closing = (dx * (e.velocity?.x || 0) + dz * (e.velocity?.z || 0)) * 20 / Math.max(.1, Math.hypot(dx, dz))
              const reach = /_spear$/.test(e.equipment?.weapon || '') ? 4.5 + Math.max(0, closing / 20) : 3
              const arrival = /^(bow|crossbow)$/.test(e.equipment?.weapon || '') ? gap / 60 : gap <= reach ? 0 : closing > 0 ? (gap - reach) / closing : Infinity
              return cost + Math.max(0, work - arrival) / Math.max(.05, t.survival)
            }, 0)
            standPrices.set(key, distance(q, m.position) / 5.6 + work * risk)
          }
          return standPrices.get(key)!
        }
        const standOrders = new Map<DigSite, SwarmPosition[]>()
        const safeStand = (s: DigSite) => {
          if (!standOrders.has(s)) standOrders.set(s, (s.stands || []).filter(q => canDigTrap(q, s)).sort((a, b) =>
            Number(retain(b, s)) - Number(retain(a, s)) || standPrice(a, s) - standPrice(b, s) || distance(a, m.position) - distance(b, m.position)))
          // Резервы и освобождение опор меняются при раздаче: кэшируем только неизменный порядок.
          return standOrders.get(s)!.find(q => freeStand(q, m.id))
        }
        const attack = attackSeconds(m, foe)
        const affordable = (s: any) => {
          const stand = undermine ? safeStand(s) : m.position
          const moving = evacuation(s)
          if (!moving) return false
          const done = Math.max(s.dug || 0, S.state.dislodgeWork?.get(`${foe.id}:dig:${cellKey(s)}`)?.dug || 0)
          // Подход копателя и освобождение опоры идут одновременно, затем начинается копка.
          const walk = Math.max(stand ? distance(m.position, stand) / 5.6 : 0, ...[...moving].map(([id, q]) => distance(team.find(a => a.id === id)!.position, q) / 5.6))
          const work = digSeconds(m, s, done) + walk
          return dislodgeSeconds(S, foe, `dig:${cellKey(s)}`, work, attack) < attack
        }
        const evacuation = (s: any) => {
          const moves = new Map<string, SwarmPosition>(), worker = safeStand(s)
          for (const a of team.filter(a => a.id !== m.id && !diggers.has(a.id) && underDig(a.position, s))) {
            if (!undermine || plan.has(a.id)) return null
            const q = floorsFor(a).find(q => freeStand(q, a.id) && !underDig(q, s) && (!worker || distance(q, worker) >= .6) &&
              ![...moves.values()].some(t => distance(q, t) < .6) && (!guards.has(a.id) || distance(q, foe.position) <= 3.5))
            if (!q) return null
            moves.set(a.id, q)
          }
          return moves
        }
        const fits = (s: any) => (!undermine || deadly(s)) && !taken.some(q => Math.abs(q.y - s.y) < 2 && Math.hypot(q.x - s.x, q.z - s.z) < (undermine ? 1 : 3)) &&
          ![...reserved].some(([id, r]) => id !== m.id && (cellKey(r.site) === cellKey(s) || underDig(r.stand, s))) &&
          (undermine ? !!safeStand(s) : canDigTrap(m.position, s)) && !stands.some(q => underDig(q, s)) && ![...vacate.values()].some(q => underDig(q, s)) &&
          pickTier(m) >= (s.tier || 0) && (pickTier(m) > 0 || !(s.handMs > 12000)) && (undermine ? affordable(s) : evacuation(s) !== null)
        const old = was.get(m.id)
        const s = sites.find(s => old?.data?.target === foe.id && cellKey(s) === cellKey(old.position!) && fits(s)) || sites.find(fits)
        reserved.delete(m.id)
        if (!s) continue
        vacate.delete(m.id)
        for (const [id, q] of evacuation(s)!) vacate.set(id, q)
        const stand = undermine && safeStand(s)
        if (stand) stands.push(stand)
        taken.push(s); diggers.set(m.id, { site: undermine ? { ...s, undermine: true, ...(stand ? { stands: [stand] } : {}) } : s, foe })
        break
      }
    }
    // Трасса подкопа против сильного (раз в 5 с): сколько мест у него и почему свои не копают.
    if (process.env.ND_SWARM_TRACE && S.state.strongFew && jobs.length && board.now() - digTraceAt > 5000) {
      digTraceAt = board.now()
      const { foe, sites } = jobs[0], why: Record<string, number> = {}
      for (const m of team) {
        const k = diggers.has(m.id) ? 'копает' : plan.has(m.id) ? 'занят' : weak(m) ? 'слаб' : distance(m.position, foe.position) <= 3.5 ? 'в упор' :
          !sites.some(s => canDigTrap(m.position, s)) ? 'не достать' : !sites.some(s => canDigTrap(m.position, s) && pickTier(m) >= ((s as any).tier || 0)) ? 'кирка' : 'другое'
        why[k] = (why[k] || 0) + 1
      }
      const p = foe.position
      console.log(`[${new Date().toTimeString().slice(0, 8)}] 🕳 ${team[0].team}: подкоп у ${foe.id} (${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}) мест ${sites.length}, смертельных ${sites.filter(s => shoveValue(foe, { x: 0, z: 0, drop: (s as any).drop ?? 7 }) >= SHOVE).length}; свои: ${Object.entries(why).map(([k, n]) => `${k} ${n}`).join(', ')}`)
    }
  }
  Object.assign(S, { held, diggers, digAvoid: [...new Map([...clearedTop, ...taken.flatMap(digCells)].map(q => [cellKey(q), q] as const)).values()], digVacate: vacate })
}

export function pvpLadders(S: PvpPlan): void {
  const { board, team, enemies, plan, aggressive, options, diggers } = S
  // Лестница для команды (пользователь 14.10: «лестница, по которой залезут другие, ценнее одноразового столба; дерево —
  // крафтить лестницы»): столб, что построил свой лезущий у цели наверху (ladderSites — драйвер), — один на столб (до
  // двух): ближний, у кого лестниц и брёвен хватит на высоту (бревно ≈ 3 лестницы), не в схватке.
  const ladderers = new Map<string, { key: string; x: number; y: number; z: number; top: number; face: { x: number; z: number } }>()
  // Место — у стены пояса между ботом и целью (верх не выше цели, по горизонтали в 12 бл. от неё); снизу вверх, ближние к цели
  // первыми; до двух сразу. Хватит ли — лестницы + из дерева (7 палок → 3 лестницы; доска → 2 палки; бревно → 4 доски; верстак
  // — 4 доски, если его нет).
  if (aggressive) {
    const goals = enemies.filter(e => board.now() - e.seenAt < 15000)
    const nearGoal = (s: SwarmPosition) => Math.min(...goals.map(e => Math.hypot(e.position.x - s.x, e.position.z - s.z)))
    const sites = (options.ladderSites || []).filter(s => goals.some(e => s.top + 1 <= e.position.y + 1 && e.position.y - s.y >= 3) && nearGoal(s) < 12)
      .sort((a, c) => a.y - c.y || nearGoal(a) - nearGoal(c))
    for (const site of sites) {
      if (ladderers.size >= 2) break
      const need = site.top - site.y + 1
      const enough = (m: SwarmMember) => {
        const planks = count(m.inventory, 'oak_planks') + 4 * count(m.inventory, 'oak_log')
        const sticks = count(m.inventory, 'stick') + 4 * Math.floor(Math.max(0, planks - (count(m.inventory, 'crafting_table') ? 0 : 4)) / 2)
        return count(m.inventory, 'ladder') + 3 * Math.floor(sticks / 7) >= need
      }
      // Не под его прицелом: бот видит его сейчас (sources — кто видит) — значит, и он видит бота. Лестница у него на виду —
      // мишень: с яруса выше человек стрелял в ставящих лестницу, а они кричали «прикройте!» и ставили дальше (игра
      // пользователя 22.10: «в дырочку с лука прострелил — даже не смотрел на это»).
      const exposed = (a: SwarmMember) => enemies.some(e => S.archer(e) && board.now() - e.seenAt < 1500 && (e.sources || []).includes(a.id) && distance(e.position, a.position) <= 40)
      const m = team.filter(a => !plan.has(a.id) && enough(a) && Math.abs(a.position.y - site.y) <= 1.5 && !diggers.has(a.id) && !ladderers.has(a.id) && ![...ladderers.values()].some(l => l.key === site.key) &&
        enemies.every(e => distance(e.position, a.position) > 6) && !exposed(a)).sort((a, c) => distance(a.position, site) - distance(c.position, site))[0]
      if (m) ladderers.set(m.id, site)
    }
  }
  S.ladderers = ladderers
}

export function pvpCampers(S: PvpPlan): void {
  const { team, enemies, aggressive, options, assault, held, diggers, ladderers, weak, outclassed } = S
  // Кемперы (пользователь 14.10: «архетипы — кемперы по углам колизея, прячутся, поджидают; если их начинают раскапывать —
  // резко атаковать»): при большом перевесе (живых ≥ 8 на врага, не штурм) — каждый десятый из снаряжённых, кто дальше 20 бл.
  // от врагов, сидит на шифте в своём тупике колизея (campSpots, ближний к нему из тех, что в 12+ бл. от врагов). Враг
  // подошёл на 20 — кемпер выходит из засады в обычный план (бой — когда тот в 4.5, сектор — как у всех).
  const campers = new Map<string, SwarmPosition>()
  // Штурм новых кемперов не ставит, а сидящих не снимает: засада — поджидать, а не бежать на общий штурм (стенд 15.10: все три
  // кемпера разом «→ fight» на штурме, ни одной коробки).
  if (aggressive && options.campSpots?.length && enemies.length && team.length >= 8 * enemies.length) {
    const was = held('camp')
    // Тупик, где толпятся свои (спавн в начале раунда, сундуки), — не засада: там не спрятаться и не замуроваться.
    // Свою засаду кемпер не теряет из-за прохожего (стенд 15.10: свой прошёл мимо коробки — кемпер «в бой» и лез из неё по кругу).
    const own = new Set([...was.values()].map(cellKey))
    const spots = options.campSpots.filter(s => enemies.every(e => distance(e.position, s) > 12) && (own.has(cellKey(s)) || !team.some(a => !was.has(a.id) && distance(a.position, s) < 4)))
    const pool = team.filter(m => (!assault || was.has(m.id)) && !weak(m) && !enemies.some(e => outclassed(m, e)) && !diggers.has(m.id) && !ladderers.has(m.id) && enemies.every(e => distance(e.position, m.position) > 20))
      .sort((a, b) => Number(was.has(b.id)) - Number(was.has(a.id)) || a.id.localeCompare(b.id))
    for (const m of pool.slice(0, Math.floor(team.length / 10))) {
      const old = was.get(m.id), i = old ? spots.findIndex(x => cellKey(x) === cellKey(old)) : -1
      const s = i >= 0 ? spots.splice(i, 1)[0] : spots.sort((a, b) => distance(a, m.position) - distance(b, m.position)).shift()
      if (s) campers.set(m.id, s)
    }
  }
  S.campers = campers
}

// Тайники в толще (пользователь 21.10: «в стенах Колизея спрятано 2–3 тайника»; модель — cache-model, копка — драйвер
// swarm-driver/caches). Кто копает — числами: копка стоит rate (тайников в секунду по модели: вероятность в открытом ходом
// на секунду дороги и копки) × CACHE_VALUE за минуту; против — бой (враг виден рядом) и лут (недобор снаряжения). Копателей
// не больше половины команды, пока враг недавно виден (бой не бросаем), и все, кроме одного, — если врага не видно 30 с.
// Уже копающий держится, пока копка стоит хотя бы 0.6 альтернативы (без мигания «копаю ↔ лут»).
export const CACHE_VALUE = 14 // тайник: незерит с защитой 20+ и оружие с чарами 20+ — сильнее любого набора сундуков
export const CHEST_VALUE = 1.5 // невиданный обычный сундук (комната, галерея): «пирог» ведёт и к нему — это тоже лут
// fighting — план ведёт его в бой (задача fight), но враг от него дальше 16 бл.: копка против его доли в общем бою.
export type CacheCandidate = { id: string; position: SwarmPosition; health: number; gear: number; canDig: boolean; fighting?: boolean }
// rate — невиданных сундуков в секунду копки; share — доля тайников среди них (модель: тайников 2–3 из всех невиданных).
export type CacheOffer = { rate: number; from: SwarmPosition; to: SwarmPosition; share?: number }
export type CacheJob = { offer: CacheOffer; dig: number; alt: number; reason: string }
// Цена боя для незанятого бойца (враг дальше 16 бл., бой команды — где-то ещё): его доля в общем бою; каждый уже копающий
// товарищ ослабляет бой ещё на FIGHT_EACH (координатор 21.10: «1–2 незанятых копают, пока команда бьётся — ценой, не
// запретом»; бой 15×15 и 4 на 4 не кончается, и свободных ботов для копки иначе нет).
// Подбор по стенду 21.10 (4 на 4, r21–r22): при 6/3 копало в среднем 0.2–0.3 бота на команду — лучшие ходы стоили 4–14 в
// минуту, а бой «где-то ещё» почти всегда в 24–48 бл.; при 3/2 — первый копает с 3, второй с 5.
export const FIGHT_SHARE = 3
export const FIGHT_EACH = 2
export function cacheJobs (team: CacheCandidate[], enemies: SharedEnemy[], offers: Map<string, CacheOffer | null>, now: number, current: Set<string> = new Set()): Map<string, CacheJob> {
  const fresh = enemies.filter(e => now - e.seenAt < 30000)
  const limit = fresh.length ? Math.ceil(team.length / 2) : Math.max(1, team.length - 1)
  const scored: { m: CacheCandidate; offer: CacheOffer; dig: number; alt: number; why: string; share: number }[] = []
  for (const m of team) {
    const offer = offers.get(m.id)
    if (!m.canDig || !offer || offer.rate <= 0 || m.health < 8) continue
    const near = Math.min(Infinity, ...fresh.map(e => distance(e.position, m.position) + (now - e.seenAt) / 1000))
    // Альтернатива в тех же единицах (ценность за минуту): враг в 16 бл. — бой (10 и ещё 2 за каждый блок ближе 24: в 12 бл. —
    // 34, вплотную — 58; ход в стену спиной к нему — смерть, бой важнее), в 16–48 — готовность (4), у бойца — его доля в бою
    // команды (FIGHT_SHARE: бой где-то ещё, координатор 21.10: «нет врага в ~16 — пусть копает»); иначе лут —
    // тем больше, чем хуже одет (gear 0 — голый, 1 — полный набор), или охота — тем больше, чем лучше одет (одетому лут
    // ничего не даёт, а враг сам не придёт). Боец, которого ждёт бой где-то ещё, — не меньше FIGHT_SHARE.
    const loot = (1 - m.gear) * 3, hunt = m.gear * 2
    const alt = near < 16 ? 10 + 2 * (24 - near) : m.fighting ? FIGHT_SHARE : near < 48 ? 4 : Math.max(loot, hunt)
    const share = offer.share ?? 1
    const dig = offer.rate * 60 * (share * CACHE_VALUE + (1 - share) * CHEST_VALUE)
    const why = near >= 16 && m.fighting ? 'бой команды' : near < 48 ? `враг в ${Math.round(near)} бл.` : loot >= hunt ? 'лут' : 'охота'
    scored.push({ m, offer, dig, alt, why, share })
  }
  scored.sort((a, b) => Number(current.has(b.m.id)) - Number(current.has(a.m.id)) || (b.dig - b.alt) - (a.dig - a.alt) || a.m.id.localeCompare(b.m.id))
  // По очереди: бойцу каждый уже взятый копатель дорожает бой на FIGHT_EACH (пока враг виден); уже копающий держится до 0.6.
  const out = new Map<string, CacheJob>()
  let fightersOut = 0
  for (const s of scored) {
    if (out.size >= limit) break
    const alt = s.alt + (s.m.fighting && fresh.length ? FIGHT_EACH * fightersOut : 0)
    if (s.dig <= alt * (current.has(s.m.id) ? 0.6 : 1)) continue
    if (s.m.fighting) fightersOut++
    out.set(s.m.id, { offer: s.offer, dig: s.dig, alt, reason: `тайник: ${(s.offer.rate * 60).toFixed(3)}/мин × (${s.share.toFixed(2)}·${CACHE_VALUE} + ${(1 - s.share).toFixed(2)}·${CHEST_VALUE}) = ${s.dig.toFixed(2)} > ${alt.toFixed(2)} (${s.why})` })
  }
  return out
}
