// Рой (swarm.ts): план боя (planPvp) — цели и приёмы строя: кольцо щитов, кокон и загон, ложная слабость, ложный отход,
// фонтан.
import type { SwarmMember, SwarmPosition } from './types'
import type { PvpPlan } from './plan-frame'
import { distance, cellKey, hasShield, buildBlock } from './common'

export function pvpTargets(S: PvpPlan): void {
  const { board, team, enemies, plan, center, forward } = S
  const loads = new Map(enemies.map(e => [e.id, 0]))
  // Цели, которых сейчас трогать нельзя (замуровываемая в коконе): общий бой их не выбирает.
  const untouchable = new Set<string>()
  const available = team.filter(m => !plan.has(m.id))
  const now = board.now()
  const sideVec = { x: -forward.z, y: 0, z: forward.x }
  const sideOf = (p: SwarmPosition, from: SwarmPosition = center) => (p.x - from.x) * sideVec.x + (p.z - from.z) * sideVec.z
  // Главная цель приёма — ближайшая к своим из свежих (виденных за секунду), а не первая по имени.
  const primary = [...enemies].sort((a, b) => Number(now - a.seenAt > 1000) - Number(now - b.seenAt > 1000) || distance(a.position, center) - distance(b.position, center))[0]
  Object.assign(S, { loads, untouchable, available, now, primary })
}

export function ringShields(S: PvpPlan): void {
  const { doctrine, primary, available, plan, enemies, now, spots, center, put } = S
  // Кольцо щитов: кто со щитом и не в ближнем бою, стоит на своём месте кольца лицом наружу с поднятым щитом.
  if (doctrine === 'ring' && primary) for (const m of available) {
    if (plan.has(m.id) || !hasShield(m) || enemies.some(e => now - e.seenAt <= 1000 && distance(e.position, m.position) <= 4.5)) continue
    const spot = spots.get(m.id)!, rx = spot.x - center.x, rz = spot.z - center.z, r = Math.hypot(rx, rz) || 1
    put(m, 'goto', { hold: 'shield', reserve: true, range: .6, target: primary.id, face: { x: spot.x + rx / r * 8, y: spot.y + 1.6, z: spot.z + rz / r * 8 } }, spot)
  }
}

export function pvpBuilders(S: PvpPlan): void {
  const { board, doctrine, primary, committed, now, available, plan, aggressive, assault, forward, untouchable, put, weak, outclassed } = S
  // Добивание: кокон — нет (стоящего добивают все), отсечка бегущего — двумя строителями, остальные бьют (стенд 15×15,
  // 21.10: стенка держала всех строителей, пока 13 добивали двоих; DeepSeek, разбор погони: отсечку не выключать целиком).
  if (primary && committed && !(S.endgame && doctrine === 'cocoon') && ['cocoon', 'hunt'].includes(doctrine) && now - primary.seenAt <= 500) {
    // Натиск: строитель рядом с целью (6 бл.) — дерётся, а не кладёт стенку у неё под мечом.
    // Слабый и переигранный стенку у него не кладут (стенд rush 15.10: 6 из 7 первых смертей — строители «загона» у незеритового).
    // Проигрываем (losing: штурм провален или нас мало) — не строить: строитель получал стенку, пока цель видна ≤ 0.5 с, а
    // иначе — «проигрываем — прячусь», и на трибуне (цель то видна, то нет) дело менялось каждую секунду со стопом —
    // бот стоял «афк» (игра пользователя 22.10: «афкшников всё равно вижу», 57 смен «прячусь ↔ строю» за 7 мин).
    const builders = available.filter(m => !plan.has(m.id) && m.role === 'miner-builder' && buildBlock(m) && !(aggressive && (assault || S.losing || distance(m.position, primary.position) <= 6 || weak(m) || outclassed(m, primary)))).slice(0, S.endgame ? 2 : undefined)
    if (builders.length) {
      // Загон впереди бегущей цели (14.10): стенка в 3 бл. от неё не успевала — на спринте (5.6 бл/с) цель пробегала место
      // раньше, чем строители клали клетки (лаборатория, run9 и run12). Бежит — упреждение на 1.5 с пути (3–9 бл.) и стенка
      // поперёк бега; стоит — 3 бл. от неё по направлению строя, как раньше.
      const v = primary.velocity || { x: 0, y: 0, z: 0 }, speed = Math.hypot(v.x, v.z) * 20
      const running = doctrine === 'hunt' && speed > 2.5
      const axis = running ? { x: v.x * 20 / speed, z: v.z * 20 / speed } : { x: forward.x, z: forward.z }
      const offset = doctrine === 'hunt' ? (running ? Math.min(9, Math.max(3, speed * 1.5)) : 3) : 0
      const fresh = { x: Math.floor(primary.position.x + axis.x * offset), y: Math.floor(primary.position.y), z: Math.floor(primary.position.z + axis.z * offset) }
      // Одна стройка на команду: все строители кладут один чертёж (раньше у каждого был свой центр от живой позиции
      // цели, и второй строитель натыкался на чужие клетки — лаборатория 13.10, загон: стену клал один). Новое место —
      // только когда цель ушла: из клетки кокона или дальше 10 бл. от стены загона (и та стена готова или не начата).
      const id = 'build-site:' + doctrine, axisId = 'build-axis:' + doctrine
      let site = board.facts().find(f => f.id === id), siteAxis = board.facts().find(f => f.id === axisId)
      // Цель уже за стенкой загона (по оси стенки дальше 1.5 бл.) — стенка бесполезна и переносится, даже начатая.
      const passed = doctrine === 'hunt' && !!site && !!siteAxis && (primary.position.x - site.position.x - .5) * (siteAxis.position.x - site.position.x) + (primary.position.z - site.position.z - .5) * (siteAxis.position.z - site.position.z) > 1.5
      const gone = !site || (doctrine === 'cocoon'
        ? Math.floor(primary.position.x) !== site.position.x || Math.floor(primary.position.z) !== site.position.z || Math.abs(primary.position.y - site.position.y) > 1
        : passed || distance(primary.position, site.position) > 10 && (() => {
          // Начатую стенку загона достраивают: перенос бросал готовую на 60 % стену ради новой за убегающей целью
          // (лаборатория 14.10: вторую стену клал один строитель). Переносится только готовая или не начатая.
          const cells = board.tasks().filter(t => t.kind === 'build' && t.data?.blueprint === `cutoff:${cellKey(site!.position)}`)
          return !cells.length || cells.every(t => t.status === 'done')
        })())
      // Кокон закладывается только вокруг стоящей цели: в прыжке клетка ног на блок выше, и кокон висел в воздухе (разбор 13.10).
      const standing = doctrine !== 'cocoon' || Math.abs(primary.position.y - Math.round(primary.position.y)) < .05
      if (gone && standing) {
        board.recordFact(builders[0].id, now, { id, kind: 'mark', position: fresh }, 30000)
        board.recordFact(builders[0].id, now, { id: axisId, kind: 'mark', position: { x: fresh.x + axis.x, y: fresh.y, z: fresh.z + axis.z } }, 30000)
        site = board.facts().find(f => f.id === id); siteAxis = board.facts().find(f => f.id === axisId)
      } else if (gone) site = undefined
      // Стенка — поперёк оси, заложенной вместе с местом (не от живого направления строя: оно прыгает за целью).
      const along = site && siteAxis ? { x: siteAxis.position.x - site.position.x, z: siteAxis.position.z - site.position.z } : forward
      const direction = Math.abs(along.x) > Math.abs(along.z) ? along.x > 0 ? 'east' : 'west' : along.z > 0 ? 'south' : 'north'
      if (site) for (const m of builders) put(m, 'scout', { buildKind: doctrine === 'hunt' ? 'cutoff' : 'cocoon', block: buildBlock(m), target: primary.id, enemyPosition: primary.position, origin: site.position, direction })
      // Оцепление кокона: пока стройка не замкнута, остальные не бьют цель (удар — повод вырваться: лаборатория 13.10,
      // цель ушла через щель, пока свои её били) и стоят у выходов — у обеих щелей и по бокам. Замкнут — бьют сквозь щели.
      const inside = site && Math.floor(primary.position.x) === site.position.x && Math.floor(primary.position.z) === site.position.z && Math.abs(primary.position.y - site.position.y) <= 1
      if (doctrine === 'cocoon' && site && inside) {
        const cells = board.tasks().filter(t => t.kind === 'build' && t.data?.blueprint === `cocoon:${cellKey(site.position)}`)
        const sealed = cells.length > 0 && cells.every(t => t.status === 'done')
        if (!sealed) untouchable.add(primary.id)
        const [dx, dz] = ({ east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1] } as Record<string, number[]>)[direction]
        const c0 = { x: site.position.x + .5, y: site.position.y, z: site.position.z + .5 }
        const exits = [[dx, dz], [-dx, -dz], [-dz, dx], [dz, -dx]].map(([x, z]) => ({ x: c0.x + x * 2, y: c0.y, z: c0.z + z * 2 }))
        const guards = available.filter(m => !plan.has(m.id))
        for (const at of exits) {
          const g = guards.filter(m => !plan.has(m.id)).sort((a, b) => distance(a.position, at) - distance(b.position, at))[0]
          if (!g) break
          if (sealed) put(g, 'fight', { cordon: true, target: primary.id, enemyPosition: primary.position }, at)
          else put(g, 'goto', { hold: 'cordon', range: .6, target: primary.id, enemyPosition: primary.position }, at)
        }
      }
    }
  }
}

export function falseWeakness(S: PvpPlan): void {
  const { board, team, doctrine, primary, committed, now, center, forward, available, plan, loads, put } = S
  if (primary && committed && doctrine === 'false-weakness') {
    // Якорь и ось приёма — на доске с первого плана: середина строя уезжает вперёд за атакующими, и «глубина кармана»
    // от неё срабатывала раньше времени (лаборатория 14.10).
    let anchor = board.facts().find(f => f.id === 'feint-anchor'), axis = board.facts().find(f => f.id === 'feint-axis')
    if (!anchor || !axis) {
      board.recordFact(team[0].id, now, { id: 'feint-anchor', kind: 'mark', position: { ...center } }, 30000)
      board.recordFact(team[0].id, now, { id: 'feint-axis', kind: 'mark', position: { x: center.x + forward.x, y: center.y, z: center.z + forward.z } }, 30000)
      anchor = board.facts().find(f => f.id === 'feint-anchor'); axis = board.facts().find(f => f.id === 'feint-axis')
    }
    const a = anchor?.position ?? center, ax = axis ? { x: axis.position.x - a.x, y: 0, z: axis.position.z - a.z } : forward
    const lat = { x: -ax.z, z: ax.x }, latOf = (p: SwarmPosition) => (p.x - a.x) * lat.x + (p.z - a.z) * lat.z
    const free = available.filter(m => !plan.has(m.id))
    const bait = free.filter(m => m.role !== 'healer' && m.role !== 'flank').sort((p, q) => p.strength - q.strength)[0] ?? free.filter(m => m.role !== 'healer').sort((p, q) => p.strength - q.strength)[0]
    if (bait) put(bait, 'goto', { bait: true, target: primary.id, enemyPosition: primary.position })
    // Засада с двух сторон: по одному флангу на сторону ждут впереди-сбоку «кармана», пока цель гонится за приманкой,
    // и бьют с боков и со спины, когда она прошла их линию (лаборатория 13.10: засады не было вовсе — фланги стояли в строю).
    const flanks = free.filter(m => m !== bait && m.role === 'flank').sort((p, q) => latOf(p.position) - latOf(q.position))
    const depth = (primary.position.x - a.x) * ax.x + (primary.position.z - a.z) * ax.z
    const pair: [SwarmMember, number][] = flanks.length >= 2 ? [[flanks[0], -1], [flanks[flanks.length - 1], 1]] : []
    const sprung = depth <= 3.5 || pair.some(([m]) => distance(m.position, primary.position) <= 4.5)
    for (const [m, sign] of pair) {
      const ambush = { x: a.x + ax.x * 3 + lat.x * sign * 5, y: m.position.y, z: a.z + ax.z * 3 + lat.z * sign * 5 }
      const data = { ambush: sign < 0 ? 'left' : 'right', target: primary.id, enemyPosition: primary.position }
      if (sprung) { put(m, 'fight', data, primary.position); loads.set(primary.id, (loads.get(primary.id) || 0) + 1) }
      else put(m, 'goto', { ...data, hold: 'ambush', range: .8 }, ambush)
    }
    // Остальные изображают слабость вместе с приманкой: стоят за ней, не лезут в драку, пока ловушка не захлопнулась
    // (лаборатория 14.10: бойцы сразу бросились на красных, те ответили, «карман» развалился).
    if (!sprung) for (const [k, m] of free.filter(m => m !== bait && !pair.some(([f]) => f === m) && m.role !== 'healer' && !plan.has(m.id)).entries()) {
      const across = (k % 2 ? 1 : -1) * (1.5 + Math.floor(k / 2) * 1.5)
      put(m, 'goto', { hold: 'ambush', range: .8, feintGuard: true, target: primary.id, enemyPosition: primary.position }, { x: a.x - ax.x * 4 + lat.x * across, y: m.position.y, z: a.z - ax.z * 4 + lat.z * across })
    }
  }
}

export function falseRetreat(S: PvpPlan): void {
  const { board, team, doctrine, primary, committed, now, center, forward, available, plan, put } = S
  if (primary && committed && doctrine === 'false-retreat') {
    let rally = board.facts().find(f => f.id === 'feigned-rally')
    if (!rally) { board.recordFact(team[0].id, now, { id: 'feigned-rally', kind: 'mark', position: { x: center.x - forward.x * 8, y: center.y, z: center.z - forward.z * 8 } }, 30000); rally = board.facts().find(f => f.id === 'feigned-rally') }
    if (rally && now - rally.seenAt < 8000) for (const m of available) if (!plan.has(m.id)) put(m, 'goto', { bait: true, feigned: true, target: primary.id, enemyPosition: primary.position }, rally.position)
  }
}

export function fountain(S: PvpPlan): void {
  const { board, team, doctrine, primary, now, center, available, plan, loads, put } = S
  // Фонтан: при рывке хищника строй расходится в стороны, пропуская его по коридору, а когда он проскочил середину —
  // смыкается вокруг него со всех сторон, со спины первым. Ось и середина рывка запоминаются на доске, пока он идёт.
  if (doctrine === 'fountain' && primary && now - primary.seenAt <= 1000) {
    const v = primary.velocity || { x: 0, y: 0, z: 0 }, speed = Math.hypot(v.x, v.z)
    const charging = speed * 20 > 2.5 && v.x * (center.x - primary.position.x) + v.z * (center.z - primary.position.z) > 0
    let anchor = board.facts().find(f => f.id === 'fountain-anchor'), heading = board.facts().find(f => f.id === 'fountain-axis')
    if ((!anchor || !heading) && charging) {
      board.recordFact(team[0].id, now, { id: 'fountain-anchor', kind: 'mark', position: { ...center } }, 12000)
      board.recordFact(team[0].id, now, { id: 'fountain-axis', kind: 'mark', position: { x: center.x + v.x / speed, y: center.y, z: center.z + v.z / speed } }, 12000)
      anchor = board.facts().find(f => f.id === 'fountain-anchor'); heading = board.facts().find(f => f.id === 'fountain-axis')
    }
    // Идёт к нам, но ещё не рывком — коридор раскрывается заранее по линии «он — середина строя» (лаборатория 13.10: до
    // рывка строй бежал ему навстречу). Стоит на месте — обычный бой вразброс, без раскрытия.
    const toUs = Math.hypot(center.x - primary.position.x, center.z - primary.position.z) || 1
    const pre = !anchor && v.x * (center.x - primary.position.x) + v.z * (center.z - primary.position.z) > 0
      ? { a: center, ax: { x: (center.x - primary.position.x) / toUs, z: (center.z - primary.position.z) / toUs } } : null
    if ((anchor && heading) || pre) {
      const a = pre ? pre.a : anchor!.position, ax = pre ? pre.ax : { x: heading!.position.x - a.x, z: heading!.position.z - a.z }
      const lateral = { x: -ax.z, z: ax.x }
      const progress = (primary.position.x - a.x) * ax.x + (primary.position.z - a.z) * ax.z
      const school = available.filter(m => !plan.has(m.id))
      if (progress < 1.5) {
        // Пробка (14.10): один встаёт в коридоре в 7 бл. за серединой — рывок упирается в него, и строй смыкается вокруг,
        // а не догоняет со спины (лаборатория run11: прорвавшийся бежал дальше, все сомкнулись только сзади). Со щитом —
        // щит к нему; без щита — самый крепкий. Нужны хотя бы двое на коридор по бокам.
        const cork = school.length >= 3 ? school.slice().sort((p, q) => Number(hasShield(q)) - Number(hasShield(p)) || q.health * q.strength - p.health * p.strength)[0] : undefined
        if (cork) put(cork, 'goto', { fountain: 'cork', ...(hasShield(cork) ? { hold: 'shield', face: { x: primary.position.x, y: primary.position.y + 1.6, z: primary.position.z } } : {}), range: .6, target: primary.id, enemyPosition: primary.position },
          { x: a.x + ax.x * 7, y: cork.position.y, z: a.z + ax.z * 7 })
        // Каждый уходит на свою сторону коридора и на шаг дальше, чем стоит: коридор — не уже 5 бл. от оси.
        const s = (m: SwarmMember) => (m.position.x - a.x) * lateral.x + (m.position.z - a.z) * lateral.z
        const ranks = new Map<number, number>()
        for (const [i, m] of school.filter(m => m !== cork).sort((p, q) => Math.abs(s(p)) - Math.abs(s(q))).entries()) {
          const sign = s(m) > .3 ? 1 : s(m) < -.3 ? -1 : i % 2 ? 1 : -1
          const rank = ranks.get(sign) || 0; ranks.set(sign, rank + 1)
          const out = sign * Math.max(Math.abs(s(m)) + 1.5, 5 + rank * 1.5)
          const along = Math.max(-6, Math.min(2, (m.position.x - a.x) * ax.x + (m.position.z - a.z) * ax.z))
          put(m, 'goto', { fountain: 'open', range: .5, target: primary.id, enemyPosition: primary.position }, { x: a.x + ax.x * along + lateral.x * out, y: m.position.y, z: a.z + ax.z * along + lateral.z * out })
        }
      } else {
        // Смыкание: места по кругу 2.5 бл. от него, первое — прямо за спиной (против хода рывка).
        const back = Math.atan2(-ax.z, -ax.x), n = school.length
        const slots = Array.from({ length: n }, (_, k) => back + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 2 * Math.PI / Math.max(3, n))
        const taken = new Set<number>()
        for (const m of school.sort((p, q) => distance(p.position, primary.position) - distance(q.position, primary.position))) {
          const angle = Math.atan2(m.position.z - primary.position.z, m.position.x - primary.position.x)
          const k = slots.map((t, j) => ({ j, d: Math.abs(Math.atan2(Math.sin(t - angle), Math.cos(t - angle))) })).filter(o => !taken.has(o.j)).sort((p, q) => p.d - q.d)[0].j
          taken.add(k)
          put(m, 'fight', { fountain: 'close', target: primary.id, enemyPosition: primary.position }, { x: primary.position.x + Math.cos(slots[k]) * 2.5, y: primary.position.y, z: primary.position.z + Math.sin(slots[k]) * 2.5 })
          loads.set(primary.id, (loads.get(primary.id) || 0) + 1)
        }
      }
    }
  }
}
