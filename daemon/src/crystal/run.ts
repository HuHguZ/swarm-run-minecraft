'use strict'
// Кристаллы (crystal.ts): исполнение плана — run (замер, лог) и runBody по виду действия: защита (сбить, отход, щит,
// укрытие, блок между), удар (рукой, стрелой, поставить и ударить, обсидиан под кристалл), якорь, прочее (держать
// место, починка, еда, обсидиан вокруг ног). Каждый шаг: своё действие — out, чужое — null.

import { P, EYE, HIT_R, TICK, IFRAME_MS, ANCHOR_P, r1, crystalBox, boxDist, isAirB, pickBlockers, faceFor, losClear } from './geometry'
import { effHp, countOf, armorWear } from './scoring'
import type { CrystalDeps, CrystalState } from './state'

// Защита: сбить его кристалл, отход, щит, укрытие, блок между.
async function runDefense (S: CrystalState, deps: CrystalDeps, ctl, a, ctx, out, foe) {
  const { bot, st, enemy, guard, anchorsAt, anchorSeen, cellKey, fail, inWin, hurtAt, wallItem, toHotbar, hit, backOff, moveTo, freshWorth } = S
  const { gameClock, boom, sleep } = deps
  if (a.kind === 'defuse') {
    // Заново на этот миг: мои хп и броня, окно ещё идёт (для «free»), размен (для «trade»).
    {
      const f = enemy()
      const dMe = boom.defenseOf(bot, bot.entity)
      const worstNow = boom.blast(bot, a.c.position, P, bot.entity.position, { def: dMe, seen: 1 }).dmg
      const eff = effHp(bot, bot.entity)
      let okNow = worstNow < eff - 3 && !!f && a.c.isValid !== false && !!bot.entities[a.c.id]
      if (okNow && a.why === 'free') { const w = inWin(S.myWin, IFRAME_MS - 60); const t = boom.blast(bot, a.c.position, P, bot.entity.position, { def: dMe }); okNow = !!(w && t.raw <= w.raw - 0.5) }
      if (okNow && a.why === 'clear') okNow = boom.blast(bot, a.c.position, P, bot.entity.position, { def: dMe }).dmg <= 1.5
      else if (okNow && a.why !== 'free') { const fw = freshWorth(a.c.position); okNow = !!(fw.t && fw.land >= fw.t.me * 1.2 + 1) }
      if (!okNow) { out.note = ''; out.wait = 60; return out }
    }
    const ok = await hit(a.c)
    out.ok = ok
    if (ok) { if (a.why === 'free') st.free++; else if (a.why === 'clear') st.clears = (st.clears || 0) + 1; else st.defuse++ }
    out.note = ok ? a.note : 'кристалл: сбить не вышло'
    out.wait = 120
    return out
  }
  if (a.kind === 'dodge') {
    S.lastDodge = gameClock.now()
    const dMe = boom.defenseOf(bot, bot.entity)
    await backOff(ctl, a.from, { ms: 500, stepSafe: ctx.stepSafe, until: () => boom.blast(bot, a.from, P, bot.entity.position, { def: dMe }).dmg < Math.max(3, a.t.me * 0.5) })
    st.dodges++
    out.ok = true
    out.wait = 150
    return out
  }
  // Его кристаллы, что ещё стоят и достают меня.
  const alive = (a) => a.threats.filter(th => th.cell ? (() => { const known = anchorsAt.get(cellKey(th.cell)); return !!known && anchorSeen(known) })() : (th.c.isValid !== false && bot.entities[th.c.id]))
  if (a.kind === 'shield') {
    S.lastDodge = gameClock.now()
    const off = bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield'
    if (!off) {
      const idx = await toHotbar('shield')
      if (idx < 0) { fail('щит: не в хотбаре'); out.wait = 100; return out }
      if (bot.quickBarSlot !== idx) bot.setQuickBarSlot(idx)
    }
    const t0 = gameClock.now()
    if (t0 - S.shieldLastEnd > 600) S.shieldStreakAt = t0
    st.shieldUps = (st.shieldUps || 0) + 1
    const managed = off && guard
    try {
      await bot.look(a.yaw, 0, true).catch(() => {})
      if (managed) await guard.raise(true)
      else bot.activateItem(off)
      S.shieldUntil = Infinity
      // Держать, пока его кристаллы стоят (до 1.5 с): лицом к худшему из живых.
      while (gameClock.now() - t0 < 1500 && !ctl.aborted) {
        const live = alive(a)
        if (!live.length) break
        const me = bot.entity.position
        const w = live.sort((x, y) => y.t.me - x.t.me)[0]
        await bot.look(Math.atan2(-(w.c.position.x - me.x), -(w.c.position.z - me.z)), 0, true).catch(() => {})
        await sleep(TICK)
      }
    } finally {
      try { if (managed) await guard.raise(false); else bot.deactivateItem() } catch {}
      S.shieldUntil = gameClock.now()
      S.shieldLastEnd = gameClock.now()
      st.shieldMs = (st.shieldMs || 0) + (gameClock.now() - t0)
    }
    out.ok = true
    out.wait = 60
    return out
  }
  if (a.kind === 'cover') {
    S.lastDodge = gameClock.now()
    st.covers = (st.covers || 0) + 1
    const dMe = boom.defenseOf(bot, bot.entity)
    await moveTo(ctl, a.to, { ms: Math.min(1500, a.ticks * TICK * 2 + 200), stepSafe: ctx.stepSafe, until: () => !alive(a).length })
    out.ok = true
    out.note = `${a.note}; на месте ${r1(hurtAt(alive(a), bot.entity.position, dMe, new Map()))}`
    out.wait = 80
    return out
  }
  if (a.kind === 'wall') {
    S.lastDodge = gameClock.now()
    const { placeBlockAt } = deps
    let n = 0
    for (const cell of a.cells) {
      if (ctl.aborted || !alive(a).length) break
      let r = null
      try { r = await placeBlockAt(bot, cell, { item: wallItem() || 'obsidian', honest: true, timeoutMs: 400 }) } catch (e) { r = { ok: false, reason: e.message } }
      if (r && r.ok && !r.already) n++
      else { fail('блок между: ' + ((r && r.reason) || '?')); break }
    }
    if (n) { st.walls = (st.walls || 0) + 1; st.wallBlocks = (st.wallBlocks || 0) + n }
    out.ok = n > 0
    out.wait = 60
    return out
  }
  return null
}

// Удар: кристалл у него рукой или стрелой, поставить и ударить (или заранее), поставить — отойти — стрела;
// обсидиан у его ног под кристалл.
async function runStrike (S: CrystalState, deps: CrystalDeps, ctl, a, ctx, out, foe) {
  const { bot, st, enemy, fail, place, hit, backOff, freshWorth, shoot } = S
  const { gameClock, boom, sleep } = deps
  if (a.kind === 'hit') {
    if (!freshWorth(a.c.position).ok) { out.note = ''; out.wait = 60; return out }
    const ok = await hit(a.c)
    out.ok = ok
    out.note = ok ? `кристалл у него — удар (прогноз ему ${r1(a.land)}, мне ${r1(a.t.me)})` : 'кристалл у него: удар не прошёл'
    out.wait = ok ? 380 : 100
    return out
  }
  if (a.kind === 'shoot') {
    const ok = await shoot(ctl, a.c, ctx)
    out.ok = ok
    out.note = ok ? `стрела в кристалл у него (прогноз ему ${r1(a.land)}, мне ${r1(a.t.me)})` : 'стрела в кристалл: не вышло'
    out.wait = 300
    return out
  }
  if (a.kind === 'place-hit' || a.kind === 'place') {
    const c: any = await place(a.base, a.f)
    if (!c) { out.note = 'кристалл: не поставил'; out.wait = 250; return out }
    if (a.kind === 'place') {
      st.pre++
      S.pendingAt = gameClock.now()
      out.ok = true
      out.keepItem = true
      out.note = `кристалл заранее — жду конца его неуязвимости (прогноз ${r1(a.t.him)})`
      out.wait = 60
      return out
    }
    // Удар через ~0.1 с, как у человека (и кристалл виден зрителю), и только
    // если размен всё ещё годен на этот миг; нет — кристалл остаётся «заранее».
    await sleep(100)
    if (ctl.aborted) return out
    if (c.isValid === false || !bot.entities[c.id]) { out.note = 'кристалл у него взорвали раньше удара'; out.wait = 80; return out }
    const fw = freshWorth(c.position)
    if (!fw.ok) { st.pre++; out.ok = true; out.keepItem = true; out.note = 'кристалл поставил — размен ушёл, жду'; out.wait = 60; return out }
    const ok = await hit(c)
    out.ok = ok
    out.note = ok ? `кристалл у его ног и удар (прогноз ему ${r1(a.land)}, мне ${r1(a.t.me)})` : 'кристалл поставил, удар не прошёл'
    out.keepItem = true
    out.wait = ok ? 380 : 80
    return out
  }
  if (a.kind === 'place-shoot') {
    S.lastPlaceShoot = gameClock.now()
    const c: any = await place(a.base, a.f)
    if (!c) { out.note = 'кристалл: не поставил'; out.wait = 250; return out }
    const dMe = boom.defenseOf(bot, bot.entity)
    const dHim = boom.defenseOf(bot, foe)
    await backOff(ctl, c.position, {
      ms: 1300,
      stepSafe: ctx.stepSafe,
      until: () => boom.blast(bot, c.position, P, bot.entity.position, { def: dMe }).dmg < Math.max(1.5, effHp(bot, bot.entity) * 0.12)
    })
    if (c.isValid === false || !bot.entities[c.id]) { out.note = 'кристалл у него взорвали раньше стрелы'; out.ok = true; out.wait = 100; return out }
    const f2 = enemy()
    const him = f2 && f2.position ? boom.blast(bot, c.position, P, f2.position, { def: dHim }).dmg : 0
    if (him < 2) { out.note = 'поставил кристалл, отошёл — он ушёл от него, стрелу не трачу'; out.wait = 200; return out }
    // Стрелять — только в видимое: за блоком его не взять в прицел.
    if (!losClear(bot, bot.entity.position.offset(0, EYE, 0), c.position.offset(0, 1, 0))) { out.note = 'поставил кристалл, отошёл — его не видно за блоками'; out.wait = 200; return out }
    const ok = await shoot(ctl, c, ctx)
    out.ok = ok
    out.note = ok ? `кристалл у него, отошёл и стрелой (прогноз ему ${r1(him)})` : 'кристалл поставил, стрелой не вышло'
    out.wait = 300
    return out
  }
  if (a.kind === 'obby') {
    S.lastObby = gameClock.now()
    const { placeBlockAt } = deps
    let r = null
    try { r = await placeBlockAt(bot, a.cell, { item: 'obsidian', honest: true, timeoutMs: 500 }) } catch (e) { r = { ok: false, reason: e.message } }
    if (r && r.ok && !r.already) { st.obby++; out.ok = true; out.keepItem = false; out.wait = 60; return out }
    fail('обсидиан: ' + ((r && r.reason) || '?'))
    out.note = 'обсидиан у его ног: не встал'
    out.wait = 200
    return out
  }
  return null
}

// Якорь: свой у его ног (заряд, подрыв) и его заряженный у нас.
async function runAnchor (S: CrystalState, deps: CrystalDeps, ctl, a, ctx, out, foe) {
  const { bot, st, myAnchorCells, cellKey, fail, toHotbar, noteBlast, freshWorth } = S
  const { gameClock, sleep, CX2 } = deps
  if (a.kind === 'anchor') {
    S.lastAnchor = gameClock.now()
    const { placeBlockAt } = deps
    let r = null
    myAnchorCells.add(cellKey(a.cell))
    try { r = await placeBlockAt(bot, a.cell, { item: 'respawn_anchor', honest: true, timeoutMs: 500 }) } catch (e) { r = { ok: false, reason: e.message } }
    const ab = () => bot.blockAt(a.cell, false)
    if (!r || !r.ok || !ab() || ab().name !== 'respawn_anchor') { fail('якорь: ' + ((r && r.reason) || 'не встал')); out.note = 'якорь у его ног: не встал'; out.wait = 250; return out }
    st.anchors = (st.anchors || 0) + 1
    // «Щит из светокамня» между мной и якорем — до заряда (S7c).
    if (a.guard && isAirB(bot.blockAt(a.guard, false))) {
      let g = null
      try { g = await placeBlockAt(bot, a.guard, { item: 'glowstone', honest: true, timeoutMs: 400 }) } catch (e) { g = { ok: false, reason: e.message } }
      if (g && g.ok && !g.already) st.anchorGuards = (st.anchorGuards || 0) + 1
      else fail('якорь: заслон ' + ((g && g.reason) || '?'))
    }
    // check — последняя проверка перед самим кликом (после переноса предмета).
    const click = async (item, check = null) => {
      const idx = await toHotbar(item)
      if (idx < 0) return false
      if (bot.quickBarSlot !== idx) bot.setQuickBarSlot(idx)
      const eye = bot.entity.position.offset(0, EYE, 0)
      const ff = faceFor(bot, a.cell, eye, pickBlockers(bot, eye))
      if (!ff || !losClear(bot, eye, ff.pt, { expectBlock: a.cell })) return false
      if (check && !check()) return false
      try { await bot._genericPlace(ab(), ff.face, { forceLook: true, delta: ff.pt.minus(a.cell), swingArm: 'right' }) } catch { return false }
      return true
    }
    // Заряд: светокамнем; ждать, пока блок покажет заряд (свойство charges).
    if (!(await click('glowstone'))) { fail('якорь: заряд'); out.note = 'якорь поставил, зарядить не вышло'; out.wait = 200; return out }
    const t0 = gameClock.now()
    const charged = () => { const b = ab(); if (!b || b.name !== 'respawn_anchor') return false; try { const p = b.getProperties && b.getProperties(); return !!(p && Number(p.charges) > 0) } catch { return false } }
    while (gameClock.now() - t0 < 300 && !charged()) await sleep(TICK)
    if (!charged()) { fail('якорь: заряд не подтвердился'); out.note = 'якорь: заряд не подтвердился'; out.wait = 150; return out }
    // Взрыв: «использовать» мечом (не светокамнем, в левой руке тотем) — если
    // размен на миг клика всё ещё годен (за перенос меча и взгляд хп и место уходят).
    let held = false
    const sword = bot.inventory.items().find(i => /_sword$/.test(i.name))
    const ok = sword ? await click(sword.name, () => { if (ctl.aborted || !charged()) return false; const fw = freshWorth(a.cell.offset(0.5, 0.5, 0.5), { power: ANCHOR_P, airCell: a.cell }); if (fw.ok) { S.anchorClick = { key: cellKey(a.cell), at: gameClock.now() }; if (CX2) noteBlast(fw); return true } held = true; return false }) : false
    if (held) { st.anchorHeld = (st.anchorHeld || 0) + 1; out.note = 'якорь заряжен — размен ушёл, не взрываю'; out.wait = 150; return out }
    if (ok) { st.anchorBooms = (st.anchorBooms || 0) + 1; out.ok = true; out.note = a.note } else { fail('якорь: подрыв'); out.note = 'якорь зарядил, подорвать не вышло' }
    out.wait = 350
    return out
  }
  if (a.kind === 'anchorPop') {
    // Его заряженный якорь у нас — подрыв моим кликом не светокамнем (RespawnAnchorBlock.useWithoutItem: заряд > 0,
    // не Ад → explode), если размен на миг клика всё ещё в мою пользу.
    S.lastAnchor = gameClock.now()
    const item = (bot.inventory.items().find(i => /_sword$/.test(i.name)) || bot.inventory.items().find(i => !/glowstone/.test(i.name)))
    const idx = item ? await toHotbar(item.name) : -1
    if (idx < 0) { fail('его якорь: нечем кликнуть'); out.wait = 100; return out }
    if (bot.quickBarSlot !== idx) bot.setQuickBarSlot(idx)
    const b = bot.blockAt(a.cell, false)
    const eye = bot.entity.position.offset(0, EYE, 0)
    const ff = b && b.name === 'respawn_anchor' ? faceFor(bot, a.cell, eye, pickBlockers(bot, eye)) : null
    if (!ff || !losClear(bot, eye, ff.pt, { expectBlock: a.cell })) { fail('его якорь: грань не видно'); out.wait = 80; return out }
    const fw = freshWorth(a.cell.offset(0.5, 0.5, 0.5), { power: ANCHOR_P, airCell: a.cell })
    if (!(fw.t && fw.land >= fw.t.me * 1.2 + 1)) { out.note = ''; out.wait = 60; return out }
    S.anchorClick = { key: cellKey(a.cell), at: gameClock.now() }
    try { await bot._genericPlace(b, ff.face, { forceLook: true, delta: ff.pt.minus(a.cell), swingArm: 'right' }) } catch { fail('его якорь: клик'); out.wait = 80; return out }
    noteBlast(fw)
    st.anchorPops = (st.anchorPops || 0) + 1
    out.ok = true
    out.wait = 200
    return out
  }
  return null
}

// Держать место, починка опытом, еда, обсидиан вокруг ног.
async function runSupport (S: CrystalState, deps: CrystalDeps, ctl, a, ctx, out, foe) {
  const { bot, st, enemy, eatAnchorDefense, toHotbar, doSurround } = S
  const { gameClock, boom, sleep } = deps
  if (a.kind === 'hold') {
    st.holdTicks = (st.holdTicks || 0) + 1
    const f = enemy()
    if (f && f.position) await bot.lookAt(f.position.offset(0, EYE, 0), true).catch(() => {})
    out.ok = true
    out.note = ''
    out.wait = 100
    out.hold = true
    return out
  }
  if (a.kind === 'mend') {
    S.lastMend = gameClock.now()
    const idx = await toHotbar('experience_bottle')
    if (idx < 0) { out.note = 'бутылки опыта: не в хотбаре'; out.wait = 300; return out }
    if (bot.quickBarSlot !== idx) bot.setQuickBarSlot(idx)
    const w0 = armorWear(bot)
    const dist0 = (() => { const f = enemy(); return f && f.position ? f.position.distanceTo(bot.entity.position) : 99 })()
    // Опасность — его кристалл, смертельный мне по полной видимости, который он
    // достаёт рукой или ЛУКОМ; или он подошёл ближе, чем был, и уже в 4 бл.
    const danger = () => {
      const f = enemy()
      const me = bot.entity.position
      if (!f || !f.position) return false
      const dMe = boom.defenseOf(bot, bot.entity)
      const hand = f.equipment && f.equipment[0] ? f.equipment[0].name : ''
      const bowUp = /^(bow|crossbow)$/.test(hand)
      if (f.position.distanceTo(me) < Math.min(4, dist0 - 0.5)) return true
      for (const c of ((Object.values(bot.entities) as any[]) as any)) {
        if (!c || c.name !== 'end_crystal' || !c.position || c.position.distanceTo(me) > 7) continue
        if (boom.blast(bot, c.position, P, me, { def: dMe, seen: 1 }).dmg >= effHp(bot, bot.entity) - 1 && (bowUp || boxDist(f.position.offset(0, EYE, 0), crystalBox(c.position)) < HIT_R + 0.5)) return true
      }
      return false
    }
    let thrown = 0
    await bot.look(bot.entity.yaw, -Math.PI / 2, true).catch(() => {})
    for (let i = 0; i < a.n && !ctl.aborted && !danger(); i++) {
      if (!bot.heldItem || bot.heldItem.name !== 'experience_bottle') break
      try { bot.activateItem() } catch { break }
      thrown++
      await sleep(90)
    }
    try { bot.deactivateItem() } catch {}
    // Сферы впитываются по порции в 2 тика (бутылка 3–11 опыта, 2 прочности за
    // очко; 12 бутылок ≈ 24 порции ≈ 2.5 с) — стоять, пока рядом есть сферы и
    // броня чинится, не дольше 3.5 с, бросить при опасности.
    const t0 = gameClock.now()
    const orbsNear = () => (Object.values(bot.entities) as any[]).some((e : any) => e && e.name === 'experience_orb' && e.position && e.position.distanceTo(bot.entity.position) < 6)
    await sleep(300)
    while (gameClock.now() - t0 < 3500 && !ctl.aborted && !danger() && orbsNear()) await sleep(TICK)
    // Починено — только по уцелевшим вещам (сломанная пропала бы как «починенная»).
    let fixed = 0
    for (const sl of [5, 6, 7, 8]) {
      const was = w0.items && w0.items[sl]
      const it = bot.inventory.slots[sl]
      if (was == null || !it || it.name !== was.name) continue
      fixed += Math.max(0, was.used - (it.durabilityUsed || 0))
    }
    st.mends = (st.mends || 0) + 1
    st.bottles = (st.bottles || 0) + thrown
    st.repaired = (st.repaired || 0) + fixed
    out.ok = thrown > 0
    out.note = `${a.note}: бутылок ${thrown}, починено ${fixed}`
    out.wait = 150
    return out
  }
  if (a.kind === 'eat') {
    S.lastEat = gameClock.now()
    const idx = await toHotbar(a.item)
    if (idx < 0) { out.note = 'яблоко: не в хотбаре'; out.wait = 300; return out }
    if (bot.quickBarSlot !== idx) bot.setQuickBarSlot(idx)
    const had = countOf(bot, a.item)
    const dMe = boom.defenseOf(bot, bot.entity)
    let why = null
    const noticed = { at: null }
    try {
      if (ctl.aborted || ctx.stop?.()) { out.note = 'яблоко: прервано'; return out }
      bot.activateItem()
      const t0 = gameClock.now()
      while (gameClock.now() - t0 < 1900 && !ctl.aborted) {
        await sleep(TICK)
        if (countOf(bot, a.item) < had) break
        if (ctl.aborted || ctx.stop?.()) { why = 'другая угроза'; break }
        const defense = eatAnchorDefense(a.item, Math.max(0, (require('../tempo') as typeof import('../tempo')).consumeMs(a.item) - (gameClock.now() - t0)), noticed, ctx.reactMs)
        if (defense) { out.defense = defense; why = 'защита от видимого якоря дешевле остатка еды'; break }
        // Его кристалл у меня и мне от него смертельно — бросить есть.
        const f = enemy()
        const me = bot.entity.position
        for (const c of ((Object.values(bot.entities) as any[]) as any)) {
          if (!c || c.name !== 'end_crystal' || !c.position || c.position.distanceTo(me) > 7) continue
          const m = boom.blast(bot, c.position, P, me, { def: dMe })
          if (m.dmg >= effHp(bot, bot.entity) - 1 && f && f.position && boxDist(f.position.offset(0, EYE, 0), crystalBox(c.position)) < HIT_R + 0.5) { why = 'его кристалл у меня'; break }
        }
        if (why) break
      }
    } finally { try { bot.deactivateItem() } catch {} }
    const ate = countOf(bot, a.item) < had
    if (ate) st.gapples = (st.gapples || 0) + 1
    else st.eatAborts = (st.eatAborts || 0) + 1
    out.ok = ate
    out.note = ate ? a.note : `яблоко бросил: ${why || 'не доел'}`
    out.wait = 100
    return out
  }
  if (a.kind === 'surround') {
    S.lastSurround = gameClock.now()
    const n = await doSurround(ctl, foe)
    if (n > 0) { st.surround++; st.surroundBlocks += n }
    out.ok = n > 0
    out.note = n > 0 ? `${a.note}: ${n} бл.` : 'обсидиан вокруг ног: не встал'
    out.wait = 150
    return out
  }
  return null
}

function createRunner (S: CrystalState, deps: CrystalDeps) {
  const { bot, st, enemy } = S
  const { DEBUG } = deps
  // ctx: { stepSafe, stop }. ND_DEBUG_CRYSTAL — каждое действие в лог (заметки
  // боя pvp.js прореживает: одна на вид за 1.5 с).
  async function run (ctl, a, ctx: any = {}) {
    if (a.knock) st.knockTries = (st.knockTries || 0) + 1
    const out = await runBody(ctl, a, ctx)
    if (DEBUG && a.kind !== 'hold') { try { const me = bot.entity.position; console.log(`[crystal] ${a.kind} ${out.ok ? 'ok' : 'нет'} | ${out.note || ''} | хп ${r1(effHp(bot, bot.entity))} я ${r1(me.x)},${r1(me.y)},${r1(me.z)}${a.t ? ` | прогноз ему ${r1(a.t.him)}, мне ${r1(a.t.me)} (макс ${r1(a.t.meMax ?? a.t.me)})` : ''}`) } catch {} }
    return out
  }
  async function runBody (ctl, a, ctx: any = {}) {
    const out: any = { ok: false, note: a.note || '' }
    const foe = enemy()
    for (const step of [runDefense, runStrike, runAnchor, runSupport]) {
      const done = await step(S, deps, ctl, a, ctx, out, foe)
      if (done) return done
    }
    return out
  }
  return { run, runBody }
}

export { createRunner, runDefense, runStrike, runAnchor, runSupport }
