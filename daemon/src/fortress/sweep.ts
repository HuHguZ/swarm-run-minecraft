'use strict'
import * as gameClock from '../game-clock'
import { xyz } from '../movement'
import * as worlds from '../worlds'
import { PLACE, DIRS, WORDS, log, BASTION_KEYS_ALL, bastionSpentNear, highLook, placeOf } from './look'
import { legTo, keepBlocks, goldOnTheWay } from './legs'

// Прямая по направлению отрезками по 16 блоков, взгляд после каждого, пока
// кирпич не увиден или не кончились maxWalk/время. start и along — откуда
// считать отрезки. stopWhen(v) — когда взгляд кончает прямую (по умолчанию — кирпич крепости или бастион).
async function walkLine (session, ctl, { start, dirName, along = 0, maxWalk, deadline, glance, legs, onStep = null, stopWhen = null, resume = null, onProgress = null, pie = null }: any) {
  const bot = session.bot
  const [dx, dz] = DIRS[dirName]
  along = resume?.along ?? along
  let side = resume?.side ?? 0
  let fails = resume?.fails ?? 0
  let v: any = { seen: 0 }
  let stopped = null
  let blocked = false
  while (!ctl.aborted && gameClock.now() < deadline && along < maxWalk) {
    const step = 16
    const me = bot.entity.position
    // Цель — впереди по направлению, со сдвигом вбок, если прямо не пройти.
    const tx = Math.round(start.x + dx * (along + step) + (dz !== 0 ? side : 0))
    const tz = Math.round(start.z + dz * (along + step) + (dx !== 0 ? side : 0))
    await keepBlocks(session, ctl)
    const biomeHere = () => { try { return String((require('../perception') as typeof import('../perception')).biomeName(bot, bot.entity.position.floored()) || '') } catch { return '' } }
    const inDelta0 = bot._ndAvoidDeltas ? /basalt_deltas/.test(biomeHere()) : false
    const w = await legTo(session, ctl, tx, tz, deadline, { onOpen: glance, stop: stopWhen || (x => !!(x && (x.seen || x.bastion))) })
    legs.push({ to: { x: tx, z: tz }, ok: w.ok, down: w.down, bored: w.bored, covered: w.covered, fought: w.fought, error: w.ok ? undefined : w.error, from: xyz(me) })
    if (ctl.aborted) { stopped = 'прервано'; break }
    // Поиск бастиона: базальтовые дельты (биом под ногами, F3) — бастионов там не бывает (bastion_remnant: все биомы Ада, кроме
    // дельт), а магмовые кубы и гасты в базальте убивали (b0-7-1 14.10: хп 20 → 1 за 2 с) — направление закрыто. Только вход в
    // дельты: из дельт, где уже стоим, отрезки выводят (b6-6-1 14.10: стоял в дельтах — каждый вызов «не иду» за 0 с).
    if (bot._ndAvoidDeltas && !inDelta0 && process.env.ND_NE_DELTAS !== '0') {
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
    if (w.fought) {
      // Отбился — тот же отрезок заново; не отбился и хп мало — стоп.
      if ((bot.health ?? 0) < 8) { stopped = w.error + `, хп ${Math.round(bot.health ?? 0)} — дальше не иду`; break }
    } else if (w.ok) {
      along += step
      side = 0
      if (onStep) onStep(along)
    } else if (Math.abs(side) < 24 && ++fails <= 6) {
      // Прямо не прошёл (лавовое озеро, обрыв) — то же расстояние, но вбок.
      side = side <= 0 ? -side + 8 : -side
    } else {
      stopped = `на ${WORDS[dirName]} дороги нет ни прямо, ни в стороны на 24 блока: ${w.error}`
      blocked = true
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
  for (let k = 0; k < 5 && !ctl.aborted && gameClock.now() < deadline; k++) {
    const p = S.pie(bot, { range: 64 })
    const n = (p && p.byType && p.byType[type]) || 0
    if (n < (type === 'chest' ? 2 : 1)) break
    // Сундуки уже выработанного бастиона рядом — не постройка для поиска (gb1-5-1: «пирог» 11 сундуков повёл обратно в тот же
    // бастион, к бруту).
    if (type === 'chest' && bastionSpentNear(session, bot.entity.position)) break
    const arc = S.pieArcs(bot, type, { fov: 30 })[0]
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

// До точки по прямым: сначала по оси, где дальше, потом по другой — отрезками
// по 16 со взглядом после каждого (walkLine).
async function walkTo (session, ctl, to, { deadline, glance, legs, stopWhen = null, resume = {}, onProgress = null, pie = null }: any) {
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
      pie
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
  let plan = session.journal.state && session.journal.state[KEY]
  if (!plan || plan.world !== 'the_nether' || !plan.origin || !plan.region) {
    const portal = placeOf(session, worlds.portalKey('the_nether'))
    const o = portal && worlds.worldOfRecord(portal) === 'the_nether' ? portal : xyz(bot.entity.position)
    const region = regionOf(o.x, o.z)
    plan = { world: 'the_nether', origin: { x: o.x, z: o.z }, region, done: [], wps: stripesOf(region[0], region[1], o), i: 0 }
    // S1f (механика генерации, jar 1.21.11 structure_set/nether_complexes: random_spread spacing 27, separation 4, fortress 2 /
    // bastion_remnant 3 — одна постройка на регион): регион увиденного бастиона крепости не содержит — обход крепости его пропускает.
    if (!forBastion && process.env.ND_REGION_SKIP !== '0') {
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
  if (high && !plan.rings) {
    const pts = []
    for (const R of rings) for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; pts.push({ x: Math.round(plan.origin.x + R * Math.cos(a)), z: Math.round(plan.origin.z + R * Math.sin(a)) }) }
    const order = []
    let cur = { x: bot.entity.position.x, z: bot.entity.position.z }
    while (pts.length) {
      let bi = 0
      for (let i = 1; i < pts.length; i++) if (Math.hypot(pts[i].x - cur.x, pts[i].z - cur.z) < Math.hypot(pts[bi].x - cur.x, pts[bi].z - cur.z)) bi = i
      cur = pts.splice(bi, 1)[0]
      order.push(cur)
    }
    plan.rings = { wps: order, i: 0 }
  }
  save()
  let stopped = null
  let blocked = 0
  while (high && plan.rings && plan.rings.i < plan.rings.wps.length && !ctl.aborted && gameClock.now() < deadline) {
    const to = plan.rings.wps[plan.rings.i]
    // Точка кольца в 48 бл. от увиденных дельт — бастиона там нет: следующая.
    if (forBastion && (bot._ndDeltaSeen || []).some(d => Math.hypot(d.x - to.x, d.z - to.z) < 48)) { plan.rings.i++; delete plan.walk; save(); continue }
    const r = await walkTo(session, ctl, to, { deadline, glance, legs, stopWhen: hit, resume: plan.walk ||= {}, onProgress: save, pie: forBastion ? 'chest' : 'spawner' })
    v = r.v
    if (hit(v)) { stopped = null; save(); return { v, stopped, plan: { origin: plan.origin, rings: plan.rings.i, of: plan.rings.wps.length } } }
    if (ctl.aborted || gameClock.now() >= deadline) break
    const h = await highLook(session, ctl, glance)
    log(forBastion ? 'бастион: точка обзора' : 'точка обзора', { i: plan.rings.i, to, at: xyz(bot.entity.position), up: h.up, skipped: h.skipped, seen: h.seen, bastion: h.bastion })
    plan.rings.i++
    delete plan.walk
    save()
    if (h.v && hit(h.v)) { v = h.v; return { v, stopped: null, plan: { origin: plan.origin, rings: plan.rings.i, of: plan.rings.wps.length } } }
  }
  while (!ctl.aborted && gameClock.now() < deadline) {
    if (plan.i >= plan.wps.length || (!forBastion && v && v.bastion)) {
      // Регион пройден, или в нём бастион (одна постройка на регион) — дальше.
      plan.done.push(plan.region)
      const next = nextRegion(plan)
      if (!next) { stopped = `обошёл регионы в трёх кольцах вокруг портала — ${forBastion ? 'бастиона' : 'крепости'} не видел`; break }
      plan.region = next
      plan.wps = stripesOf(next[0], next[1], bot.entity.position)
      plan.i = 0
      v = { seen: 0 }
      save()
      if (high) { const h = await highLook(session, ctl, glance); if (h.v && hit(h.v)) { v = h.v; stopped = null; break } }
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

export { walkLine, regionOf, bastionRegions, sweep }
