'use strict'
// Слежка за бойцами: тревога (враг подбегает — рвать дело), рой (swarm-driver) и враги глазами, обёртки вызовов
// демона, опрос состояния, сторож зависаний, мобы глазами, счёт и уборка.
import { ROOT, SOLO } from './context'
import { SPRINT, power, MOB_SPD, worthOf } from './gear'
import type { ArenaContext } from './context'
const fs = require('fs')
const path = require('path')

const dist3 = (a, c) => Math.hypot(a.x - c.x, a.y - c.y, a.z - c.z)

export function watchAlarm (ctx: ArenaContext) {
  const { teams, bots, names, pos, busy, teamOf } = ctx
  const cancelled = new WeakMap<object, { round: number, action: any }>()
  // Тревога (10.10: «подбегаю быстро — тупят, не реагируют, как будто не успевают; должны понимать, что я быстрый»):
  // раз в 250 мс у каждого бойца не в бою — кто доберётся до меня быстрее чем за 2 с (по его скорости, а не по блокам:
  // игрок со «Скоростью V» — 10+ бл/с), тот рвёт текущее дело (лут, путь, крафт); цикл бойца решит заново — бежать,
  // звать своих или драться. Одно текущее дело отменяется один раз; новое не наследует иммунитет старого.
  return setInterval(() => {
    if (ctx.between) return
    for (const b of bots) {
      const m = pos[b.name]; if (!m?.p || !ctx.alive(b.name)) continue
      // Бой и уход (жемчуг, заряд, подкоп, бег) — не рвать: это и есть ответ на угрозу.
      // Рывок/заливка/полёт (busy) — тоже ответ на угрозу (12.10, замер лучником: тревога гасила каждый стрейф через доли секунды).
      // Идёт к человеку (погоня, спуск к нему — _hunt) — это и есть ответ: не рвать (13.10: «скопились наверху» — тревога
      // обрывала спуск к нему каждые 5 с).
      if (b.last?.p?._hunt && !b.swarmTask?.data?.dig) continue
      // Кемпер выходит из коробки (ранен) — не рвать выход (Codex 15.10).
      if (b.campReacting) continue
      if (busy.has(b.name) || (!b.looting && (/^(fight|drink_buffs|pearl_to|wind_jump|burrow|flee|block_behind|evade|douse_lava|fly_to|peek_shot|wind_leap|juke|take_cover|undercut)$/.test(b.last?.m || '') || b.waiting))) continue
      const en = ctx.enemiesOf(b, m.p)
      const t = (e) => Math.max(0, e.d - 3) / Math.max(e.spd, SPRINT)
      const hot = en.filter(e => t(e) < (SOLO && e.human ? 3.5 : 2) && (e.human || e.d < 6))
      if (!hot.length) continue
      // Копатель ямы работает у врага нарочно: пока тот не вплотную (3.5 — контакт, бой решает цикл роя), не рвать.
      if (b.swarmTask?.data?.dig && hot.every(e => e.d > 3.5)) continue
      const old = cancelled.get(b)
      if (old && old.round === ctx.round && old.action === b.last) continue
      cancelled.set(b, { round: ctx.round, action: b.last })
      if (b.looting || b.climbing || b.last && b.last.pending !== false) { b.looting = false; b.c.call('stop').catch(() => {}) }
      const ours = names.filter(n => n !== b.name && teamOf(n) === b.team && ctx.alive(n) && dist3(pos[n].p, m.p) / SPRINT < 2.5).length
      if (teams) ctx.callout(b, 'cover', { foe: hot[0].n, foes: hot.length, mates: ours }, 6000, `прикройте! на меня ${ctx.short(hot[0].n)}${hot.length > 1 ? ` и ещё ${hot.length - 1}` : ''}`)
    }
  }, 250)
}

export function installSight (ctx: ArenaContext) {
  const { i, arms, bots, names, pos, humans, X, Y, Z, R, L, rcon, log } = ctx
  const arena = { x: X + .5, y: Y, z: Z + .5, r: R, killY: arms ? Y + L.y0 - 3 : undefined }
  // Соло (люди против роя): натиск — бегут только на хилку, без обманок, голые сперва лутаются (14.10: «не атакуют»).
  // Укрытия для слабых (натиск): закрытые места колизея — камеры, галереи, лаборатория, оружейная, комнаты спавна.
  const hideouts = arms && L?.map === 'colosseum' ? [...L.areas.filter(a => /^(камера|галерея|лаборатория|оружейная)/.test(a.id)), ...(L.spawnRooms || []).filter(r => r.team !== (ctx.HUMAN_TEAM || 'red')).map(r => r.spot)]
    .map(a => ({ x: X + a.x + .5, y: Y + a.y, z: Z + a.z + .5, tier: require('./loot').tierOf(a.y) })) : []
  // Сундуки крыши и венца (ярусы 4–5, лучший лут) — тоже места обхода: пешком туда не дойти, только столбом с галереи 4 (dy 24)
  // (пользователь 15.10: «проверь, что сундуки с самой большой высоты лутают»; за ночной раунд их не открыли ни разу).
  const chestTops = arms && L?.map === 'colosseum' ? (L.chests || []).filter(c => c.y >= 30).map(c => ({ x: X + c.x + .5, y: Y + c.y, z: Z + c.z + .5, climbFrom: Y + 24, tier: require('./loot').tierOf(c.y) })) : []
  // Обрыв у цели (окружение — бить с другой стороны, чтобы отбросило вниз): по модели колизея с раскладкой — в 8 сторонах на
  // 1–3 бл. от него пола нет на 4+ бл. вниз. Модель — как построено (столбы и воронки раунда не видит).
  let edgeOf = null, digSites = null, surfaceY = null, ladderSites: any[] = []
  if (arms && L?.map === 'colosseum') {
    const C = require('../../daemon/colosseum'); const g = C.model({ R: 24, ceilH: 16 }).g
    for (const [x, y, z, b] of [...L.field, ...L.set]) g.set(x, y, z, b === 'air' ? '' : b.replace(/\{.*$/, ''))
    // Пол поля (песок на −1) кладут команды раскладки, в модели его нет; лава ям — не пол (туда и скидывать).
    const solid = (x, y, z) => { const b = g.get(x, y, z); return b ? !/carpet|banner|lantern|button|torch|ladder|lava/.test(b) : y === -1 && Math.abs(x) <= L.R && Math.abs(z) <= L.R }
    edgeOf = p => {
      const rx = Math.floor(p.x - X), ry = Math.floor(p.y - Y), rz = Math.floor(p.z - Z)
      // Ближний обрыв, до которого тело долетит: стена на пути (ноги или голова) — не обрыв (Codex 15.10: бил «в обрыв» сквозь стену).
      let best = null
      for (let k = 0; k < 8; k++) for (let t = 1; t <= 3; t++) {
        const dx = Math.round(Math.cos(k * Math.PI / 4) * t), dz = Math.round(Math.sin(k * Math.PI / 4) * t)
        // Стена — твёрдое выше его ног (нижняя плита пола под ногами — не стена; Codex 15.10).
        const wall = (x, y, z) => solid(x, y, z) && (floorTop(x, y, z) == null || floorTop(x, y, z) > p.y - Y + 1e-3)
        if (wall(rx + dx, ry, rz + dz) || wall(rx + dx, ry + 1, rz + dz)) break
        let floor = false
        for (let y = ry - 1; y >= ry - 4 && !floor; y--) floor = solid(rx + dx, y, rz + dz)
        if (!floor) { if (!best || t < best.t) best = { t, k }; break }
      }
      return best ? { x: Math.cos(best.k * Math.PI / 4), z: Math.sin(best.k * Math.PI / 4) } : null
    }
    // Места для ям-ловушек: клетка пола этажа (галереи dy 8/16/24, крыша-терраса 31), под ней 2 блока, ниже — пустота 4+
    // (этаж ниже): вскрыть 2 — дыра с падением 6–8 бл.
    const holeCells: any[] = []
    const mc = require('../../daemon/node_modules/minecraft-data')('1.21.11')
    const floorTop = (x, y, z) => { const b = g.get(x, y, z); if (C.sturdyFace(b, 'up')) return y + 1; return C.isSlab(b) && C.parse(b).props?.type === 'bottom' ? y + .5 : null }
    const handMs = b => { const d = b && mc.blocksByName[C.parse(b).name]; return !d || d.diggable === false || d.hardness < 0 ? Infinity : Math.ceil(d.hardness * (d.harvestTools ? 100 : 30)) * 50 }
    for (let x = -L.half; x <= L.half; x++) for (let z = -L.half; z <= L.half; z++) for (const F of [8, 16, 24, 31]) {
      if (!solid(x, F - 1, z) || solid(x, F, z) || solid(x, F + 1, z) || !solid(x, F - 2, z)) continue
      let air = 0; for (let y = F - 3; y >= F - 9 && !solid(x, y, z); y--) air++
      if (air < 4) continue
      const feet = floorTop(x, F - 1, z); if (feet == null) continue
      const stands = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dz]) => floorTop(x + dx, F - 1, z + dz) === feet && !solid(x + dx, F, z + dz) && !solid(x + dx, F + 1, z + dz))
        .map(([dx, dz]) => ({ x: X + x + dx + .5, y: Y + feet, z: Z + z + dz + .5 }))
      const blocks = [g.get(x, F - 1, z), g.get(x, F - 2, z)]
      if (stands.length) holeCells.push({ x, y: F - 1, z, F, feetY: Y + feet, stands, blocks, handMs: blocks.reduce((n, b) => n + handMs(b), 0) })
    }
    // Все места у цели; досягаемость копателю и разнос проверяет планировщик.
    digSites = p => {
      const rx = p.x - X, ry = p.y - Y, rz = p.z - Z, out: any[] = []
      for (const c of holeCells.filter(c => Math.abs(c.F - ry) < 1.6).map(c => ({ c, d: Math.hypot(c.x + .5 - rx, c.z + .5 - rz) })).filter(o => o.d >= 2 && o.d <= 6).sort((a, b) => a.d - b.d)) {
        out.push({ ...c.c, x: X + c.c.x, y: Y + c.c.y, z: Z + c.c.z })
      }
      return out
    }
    log(`ямы-ловушки: мест в полах этажей ${holeCells.length}`)
    const inside = (x, z) => Math.abs(x) <= L.half && Math.abs(z) <= L.half
    for (let x = -L.half; x <= L.half; x++) for (let z = -L.half; z <= L.half; z++) for (let F = 0; F <= 40; F++) {
      if (!C.sturdyFace(g.get(x, F - 1, z), 'up') || g.get(x, F, z) || g.get(x, F + 1, z)) continue
      for (const [name, [fx, fz]] of Object.entries(C.DIR) as [string, number[]][]) {
        const wx = x - fx, wz = z - fz, sx = x + fx, sz = z + fz
        if (!inside(wx, wz) || !inside(sx, sz) || !C.sturdyFace(g.get(sx, F - 1, sz), 'up') || g.get(sx, F, sz) || g.get(sx, F + 1, sz)) continue
        for (let top = F; top <= F + 9; top++) {
          if (!C.sturdyFace(g.get(wx, top, wz), name) || g.get(x, top, z) || g.get(x, top + 1, z)) break
          if (top - F + 1 < 3 || !C.sturdyFace(g.get(wx, top, wz), 'up') || g.get(wx, top + 1, wz) || g.get(wx, top + 2, wz)) continue
          ladderSites.push({ key: `${X + wx},${Y + F},${Z + wz},${fx},${fz}`, x: X + wx, y: Y + F, z: Z + wz, top: Y + top, face: { x: fx, z: fz } })
          break
        }
      }
    }
    log(`лестницы: мест у стен ${ladderSites.length}; по высоте основания: ${Object.entries(ladderSites.reduce((o, s) => (o[s.y - Y] = (o[s.y - Y] || 0) + 1, o), {})).map(([y, n]) => `${y}:${n}`).join(' ')}; примеры ${[0, 4, 8, 24].map(h => ladderSites.filter(s => s.y - Y === h).slice(0, 2).map(s => s.key + '→' + (s.top - Y)).join(' ')).join(' | ')}`)
    // Поверхность под точкой (подъём отрезками): верхняя клетка, где стоять, не выше top — ступень рядов, проход, крыша.
    // Замер 14.10: отрезки по поверхности — с песка на крышу за 58 с и 29 блоков без кирки; по прямой — внутрь засыпки рядов.
    surfaceY = (x, z, top) => { const rx = Math.floor(x - X), rz = Math.floor(z - Z); for (let y = Math.floor(top - Y); y >= -2; y--) if (solid(rx, y - 1, rz) && !solid(rx, y, rz) && !solid(rx, y + 1, rz)) return Y + y; return null }
  }
  ctx.swarmDriver = require('../swarm-driver').createSwarmDriver({ bots, pos, alive: ctx.alive, arms, arena, hideouts, chestTops, perches: ctx.perches, drops: () => Object.values(ctx.deathAt), aggressive: SOLO && process.env.SWARM_AGGRO !== '0',
    sandSpot: arms && L?.map === 'colosseum' ? { x: X + 0.5, y: Y, z: Z + 10.5 } : null, edgeOf, digSites, surfaceY, ladderSites,
    announce: SOLO ? (text, color) => rcon(i, `tellraw @a ${JSON.stringify([{ text: '[рой] ', color: 'dark_aqua' }, { text, color }])}`) : null,
    home: b => { if (arms) return ctx.armsHome(b, 0); const [x, z] = ctx.home(b, 0).split(/\s+/).map(Number); return { x, y: Y, z } }, log,
    hostile: ctx.hostile
  })
  ctx.enemiesOf = (b, at) => [
    ...ctx.swarmDriver.enemies(b).map(e => ({ n: e.id, p: e.position, spd: Math.hypot(e.velocity?.x || 0, e.velocity?.z || 0) * 20,
      geared: !!e.equipment?.weapon || !!e.equipment?.armor?.length, human: !names.includes(e.id),
      pow: power(20, e.equipment?.weapon ? { [e.equipment.weapon]: 1 } : {}, Object.fromEntries((e.equipment?.armor || []).map((n, k) => [k, n]))) })),
    // Мобы — те же враги (10.10: «от мобов бегут, а меня не видят»): что видит сам боец (демон, раз в секунду).
    ...((pos[b.name]?.mobs || []) as any[]).map(m => ({ n: `mob${m.id}`, id: m.id, p: m.p, spd: MOB_SPD[m.name] ?? 3, geared: true, human: false, mob: true, kind: m.name, pow: 0 }))
  ].map(e => ({ ...e, d: at ? dist3(e.p, at) : Infinity })).sort((a, c) => a.d - c.d)
  // Отход к своим (10.10: «один — иногда убегать к союзникам»; «не хардкодь блоки — адаптивно»). Без порогов в блоках:
  // враг сильнее моей силы «здесь» (я + свои, кто успеет за секунду) — к той группе своих, что даст больше силы на
  // секунду пути, если добегу раньше, чем он догонит (разрыв до удара / разница скоростей). Догонит раньше — драться.
  // Лезет к человеку (b.climbing) — другие задачи драйвера (обмен бронёй, «прикрываю», сундуки, сбор) его не дёргают
  // (13.10: «сижу в нычке — никто не дошёл»: путь наверх в 45 шагов находился, но подъём рвали обмены и прикрытие — 0–3 бл.
  // за 20 с). Пропускаются только ответы на угрозу, свой подъём (_climb) и стоп.
  // Человек ворвался (ближе 6 бл.) — подъём/подкоп уже не главное (13.10: «бот строит, я врываюсь — должен видеть меня и
  // решать: драться тем, что есть, или уходить, отбиваясь»): тревога рвёт дело, цикл выбирает бой или отход.
  const humanClose = (b) => { const p = pos[b.name]?.p; return !!p && !!ctx.swarmDriver && ctx.swarmDriver.enemies(b).some(e => Date.now() - e.seenAt < 1500 && !names.includes(e.id) && Math.hypot(e.position.x - p.x, e.position.y - p.y, e.position.z - p.z) < 6) }
  const CLIMB_OK = /^(status|emote|look_at|armor|team_hint|mobs|rescue_config|wind_leap|dig_to|undercut|watch_dangers|evade|juke|take_cover|douse_lava|wind_jump|pearl_to|fly_to|mine)$/
  // Открытый сундук — в opened: по нему таймер пополнения (ARMS_LOOT_X) знает, что пополнять. Раньше его отмечал старый
  // лут ffa, после роя — никто, и пополнение не работало вовсе (14.10). Ключ — как у L.chests (от центра карты), вторая
  // половина двойного — по pair.
  const same = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z
  const markOpened = at => { const c = L?.chests.find(c => same({ x: X + c.x, y: Y + c.y, z: Z + c.z }, at) || same(c.pair, at)); if (c) ctx.opened.add(`${c.x},${c.y},${c.z}`) }
  for (const b of bots) { const raw = b.c.call.bind(b.c); b.c.call = (m, p) => {
    p = { ...p, arena: p?.arena || arena }
    // Мгновенные запросы (items_near, blocks_around) — не дело: перекрывали настоящее последнее, и сторож «сбрасывал items_near».
    const action = /^(status|observe|swarm_pose|swarm_position|emote|look_at|armor|team_hint|stop|mobs|rescue_config|watch_dangers|swarm_keep|items_near|blocks_around)$/.test(m) ? null : (b.last = { m, at: Date.now(), p, pending: true })
    const out = raw(m, p)
    if (action) Promise.resolve(out).then(() => { action.pending = false }, () => { action.pending = false })
    if (m === 'chest_take') Promise.resolve(out).then(r => markOpened(r?.detail?.at || (Number.isFinite(p.x) ? { x: p.x, y: p.y, z: p.z } : null)), () => {})
    return out
  } }
  // Обёртка подъёма — внешняя, после учёта b.last: пропущенный «лезу к цели» вызов (обмен, лут) не перезаписывает b.last
  // (копатель шёл к яме с _hunt, обмен перезаписывал его, тревога видела «не к человеку» и слала stop — 29 «cancelled»).
  for (const b of bots) { const raw0 = b.c.call.bind(b.c); b.c.call = (m, p) => (b.climbing && !(p && p._climb) && !CLIMB_OK.test(m) && !(m === 'stop' && ctx.between) && !humanClose(b)) ? Promise.resolve({ status: 'skipped', detail: { why: 'лезу к цели' } }) : raw0(m, p) }
}

export function watchStatus (ctx: ArenaContext) {
  const { teams, arms, bots, names, pos, busy, out, deadNow, labNeed, deathAt, rel, humans, X, Y, Z, L, STOPF, HUMAN_TEAM, teamOf, log } = ctx
  const mobInfo: Record<string, any> = {}
  const panicStops = new WeakMap<object, { round: number, action: any }>()
  const spreading = new WeakMap<object, { round: number, holder: string, mate: string, action: any }>()
  // Мобы глазами бойцов — раз в секунду (только с мобами на арене: ARMS_MOBS).
  const mobPollT = process.env.ARMS_MOBS ? setInterval(() => {
    for (const b of bots) {
      if (!pos[b.name]?.p || deadNow.has(b.name)) continue
      b.c.call('mobs', { radius: 24 }).then(r => {
        const list = (r?.detail || r)?.mobs || []
        if (pos[b.name]) pos[b.name].mobs = list
        for (const m of list) mobInfo[`mob${m.id}`] = m
      }).catch(() => {})
    }
  }, 1000) : null
  // Сторож зависаний (10.10: «подвисают, ничего не делая — фармлю их»): живой боец 8 с на месте, рядом (3 бл.) нет
  // врага и он не ждёт нарочно (сбор, хилка) — в журнал, чем занят (последний вызов демона и сколько длится), и стоп:
  // цикл бойца выберет дело заново.
  // Работа на месте (копка, прокоп, кладка, коробка, лестница, динамит) — не зависание в пределах своего бюджета: сброс через
  // 6 с рвал прокоп и добычу посреди блока (арены 36–40: десятки «🧊 стоит 6 с — dig_to/mine — сброс»).
  const frozenT = setInterval(() => {
    if (ctx.between) return
    for (const b of bots) {
      const m = pos[b.name]
      if (m?.p) {
        b.badSpots = (b.badSpots || []).filter(s => !s.from || s.round === ctx.round && dist3(s.from, m.p) < 2).slice(-32)
        if (b.frozen && (b.frozen.round !== ctx.round || dist3(b.frozen.p, m.p) >= 2)) delete b.frozen
      }
      // Стойка на месте (засада кемпера, кольцо щитов, оцепление) — её дело и есть стоять (кемпер в коробке: «стоит 6 с — сброс»).
      // (на месте: по дороге к засаде сторож нужен — зависший поход иначе не сбрасывался; Codex 15.10)
      if (!m?.p || !ctx.alive(b.name) || b.waiting || b.climbing || b.swarmReserved || b.swarmTask?.data?.hold && b.swarmTask.position && dist3(b.swarmTask.position, m.p) < 1.5 || b.swarmExecuting && (b.swarmBusyUntil || ctx.swarmDriver?.holding?.(b)) || busy.has(b.name) || (b.last?.m === 'craft' && b.last.pending) || (/^(mine|dig_to|swarm_work|box_in|box_out|ladder_up|tnt_at)$/.test(b.last?.m || '') && Date.now() - b.last.at < ((b.last.p?.timeoutSeconds ?? 12) + 2) * 1000)) { b.anchor = null; continue }
      // A delayed status or paused native physics is not evidence that a route is physically stuck.
      if (!Number.isFinite(m.observedAt) || !Number.isFinite(m.frameAt) || Date.now() - Math.min(m.observedAt, m.frameAt) > 5000) { b.anchor = null; continue }
      if (!b.anchor || dist3(b.anchor.p, m.p) > 1) { b.anchor = { p: { ...m.p }, at: Date.now() }; continue }
      // Свежий бой не наследует неподвижность прежнего похода (Codex 15.10: «стоит 20 с — fight (0 с) — сброс» → 0/0 cancelled).
      const still = Date.now() - (b.last?.m === 'fight' ? Math.max(b.anchor.at, b.last.at) : b.anchor.at)
      // Поход ещё считает путь (до 4 с в Колизее при 30 ботах) — до конца его времени не сбрасывать.
      if (b.last?.m === 'goto' && Date.now() - b.last.at < ((b.last.p?.timeoutSeconds || 10) + 2) * 1000) continue
      if (b.last?.m === 'chest_take' && Date.now() - b.last.at < (Math.min(45, b.last.p?.timeoutSeconds ?? 45) + 4) * 1000) continue
      if (b.last?.m === 'assist' && b.last.p?.mode === 'pickup' && Date.now() - b.last.at < 10000) continue
      // Стойка роя (щит, засада, оцепление, ожидание у стройки) стоит нарочно: сброс рвал её 36 раз за 2.5 мин (арена 14.10).
      if (b.last?.m === 'swarm_hold' && Date.now() - b.last.at < ((b.last.p?.timeoutSeconds ?? 2) + 2) * 1000) continue
      // The old frozen anchor predates a fresh escape; allow its first movement sample.
      if (/^(flee|evade|juke)$/.test(b.last?.m || '') && Date.now() - b.last.at < Math.min(5, (b.last.p?.timeoutSeconds ?? 3) + 2) * 1000) continue
      // Враг вплотную, а я стою и не в бою — это хуже всего (10.10: «стоит рядом, не атакует, я ваншочу»): 3 с; иначе 5 с.
      const near = ctx.enemiesOf(b, m.p).some(e => e.d < 3)
      if ((near && b.last?.m === 'fight') || still < (b.last?.m === 'fight' ? 8000 : near ? 3000 : 5000)) continue
      const L0 = b.last || {}
      const goal = L0.p?.at || L0.p?.to || L0.p
      // Отказ конкретного подхода: снимается сменой стойки/раунда, а не ожиданием; читатель — swarm-driver (1b).
      if (goal && Number.isFinite(goal.x) && !(b.badSpots || []).some(s => dist3(s, goal) < 1)) (b.badSpots ||= []).push({ x: goal.x, y: goal.y, z: goal.z, from: { ...m.p }, round: ctx.round })
      log(`🧊 ${b.name} стоит ${Math.round(still / 1000)} с — ${L0.m || '?'} ${L0.p?.item || L0.p?.target || L0.p?.mode || ''} (${L0.at ? Math.round((Date.now() - L0.at) / 1000) + ' с' : ''}) — сброс`)
      // Застрял наверху (крыша камеры, уступ галереи: спуск 6+ без воды pathfinder не планирует) — спрыгнуть.
      // Человек высоко (соло, 12.10: «поднимаются ко мне и встают» — спрыгивали и телепортировались на старт): наверху — охота, не застревание.
      if (m.p.y > Y + 3 && !(SOLO && Object.values(humans).some((h: any) => h.p && h.p.y > Y + 6))) b.needDrop = true
      // Шёл выше (галерея, ярус) и встал — подбросить себя зарядом ветра (10.10), если есть.
      else if (goal && Number.isFinite(goal.y) && goal.y - m.p.y >= 3 && (m.inv || {}).wind_charge) b.needLift = { x: goal.x, z: goal.z }
      // Второй сброс на том же месте (2 бл.) — путь отсюда не строится (желоб у края поля с дном из плачущего обсидиана:
      // «застрял на air у air», 31i 22 сброса за 196 с, 15.10): выбраться простыми шагами — dig_to к цели (прыжок, подкоп, блок).
      b.frozen = b.frozen && dist3(b.frozen.p, m.p) < 2 ? { ...b.frozen, n: b.frozen.n + 1 } : { p: { ...m.p }, round: ctx.round, n: 1 }
      const to = goal && Number.isFinite(goal.x) && Number.isFinite(goal.z) ? goal : { x: X + .5, y: Y, z: Z + .5 }
      const recovery = JSON.stringify([to.x, to.y, to.z, Object.keys(m.inv || {}).filter(n => /_(pickaxe|shovel|axe)$/.test(n)).sort()])
      const action = b.last, round = ctx.round
      if (b.frozen.n >= 2 && b.frozen.recovery !== recovery) b.c.call('stop').catch(() => {}).then(() => {
        if (ctx.between || ctx.round !== round || b.last !== action || busy.has(b.name) || !ctx.alive(b.name)) return
        b.frozen.recovery = recovery
        return b.c.call('dig_to', { at: { x: to.x, y: Number.isFinite(to.y) ? to.y : m.p.y, z: to.z }, maxSteps: 4, timeoutSeconds: 6 })
      })
        .then(r => {
          if (ctx.round !== round || !r) return
          const d = r?.detail || r || {}
          if ((d.steps > 0 || d.dug > 0) && b.frozen?.recovery === recovery) delete b.frozen.recovery
          log(`🧊 ${b.name}: выбираюсь шагами — ${d.steps ?? 0} шаг., ${d.dug ?? 0} бл.${d.why ? ' (' + String(d.why).slice(0, 50) + ')' : ''}`)
        }).catch(() => {})
      else b.c.call('stop').catch(() => {})
      b.anchor = { p: { ...m.p }, at: Date.now() }
    }
  }, 2000)
  // Позиции всех — раз в секунду (цель — ближайший живой).
  const statusPolling = new Set<string>()
  const poll = setInterval(() => {
    if (ctx.between) return
    const observedRound = ctx.round
    ctx.readDeaths()
    if (fs.existsSync(STOPF)) ctx.stop = true
    // Ход — по смещению за секунду (б/т); «ранен» — его хп упало (вспышка удара, видна глазами), в решения хп не идёт.
    for (const b of bots) {
      if (statusPolling.has(b.name)) continue
      statusPolling.add(b.name)
      // Наблюдение не старше запроса: демон снимает его, когда отвечает, — время приёма делало его свежее, чем оно есть
      // (под нагрузкой ответ идёт сотни мс; ревью 14.10).
      const asked = Date.now()
      b.c.call('status', {
      swarm: true, dangers: arms,
      swarmAllies: teams ? bots.filter(o => o.team === b.team).map(o => o.name) : []
    }).then(s => {
      if (ctx.between || ctx.round !== observedRound || !s?.state?.pos) return
      const was = pos[b.name]; const p = s.state.pos
      // Зелья (12.10: «кидаю зелья — стоят со щитом и помирают; видно же, что я взял зелье»): щит брызги не держит. Летит
      // вредное (или неизвестное) и ляжет в 4.5 бл. — рывок на 5 бл. от точки падения; у врага взрывное вредное в руке, а
      // свой стоит вплотную (≤ 2.5 бл.) — разойтись на 4, чтобы одно зелье не накрыло двоих.
      const dz = s.detail?.dangers
      if (dz && ctx.alive(b.name) && !out.has(b.name)) {
        const holder = (dz.holders || []).find(hd => teams ? teamOf(hd.name) !== b.team && !(rel[b.team][hd.name] > 0) : true)
        const mate = holder && names.find(n => n !== b.name && teamOf(n) === b.team && ctx.alive(n) && pos[n]?.p && Math.hypot(pos[n].p.x - p.x, pos[n].p.z - p.z) <= 2.5)
        const old = spreading.get(b)
        if (!holder || old && (!pos[old.mate]?.p || dist3(pos[old.mate].p, p) >= 4)) spreading.delete(b)
        if (mate && !busy.has(b.name) && !(b.last?.pending !== false && /^(evade|juke|flee)$/.test(b.last?.m || '')) && (!spreading.has(b) || old.round !== ctx.round || old.holder !== holder.name || old.mate !== mate || old.action !== b.last)) {
          spreading.set(b, { round: ctx.round, holder: holder.name, mate, action: b.last })
          log(`🧪↔ ${b.name}: у ${holder.name} зелье в руке, рядом ${mate} — расходимся`); ctx.dodgeAway(b, p, pos[mate].p, 4, null, { x: holder.at.x, y: holder.at.y + 1.6, z: holder.at.z })
        }
      }
      // Игровые тики (clock.ticks): на ускоренном сервере секунда стены — десятки игровых.
      const tick = s.state.clock?.ticks ?? 0
      const dt = was && was.p && tick > was.tick ? tick - was.tick : 0
      const v = dt ? { x: (p.x - was.p.x) / dt, y: (p.y - was.p.y) / dt, z: (p.z - was.p.z) / dt } : { x: 0, y: 0, z: 0 }
      // «Ранен» — только рядом с противником (≤ 8 бл.): своя посадка и удар о землю — не повод его добивать.
      const foeNear = (s.detail?.sightings || []).some(e => e.id !== b.name && teamOf(e.id) !== b.team && dist3(e.position, p) <= 8)
      const hurtTick = was && s.state.health < was.hp && foeNear ? tick : (was ? was.hurtTick : 0)
      if (was && teams) {
        const visibleHumans = (s.detail?.sightings || []).filter(e => !names.includes(e.id))
        const hNear = visibleHumans.filter(e => dist3(e.position, p) <= 4.5).map(e => e.id)
        const botFoeNear = (s.detail?.sightings || []).some(e => names.includes(e.id) && teamOf(e.id) !== b.team && dist3(e.position, p) <= 4.5)
        // Свой человек (ARMS_HUMAN_TEAM, огонь по своим выключен) ранить не может — урон рядом с ним не его (10.10: стрелы, падение
        // и взрывы записывались ему — «враг: красные все на него», и свои стреляли в него).
        if (hNear.length && s.state.health < was.hp - 0.5 && !botFoeNear && !(HUMAN_TEAM && b.team === HUMAN_TEAM)) ctx.relSay(b.team, hNear[0], -3, `ударил ${b.name}`)
        const cnt = (inv) => Object.values(inv || {}).reduce((a: number, n: any) => a + (Number(n) || 0), 0) as number
        const nearChest = arms && L.chests.some(c => Math.hypot(X + c.x - p.x, Y + c.y - p.y, Z + c.z - p.z) < 4)
        const gNear = visibleHumans.filter(e => dist3(e.position, p) <= 8).map(e => e.id)
        if (gNear.length && cnt(s.state.inventory) > cnt(was.inv) && !nearChest && !Object.keys(deathAt).some(k => deathAt[k].p && Math.hypot(deathAt[k].p.x - p.x, deathAt[k].p.z - p.z) < 6)) {
          const got = Object.entries(s.state.inventory || {}).filter(([n, c]: any) => c > ((was.inv || {})[n] || 0)).map(([n, c]: any) => [n, c - ((was.inv || {})[n] || 0)]) as [string, number][]
          const value = got.reduce((a, [n, c]) => a + worthOf(n) * (worthOf(n) >= 1 ? 1 : c), 0)
          log(`🎁 ${b.name} принял от ${gNear[0]}: ${got.map(([n, c]) => n + '×' + c).join(', ')} — ценность ${value.toFixed(1)}`)
          if (value >= 1) { ctx.relSay(b.team, gNear[0], Math.min(10, Math.round(value) + 1), `подарил ${b.name} ${got.map(([n]) => n).join(', ')}`); ctx.emote(b, 'crouch', ctx.eyeOf(gNear[0])).then(() => ctx.emote(b, 'wave')) }
        }
        const hHeal = visibleHumans.filter(e => dist3(e.position, p) <= 6).map(e => e.id)
        if (hHeal.length && s.state.health > was.hp + 3) ctx.relSay(b.team, hHeal[0], 2, `вылечил ${b.name}`)
      }
      const now = Date.now(), frame = s.state.physicsTicks ?? tick, clockId = s.state.clock?.id
      const frameAt = was?.frame === frame && was?.clockId === clockId ? (was.frameAt ?? now) : now
      pos[b.name] = { p, v, hp: s.state.health, hurtTick, tick, frame, clockId, frameAt, observedAt: now, tactics: s.state.tactics, pots: (s.state.inventory || {}).splash_potion || 0, inv: s.state.inventory || {}, armor: s.state.armor || {}, offHand: s.state.offHand || null, potions: s.state.potions || {}, enchants: s.detail?.ownEnchants || [], labNeed: labNeed[b.name] || [], water: !!s.detail?.water }
      if (dz) b.c.onDanger?.({ pos: p, dangers: dz, observedAt: asked, status: true })
      ctx.swarmDriver.observe(b, s.detail?.sightings || [], asked)
      const panic = ctx.swarmDriver.panic(b), oldPanic = panicStops.get(b)
      if (!panic) panicStops.delete(b)
      if (!ctx.between && ctx.alive(b.name) && !/^(flee|evade|juke)$/.test(b.last?.m || '') && b.swarmTask?.kind !== 'flee' && panic && (!oldPanic || oldPanic.round !== ctx.round || oldPanic.action !== b.last)) {
        panicStops.set(b, { round: ctx.round, action: b.last })
        ctx.swarmDriver.release(b)
        b.c.call('stop').catch(() => {})
      }
    }).catch(() => {}).finally(() => statusPolling.delete(b.name))
    }
  }, Number(process.env.FFA_POLL_MS || 250))
  return { mobPollT, frozenT, poll }
}

// Дроп, стрелы, опыт — раз в 30 с по габариту Колизея (вещи копились и тормозили игру). Ракеты и трезубцы в
// полёте не трогаем: ракета держит разгон элитр.
export function watchBoard (ctx: ArenaContext) {
  const { i, arms, BOX, rcon, log } = ctx
  return setInterval(() => {
    log('счёт (убил/умер) ' + ctx.board())
    fs.writeFileSync(path.join(ROOT, 'farm', `swarm-${i}.json`), JSON.stringify(ctx.swarmDriver.snapshot(), null, 2))
    for (const t of arms ? ['arrow', 'experience_orb'] : ['item', 'arrow', 'experience_orb']) rcon(i, `kill @e[type=${t},${BOX}]`).catch(() => {})
  }, 30000)
}
