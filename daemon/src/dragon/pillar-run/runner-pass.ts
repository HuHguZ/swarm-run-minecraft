'use strict'
// Бой с драконом: бегун по столбу (pillarRun) — проход головы и окно кровати, якорь, ставка кровати заранее.
import { gameClock, Vec3, findItem, sleep, EYE, RUN_SEEN, PHASE_RU, envNum, RUN_BOX, envv, FIRST_MAX, RUN_TICKSEEN, PLACE_LEAD, RUN_FACING } from '../dig-down-to'
import { doing, r1 } from '../fall-guard'
import { bedDamage } from '../evade-raw'
import { pillarHere, smDragonSeen, SM_EMPTY, bodyBlocksBed } from '../station-plan'
import { faceClick, faceClickFacing } from '../pillar-plan'
import { FACE_IDX, chargeAnchor } from '../ts-plan'
import { type RunState, type RunTick, type Turn } from './runner-state'

export async function runPass (rs: RunState, tk: RunTick): Promise<Turn> {
  // ближайший проход головы у подушки (локальный минимум ≤ 3.2), кровать не задета до него
  tk.ctr = tk.useAn ? rs.Acentre : rs.plan.centre
  // Проход и свободное окно кровати — вместе (Codex dragon-series, 01.10: проход брался до проверки окна — первый
  const started = rs.out.booms.some(b => typeof b === 'number')
  const mins = []
  for (let i = Math.max(1, tk.minTick - 1); i < tk.fc.path.length - 1; i++) {
    const a = tk.fc.path[i - 1]; const b = tk.fc.path[i]; const c = tk.fc.path[i + 1]
    const d = b.head.distanceTo(tk.ctr)
    if (i < tk.minTick || d > a.head.distanceTo(tk.ctr) || d > c.head.distanceTo(tk.ctr)) continue
    if (d <= 6.5) mins.push({ i, d })
  }
  // Тик взрыва и когда ставить. Коробки дракона (голова/шея/тело) «съедают» кровать на клетках F/H (checkWalls): взрыв —
  const free = k => { const s2 = tk.fc.path[k]; return !s2 || !rs.cellHit(s2) }
  const placedNow = rs.bedHere()
  // ND_PLACE_CLICK: 2 (по умолчанию с 02.10) — кровать ставится и взрывается двумя пакетами в тик прохода, коробки не
  const pcMode = envv('ND_PLACE_CLICK') ?? '2'
  tk.placeClick = !tk.useAn && (pcMode === '1' || pcMode === '2') && !placedNow
  const placeClick2 = tk.placeClick && pcMode === '2'
  const firstMax = envNum('ND_FIRST_MAX', FIRST_MAX)
  const lim = started ? 6.5 : firstMax
  // ND_EAT_MARGIN=0 — кровать нужна целой только до тика взрыва c (щелчок обработан между тиками c и c + 1),
  // без запаса на поздний щелчок (лаборатория 02.10: щелчок −25 мс от конца окна — в середине тика)
  const eatMargin = envNum('ND_EAT_MARGIN', 1)
  // ND_MIN_BLAST_HP — не щёлкать в тик c, где прогнозный урон головы (bedDamage, видимость ND_MIN_BLAST_SEEN, 1 —
  // по замеру лаборатории seen p50 0.99) ниже порога: ранний «безопасный» тик слабее самого прохода (Codex dragon-blast, 02.10). 0 — выкл.
  const minBlastHp = Math.max(0, envNum('ND_MIN_BLAST_HP', 0)); const minBlastSeen = envNum('ND_MIN_BLAST_SEEN', 1)
  const windowFor = m => {
    if (tk.useAn) return { clickI: m.i, safeFrom: tk.nowTick }
    // ND_PLACE_CLICK=1: кровать ставится и взрывается двумя пакетами в одном окне тика — коробки дракона её не застают;
    // нужна только свободная клетка в тик взрыва c (сервер не ставит блок в коробку сущности)
    if (tk.placeClick) {
      for (let c = m.i; c >= tk.nowTick + 1; c--) {
        // ND_PLACE_CLICK=2 — и без проверки коробок: части дракона стройке не мешают (Entity.blocksBuilding у EnderDragonPart
        // нет; lab5: 14 неудачных ставок из 499), а checkWalls кровать, поставленную и взорванную между тиками, не застаёт
        if (placeClick2 ? false : !free(c)) continue
        // R: низ коробки родителя 16×8×16 (LivingEntity.blocksBuilding) ниже верха кровати в F — ставка не пройдёт (rs3/rs4:
        // 10 из 10 «ставка не прошла» — тело в 0.1–1.5 над ярусом кровати и снижается); раньше — тело выше
        if (RUN_BOX() && rs.runnerLevels && bodyBlocksBed(tk.fc.path[c].pos, rs.F, rs.yb)) continue
        const cd = tk.fc.path[c].head.distanceTo(tk.ctr)
        if (cd > lim) return null
        if (minBlastHp > 0 && bedDamage(cd, minBlastSeen) < minBlastHp) return null
        // R + seen: среди этого тика и до 3 более ранних (тело выше — seen больше) — наибольший прогнозный урон
        if (rs.runnerLevels && RUN_SEEN() && rs.smSnap && RUN_TICKSEEN()) {
          const extra = rs.yb > rs.P ? [[0, rs.P, rs.F.z, 1, rs.P + 1, rs.F.z + 1]] : SM_EMPTY
          let best = null
          for (let c2 = c; c2 >= Math.max(tk.nowTick + 1, c - 3, tk.minTick); c2--) {
            if (RUN_BOX() && bodyBlocksBed(tk.fc.path[c2].pos, rs.F, rs.yb)) continue
            const d2 = tk.fc.path[c2].head.distanceTo(tk.ctr)
            if (d2 > lim) break
            const sn = smDragonSeen(rs.smSnap, tk.ctr, tk.fc.path[c2].pos, extra)
            const sc = bedDamage(d2, sn == null ? 0.95 : sn)
            if (!best || sc > best.sc + 0.5) best = { c: c2, sc }
          }
          if (best) return { clickI: best.c, safeFrom: best.c }
        }
        return { clickI: c, safeFrom: c }
      }
      return null
    }
    for (let c = m.i; c >= tk.nowTick + 1; c--) {
      if (!free(c) || (eatMargin && !free(c + 1))) continue
      let w0 = c
      while (w0 - 1 >= tk.nowTick && free(w0 - 1)) w0--
      if (placedNow ? w0 > tk.nowTick : c - w0 < 3) continue
      const clickDist = tk.fc.path[c].head.distanceTo(tk.ctr)
      if (clickDist > lim) return null
      if (minBlastHp > 0 && bedDamage(clickDist, minBlastSeen) < minBlastHp) return null
      return { clickI: c, safeFrom: w0 }
    }
    return null
  }
  // Ярусы прохода: ND_PASS_T1 (3.2), ND_PASS_T2 (4.6), ND_PASS_END=0 — без дальнего прохода у конца захода
  const passT1 = envNum('ND_PASS_T1', 3.2); const passT2 = envNum('ND_PASS_T2', 4.6); const passEnd = envNum('ND_PASS_END', 1)
  const tiers = [m => m.d <= passT1, m => m.d <= (started ? passT2 : Math.min(passT2, firstMax)), m => passEnd && started && tk.fc.n - tk.nowTick < 40]
  tk.pass = null; tk.win = null
  for (const okT of tiers) {
    for (const m of mins) { if (!okT(m)) continue; const w = windowFor(m); if (w) { tk.pass = m; tk.win = w; break } }
    if (tk.pass) break
  }
  if (!tk.pass) {
    // сядет без прохода — дальше сидячие кровати. Не раньше, чем за 6 тиков: после толчков прогноз конца
    if (tk.fc.n - tk.nowTick < 6) {
      if (!rs.runnerLevels && !tk.useAn && process.env.ND_SALVAGE !== '0' && await rs.salvage('садится')) return 'next'
      rs.out.why = 'садится без прохода'; return 'stop'
    }
    await sleep(40); return 'next'
  }
}

export async function runAnchor (rs: RunState, tk: RunTick): Promise<Turn> {
  const { bot, ctl } = rs
  if (tk.useAn && tk.hereAn < 1) {
    // якорь: поставить и зарядить сейчас (дракон его не сносит), не раньше 120 мс после взрыва
    if (gameClock.now() < (rs.lastBoom || 0) + 120) { await sleep(40); return 'next' }
    doing(ctl, 'pillar:anchor')
    if (tk.hereAn < 0) {
      // как кровать: к той же грани опоры K, прицел — по видимой точке (без факелов на луче)
      const K = bot.blockAt(new Vec3(rs.plan.place.K.x, rs.plan.place.K.y, rs.plan.place.K.z))
      const fcl = K && faceClick(bot, bot.entity.position.offset(0, EYE, 0), K.position, rs.plan.place.face, { avoidTorch: rs.torchHitP })
      const it = findItem(bot, /^respawn_anchor$/)
      if (fcl && it) {
        await bot.equip(it, 'hand').catch(() => {})
        bot.setControlState('sneak', false)
        await bot.lookAt(fcl.point, true)
        await new Promise<any>(resolve => bot.once('physicsTick', resolve))
        const cur = fcl.point.minus(K.position)
        bot._client.write('block_place', { location: K.position, direction: FACE_IDX(rs.plan.place.face), hand: 0, cursorX: cur.x, cursorY: cur.y, cursorZ: cur.z, insideBlock: false, sequence: 0, worldBorderHit: false })
        bot.swingArm()
        const tw = gameClock.now()
        while (gameClock.now() - tw < 400 && rs.anchorAt() < 0) await sleep(20)
      }
      if (!fcl && await rs.recenter()) return 'next'
      if (rs.anchorAt() < 0) { rs.out.anFail = (rs.out.anFail || 0) + 1; if (rs.out.anFail > 2) { rs.st.noAnchor = true; rs.out.anchor = fcl ? 'не встаёт' : 'опору не видно' } return 'next' }
    }
    const c = await chargeAnchor(bot, { H: { x: rs.F.x, z: rs.F.z }, yb: rs.yb }, 1, () => { const h = rs.anClick(bot); return h && { ...h, block: bot.blockAt(rs.Apos) } })
    if (!c.ok) { rs.out.anFail = (rs.out.anFail || 0) + 1; if (rs.out.anFail > 3) { rs.out.why = `якорь: ${c.why}`; return 'stop' } return 'next' }
    return 'next'
  }
}

export async function runPlace (rs: RunState, tk: RunTick): Promise<Turn> {
  const { bot, ctl } = rs
  tk.clickI = tk.win.clickI; const safeFrom = tk.win.safeFrom
  // Ставить не в начале свободного окна, а за PLACE_LEAD тиков до щелчка (st4: кровати, поставленные заранее, съедали
  // коробки дракона или они оставались у столба при «садится без прохода» — s13 −2, s14 −2 из 6). ND_PLACE_LEAD=0 — как было.
  const placeLead = envNum('ND_PLACE_LEAD', PLACE_LEAD)
  const tPlace = tk.fc.t + 50 * (placeLead > 0 ? Math.max(safeFrom, tk.clickI - placeLead) : safeFrom)
  // Поставленная кровать пропала до щелчка (коробки дракона, checkWalls) — потеря из бюджета (01.10: с 7
  // кроватями бой кончался на 6 взрывах в 41 из 58 вызовов — одна уходила молча, без события).
  if (!tk.useAn && rs.placedSince && !rs.bedHere()) {
    rs.placedSince = false
    rs.out.lost = (rs.out.lost || 0) + 1
    rs.ev('bedLost', { ph: PHASE_RU[tk.ph] ?? tk.ph, tick: tk.nowTick, n: tk.fc.n })
    console.log(`[bed] пропала до щелчка (съели коробки дракона?), тик ${tk.nowTick} из ${tk.fc.n}`)
  }
  if (!tk.useAn && !rs.bedHere() && !tk.placeClick) {
    if (tPlace - gameClock.now() > 120) { await sleep(Math.min(200, tPlace - gameClock.now() - 100)); return 'next' }
    if (gameClock.now() < (rs.lastBoom || 0) + 120) { await sleep(40); return 'next' }
    doing(ctl, 'pillar:bed')
    const K = bot.blockAt(new Vec3(rs.plan.place.K.x, rs.plan.place.K.y, rs.plan.place.K.z))
    const fcl = K && (rs.runnerLevels && RUN_FACING() ? faceClickFacing(bot, bot.entity.position.offset(0, EYE, 0), K.position, rs.plan.place.face, { x: rs.H.x - rs.F.x, z: rs.H.z - rs.F.z }) : faceClick(bot, bot.entity.position.offset(0, EYE, 0), K.position, rs.plan.place.face))
    if (!fcl) {
      if (await rs.recenter()) return 'next'
      // станция с этого места не работает (мир не как в плане: леса, выбитый эндерняк) — перепланировать,
      // пока дракон далеко (pil8-15: «грань опоры не видно» при боте точно в окопе)
      const e = bot.entity.position.offset(0, EYE, 0)
      rs.out.dbg = { eye: [r1(e.x), r1(e.y), r1(e.z)], K: [rs.plan.place.K.x, rs.plan.place.K.y, rs.plan.place.K.z], Kname: (K || {}).name, here: !!pillarHere(bot, rs.plan) }
      rs.st.built = false
      rs.out.why = 'грань опоры не видно'; return 'stop'
    }
    const bedItem = findItem(bot, /_bed$/)
    await bot.equip(bedItem, 'hand').catch(() => {})
    bot.setControlState('sneak', false)
    await bot.lookAt(fcl.point, true)
    await new Promise<any>(resolve => bot.once('physicsTick', resolve))
    // сырой пакет: грань и точка — те, что видны (placeBlock сам смотрит в середину грани)
    const cur = fcl.point.minus(K.position)
    bot._client.write('block_place', { location: K.position, direction: FACE_IDX(rs.plan.place.face), hand: 0, cursorX: cur.x, cursorY: cur.y, cursorZ: cur.z, insideBlock: false, sequence: 0, worldBorderHit: false })
    bot.swingArm()
    const tw = gameClock.now()
    while (gameClock.now() - tw < 400 && !rs.bedHere()) await sleep(20)
    if (!rs.bedHere()) { rs.out.bedFail = (rs.out.bedFail || 0) + 1; if (rs.out.bedFail > 3) { rs.out.why = 'кровать не встаёт'; return 'stop' } return 'next' }
    rs.placedSince = true
  }
}
