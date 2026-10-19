'use strict'
// Бой с драконом (dragon/pillar-run.ts): бегун по столбу: упреждение клика и сам прогон.
const { gameClock, Vec3, findItem, sleep, stepTo, dragonOf, phaseOf, PHASE, EYE, SITTING, clearControls, box, RUN_SEEN, PHASE_RU, hpOf, RUN_ARROW, envNum, RUN_KEEPCOB, isAirish, RUN_BOX, RUN_HIGH, envv, FIRST_MAX, RUN_TICKSEEN, PLACE_LEAD, RUN_FACING, RUN_GAPARROW, RUN_LATEHEAD }: typeof import('../dig-down-to') = require('../dig-down-to')
const { hunters, doing, r1, podiumTop }: typeof import('../fall-guard') = require('../fall-guard')
const { countOf, lookAtSafe, DRAD, virtualBot, exposure, landingForecast, landingHits, bedDamage }: typeof import('../evade-raw') = require('../evade-raw')
const { bedHere, pillarHere, smCompile, smDragonSeen, SM_EMPTY, runnerArrow, runnerSupport, bodyBlocksBed, runnerGapArrow }: typeof import('../station-plan') = require('../station-plan')
const { pillarCells, faceClick, BED_GAP_MS, faceClickFacing }: typeof import('../pillar-plan') = require('../pillar-plan')
const { anchorCharges, FACE_IDX, chargeAnchor, pushedForecast }: typeof import('../ts-plan') = require('../ts-plan')
import { bedsBoom } from './beds-act'
import { pillarEnter } from './pillar-build'

// Тиков после прохода головы по прогнозу до щелчка: +1 на 20 тиках (an-pilltiming, 81 из 90), 0 на ускоренных (s5 06.10).
function clickLead (rate = gameClock.snapshot()?.tickRate ?? 20) { return envNum('ND_CLICK_LEAD', rate > 100 ? 0 : 1) }

async function pillarRun (session, ctl, stats, track, feed) {
  const bot = session.bot
  const ev = (k, o) => { if (ctl.trace) ctl.trace.ev(k, o) }
  const st = ctl.pillar
  let plan = st.plan
  const runnerLevels = plan.runnerLevels
  const P = podiumTop(bot)
  const out: any = { booms: [], why: null }
  const t0 = gameClock.now()
  let H = plan.H; let F = plan.F; let yb = plan.yb
  const bedHere = () => /_bed$/.test((bot.blockAt(new Vec3(H.x, yb, H.z)) || {}).name || '') && /_bed$/.test((bot.blockAt(new Vec3(F.x, yb, F.z)) || {}).name || '')
  const bedCells = [{ x: F.x, y: yb, z: F.z }, { x: H.x, y: yb, z: H.z }]
  // Якорь возрождения (если есть якоря и светокамень): взрыв той же силы, дракон его не ломает (dragon_immune) —
  const Apos = new Vec3(F.x, yb, F.z)
  const Acentre = new Vec3(F.x + 0.5, yb + 0.5, F.z + 0.5)
  const anMode = process.env.ND_PILLAR_ANCHOR || 'last'
  const anchorAt = () => anchorCharges(bot, Apos)
  const torchSetP = new Set(pillarCells(plan.P ?? yb + 1).torches.map(t => `${t.x},${t.y},${t.z}`))
  const torchHitP = (eye, d, len) => { if (runnerLevels) return false; for (let t = 0; t < len; t += 0.1) { const q = eye.plus(d.scaled(t)); if (torchSetP.has(`${Math.floor(q.x)},${Math.floor(q.y)},${Math.floor(q.z)}`)) return true } return false }
  const anClick = (vb) => { const eye = bot.entity.position.offset(0, EYE, 0); for (const f of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, 1, 0]]) { const c = faceClick(vb, eye, Apos, new Vec3(f[0], f[1], f[2]), { reach: 4.3, avoidTorch: torchHitP }); if (c) return { point: c.point, face: new Vec3(f[0], f[1], f[2]) } } return null }
  // F ближе к окопу, чем H, и закрыт хуже (pil7-22: 1–1.5 хп нам за якорь против 0.3 за кровать) — при хп < 12 только кровати
  const recenter = async () => {
    out.recenter = (out.recenter || 0) + 1
    if (out.recenter > (runnerLevels ? 12 : 3)) return false
    const q = bot.entity.position
    await stepTo(bot, ctl, runnerLevels ? new Vec3(plan.feet.x, q.y, plan.feet.z) : new Vec3(plan.B.x + 0.5, q.y, plan.B.z + 0.5), { ms: 700, sprint: false, stopAt: 0.06, portal: true })
    clearControls(bot)
    // взрыв мог выбить эндерняк у окопа (якорь в F ближе к нам) — тогда окоп заново (глубже — подняться)
    if (!pillarHere(bot, plan)) await pillarEnter(session, ctl, plan)
    return true
  }
  const anchorOk = () => !runnerLevels && anMode !== '0' && !st.noAnchor && bot.health >= 12 && countOf(bot, /^respawn_anchor$/) >= 1 && countOf(bot, /^glowstone$/) >= 1
  // Поставленная, но не взорванная кровать — тоже заряд (01.10: последняя из 7 ставилась и бросалась — «кровати кончились»
  // при 0 в рюкзаке, хотя кровать стояла у столба: 6 взрывов из 7 в 41 из 58 вызовов).
  const noBoom = () => countOf(bot, /_bed$/) < 1 && !bedHere() && !anchorOk() && anchorAt() < 1
  const cellHit = (st2) => {
    // клетки кровати в коробках головы/шеи/тела (checkWalls — по клеткам)
    const M = 0.1
    const hb = box(st2.head.x, st2.head.y - M, st2.head.z, 0.5, 1 + M); const nb = box(st2.neck.x, st2.neck.y - M, st2.neck.z, 1.5, 3 + M)
    const by = box(st2.pos.x + Math.sin(st2.yRot * DRAD) * 0.5, st2.pos.y - M, st2.pos.z - Math.cos(st2.yRot * DRAD) * 0.5, 2.5, 3 + M)
    const cellsOf = b => ({ x0: Math.floor(b.min.x), x1: Math.floor(b.max.x - 1e-7), y0: Math.floor(b.min.y), y1: Math.floor(b.max.y - 1e-7), z0: Math.floor(b.min.z), z1: Math.floor(b.max.z - 1e-7) })
    return [hb, nb, by].some(b => { const c = cellsOf(b); return bedCells.some(q => q.x >= c.x0 && q.x <= c.x1 && q.y >= c.y0 && q.y <= c.y1 && q.z >= c.z0 && q.z <= c.z1) })
  }
  try {
    if (noBoom()) { out.why = 'кровати кончились'; return out }
    doing(ctl, 'pillar:enter')
    if (!(await pillarEnter(session, ctl, plan))) { out.why = 'в окоп не встал'; return out }
    // якорь в H с этого места щёлкается? (иначе — только кровати)
    if (anchorOk() && anchorAt() < 0 && !anClick(virtualBot(bot, new Map([[`${F.x},${yb},${F.z}`, 'block']])))) { st.noAnchor = true; out.anchor = 'не видно' }
    // открытость окопа взрыву в F: > 0.3 — якоря не ставить (урон нам ~2+ за взрыв)
    if (anchorOk() && !st.anExpo) { st.anExpo = exposure(bot, bot.entity.position, Acentre); out.anExpo = r1(st.anExpo * 100) / 100; if (st.anExpo > 0.3) { st.noAnchor = true; out.anchor = 'окоп открыт взрыву в F' } }
    let lastBoom = stats.lastBoom || 0
    let gapKey = null
    let keepKey = null
    const supBan = new Map()
    // снимок мира у станции R для seen (без клеток кровати и опоры под F — их форма зависит от яруса), один на цепочку
    let smSnap = null; const smCache = new Map()
    if (runnerLevels && RUN_SEEN()) {
      const t0s = gameClock.now()
      try { smSnap = smCompile(bot, [-16, P - 6, -16, 16, P + 16, 16], (x, y, z) => x === 0 && (z === 0 || z === F.z) && y >= P && y <= P + 1) } catch (e) { smSnap = null }
      out.smMs = gameClock.now() - t0s; out.smN = smSnap ? smSnap.colliders.length : null
    }
    // прогноз seen родителя и высоты тела над ярусом в тик щелчка — в событие bed (сверка с сервером, DragonLab)
    let fcNow = null
    const seenNote = (k) => {
      try {
        const st0 = fcNow && fcNow.path[k]
        if (!st0) return {}
        const o: any = { bodyDy: r1(st0.pos.y - yb) }
        if (smSnap) { const sp = smDragonSeen(smSnap, new Vec3(0.5, yb + 0.5, 0.5), st0.pos, yb > P ? [[0, P, F.z, 1, P + 1, F.z + 1]] : SM_EMPTY); if (sp != null) o.seenP = Math.round(sp * 1000) / 1000 }
        return o
      } catch (e) { return {} }
    }
    let pushed = null
    let placedSince = bedHere()
    // Поставленная кровать без прохода (садится/сел) — взорвать сейчас, а не отдать коробкам дракона (st1: «садится без
    const salvage = async (tag) => {
      if (!bedHere() || gameClock.now() < (stats.lastBoom || 0) + BED_GAP_MS) return false
      const eye = bot.entity.position.offset(0, EYE, 0)
      let hitCell = new Vec3(plan.click.cell.x, yb, plan.click.cell.z)
      let hit = faceClick(bot, eye, hitCell, new Vec3(plan.click.face.x, plan.click.face.y, plan.click.face.z))
      // плановая грань не видна (толчок сдвинул в окопе) — любая видимая грань кровати
      for (const cell of [F, H]) for (const fc of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, 1, 0]]) { if (!hit) { const c3 = new Vec3(cell.x, yb, cell.z); hit = faceClick(bot, eye, c3, new Vec3(fc[0], fc[1], fc[2])); if (hit) hitCell = c3 } }
      if (!hit) { out.salvageFail = (out.salvageFail || 0) + 1; return false }
      await lookAtSafe(bot, hit.point)
      await new Promise<any>(resolve => bot.once('physicsTick', resolve))
      const r = await bedsBoom(session, ctl, stats, { ...plan, dist: null, expect: null, D: plan.a, y: yb, reuse: true }, { point: hit.point, block: bot.blockAt(hitCell) }, 'снижение', { aimed: true, until: gameClock.now(), uncounted: true, phCheck: p => p === PHASE.LANDING || SITTING.has(p), note: { oc: 'P', salvage: tag } })
      out.booms.push(r.ok ? r.dmg : null)
      out.salvage = (out.salvage || 0) + 1
      if (r.ok) { lastBoom = stats.lastBoom || gameClock.now(); st.booms++; placedSince = false; pushed = null }
      return r.ok
    }
    const tEnd = gameClock.now() + 60000
    while (!ctl.aborted && gameClock.now() < tEnd) {
      const dd = dragonOf(bot)
      if (!dd) { out.why = 'дракона нет'; break }
      const ph = phaseOf(bot, dd)
      if (ph !== PHASE.LANDING) {
        out.why = `фаза ${PHASE_RU[ph] ?? ph}`
        if (!runnerLevels && SITTING.has(ph) && process.env.ND_SALVAGE !== '0') await salvage('сел')
        break
      }
      if (noBoom()) {
        // R: кровати кончились, а дракон ещё снижается и хп мало — стрела в проход головы (ND_RUN_ARROW=0 — выкл.)
        const hpNow = hpOf(bot, dd)
        if (runnerLevels && RUN_ARROW() && hpNow != null && hpNow <= envNum('ND_RUN_ARROW_HP', 30) && (out.arrows || 0) < 3) {
          out.arrows = (out.arrows || 0) + 1
          doing(ctl, 'pillar:arrow')
          const a: any = await runnerArrow(session, ctl, feed, P, lastBoom)
          ;(out.arrowLog || (out.arrowLog = [])).push(a.shot ? { ...a.shot, hpAfter: a.hpAfter } : a.why)
          continue
        }
        out.why = 'кровати кончились'; break
      }
      if ((hpOf(bot, dd) ?? 1) <= 0) break
      if (bot.health < 10 && hunters(bot, 5).length) { out.why = 'эндермен бьёт'; break }
      const hereAn = anchorAt()
      const useAn = hereAn >= 0 || (!bedHere() && anchorOk() && (anMode === 'first' || countOf(bot, /_bed$/) < 1))
      if (hereAn === 0 && countOf(bot, /^glowstone$/) < 1) { out.why = 'якорь без заряда'; break }
      // прогноз: свежий по пакетам, а сразу после взрыва — с толчком
      let fc = landingForecast(feed, P)
      if (pushed && (!fc || fc.t < pushed.after)) fc = pushed.fc
      if (!fc) { await sleep(20); continue }
      fcNow = fc
      const nowTick = Math.round((gameClock.now() - fc.t) / 50)
      const minTick = Math.max(nowTick + 3, Math.ceil((lastBoom + BED_GAP_MS + 60 - fc.t) / 50))
      if (runnerLevels) {
        const q = bot.entity.position
        // толчок своего взрыва сдвигает в чаше (labR: 27 из 30 цепочек обрывались после первого взрыва) — вернуться в клетку
        if (bot.health < 10) { out.why = 'R: мало хп'; break }
        // без проверки exposure: первый взрыв сносит факелы столба, клиентский exposure считал их заслоном и рвал цепочку
        // (labR2: 16 из 17), а урон боту в чаше по серверу 0.3 за снижение
        if (!bot.entity.onGround || q.distanceTo(plan.feet) > 0.25) { if (await recenter()) continue; out.why = 'R: потеря защищённой позиции'; break }
        const danger = landingHits({ path: fc.path.slice(Math.max(0, nowTick), nowTick + 4) }, q)
        if (danger) { out.why = 'R: ' + danger.what; break }
        // Опора под F для P + 1 — сразу после взрыва, если её снесло (labS1: P + 1 выбран лишь в 43 % взрывов — к проходу булыжник
        if (RUN_KEEPCOB() && keepKey !== lastBoom && !bedHere() && runnerLevels.some(p => p.yb > P) && gameClock.now() - (lastBoom || 0) > 120 && !supBan.has('keep')) {
          keepKey = lastBoom
          const sb = bot.blockAt(new Vec3(0, P, F.z))
          if (isAirish(sb) && !landingHits({ path: fc.path.slice(Math.max(0, nowTick), nowTick + 8) }, q)) {
            const ok = await runnerSupport(bot, { ...plan, P }, 1)
            out.keepCob = (out.keepCob || 0) + 1
            if (!ok) { supBan.set('keep', true); (out.supWhy || (out.supWhy = [])).push('держать: ' + runnerSupport.why) }
            continue
          }
        }
        if (!bedHere()) {
          const rej = {}
          const choices = runnerLevels.map(p => {
            let i = -1, dist = Infinity
            for (let k = minTick; k < fc.path.length - 1; k++) {
              const d = fc.path[k].head.distanceTo(p.centre)
              if (d > fc.path[k - 1].head.distanceTo(p.centre) || d > fc.path[k + 1].head.distanceTo(p.centre)) continue
              if (d < dist) { i = k; dist = d }
            }
            // коробка родителя закроет F в тик прохода — ближайший ранний тик, где не закрывает (тело выше), с его расстоянием
            if (RUN_BOX() && i >= 0 && bodyBlocksBed(fc.path[i].pos, p.F, p.yb)) {
              let c = i
              while (c > minTick && bodyBlocksBed(fc.path[c].pos, p.F, p.yb)) c--
              if (bodyBlocksBed(fc.path[c].pos, p.F, p.yb) || fc.path[c].head.distanceTo(p.centre) > 4.6) { i = -1; rej[p.yb - P] = 'коробка' } else { i = c; dist = fc.path[c].head.distanceTo(p.centre) }
            } else if (i < 0) rej[p.yb - P] = 'нет прохода'
            let score = null
            if (RUN_SEEN() && i >= 0 && smSnap) {
              const extra = p.yb > P ? [[0, P, F.z, 1, P + 1, F.z + 1]] : SM_EMPTY
              const key = `${p.yb}|${r1(fc.path[i].pos.x)}|${r1(fc.path[i].pos.y)}|${r1(fc.path[i].pos.z)}`
              let seen = smCache.get(key)
              if (seen === undefined) { seen = smDragonSeen(smSnap, p.centre, fc.path[i].pos, extra); smCache.set(key, seen) }
              score = seen == null ? null : bedDamage(dist, seen)
            }
            return { p, i, dist, score }
          }).filter(c => {
            if (c.i < 0) return false
            const b = bot.blockAt(new Vec3(0, P, F.z))
            const ready = c.p.yb > P ? (b || {}).name === 'cobblestone' : isAirish(b)
            // ярус, опору которого только что не удалось подготовить, — не раньше, чем через 2.5 с (rs3-s2: цепочка рвалась)
            if (!ready && supBan.has(c.p.yb) && gameClock.now() < supBan.get(c.p.yb)) { rej[c.p.yb - P] = 'бан'; return false }
            if (!ready && c.i - nowTick < 20) { rej[c.p.yb - P] = `не готов (${c.i - nowTick} т.)`; return false }
            return true
          }).sort((a, b) => (a.score != null && b.score != null ? b.score - a.score : 0) || (RUN_HIGH() ? b.p.yb - a.p.yb : 0) || a.dist - b.dist)
          const best = choices[0]
          if (!best) { await sleep(30); continue }
          if (best) {
            const support = bot.blockAt(new Vec3(0, P, F.z)), dy = best.p.yb - P
            const ready = dy ? (support || {}).name === 'cobblestone' : isAirish(support)
            if (!ready) {
              // Окно подготовки — не менее 20 тиков, без коробок на всём этом интервале.
              if (best.i - nowTick < 20 || landingHits({ path: fc.path.slice(Math.max(0, nowTick), nowTick + 20) }, q)) { await sleep(30); continue }
              // 02.10 (rs3-s2: «R: опора не подтверждена» рвал цепочку после 2 взрывов, и второй заход — сразу): не рвать — на 2.5 с
              // этот ярус не брать, взять готовый (на P опоре быть воздухом — после взрыва булыжник обычно снесён)
              if (!await runnerSupport(bot, plan, dy)) { out.supFail = (out.supFail || 0) + 1; (out.supWhy || (out.supWhy = [])).push(runnerSupport.why); supBan.set(best.p.yb, gameClock.now() + 2500); if (out.supFail > 6) { out.why = 'R: опора не подтверждена'; break } continue }
              continue // после await только свежий landingForecast/pushedForecast
            }
            plan = { ...best.p, runnerLevels }; st.plan = plan
            H = plan.H; F = plan.F; yb = plan.yb
            bedCells.splice(0, bedCells.length, F, H)
            const heightRec = { y: yb, headY: r1(fc.path[best.i].head.y * 10) / 10, pass: best.i, dist: r1(best.dist * 10) / 10, alt: choices.length > 1 ? r1(choices[1].dist * 10) / 10 : null, ...(Object.keys(rej).length ? { rej } : {}) }
            // запись — только когда выбор сменился (rs1: 149 одинаковых событий на цепочку)
            const rhKey = `${heightRec.y}|${heightRec.pass}`
            if (rhKey !== out.rhKey) { out.rhKey = rhKey; (out.runnerHeights || (out.runnerHeights = [])).push(heightRec); ev('runnerHeight', heightRec) }
          }
        }
      }
      // ближайший проход головы у подушки (локальный минимум ≤ 3.2), кровать не задета до него
      const ctr = useAn ? Acentre : plan.centre
      // Проход и свободное окно кровати — вместе (Codex dragon-series, 01.10: проход брался до проверки окна — первый
      const started = out.booms.some(b => typeof b === 'number')
      const mins = []
      for (let i = Math.max(1, minTick - 1); i < fc.path.length - 1; i++) {
        const a = fc.path[i - 1]; const b = fc.path[i]; const c = fc.path[i + 1]
        const d = b.head.distanceTo(ctr)
        if (i < minTick || d > a.head.distanceTo(ctr) || d > c.head.distanceTo(ctr)) continue
        if (d <= 6.5) mins.push({ i, d })
      }
      // Тик взрыва и когда ставить. Коробки дракона (голова/шея/тело) «съедают» кровать на клетках F/H (checkWalls): взрыв —
      const free = k => { const s2 = fc.path[k]; return !s2 || !cellHit(s2) }
      const placedNow = bedHere()
      // ND_PLACE_CLICK: 2 (по умолчанию с 02.10) — кровать ставится и взрывается двумя пакетами в тик прохода, коробки не
      const pcMode = envv('ND_PLACE_CLICK') ?? '2'
      const placeClick = !useAn && (pcMode === '1' || pcMode === '2') && !placedNow
      const placeClick2 = placeClick && pcMode === '2'
      const firstMax = envNum('ND_FIRST_MAX', FIRST_MAX)
      const lim = started ? 6.5 : firstMax
      // ND_EAT_MARGIN=0 — кровать нужна целой только до тика взрыва c (щелчок обработан между тиками c и c + 1),
      // без запаса на поздний щелчок (лаборатория 02.10: щелчок −25 мс от конца окна — в середине тика)
      const eatMargin = envNum('ND_EAT_MARGIN', 1)
      // ND_MIN_BLAST_HP — не щёлкать в тик c, где прогнозный урон головы (bedDamage, видимость ND_MIN_BLAST_SEEN, 1 —
      // по замеру лаборатории seen p50 0.99) ниже порога: ранний «безопасный» тик слабее самого прохода (Codex dragon-blast, 02.10). 0 — выкл.
      const minBlastHp = Math.max(0, envNum('ND_MIN_BLAST_HP', 0)); const minBlastSeen = envNum('ND_MIN_BLAST_SEEN', 1)
      const windowFor = m => {
        if (useAn) return { clickI: m.i, safeFrom: nowTick }
        // ND_PLACE_CLICK=1: кровать ставится и взрывается двумя пакетами в одном окне тика — коробки дракона её не застают;
        // нужна только свободная клетка в тик взрыва c (сервер не ставит блок в коробку сущности)
        if (placeClick) {
          for (let c = m.i; c >= nowTick + 1; c--) {
            // ND_PLACE_CLICK=2 — и без проверки коробок: части дракона стройке не мешают (Entity.blocksBuilding у EnderDragonPart
            // нет; lab5: 14 неудачных ставок из 499), а checkWalls кровать, поставленную и взорванную между тиками, не застаёт
            if (placeClick2 ? false : !free(c)) continue
            // R: низ коробки родителя 16×8×16 (LivingEntity.blocksBuilding) ниже верха кровати в F — ставка не пройдёт (rs3/rs4:
            // 10 из 10 «ставка не прошла» — тело в 0.1–1.5 над ярусом кровати и снижается); раньше — тело выше
            if (RUN_BOX() && runnerLevels && bodyBlocksBed(fc.path[c].pos, F, yb)) continue
            const cd = fc.path[c].head.distanceTo(ctr)
            if (cd > lim) return null
            if (minBlastHp > 0 && bedDamage(cd, minBlastSeen) < minBlastHp) return null
            // R + seen: среди этого тика и до 3 более ранних (тело выше — seen больше) — наибольший прогнозный урон
            if (runnerLevels && RUN_SEEN() && smSnap && RUN_TICKSEEN()) {
              const extra = yb > P ? [[0, P, F.z, 1, P + 1, F.z + 1]] : SM_EMPTY
              let best = null
              for (let c2 = c; c2 >= Math.max(nowTick + 1, c - 3, minTick); c2--) {
                if (RUN_BOX() && bodyBlocksBed(fc.path[c2].pos, F, yb)) continue
                const d2 = fc.path[c2].head.distanceTo(ctr)
                if (d2 > lim) break
                const sn = smDragonSeen(smSnap, ctr, fc.path[c2].pos, extra)
                const sc = bedDamage(d2, sn == null ? 0.95 : sn)
                if (!best || sc > best.sc + 0.5) best = { c: c2, sc }
              }
              if (best) return { clickI: best.c, safeFrom: best.c }
            }
            return { clickI: c, safeFrom: c }
          }
          return null
        }
        for (let c = m.i; c >= nowTick + 1; c--) {
          if (!free(c) || (eatMargin && !free(c + 1))) continue
          let w0 = c
          while (w0 - 1 >= nowTick && free(w0 - 1)) w0--
          if (placedNow ? w0 > nowTick : c - w0 < 3) continue
          const clickDist = fc.path[c].head.distanceTo(ctr)
          if (clickDist > lim) return null
          if (minBlastHp > 0 && bedDamage(clickDist, minBlastSeen) < minBlastHp) return null
          return { clickI: c, safeFrom: w0 }
        }
        return null
      }
      // Ярусы прохода: ND_PASS_T1 (3.2), ND_PASS_T2 (4.6), ND_PASS_END=0 — без дальнего прохода у конца захода
      const passT1 = envNum('ND_PASS_T1', 3.2); const passT2 = envNum('ND_PASS_T2', 4.6); const passEnd = envNum('ND_PASS_END', 1)
      const tiers = [m => m.d <= passT1, m => m.d <= (started ? passT2 : Math.min(passT2, firstMax)), m => passEnd && started && fc.n - nowTick < 40]
      let pass = null; let win = null
      for (const okT of tiers) {
        for (const m of mins) { if (!okT(m)) continue; const w = windowFor(m); if (w) { pass = m; win = w; break } }
        if (pass) break
      }
      if (!pass) {
        // сядет без прохода — дальше сидячие кровати. Не раньше, чем за 6 тиков: после толчков прогноз конца
        if (fc.n - nowTick < 6) {
          if (!runnerLevels && !useAn && process.env.ND_SALVAGE !== '0' && await salvage('садится')) continue
          out.why = 'садится без прохода'; break
        }
        await sleep(40); continue
      }
      if (useAn && hereAn < 1) {
        // якорь: поставить и зарядить сейчас (дракон его не сносит), не раньше 120 мс после взрыва
        if (gameClock.now() < (lastBoom || 0) + 120) { await sleep(40); continue }
        doing(ctl, 'pillar:anchor')
        if (hereAn < 0) {
          // как кровать: к той же грани опоры K, прицел — по видимой точке (без факелов на луче)
          const K = bot.blockAt(new Vec3(plan.place.K.x, plan.place.K.y, plan.place.K.z))
          const fcl = K && faceClick(bot, bot.entity.position.offset(0, EYE, 0), K.position, plan.place.face, { avoidTorch: torchHitP })
          const it = findItem(bot, /^respawn_anchor$/)
          if (fcl && it) {
            await bot.equip(it, 'hand').catch(() => {})
            bot.setControlState('sneak', false)
            await bot.lookAt(fcl.point, true)
            await new Promise<any>(resolve => bot.once('physicsTick', resolve))
            const cur = fcl.point.minus(K.position)
            bot._client.write('block_place', { location: K.position, direction: FACE_IDX(plan.place.face), hand: 0, cursorX: cur.x, cursorY: cur.y, cursorZ: cur.z, insideBlock: false, sequence: 0, worldBorderHit: false })
            bot.swingArm()
            const tw = gameClock.now()
            while (gameClock.now() - tw < 400 && anchorAt() < 0) await sleep(20)
          }
          if (!fcl && await recenter()) continue
          if (anchorAt() < 0) { out.anFail = (out.anFail || 0) + 1; if (out.anFail > 2) { st.noAnchor = true; out.anchor = fcl ? 'не встаёт' : 'опору не видно' } continue }
        }
        const c = await chargeAnchor(bot, { H: { x: F.x, z: F.z }, yb }, 1, () => { const h = anClick(bot); return h && { ...h, block: bot.blockAt(Apos) } })
        if (!c.ok) { out.anFail = (out.anFail || 0) + 1; if (out.anFail > 3) { out.why = `якорь: ${c.why}`; break } continue }
        continue
      }
      const clickI = win.clickI; const safeFrom = win.safeFrom
      // Ставить не в начале свободного окна, а за PLACE_LEAD тиков до щелчка (st4: кровати, поставленные заранее, съедали
      // коробки дракона или они оставались у столба при «садится без прохода» — s13 −2, s14 −2 из 6). ND_PLACE_LEAD=0 — как было.
      const placeLead = envNum('ND_PLACE_LEAD', PLACE_LEAD)
      const tPlace = fc.t + 50 * (placeLead > 0 ? Math.max(safeFrom, clickI - placeLead) : safeFrom)
      // Поставленная кровать пропала до щелчка (коробки дракона, checkWalls) — потеря из бюджета (01.10: с 7
      // кроватями бой кончался на 6 взрывах в 41 из 58 вызовов — одна уходила молча, без события).
      if (!useAn && placedSince && !bedHere()) {
        placedSince = false
        out.lost = (out.lost || 0) + 1
        ev('bedLost', { ph: PHASE_RU[ph] ?? ph, tick: nowTick, n: fc.n })
        console.log(`[bed] пропала до щелчка (съели коробки дракона?), тик ${nowTick} из ${fc.n}`)
      }
      if (!useAn && !bedHere() && !placeClick) {
        if (tPlace - gameClock.now() > 120) { await sleep(Math.min(200, tPlace - gameClock.now() - 100)); continue }
        if (gameClock.now() < (lastBoom || 0) + 120) { await sleep(40); continue }
        doing(ctl, 'pillar:bed')
        const K = bot.blockAt(new Vec3(plan.place.K.x, plan.place.K.y, plan.place.K.z))
        const fcl = K && (runnerLevels && RUN_FACING() ? faceClickFacing(bot, bot.entity.position.offset(0, EYE, 0), K.position, plan.place.face, { x: H.x - F.x, z: H.z - F.z }) : faceClick(bot, bot.entity.position.offset(0, EYE, 0), K.position, plan.place.face))
        if (!fcl) {
          if (await recenter()) continue
          // станция с этого места не работает (мир не как в плане: леса, выбитый эндерняк) — перепланировать,
          // пока дракон далеко (pil8-15: «грань опоры не видно» при боте точно в окопе)
          const e = bot.entity.position.offset(0, EYE, 0)
          out.dbg = { eye: [r1(e.x), r1(e.y), r1(e.z)], K: [plan.place.K.x, plan.place.K.y, plan.place.K.z], Kname: (K || {}).name, here: !!pillarHere(bot, plan) }
          st.built = false
          out.why = 'грань опоры не видно'; break
        }
        const bedItem = findItem(bot, /_bed$/)
        await bot.equip(bedItem, 'hand').catch(() => {})
        bot.setControlState('sneak', false)
        await bot.lookAt(fcl.point, true)
        await new Promise<any>(resolve => bot.once('physicsTick', resolve))
        // сырой пакет: грань и точка — те, что видны (placeBlock сам смотрит в середину грани)
        const cur = fcl.point.minus(K.position)
        bot._client.write('block_place', { location: K.position, direction: FACE_IDX(plan.place.face), hand: 0, cursorX: cur.x, cursorY: cur.y, cursorZ: cur.z, insideBlock: false, sequence: 0, worldBorderHit: false })
        bot.swingArm()
        const tw = gameClock.now()
        while (gameClock.now() - tw < 400 && !bedHere()) await sleep(20)
        if (!bedHere()) { out.bedFail = (out.bedFail || 0) + 1; if (out.bedFail > 3) { out.why = 'кровать не встаёт'; break } continue }
        placedSince = true
      }
      // щелчок в тик прохода
      const eyeNow = bot.entity.position.offset(0, EYE, 0)
      const vBed = placeClick ? virtualBot(bot, new Map([[`${F.x},${yb},${F.z}`, 'bed'], [`${H.x},${yb},${H.z}`, 'bed']])) : bot
      const hit = useAn ? anClick(bot) : faceClick(vBed, eyeNow, new Vec3(plan.click.cell.x, yb, plan.click.cell.z), new Vec3(plan.click.face.x, plan.click.face.y, plan.click.face.z))
      // ставка в тот же миг: грань опоры K (взгляд — на неё: по горизонтали взгляда сервер кладёт изголовье)
      let pre = null
      if (placeClick && hit) {
        const Kb = bot.blockAt(new Vec3(plan.place.K.x, plan.place.K.y, plan.place.K.z))
        const fk = Kb && (runnerLevels && RUN_FACING() ? faceClickFacing(bot, eyeNow, Kb.position, plan.place.face, { x: H.x - F.x, z: H.z - F.z }) : faceClick(bot, eyeNow, Kb.position, plan.place.face))
        if (!fk) { if (await recenter()) continue; st.built = false; out.why = 'грань опоры не видно'; break }
        pre = { pos: Kb.position, face: plan.place.face, point: fk.point }
      }
      if (!hit) { if (await recenter()) continue; if (!useAn) st.built = false; out.why = useAn ? 'якорь не видно' : 'кровать не видно'; break }
      // +1 тик против L: по записи сервера (an-pilltiming.js, 90 взрывов pil2) лучший тик — на 1 позже в 81 из 90
      // 750 TPS (s5, 06.10, свидетель DragonLab, 16 взрывов): тот же +1 тик опаздывал — лучший тик раньше на 1 (медиана; −2…+1):
      // доставка и разбор пакетов — доли мс, но это 1–2 тика. На ускоренных тиках — без +1 (ND_CLICK_LEAD).
      const tClick = fc.t + 50 * (clickI + clickLead()) + envNum('ND_CLICK_OFS', -25)
      // тот же миг по ровным часам на ускоренных тиках (ND_CLICK_MONO=0 — по игровым, как раньше)
      const snNow = gameClock.snapshot(); const rateNow = snNow?.effectiveRate || snNow?.tickRate || 20
      const tClickMono = !snNow?.lockstep && rateNow > 100 && fc.monoT != null && envv('ND_CLICK_MONO') !== '0' ? fc.monoT + (clickI + clickLead() + envNum('ND_CLICK_OFS', -25) / 50) * 1000 / rateNow : null
      const dClick = clickI === pass.i ? pass.d : fc.path[clickI].head.distanceTo(ctr)
      // щёлкать — по свежему прогнозу, когда до прохода ≤ 8 тиков (на 30 тиков вперёд прогноз спирали
      // ошибается на 2–3 блока: pil1-8 — ждали 41, вышло 15)
      const aimAt = pre ? pre.point : hit.point
      // R: стрела в промежутке, пока до щелчка ≥ 1.5 с (ND_RUN_GAPARROW=1); одна попытка на промежуток
      if (runnerLevels && RUN_GAPARROW() && tClick - gameClock.now() > 1500 && gapKey !== lastBoom && bot.health >= 10 && countOf(bot, /arrow$/) > 0) {
        gapKey = lastBoom
        const ga: any = await runnerGapArrow(session, ctl, feed, P, { minHit: (lastBoom || 0) + 560, maxHit: tClick - 560, deadline: tClick - 330 })
        ;(out.gapLog || (out.gapLog = [])).push(ga.shot ? { ...ga.shot, hpAfter: ga.hpAfter } : ga.why)
        continue
      }
      if (tClick - gameClock.now() > 260) { await lookAtSafe(bot, aimAt); await sleep(30); continue }
      await lookAtSafe(bot, aimAt)
      if (pre) { const bi = findItem(bot, /_bed$/); if (!bi) { out.why = 'кровати кончились'; break } if (!bot.heldItem || !/_bed$/.test(bot.heldItem.name)) await bot.equip(bi, 'hand').catch(() => {}) }
      await new Promise<any>(resolve => bot.once('physicsTick', resolve))
      if (ctl.trace && runnerLevels) ev('clickSchedule', { rate: rateNow, game: gameClock.now(), mono: gameClock.wall.monotonic(), tClick, targetMono: tClickMono, fcT: fc.t, fcMono: fc.monoT,
        samples: feed.list.slice(-6).map(q => ({ t: q.t, mono: q.mono, tick: q.tick, n: q.n, tt: q.tt, ttMono: q.ttMono, p: [q.x, q.y, q.z], v: [q.vx, q.vy, q.vz] })) })
      const r = await bedsBoom(session, ctl, stats, { ...plan, ...(useAn ? { H: { x: F.x, z: F.z }, centre: Acentre } : {}), anchor: useAn, dist: r1(dClick), expect: bedDamage(dClick, plan.seen || 1), D: plan.a, y: yb, reuse: true }, { point: hit.point, face: runnerLevels ? plan.click.face : null, runnerGuard: runnerLevels ? () => {
        const q = bot.entity.position, f = landingForecast(feed, P) || fc
        const k = Math.max(0, Math.round((gameClock.now() - f.t) / 50))
        const dd = dragonOf(bot)
        // причина отказа — строкой (в трассу bedFail), годится — true
        if (ctl.aborted) return 'прервано'
        if (!dd || phaseOf(bot, dd) !== PHASE.LANDING) return 'фаза'
        if (k >= f.path.length) return 'прогноз кончился'
        if (!bot.entity.onGround) return 'не на земле'
        if (q.distanceTo(plan.feet) > 0.15) return `сдвинут ${r1(q.distanceTo(plan.feet) * 10) / 10}`
        if (bot.health < 10) return 'мало хп'
        // свежий прогноз в миг щелчка: голова в тик взрыва далеко (rs6-s1: прогноз 1.3, по серверу 11.1 — урон 0.3) — кровать не тратить;
        // порог с запасом (rs7-s18: вето при 3.3 на раннем тике — цепочка оборвалась, дракон сел)
        { const kc = Math.round((tClick + 25 - f.t) / 50); const st2 = f.path[Math.min(f.path.length - 1, Math.max(0, kc))]; const hd = st2 ? st2.head.distanceTo(ctr) : null; if (RUN_LATEHEAD() && hd != null && hd > Math.max(6.5, dClick + 3)) return `голова ${r1(hd)}` }
        if (landingHits({ path: f.path.slice(k, k + 3) }, q)) return 'коробки дракона'
        const v = virtualBot(bot, new Map([[`${F.x},${yb},${F.z}`, 'bed'], [`${H.x},${yb},${H.z}`, 'bed']]))
        const eye = q.offset(0, EYE, 0)
        if (!faceClick(v, eye, new Vec3(F.x, yb, F.z), plan.click.face)) return 'бок кровати не виден'
        if (!(RUN_FACING() ? faceClickFacing(bot, eye, new Vec3(plan.place.K.x, yb, plan.place.K.z), plan.place.face, { x: H.x - F.x, z: H.z - F.z }, { minCos: 0.75 }) : faceClick(bot, eye, new Vec3(plan.place.K.x, yb, plan.place.K.z), plan.place.face))) return 'грань K не видна'
        return true
      } : null, block: useAn ? bot.blockAt(Apos) : bot.blockAt(new Vec3(plan.click.cell.x, yb, plan.click.cell.z)) }, 'снижение', { aimed: true, until: Math.max(tClick, (stats.lastBoom || 0) + BED_GAP_MS), untilMono: tClickMono, uncounted: true, ...(pre ? { keepHand: true, prePlace: pre } : {}), phCheck: p => p === PHASE.LANDING, note: { ...(pre ? { pc: 1 } : {}), ...(runnerLevels ? { runnerY: yb, ...seenNote(clickI) } : {}), oc: useAn ? 'PA' : 'P', pass: clickI, headDist: r1(dClick), fcT: fc.t, fcWall: fc.wallMs, tClick, mono: tClickMono != null, ...(clickI !== pass.i ? { early: pass.i - clickI } : {}) } })
      // кровать пропала без удара по дракону и без урона нам — её снесли коробки дракона (checkWalls), взрыва
      // не было: толчка нет, прогноз — свежий (pil6-15, pil6-21: «съеденная» кровать на последнем заходе)
      const eaten = r.ok && !useAn && r.lagMs == null && !r.dmg && !r.self
      if (r.ok) placedSince = false
      out.booms.push(r.ok ? (eaten ? 'съели' : r.dmg) : null)
      if (!r.ok) (out.fails || (out.fails = [])).push(r.why)
      if (eaten) { out.eaten = (out.eaten || 0) + 1; pushed = null; continue }
      if (r.ok) {
        lastBoom = stats.lastBoom || gameClock.now()
        st.booms++
        const pf = pushedForecast(fc, clickI, ctr, plan.seen || 1, P)
        pushed = pf ? { fc: { ...pf, t: fc.t }, after: gameClock.now() + 150 } : null
      } else if (!useAn && !bedHere()) { /* снесло — следующая */ }
    }
    return out
  } finally {
    out.ms = gameClock.now() - t0
    ev('pillarRun', out)
  }
}

export {
  clickLead, pillarRun
}
