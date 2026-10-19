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
    // Контрмеры: его поплавок на мне (метаданные поплавка: зацеплен = мой id + 1). Удочка есть — обратный подтяг
    // (оба поплавка тянут к хозяину: кто дёрнул вторым — тот и тянет), иначе — отметка: бой ударит на подлёте.
    const hookOnMe = hookedBy(bot, e)
    if (hookOnMe && ready('rodCounter')) {
      rest('rodCounter', 2000)
      st.hookedOnMe++
      if (ctx.d >= 3.5 && ctx.d <= ROD_MAX && findItem(bot, i => i.name === 'fishing_rod') && ctx.sees) {
        st.rod++
        const r = await rodPull(bot, ctx.ctl, e, { velFn: ctx.vel })
        if (r.hooked) { st.rodHooked++; st.rodCounter++; used('удочка на удочку — обратный подтяг') } else used('его поплавок на мне — обратный подтяг мимо')
        return { did: 'rod', rush: !!r.hooked }
      }
      used('его поплавок на мне — бью на подлёте')
    }
    // Удочка.
    // Граф боя (S7d): удочка/трезубец — только если калькулятор не нашёл заметно лучшего (ctx.allow).
    const allow = (k) => !ctx.allow || ctx.allow(k)
    if (ready('rod') && ctx.d >= 3.5 && ctx.d <= ROD_MAX) {
      const rp0 = rodPlan(bot, e, { d: ctx.d, dy: ctx.dy, sees: ctx.sees, busy: ctx.busy || {}, theyUp: ctx.theyUp, vel: ctx.vel ? ctx.vel() : null, blocking: !!ctx.blocking })
      // Граф гасит только «просто подтянуть под удар» (по модели урона сближение бегом обычно не хуже); со столба,
      // в лаву/яму, едока, стрелка, убегающего — польза вне модели урона, решает сам план удочки.
      const rp = rp0 && (rp0.why !== 'удочкой подтянул под удар' || allow('rod')) ? rp0 : null
      if (rp) {
        rest('rod', 2500)
        st.rod++
        const r = await rodPull(bot, ctx.ctl, e, { velFn: ctx.vel })
        if (r.hooked) { st.rodHooked++; used(rp.why + ' — зацепил и дёрнул' + (r.probe ? ` (сервер: Motion [${r.probe}], расчёт рывка [${r.expect}])` : '')) } else used(rp.why + ' — мимо')
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

  return { step, chorusMaybe, riptideAway, stuckOf: (e) => stuckOf(bot, e), stats: st, close }
}

export { create }
