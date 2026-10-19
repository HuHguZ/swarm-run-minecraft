// Булава (mace.ts): слежка за ним — взлёт, вершина, булава в руке, угроза «булава сверху», итог толчков, отчёт.
import * as gameClock from '../game-clock'
import { install, healthOf, heldName } from './hands'
import { grounded } from './world'

// ---------------------------------------------------------------- слежка

// За ним на каждом тике физики: вертикальная скорость по позициям (скорость
// сущностей из пакетов mineflayer на 1.21.11 делит на 8000 — edges.
// fixSelfKnockback), взлёт (быстрее прыжка: прыжок 0.42 б/т), вершина полёта,
// что в руке. Отсюда threat() — «булава сверху».
export function track (bot, { enemy, telemetryHp = e => healthOf(bot, e) }: any) {
  install(bot)
  const st: any = {
    launches: 0, launched: 0, peaks: [], smashes: 0, smashHits: 0, dealt: [], selfDmg: 0, fallSmash: 0,
    pushes: 0, pushHits: 0, knockoffs: 0, pushWhy: {}, threats: 0, shieldUps: 0, dodges: 0, threatHp: 0,
    counterHits: 0, mlg: 0
  }
  const his = { id: null, y: null, vy: 0, air: false, launchedAt: 0, peak: null, maceAt: 0, airSince: 0, hist: [] }
  let active = null
  let pushWatch = null
  let hpLast = bot.health ?? 20
  const onHealth = () => {
    const now = bot.health ?? 20
    if (active && now < hpLast) st.threatHp += hpLast - now
    hpLast = now
  }
  const onTick = () => {
    try {
      const e = enemy()
      if (!e || !e.position || e.isValid === false) return
      if (his.id !== e.id) { his.id = e.id; his.y = null; his.air = false; his.peak = null; his.launchedAt = 0; his.hist = [] }
      const y = e.position.y
      // Позиции чужих приходят пакетами, не в такт нашему тику: скорость — по
      // окну в ~150 мс, иначе она скачет между нулём и двойной.
      const now = gameClock.now()
      his.hist.push({ y, t: now })
      while (his.hist.length > 2 && now - his.hist[0].t > 160) his.hist.shift()
      const h0 = his.hist[0]
      const vy = now - h0.t > 30 ? (y - h0.y) / ((now - h0.t) / 50) : 0
      his.y = y
      his.vy = vy
      const air = !grounded(bot, e, vy)
      if (air && !his.air) { his.airSince = gameClock.now(); his.peak = y }
      if (!air) { his.peak = null; his.launchedAt = 0 }
      his.air = air
      if (air && (his.peak == null || y > his.peak)) his.peak = y
      if (air && vy > 0.55) his.launchedAt = gameClock.now()
      if (heldName(e) === 'mace') his.maceAt = gameClock.now()
      // Итог толчка: упал ниже, чем стоял, на 3+ — сбили.
      if (pushWatch && pushWatch.id === e.id) {
        if (y < pushWatch.y0 - 3 && !pushWatch.fell) { pushWatch.fell = true; st.knockoffs++ }
        const hp = telemetryHp(e)
        if (hp != null && pushWatch.hp0 != null && hp < pushWatch.hp0 - 0.4 && !pushWatch.hurt) { pushWatch.hurt = true; st.pushHits++ }
        if (gameClock.now() > pushWatch.until) pushWatch = null
      }
    } catch {}
  }
  bot.on('physicsTick', onTick)
  bot.on('health', onHealth)

  // Он в воздухе над нами после взлёта (или с булавой в руке) и может
  // достать при спуске — или сидит сверху с булавой. null — угрозы нет.
  const threat = () => {
    const e = enemy()
    if (!e || !e.position || e.isValid === false || !bot.entity) return (active = null)
    const me = bot.entity.position
    const dy = e.position.y - me.y
    const dh = Math.hypot(e.position.x - me.x, e.position.z - me.z)
    const mace = gameClock.now() - his.maceAt < 4000
    // Подбросили его мы сами (свой заряд в него) — это не его взлёт.
    const ours = pushWatch && pushWatch.id === e.id && gameClock.now() - pushWatch.at < 2000
    const launched = his.launchedAt && gameClock.now() - his.launchedAt < 2500 && !ours
    let out = null
    // Без взлёта и без булавы — только настоящее падение на нас (уже летит
    // вниз и упал от вершины на 1.5+): подпрыгивать на своём столбе — не угроза
    // (арена 2026-09-26: «булава сверху ×21» от прыжков на столбе).
    const dropping = his.vy < -0.3 && his.peak != null && his.peak - e.position.y > 1.5 && his.peak - me.y > 3.5 && dh < 3.5
    if (his.air && dy > 1.5 && dh < 5.5 && (launched || mace || dropping)) {
      // Когда он будет на высоте нашей головы: прогон по вертикали.
      let yy = e.position.y; let vv = his.vy; let n = 0
      const headY = me.y + 1.8
      while (n < 40 && !(vv < 0 && yy <= headY + 1.2)) { vv = (vv - 0.08) * 0.98; yy += vv; n++ }
      out = { kind: 'air', dy, dh, vy: his.vy, eta: n, mace, launched: !!launched, peak: his.peak }
    } else if (!his.air && mace && dy > 2.4 && dh < 3.6) {
      out = { kind: 'above', dy, dh, eta: 99, mace: true }
    }
    if (out && !active) st.threats++
    // Та же угроза, что и тиком раньше, — тот же объект: на нём метки «щит уже
    // подняли», «уже уходил» (счёт в отчёте — по угрозам, не по тикам).
    if (out && active && active.kind === out.kind) { Object.assign(active, out); return active }
    active = out
    return out
  }

  return {
    st,
    his,
    threat,
    notePush (e, why) {
      st.pushes++
      st.pushWhy[why] = (st.pushWhy[why] || 0) + 1
      pushWatch = { id: e.id, y0: e.position.y, hp0: telemetryHp(e), at: gameClock.now(), until: gameClock.now() + 3000 }
    },
    report () {
      const avg = a => a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length * 10) / 10 : undefined
      const out = {
        launches: st.launches || undefined,
        launched: st.launched || undefined,
        peak: st.peaks.length ? avg(st.peaks) : undefined,
        smashes: st.smashes || undefined,
        smashHits: st.smashHits || undefined,
        fallSmash: st.fallSmash || undefined,
        stunSlams: st.stunSlams || undefined,
        dealt: st.dealt.length ? st.dealt.map(x => Math.round(x * 10) / 10) : undefined,
        selfDmg: st.selfDmg ? Math.round(st.selfDmg * 10) / 10 : undefined,
        pushes: st.pushes || undefined,
        pushHits: st.pushHits || undefined,
        knockoffs: st.knockoffs || undefined,
        pushWhy: Object.keys(st.pushWhy).length ? st.pushWhy : undefined,
        threats: st.threats || undefined,
        shieldUps: st.shieldUps || undefined,
        dodges: st.dodges || undefined,
        threatHp: st.threatHp ? Math.round(st.threatHp * 10) / 10 : undefined,
        counterHits: st.counterHits || undefined,
        mlg: st.mlg || undefined,
        // 2026-09-26: второй заряд стоя после неудачного взлёта; увёл посадку
        // из огня/лавы или не смог.
        retries: st.retries || undefined,
        rebounds: st.rebounds || undefined,
        burnDodge: st.burnDodge || undefined,
        burnNoWay: st.burnNoWay || undefined
      }
      return (Object.values(out) as any[]).some(v => v !== undefined) ? out : undefined
    },
    close () {
      bot.removeListener('physicsTick', onTick)
      bot.removeListener('health', onHealth)
    }
  }
}
