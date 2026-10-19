'use strict'
// Арена (часть arena.ts): раунд — подготовка (сброс поля, погода, выдача, телепорт, броня), бой кусками до смерти или
// вылета с ринга под сторожами (стоп, вылет, застой, предел), итог по логу сервера и машинная строка ROUND.
import * as gameClock from '../../src/game-clock'
import { roundDetail } from '../arena-metrics'
import { delta as totemDelta } from '../../src/totem'
import { A_URL, B_URL, NOTIMER, stopRequested, sleep, log, HUMANS, HUMAN, NA, NB, X, Y, Z, GENTLE, TP } from './config'
import { lagMax, A, B, cmd } from './rpc'
import { CLEAN_R, resetArena } from './build'
import { equipChecked, kitSides, enchLog, heal, alive, ACTIVE, onlineHumans, setActive } from './fighters'
import { diedIn, lostLink, deathBase, logSize, roundDeaths, where, STALL_MS, MAX_MS, RETURN_MS, GONE_MS, PREP_RATE, FIGHT_RATE, short, score } from './judge'

async function round (kit, n) {
  if (HUMANS.length) {
    setActive(await onlineHumans())
    if (!ACTIVE.length) log('людей на сервере нет — жду, пока кто-нибудь зайдёт')
    while (!ACTIVE.length && !stopRequested()) { await gameClock.wall.sleep(10000); setActive(await onlineHumans()) }
    if (!ACTIVE.length) return
    const gone = HUMANS.filter(h => !ACTIVE.includes(h))
    if (gone.length) log(`вышли: ${gone.join(', ')} — раунд без них`)
  }
  log(`=== ${kit.name}, раунд ${n} ===`)
  // Подготовка (сброс, выдача, телепорт) — на 20 TPS: ожидания арены игровые, и
  // на 750 выдача и проверка рюкзака проскакивали за десятки мс (s7 06.10:
  // «броня не наделась»). Бой — на FIGHT_RATE.
  if (PREP_RATE) await cmd(`/tick rate ${PREP_RATE}`)
  // Отвалившегося за прошлый раунд бойца — обратно на сервер.
  await A.call('connect').catch(() => {})
  if (!HUMAN) await B.call('connect').catch(() => {})
  await resetArena(kit)
  // Погода набора (трезубцы: «Тягун» — только под дождём); в чужом мире не трогаем.
  if (!GENTLE) await cmd(`/weather ${kit.weather || 'clear'}`)
  await alive(A); await alive(B)
  // Бойцы — в выживании (S7d: мир слота 29 — копия карты-паркура, режим по умолчанию «приключение»: новый боец
  // NeuroFarm29b не ставил и не ломал блоки весь базовый прогон). Ботам режим ставим и в чужом мире (это их тела).
  for (const nm of HUMAN ? [NA] : [NA, NB]) await cmd(`/gamemode survival ${nm}`)
  // Наборы раунда — с чарами (kitSides) или как в KITS.
  const sides = kitSides(kit, n)
  const t0 = gameClock.now()
  await equipChecked(A, NA, sides.a, { onBody: !!kit.onBody, offhand: kit.offhand || null })
  const t1 = gameClock.now()
  await equipChecked(B, NB, sides.b, { onBody: !!kit.onBody, offhand: kit.offhand || null })
  if (sides.ench) await enchLog(sides.ench, [t1 - t0, gameClock.now() - t1])
  // ARENA_SIDES=swap — A на восточном краю, B на западном (опыт перекоса сторон:
  // A выигрывал ~3 из 4 и со сменой демонов — роль или край поля, 2026-09-30).
  const sideA = process.env.ARENA_SIDES === 'swap' ? 6 : -6
  await cmd(`${TP} ${NA} ${X + sideA} ${Y} ${Z} ${sideA < 0 ? -90 : 90} 0`)
  if (HUMANS.length) {
    for (let i = 0; i < ACTIVE.length; i++) { await cmd(`/tp ${ACTIVE[i]} ${X + 8} ${Y} ${Z + (i - (ACTIVE.length - 1) / 2) * 4} 90 0`); await heal(ACTIVE[i]) }
    await heal(NA)
  } else {
    await cmd(`${TP} ${NB} ${X - sideA} ${Y} ${Z} ${sideA < 0 ? 90 : -90} 0`)
    await heal(NA); await heal(NB)
  }
  await sleep(1500)
  // Броня на тело — до боя, как сделал бы человек.
  // Одеться с проверкой: бот выходил на бой голым с бронёй в рюкзаке.
  const dress = async (c, who) => {
    for (let i = 0; i < 4; i++) {
      const r = await c.call('armor').catch(() => null)
      const w = r && r.detail && r.detail.worn
      if (!w || (w.torso && w.head && w.legs && w.feet)) return
      await sleep(800)
    }
    log(`${who}: броня не наделась`)
  }
  await Promise.all([dress(A, NA), HUMAN ? null : dress(B, NB)])
  await sleep(500)

  // Поле — бою (pvp.js): держать арену, когда он выпал, и возвращаться, когда выпал сам.
  const fight = { target: null, allowPlayer: true, timeoutSeconds: HUMANS.length > 1 ? 150 : 90, retreatAtHealth: 3, arena: { x: X + 0.5, y: Y, z: Z + 0.5, r: CLEAN_R } }
  // Крафт-режим: каждый сперва готовится по своей тактике и идёт в бой, как
  // только закончил, — рывок успевает напасть, пока второй за верстаком (того
  // прерывает первый же удар, и он дерётся тем, что успел).
  // Бой до конца: fight возвращается кусками (таймаут, «не вижу цель»,
  // отступил) — тогда снова в бой. Раунд кончается смертью бойца или всех его
  // противников; over общий — умер один, второго останавливаем, чтобы он не
  // гнался за возродившимся у спавна.
  const over: Record<string, any> = { done: false }
  const phys = async (c) => { const st = await c.call('status', { totem: true }).catch(() => null); const s = st && st.state; return s && s.clock && typeof s.physicsTicks === 'number' ? { p: s.physicsTicks, t: s.clock.ticks, totem: st.totem ?? st.detail?.totem ?? null } : null }
  const finishRound = () => {
    if (over.done) return false
    over.done = true
    over.end = { at: gameClock.now(), ticks: gameClock.snapshot()?.ticks ?? null, wall: gameClock.wall.now(), lag: { ...lagMax } }
    over.phys = Promise.all([phys(A), HUMAN ? null : phys(B)])
    return true
  }
  const fill = async (c, d, started) => {
    if (d.tricks || d.swings != null) return d
    await gameClock.wall.sleep(1500)
    const s = await c.call('status', { lastDuel: true }).catch(() => null)
    const ld = s && (s.lastDuel || s.detail?.lastDuel)
    if (!ld?.detail || ld.at < started || gameClock.wall.now() - ld.at > 60000) return d
    return { ...ld.detail, ...d, filled: true }
  }
  const go = async (c, me, foes, strategy, peer) => {
    if (strategy) {
      const pr = await c.call('prep', { strategy, enemy: foes[0] }).catch(e => ({ status: 'failed', error: e.message }))
      const d = pr.detail || {} as Record<string, any>
      log(`${me} [${strategy}] крафт ${d.seconds ?? '?'} с: ${(d.made || []).map(m => `${m.what}@${m.s}`).join(', ') || pr.error || pr.status}${pr.status === 'interrupted' ? ' — прервали' : ''}`)
    }
    const end = NOTIMER ? Infinity : gameClock.now() + fight.timeoutSeconds * 1000
    const dead = new Set()
    let last: Record<string, any> = { status: 'done', detail: {} as Record<string, any> }
    const segments = []
    let turn = 0
    const finish = () => { if (finishRound() && peer) peer.call('stop').catch(() => {}) }
    while (!over.done && gameClock.now() < end) {
      let left = foes.filter(f => !dead.has(f))
      if (HUMANS.length) { const on = await onlineHumans(); left = left.filter(f => on.includes(f)) }
      if (!left.length) break
      const foeNow = left[turn++ % left.length]
      const started = gameClock.wall.now()
      last = await c.call('fight', { ...fight, target: foeNow, timeoutSeconds: NOTIMER ? 300 : Math.max(5, Math.round((end - gameClock.now()) / 1000)) }).catch(e => ({ status: 'failed', error: e.message }))
      const dd = last.detail || (last.detail = {} as Record<string, any>)
      try {
        const at = diedIn(last) ? 'dead' : await where(c)
        if (at === 'dead') { dd.died = true; finish(); break }
        if ((at === 'out' || at === 'gone') && over.ringout === me) { dd.died = true; dd.ringout = true; finish(); break }
        if (lostLink(last)) { finish(); break }
        if (dd.killed) {
          // Убит не противник по раунду (зритель в выживании ударил бота, и тот
          // развернулся на него — 2026-09-26) — бой не кончен, дальше.
          const hit = String(dd.killed).split(', ').filter(k => foes.includes(k))
          for (const k of hit) dead.add(k)
          if (foes.every(f => dead.has(f))) { finish(); break }
          if (!hit.length) delete dd.killed
          continue
        }
        // Не видно / остыл / сбежал — не выбывший: пауза и следующий по кругу,
        // до конца раунда (раньше раунд обрывался на «не вижу цель»).
        await sleep(last.status === 'failed' ? 1500 : 300)
      } finally {
        last.detail = await fill(c, dd, started)
        segments.push(last.detail)
      }
    }
    if (foes.length > 1 && foes.every(f => dead.has(f))) last.detail.killed = NB
    return { ...last, detail: roundDetail(segments) }
  }
  // «хватит» в чате — посреди драки тоже: fight длится до 300 с, и ждать его
  // конца, чтобы прочитать чат, — это пять минут боя после просьбы остановиться.
  // Тот же таймер следит за вылетом: fight длится до 300 с, и узнавать после
  // него, что боец давно внизу, — поздно.
  const outSince: Record<string, any> = {} as Record<string, any>
  const hpWas: Record<string, any> = {} as Record<string, any>
  // Бой — на темпе фермы (ARENA_FIGHT_RATE, 750): часам демонов — 1.5 с
  // настоящего времени замерить новый темп до старта.
  if (FIGHT_RATE) { await cmd(`/tick rate ${FIGHT_RATE}`); await gameClock.wall.sleep(1500) }
  const vs = HUMAN ? `${NA} ${score[NA]} : ${score[NB]} вы` : `${NA} ${score[NA]} : ${score[NB]} ${NB}`
  await cmd(`/say Раунд ${n}: ${kit.name}. Счёт ${vs}. 3... 2... 1... БОЙ!`); await sleep(3000)
  let hurtAt = gameClock.now()
  const roundAt = gameClock.now()
  const tick0 = gameClock.snapshot()?.ticks ?? null
  const wall0 = gameClock.wall.now()
  // Доля физических тиков бойца за раунд (status.physicsTicks / clock.ticks):
  // при 750 TPS часы демона пропускают тики, когда CPU не успевает.
  const phys0 = await Promise.all([phys(A), HUMAN ? null : phys(B)])
  deathBase.clear()
  for (const c of HUMAN ? [A] : [A, B]) { const st = await c.call('status').catch(() => null); if (st && st.state) deathBase.set(c, st.state.lastDeathAt || null) }
  for (const k of Object.keys(lagMax)) lagMax[k] = 0
  // Human stop requests still work while ticks are frozen.
  const stopWatch = gameClock.wall.setInterval(() => {
    if (over.done || !stopRequested()) return
    finishRound()
    A.call('stop').catch(() => {})
    if (!HUMAN) B.call('stop').catch(() => {})
  }, 3000)
  const gameWatch = gameClock.setInterval(async () => {
    if (over.done) return
    for (const [c, who] of (HUMAN ? [[A, NA]] : [[A, NA], [B, NB]] as Array<any>)) {
      const got: Record<string, any> = {} as Record<string, any>
      const at = await where(c, got)
      if (got.hp !== undefined) { if (hpWas[who] !== undefined && got.hp < hpWas[who]) hurtAt = gameClock.now(); hpWas[who] = got.hp }
      if (at !== 'out' && at !== 'gone') { if (outSince[who]) log(`${who} вернулся на арену за ${Math.round((gameClock.now() - outSince[who]) / 1000)} с`); delete outSince[who]; continue }
      const limit = at === 'gone' ? GONE_MS : RETURN_MS
      if (!outSince[who]) { outSince[who] = gameClock.now(); log(at === 'gone' ? `${who} за стеной поля — ${limit / 1000} с, и вылет` : `${who} выпал с арены — ${limit / 1000} с на возвращение`) }
      if (gameClock.now() - outSince[who] > limit && !over.done) {
        finishRound()
        over.ringout = who
        log(`${who} не вернулся — вылет с ринга`)
        A.call('stop').catch(() => {})
        if (!HUMAN) B.call('stop').catch(() => {})
      }
    }
    if (!HUMAN && MAX_MS > 0 && !over.done && gameClock.now() - roundAt > MAX_MS) {
      finishRound()
      log(`раунд затянулся: ${Math.round(MAX_MS / 60000)} мин — ничья`)
      A.call('stop').catch(() => {})
      B.call('stop').catch(() => {})
    }
    if (!HUMAN && STALL_MS > 0 && !over.done && gameClock.now() - hurtAt > STALL_MS) {
      finishRound()
      log(`застой: ${Math.round(STALL_MS / 1000)} с никто не получал урона — ничья`)
      A.call('stop').catch(() => {})
      B.call('stop').catch(() => {})
    }
  }, 3000)
  const log0 = logSize()
  const [ra, rb] = await Promise.all([
    go(A, NA, HUMAN ? ACTIVE : [NB], kit.craft && kit.craft.a, HUMAN ? null : B),
    HUMAN ? Promise.resolve({ status: 'done', detail: {} as Record<string, any> }) : go(B, NB, [NA], kit.craft && kit.craft.b, A)
  ])
  finishRound()
  const phys1 = await over.phys
  gameClock.wall.clearInterval(stopWatch)
  gameClock.clearInterval(gameWatch)
  let da = ra.detail || {} as Record<string, any>
  let db = rb.detail || {} as Record<string, any>
  // Segment deltas omit reflexes between fight calls. Only round-boundary status
  // snapshots cover that interval; a missing/reconnected boundary stays unknown.
  da.totem = totemDelta(phys0[0]?.totem, phys1[0]?.totem)
  db.totem = totemDelta(phys0[1]?.totem, phys1[1]?.totem)
  log(`${NA}: ${short(ra)}`)
  log(`${NB}: ${short(rb)}`)
  // Проиграл тот, кто умер (или выпал за стену); оба — ничья.
  if (over.ringout === NA) { da.died = true; da.ringout = true }
  if (over.ringout === NB) { db.died = true; db.ringout = true }
  // Смерть — по логу сервера, когда он есть (S7d: s7d-base-28 «якоря» р.3–4 — арена записала смерть NeuroFarm28
  // без строки смерти на сервере: тотем/рывок статуса принимались за смерть, победа уходила не тому). Вылет за стену —
  // не смерть, его оставляем. Арена говорит «умер», а сервер нет — смерть не засчитана (deathUnconfirmed).
  const dl = await (async () => { await gameClock.wall.sleep(1000); return roundDeaths(log0, [NA, NB]) })()
  if (dl) {
    const died = new Set(dl.map(x => x.who))
    for (const [d, nm] of [[da, NA], [db, NB]] as Array<any>) {
      if (d.died && !d.ringout && !died.has(nm)) { d.died = false; d.deathUnconfirmed = true; log(`${nm}: арена считала смерть, в логе сервера смерти нет — не засчитана`) }
      if (!d.died && died.has(nm)) { d.died = true; d.deathFromLog = true }
    }
  }
  const winner = da.died && !db.died ? NB : db.died && !da.died ? NA : !da.died && !db.died && da.killed ? NA : null
  if (winner) score[winner]++
  else score.draw++
  log(`итог: ${winner ? 'победил ' + winner : 'ничья'} | счёт ${NA} ${score[NA]} : ${score[NB]} ${NB}, ничьих ${score.draw}`)
  // Машинная строка раунда (сводка — farm/crystal/csum.js, 2026-09-30).
  // Сводка — farm/crystal/tsum.js: частоты и урон приёмов (trickDmg), фактический TPS.
  const side = (name, d) => ({ name, died: !!d.died, ringout: !!d.ringout, deathUnconfirmed: d.deathUnconfirmed || undefined, deathFromLog: d.deathFromLog || undefined, filled: d.filled || undefined, hp: d.hp, crystal: d.crystal, totem: d.totem, quality: d.quality, search: d.search, swings: d.swings, landed: d.landed, crits: d.crits, sprintHits: d.sprintHits, arrows: d.arrows, arrowHits: d.arrowHits, mace: d.mace, elytra: d.elytra, boom: d.boom, hops: d.hops, xbow: d.xbow, rod: d.rod, util: d.util, calc: d.calc, combos: d.combos, melee: d.melee, blocks: d.blocks, blockLog: d.blockLog, shield: d.shield, vsShield: d.vsShield, storm: d.storm, breakUnder: d.breakUnder, axeOnShield: d.axeOnShield, tricks: d.tricks, trickDmg: d.trickDmg })
  const tick1 = over.end.ticks
  const share = (i) => phys0[i] && phys1[i] && phys1[i].t > phys0[i].t ? Math.round((phys1[i].p - phys0[i].p) / (phys1[i].t - phys0[i].t) * 100) / 100 : null
  const wallS = (over.end.wall - wall0) / 1000
  const tps = tick0 != null && tick1 != null && wallS > 0 ? Math.round((tick1 - tick0) / wallS) : null
  const deaths = dl
  log('ROUND ' + JSON.stringify({ kit: kit.name, n, winner, deaths, durS: Math.round((over.end.at - roundAt) / 1000), wallS: Math.round(wallS), tps, lagMax: { a: over.end.lag[A_URL] ?? null, b: over.end.lag[B_URL] ?? null }, physShare: { a: share(0), b: share(1) }, sides: process.env.ARENA_SIDES === 'swap' ? 'swap' : 'std', a: { ...side(NA, da), segments: da.segments }, b: { ...side(NB, db), segments: db.segments } }))
  await sleep(4000)
}

export { round }
