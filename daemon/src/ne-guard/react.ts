'use strict'
// Страж Ада (ne-guard.ts): слежение за угрозой (install/attach/hot) и ответ (react): укрытие, бой, отход.
import * as gameClock from '../game-clock'
import { sleep } from '../movement'
import { HIDE_FROM, aggressive, bigMelee, log, meleeFoes, meleeName, sees, worldIsNether } from './foes'
import { above, boxIn, guardItem, hideDown, holeFits, pillarFits, pillarHeight } from './shelter'
import { duel, sit } from './fight'

// Сессия тела для сторожа (react без вызывающего). Зовут bastion/routeTo/farmRods на входе.
export function attach (session) {
  const g = install(session && session.bot)
  if (g) {
    g.session = session
    if ((require('../reflex-lock') as typeof import('../reflex-lock')).on()) (require('../reflex-lock') as typeof import('../reflex-lock')).install(session)
  }
  return g
}
export function install (bot) {
  if (!bot || !bot._client) return null
  if (bot._ndGuard) return bot._ndGuard
  const g: any = { hits: [] }
  const onDmg = pk => {
    try {
      if (!pk || !bot.entity || pk.entityId !== bot.entity.id) return
      const src = bot.entities[(pk.sourceCauseId ?? 0) - 1] || bot.entities[(pk.sourceDirectId ?? 0) - 1]
      if (!src || !src.position || src === bot.entity) return
      g.hits.push({ t: gameClock.now(), id: src.id, name: src.name || src.type, d: +src.position.distanceTo(bot.entity.position).toFixed(1) })
      if (/piglin/.test(src.name || '')) g.angerAt = gameClock.now()
      if (g.session?.tactics?.enabled()) {
        g.session.tactics.requestGuard().catch(() => null)
        if (g.hits.length > 24) g.hits.shift()
        return
      }
      // First attack, not second: own the hands before a health packet/craft
      // continuation arrives. The original intent remains alive under the lock.
      if ((require('../reflex-lock') as typeof import('../reflex-lock')).on() && g.session && g.session.bot === bot && worldIsNether(bot) && meleeName(src.name || '') && (src.name !== 'blaze' || src.position.distanceTo(bot.entity.position) < 3.5)) {
        react(g.session, g.session.current?.ctl || { aborted: false, onAbort: [] }, {
          force: { e: src, why: 'первый удар ' + src.name }, triggerAt: g.hits.at(-1).t
        }).catch(() => null)
        if (g.hits.length > 24) g.hits.shift()
        return
      }
      // Щит-рефлекс (ND_GUARD=1): удар ближнего моба, а ответ ещё не начат (тело считает план/крафтит/копает) — сразу
      // взгляд на него и щит на 1.2 с: удар меча пиглина щит снимает целиком, топор брута — первый (потом щит выбит на 5 с).
      if (process.env.ND_GUARD !== '0' && !g.reacting && meleeName(src.name || '') && src.position.distanceTo(bot.entity.position) < 4.5 && (src.name !== 'blaze' || src.position.distanceTo(bot.entity.position) < 3.5) &&
        bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield' && gameClock.now() - (g.shieldAt || 0) > 1500) {
        g.shieldAt = gameClock.now()
        bot.lookAt(src.position.offset(0, (src.height || 1.9) * 0.8, 0), true).catch(() => {})
        try { bot.activateItem(true) } catch {}
        gameClock.setTimeout(() => { try { if (!g.reacting && gameClock.now() - g.shieldAt >= 1100) bot.deactivateItem() } catch {} }, 1200)
      }
      if (g.hits.length > 24) g.hits.shift()
      // Сторож (ND_GUARD=1): второй удар ближнего моба за 4 с, а ответа нет (дело тела — ходьба к точке обзора, ожидание,
      // план — без проверок стража: B1-32 03.10, хоглин 7 ударов за 13 с при обходе бастиона) — ответ сам, мимо цикла дела.
      if (process.env.ND_GUARD !== '0' && !g.reacting && g.session && meleeName(src.name || '') && worldIsNether(bot) && (src.name !== 'blaze' || src.position.distanceTo(bot.entity.position) < 3.5)) {
        const now = gameClock.now()
        const recent = g.hits.filter(h => now - h.t < 4000 && meleeName(h.name || '') && (h.name !== 'blaze' || h.d < 3.5)).length
        if (recent >= 2 && now - (g.autoAt || 0) > 6000) {
          g.autoAt = now
          const ctl = { aborted: false, onAbort: [] }
          const onDeath = () => { ctl.aborted = true; for (const f of ctl.onAbort) { try { f() } catch {} } }
          bot.once('death', onDeath)
          log('сторож: ответа нет — отвечаю сам', { foe: src.name, hits: recent, hp: Math.round(bot.health ?? 0) })
          react(g.session, ctl, { force: { e: src, why: 'сторож: ' + src.name } }).catch(() => null).finally(() => bot.removeListener('death', onDeath))
        }
      }
    } catch {}
  }
  bot._client.on('damage_event', onDmg)
  // Крупный удар (≥ 6 хп за раз) от ближнего моба за последнюю секунду — сторож сразу, не ждать второго.
  let hp0 = bot.health ?? 20
  const onHealth = () => {
    try {
      const hp = bot.health ?? 20
      const drop = hp0 - hp
      hp0 = hp
      if (g.session?.tactics?.enabled()) { g.session.tactics.update(true); return }
      if (drop < 6 || process.env.ND_GUARD === '0' || g.reacting || !g.session || !worldIsNether(bot)) return
      const last = g.hits[g.hits.length - 1]
      if (!last || gameClock.now() - last.t > 1000 || !meleeName(last.name || '') || gameClock.now() - (g.autoAt || 0) < 6000) return
      const src = bot.entities[last.id]
      if (!src || !src.position || src.position.distanceTo(bot.entity.position) > 5.5 || (src.name === 'blaze' && src.position.distanceTo(bot.entity.position) >= 3.5)) return
      g.autoAt = gameClock.now()
      const ctl = { aborted: false, onAbort: [] }
      const onDeath = () => { ctl.aborted = true; for (const f of ctl.onAbort) { try { f() } catch {} } }
      bot.once('death', onDeath)
      log('сторож: крупный удар — отвечаю сам', { foe: src.name, drop: Math.round(drop), hp: Math.round(hp) })
      react(g.session, ctl, { force: { e: src, why: 'сторож: ' + src.name } }).catch(() => null).finally(() => bot.removeListener('death', onDeath))
    } catch {}
  }
  bot.on('health', onHealth)
  const GUARDED = /^(gold_block|raw_gold_block|gilded_blackstone|chest|trapped_chest|barrel|ender_chest|gold_ore|deepslate_gold_ore|nether_gold_ore|[a-z_]*shulker_box|[a-z_]*copper_chest[a-z_]*)$/
  const onDug = b => { try { if (b && GUARDED.test(b.name || '')) g.angerAt = gameClock.now() } catch {} }
  const onWin = w => { try { if (w && /chest|barrel|shulker|generic_9x3|generic_9x6/i.test(String(w.type || ''))) g.angerAt = gameClock.now() } catch {} }
  bot.on('diggingCompleted', onDug)
  bot.on('windowOpen', onWin)
  const onTick = () => {
    if (g.session?.tactics?.enabled()) { g.session.tactics.update(); return }
    if (!(require('../reflex-lock') as typeof import('../reflex-lock')).on() || !g.session || g.session.bot !== bot || g.reacting || g.session.reflex || !worldIsNether(bot) || (bot.health ?? 0) <= 0) return
    const h = hot(bot)
    if (h) react(g.session, g.session.current?.ctl || { aborted: false, onAbort: [] }, { force: h }).catch(() => null)
  }
  const onReflex = o => log('reflex', o)
  bot.on('physicsTick', onTick)
  bot.on('nd_guard_reflex', onReflex)
  bot.once('end', () => { g.ended = true; try { bot._client.removeListener('damage_event', onDmg); bot.removeListener('health', onHealth); bot.removeListener('physicsTick', onTick); bot.removeListener('nd_guard_reflex', onReflex); bot.removeListener('diggingCompleted', onDug); bot.removeListener('windowOpen', onWin) } catch {} })
  bot._ndGuard = g
  return g
}

// Кто бьёт или вот-вот ударит: удар ближнего моба за ms (он жив и в 5 бл.) — или брут/хоглин/зоглин злой и видимый
// ближе near, или злой пиглин ближе 2. null — тихо.
export function hot (bot, { ms = 1500, near = 3.0 }: any = {}) {
  if (!bot || !bot.entity) return null
  const g = install(bot)
  const now = gameClock.now()
  if (g) {
    for (let i = g.hits.length - 1; i >= 0; i--) {
      const h = g.hits[i]
      if (now - h.t > ms) break
      if (!meleeName(h.name || '') || (h.name === 'blaze' && h.d >= 3.5)) continue
      const e = bot.entities[h.id]
      if (e && e.isValid !== false && e.position && e.position.distanceTo(bot.entity.position) < 5.5 && (e.name !== 'blaze' || e.position.distanceTo(bot.entity.position) < 3.5)) return { e, why: 'удар ' + e.name }
    }
  }
  const me = bot.entity.position
  // Брут/хоглин бегут ~3.5 бл/с, яма — ~1 с: злой и видимый в 5 бл. — уже пора (иссушитель — в 3.5).
  for (const e of (meleeFoes(bot, Math.max(near + 4, 7)) as any)) {
    const d = e.position.distanceTo(me)
    const lim = e.name === 'wither_skeleton' ? near + 0.5 : near + 4
    // Мы выше на 2.5+ (свой столб) — он не достаёт: не повод строить ещё (иначе столб растёт каждый план хода).
    if (e.name === 'blaze') {
      // No mob_flags prerequisite: BlazeAttackGoal has its own target logic.
      if (d <= 2.7 && (require('../pick') as typeof import('../pick')).canHit(bot, e)) return { e, why: 'блейз вплотную' }
      continue
    }
    if (me.y - e.position.y >= 2.5) continue
    if ((HIDE_FROM.test(e.name) || e.name === 'wither_skeleton') && d <= lim && aggressive(bot, e) && sees(bot, e)) {
      // Издали (> 3 бл.) по тому же — не чаще раза в 20 с, пока он не ударил: брут за окном закрытого штрека виден и зол,
      // а пути к нам нет — без предела ответ шёл бы перед каждым ходом (D6-22: «брут видит в штреке» ×19, 13 мин).
      if (d > 3 && g) { g.pre = g.pre || new Map(); if (now - (g.pre.get(e.id) || 0) < 20000) continue; g.pre.set(e.id, now) }
      return { e, why: `${e.name} в ${d.toFixed(1)} бл.` }
    }
    if (/^(piglin|zombified_piglin)$/.test(e.name) && d <= 2.2 && gameClock.now() - (g && g.reactEnd || 0) > 3000) {
      let can = false
      try { can = (require('../pick') as typeof import('../pick')).canHit(bot, e) } catch {}
      if (can) return { e, why: `злой ${e.name} в ${d.toFixed(1)} бл.` }
    }
  }
  return null
}

// Ответ на удар/угрозу вплотную. opts.onOwn(cells) — клетки ямы (свои для штрека). { acted, how, … }.
export async function react (session, ctl, opts: any = {}) {
  if (ctl.aborted || !session.bot?.entity || (session.bot.health ?? 0) <= 0) return { acted: false, cancelled: true }
  const bot = session.bot
  const dimension = bot.game?.dimension
  const g = install(bot)
  const active = () => !ctl.aborted && session.bot === bot && !!bot.entity && (bot.health ?? 0) > 0 &&
    bot.game?.dimension === dimension && !g?.ended
  if (!active()) return { acted: false, cancelled: true }
  if (session.tactics?.enabled() && !opts._owned) {
    const result = await session.tactics.requestGuard()
    // A declined guard can resolve synchronously; native packets and aborts must still run.
    await new Promise<void>(resolve => setImmediate(resolve))
    return active() ? result : { acted: false, cancelled: true }
  }
  const h = opts.force || hot(session.bot, opts)
  if (!h) return { acted: false }
  const R: typeof import('../reflex-lock') = require('../reflex-lock')
  if (R.on() && !opts._owned) {
    return R.start(session, async sub => {
      // Immediate defensive action before a tower/box needs inventory clicks.
      const b = session.bot
      if (b.inventory.slots[45]?.name === 'shield') {
        try { await b.lookAt(h.e.position.offset(0, (h.e.height || 1.9) * .8, 0), true); b.activateItem(true) } catch {}
      } else if ((require('../pick') as typeof import('../pick')).canHit(b, h.e)) {
        try { await b.lookAt(h.e.position.offset(0, (h.e.height || 1.9) * .7, 0), true); b.attack(h.e) } catch {}
      }
      return react(session, sub, { ...opts, force: h, _owned: true })
    }, { triggerAt: opts.triggerAt ?? gameClock.now(), source: h.e.name })
  }
  // Ответ уже идёт (сторож отвечает сам) — дождаться его конца, а не второй поверх.
  if (g?.reacting && !g.reactionCtl?.aborted) { const tw = gameClock.now(); while (g.reacting && gameClock.now() - tw < 30000 && !ctl.aborted) await sleep(200); return ctl.aborted ? { acted: false, cancelled: true } : { acted: true, how: 'ждал ответа' } }
  if (g) { g.reacting = true; g.reactionCtl = ctl }
  try { return await reactCatch(session, ctl, opts, h) } finally { if (g?.reactionCtl === ctl) { g.reacting = false; g.reactEnd = gameClock.now() } }
}
async function reactCatch (session, ctl, opts, h) {
  try { return await reactBody(session, ctl, opts, h) } catch (e) {
    if (ctl.aborted || e.code === 'REFLEX_CANCELLED') return { acted: false, cancelled: true }
    log('ошибка ответа', { error: e.message, foe: h.e && h.e.name }); return { acted: true, how: 'ошибка', error: e.message }
  }
}
async function reactBody (session, ctl, opts, h) {
  const bot = session.bot
  const dimension = bot.game?.dimension
  const active = () => {
    if (ctl.aborted || session.bot !== bot || !bot.entity || (bot.health ?? 0) <= 0 || bot.game?.dimension !== dimension || bot._ndGuard?.ended) {
      throw Object.assign(new Error('guard: defensive action cancelled'), { code: 'REFLEX_CANCELLED' })
    }
  }
  const step = async work => { const result = await work; active(); return result }
  active()
  // Also capture the ray before a direct guard call closes the hole (tactics can be off).
  if (process.env.ND_BRUTE_MEMORY === '1') (require('../brute-memory') as typeof import('../brute-memory')).observe(bot, true)
  const t0 = gameClock.now()
  const hp0 = Math.round(bot.health ?? 0)
  try { bot.pathfinder && bot.pathfinder.setGoal(null) } catch {}
  bot.clearControlStates()
  const foes = meleeFoes(bot, 6)
  const e = h.e
  const bruteGuard = process.env.ND_BRUTE_GUARD === '1' && e.name === 'piglin_brute'
  const rest = (options: any) => sit(session, ctl, opts.sitMs ?? 25000, { ...options,
    ...(bruteGuard ? { swing: false, hitStop: true, safeWhile: () => {
      const near = meleeFoes(bot, 12)
      return near.length === 0 || above(bot, near)
    } } : {}) })
  // Видимые (луч) и тот, кто бьёт: за стеной сущность игроку не видна (AGENTS.md, без рентгена).
  const big = !!opts.hide || bigMelee(bot, meleeFoes(bot, 8).filter((f: any) => f === e || sees(bot, f)), e)
  const out: any = { acted: true, why: h.why, foe: e.name, foes: foes.length, hp0 }
  // Уже на своём столбе над ними (2.5+): рукой не достают — сидеть и бить сверху, а не строить второй столб.
  if (big && above(bot, foes)) {
    out.how = 'столб (уже)'
    out.sat = await step(rest({ swing: true }))
    if (!out.sat.danger && !out.sat.hit) {
      out.hp = Math.round(bot.health ?? 0); out.s = Math.round((gameClock.now() - t0) / 1000)
      log('ответ', out)
      return out
    }
  }
  if (big) {
    const f0 = bot.entity.position.floored()
    // From sight, before native aggro: four blocks take about 40 ticks. Never the answer after a melee hit.
    if (bruteGuard && e.position.distanceTo(bot.entity.position) >= 15.5 && e.position.y <= bot.entity.position.y + .1 && pillarFits(bot)) {
      const y0 = bot.entity.position.y
      const tower = await step((require('../build') as typeof import('../build')).towerUp(bot, ctl, 4,
        { sneak: true, fast: true, item: guardItem(bot), maxDigMs: 0 }))
      const near = meleeFoes(bot, 16)
      if (tower.ok && bot.entity.position.y >= y0 + 3.9 && (!near.length || above(bot, near))) {
        out.how = 'столб заранее'
        out.sat = await step(rest({ swing: false }))
        if (!out.sat.danger && !out.sat.hit) return { ...out, hp: Math.round(bot.health ?? 0) }
      }
    }
    // A melee hit leaves only the next axe cooldown: close physical walls before another jump-place.
    if (bruteGuard && e.position.distanceTo(bot.entity.position) <= 4.5) {
      out.box = await step(boxIn(bot, e, { ctl }).catch(err => ({ ok: false, why: err.message })))
      if (out.box.ok) {
        out.how = 'коробка от брута'
        out.sat = await step(sit(session, ctl, opts.sitMs ?? 25000, { hitStop: true }))
        if (!out.sat.hit) return { ...out, hp: Math.round(bot.health ?? 0) }
      }
      return { ...out, failed: true, reason: 'брут вплотную: укрытие не подтверждено', how: 'укрытие не удержало' }
    }
    // Нора на 2 вниз в толще — быстрее столба (netherrack железной киркой — доли секунды на клетку) и не рвётся отбрасыванием:
    // с глубины 2 ходячий нас рукой не достаёт, а мы бьём его по ногам с края; третья клетка и пробка — от арбалета. Сцена
    // try-lab-ne-piglin 14.10: столб под ударами «не подпрыгнул» (отбросило из клетки), брут убивал за 3 с в 7 из 8 попыток.
    if (holeFits(bot)) {
      const hd: any = await step(hideDown(session, ctl).catch(err => ({ ok: false, why: err.message })))
      out.hole = hd
      log('нора', { ...hd, hp: Math.round(bot.health ?? 0) })
      if (hd.ok) {
        if (opts.onOwn && hd.cells) { try { opts.onOwn(hd.cells) } catch {} }
        out.how = 'нора'
        out.sat = await step(rest({ swing: !hd.capped }))
        if (bruteGuard && (out.sat.danger || out.sat.hit)) return { ...out, failed: true, reason: 'нора не держит брута' }
        out.hp = Math.round(bot.health ?? 0); out.s = Math.round((gameClock.now() - t0) / 1000)
        log('ответ', out)
        return out
      }
    }
    const PH = pillarHeight()
    if (!bruteGuard && pillarFits(bot)) {
      const y0 = bot.entity.position.y
      const ti = guardItem(bot)
      const tw = await step((require('../build') as typeof import('../build')).towerUp(bot, ctl, PH, { sneak: true, ...(bruteGuard ? { fast: true, maxDigMs: 0 } : {}), ...(ti ? { item: ti } : {}) }).catch(err => ({ ok: false, reason: err.message })))
      if (bot.entity.position.y >= y0 + PH - 0.1) {
        out.how = 'столб'
        out.sat = await step(rest({ swing: true }))
        if (bruteGuard && (out.sat.danger || out.sat.hit)) return { ...out, failed: true, reason: 'столб не держит брута' }
        bot.setControlState('sneak', false)
        // Врагов в 8 нет — слезть (копать столб под собой), иначе дальше план со столба.
        if (!meleeFoes(bot, 8).length && !ctl.aborted) { try { out.down = (await step((require('../pearls') as typeof import('../pearls')).pillarDown(bot, ctl, session.mcData, f0))).ok } catch {} }
        active()
        out.hp = Math.round(bot.health ?? 0); out.s = Math.round((gameClock.now() - t0) / 1000)
        log('ответ', out)
        return out
      }
      out.tower = tw && (tw.reason || tw.why || tw.placed)
    }
    // Коробка: клетка занята сущностью — щит к врагу и ещё раз (до 3 с): моб у рта ямы отходит на полшага.
    let bx: any = await step(boxIn(bot, e, { ctl }).catch(err => ({ ok: false, why: err.message })))
    const tb = gameClock.now()
    const hasShield = !!(bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield')
    while (!bx.ok && !bx.pressure && gameClock.now() - tb < 3000 && !ctl.aborted && (bot.health ?? 0) > 0 && bx.left && bx.left.length) {
      try { await bot.lookAt(e.position.offset(0, 1.6, 0), true) } catch {}
      if (hasShield) { try { bot.activateItem(true) } catch {} }
      await step(sleep(250))
      if (hasShield) { try { bot.deactivateItem() } catch {} }
      const nb: any = await step(boxIn(bot, e, { ctl }).catch(err => ({ ok: false, why: err.message })))
      bx = { ...nb, placed: (bx.placed || 0) + (nb.placed || 0) }
    }
    out.box = bx
    if (bx.ok) {
      if (opts.onOwn) { try { opts.onOwn([]) } catch {} }
      out.how = 'коробка'
      out.sat = await step(sit(session, ctl, opts.sitMs ?? 25000, { hitStop: true }))
      if (out.sat.hit && !ctl.aborted) {
        // Бьют сквозь коробку — заложить и диагонали (ноги и голова), снова сидеть; бьют и так — бой до конца.
        const bd = await step(boxIn(bot, e, { diag: true, ctl }).catch(err => ({ ok: false, why: err.message })))
        out.boxDiag = bd
        if (bd.ok) out.sat2 = await step(sit(session, ctl, opts.sitMs ?? 25000, { hitStop: true }))
        if (bruteGuard && (!bd.ok || out.sat2?.hit)) return { ...out, failed: true, reason: 'коробка не держит брута' }
        if ((!bd.ok || out.sat2?.hit) && !ctl.aborted) { out.last = await step(duel(session, ctl, e, 20000, { crowdOk: true, lastStand: true }).catch(err => ({ error: err.message }))); out.how = 'коробка → бой' }
      }
      out.hp = Math.round(bot.health ?? 0); out.s = Math.round((gameClock.now() - t0) / 1000)
      log('ответ', out)
      return out
    }
  }
  if (bruteGuard) return { ...out, failed: true, reason: 'от брута нет подтверждённого укрытия', how: 'укрыться не вышло' }
  out.how = 'бой'
  const f: any = await step(duel(session, ctl, e, opts.duelMs ?? 15000, { crowdOk: big }).catch(err => ({ error: err.message })))
  out.duel = f
  out.killed = !!(f && f.killed)
  // Бой не задался (толпа, хп) — коробка.
  if (f && (f.stopped === 'хп' || f.stopped === 'толпа')) {
    const bx = await step(boxIn(bot, e, { ctl }).catch(err => ({ ok: false, why: err.message }))); out.box2 = bx
    if (bx.ok) { out.how = 'бой → коробка'; out.sat = await step(sit(session, ctl, opts.sitMs ?? 25000)) } else {
      // Коробки нет (враг в соседней клетке) — бой до конца, а не стоять (проба 03.10: брут вплотную под потолком — стоя смерть).
      out.last = await step(duel(session, ctl, e, 20000, { crowdOk: true, lastStand: true }).catch(err => ({ error: err.message })))
      out.how = 'бой до конца'
    }
  }
  out.hp = Math.round(bot.health ?? 0); out.s = Math.round((gameClock.now() - t0) / 1000)
  log('ответ', out)
  return out
}

// Идёт ответ стража (сторож мимо цикла дела) — подождать его конца (ходьба/план не должны тянуть тело со столба/из коробки).
export function busy (bot) { return !!(bot && bot._ndGuard && bot._ndGuard.reacting) }
export async function waitIdle (bot, ms = 30000) { const t = gameClock.now(); while (busy(bot) && gameClock.now() - t < ms) await sleep(200) }
