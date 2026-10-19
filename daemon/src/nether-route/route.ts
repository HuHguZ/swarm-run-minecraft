'use strict'
// Ход по сетке Ада (nether-route.ts): routeTo — план, шаги, перепланировка, угрозы и запасы до цели.
import * as gameClock from '../game-clock'
import { C, NetherRouteResult, RouteSupplyNeed, budgetOn, feetCell, gridOf, log, receiptCostFor, sleep, xyz } from './base'
import { bastionZones, goldPicks, inLava, lavaSwim, liveDangers, makeRoom, spawnerHot } from './hazards'
import { stepOne, syncAround } from './step'
import { plan } from './plan'
import { eatIfLow, threatCheck } from './fight'


// К цели по сетке: план, исполнение, перепланирование (живые поправки — g.mark). Итог { ok, why, steps, dug, … }.
export async function routeTo (session, ctl, p: any = {}): Promise<NetherRouteResult> {
  const bot = session.bot
  try { (require('../ne-guard') as typeof import('../ne-guard')).swatInstall(bot) } catch {}
  try { (require('../ne-guard') as typeof import('../ne-guard')).attach(session) } catch {}
  const g = gridOf(session)
  const goal = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), r: p.r ?? 0, dy: p.dy ?? 0 }
  const st: any = { ok: false, steps: 0, dug: 0, plans: 0, mismatch: 0, digFails: 0, stepFails: 0, fights: 0, goal, fireproof: false, piglinsAngry: !!p.piglinsAngry }
  if (!g) return { ...st, why: 'сетки Ада нет (знание карты не снято)' }
  const deadline = gameClock.now() + (p.timeoutSeconds ?? 600) * 1000
  const t0 = gameClock.now()
  // Кирки: железная — золоту бастиона; обёртка bot.dig берёт «лучший» инструмент, и без фильтра железная стиралась о
  // незерак за 250 копок (neF-B3f25-1 03.10). ironOk (после бастиона) — любая.
  const filter0 = bot._ndToolFilter
  // Железную беречь всегда (нужна золоту, спуску к крепости Края — SH1 03.10: 825 копок по Аду стёрли все кирки, наверху
  // «до кирпича не докопался: голыми руками»); каменные — из запаса и по дороге (restockPicks).
  bot._ndToolFilter = (require('../tunnel') as typeof import('../tunnel')).makeToolFilter(bot, false)
  // ND_NE_STAY=1: других кирок нет (каменные стёрлись, сделать не из чего) — железная лучше рук (B2-26 03.10: 608 копок руками,
  // 13 мин хода домой).
  const ironOnly = () => !bot.inventory.items().some(i => /^(stone|wooden|golden|diamond|netherite)_pickaxe$/.test(i.name)) && bot.inventory.items().some(i => i.name === 'iron_pickaxe')
  // Ход сам себя бережёт (бой на ходу, стоп на хп < 6), как nether_tunnel (autopilot SELF_GUARDED): аварийный отход
  // автопилота посреди хода у тронного зала бегал на месте 60 с под блейзами — смерть (neF-B4f22-1 03.10).
  const emOff0 = session.emergencyOff
  session.emergencyOff = true
  const own = new Set<string>()
  const solidUnder = () => { if (!p.solidFloor) return true; const b = bot.blockAt(feetCell(bot).offset(0, -1, 0)); return !!b && b.boundingBox === 'block' && !/fence|wall|slab|stairs|chain|bars|pane/.test(b.name) }
  const reached = () => { const f = feetCell(bot); return Math.abs(f.y - goal.y) <= goal.dy && (goal.r ? Math.hypot(f.x - goal.x, f.z - goal.z) <= goal.r : (f.x === goal.x && f.z === goal.z)) && solidUnder() }
  // Запас взмахов — под оставшиеся копки плана, а не жёсткие 260 (s1c-F-7 06.10: «ресурсный запас 259/260 — пополнение» по кругу
  // bastion ↔ AcquireNetherTools 10+ мин, и отказ уже ПОСЛЕ прихода к цели).
  const keepSupply = async (craft = true, need = 260): Promise<boolean> => {
    if (!p.supplyReserve) return true
    const tools: typeof import('../items') = require('../items')
    let swings = tools.toolBudget(bot, 'pickaxe')
    if (swings >= need) return true
    const calm = (bot.health ?? 0) >= 12 && !(require('../ne-guard') as typeof import('../ne-guard')).meleeFoes(bot, 12).length
    if (craft && calm && !ctl.aborted && session.bot === bot && gameClock.now() < deadline) {
      const made = await (require('../tunnel') as typeof import('../tunnel')).restockPicks(session, ctl, 2, { reservePlanks: 8 }).catch(() => 0)
      st.crafted = (st.crafted || 0) + made
      if (made) log('кирки: запас подхода', { made, low: (require('../tunnel') as typeof import('../tunnel')).lowPicks(bot) })
    }
    if (ctl.aborted || session.bot !== bot) return false
    swings = tools.toolBudget(bot, 'pickaxe')
    if (swings >= need) return true
    const inventory = tools.countItems(bot)
    st.supplyNeeded = { pickSwings: swings, requiredSwings: need,
      woodEquivalent: Object.entries(inventory).reduce((total, [name, count]) => total +
        (/_planks$/.test(name) ? Number(count) : /_(log|stem|wood|hyphae)$/.test(name) ? Number(count) * 4 : 0), 0),
      requiredWood: 8, table: (inventory.crafting_table || 0) > 0 } satisfies RouteSupplyNeed
    st.why = 'нужно пополнить инструменты до продолжения подхода'
    return false
  }
  let prefetch = null
  try {
  let lastFrom = null; let sameFrom = 0
  const planCap = p.maxPlans ?? (12 + Math.ceil(Math.hypot(goal.x - bot.entity.position.x, goal.z - bot.entity.position.z) / 48))
  // Гаст в 96 бл. с лучом к нам (раз в план): дальнобойный, выше пола — опасен на любом открытом шаге, не по расстоянию.
  const ghastSeen = () => {
    try {
      const P: typeof import('../perception') = require('../perception')
      // …и ифриты с лучом в 24 бл.: выход от спавнера открытым ходом убивал (s1-LI-7 06.10: 6 стержней, 10 очей, ne_route из норы у
      // спавнера — смерть на первом шаге).
      return (Object.values(bot.entities || {}) as any[]).some((e: any) => e && e.position && e.isValid !== false && (
        e.name === 'ghast' && e.position.distanceTo(bot.entity.position) < 96 && P.raySees(bot, P.eyePos(bot), e.position.offset(0, 2, 0)) ||
        e.name === 'blaze' && e.position.distanceTo(bot.entity.position) < 24 && P.raySees(bot, P.eyePos(bot), e.position.offset(0, 1.2, 0))))
    } catch { return false }
  }
  // У спавнера ифритов (≤ 28 бл. по памяти) — открытое дороже всегда: из норы у спавнера ифриты лучом не видны, план выводил
  // в открытый зал (s1-LI-7).
  const nearSpawner = () => {
    try {
      const sp = ((session.journal && session.journal.state && session.journal.state.places) || {})['спавнер блейзов']
      return !!sp && Math.hypot(sp.x - bot.entity.position.x, sp.z - bot.entity.position.z) < 28 && Math.abs(sp.y - bot.entity.position.y) < 20
    } catch { return false }
  }
  const planOptions = blocks => ({ solidFloor: !!p.solidFloor, maxNodes: p.maxNodes, maxMs: p.maxPlanMs, blocks: Math.min(24, blocks), fireproof: st.fireproof, partial: true, zone: p.zone, zones: bastionZones(session), zoneExpo: p.zoneExpo,
    digWaitSeconds: receiptCostFor(session).costs.seconds(receiptCostFor(session).context) + (receiptCostFor(session).swing || 0),
    alarm: () => ctl.aborted || !!session.reflex || (process.env.ND_GUARD_REFLEX === '0' && process.env.ND_GUARD !== '0' && !!(require('../ne-guard') as typeof import('../ne-guard')).hot(bot)),
    dangers: liveDangers(session), hot: [...(p.hot || []), ...spawnerHot(session, goal, st.fireproof)], expoMul: ghastSeen() || nearSpawner() ? 3 : 1 })
  const planLog = (pl, from, speculative) => log('план', { from: xyz(from), goal, leg: pl.leg, more: pl.more, prefetched: speculative, ok: pl.ok, steps: pl.steps, digs: pl.digs, expo: pl.expo, risk: pl.risk || 0, cost: pl.cost, digWaitSeconds: pl.digWaitSeconds, nodes: pl.nodes, ms: pl.ms, why2: pl.why2, why: pl.ok ? undefined : pl.why,
    head: (pl.path || []).slice(0, pl.steps <= 12 ? 12 : 4).map(m => `${m.kind}@${m.to.x},${m.to.y},${m.to.z}`).join(' ') })
  { const f0 = feetCell(bot); own.add(`${f0.x},${f0.y},${f0.z}`); own.add(`${f0.x},${f0.y + 1},${f0.z}`) }
  while (!ctl.aborted && gameClock.now() < deadline && st.plans < planCap) {
    if (ctl.waitReflex) await ctl.waitReflex()
    if (!(await keepSupply(true, 120))) break
    if (reached()) { st.ok = true; break }
    st.fireproof = (require('../blaze') as typeof import('../blaze')).hasEffect(bot, 'fire_resistance')
    if (inLava(bot)) {
      // Огнестойкость, если есть, — и к берегу.
      if (!st.fireproof) { try { const B: typeof import('../blaze') = require('../blaze'); await B.drinkFireResistance(bot); st.fireproof = B.hasEffect(bot, 'fire_resistance') } catch {} }
      await lavaSwim(bot, ctl, st)
    }
    if (ctl.aborted) break
    // Перед планом (он бывает 2–15 с): брут/злой вплотную — сперва ответ (VR23-1 03.10: брут бил 8 с, пока считался план).
    if (process.env.ND_GUARD !== '0') {
      const G: typeof import('../ne-guard') = require('../ne-guard')
      const h = G.hot(bot, { near: 4 })
      if (h) {
        const rr = await G.react(session, ctl, { force: h, onOwn: cells => { for (const k of cells) own.add(k) } })
        if (rr.cancelled || ctl.aborted || session.bot !== bot) break
        if (rr.acted !== false) {
          st.guards = (st.guards || 0) + 1
          log('страж', { why: h.why, how: rr.how, hp: Math.round(bot.health ?? 0), before: 'план' })
        }
      }
    }
    const from = feetCell(bot)
    st.synced = (st.synced || 0) + syncAround(bot, g, st.plans ? 5 : 8)
    // Клетки, куда тело не шагнуло дважды, — снова «непроходимы» (сверка с живыми блоками их стирала: B7f31).
    for (const k of (st.blocked || [])) { const [bx, by, bz] = k.split(',').map(Number); g.mark(bx, by, bz, C.BLOCK) }
    const blocks = bot.inventory.items().filter(i => (require('../sealed') as typeof import('../sealed')).FILL_NAMES.includes(i.name)).reduce((n, i) => n + i.count, 0)
    let pl
    if (prefetch && from.x === prefetch.from.x && from.y === prefetch.from.y && from.z === prefetch.from.z && prefetch.fireproof === st.fireproof) {
      pl = await prefetch.promise
      st.prefetched = (st.prefetched || 0) + 1
    } else {
      // Failed/moved defence invalidates the speculative start, not the intent.
      if (prefetch) { prefetch.cancelled = true; await prefetch.promise }
      pl = await plan(g, { x: from.x, y: from.y, z: from.z }, goal, planOptions(blocks))
      st.plans++
      if (pl.why2 !== 'тревога' || (st.pausedPlans || 0) < 8) planLog(pl, from, false)
    }
    prefetch = null
    if (pl.why2 === 'тревога') {
      st.plans--
      st.pausedPlans = (st.pausedPlans || 0) + 1
      if (ctl.waitReflex) await ctl.waitReflex()
      await new Promise<void>(resolve => setImmediate(resolve))
      continue
    }
    if (lastFrom && lastFrom.equals(from)) sameFrom++; else sameFrom = 0
    lastFrom = from
    if (sameFrom >= 5) { st.why = 'на месте после пяти планов'; break }
    if (!pl.path || !pl.path.length) { st.why = pl.why2 || 'пути нет'; st.planWhy = pl.why; break }
    // Неполный план (цель недостижима по сетке) — идём до ближней точки, дальше — решает вызывающий.
    let res = 'ok'
    for (let i = 0; i < pl.path.length && !ctl.aborted && gameClock.now() < deadline; i++) {
      if (ctl.waitReflex) await ctl.waitReflex()
      // Start the next leg while the last 12 physical moves of this one run.
      // Snapshot/arrays belong to that plan; projected digs/blocks describe only
      // the remaining moves. Source mismatch discards it above.
      if (budgetOn() && pl.more && !prefetch && i >= pl.path.length - 12 && st.plans < planCap) {
        const tail = pl.path.slice(i)
        const next: any = { from: pl.path.at(-1).to, fireproof: st.fireproof, cancelled: false }
        const options = planOptions(Math.max(0, blocks - pl.path.filter(m => m.kind === 'bridge' || m.kind === 'vup').length))
        const alarm = options.alarm
        prefetch = next; st.plans++
        next.promise = plan(g, next.from, goal, { ...options, projected: tail, alarm: () => next.cancelled || alarm() })
          .then(r => { planLog(r, next.from, true); return r }, e => ({ ok: false, path: [], why2: e.message }))
      }
      // Страж ближнего боя (ND_GUARD=1, ne-guard): удар/брут вплотную — ответ до шага (проверка угроз раз в 4 шага
      // запаздывала на секунды: VR22-3/VR31-2 03.10 — брут, 3 удара за 2 с посреди хода к золоту).
      if (process.env.ND_GUARD !== '0') {
        const G: typeof import('../ne-guard') = require('../ne-guard')
        const h = G.hot(bot)
        if (h) {
          const rr = await G.react(session, ctl, { force: h, onOwn: cells => { for (const k of cells) own.add(k) } })
          if (rr.cancelled || ctl.aborted || session.bot !== bot) { res = 'stop:прервано'; break }
          if (rr.acted !== false) {
            st.guards = (st.guards || 0) + 1
            log('страж', { why: h.why, how: rr.how, hp: Math.round(bot.health ?? 0) })
            res = 'replan'; break
          }
        }
      }
      if (!(await keepSupply(true, Math.min(260, 30 + Math.ceil(1.3 * pl.path.slice(i).reduce((n, m) => n + (m.dig ? m.dig.length : 0), 0)))))) { res = 'stop:' + (st.supplyNeeded ? st.why : 'прервано'); break }
      // Иссушитель/брут вплотную — ответ на каждом шаге, а не раз в 4 (s1c-D-2 06.10: 5 ударов по 4.8 за один длинный шаг спуска).
      if (i % 4 !== 0 && process.env.ND_WITHER_PIT !== '0' && (Object.values(bot.entities || {}) as any[]).some((e: any) => e && /^(wither_skeleton|piglin_brute)$/.test(e.name || '') &&
          e.isValid !== false && e.position && e.position.distanceTo(bot.entity.position) < 3.6)) {
        if (await threatCheck(session, ctl, st)) { res = 'replan'; break }
      }
      // abortNear: враг из списка виден ближе r — ход бросить (золото у двора: брут — D2-31 03.10, три удара за 2 с). На каждом шаге,
      // а не раз в 4 (s1c-F-3 06.10: ход к помосту среди ифритов — 26 урона ударами до обрыва хода).
      if (p.abortNear) {
        const P: typeof import('../perception') = require('../perception')
        const re = p.abortNear.re instanceof RegExp ? p.abortNear.re : new RegExp(p.abortNear.re || '^(piglin_brute|hoglin)$')
        const near: any = (Object.values(bot.entities || {}) as any[]).find((e : any) => e && e.position && e.isValid !== false && re.test(e.name || '') && e.position.distanceTo(bot.entity.position) < (p.abortNear.r || 10) && (() => { try { return P.raySees(bot, P.eyePos(bot), e.position.offset(0, 1.2, 0)) } catch { return true } })())
        if (near) { res = 'stop:рядом ' + near.name; break }
      }
      if (i % 4 === 0) {
        if (i % 40 === 0) await makeRoom(bot, 5)
        // Кирки: каменных не осталось — сделать из булыжника/чернокамня (железная — золоту бастиона).
        // Не у самой цели (у спавнера — блейзы: крафт 80 с под ударами, neF-B5f31-1): там — любая кирка, и железная.
        const nearGoal = Math.hypot(bot.entity.position.x - goal.x, bot.entity.position.z - goal.z) < 28
        if (nearGoal && bot._ndToolFilter && p.ironOk) bot._ndToolFilter = filter0
        if (process.env.ND_NE_STAY === '1' && bot._ndToolFilter && ironOnly()) bot._ndToolFilter = filter0
        // ND_GUARD=1: ближний враг в 12 бл. — не крафт (верстак — секунды без ответа: B1-31 03.10, брут убил за крафтом кирок).
        const calm = process.env.ND_GUARD === '0' || !(require('../ne-guard') as typeof import('../ne-guard')).meleeFoes(bot, 12).length
        if (calm && !nearGoal && i % 12 === 0 && pl.path.slice(i, i + 12).some(m => m.dig.length) && (require('../tunnel') as typeof import('../tunnel')).lowPicks(bot) < 2) {
          const made = await (require('../tunnel') as typeof import('../tunnel')).restockPicks(session, ctl, 2, p.supplyReserve ? { reservePlanks: 8 } : {}).catch(() => 0)
          st.crafted = (st.crafted || 0) + (made || 0)
          if (made) log('кирки', { made, low: (require('../tunnel') as typeof import('../tunnel')).lowPicks(bot) })
          // Камня на каменные нет, а кирок никаких — железная из слитков/самородков/блоков сундуков (D5-23/31 03.10: «бой у
          // спавнера: не хватает кирки» при 2 слитках и самородках).
          if (!made && !bot.inventory.items().some(it => /_pickaxe$/.test(it.name))) {
            const ok = await (require('../bastion') as typeof import('../bastion')).makeIronPick(session, ctl).catch(() => false)
            log('кирки: железная', { ok })
            if (!ok) { const g = await goldPicks(session, ctl, 2); if (g) log('кирки: золотые', { made: g }) }
          }
        }
        if (await threatCheck(session, ctl, st)) { res = 'replan'; break }
        await eatIfLow(session, ctl)
        if ((bot.health ?? 20) < 6) { res = 'stop:хп ' + Math.round(bot.health ?? 0); break }
      }
      // Впереди (5 ходов) опасные шаги, огнестойкости нет, а зелий больше, чем просили оставить, — выпить; у точки frNear
      // (спавнер: блейзы) — любое зелье.
      const nearFr = p.frNear && Math.hypot(bot.entity.position.x - p.frNear.x, bot.entity.position.z - p.frNear.z) <= (p.frNear.r ?? 20) && Math.abs(bot.entity.position.y - (p.frNear.y ?? bot.entity.position.y)) <= 24
      if ((p.frKeep != null || nearFr) && !st.fireproof && (nearFr || pl.path.slice(i, i + 5).some(m => m.risk))) {
        const B: typeof import('../blaze') = require('../blaze')
        const { potionOf }: typeof import('../pvp') = require('../pvp')
        const frN = bot.inventory.items().filter(it => /potion$/.test(it.name) && /fire_resistance$/.test(potionOf(it) || '')).reduce((n, it) => n + it.count, 0)
        if ((nearFr ? frN > 0 : frN > p.frKeep) && !B.hasEffect(bot, 'fire_resistance')) {
          const d = await B.drinkFireResistance(bot).catch(e => e.message)
          for (let q = 0; q < 20 && !B.hasEffect(bot, 'fire_resistance'); q++) await sleep(100)
          st.fireproof = B.hasEffect(bot, 'fire_resistance')
          st.drinks = (st.drinks || 0) + 1
          log('огнестойкость перед опасным', { d, left: frN - 1, at: xyz(bot.entity.position) })
        }
      }
      const r = await stepOne(session, ctl, g, pl.path[i], st)
      if (r !== 'ok') { res = r; break }
      if (i % 20 === 0) st.fireproof = (require('../blaze') as typeof import('../blaze')).hasEffect(bot, 'fire_resistance')
      st.steps++
      if (st.steps % 50 === 0) log('ход', { steps: st.steps, of: pl.steps, dug: st.dug, s: Math.round((gameClock.now() - t0) / 1000), at: xyz(bot.entity.position), hp: Math.round(bot.health ?? 0) })
      // Свои клетки (тело прошло, копал) — для штрека бастиона (sealedGold: «свои» не чужой воздух).
      const t = pl.path[i].to
      own.add(`${t.x},${t.y},${t.z}`); own.add(`${t.x},${t.y + 1},${t.z}`)
      for (const c of pl.path[i].dig) own.add(`${c[0]},${c[1]},${c[2]}`)
    }
    if (res.startsWith('stop:')) { st.why = res.slice(5); break }
    // Неполный план по пределу узлов — дошли до ближней к цели точки, план снова оттуда; поиск исчерпан — путей нет.
    if (res === 'ok' && !pl.ok && !pl.limit && !pl.more && !reached()) { st.why = 'по сетке дальше пути нет'; st.planWhy = pl.why; break }
  }
  } finally { if (prefetch) { prefetch.cancelled = true; await prefetch.promise }; bot._ndToolFilter = filter0; session.emergencyOff = emOff0 }
  if (!ctl.aborted && session.bot === bot && !reached()) await keepSupply(false, 120)
  st.ok = !st.supplyNeeded && (st.ok || reached())
  if (!st.ok && !st.why) st.why = ctl.aborted ? 'прервано' : gameClock.now() >= deadline ? 'время вышло' : 'планов много'
  st.seconds = Math.round((gameClock.now() - t0) / 1000)
  st.at = xyz(bot.entity.position)
  st.speed = st.seconds ? Math.round(st.steps / st.seconds * 100) / 100 : null
  log('итог', st)
  st.own = own
  return st
}
