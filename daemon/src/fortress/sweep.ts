'use strict'
import * as gameClock from '../game-clock'
import { xyz } from '../movement'
import * as worlds from '../worlds'
import { PLACE, DIRS, WORDS, log, BASTION_KEYS_ALL, bastionSpentNear, highLook, placeOf, openDirections, rayClear } from './look'
import { legTo, keepBlocks, goldOnTheWay, woodOnTheWay, climbWalk } from './legs'

// ND_BLZ_OPEN_LEGS=1 (blz 21.10): отрезок луча — по открытому, а не прямо сквозь толщу. Поиск крепости съедал 600–900 взмахов за 10–25
// мин (pathfinder в сплошном незераке — 2.5 копки на блок хода: 580 сбросов пути «block_updated» в bzP2-s18-1), а спидраннер идёт пещерами
// и по берегам. Лучи от глаз в ±0/30/60° от направления прямой и на 0/±15° по высоте: самый длинный чистый (с весом cos отклонения), от 8 бл.
// — цель отрезка (до 20 бл. по нему); короче 8 везде — прямо, как прежде. Прогресс прямой — по проекции на её ось.
function openLeg (bot, dx, dz, reach = 32) {
  const Vec3: typeof import('vec3').Vec3 = require('vec3')
  const eye = (require('../pick') as typeof import('../pick')).eyeOf(bot)
  const base = Math.atan2(dz, dx)
  let best = null
  for (const off of [0, -30, 30, -60, 60]) for (const pitch of [0, -15, 15]) {
    const a = base + off * Math.PI / 180, p = pitch * Math.PI / 180
    const dir = new Vec3(Math.cos(a) * Math.cos(p), Math.sin(p), Math.sin(a) * Math.cos(p))
    const d = rayClear(bot, eye, dir, reach)
    const score = d * Math.cos(off * Math.PI / 180) - Math.abs(pitch) * 0.1
    if (!best || score > best.score) best = { score, d, off, pitch, dir }
  }
  if (!best || best.d < 8) return null
  const L = Math.min(best.d - 1.5, 20)
  return { x: Math.round(eye.x + best.dir.x * L), z: Math.round(eye.z + best.dir.z * L), clear: Math.round(best.d), off: best.off, pitch: best.pitch }
}

// Прямая по направлению отрезками по 16 блоков, взгляд после каждого, пока
// кирпич не увиден или не кончились maxWalk/время. start и along — откуда
// считать отрезки. stopWhen(v) — когда взгляд кончает прямую (по умолчанию — кирпич крепости или бастион).
async function walkLine (session, ctl, { start, dirName, along = 0, maxWalk, deadline, glance, legs, onStep = null, stopWhen = null, resume = null, onProgress = null, pie = null, blindMax = 2, deltasOk = false, openLegs = false }: any) {
  const bot = session.bot
  const [dx, dz] = DIRS[dirName]
  along = resume?.along ?? along
  let side = resume?.side ?? 0
  let fails = resume?.fails ?? 0
  let v: any = { seen: 0 }
  let stopped = null
  let blocked = false
  let blindLegs = resume?.blind ?? 0
  while (!ctl.aborted && gameClock.now() < deadline && along < maxWalk) {
    const step = 16
    const me = bot.entity.position
    // Цель — впереди по направлению, со сдвигом вбок, если прямо не пройти.
    let tx = Math.round(start.x + dx * (along + step) + (dz !== 0 ? side : 0))
    let tz = Math.round(start.z + dz * (along + step) + (dx !== 0 ? side : 0))
    const open = openLegs && !side ? openLeg(bot, dx, dz) : null
    const me0 = bot.entity.position.clone()
    if (open) { tx = open.x; tz = open.z }
    await keepBlocks(session, ctl)
    const biomeHere = () => { try { return String((require('../perception') as typeof import('../perception')).biomeName(bot, bot.entity.position.floored()) || '') } catch { return '' } }
    const inDelta0 = bot._ndAvoidDeltas ? /basalt_deltas/.test(biomeHere()) : false
    const w = await legTo(session, ctl, tx, tz, deadline, { onOpen: glance, stop: stopWhen || (x => !!(x && (x.seen || x.bastion))) })
    legs.push({ to: { x: tx, z: tz }, ...(open ? { open: { clear: open.clear, off: open.off, pitch: open.pitch } } : {}), ok: w.ok, down: w.down, bored: w.bored, covered: w.covered, fought: w.fought, error: w.ok ? undefined : w.error, from: xyz(me) })
    if (ctl.aborted) { stopped = 'прервано'; break }
    // Поиск бастиона: базальтовые дельты (биом под ногами, F3) — бастионов там не бывает (bastion_remnant: все биомы Ада, кроме
    // дельт), а магмовые кубы и гасты в базальте убивали (b0-7-1 14.10: хп 20 → 1 за 2 с) — направление закрыто. Только вход в
    // дельты: из дельт, где уже стоим, отрезки выводят (b6-6-1 14.10: стоял в дельтах — каждый вызов «не иду» за 0 с).
    // ND_NE_DELTA_PASS=1 (blz 21.10, координатор: 5730 — бастион TREASURE в 66 бл. к Ю от портала за дельтами, поиск ни разу не пошёл
    // на юг): бастиона нет в самих дельтах, но он бывает за ними — одно пересечение дельт за вызов при хп ≥ 16 (кубы теперь видны,
    // ND_SLIME_SIZE), дальше по-старому.
    const deltaPass = process.env.ND_NE_DELTA_PASS === '1' && (bot.health ?? 0) >= 16 && (bot._ndDeltaPasses || 0) < 1
    if (bot._ndAvoidDeltas && !inDelta0 && !deltasOk && process.env.ND_NE_DELTAS !== '0' && deltaPass && /basalt_deltas/.test(biomeHere())) {
      bot._ndDeltaPasses = (bot._ndDeltaPasses || 0) + 1
      log('дельты: прохожу один раз — бастион бывает за ними', { dir: dirName, at: xyz(bot.entity.position), hp: Math.round(bot.health ?? 0) })
    } else if (bot._ndAvoidDeltas && !inDelta0 && !deltasOk && process.env.ND_NE_DELTAS !== '0') {
      if (/basalt_deltas/.test(biomeHere())) {
        ;(bot._ndDeltaSeen ||= []).push(xyz(bot.entity.position))
        stopped = `на ${WORDS[dirName]} базальтовые дельты — колонны над лавой и магмовые кубы (бастиона там не бывает), не иду`
        blocked = true
        if (resume) Object.assign(resume, { along, side, fails, blocked })
        break
      }
    }
    await goldOnTheWay(session, ctl)
    if (ctl.aborted) { stopped = 'прервано'; break }
    await woodOnTheWay(session, ctl)
    if (w.fought) {
      // Отбился — тот же отрезок заново; не отбился и хп мало — стоп.
      if ((bot.health ?? 0) < 8) { stopped = w.error + `, хп ${Math.round(bot.health ?? 0)} — дальше не иду`; break }
    } else if (w.ok || open && ((bot.entity.position.x - me0.x) * dx + (bot.entity.position.z - me0.z) * dz) >= 4) {
      // По открытому отрезку — вдоль оси засчитано столько, сколько тело реально продвинулось по ней.
      along = open ? Math.max(along, Math.round((bot.entity.position.x - start.x) * dx + (bot.entity.position.z - start.z) * dz)) : along + step
      side = 0
      if (onStep) onStep(along)
    } else if (Math.abs(side) < 24 && ++fails <= 6) {
      // Прямо не прошёл (лавовое озеро, обрыв) — то же расстояние, но вбок.
      side = side <= 0 ? -side + 8 : -side
    } else {
      stopped = `на ${WORDS[dirName]} дороги нет ни прямо, ни в стороны на 24 блока: ${w.error}`
      blocked = true
    }
    // ND_BLZ_BLIND_LEGS=1 (blz 21.10): отрезок кончился в толще (из 8 лучей обзора дальше 6 бл. — меньше трёх: свой штрек назад — один)
    // — из штрека не видно ничего, а кирки уходят: два таких подряд — прямая закрыта, обход берёт следующую точку (bzC1-s17-2: 8 отрезков
    // штреком на север от портала, 455 незерака, «кирпича не видно» — кирка съедена за 5 мин, крепость была на юге).
    if (process.env.ND_BLZ_BLIND_LEGS === '1' && !blocked) {
      const enclosed = openDirections(bot).filter(o => o.clear >= 6).length < 3
      blindLegs = enclosed ? blindLegs + 1 : 0
      if (resume) resume.blind = blindLegs
      if (blindLegs >= blindMax) { stopped = `на ${WORDS[dirName]} ${blindMax} отрезка в толще — из штрека не видно, не копаю вслепую`; blocked = true }
    }
    if (resume) { Object.assign(resume, { along, side, fails, blocked }); onProgress?.() }
    if (blocked) break
    // Из устья закрытого штрека уже видно постройку — это и есть взгляд отрезка (из замкнутого штрека потом не видно ничего).
    v = w.view && (stopWhen ? stopWhen(w.view) : (w.view.seen || w.view.bastion)) ? w.view : await glance()
    if (pie && !(stopWhen ? stopWhen(v) : (v.seen || v.bastion))) v = (await pieLead(session, ctl, { type: pie, deadline, glance, legs, hit: stopWhen || (x => !!(x && (x.seen || x.bastion))) })) || v
    if (stopWhen ? stopWhen(v) : (v.seen || v.bastion)) break
  }
  if (!v.seen && !stopped) stopped = ctl.aborted ? 'прервано' : (along >= maxWalk ? `прошёл ${along} блоков на ${WORDS[dirName]} — кирпича не видно` : 'время вышло')
  return { v, along, stopped, blocked }
}

// «Пирог» F3 (AGENTS.md: есть ли рядом в прорисованных чанках сундуки или спавнер — без клетки, место ищется ходом): из закрытого
// штрека постройку не видно, а пирог её чует — у бастиона сундуков много (chest ≥ 2: у руин портала один), у крепости спавнер.
// Пеленг дуги — отрезок 20 бл. к нему (legTo, устья — взгляд), снова пеленг, до 5 раз или до находки (hit).
async function pieLead (session, ctl, { type, deadline, glance, legs, hit }) {
  const S: typeof import('../perception/senses') = require('../perception/senses')
  const bot = session.bot
  let v = null
  // A1: only counts and bearings from loaded chunks; no spawner coordinates.
  // «Пирог» видит спавнер только в дальности отрисовки блок-сущностей клиента (BlockEntityRenderer.getViewDistance = 64, у спавнера
  // своей нет) — 64, а не 128 (дальность прогрузки чанков фермы): дальше пирог спавнера не показывает.
  const range = 64
  for (let k = 0; k < 5 && !ctl.aborted && gameClock.now() < deadline; k++) {
    const p = S.pie(bot, { range })
    const n = (p && p.byType && p.byType[type]) || 0
    if (n < (type === 'chest' ? 2 : 1)) break
    if (type === 'spawner' && process.env.ND_BLZ_PIE_FIRST === '1') {
      await keepBlocks(session, ctl)
      if (ctl.aborted || gameClock.now() >= deadline) break
    }
    // Сундуки уже выработанного бастиона рядом — не постройка для поиска (gb1-5-1: «пирог» 11 сундуков повёл обратно в тот же
    // бастион, к бруту).
    if (type === 'chest' && bastionSpentNear(session, bot.entity.position)) break
    if (type === 'chest' && n >= 4 && process.env.ND_BASTION_PIE_SEEK === '1') {
      // legTo can report partial progress; take short legs until the actual baseline/approach is reached.
      const move = async (x, z, until) => {
        while (!ctl.aborted && gameClock.now() < until && !hit(v)) {
          const p = bot.entity.position
          const d = Math.hypot(x - p.x, z - p.z)
          if (d <= 3) return { ok: true }
          const k = Math.min(16, d) / d
          const tx = Math.round(p.x + (x - p.x) * k), tz = Math.round(p.z + (z - p.z) * k)
          const w = await legTo(session, ctl, tx, tz, until, { onOpen: glance, stop: hit })
          legs.push({ to: { x: tx, z: tz }, at: xyz(bot.entity.position), pieSeek: true, ok: !!w.ok, covered: w.covered, error: w.error })
          if (w.view && hit(w.view)) { v = w.view; return { ok: true } }
          if (ctl.aborted || gameClock.now() >= until) return { ok: false, error: ctl.aborted ? 'прервано' : 'время вышло' }
          v = await glance()
          if (hit(v)) return { ok: true }
          if (!w.ok || d - Math.hypot(x - bot.entity.position.x, z - bot.entity.position.z) < 1) return { ok: false, error: w.error || 'пирог: нет продвижения' }
        }
        return { ok: hit(v), error: ctl.aborted ? 'прервано' : 'время вышло' }
      }
      const r = await S.pieSeek(session, ctl, { type, base: 24, near: 24, timeoutSeconds: 120, until: deadline, move, stop: () => hit(v) })
      log('пирог: две точки', { n, ...r, at: xyz(bot.entity.position) })
      if (!ctl.aborted && gameClock.now() < deadline && !hit(v)) {
        v = await glance()
        // Estimate is only a cue; only a visible bastion ends the search. Keep existing tower safety checks.
        if (!ctl.aborted && gameClock.now() < deadline && !hit(v) && r.found && r.dist <= 27) {
          const h = await highLook(session, ctl, glance, { up: 12 })
          log('пирог: взгляд с вышки', { ...h, v: undefined })
          if (h.v) v = h.v
        }
      }
      return v
    }
    const arc = S.pieArcs(bot, type, { range, fov: 30 })[0]
    if (!arc || arc.center === null) break
    const d = S.vecOf(arc.center)
    const me = bot.entity.position
    const w = await legTo(session, ctl, Math.round(me.x + d.x * 20), Math.round(me.z + d.z * 20), deadline, { onOpen: glance, stop: hit })
    legs.push({ ok: !!w.ok, at: xyz(bot.entity.position), pie: { type, n, yaw: arc.center }, covered: w.covered, error: w.ok ? undefined : w.error })
    log('пирог: к постройке', { type, n, yaw: arc.center, ok: !!w.ok, at: xyz(bot.entity.position) })
    v = w.view && hit(w.view) ? w.view : await glance()
    if (hit(v) || !w.ok) break
  }
  return v
}

// Поиск по регионам nether_complexes (байткод paper-1.21.11,
// RandomSpreadStructurePlacement.getPotentialStructureChunk): стартовый чанк
// постройки = floorDiv(чанк, 27)·27 + nextInt(27 − 4), то есть в каждом
// регионе 432x432 ровно одна постройка, и её старт лежит в квадрате 368x368 у
// северо-западного угла региона (23 чанка). Куски крепости — до 112 блоков от
// старта (NetherBridgePiece: bipush 112). Поэтому поиск — «газонокосилкой» по
// этому квадрату: три полосы вдоль X (совет спидраннеров — идти по X) на
// z0+48, z0+176, z0+304: взгляд в 64 блока покрывает квадрат целиком. Регион
// пройден (или в нём виден бастион — тогда крепости в нём нет) — соседний,
// ближайший к порталу Ада. План — в памяти (fortressSearch): следующий вызов
// продолжает с той же точки. Отрезок закрыт (лава во всю ширину) — следующая
// точка от того места, где тело стоит.
const REGION = 432
const ZONE = 23 * 16
const STRIPES = [48, 176, 304]
function regionOf (x, z) { return [Math.floor(x / REGION), Math.floor(z / REGION)] }
const same = (a, b) => a[0] === b[0] && a[1] === b[1]
/** S1f: регионы nether_complexes с увиденным бастионом (места памяти Ада) — без повторов; там крепости нет. */
function bastionRegions (places) {
  const out = []
  for (const k of BASTION_KEYS_ALL) {
    const r = places[k]
    if (!r || !Number.isFinite(r.x) || worlds.worldOfRecord(r) !== 'the_nether') continue
    const g = regionOf(r.x, r.z)
    if (!out.some(q => q[0] === g[0] && q[1] === g[1])) out.push(g)
  }
  return out
}
function stripesOf (rx, rz, me) {
  const x0 = rx * REGION - 16
  const x1 = rx * REGION + ZONE + 16
  let rows = STRIPES.map(o => rz * REGION + o)
  // Ближняя полоса первой, ближний край первым — змейкой.
  if (Math.abs(me.z - rows[2]) < Math.abs(me.z - rows[0])) rows = rows.reverse()
  let west = Math.abs(me.x - x0) <= Math.abs(me.x - x1)
  const wps = []
  for (const z of rows) {
    wps.push(west ? { x: x0, z } : { x: x1, z }, west ? { x: x1, z } : { x: x0, z })
    west = !west
  }
  return wps
}
// Соседи по кольцам вокруг региона портала, ближние первыми.
function nextRegion (plan) {
  const [ox, oz] = regionOf(plan.origin.x, plan.origin.z)
  const done = new Set(plan.done.map(r => r.join(',')))
  for (let ring = 1; ring <= 3; ring++) {
    const cand = []
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dz = -ring; dz <= ring; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue
        const r = [ox + dx, oz + dz]
        if (!done.has(r.join(','))) cand.push(r)
      }
    }
    if (cand.length) {
      const c = [(0.5) * REGION, (0.5) * REGION]
      cand.sort((a, b) => Math.hypot(a[0] * REGION + c[0] - plan.origin.x, a[1] * REGION + c[1] - plan.origin.z) -
        Math.hypot(b[0] * REGION + c[0] - plan.origin.x, b[1] * REGION + c[1] - plan.origin.z))
      return cand[0]
    }
  }
  return null
}

// ND_BLZ_AXES: регионов у луча оси (по обе стороны его середины, ±64), где крепость ещё возможна (не регион увиденного бастиона).
function axisScoreOf (p, origin, skip) {
  const mid = { x: origin.x + p.ax * p.R / 2, z: origin.z + p.az * p.R / 2 }
  const sides = [regionOf(mid.x + p.az * 64, mid.z + p.ax * 64), regionOf(mid.x - p.az * 64, mid.z - p.ax * 64)]
  return sides.filter((r, k) => sides.findIndex(q => same(q, r)) === k && !skip.some(q => same(q, r))).length
}

// До точки по прямым: сначала по оси, где дальше, потом по другой — отрезками
// по 16 со взглядом после каждого (walkLine).
async function walkTo (session, ctl, to, { deadline, glance, legs, stopWhen = null, resume = {}, onProgress = null, pie = null, blindMax = 2, deltasOk = false, openLegs = false }: any) {
  const bot = session.bot
  let v: any = { seen: 0 }
  let stopped = null
  // Ось закрыта (лава, обрыв) — другая ось, потом снова первая: полосу в 128
  // блоков можно пройти и на 40 блоков севернее — взгляд в 64 её покроет
  // (прогон 8: юг с z=263 закрыт, и вся последняя полоса ушла в «пройдено»).
  const target = `${to.x},${to.z}`
  if (resume.to !== target) { resume.to = target; resume.closed = []; delete resume.line }
  const closed = new Set(resume.closed || [])
  for (let turn = 0; turn < 6 && !ctl.aborted && gameClock.now() < deadline; turn++) {
    const me = bot.entity.position
    const dx = to.x - me.x
    const dz = to.z - me.z
    if (Math.abs(dx) <= 8 && Math.abs(dz) <= 8) { stopped = null; break }
    const axes = (Math.abs(dx) >= Math.abs(dz) ? ['x', 'z'] : ['z', 'x'])
      .filter(a => Math.abs(a === 'x' ? dx : dz) > 8 && !closed.has(a))
    if (!axes.length) break
    const ax = axes.includes(resume.line?.axis) ? resume.line.axis : axes[0]
    if (resume.line?.axis !== ax) delete resume.line
    // A failed path plus bore can use the whole call. Resume the remaining
    // detours next time; a timeout does not mean this area was explored.
    const line = resume.line ||= {
      axis: ax, dirName: ax === 'x' ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north'),
      start: { x: Math.round(me.x), z: Math.round(me.z) }, maxWalk: Math.max(16, Math.round(Math.abs(ax === 'x' ? dx : dz) / 16) * 16)
    }
    const r = await walkLine(session, ctl, {
      start: line.start,
      dirName: line.dirName,
      along: 0,
      maxWalk: line.maxWalk,
      deadline,
      glance,
      legs,
      stopWhen,
      resume: line,
      onProgress,
      pie,
      blindMax,
      deltasOk,
      openLegs
    })
    v = r.v
    if (stopWhen ? stopWhen(v) : (v.seen || v.bastion)) { stopped = null; break }
    stopped = r.stopped
    if (r.blocked) {
      closed.add(ax)
      delete resume.line
    } else if (r.along >= line.maxWalk) {
      // Прошёл по оси — закрытая раньше может открыться с нового места.
      closed.clear()
      delete resume.line
    }
    resume.closed = [...closed]
    onProgress?.()
    if (ctl.aborted || gameClock.now() >= deadline) break
  }
  return { v, stopped }
}

// want='bastion' — тот же обход регионов, но цель — бастион (fortress mode=bastion): свой план в памяти (bastionSearch),
// регион известной крепости и регионы, пройденные обходом крепости, пропускаются (в регионе одна постройка), стоп —
// когда взгляд увидел бастион; кирпич крепости обход не останавливает.
async function sweep (session, ctl, { deadline, glance, legs, v, want = 'fortress', high = false, rings = [128, 256] }: any) {
  const bot = session.bot
  const forBastion = want === 'bastion'
  const KEY = forBastion ? 'bastionSearch' : 'fortressSearch'
  const hit = forBastion ? (x => !!(x && x.bastion)) : (x => !!(x && x.seen))
  // A1: consult an available F3 cue before paying for the first regional leg.
  if (!forBastion && process.env.ND_BLZ_PIE_FIRST === '1' && !hit(v)) {
    v = await pieLead(session, ctl, { type: 'spawner', deadline, glance, legs, hit }) || v
    if (hit(v)) return { v, stopped: null, plan: null }
  }
  if (forBastion && process.env.ND_BASTION_PIE_SEEK === '1' && !hit(v)) {
    const S: typeof import('../perception/senses') = require('../perception/senses')
    if ((S.pie(bot, { range: 64 })?.byType?.chest || 0) >= 4) {
      v = await pieLead(session, ctl, { type: 'chest', deadline, glance, legs, hit }) || v
      if (hit(v)) return { v, stopped: null, plan: null }
    }
  }
  let plan = session.journal.state && session.journal.state[KEY]
  if (!plan || plan.world !== 'the_nether' || !plan.origin || !plan.region) {
    const portal = placeOf(session, worlds.portalKey('the_nether'))
    const o = portal && worlds.worldOfRecord(portal) === 'the_nether' ? portal : xyz(bot.entity.position)
    const region = regionOf(o.x, o.z)
    plan = { world: 'the_nether', origin: { x: o.x, z: o.z }, region, done: [], wps: stripesOf(region[0], region[1], o), i: 0 }
    // S1f (механика генерации, jar 1.21.11 structure_set/nether_complexes: random_spread spacing 27, separation 4, fortress 2 /
    // bastion_remnant 3 — одна постройка на регион): регион увиденного бастиона крепости не содержит — обход крепости его пропускает.
    if (!forBastion && process.env.ND_REGION_SKIP !== '0' && process.env.ND_BLZ_REGION_HINTS !== '1') {
      plan.done = bastionRegions((session.journal.state && session.journal.state.places) || {})
      if (plan.done.some(r => r[0] === region[0] && r[1] === region[1])) {
        const next = nextRegion(plan)
        if (next) { plan.region = next; plan.wps = stripesOf(next[0], next[1], bot.entity.position) }
      }
    }
    if (forBastion) {
      const skip = []
      const fort = placeOf(session, PLACE)
      if (fort && worlds.worldOfRecord(fort) === 'the_nether') skip.push(regionOf(fort.x, fort.z))
      const fs0 = session.journal.state && session.journal.state.fortressSearch
      if (fs0 && fs0.world === 'the_nether' && Array.isArray(fs0.done)) skip.push(...fs0.done)
      plan.done = skip.filter((r, k) => skip.findIndex(q => q[0] === r[0] && q[1] === r[1]) === k)
      if (plan.done.some(r => r[0] === region[0] && r[1] === region[1])) {
        const next = nextRegion(plan)
        if (next) { plan.region = next; plan.wps = stripesOf(next[0], next[1], bot.entity.position) }
      }
    }
  } else {
    plan = { ...plan, done: [...(plan.done || [])], wps: [...(plan.wps || [])] }
  }
  const save = () => session.journal.patch(s => { s[KEY] = { ...plan } })
  // high: сначала кольца точек обзора вокруг портала (128 и 256 бл., 8 направлений, ближняя первой), на каждой —
  // взгляд с вышки радиусом 128; полосы региона — потом. Полосы одного региона — 1200+ бл. ходьбы (~0.85 бл/с на
  // новых мирах 02.10), а крепость часто в соседнем регионе через границу (портал у z=−2, крепость у z=288).
  // ND_BLZ_AXES=1 (blz 21.10): точки обзора — по осям X/Z от портала (128, потом 256), а не 8 по кругу: портал Ада у 0,0 стоит в углу
  // четырёх регионов nether_complexes (432, одна постройка на регион), и луч вдоль оси идёт по границе двух регионов — видит постройку
  // любого из них; диагональ — одного. Порядок — по числу регионов у луча, где крепость ещё возможна (регион увиденного бастиона —
  // нет), при равенстве — по видимому просвету. Пересчёт перед каждой точкой: бастион, увиденный по пути, снимает свои лучи
  // (5730: бастион 39,38 на юго-востоке, крепость на западе — обход шёл на восток ×3; 5955: бастион 14,31, крепость на северо-востоке).
  const axes = !forBastion && high && process.env.ND_BLZ_AXES === '1'
  if (axes && !plan.rings) {
    let open = openDirections(bot)
    // Прибытие кладёт тело в карман (ne_burrow «в толщу»): изнутри все лучи упираются в 0.5–0.7 бл., просвет и взгляд с вышки — пустые
    // («над головой открыто 0»). Портал рядом — сперва к нему, оттуда просвет.
    const portal = placeOf(session, worlds.portalKey('the_nether'))
    if (open.filter(o => o.clear >= 6).length < 2 && portal && worlds.worldOfRecord(portal) === 'the_nether' &&
        Math.hypot(portal.x - bot.entity.position.x, portal.z - bot.entity.position.z) < 12 && !ctl.aborted) {
      const Vec3: typeof import('vec3').Vec3 = require('vec3')
      const w = await climbWalk(session, ctl, new Vec3(portal.x, portal.y - 1, portal.z), deadline)
      open = openDirections(bot)
      log('оси: из кармана к порталу', { ok: w.ok, at: xyz(bot.entity.position), open: open.filter(o => o.clear >= 6).length })
    }
    const cur = { x: bot.entity.position.x, z: bot.entity.position.z }
    const clear = p => open?.[(Math.round(Math.atan2(p.z - cur.z, p.x - cur.x) * 4 / Math.PI) + 8) % 8]?.clear || 0
    const wps = []
    // Лучи короче колец: коробки крепостей дальних сидов — в 40–92 бл. от портала по оси (правда d1-world: 5730 — 90 на З, 5955 — 84–92 на СВ,
    // 3292 — 50 на С), взгляд с вышки в конце луча 96 их покрывает; 192 — второй круг.
    for (const R of [96, 192]) for (const [ax, az] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      const p = { x: Math.round(plan.origin.x + R * ax), z: Math.round(plan.origin.z + R * az), R, ax, az }
      wps.push({ ...p, clear: Math.round(clear(p) * 100) / 100 })
    }
    plan.rings = { wps, i: 0, axes: true }
    log('оси: точки обзора', { open, wps: wps.slice(0, 4) })
  }
  const axisScore = p => axisScoreOf(p, plan.origin, [...bastionRegions((session.journal.state && session.journal.state.places) || {}),
    ...((session.journal.state && session.journal.state.thronelessRegions) || [])])
  if (high && !plan.rings) {
    const directed = !forBastion && process.env.ND_BLZ_OPEN_RING === '1'
    const open = directed ? openDirections(bot) : null
    const groups = directed ? [...rings].sort((a, b) => a - b).map(r => [r]) : [rings]
    const order = []
    let cur = { x: bot.entity.position.x, z: bot.entity.position.z }
    const horizon = p => open?.[(Math.round(Math.atan2(p.z - cur.z, p.x - cur.x) * 4 / Math.PI) + 8) % 8]?.clear || 0
    for (const radii of groups) {
      const pts = []
      for (const R of radii) for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; pts.push({ x: Math.round(plan.origin.x + R * Math.cos(a)), z: Math.round(plan.origin.z + R * Math.sin(a)) }) }
      while (pts.length) {
        let bi = 0
        for (let i = 1; i < pts.length; i++) {
          const more = open && !order.length ? horizon(pts[i]) - horizon(pts[bi]) : 0
          if (more > 1e-6 || (Math.abs(more) <= 1e-6 && Math.hypot(pts[i].x - cur.x, pts[i].z - cur.z) < Math.hypot(pts[bi].x - cur.x, pts[bi].z - cur.z))) bi = i
        }
        cur = pts.splice(bi, 1)[0]
        order.push(cur)
      }
    }
    if (open) log('кольца: начало по видимому просвету', { open, first: order[0] })
    plan.rings = { wps: order, i: 0 }
  }
  save()
  let stopped = null
  let blocked = 0
  while (high && plan.rings && plan.rings.i < plan.rings.wps.length && !ctl.aborted && gameClock.now() < deadline) {
    if (plan.rings.axes && !plan.walk?.to) {
      // Оставшиеся точки осей: ближнее кольцо, больше возможных регионов у луча, шире просвет, ближе к телу.
      const me = bot.entity.position, rest = plan.rings.wps.slice(plan.rings.i)
      rest.sort((a, b) => a.R - b.R || axisScore(b) - axisScore(a) || b.clear - a.clear || Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z))
      plan.rings.wps.splice(plan.rings.i, rest.length, ...rest)
      log('оси: следующая', { to: rest[0], score: axisScore(rest[0]), rest: rest.length })
    }
    const to = plan.rings.wps[plan.rings.i]
    // Точка кольца в 48 бл. от увиденных дельт — бастиона там нет: следующая.
    if (forBastion && (bot._ndDeltaSeen || []).some(d => Math.hypot(d.x - to.x, d.z - to.z) < (process.env.ND_NE_DELTA_PASS === '1' ? 24 : 48))) { plan.rings.i++; delete plan.walk; save(); continue }
    const r = await walkTo(session, ctl, to, { deadline, glance, legs, stopWhen: hit, resume: plan.walk ||= {}, onProgress: save, pie: forBastion ? 'chest' : 'spawner',
      // ND_BLZ_AXES: луч выбран нарочно — в сплошной толще (5955: «два отрезка в толще» на каждой оси за 1–6 бл.) до 4 отрезков штрека, не 2.
      blindMax: plan.rings.axes ? 4 : 2,
      // ND_BLZ_AXES: дельты на луче — цена (магмовые кубы, колонны над лавой), не запрет, если есть зелье FR: 5730 — крепость за дельтами
      // на западе, лучи З/Ю «базальтовые дельты — не иду» с 16–38 бл. (bzP2-s18-1, 34 мин, БЛОКЕР без кирок).
      deltasOk: !!plan.rings.axes && !!(require('../blaze/potions') as typeof import('../blaze/potions')).drinkable(bot),
      openLegs: !!plan.rings.axes && process.env.ND_BLZ_OPEN_LEGS === '1' })
    v = r.v
    if (hit(v)) { stopped = null; save(); return { v, stopped, plan: { origin: plan.origin, rings: plan.rings.i, of: plan.rings.wps.length } } }
    if (ctl.aborted || gameClock.now() >= deadline) break
    // ND_BLZ_AXES: у точки оси одна ось хода — закрытая прямая (обрыв, лава, два отрезка в толще) бросала луч через 2–5 с (bzM2-s18-1:
    // все 8 точек за 50 с, север к крепости — после 29 бл.). Не дошёл и на половину — та же ось со сдвигом вбок на 32 (сперва в одну
    // сторону, потом в другую), и только потом взгляд и следующий луч.
    if (plan.rings.axes && to.ax !== undefined) {
      const me = bot.entity.position
      const along = (me.x - plan.origin.x) * to.ax + (me.z - plan.origin.z) * to.az
      if (along < to.R - 24 && (to.tries || 0) < 2) {
        to.tries = (to.tries || 0) + 1
        const k = to.tries === 1 ? 1 : -2
        to.x += Math.abs(to.az) * 32 * k; to.z += Math.abs(to.ax) * 32 * k
        log('оси: прямая закрыта — сдвиг вбок', { to, along: Math.round(along), stopped: r.stopped })
        delete plan.walk
        save()
        continue
      }
    }
    const nextLook = plan.rings.wps[plan.rings.i + 1] || plan.wps[plan.i]
    const h = await highLook(session, ctl, glance, { walkBlocks: !forBastion && nextLook ? Math.hypot(nextLook.x - bot.entity.position.x, nextLook.z - bot.entity.position.z) : null })
    log(forBastion ? 'бастион: точка обзора' : 'точка обзора', { i: plan.rings.i, to, at: xyz(bot.entity.position), up: h.up, skipped: h.skipped, seen: h.seen, bastion: h.bastion })
    plan.rings.i++
    delete plan.walk
    save()
    if (h.v && hit(h.v)) { v = h.v; return { v, stopped: null, plan: { origin: plan.origin, rings: plan.rings.i, of: plan.rings.wps.length } } }
  }
  // Бастион виден — пропустить только СВОЙ регион плана: бастион у портала (соседний регион) прежде засчитывал «пройденным» каждый
  // следующий регион за 0 с — 24 региона трёх колец за один вызов, крепость не искалась вовсе (ne01-s13 21.10).
  // A1: a visible template piece can cross a start-region boundary.
  const bastionHere = x => process.env.ND_BLZ_REGION_HINTS !== '1' && !!(x && x.bastion && x.bastion.nearest) && same(regionOf(x.bastion.nearest.x, x.bastion.nearest.z), plan.region)
  while (!ctl.aborted && gameClock.now() < deadline) {
    if (plan.i >= plan.wps.length || (!forBastion && bastionHere(v))) {
      // Регион пройден, или в нём бастион (одна постройка на регион) — дальше.
      plan.done.push(plan.region)
      const next = nextRegion(plan)
      if (!next) { stopped = `обошёл регионы в трёх кольцах вокруг портала — ${forBastion ? 'бастиона' : 'крепости'} не видел`; break }
      plan.region = next
      plan.wps = stripesOf(next[0], next[1], bot.entity.position)
      plan.i = 0
      v = { seen: 0 }
      save()
      if (high) { const to = plan.wps[plan.i]; const h = await highLook(session, ctl, glance, { walkBlocks: !forBastion && to ? Math.hypot(to.x - bot.entity.position.x, to.z - bot.entity.position.z) : null }); if (h.v && hit(h.v)) { v = h.v; stopped = null; break } }
    }
    const to = plan.wps[plan.i]
    const r = await walkTo(session, ctl, to, { deadline, glance, legs, stopWhen: forBastion ? hit : null, resume: plan.walk ||= {}, onProgress: save, pie: forBastion ? 'chest' : 'spawner' })
    v = r.v
    stopped = r.stopped
    if (hit(v)) { stopped = null; break }
    if (ctl.aborted || gameClock.now() >= deadline) break
    if (r.stopped) blocked++
    else blocked = 0
    plan.i++
    delete plan.walk
    save()
    if (blocked >= 4) break
  }
  return {
    v,
    stopped,
    plan: { origin: plan.origin, region: plan.region, regionsDone: plan.done.length, point: plan.i, of: plan.wps.length, next: plan.wps[plan.i] || null }
  }
}

export { walkLine, regionOf, bastionRegions, sweep, axisScoreOf, openLeg }
