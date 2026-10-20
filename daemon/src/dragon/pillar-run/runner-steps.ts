'use strict'
// Бой с драконом: бегун по столбу (pillarRun) — шаги оборота до выбора прохода: дракон и фаза, заряды, хп и якорь,
// прогноз снижения, ярус кровати у R. Порядок — RUN_STEPS в runner.ts.
import { gameClock, Vec3, sleep, dragonOf, phaseOf, PHASE, SITTING, RUN_SEEN, PHASE_RU, hpOf, RUN_ARROW, envNum, RUN_KEEPCOB, isAirish, RUN_BOX, RUN_HIGH } from '../dig-down-to'
import { hunters, doing, r1 } from '../fall-guard'
import { countOf, landingForecast, landingHits, bedDamage } from '../evade-raw'
import { smDragonSeen, SM_EMPTY, runnerArrow, runnerSupport, bodyBlocksBed } from '../station-plan'
import { BED_GAP_MS } from '../pillar-plan'
import { type RunState, type RunTick, type Turn } from './runner-state'

export async function runPhase (rs: RunState, tk: RunTick): Promise<Turn> {
  const { bot } = rs
  tk.dd = dragonOf(bot)
  if (!tk.dd) { rs.out.why = 'дракона нет'; return 'stop' }
  tk.ph = phaseOf(bot, tk.dd)
  if (tk.ph !== PHASE.LANDING) {
    rs.out.why = `фаза ${PHASE_RU[tk.ph] ?? tk.ph}`
    if (!rs.runnerLevels && SITTING.has(tk.ph) && process.env.ND_SALVAGE !== '0') await rs.salvage('сел')
    return 'stop'
  }
}

export async function runBeds (rs: RunState, tk: RunTick): Promise<Turn> {
  const { bot, ctl, session, feed } = rs
  if (rs.noBoom()) {
    // R: кровати кончились, а дракон ещё снижается и хп мало — стрела в проход головы (ND_RUN_ARROW=0 — выкл.)
    const hpNow = hpOf(bot, tk.dd)
    if (rs.runnerLevels && RUN_ARROW() && hpNow != null && hpNow <= envNum('ND_RUN_ARROW_HP', 30) && (rs.out.arrows || 0) < 3) {
      rs.out.arrows = (rs.out.arrows || 0) + 1
      doing(ctl, 'pillar:arrow')
      const a: any = await runnerArrow(session, ctl, feed, rs.P, rs.lastBoom)
      ;(rs.out.arrowLog || (rs.out.arrowLog = [])).push(a.shot ? { ...a.shot, hpAfter: a.hpAfter } : a.why)
      return 'next'
    }
    rs.out.why = 'кровати кончились'; return 'stop'
  }
}

export async function runVitals (rs: RunState, tk: RunTick): Promise<Turn> {
  const { bot } = rs
  if ((hpOf(bot, tk.dd) ?? 1) <= 0) return 'stop'
  if (bot.health < 10 && hunters(bot, 5).length) { rs.out.why = 'эндермен бьёт'; return 'stop' }
  tk.hereAn = rs.anchorAt()
  tk.useAn = tk.hereAn >= 0 || (!rs.bedHere() && rs.anchorOk() && (rs.anMode === 'first' || countOf(bot, /_bed$/) < 1))
  if (tk.hereAn === 0 && countOf(bot, /^glowstone$/) < 1) { rs.out.why = 'якорь без заряда'; return 'stop' }
}

export async function runForecast (rs: RunState, tk: RunTick): Promise<Turn> {
  const { feed } = rs
  // прогноз: свежий по пакетам, а сразу после взрыва — с толчком
  tk.fc = landingForecast(feed, rs.P)
  if (rs.pushed && (!tk.fc || tk.fc.t < rs.pushed.after)) tk.fc = rs.pushed.fc
  if (!tk.fc) { await sleep(20); return 'next' }
  rs.fcNow = tk.fc
  tk.nowTick = Math.round((gameClock.now() - tk.fc.t) / 50)
  tk.minTick = Math.max(tk.nowTick + 3, Math.ceil((rs.lastBoom + BED_GAP_MS + 60 - tk.fc.t) / 50))
}

export async function runLevels (rs: RunState, tk: RunTick): Promise<Turn> {
  const { bot } = rs
  if (rs.runnerLevels) {
    const q = bot.entity.position
    // толчок своего взрыва сдвигает в чаше (labR: 27 из 30 цепочек обрывались после первого взрыва) — вернуться в клетку
    if (bot.health < 10) { rs.out.why = 'R: мало хп'; return 'stop' }
    // без проверки exposure: первый взрыв сносит факелы столба, клиентский exposure считал их заслоном и рвал цепочку
    // (labR2: 16 из 17), а урон боту в чаше по серверу 0.3 за снижение
    if (!bot.entity.onGround || q.distanceTo(rs.plan.feet) > 0.25) { if (await rs.recenter()) return 'next'; rs.out.why = 'R: потеря защищённой позиции'; return 'stop' }
    const danger = landingHits({ path: tk.fc.path.slice(Math.max(0, tk.nowTick), tk.nowTick + 4) }, q)
    if (danger) { rs.out.why = 'R: ' + danger.what; return 'stop' }
    // Опора под F для P + 1 — сразу после взрыва, если её снесло (labS1: P + 1 выбран лишь в 43 % взрывов — к проходу булыжник
    if (RUN_KEEPCOB() && rs.keepKey !== rs.lastBoom && !rs.bedHere() && rs.runnerLevels.some(p => p.yb > rs.P) && gameClock.now() - (rs.lastBoom || 0) > 120 && !rs.supBan.has('keep')) {
      rs.keepKey = rs.lastBoom
      const sb = bot.blockAt(new Vec3(0, rs.P, rs.F.z))
      if (isAirish(sb) && !landingHits({ path: tk.fc.path.slice(Math.max(0, tk.nowTick), tk.nowTick + 8) }, q)) {
        const ok = await runnerSupport(bot, { ...rs.plan, P: rs.P }, 1)
        rs.out.keepCob = (rs.out.keepCob || 0) + 1
        if (!ok) { rs.supBan.set('keep', true); (rs.out.supWhy || (rs.out.supWhy = [])).push('держать: ' + runnerSupport.why) }
        return 'next'
      }
    }
    if (!rs.bedHere()) {
      const rej = {}
      const choices = rs.runnerLevels.map(p => {
        let i = -1, dist = Infinity
        for (let k = tk.minTick; k < tk.fc.path.length - 1; k++) {
          const d = tk.fc.path[k].head.distanceTo(p.centre)
          if (d > tk.fc.path[k - 1].head.distanceTo(p.centre) || d > tk.fc.path[k + 1].head.distanceTo(p.centre)) continue
          if (d < dist) { i = k; dist = d }
        }
        // коробка родителя закроет F в тик прохода — ближайший ранний тик, где не закрывает (тело выше), с его расстоянием
        if (RUN_BOX() && i >= 0 && bodyBlocksBed(tk.fc.path[i].pos, p.F, p.yb)) {
          let c = i
          while (c > tk.minTick && bodyBlocksBed(tk.fc.path[c].pos, p.F, p.yb)) c--
          if (bodyBlocksBed(tk.fc.path[c].pos, p.F, p.yb) || tk.fc.path[c].head.distanceTo(p.centre) > 4.6) { i = -1; rej[p.yb - rs.P] = 'коробка' } else { i = c; dist = tk.fc.path[c].head.distanceTo(p.centre) }
        } else if (i < 0) rej[p.yb - rs.P] = 'нет прохода'
        let score = null
        if (RUN_SEEN() && i >= 0 && rs.smSnap) {
          const extra = p.yb > rs.P ? [[0, rs.P, rs.F.z, 1, rs.P + 1, rs.F.z + 1]] : SM_EMPTY
          const key = `${p.yb}|${r1(tk.fc.path[i].pos.x)}|${r1(tk.fc.path[i].pos.y)}|${r1(tk.fc.path[i].pos.z)}`
          let seen = rs.smCache.get(key)
          if (seen === undefined) { seen = smDragonSeen(rs.smSnap, p.centre, tk.fc.path[i].pos, extra); rs.smCache.set(key, seen) }
          score = seen == null ? null : bedDamage(dist, seen)
        }
        return { p, i, dist, score }
      }).filter(c => {
        if (c.i < 0) return false
        const b = bot.blockAt(new Vec3(0, rs.P, rs.F.z))
        const ready = c.p.yb > rs.P ? (b || {}).name === 'cobblestone' : isAirish(b)
        // ярус, опору которого только что не удалось подготовить, — не раньше, чем через 2.5 с (rs3-s2: цепочка рвалась)
        if (!ready && rs.supBan.has(c.p.yb) && gameClock.now() < rs.supBan.get(c.p.yb)) { rej[c.p.yb - rs.P] = 'бан'; return false }
        if (!ready && c.i - tk.nowTick < 20) { rej[c.p.yb - rs.P] = `не готов (${c.i - tk.nowTick} т.)`; return false }
        return true
      }).sort((a, b) => (a.score != null && b.score != null ? b.score - a.score : 0) || (RUN_HIGH() ? b.p.yb - a.p.yb : 0) || a.dist - b.dist)
      const best = choices[0]
      if (!best) { await sleep(30); return 'next' }
      if (best) {
        const support = bot.blockAt(new Vec3(0, rs.P, rs.F.z)), dy = best.p.yb - rs.P
        const ready = dy ? (support || {}).name === 'cobblestone' : isAirish(support)
        if (!ready) {
          // Окно подготовки — не менее 20 тиков, без коробок на всём этом интервале.
          if (best.i - tk.nowTick < 20 || landingHits({ path: tk.fc.path.slice(Math.max(0, tk.nowTick), tk.nowTick + 20) }, q)) { await sleep(30); return 'next' }
          // 02.10 (rs3-s2: «R: опора не подтверждена» рвал цепочку после 2 взрывов, и второй заход — сразу): не рвать — на 2.5 с
          // этот ярус не брать, взять готовый (на P опоре быть воздухом — после взрыва булыжник обычно снесён)
          if (!await runnerSupport(bot, rs.plan, dy)) { rs.out.supFail = (rs.out.supFail || 0) + 1; (rs.out.supWhy || (rs.out.supWhy = [])).push(runnerSupport.why); rs.supBan.set(best.p.yb, gameClock.now() + 2500); if (rs.out.supFail > 6) { rs.out.why = 'R: опора не подтверждена'; return 'stop' } return 'next' }
          return 'next' // после await только свежий landingForecast/pushedForecast
        }
        rs.plan = { ...best.p, runnerLevels: rs.runnerLevels }; rs.st.plan = rs.plan
        rs.H = rs.plan.H; rs.F = rs.plan.F; rs.yb = rs.plan.yb
        rs.bedCells.splice(0, rs.bedCells.length, rs.F, rs.H)
        const heightRec = { y: rs.yb, headY: r1(tk.fc.path[best.i].head.y * 10) / 10, pass: best.i, dist: r1(best.dist * 10) / 10, alt: choices.length > 1 ? r1(choices[1].dist * 10) / 10 : null, ...(Object.keys(rej).length ? { rej } : {}) }
        // запись — только когда выбор сменился (rs1: 149 одинаковых событий на цепочку)
        const rhKey = `${heightRec.y}|${heightRec.pass}`
        if (rhKey !== rs.out.rhKey) { rs.out.rhKey = rhKey; (rs.out.runnerHeights || (rs.out.runnerHeights = [])).push(heightRec); rs.ev('runnerHeight', heightRec) }
      }
    }
  }
}
