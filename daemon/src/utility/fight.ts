'use strict'
// Подручное (utility.ts): на бой — планировщик приёмов (ловушки, ответ на его удочку, удочка, трезубец, «Тягун»),
// уход «Тягуном» и хорусом, счёт приёмов в отчёт боя.
import * as gameClock from '../game-clock'
import * as edges from '../edges'
import { raySees, raining } from '../perception'
import { sleep } from '../movement'
import { EYE, USE_RANGE, TICK_MS, findItem, isPlayer, hpOf } from './common'
import { ROD_MAX, installRodPull, hookedBy, rodPlan, rodPull } from './rod'
import { tridents, rainAt, wetOrRain, tridentPlan, throwTrident, riptide } from './trident'
import { escapeChoice, chorusEscape } from './chorus'
import { stuckOf, anvilPlan, dropAnvil, blockInPlan, blockIn, lavaPlan, pourLava } from './traps'
import { Vec3 } from './common'

// ================================================================ на бой

// Один раз на бой: планировщик приёмов и счёт. used — в отчёт боя.
function create (bot, { used = () => {}, tt = null }: any = {}) {
  installRodPull(bot)
  const st: any = { rod: 0, rodHooked: 0, hookedOnMe: 0, rodCounter: 0, trident: 0, tridentHit: 0, bolts: 0, riptide: 0, chorus: 0, anvils: 0, anvilDmg: [], boxes: 0, lava: 0, pulledMe: 0 }
  const cd = {}
  const ready = (k) => gameClock.now() >= (cd[k] || 0)
  const rest = (k, ms) => { cd[k] = gameClock.now() + ms }
  const pending = [] // своя лава: забрать ведром
  const onPulled = () => { st.pulledMe++ }
  bot.on('nd_rodPulled', onPulled)

  // Лава, поставленная ловушкой, — обратно в ведро через 3 с, если достаём.
  const scoop = async () => {
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i]
      if (gameClock.now() - p.at < 3000) continue
      pending.splice(i, 1)
      const b = bot.blockAt(p.cell)
      const bucket = findItem(bot, it => it.name === 'bucket')
      if (!b || b.name !== 'lava' || !bucket) continue
      if (p.cell.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, EYE, 0)) > USE_RANGE) continue
      try { await bot.equip(bucket, 'hand'); await bot.lookAt(p.cell.offset(0.5, 0.3, 0.5), true); await sleep(50); bot.activateItem(); await sleep(80) } catch {}
      return true
    }
    return false
  }

  // Шаг боя: один приём или null. ctx: { entity, d, dy, r, hp, sees, theyUp,
  // busy (tt.state), vel(), others[], ctl, onDraw }.
  const step = async (ctx) => {
    const e = ctx.entity
    if (!e || !isPlayer(e) || !bot.entity) return null
    if (pending.length && (await scoop())) return { did: 'scoop' }
    const stuck = ctx.d < 6 ? stuckOf(bot, e) : null
    // Ловушки: он застрял рядом.
    if (stuck && ready('trap')) {
      const lp = stuck !== 'коробка' && !(ctx.busy && ctx.busy.burning) ? lavaPlan(bot, e) : null
      if (lp) {
        rest('trap', 4000)
        const r = await pourLava(bot, e, lp)
        if (r.ok) { st.lava++; pending.push({ cell: r.cell, at: gameClock.now() }); used(`ловушка: лава на него (${stuck})`); return { did: 'lava' } }
      }
      if (stuck === 'паутина' && ctx.d <= 3.4 && !(ctx.others || []).some(o => o.position.distanceTo(bot.entity.position) < 5) && ready('box')) {
        const bp = blockInPlan(bot, e)
        if (bp) {
          rest('box', 8000)
          const r = await blockIn(bot, ctx.ctl, e, bp)
          if (r.placed) { st.boxes++; used(r.ok ? `ловушка: запер в коробке 1×2 (${r.placed} бл.)` : `ловушка: коробка не сомкнулась (${r.placed} бл.)`) }
          if (r.placed) return { did: 'box' }
        }
      }
      const ap = anvilPlan(bot, e)
      if (ap) {
        rest('trap', 4000)
        const r = await dropAnvil(bot, ctx.ctl, e, ap)
        if (r.ok) { st.anvils++; if (r.dealt != null) st.anvilDmg.push(r.dealt); used(`ловушка: наковальня с ${ap.k} бл. (${stuck}${r.built ? `, опора ${r.built}` : ''}) — снял ${r.dealt ?? '?'} хп`); return { did: 'anvil' } }
        used('ловушка: наковальня не вышла — ' + r.why)
        rest('trap', 2500)
      }
    }
    const allow = (k) => !ctx.allow || ctx.allow(k)
    // Контрмеры: его поплавок на мне (метаданные поплавка: зацеплен = мой id + 1). Удочка есть — обратный подтяг
    // (оба поплавка тянут к хозяину: кто дёрнул вторым — тот и тянет), иначе — отметка: бой ударит на подлёте.
    const hookOnMe = hookedBy(bot, e)
    if (hookOnMe && ready('rodCounter')) {
      rest('rodCounter', 2000)
      st.hookedOnMe++
      if (ready('rod') && allow('rod') && ctx.d >= 3.5 && ctx.d <= ROD_MAX && findItem(bot, i => i.name === 'fishing_rod') && ctx.sees) {
        rest('rod', 2500)
        const r = await rodPull(bot, ctx.ctl, e, { velFn: ctx.vel, threatFn: ctx.threat })
        if (r.casted) st.rod++
        if (r.hooked) { st.rodHooked++; st.rodCounter++; used('удочка на удочку — обратный подтяг') } else used(r.interrupted ? 'бросил удочку: угроза' : 'его поплавок на мне — обратный подтяг мимо')
        return { did: 'rod', rush: !!r.hooked }
      }
      used('его поплавок на мне — бью на подлёте')
    }
    // Удочка.
    // Граф боя (S7d): удочка/трезубец — только если калькулятор не нашёл заметно лучшего (ctx.allow).
    if (ready('rod') && ctx.d >= 3.5 && ctx.d <= ROD_MAX) {
      const rp0 = rodPlan(bot, e, { d: ctx.d, dy: ctx.dy, sees: ctx.sees, busy: ctx.busy || {}, theyUp: ctx.theyUp, vel: ctx.vel ? ctx.vel() : null, blocking: !!ctx.blocking })
      // Геометрия ловушки не отменяет цену заброса и промахов по этой цели.
      const rp = rp0 && allow('rod') ? rp0 : null
      if (rp) {
        rest('rod', 2500)
        const r = await rodPull(bot, ctx.ctl, e, { velFn: ctx.vel, threatFn: ctx.threat })
        if (r.casted) st.rod++
        if (r.hooked) { st.rodHooked++; used(rp.why + ' — зацепил и дёрнул' + (r.probe ? ` (сервер: Motion [${r.probe}], расчёт рывка [${r.expect}])` : '')) } else used(r.interrupted ? 'бросил удочку: угроза' : rp.why + ' — мимо')
        return { did: 'rod', rush: !!r.hooked }
      }
    }
    // Трезубец в него.
    if (ready('trident')) {
      // Против игрока — оценка хп (ctx.foeHp из pvp.foeHpDecide), не метаданные: человек их не видит (AGENTS.md).
      const ehp = ctx.foeHp !== undefined ? ctx.foeHp : hpOf(bot, e)
      const tp = tridentPlan(bot, e, { d: ctx.d, sees: ctx.sees, finishing: ehp != null && ehp <= 5 })
      if (tp && (ctx.d > 7 || (ctx.busy && ctx.busy.consuming)) && allow('trident')) {
        rest('trident', 1800)
        st.trident++
        const r = await throwTrident(bot, e, tp.t, { velFn: ctx.vel, onDraw: ctx.onDraw })
        if (r.ok) {
          used(tp.why)
          // Молния «Громовержца» у него (сущность lightning_bolt в 4 бл. от него за 2 с после броска) — счёт.
          const tB = gameClock.now()
          const onBolt = (en) => {
            if (gameClock.now() - tB > 2000) { bot.removeListener('entitySpawn', onBolt); return }
            if (en && en.name === 'lightning_bolt' && e.position && en.position && en.position.distanceTo(e.position) <= 4) { st.bolts = (st.bolts || 0) + 1; used('трезубец: молния в него'); bot.removeListener('entitySpawn', onBolt) }
          }
          bot.on('entitySpawn', onBolt)
          gameClock.setTimeout(() => bot.removeListener('entitySpawn', onBolt), 2100)
          // Попал ли: его damage_event с причиной «я» (или он погиб) за время полёта; хп по метаданным — запасной
          // признак (S7d: убийство броском «was impaled» не засчитывалось — сущность снята раньше метаданных).
          const t0 = gameClock.now()
          let byMe = false
          const onDmg = (pk) => { try { if (pk && pk.entityId === e.id && bot.entity && pk.sourceCauseId === bot.entity.id + 1) byMe = true } catch {} }
          try { bot._client.on('damage_event', onDmg) } catch {}
          try {
            while (gameClock.now() - t0 < Math.min(1500, (r.ticks || 10) * 50 + 400)) {
              const h = hpOf(bot, e)
              if (byMe || e.isValid === false || (h != null && r.hp0 != null && h < r.hp0 - 0.4)) { st.tridentHit++; used('трезубец попал'); break }
              await sleep(TICK_MS)
            }
          } finally { try { bot._client.removeListener('damage_event', onDmg) } catch {} }
          return { did: 'trident' }
        }
      }
    }
    // «Тягун» в грозу/дождь или в воде — рывком к нему: касание 8 урона.
    if (ready('riptideNote') && ctx.d > 6 && tridents(bot).some(t => t.riptide) && !wetOrRain(bot)) {
      rest('riptideNote', 10000)
      used(`трезубец: «Тягун» ждёт воды или дождя (дождь ${raining(bot) ? 'идёт' : 'нет'} [флаг ${!!bot.isRaining}, уровень ${Math.round((bot.rainState || 0) * 100) / 100}], небо над головой ${rainAt(bot, bot.entity.position) ? 'открыто' : 'закрыто'})`)
    }
    if (ready('riptide') && ctx.d > 6 && ctx.d < 14 && ctx.hp >= 10 && ctx.sees && wetOrRain(bot) && tridents(bot).some(t => t.riptide)) {
      rest('riptide', 5000)
      const me = bot.entity.position
      const yaw = Math.atan2(-(e.position.x - me.x), -(e.position.z - me.z))
      const r = await riptide(bot, yaw, 0.12, { ctl: ctx.ctl })
      if (r.ok) { st.riptide++; used(`трезубец: «Тягун ${r.level}» рывком к нему (${r.moved} бл.)`); return { did: 'riptide' } }
      used('трезубец: «Тягун» не вышел — ' + r.why)
    }
    return null
  }

  // Уход «Тягуном» из-под двоих или на последних хп (дождь или вода).
  const riptideAway = async (foes, ctl = null) => {
    if (!ready('riptideAway') || !wetOrRain(bot) || !tridents(bot).some(t => t.riptide)) return null
    const me = bot.entity.position
    let sx = 0; let sz = 0
    for (const f of foes) { const d = Math.max(0.5, f.position.distanceTo(me)); sx += (me.x - f.position.x) / d; sz += (me.z - f.position.z) / d }
    if (!sx && !sz) return null
    const yaw = Math.atan2(-sx, -sz)
    // Путь свободен на 6 блоков и там есть пол (не в дыру арены).
    const dir = new Vec3(-Math.sin(yaw), 0, -Math.cos(yaw))
    const eye = me.offset(0, 1.2, 0)
    if (!raySees(bot, eye, eye.plus(dir.scaled(6)))) return null
    const landAt = me.plus(dir.scaled(9))
    try { if (edges.lethalAt(bot, landAt, new Map())) return null } catch {}
    rest('riptideAway', 6000)
    const r = await riptide(bot, yaw, 0.12, { ctl })
    if (r.ok) { st.riptide++; used(`трезубец: «Тягун ${r.level}» — ушёл рывком (${r.moved} бл.)`) }
    return r
  }

  // «Тягун → булава» (пользователь 24.10, трамплин трезубцем): в дождь или воде рывок крутой дугой к нему, в воздухе — булава
  // в руку, удар с падения (MaceItem: бонус от fallDistance; попадание гасит падение). Цена промаха — урон падения: допускаем
  // не больше, чем оставит 8 хп. Лужа впереди не нужна: на арене гроза (wetOrRain).
  // ND_TRACE_RIPTIDE=1 — почему связка не началась (в вывод демона, раз в 3 с).
  let whyAt = 0
  const no = (why: string) => { if (process.env.ND_TRACE_RIPTIDE === '1' && gameClock.now() - whyAt > 3000) { whyAt = gameClock.now(); console.log(`[riptideSmash] ${bot.username}: ${why}`) } return null }
  const riptideSmash = async (e, ctl) => {
    if (!ready('riptideSmash')) return null
    if (!e?.position || !e.onGround) return no('враг не на земле')
    if (!wetOrRain(bot)) {
      const f = bot.entity.position.floored(), bio = bot.blockAt(f)?.biome
      let over = 'небо'
      for (let y = f.y + 1; y < 320; y++) { const b = bot.blockAt(f.offset(0, y - f.y, 0)); if (!b) { over = `null на ${y}`; break } if (b.boundingBox === 'block' || /water|lava|leaves|glass|barrier/.test(b.name)) { over = `${b.name} на ${y}`; break } }
      return no(`сухо: дождь ${!!bot.isRaining}, биом ${bio?.name ?? bio?.id} осадки ${bio?.has_precipitation} t ${bio?.temperature}, над головой ${over}, я на ${f.y}`)
    }
    if ((bot.health ?? 0) < 12) return no(`хп ${bot.health}`)
    const t = tridents(bot).filter(x => x.riptide).sort((a, b) => b.riptide - a.riptide)[0], mace = findItem(bot, i => i.name === 'mace')
    const me = bot.entity.position, d = Math.hypot(e.position.x - me.x, e.position.z - me.z)
    if (!t || !mace) return no(`трезубец ${!!t}, булава ${!!mace}`)
    if (d < 4 || d > 14) return no(`до него ${d.toFixed(1)} бл.`)
    // Промах — падение с вершины (fallDistance − 3): без страховки — не больше, чем оставит 8 хп. Страховка (пользователь 24.10:
    // «можно же ведро воды себе подкинуть — комбинировать, а не сдаваться»): ведро воды (не в Аду) или паутина — сторож
    // падения (edges/mlg installFallGuard) гасит промах в последний тик, и высокая дуга «Тягуна» II–III тоже годится.
    const nether = /nether/.test(String(bot.game?.dimension || ''))
    const insurance = !nether && findItem(bot, i => i.name === 'water_bucket') ? 'water_bucket' : findItem(bot, i => i.name === 'cobweb') ? 'cobweb' : null
    const maxApex = insurance ? 48 : (bot.health ?? 0) - 8 + 3
    const rt: typeof import('../navigation/riptide') = require('../navigation/riptide')
    const arcs = rt.riptideArcs(t.riptide, me, e.position, maxApex)
    if (!arcs.length) return no(`дуги нет (Тягун ${t.riptide}, вершина ≤ ${maxApex.toFixed(0)})`)
    // До заряда — посадка и путь вращения мимо своих (у цели толпа: runRiptide срывал выпуск riptide_allied_spin_collision
    // уже после 13 тиков заряда, 2 из 4 на стенде); первый годный курс, прямой — первым.
    bot._ndRiptideMace = { maxDamage: insurance ? 1000 : Math.max(0, (bot.health ?? 0) - 8) }
    const why: string[] = []
    let arc = null
    try { arc = arcs.find(a => { const w = rt.riptideArcSafe(bot, t.riptide, a.yaw, a.pitch); if (w) why.push(w); return !w }) } finally { delete bot._ndRiptideMace }
    if (!arc) return no(`дуги ${arcs.length}, все отпали: ${[...new Set(why)].join(', ')}`)
    console.log(`[riptideSmash] ${bot.username}: взлёт (Тягун ${t.riptide}), до него ${d.toFixed(1)} бл., вершина ${arc.apex.toFixed(1)}, страховка ${insurance || 'нет'}`)
    rest('riptideSmash', 8000)
    // Связка не делится (стенд 24.10: рой посреди заряда слал goto/flee, бой обрывался — 3 из 5 взлётов «interrupted»): в
    // статусе — combo (рой этого бота не перебивает), после отрыва спуск ведёт своя отмена — только смерть.
    const flightMs = 2500 + arc.apex * 120
    bot._ndCombo = { kind: 'riptide_mace', until: gameClock.now() + 2000 + flightMs }
    try { return await riptideSmashRun(e, ctl, t, mace, arc, insurance, flightMs) } finally { delete bot._ndCombo }
  }
  const riptideSmashRun = async (e, ctl, t, mace, arc, insurance, flightMs) => {
    // Сторож берёт страховку только из хотбара (waterReady/webReady) — положить туда до взлёта.
    // Булава — тоже в хотбар: после выпуска взять её сменой слота в тот же тик (bot.equip ждал сервер ~1 с, спуск начинался
    // уже на падении — стенд 24.10: вершина спуска 14 бл. вместо 39, сел в 15 бл. от него).
    const hands: typeof import('../mace/hands') = require('../mace/hands')
    await hands.ensureHotbar(bot, insurance ? ['mace', insurance] : ['mace']).catch(() => {})
    bot._ndRiptideMace = { maxDamage: insurance ? 1000 : Math.max(0, (bot.health ?? 0) - 8) }
    let r
    // Заряд и выпуск — тоже до конца: срок боя (timeoutSeconds 3) кончался посреди 13 тиков заряда.
    const alive = { get aborted () { return !bot.entity || !((bot.health ?? 0) > 0) } }
    try { r = await riptide(bot, arc.yaw, arc.pitch, { ctl: alive }) } finally { delete bot._ndRiptideMace }
    console.log(`[riptideSmash] ${bot.username}: ${r.ok ? 'взлетел' : 'не взлетел — ' + r.why}`)
    if (!r.ok) { used(`трезубец+булава: не взлетел (${r.why || '?'})`); return r }
    st.riptide++
    const slot = hands.hotbarIndex(bot, 'mace')
    if (slot >= 0) bot.setQuickBarSlot(slot)
    else try { await bot.equip(mace, 'hand') } catch {}
    // Спуск: скорость цели — по наблюдённым позициям (сырой entity.velocity у чужого игрока — из редких пакетов), срок —
    // весь полёт: с вершины 40 бл. подъём и падение ~3.3 с, прежние 3.5 с обрывали спуск у самой цели.
    const track: typeof import('../bow/track') = require('../bow/track')
    const res = await (require('../mace') as typeof import('../mace')).descend(bot, alive, e, { stats: st, vel: () => track.observedVelocity(e), maxMs: flightMs })
    used(`трезубец+булава: «Тягун ${r.level}» дугой вверх на ${arc.apex.toFixed(0)} бл. — ${res?.hit ? 'удар булавой с падения' : 'мимо'}`)
    const me2 = bot.entity.position, ep = e.position
    console.log(`[riptideSmash] ${bot.username}: ${res?.hit ? `удар булавой с падения ${res.hit.fall} бл.` : 'мимо'} — ${res?.why}, вершина ${(res?.peak - ep.y).toFixed(1)}, за ${res?.ms} мс, конец в ${Math.hypot(me2.x - ep.x, me2.z - ep.z).toFixed(1)} бл. от него`)
    return { ...r, hit: !!res?.hit }
  }

  const chorusMaybe = async (ctl, ctx) => {
    if (!ready('chorus')) return null
    const ch = escapeChoice(bot, ctx)
    if (!ch) return null
    rest('chorus', 2500)
    if (!ch.use) { if (ready('chorusNote')) { rest('chorusNote', 8000); used(`хорус: не ем — ${ch.why} (перенос ${ch.odds.tp}%, ниже на 4+ ${ch.odds.low}%)`) } return null }
    const r = await chorusEscape(bot, ctl)
    if (r.ok) { st.chorus++; used(`хорус: ${ch.why} — прыгнул на ${r.moved} бл. (прогноз: от врага 6+ в ${ch.odds.away6}%, сдвиг ~${ch.odds.move})`) } else used(`хорус: ${ch.why} — ${r.why || 'не перенесло'}`)
    return r
  }

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    bot.removeListener('nd_rodPulled', onPulled)
    if (st.pulledMe) used(`удочкой дёрнули меня ×${st.pulledMe} (сдвинулся сам, как клиент)`)
    const bits = []
    if (st.rod) bits.push(`удочка ${st.rodHooked}/${st.rod}`)
    if (st.hookedOnMe) bits.push(`меня зацепили ${st.hookedOnMe}, обратный подтяг ${st.rodCounter}`)
    if (st.trident) bits.push(`трезубец ${st.tridentHit}/${st.trident}`)
    if (st.riptide) bits.push(`«Тягун» ${st.riptide}`)
    if (st.chorus) bits.push(`хорус ${st.chorus}`)
    if (st.anvils) bits.push(`наковальня ${st.anvils} (${st.anvilDmg.join(', ')} хп)`)
    if (st.boxes) bits.push(`коробка ${st.boxes}`)
    if (st.lava) bits.push(`лава-ловушка ${st.lava}`)
    if (bits.length) used('подручное: ' + bits.join(', '))
  }

  return { step, chorusMaybe, riptideAway, riptideSmash, stuckOf: (e) => stuckOf(bot, e), stats: st, close }
}

export { create }
