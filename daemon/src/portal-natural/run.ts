'use strict'
// Природная лава для портала (portal-natural.ts): run — найти, дойти, отлить и зажечь; RPC portal_natural.
import * as gameClock from '../game-clock'
import { inWater, escapeWater, travelXZ, xyz } from '../movement'
import { Vec3 } from 'vec3'
import {
  SWEEP, clearSoft, edgeSpot, hintFor, legTarget, lookoutSpot, pillarLook, refreshCastLava, softCells, walkNear
} from './walk'
import { ON, biomeAt, searchOrder, survey } from './look'


export async function run (session, ctl, p: any = {}) {
  const bot = session.bot
  const t0 = gameClock.now()
  const secs = Math.max(60, Math.min(900, p.timeoutSeconds ?? 600))
  const deadline = t0 + secs * 1000 - 5000
  const late = () => gameClock.now() > deadline || ctl.aborted
  const steps = []
  const mark = (what, extra: any = {}) => steps.push({ s: Math.round((gameClock.now() - t0) / 100) / 10, what, ...extra })
  ctl.onAbort.push(() => { try { bot.pathfinder.setGoal(null) } catch {} })

  const R = p.radius ?? 128
  const pillar = p.pillar ?? 10
  // Точка обзора: сначала естественная высота (≥ +8 в 24 бл. — глаза почти как на столбе) — дойти и осмотреться;
  // иначе (или не дошёл) — столб 10 своими блоками, обзор 128, спуск с копкой столба.
  let lastLook = null
  const lookout = async (tag) => {
    lastLook = null
    if (inWater(bot)) await escapeWater(bot, ctl).catch(() => null)
    const spot = lookoutSpot(bot)
    if (spot && spot.y >= bot.entity.position.y + Math.min(8, pillar || 8)) {
      const ok = await walkNear(bot, ctl, spot, 1, 20000)
      if (ok || !pillar) {
        const s2 = survey(bot, { radius: R })
        mark(`${tag}: высота`, { ok, at: spot, seen: s2.seenSources, best: s2.best && s2.best.kind })
        lastLook = 'высота'
        return s2
      }
    }
    if (!pillar) return survey(bot, { radius: R })
    const l = await pillarLook(session, ctl, { height: pillar, radius: R })
    mark(`${tag}: столб`, { placed: l.placed, why: l.why, seen: l.survey.seenSources, best: l.survey.best && l.survey.best.kind })
    lastLook = 'столб'
    return l.survey
  }
  let s = survey(bot, { radius: R })
  mark('осмотр', { seen: s.seenSources, best: s.best && s.best.kind })
  const start = bot.entity.position.clone()
  // Подсказка из скана копии мира (hint {x,y,z} или seed → hintFor): сразу к месту видимой лавы, там осмотр, обход и
  // точка обзора. Не увидел — лучи от старта (их число — legs; кампания с подсказкой зовёт legs: 0 и идёт вниз).
  const hint = p.hint || hintFor(p.seed)
  if (!s.best && hint && !late()) {
    // Отрезками по 64: путь в 245 м одним goto — «Took to long to decide path to goal!» на 25-й с (pn-hint 02.10, сид
    // 6162616963942616824), и дальше всё шло от места в 200 м от подсказки. Два отказа подряд — стоп.
    const hd = () => Math.hypot(hint.x - bot.entity.position.x, hint.z - bot.entity.position.z)
    let fails = 0; let legsTo = 0
    while (hd() > 16 && fails < 2 && !late()) {
      const d = hd(); const k = Math.min(1, 64 / d)
      const tx = bot.entity.position.x + (hint.x - bot.entity.position.x) * k
      const tz = bot.entity.position.z + (hint.z - bot.entity.position.z) * k
      const r = await travelXZ(bot, ctl, tx, tz, { range: k < 1 ? 6 : 12, retries: 1, deadline: Math.min(deadline, gameClock.now() + 45000) })
      legsTo++
      fails = r.ok ? 0 : fails + 1
      if (k >= 1 && r.ok) break
    }
    mark('к подсказке', { ok: hd() <= 24, legs: legsTo, hint, me: xyz(bot.entity.position.floored()) })
    // Гладь выше или ниже глаз на 4+ (pn-hint 02.10, сид −1438498926029987630: озеро на плато y 91, тело внизу на 72 в
    // 11 м — снизу глади не видно): подняться/спуститься к ней с копкой, как goto.
    const dy = hint.y - bot.entity.position.y
    if ((dy > 3 || dy < -6) && hd() <= 24 && !late()) {
      const ok = await walkNear(bot, ctl, { x: hint.x, y: hint.y + 1, z: hint.z }, 6, Math.min(60000, Math.max(5000, deadline - gameClock.now())))
      mark('к подсказке по высоте', { ok, dy: Math.round(dy), me: xyz(bot.entity.position.floored()) })
    }
    s = survey(bot, { radius: R })
    mark('осмотр у подсказки', { seen: s.seenSources, best: s.best && s.best.kind })
    // Не видно с подхода — обойти место по кругу в 8 бл. на уровне глади (край чаши с другой стороны), потом точка
    // обзора. pn-hint 02.10, сид −1438498926029987630: озеро на плато, с подхода и с горы рядом (+14) — 0 источников.
    for (const [ox, oz] of [[8, 0], [0, 8], [-8, 0], [0, -8]]) {
      if (s.best || late() || hd() > 32) break
      const to = { x: hint.x + ox, y: hint.y + 1, z: hint.z + oz }
      const ok = await walkNear(bot, ctl, to, 2, Math.min(25000, Math.max(3000, deadline - gameClock.now())))
      s = survey(bot, { radius: R })
      mark('обход подсказки', { ok, to, seen: s.seenSources, best: s.best && s.best.kind })
    }
    if (!s.best && p.lookout !== false && !late()) s = await lookout('подсказка')
    // Высота рядом не показала — ещё столб: лава здесь известна, 20 с того стоят.
    if (!s.best && pillar && lastLook === 'высота' && p.lookout !== false && !late()) {
      const l = await pillarLook(session, ctl, { height: pillar, radius: R })
      mark('подсказка: столб', { placed: l.placed, why: l.why, seen: l.survey.seenSources, best: l.survey.best && l.survey.best.kind })
      s = l.survey
    }
  }
  if (!s.best && p.lookout !== false && !late() && !hint) s = await lookout('старт')
  // Разведка лучами поверху: без копки и без лесов, как actions.explore.
  // По умолчанию 2 луча (~1.5 мин со столбами): находки были со столба на старте и после первого луча, а путь вниз к
  // −55 гарантирован (07 §8, бюджет поиска поверху).
  const legs = Math.max(0, Math.min(16, p.legs ?? 2))
  // Точки лучей — от места старта, не от текущего: от текущего восемь отрезков E, S, W, N… водили тело квадратом
  // вокруг старта (pn-pool 02.10: четвёртый луч вернулся на спавн). Здесь — восемь направлений на 64, потом на 128.
  // Конец луча — сушей (legTarget): в воду не идти; направление без суши пропускается и луча не стоит.
  for (let i = 0, k = 0; !s.best && i < legs && k < SWEEP.length * 2 && !late(); k++) {
    const [dx, dz] = SWEEP[k % SWEEP.length]
    const spread = 1 + Math.floor(k / SWEEP.length)
    const step = p.stepDistance ?? 64
    const to = legTarget(bot, start, [dx, dz], step * spread, bot.entity.position)
    if (!to) { mark(`луч ${dx},${dz}: вода — мимо`); continue }
    i++
    const mv = bot.pathfinder.movements
    const dug = mv ? mv.canDig : undefined
    const scaffold = mv ? mv.scafoldingBlocks : undefined
    if (mv) { mv.canDig = false; mv.scafoldingBlocks = [] }
    session.surfaceWalk = true
    let r
    try {
      r = await travelXZ(bot, ctl, to.x, to.z, { range: 6, retries: 1, deadline: Math.min(deadline, gameClock.now() + 45000) })
    } finally {
      session.surfaceWalk = false
      if (mv) { mv.canDig = dug; mv.scafoldingBlocks = scaffold }
    }
    s = survey(bot, { radius: R })
    mark(`луч ${dx},${dz}`, { ok: r.ok, to: xyz(new Vec3(to.x, to.y, to.z).floored()), seen: s.seenSources, best: s.best && s.best.kind })
    if (!s.best && p.lookout !== false && !late()) s = await lookout(`луч ${dx},${dz}`)
  }
  if (!s.best) {
    return { found: false, hintUsed: hint || null, seconds: Math.round((gameClock.now() - t0) / 1000), steps, order: searchOrder(s.biome), last: s.sites.slice(0, 3), ruins: s.ruins, stopped: 'годной лавы не видно — дальше путь вниз (ND_OW_DEEP) или разведка' }
  }
  const site = s.best
  const found = { kind: site.kind, at: site.at, open: site.open, dist: site.dist, est: site.est, water: site.water, biome: site.biome, ruins: site.ruins }
  mark('выбрал', found)
  // Подойти на сушу в 6–10 бл. от источника: cast.js ищет место рамы в radius 9 от тела, лава — не ближе 5 и не
  // дальше 18 от рамы. Не вышло с одной стороны — с другой.
  // Далеко — сперва поверху отрезком (travelXZ: страж застревания), потом точный подход.
  if (Math.hypot(site.at.x - bot.entity.position.x, site.at.z - bot.entity.position.z) > 24 && !late()) {
    const r = await travelXZ(bot, ctl, site.at.x, site.at.z, { range: 10, retries: 2, deadline: Math.min(deadline, gameClock.now() + 120000) })
    mark('к лаве поверху', { ok: r.ok, error: r.error, me: xyz(bot.entity.position.floored()) })
  }
  // Литьё — как этап cast кампании, заходами. «Места под раму нет» — к следующей стороне озера; «не вижу лавы» —
  // снова к лаве; остальное (лава кончилась, клетка не вышла, время) — тот же заход ещё раз: cast.js продолжает
  // начатую раму (план в памяти). Смоук pn-rand 02.10: «лава кончилась: зачерпнуть не вышло» на 5/10, а baseline со
  // второго захода дожал до горящего.
  const tries = [[0, 0], [8, 0], [-8, 0], [0, 8], [0, -8]]
  let side = 0
  let cast = null
  let approach = true
  let stall = 0
  let dry = 0
  let noProg = 0
  let lastFrame = -1
  // Заходов — до 30: предел ставят время (deadline) и стороны (tries; без прироста — к следующей, кончились — стоп).
  // pn-hint 02.10: −1438… — восемь заходов кончились на 304-й с из 570, 8388… (мангры) — двенадцать на 126-й с.
  for (let attempt = 0; attempt < 30 && !late(); attempt++) {
    if (approach) {
      const [ox, oz] = tries[Math.min(side, tries.length - 1)]
      const goal = { x: site.at.x + ox, y: site.at.y + 1, z: site.at.z + oz }
      const ok = await walkNear(bot, ctl, goal, ox || oz ? 3 : 7, Math.min(90000, Math.max(5000, deadline - gameClock.now())))
      mark('подошёл', { ok, to: goal, me: xyz(bot.entity.position.floored()) })
    }
    const left = Math.round((deadline - gameClock.now()) / 1000)
    if (left < 45) break
    const t1 = gameClock.now()
    const castMod: typeof import('../cast') = require('../cast')
    cast = await castMod.castPortal(session, ctl, { timeoutSeconds: Math.min(540, left), radius: 9 })
    mark('литьё', { built: cast.built, frame: cast.frame, stopped: cast.stopped, refills: cast.refills, trace: Array.isArray(cast.trace) ? cast.trace.slice(-6) : undefined, buckets: ['bucket', 'water_bucket', 'lava_bucket'].map(n => bot.inventory.items().filter(i => i.name === n).reduce((a, i) => a + i.count, 0)).join('/') })
    if (cast.built) break
    const why = cast.stopped || ''
    if (cast.need) break // нет вёдер или блоков — не здесь лечить
    // Пустая рама и отказ за секунды («не встал на …» пять раз за 1.5 с — pn-rand 02.10, сид 4307605278284484928):
    // место негодно для тела — забыть план (он и в журнале мира) и зайти с другой стороны озера.
    const empty = /^0\/10/.test(cast.frame || '0/10')
    const frameN = Number((/^(\d+)\//.exec(cast.frame || '') || [])[1] || 0)
    const fast = gameClock.now() - t1 < 5000
    // Трава или снег не дали выкопать место или налить — снять и тот же заход ещё раз.
    if (!/лава кончилась|места под раму/.test(why)) {
      const soft = softCells(cast)
      const n = soft.length && !late() ? await clearSoft(bot, ctl, soft) : 0
      if (n) { mark('трава/снег', { n }); approach = false; lastFrame = frameN; continue }
    }
    // Без прироста рамы и за секунды второй раз подряд — место негодно (не только при пустой раме: pn-hint 6162…,
    // 1/10 и четыре захода за 0 с) — к другой стороне.
    stall = fast && frameN <= lastFrame ? stall + 1 : 0
    noProg = frameN <= lastFrame ? noProg + 1 : 0 // четыре захода подряд без прироста рамы — тоже к другой стороне
    // «Лава кончилась» без единого черпака дважды подряд и после обновления плана живой лавой — с этой стороны черпак
    // не достаёт (pn-hint 02.10, сид 8388397891651367710, мангры: рама 1/10, восемь заходов «видно 0») — к другой.
    dry = /лава кончилась/.test(why) && !cast.refills ? dry + 1 : 0
    lastFrame = Math.max(lastFrame, frameN)
    if (/места под раму/.test(why) || (empty && fast) || stall >= 2 || dry >= 3 || noProg >= 4) {
      stall = 0; dry = 0; noProg = 0
      side++
      if (side >= tries.length) break
      session.castPlan = null
      try { session.journal.patch(st => { if (st.places) delete st.places[castMod.PLACE] }) } catch {}
      approach = true
      continue
    }
    approach = /не вижу лавы/.test(why)
    // Лава «кончилась» при живом озере (pn3-rand, сид 4307605278284484928: 74 открытых источника, рама 4/10, шесть
    // заходов подряд refills 0) — встать на берег у открытого источника и лить дальше.
    if (/лава кончилась/.test(why) && !late()) {
      const ref = cast.site && cast.site.origin ? new Vec3(cast.site.origin.x, cast.site.origin.y, cast.site.origin.z) : null
      const n = refreshCastLava(session, site.at, ref)
      mark('живая лава в план', { n })
      if (!n) { const e = edgeSpot(bot, site.at); if (e) { const ok = await walkNear(bot, ctl, e, 0, 20000); mark('к берегу', { ok, to: xyz(e) }) } }
    }
  }
  let light = null
  if (cast && cast.built && !ctl.aborted) {
    light = await (require('../nether') as typeof import('../nether')).portal(session, ctl, { mode: 'build', timeoutSeconds: 60 })
    mark('поджиг', { lit: !!(light && light.lit) })
  }
  return {
    found: true,
    hintUsed: hint || null,
    site: found,
    built: !!(cast && cast.built),
    lit: !!(light && light.lit),
    seconds: Math.round((gameClock.now() - t0) / 1000),
    cast: cast ? { frame: cast.frame, refills: cast.refills, placed: cast.placed, dug: cast.dug, stopped: cast.stopped, site: cast.site } : null,
    steps
  }
}

// RPC portal_natural: mode survey (по умолчанию, только чтение) | order | run (ND_PORTAL_NATURAL=1).
export function rpc (session, p: any = {}) {
  const mode = String(p.mode || 'survey')
  if (mode === 'survey') return session.immediate(async () => survey(session.require(), p))
  // Отладка луча: во что упирается взгляд к верхней грани клетки at.
  if (mode === 'ray') {
    return session.immediate(async () => {
      const bot = session.require()
      const p0 = new Vec3(p.at.x, p.at.y, p.at.z)
      const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0)
      const t = p0.offset(0.5, 0.85, 0.5)
      const delta = t.minus(eye)
      const dist = delta.norm()
      const hit = bot.world.raycast(eye, delta.clone().normalize(), dist + 0.3, (b, iter) => {
        if (b.position.equals(p0)) return true
        return !!(b.shapes && b.shapes.length && iter.intersect(b.shapes, b.position))
      })
      const path = []
      const dir = delta.clone().normalize()
      for (let k = 0; k <= Math.ceil(dist * 4); k++) {
        const q = eye.plus(dir.scaled(k / 4)).floored()
        const b = bot.blockAt(q)
        const last = path[path.length - 1]
        if (!last || last[0] !== `${q.x},${q.y},${q.z}`) path.push([`${q.x},${q.y},${q.z}`, b ? b.name : null, b && b.shapes ? b.shapes.length : -1])
      }
      return { eye: xyz(eye), target: xyz(p0), hit: hit ? { at: xyz(hit.position), name: hit.name } : null, block: (bot.blockAt(p0) || {}).name, path: path.filter(x => x[1] !== 'air').slice(0, 12) }
    })
  }
  if (mode === 'order') return session.immediate(async () => ({ order: searchOrder(biomeAt(session.require(), session.require().entity.position.floored())) }))
  if (mode === 'run') {
    if (!ON()) return Promise.resolve({ status: 'failed', error: 'portal_natural run — под флагом ND_PORTAL_NATURAL=1 (по умолчанию выкл.)' })
    return session.runIntent('portal', ctl => {
      session.require()
      session.updateMovements()
      return run(session, ctl, p)
    }, {
      timeoutMs: (Math.min(900, p.timeoutSeconds ?? 600) + 90) * 1000,
      params: p,
      interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected']
    })
  }
  return Promise.resolve({ status: 'failed', error: `mode: survey | order | run, не ${mode}` })
}
