'use strict'
// Застревание: детектор, память отказов между goto, наблюдатель на весь переход, освободиться здесь.
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { waterB, at, sleepReal, towardOf, diagnose, ladder } from './diagnose'
import { RUNGS } from './rungs'

// ------------------------------------------------------------------ детектор
// Застревание при живой цели: (а) still — за stillMs тело не сдвинулось на minMove; (б) noprogress — за progressMs
// эвристика цели не улучшилась на 1.5, а тело топчется в радиусе roam; (в) dig — одна и та же копка дольше digMs.
// Не застревание: идёт поиск (последний path_update — 'partial' с пустым путём, свежий), pathfinder копает/ставит,
// исполнитель моста/спуска держит своё (bot._ndBridgeExec).
export function createDetector (bot, { goal = null, stillMs = 3000, minMove = 0.4, progressMs = 20000, roam = 5, digMs = 10000, buildMs = 6000, now = () => gameClock.now() }: any = {}) {
  let anchor = null; let anchorT = 0
  let best = Infinity; let bestT = 0; let roamAt = null
  let lastPath = null; let lastPathT = 0; let lastPartialT = -Infinity
  let digKey = null; let digT = 0
  let buildT = 0
  const h = () => {
    if (!goal || typeof goal.heuristic !== 'function') return null
    const p = bot.entity.position
    try { return goal.heuristic({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }) } catch { return null }
  }
  const reset = () => {
    const t = now()
    anchor = bot.entity.position.clone(); anchorT = t
    const v = h(); best = v == null ? Infinity : v; bestT = t; roamAt = anchor.clone()
    digKey = null; buildT = 0
  }
  reset()
  return {
    reset,
    feed (r) { if (r) { lastPath = { status: r.status, len: Array.isArray(r.path) ? r.path.length : 0 }; lastPathT = now(); if (r.status === 'partial') lastPartialT = lastPathT } },
    check () {
      const t = now()
      const e = bot.entity
      if (!e) return null
      const p = e.position
      // Цель ближе — прогресс.
      const v = h()
      if (v != null && v < best - 1.5) { best = v; bestT = t; roamAt = p.clone() }
      if (roamAt && p.distanceTo(roamAt) > roam) { roamAt = p.clone(); bestT = t; if (v != null) best = Math.min(best, v) }
      // В воде тело качается вверх-вниз на полблока — сдвиг там считаем по горизонтали.
      const wet = !!e.isInWater || waterB(at(bot, p.floored()))
      const moved = wet ? Math.hypot(p.x - anchor.x, p.z - anchor.z) : p.distanceTo(anchor)
      if (moved > minMove) { anchor = p.clone(); anchorT = t; digKey = null; buildT = 0 }
      // Поиск идёт — стоять можно.
      const searching = !lastPath || (lastPath.status === 'partial' && lastPath.len === 0 && t - lastPathT < 1500)
      let mining = false; let building = false
      try { mining = !!(bot.pathfinder && bot.pathfinder.isMining && bot.pathfinder.isMining()) } catch {}
      try { building = !!(bot.pathfinder && bot.pathfinder.isBuilding && bot.pathfinder.isBuilding()) } catch {}
      const exec = bot._ndBridgeExec
      const blockWork = !!(exec && (exec.seg || exec.desc || (exec.queue && exec.queue.length)))
      if (mining) {
        const tb = bot.targetDigBlock
        const k = tb && tb.position ? `${tb.position.x},${tb.position.y},${tb.position.z}` : 'none'
        if (k !== digKey) { digKey = k; digT = t }
        anchorT = t
        if (t - digT > digMs) return { kind: 'dig', ms: t - digT }
        return null
      }
      if (building || blockWork) {
        if (!buildT) buildT = t
        anchorT = t
        if (t - buildT > buildMs) return { kind: 'still', ms: t - buildT, why: 'стройка без сдвига' }
        return null
      }
      if (searching) { anchorT = t; return null }
      if (t - anchorT >= stillMs) return { kind: 'still', ms: t - anchorT }
      // Поиск A* идёт (свежий 'partial', с путём или без) — топтание у старта не застревание: тело ходит по частичным
      // путям, пока ищется обход (лавовое озеро на стенде mv-gap: 40–55 с у старта, и поиск доходил; перестройка
      // каждые 20 с его обнуляла — us-reg-gap: озеро 1/4 вместо 4/4).
      if (t - lastPartialT < 2500) { bestT = t; return null }
      if (t - bestT >= progressMs) return { kind: 'noprogress', ms: t - bestT }
      return null
    }
  }
}

// ------------------------------------------------------------------ память отказов (между вызовами goto)
// Один и тот же отказ поиска в той же точке: кампания звала goto 6801 раз за 5 мин у ямы под лавой (neF-S26-1).
const memory = new WeakMap()
export function noteRefusal (bot, kind, pos, t = gameClock.now()) {
  let m = memory.get(bot)
  if (!m) { m = []; memory.set(bot, m) }
  m.push({ kind, pos: pos.clone ? pos.clone() : new Vec3(pos.x, pos.y, pos.z), t })
  while (m.length > 40 || (m.length && t - m[0].t > 120000)) m.shift()
  return m.filter(r => r.pos.distanceTo(pos) <= 2.5 && t - r.t <= 90000).length
}

// ------------------------------------------------------------------ наблюдатель на весь переход (session.goto)
// watch(session, ctl, { deadline }) → { attach(bot, goal, { resume, fail }) → handle, stats, report() }.
// handle (на один gotoGoal): busy() — идёт ступень (gotoGoal не реагирует на свои setGoal(null)); refused(r) — отказ поиска:
// true — забрали себе (ступень и resume/fail), false — пусть gotoGoal отвечает как раньше; stop().
export function watch (session, ctl, { deadline = Infinity, maxRungs = 7, maxTotal = 30, log = console.log, now = () => gameClock.now(), sleep = sleepReal, tickMs = 250, detector = {} }: any = {}) {
  const st = { detected: 0, refusals: 0, rungs: [], freed: 0, gaveUp: null, cls: {} }
  let spot = null; let tried = []; let spotH = null; let total = 0
  // Лестница в этой точке исчерпана — до конца перехода не вмешиваемся (дальше прежний goto: сторож 8 с, рывки, план XZ).
  let exhausted = false
  let current = null
  const deadlineOk = () => now() < deadline - 2000
  const report = () => ({ detected: st.detected, refusals: st.refusals, rungs: st.rungs.map(r => `${r.cls}:${r.rung}${r.applied ? '' : '-'}`), gaveUp: st.gaveUp || undefined })

  function attach (bot, goal, { resume, fail }: any) {
    if (exhausted) return { busy: () => false, refused: () => false, stop () {} }
    const det = createDetector(bot, { goal, now, ...detector })
    let busy = false
    let stopped = false
    const onPath = r => det.feed(r)
    bot.on('path_update', onPath)
    const timer = gameClock.setInterval(() => {
      if (busy || stopped || (ctl && ctl.aborted)) return
      let v = null
      try { v = det.check() } catch {}
      if (v) escape(v.kind, v).catch(() => {})
    }, tickMs)
    // Прерывание посреди ступени: gotoGoal свои события в это время не слушает — отпустить его отказом, иначе промис и
    // его слушатели на теле повисли бы навсегда.
    if (ctl && ctl.onAbort) ctl.onAbort.push(() => { const was = busy && !stopped; stop(); if (was) { try { fail(Object.assign(new Error('прервано посреди выхода из застревания'), { name: 'Aborted' })) } catch {} } })

    async function escape (kind, info: any = {}) {
      busy = true
      try {
        try { bot.pathfinder.setGoal(null) } catch {}
        try { bot.clearControlStates() } catch {}
        const pos = bot.entity.position.clone()
        // Новое место — лестница заново: ушли от точки начала на 3+ или стали ближе к цели на 0.9+ (штрек руками к цели
        // по блоку за ступень — каждая ступень с продвижением открывает следующую). Всего ступеней на переход — maxTotal.
        const hNow = (() => { try { return goal.heuristic({ x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }) } catch { return null } })()
        if (!spot || pos.distanceTo(spot) > 3 || (hNow != null && spotH != null && hNow < spotH - 0.9)) { spot = pos; spotH = hNow; tried = [] }
        if (kind === 'refused') st.refusals++
        else st.detected++
        // До 3 ступеней подряд, если ступень «не применилась» (нечего ломать, не в яме) — следующая сразу.
        for (let i = 0; i < 4; i++) {
          if (stopped || (ctl && ctl.aborted)) return
          const toward = towardOf(bot, goal, session && session.pathNodes)
          const d: any = diagnose(bot, toward)
          st.cls[d.cls] = (st.cls[d.cls] || 0) + 1
          const rungs = ladder(d.cls, kind === 'refused' ? 'refused' : 'still', info.status).filter(r => !tried.includes(r))
          if (!rungs.length || tried.length >= maxRungs || total >= maxTotal || !deadlineOk()) {
            exhausted = true
            // Поиск отказал в открытом месте, а лестнице помочь нечем — ответ goto прежний (повторы, план XZ) — рельеф,
            // us-reg-terr: «застрял (open) … пути нет» за 18 с там, где прежний goto доходил.
            if (kind === 'refused' && info.answer && !['dig-flag', 'buried', 'water', 'enclosed', 'lava'].includes(d.cls)) {
              log('[unstuck] отдаю', JSON.stringify({ cls: d.cls, tried: tried.slice() }))
              stopped = true
              info.answer()
              return
            }
            st.gaveUp = { cls: d.cls, at: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }, kind, tried: tried.slice(), facts: { feet: d.feet, head: d.head, ground: d.ground, front: d.front } }
            log('[unstuck] отказ', JSON.stringify(st.gaveUp))
            stopped = true
            const err = Object.assign(new Error(`застрял (${d.cls}) у ${st.gaveUp.at.x},${st.gaveUp.at.y},${st.gaveUp.at.z}: ${kind === 'refused' ? 'пути нет' : 'не сдвигаюсь'}; испробовано: ${tried.join(', ') || 'ничего'}`), { code: 'STUCK', unstuck: st.gaveUp })
            fail(err)
            return
          }
          const rung = rungs[0]
          tried.push(rung)
          total++
          const t0 = now()
          let res = { applied: false, why: 'ошибка' }
          try { res = await RUNGS[rung]({ bot, session, ctl, toward, goal, diag: d, mcData: session && session.mcData, sleep, deadline, now }) || res } catch (err) { res = { applied: false, why: String(err && err.message || err).slice(0, 80) } }
          st.rungs.push({ cls: d.cls, rung, applied: !!res.applied, ms: now() - t0 })
          log('[unstuck]', JSON.stringify({ kind, cls: d.cls, rung, applied: !!res.applied, why: res.why, ms: now() - t0, pos: d.pos, feet: d.feet, head: d.head, ground: d.ground, front: d.front, info: info.ms ? info.ms : undefined }))
          if (res.applied) break
        }
        if (stopped || (ctl && ctl.aborted)) return
        det.reset()
        busy = false
        try { resume() } catch {}
      } finally {
        if (!stopped) busy = false
      }
    }

    let detached = false
    function stop () {
      if (detached) return
      detached = true
      stopped = true
      gameClock.clearInterval(timer)
      bot.removeListener('path_update', onPath)
    }

    current = {
      busy: () => busy,
      // Отказ поиска (r — path_update): пусто/нет пути/таймаут не у цели. Берём себе, если тело в «ловушке» (завалило,
      // вода, яма, стена к цели, флаг копки) или отказ в этой точке повторяется (≥ 2 за 90 с, и между вызовами goto).
      refused (r, answer) {
        if (busy || stopped || (ctl && ctl.aborted)) return busy
        if (!bot.entity) return false
        const toward = towardOf(bot, goal, null)
        const d: any = diagnose(bot, toward)
        const n = noteRefusal(bot, r && r.status, bot.entity.position, now())
        const trap = ['dig-flag', 'buried', 'water', 'enclosed', 'wall', 'lava'].includes(d.cls)
        const far = !!toward && Math.hypot(toward.x - bot.entity.position.x, toward.z - bot.entity.position.z) >= 20
        if (!trap && n < 2 && !(r && r.status === 'timeout' && far)) return false
        if (!deadlineOk()) return false
        escape('refused', { status: r && r.status, repeats: n, answer }).catch(() => {})
        return true
      },
      stop
    }
    return current
  }

  return { attach, stats: st, report, exhausted: () => exhausted }
}

// Есть ли сухой берег вплавь (movement.findSwimRoute — путь по клеткам воды до опоры).
export function landBySwim (bot) {
  try { const r = (require('../movement') as typeof import('../movement')).findSwimRoute(bot); return !!r && r.kind === 'land' } catch { return true }
}

// Один заход лестницы вне goto (для этапов: штрек, колодец, подъём): до maxRungs ступеней, пока тело не сдвинется на 1.5.
export async function freeHere (session, ctl, { toward = null, maxRungs = 5, log = console.log }: any = {}) {
  const bot = session.bot
  const p0 = bot.entity.position.clone()
  const tried = []
  for (let i = 0; i < maxRungs && !(ctl && ctl.aborted); i++) {
    const d: any = diagnose(bot, toward)
    const rung = ladder(d.cls).find(r => !tried.includes(r))
    if (!rung) break
    tried.push(rung)
    let res
    try { res = await RUNGS[rung]({ bot, session, ctl, toward, diag: d, mcData: session.mcData, sleep: sleepReal }) } catch (err) { res = { applied: false, why: err.message } }
    log('[unstuck] free', JSON.stringify({ cls: d.cls, rung, applied: !!(res && res.applied), why: res && res.why }))
    if (bot.entity.position.distanceTo(p0) >= 1.5) return { ok: true, cls: d.cls, tried }
  }
  const d: any = diagnose(bot, toward)
  return { ok: bot.entity.position.distanceTo(p0) >= 1.5, cls: d.cls, tried }
}
