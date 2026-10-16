const { standTop, grounded, refugeFoe, refugeLook, lookLine, toShore, chooseRefuge, planksFromLogs, outrun, buildMsOf, takeNiche, takeBox, holdOut, sitTight, waitClear, leaveBox, SIT_CAP_MS } = require('./hold-out')
const { PILLAR, holePlan, HOLE_DEPTH, surface, REFUGE_FLEE_MS } = require('./surface-body')
const { worlds, sleep, xyz, travelXZ, inWater, findNearestLand, findSwimRoute, escapeWater, enterShelter, placeBlockAt, digUp, pickFiller, withTimeout, occupiedByEntity, exitShelter, sitOn, gameClock, Vec3 } = require('./enter-shelter')
async function refuge (session, ctl, p: any = {}) {
  const bot = session.bot
  const t0 = gameClock.now()
  const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) && v !== null && v !== '' ? Math.max(lo, Math.min(hi, n)) : d }
  const minHp = num(p.minHp, 16, 6, 20)
  const maxMs = num(p.maxSeconds, 120, 10, 300) * 1000
  const deadline = t0 + maxMs
  const out: any = { how: 'none', code: 'OK', hp0: Math.round(bot.health ?? 0), why: p.why || undefined, steps: [] }
  // Смерть внутри отхода: возрождение тут же даёт хп 20, и отход писал «вылечился» (ревью Codex 02.10, 6 случаев) —
  // сверять номер смерти на входе и в итоге.
  const deathAt0 = (session.lastDeath && session.lastDeath.at) || 0
  Object.defineProperty(out, 'diedInside', { value: () => ((session.lastDeath && session.lastDeath.at) || 0) !== deathAt0, enumerable: false })
  // Сидеть до рассвета (кампания: ночь наверху без кровати, ND_NIGHT_BOX) — пересидка не только по врагам у стен.
  if (p.untilDawn) out.untilDawn = true
  // stayIn (кампания, ND_NIGHT_DOWN): из закрытой коробки не выходить — дальше вниз прямо из неё (нора под ногами,
  // крыша коробки над головой): ночью «укрытие → вниз работать», а не выход к тем, от кого прятался.
  if (p.stayIn) out.stayIn = true
  // Шаг — с секундой от начала отхода: где ушло время (рывок, стройка, еда).
  const step = s => { out.steps.push(`${((gameClock.now() - t0) / 1000).toFixed(1)}с ${s}`) }
  ctl.onAbort.push(() => { try { bot.pathfinder.setGoal(null) } catch {} try { bot.clearControlStates() } catch {} })
  try { if (typeof session.updateMovements === 'function') session.updateMovements() } catch {}

  // Кто и чем бил за время отхода (damage_event 1.21.11) — для разбора.
  const hurts = []
  const onHurt = pk => {
    if (!pk || !bot.entity || pk.entityId !== bot.entity.id || hurts.length >= 10) return
    let type = null
    try { type = require('.././gamedata').damageTypeName(pk.sourceTypeId) } catch {}
    const src = pk.sourceCauseId > 0 && bot.entities ? bot.entities[pk.sourceCauseId - 1] : null
    // Откуда бил: смещение моба от нас (разбор «достают на столбе»).
    const off = src && src.position ? ` @${(src.position.x - bot.entity.position.x).toFixed(1)},${(src.position.y - bot.entity.position.y).toFixed(1)},${(src.position.z - bot.entity.position.z).toFixed(1)}` : ''
    hurts.push(`${((gameClock.now() - t0) / 1000).toFixed(1)}с ${type || pk.sourceTypeId}${src ? ' ' + (src.username || src.name) : ''}${off} y${bot.entity.position.y.toFixed(1)}${bot.entity.onGround ? '' : ' в воздухе'}`)
  }
  try { bot._client.on('damage_event', onHurt) } catch {}
  ctl.onAbort.push(() => { try { bot._client.removeListener('damage_event', onHurt) } catch {} })
  try {
    // Только выйти из воды на берег (кампания: утопленник бьёт, я в воде) — без коробки и лечения.
    if (p.shore) {
      out.how = 'shore'
      if (inWater(bot)) {
        const r = await toShore(session, ctl, { step, timeoutMs: Math.min(20000, maxMs) })
        out.code = r.ok ? 'OK' : 'IN_WATER'
        out.target = r.target || undefined
      }
      const hp = Math.round(bot.health ?? 0)
      out.hp = hp
      out.healed = hp >= minHp
      out.dry = !inWater(bot)
      out.seconds = Math.round((gameClock.now() - t0) / 100) / 10
      if (hurts.length) out.hurts = hurts
      if (hp <= 0 || out.diedInside()) { out.code = 'DIED'; out.healed = false }
      out.note = `берег: ${out.dry ? 'на суше' : 'в воде'}, хп ${out.hp0} → ${hp}, ${out.seconds} с`
      if (out.code !== 'OK') out.stopped = `${out.code}: ${out.note}`
      console.log('[refuge]', JSON.stringify(out))
      return out
    }
    return await refugeBody(session, ctl, { t0, minHp, deadline, out, step, hurts })
  } finally {
    try { bot._client.removeListener('damage_event', onHurt) } catch {}
  }
}

async function refugeBody (session, ctl, { t0, minHp, deadline, out, step, hurts }: any) {
  const bot = session.bot
  const flee = require('.././flee')
  // Клетка ног — с пола: в прыжке floored-клетка на блок выше, и вся оценка
  // (клетка коробки, нора) съезжает на уровень.
  try { bot.pathfinder.setGoal(null) } catch {}
  await require('.././fortify').landed(bot, 600)
  let a: any = refugeLook(session)
  out.look = lookLine(a)
  out.lookMs = a.ms

  if (a.lava && !ctl.aborted) {
    step('в огне — вон из него')
    try { if (session.director && typeof session.director.escapeFire === 'function') await session.director.escapeFire() } catch {}
    a = refugeLook(session)
  }
  if (a.water && !ctl.aborted && process.env.ND_REFUGE_SHORE !== '0') {
    // Из воды — на берег подальше от утопленников (toShore), а не «всплыть»: тело оставалось в воде.
    step('в воде — плыву к берегу')
    try {
      const r = await toShore(session, ctl, { step })
      step(`берег: ${r.ok ? 'на суше' : 'не вышел'} за ${r.seconds} с`)
    } catch (e) { step(`берег: ${e.message}`) }
    await require('.././fortify').landed(bot, 600)
    a = refugeLook(session)
  }
  if (a.water && !ctl.aborted) {
    // Из воды — к суше, как campaign.rest: открытый воздух важнее норы.
    step('в воде — выхожу на сушу')
    try {
      const r = await surface(session, ctl, { targetY: Math.floor(bot.entity.position.y) + 2, timeoutSeconds: 25, preferPillar: false })
      if (r && r.stopped) step(`суша: ${r.stopped}`)
    } catch (e) { step(`суша: ${e.message}`) }
    a = refugeLook(session)
  }
  let pick = chooseRefuge(a)
  // Паук вплотную, а с ним не больше одного ходячего — сперва бой (ND_REFUGE_SPIDER=1): от паука не оторваться в
  const spiderFirst = async () => {
    if (process.env.ND_REFUGE_SPIDER === '0' || ctl.aborted || (bot.health ?? 0) < 8 || !require('.././items').bestWeapon(bot)) return false
    const hs = flee.hostilesAround(bot, 10).filter(h => refugeFoe(bot, h.e, session))
    // Паук в 6 бл. — дойдёт за 1.5 с (3.9 бл/с, прыжок с 2–4): от него не оторваться и коробку при нём не закрыть.
    const sp = hs.find(h => /^(spider|cave_spider)$/.test(h.e.name) && h.d <= 6 && Math.abs(h.e.position.y - bot.entity.position.y) <= 3)
    // Только один на один: с зомби рядом бой с пауком тянется 7–8 с под его ударами (trap3/4: 12 → 0).
    const others = hs.filter(h => h !== sp && (h.doc.radius > 0 || h.doc.range) && h.d <= 8).length
    if (!sp || others > 0 || a.creeper) return false
    {
      step(`${sp.e.name} вплотную (${sp.d.toFixed(1)} бл.) — сперва бой`)
      let r = null
      try { r = await require('.././combat').fight(session, ctl, { target: '#' + sp.e.id, timeoutSeconds: 12, retreatAtHealth: 5, purpose: 'defense' }) } catch (e) { r = { error: e.message } }
      step(`паук: ${r && (r.killed || (r.kills && r.kills.length)) ? 'убит' : String((r && (r.stopped || r.error)) || 'бой кончился').slice(0, 60)}, хп ${Math.round(bot.health ?? 0)}`)
      await require('.././fortify').landed(bot, 600)
      a = refugeLook(session)
      pick = chooseRefuge(a)
      return true
    }
  }
  await spiderFirst()
  // Блоков мало, а брёвна есть (начало игры: после дерева, до камня) — доски из брёвен в сетке 2×2 (~0.5 с на
  if (process.env.ND_REFUGE_PLANKS !== '0' && !ctl.aborted && a.blocks < 8 && !a.nether &&
    (pick.code === 'NO_BLOCKS' || a.foeClose || (pick.how === 'box' && a.cell && a.cell.blocks > a.blocks))) {
    const made = await planksFromLogs(session, ctl, Math.ceil((8 - a.blocks) / 4))
    if (made) {
      step(`доски из брёвен: +${made}`)
      a = refugeLook(session)
      pick = chooseRefuge(a)
    }
  }

  // Он дойдёт раньше, чем встанут стены, — сперва оторваться: зомби 2.3 бл/с,
  // мы спринтом 5.6. Два коротких рывка, потом строиться где стоим.
  for (let k = 0; k < 2 && !ctl.aborted && outrun(a, pick.how); k++) {
    // От паука не оторваться — с ним бой (если он один на один), а не рывок.
    if (process.env.ND_REFUGE_SPIDER !== '0' && /^(spider|cave_spider)$/.test(a.nearest.name) && await spiderFirst()) continue
    step(`${a.nearest.name} в ${a.nearest.d} бл. дойдёт за ${(a.nearest.etaMs / 1000).toFixed(1)} с, стройка ~${(buildMsOf(a, pick.how) / 1000).toFixed(1)} с — сперва отрываюсь`)
    const p0 = bot.entity.position.clone()
    const f = await flee.smartFlee(session, ctl, { timeoutMs: REFUGE_FLEE_MS, safeDist: 10 })
    const moved = bot.entity.position.distanceTo(p0)
    out.ran = (out.ran || 0) + Math.round(moved)
    await require('.././fortify').landed(bot, 600)
    a = refugeLook(session)
    pick = chooseRefuge(a)
    if (f.cornered) { step('прижали — строюсь где стою'); break }
    // Рывок не сдвинул (лесенка шириной в клетку, тупик штрека): второй такой же — ещё 2.5 с под ударами
    // (trap0 02.10: два рывка по 0 бл. и смерть). Строиться здесь, отталкивая ударом (refugeBox — shove).
    if (moved < 2) { step(`рывок не сдвинул (${moved.toFixed(1)} бл.) — строюсь где стою`); break }
  }
  out.choice = pick.why

  let hold = null
  let exitRes = null
  // Способ, за ним откаты. Не встал первый, а ходячий уже рядом (≤ 8 бл.) — сразу
  const alt = [a.niche ? 'niche' : null, a.cell && a.canBreakOut ? 'box' : null, a.hole && !a.shooters ? 'hole' : null, a.pillar ? 'pillar' : null].filter(Boolean)
  const order = pick.how === 'flee' || pick.how === 'pocket'
    ? [pick.how, 'flee']
    : [pick.how, ...alt.filter(h => h !== pick.how), 'flee']
  let first = true
  for (const how of order) {
    if (ctl.aborted || (bot.health ?? 0) <= 0) break
    // Откат (коробка не встала): место и мобы уже другие — если ходячий дойдёт
    if (!first && (how === 'hole' || how === 'pillar')) {
      await require('.././fortify').landed(bot, 600)
      a = refugeLook(session)
      if (a.nearest && a.nearest.d <= 8) { step(`${how}: ${a.nearest.name} в ${a.nearest.d} бл. — не успеть, бегство`); continue }
      if (outrun(a, how)) {
        step(`${how}: ${a.nearest.name} в ${a.nearest.d} бл. — сперва рывок`)
        const f = await flee.smartFlee(session, ctl, { timeoutMs: REFUGE_FLEE_MS, safeDist: 10 })
        out.ran = (out.ran || 0) + (f.ran || 0)
        await require('.././fortify').landed(bot, 600)
        a = refugeLook(session)
        if ((how === 'hole' && !a.hole) || (how === 'pillar' && !a.pillar)) continue
      }
    }
    first = false
    if (how === 'box' || how === 'niche') {
      // U2: Fight took the hands at the last roof block and jumped into the unfinished box. Only this bounded build owns
      // ordinary defence; healing/exit and urgent hazards retain normal arbitration. A replaced intent cannot keep it.
      let b
      session._refugeBuild = ctl
      try { b = how === 'niche' ? await takeNiche(session, ctl, a, step) : await takeBox(session, ctl, a, step, box => { out.box = box }) }
      finally { if (session._refugeBuild === ctl) delete session._refugeBuild }
      if (!b) { a = refugeLook(session); continue }
      out.how = how
      out.cell = xyz(b.cell)
      out.placed = b.placed
      if (b.intruder) {
        // This box encloses its attacker too. Release construction first, then
        // use the existing physical wall exit and flight, without eating here.
        out.how = 'flee'
        out.breached = b.intruder
        out.code = 'CORNERED'
        exitRes = await leaveBox(session, ctl, b, { why: 'breached' }, step)
        if (exitRes?.ok && !ctl.aborted && (bot.health ?? 0) > 0 && gameClock.now() < deadline) {
          const f = await flee.smartFlee(session, ctl, { timeoutMs: Math.min(6000, deadline - gameClock.now()), safeDist: 12 })
          out.ran = (out.ran || 0) + (f.ran || 0)
          step(`из занятой коробки: ${f.mode}`)
          if (!ctl.aborted && f.mode === 'оторвался') out.code = 'OK'
        }
        break
      }
      hold = await holdOut(session, ctl, { kind: 'box', box: b, minHp, deadline, note: step })
      // No food means no healing. Return behind the confirmed walls so the
      // speedrun caller can choose work or food without reopening to the shooter.
      const noFoodWork = session.playPolicy?.mode === 'speedrun' && !out.untilDawn && hold.why === 'no_food'
      if ((out.stayIn || noFoodWork) && hold.why !== 'breached' && hold.why !== 'died' && !ctl.aborted && (bot.health ?? 0) > 0 &&
        require('.././fortify').enclosure(bot, b.cell).sealed) {
        step('остаюсь в коробке — дальше вниз из неё')
        out.stayed = true
        break
      }
      // Снаружи опасно, а коробка цела — сидеть (NO_FOOD/срок не повод выходить к ним).
      if ((sitOn() || out.untilDawn) && hold.why !== 'breached' && hold.why !== 'died' && require('.././fortify').enclosure(bot, b.cell).sealed) {
        const st = await sitTight(session, ctl, { at: b.cell, t0, box: b, step, untilDawn: out.untilDawn })
        if (st.sat) out.sat = Math.round(st.sat / 1000)
      }
      // Вскрыли — не ждать у дыры, выходить с дальней стороны.
      if (hold.why !== 'breached' && require('.././fortify').enclosure(bot, b.cell).sealed) {
        const clear = await waitClear(session, ctl, b.cell, { deadline: Math.min(deadline + 20000, gameClock.now() + 30000), reach: 4, step })
        // Срок вышел и хп полное — не повод вскрывать целую коробку к толпе (как у норы ниже; Codex ne-deaths №4:
        // VR25-3 — вышел к 10 ифритам, VR26-1 — к эндерменам). Дальше — вниз/вбок из коробки, как stayIn.
        if (!clear && sitOn() && !ctl.aborted && (bot.health ?? 0) > 0 && require('.././fortify').enclosure(bot, b.cell).sealed) {
          step('у выхода враги — коробку не вскрываю, остаюсь')
          out.stayed = true
          break
        }
      }
      exitRes = await leaveBox(session, ctl, b, hold, step)
      break
    }
    if (how === 'pillar') {
      const pl = await takePillar(session, ctl, step)
      if (!pl) { a = refugeLook(session); continue }
      out.how = 'pillar'
      out.height = pl.height
      hold = await holdOut(session, ctl, { kind: 'pillar', minHp, deadline, note: step, topY: Math.floor(bot.entity.position.y) })
      exitRes = await leavePillar(session, ctl, step)
      break
    }
    if (how === 'hole') {
      const h = await takeHole(session, ctl, step)
      if (!h) { a = refugeLook(session); continue }
      out.how = 'hole'
      out.depth = h.depth
      hold = await holdOut(session, ctl, { kind: 'hole', minHp, deadline, note: step })
      if (process.env.ND_NIGHT_WORK !== '0' && out.stayIn && !out.untilDawn && !h.open &&
          !/^(breached|died)$/.test(hold.why) && !ctl.aborted && (bot.health ?? 0) > 0 && refugeLook(session).pocket) {
        step('остаюсь в закрытой норе — дальше работа')
        out.stayed = true
        break
      }
      if ((sitOn() || out.untilDawn) && !h.open && hold.why !== 'breached' && hold.why !== 'died') {
        const st = await sitTight(session, ctl, { at: bot.entity.position.floored(), t0, step, untilDawn: out.untilDawn })
        if (st.sat) out.sat = Math.round(st.sat / 1000)
      }
      // Вылезать столбом, пока у края стоит ходячий, — голова выходит ему под руку
      const top = bot.entity.position.floored().offset(0, h.depth, 0)
      const clear = await waitClear(session, ctl, top, { deadline: Math.min(deadline + 30000, gameClock.now() + 30000), reach: 4, step })
      // Не ушли от края — наверх не лезть (ND_REFUGE_SIT): pool1 02.10 слот 18 — нора в штреке, «у выхода ждал 30 с —
      if (!clear && sitOn() && !h.open && hold.why !== 'breached' && !ctl.aborted && (bot.health ?? 0) > 0) {
        step('у выхода ждут — наверх не лезу, остаюсь внизу')
        out.stayed = true
      } else if (!(hold.why === 'breached' && (bot.health ?? 0) <= 4)) {
        exitRes = await exitShelter(session, ctl, { depth: h.depth })
        if (exitRes && exitRes.stopped) step(`выход из норы: ${exitRes.stopped}`)
      }
      break
    }
    if (how === 'pocket') {
      out.how = 'pocket'
      step(`сижу в замкнутом кармане (${a.pocket} кл.)`)
      hold = await holdOut(session, ctl, { kind: 'pocket', minHp, deadline, note: step })
      if (process.env.ND_NIGHT_WORK !== '0' && out.stayIn && !out.untilDawn &&
          !/^(breached|died)$/.test(hold.why) && !ctl.aborted && (bot.health ?? 0) > 0 && refugeLook(session).pocket) {
        step('остаюсь в кармане — дальше работа')
        out.stayed = true
        break
      }
      if ((process.env.ND_OW_NIGHT_BLOCKOFF === '1' && out.stayIn || session.playPolicy?.mode === 'speedrun') && !out.untilDawn && hold.why === 'no_food' &&
        !ctl.aborted && (bot.health ?? 0) > 0 && refugeLook(session).pocket) {
        step('остаюсь в кармане — дальше работа или еда')
        out.stayed = true
        break
      }
      if ((sitOn() || out.untilDawn) && hold.why !== 'breached' && hold.why !== 'died') {
        const st = await sitTight(session, ctl, { at: bot.entity.position.floored(), t0, step, untilDawn: out.untilDawn })
        if (st.sat) out.sat = Math.round(st.sat / 1000)
      }
      break
    }
    // Бегство: оторваться, в тихом месте поесть; подошли — снова.
    out.how = 'flee'
    if (pick.code) out.code = pick.code
    // Круги «оторваться — поесть»: зомби 2.3 бл/с, кусок 1.6 с — на круг один-два куска.
    for (let k = 0; k < 10 && !ctl.aborted && gameClock.now() < deadline && (bot.health ?? 0) > 0; k++) {
      const f = await flee.smartFlee(session, ctl, { timeoutMs: Math.min(15000, Math.max(3000, deadline - gameClock.now())), safeDist: 16 })
      out.ran = (out.ran || 0) + (f.ran || 0)
      step(`бегство: ${f.mode}`)
      if (f.cornered) { out.code = 'CORNERED'; break }
      hold = await holdOut(session, ctl, { kind: 'open', minHp, deadline, note: step })
      if (hold.why !== 'contact') break
    }
    break
  }

  // Вышел, а ходячие ждут у стен (ночью зомби не расходятся: H — 4 из 6 смертей
  if (exitRes && out.how !== 'flee' && !ctl.aborted && (bot.health ?? 0) > 0) {
    const near = flee.hostilesAround(bot, 8).filter(h => refugeFoe(bot, h.e, session) && h.doc.radius > 0)
    if (near.length) {
      const f = await flee.smartFlee(session, ctl, { timeoutMs: 6000, safeDist: 12 })
      out.ran = (out.ran || 0) + (f.ran || 0)
      step(`после выхода (${near.length} рядом): ${f.mode}`)
    }
  }

  // Итог.
  const hp = Math.round(bot.health ?? 0)
  out.hp = hp
  out.healed = hp >= minHp
  out.seconds = Math.round((gameClock.now() - t0) / 100) / 10
  if (hold) {
    if (hold.ate.length) out.ate = hold.ate
    if (hold.patched) out.patched = hold.patched
    if (hold.breaches) out.breaches = hold.breaches
    out.held = hold.why
  }
  if (exitRes) out.out = exitRes.ok !== undefined ? exitRes.ok : exitRes.out
  // Оборвал не урон (его в прерываниях нет), а чужое намерение, чат или смерть.
  if (ctl.aborted) out.aborted = true
  if (hurts.length) out.hurts = hurts
  if (out.diedInside && out.diedInside()) out.healed = false
  if (hp <= 0 || (out.diedInside && out.diedInside())) out.code = 'DIED'
  else if (out.code === 'OK' && hold && hold.why === 'no_food' && !out.healed) out.code = 'NO_FOOD'
  else if (out.code === 'OK' && hold && hold.why === 'breached') out.code = 'CORNERED'
  else if (out.code === 'OK' && out.how === 'none') out.code = 'CORNERED'
  const words = { box: 'коробка', niche: 'ниша', hole: 'нора', pocket: 'карман', pillar: 'столб', flee: 'бегство', none: 'укрыться не вышло' }
  out.note = `${words[out.how]}: хп ${out.hp0} → ${hp}${out.healed ? '' : ` (до ${minHp} не дотянул${hold && hold.why === 'no_food' ? ' — лечиться нечем' : hold && hold.why === 'timeout' ? ' — время вышло' : ''})`}` +
    (out.ate ? `, съел ${out.ate.join(', ')}` : '') + `, ${out.seconds} с`
  if (out.code !== 'OK') out.stopped = `${out.code}: ${out.note}`
  try { session.journal.append('отход', `${out.note}; ${out.choice || ''}`, bot.entity.position) } catch {}
  console.log('[refuge]', JSON.stringify(out))
  return out
}

async function takeHole (session, ctl, step) {
  // Место могло смениться (рывок, коробка не встала) — нора копается ли здесь.
  if (!holePlan(grounded(session.bot), session.mcData, require('.././fortify').feetCell(session.bot))) { step('нора: здесь не копается'); return null }
  try {
    // После рывка тело где попало на клетке: sinkOne копает блок под floored-клеткой,
    // а стоит тело и на соседней — не проваливается. Сперва встать в центр.
    try { await require('.././fortify').centerInCell(session.bot) } catch {}
    const r = await enterShelter(session, ctl, { depth: HOLE_DEPTH, torch: false, box: false, maxSwings: HOLE_DEPTH + 2, center: true })
    step(`нора: ${r.note || ''}`)
    if (r.sealed) return { depth: r.depth }
    // Крышка не встала (моб стоит в её клетке) — ещё пару раз; на 2+ вниз рука
    for (let k = 0; k < 3 && !r.sealed && r.depth >= 2 && !ctl.aborted; k++) {
      await sleep(400)
      const top = session.bot.entity.position.floored().offset(0, 2, 0)
      const q = await placeBlockAt(session.bot, top, { timeoutMs: 600, steady: true }).catch(() => ({ ok: false }))
      if (q.ok) { r.sealed = true; step('нора: крышку закрыл со второго раза') }
    }
    if (r.sealed) return { depth: r.depth }
    // Открытая нора при ходячих рядом — не укрытие: зомби сваливается в ствол
    // сверху и бьёт в голову (J: 3 смерти). Сидеть — только если их нет.
    const walkers = require('.././flee').hostilesAround(session.bot, 8).filter(h => refugeFoe(session.bot, h.e, session) && h.doc.radius > 0)
    if (r.depth >= 2 && !walkers.length) { step('нора открыта, но на 2+ вниз и ходячих нет — сижу'); return { depth: r.depth, open: true } }
    if (r.depth) await exitShelter(session, ctl, { depth: r.depth })
  } catch (e) { step(`нора: ${e.message}`) }
  return null
}

async function takePillar (session, ctl, step) {
  const bot = session.bot
  try { await require('.././fortify').centerInCell(bot) } catch {}
  const lift = standTop(bot, require('.././fortify').feetCell(bot))
  const want = PILLAR + lift
  if (require('.././pack').buildCount(bot, worlds.worldOf(bot)) < want) { step(`столб: на ${want} блоков не хватает`); return null }
  const y0 = bot.entity.position.y
  // Ходячий вплотную толкает тело с прыжка: блок встаёт, а тело — рядом на земле
  // (G: «4 бл., ноги y150»). Сперва отбросить его ударом, как у стены коробки.
  try { await require('.././fortify').shoveNear(bot, 1.6) } catch {}
  let r
  try { r = await require('.././build').towerUp(bot, ctl, want, { sneak: true, fast: true }) } catch (e) { r = { placed: 0, why: [e.message] } }
  const rose = bot.entity.position.y - y0
  step(`столб: ${r.placed} бл., подъём ${rose.toFixed(1)}${r.why ? ' — ' + r.why.slice(0, 2).join('; ') : ''}`)
  // Верх — по телу, а не по счёту блоков.
  if (rose < PILLAR + lift - 0.5) return null
  return { height: Math.round(rose), lift }
}

async function leavePillar (session, ctl, step) {
  const bot = session.bot
  if ((bot.health ?? 0) <= 0) return null
  const foes = require('.././flee').hostilesAround(bot, 16).filter(h => refugeFoe(bot, h.e, session))
  let yaw = bot.entity.yaw
  if (foes.length) {
    const f = foes[0].e.position
    const dx = bot.entity.position.x - f.x
    const dz = bot.entity.position.z - f.z
    yaw = Math.atan2(-dx, -dz)
  }
  try {
    await bot.look(yaw, 0, true)
    bot.setControlState('forward', true)
    bot.setControlState('jump', true)
    await sleep(450)
  } catch {} finally { try { bot.clearControlStates() } catch {} }
  await require('.././fortify').landed(bot, 1500)
  step(`слез со столба, хп ${Math.round(bot.health ?? 0)}`)
  return { ok: true }
}

async function dodgeCreeper (session, ctl, { id = null, minDist = 8, maxMs = 3000 }: any = {}) {
  const bot = session.bot
  const flee = require('.././flee')
  const { stepSafe, keyDir } = require('.././moves')
  const t0 = gameClock.now()
  const hp0 = Math.round(bot.health ?? 0)
  const set = (k, v) => { try { bot.setControlState(k, v) } catch {} }
  const stop = () => { for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) set(k, false) }
  ctl.onAbort.push(stop)
  try { bot.stopDigging() } catch {}
  try { bot.pathfinder.setGoal(null) } catch {}
  const edgeGuard = require('.././edges').guard(bot)
  // Ближний опасный крипер на каждом шаге: шипящий важнее, второй крипер не забывать (ревью Codex 02.10).
  const creeper = () => {
    let best = null
    for (const x of ((Object.values(bot.entities || {}) as any[]) as any)) {
      if (!x || x.name !== 'creeper' || !x.position || x.isValid === false) continue
      const d = x.position.distanceTo(bot.entity.position)
      if (d >= 9) continue
      let sw = false
      try { sw = flee.creeperSwelling(bot, x) } catch {}
      const score = d - (sw ? 4 : 0) - (x.id === id ? 0.5 : 0)
      if (!best || score < best.score) best = { e: x, d, score }
    }
    return best ? best.e : null
  }
  let dist = null
  let plan = null
  let replanAt = 0
  let prevYaw = null
  let hits = 0
  let hitAt = 0
  let walled = false
  let wall = 0
  let lastPos = bot.entity.position.clone()
  let stuckSince = 0
  try {
    while (!ctl.aborted && gameClock.now() - t0 < maxMs && (bot.health ?? 0) > 0) {
      const c = creeper()
      if (!c) { dist = null; break }
      dist = c.position.distanceTo(bot.entity.position)
      if (dist >= minDist) break
      const now = gameClock.now()
      if (!plan || now >= replanAt) {
        plan = flee.pickDirection(bot, flee.hostilesAround(bot, 16), prevYaw)
        replanAt = now + 250
        if (plan) prevYaw = plan.yaw
      }
      // Бежать некуда (лесенка, тупик) или не сдвинулись за полсекунды, а он вплотную — ударить: отброс 0.4 (+0.5
      // со спринта) выигрывает время до следующего шага прочь (trap1 02.10: в лесенке «ушёл на 3 бл. за 3 с»).
      const moved = bot.entity.position.distanceTo(lastPos)
      if (moved > 0.4) { lastPos = bot.entity.position.clone(); stuckSince = 0 } else if (!stuckSince) stuckSince = now
      // Прижали — сперва заслон: блок между нами на уровне глаз (и ног) рвёт ему видимость, а без неё SwellGoal.tick
      // гасит фитиль (MOBS.md §1). Ставится честно (placeBlockAt honest), ~0.2 с. Не встал — удар.
      if ((!plan || (stuckSince && now - stuckSince > 500)) && dist <= 4.5 && !walled && require('.././build').pickFiller(bot)) {
        walled = true
        stop()
        const me = bot.entity.position
        const dx = c.position.x - me.x
        const dz = c.position.z - me.z
        const step = Math.abs(dx) >= Math.abs(dz) ? new Vec3(Math.sign(dx), 0, 0) : new Vec3(0, 0, Math.sign(dz))
        const cell = me.floored().plus(step)
        let put = 0
        for (const dy of [1, 0]) {
          try {
            const r = await require('.././build').placeBlockAt(bot, cell.offset(0, dy, 0), { timeoutMs: 500, honest: true, steady: true })
            if (r && r.ok) put++
          } catch {}
        }
        wall = put
        if (put) { await sleep(100); continue }
      }
      if ((!plan || (stuckSince && now - stuckSince > 500)) && dist <= 3.6 && now - hitAt > 650) {
        const aimed = require('.././pick').aim(bot, c)
        if (aimed && aimed.point) {
          stop()
          try {
            const w = require('.././items').bestWeapon(bot)
            if (w && (!bot.heldItem || bot.heldItem.type !== w.type)) await bot.equip(w, 'hand').catch(() => {})
            await bot.lookAt(aimed.point, true)
            bot.attack(c)
            hits++
          } catch {}
          hitAt = gameClock.now()
          await sleep(100)
          continue
        }
      }
      const me = bot.entity.position
      const yaw = plan ? plan.yaw : Math.atan2(-(me.x - c.position.x), -(me.z - c.position.z))
      bot.look(yaw, 0, true).catch(() => {})
      const f = keyDir(bot, 'forward')
      set('forward', stepSafe(bot, f) || require('.././movement').inWater(bot))
      set('sprint', (bot.food ?? 20) > 6)
      const ahead = bot.blockAt(me.offset(f.x * 0.8, 0, f.z * 0.8).floored())
      set('jump', !!(ahead && ahead.boundingBox === 'block'))
      await sleep(50)
    }
  } finally {
    stop()
    edgeGuard.stop()
  }
  const hp = Math.round(bot.health ?? 0)
  const out: any = {
    how: 'dodge',
    // Фитиль гаснет только при d > 7 (SwellGoal.tick, MOBS.md §1): 7 ровно — ещё шипит.
    code: hp <= 0 ? 'DIED' : dist !== null && dist <= 7.2 ? 'CORNERED' : 'OK',
    hp0,
    hp,
    healed: hp >= 16,
    dist: dist === null ? null : Math.round(dist * 10) / 10,
    hits: hits || undefined,
    wall: wall || undefined,
    seconds: Math.round((gameClock.now() - t0) / 100) / 10
  }
  out.note = `крипер: ушёл на ${out.dist ?? '?'} бл. за ${out.seconds} с, хп ${hp0} → ${hp}`
  if (out.code !== 'OK') out.stopped = `${out.code}: ${out.note}`
  try { session.journal.append('отход', out.note, bot.entity.position) } catch {}
  return out
}

function runDodgeCreeper (session, p: any = {}) {
  return session.runIntent('refuge', ctl => {
    session.require()
    return dodgeCreeper(session, ctl, p)
  }, { timeoutMs: 8000, interruptOn: ['chat', 'death', 'kicked', 'disconnected'] })
}

function runRefuge (session, p: any = {}) {
  const secs = Math.max(10, Math.min(300, Number(p.maxSeconds) || 120))
  return session.runIntent('refuge', ctl => {
    session.require()
    ctl.entry = session.current
    return refuge(session, ctl, p)
  }, { timeoutMs: (Math.max(secs, sitOn() || p.untilDawn ? SIT_CAP_MS / 1000 : 0) + 60) * 1000, interruptOn: ['chat', 'death', 'kicked', 'disconnected'] })
}

module.exports = { refuge, refugeBody, takeHole, takePillar, leavePillar, dodgeCreeper, runDodgeCreeper, runRefuge }
