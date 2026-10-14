'use strict'
// Угрозы бойцу (сообщения danger от демона): рывок прочь, стрейф и джук от прицела, заливка лавы, ответ тем, что в руках.
import { SEG_S } from './context'
import { geared } from './gear'
import type { ArenaContext } from './context'

export function installDangers (ctx: ArenaContext) {
  const { arms, bots, pos, busy, out, deadNow, X, Y, Z, R, L, log } = ctx
  ctx.dodgeAway = (o, me, from, dist, then: (() => void) | null = null, look: any = null, dropOk = false) => {
    let ax = me.x - from.x; let az = me.z - from.z; const L0 = Math.hypot(ax, az)
    if (L0 < 0.5) { const a = Math.random() * 2 * Math.PI; ax = Math.cos(a); az = Math.sin(a) } else { ax /= L0; az /= L0 }
    busy.add(o.name)
    // Рывок — спринт с прыжками (тело: evade), а не путь до точки (12.10: «бегать и прыгать при увороте»); прыгучесть — своя.
    o.c.call('evade', { dir: { x: ax, z: az }, ticks: Math.max(4, Math.min(26, dist / 0.33)), jump: Math.random() < (o.dodgeStyle?.jumpy ?? 0.75), look, dropOk }).then(r => { const d = r?.detail || r; if (d?.ok === false) o.noEvadeUntil = Date.now() + 3000; if (!d?.ok) log(`⛔ ${o.name}: рывок не вышел — ${d?.why || r?.error || r?.status || '?'}`) }).catch(e => log(`⛔ ${o.name}: рывок — ${e.message}`))
      .finally(() => { busy.delete(o.name); if (then) then() })
  }
  for (const b of bots) b.c.onDanger = (m) => {
    if (ctx.between || out.has(b.name) || deadNow.has(b.name) || !m.pos) return
    const d = m.dangers || {}
    // Перезарядка — своя у каждого вида (12.10: «зелья сверху кидаю — не уворачиваются»: общая перезарядка после стрейфа
    // от прицела секунду глушила летящее зелье). Вид на перезарядке — следующий по важности.
    const cd = b.dangerCd || (b.dangerCd = {})
    const ready = (k) => (cd[k] || 0) <= Date.now()
    const sm = ready('sm') && d.smashes?.[0]; const pt = ready('pt') && d.potions?.[0]; const ar = ready('ar') && d.arrows?.[0]; const am = ready('am') && d.aims?.[0]; const lv = ready('lv') && d.lava?.[0]; const cl = ready('cl') && d.clouds?.[0]
    const src = sm || pt || ar || am || lv || cl
    if (!src) return
    // Джук сам уходит от стрел и прицела — его перебивают только булава и зелье.
    if (b.juking && !sm && !pt) return
    const st = b.dodgeStyle || (b.dodgeStyle = { delay: 40 + Math.random() * 160, len: 1.8 + Math.random() * 1.8, cd: 500 + Math.random() * 500, skip: 0.05 + Math.random() * 0.15, jumpy: 0.5 + Math.random() * 0.5 })
    const jit = (k) => k * (0.7 + Math.random() * 0.6)
    const kind = src === sm ? 'sm' : src === pt ? 'pt' : src === ar ? 'ar' : src === am ? 'am' : src === lv ? 'lv' : 'cl'
    cd[kind] = Date.now() + (src === cl ? 600 : src === am ? jit(st.cd) : src === lv ? 1500 : src === ar ? 250 : 600)
    // В рукопашной (бой и враг ближе 4.5 бл.) от прицела и стрел не стрейфить: уворот рвёт бой (арена 14.10: один лучник
    // прицелился — трое бросили свои схватки, ни одного удара; пользователь: «рои вырезают друг друга до конца»).
    if ((src === am || src === ar) && b.last?.m === 'fight' && ctx.enemiesOf(b, m.pos).some(e => e.d <= 4.5 && !e.mob)) return
    // Прицел: увернуться было некуда (столб, уступ) — 3 с драться, а не дёргаться; вплотную (≤ 4 бл.) — бить, а не стрейфить.
    if (src === am && (Math.random() < st.skip * 0.5 || (b.noEvadeUntil || 0) > Date.now() || Math.hypot(am.at.x - m.pos.x, am.at.y - m.pos.y, am.at.z - m.pos.z) <= 3)) return
    log(sm ? `☂ ${b.name}: ${sm.name} падает на меня (сядет через ${sm.ticks} т; ${sm.dbg}) — рывок` : pt ? `🧪↯ ${b.name}: летит ${pt.name}${pt.role ? ' (' + pt.role + ')' : ''}, ляжет через ${pt.ticks} т — рывок` : lv ? `🌋 ${b.name}: лава в ${lv.d.toFixed(1)} бл. — ${(pos[b.name]?.inv?.water_bucket || 0) > 0 ? 'заливаю водой' : 'отхожу'}` : am ? `🎯↔ ${b.name}: ${am.name} целится в меня (${am.weapon}) — стрейф` : ar ? `🏹↯ ${b.name}: летит ${ar.name}, через ${ar.ticks} т — шаг поперёк` : `🧪☁ ${b.name}: облако зелья — выхожу`)
    // Стрела — шаг поперёк её полёта (side от тела), на 3 бл.
    // Целится — зигзаг: шаг поперёк его линии, каждый раз в другую сторону (12.10: «стрейфить заранее, как только нацеливаюсь»).
    // Лава рядом (12.10: «лаву водой — заранее»): ведро воды есть — залить и забрать воду, нет — отойти.
    if (src === lv) {
      if ((pos[b.name]?.inv?.water_bucket || 0) > 0) { busy.add(b.name); b.c.call('douse_lava', { at: lv.at }).catch(() => {}).finally(() => busy.delete(b.name)) } else ctx.dodgeAway(b, m.pos, lv.at, 3)
      return
    }
    if (src === am) {
      b.strafe = Math.random() < 0.7 ? -(b.strafe || (Math.random() < 0.5 ? 1 : -1)) : (b.strafe || 1)
      // Под обстрелом без ответа (12.10: «бесконечно на мне фокусируются, когда я стреляю, — надо убегать»): лука/арбалета
      // нет, а он выше на 4+ или целится в меня третий раз за 6 с — зигзаг прочь от него (вбок и назад), шаг длиннее.
      b.aimedAt = [...(b.aimedAt || []).filter(t => Date.now() - t < 6000), Date.now()]
      const ranged = Object.keys(pos[b.name]?.inv || {}).some(n => /^(bow|crossbow)$/.test(n)) && (pos[b.name]?.inv?.arrow || 0) > 0
      const retreat = !ranged && (am.at.y - m.pos.y > 4 || b.aimedAt.length >= 3)
      // Непрерывный джук тела (juke), пока он целится: рывки с паузами давали 80 % попаданий с 8 бл. (archer-roof-5).
      const juke = () => {
        if (retreat && Math.random() < 0.3) log(`🏃 ${b.name}: ${am.name} стреляет, а мне нечем — ухожу зигзагом`)
        busy.add(b.name); b.juking = true
        b.c.call('juke', { from: am.name, retreat, jumpy: st.jumpy, maxTicks: 80 }).then(r => { const d = r?.detail || r; if (d?.ok === false || d?.segments === 0) b.noEvadeUntil = Date.now() + 2000 }).catch(() => {})
          .finally(() => { busy.delete(b.name); b.juking = false })
      }
      // Что в руках — то и в ход (12.10: «ветер — ускорять себя, жемчуг — ближе к стрелку и резко атаковать, блоками
      // заставиться, на элитрах — если стоит тратить фейерверки; просто стрейфы — мало»). Вес — от положения (он выше,
      // далеко) и запаса, и у каждого броска — свой случай: одинаково не ходят.
      const fightHim = () => (ctx.swarmDriver.canEngage(b, am.name)
        ? b.c.call('fight', { target: am.name, allowPlayer: true, allowRanged: true, timeoutSeconds: SEG_S, retreatAtHealth: 3, arena: { x: X + 0.5, y: Y, z: Z + 0.5, r: R, killY: arms ? Y + L.y0 - 3 : undefined } })
        : b.c.call('flee', { from: [am.name], timeoutSeconds: 3, safeDist: 14 })).catch(() => {})
      const act = (k, call, ok, after) => {
        busy.add(b.name)
        call().then(r => { const d = r?.detail || r || {}; log(`${k} ${b.name} от прицела ${am.name}: ${ok(d) ? 'вышло' : 'нет'} — ${[d.how, d.stop, d.why, d.error].filter(Boolean).map(x => typeof x === 'object' ? JSON.stringify(x).slice(0, 160) : x).join(' ') || (d.rise != null ? 'взлёт ' + d.rise : '')}`); return ok(d) })
          .catch(() => false).then(good => { busy.delete(b.name); if (good && after) after(); else if (!good) juke() })
      }
      const go = () => {
        if (busy.has(b.name)) return
        if (ctx.swarmDriver.panic(b)) {
          busy.add(b.name)
          b.c.call('flee', { from: [am.name], timeoutSeconds: 3, safeDist: 14 }).catch(() => {}).finally(() => busy.delete(b.name))
          return
        }
        const me = pos[b.name] || {}; const inv = me.inv || {}
        const dH = Math.hypot(am.at.x - m.pos.x, am.at.z - m.pos.z); const above = am.at.y - m.pos.y; const dist = Math.hypot(dH, above)
        const opts: { k: string, w: number }[] = [{ k: 'juke', w: 2 }]
        if ((inv.ender_pearl || 0) > 0 && (b.pearlAt || 0) < Date.now() && dist >= 8 && dist <= 45 && (above > 3 || dH > 14)) opts.push({ k: 'pearl', w: above > 3 ? 5 : 3 })
        if ((inv.elytra || me.armor?.torso === 'elytra') && (inv.firework_rocket || 0) >= 4 && (b.flyAt || 0) < Date.now() && dist > 14) opts.push({ k: 'fly', w: 1.5 + (above > 6 ? 1.5 : 0) })
        if ((inv.wind_charge || 0) > 0 && (b.windAt || 0) < Date.now()) opts.push({ k: 'wind', w: above > 2 && above < 8 && dH < 10 ? 4 : 1.5 })
        if (above > 3 || !ranged) opts.push({ k: 'cover', w: above > 3 ? 3.5 : 1.5 })
        // Есть лук — ответить из-за стенки в прыжке (13.10: «ставит блоки, прыгает и стреляет — очень крутой приём»).
        if (ranged && dist >= 8 && dist <= 35 && (b.peekAt || 0) < Date.now()) opts.push({ k: 'peek', w: 3 })
        let sum = 0; for (const o of opts) { o.w *= 0.5 + Math.random(); sum += o.w }
        let r = Math.random() * sum; const pick = opts.find(o => (r -= o.w) <= 0) || opts[0]
        const at = { x: am.at.x, y: am.at.y, z: am.at.z }
        if (pick.k === 'pearl') { b.pearlAt = Date.now() + 8000; act('🟣', () => b.c.call('pearl_to', { to: at, edgeOk: true, yTop: 45 }), d => !!d.ok, fightHim) }
        else if (pick.k === 'fly') { b.flyAt = Date.now() + 15000; act('🪽', () => b.c.call('fly_to', { at, timeoutSeconds: 20 }), d => !!d.ok, fightHim) }
        else if (pick.k === 'wind') {
          b.windAt = Date.now() + 3000
          const up = above > 2 && above < 8 && dH < 10
          const sd = Math.random() < 0.5 ? 1 : -1
          const to = up ? at : { x: m.pos.x + am.side.x * sd * 6, z: m.pos.z + am.side.z * sd * 6 }
          act('💨', () => b.c.call('wind_jump', up ? { up: true, toward: to } : { toward: to }), d => (d.used || 0) > 0, up ? fightHim : null)
        } else if (pick.k === 'cover') act('🧱', () => b.c.call('take_cover', { from: am.name, maxRun: 7 }), d => !!d.ok, null)
        else if (pick.k === 'peek') { b.peekAt = Date.now() + 5000; act('🏹🧱', () => b.c.call('peek_shot', { target: am.name, shots: 2 }), d => !!d.ok, null) }
        else juke()
      }
      setTimeout(go, Math.random() * st.delay)
      return
    }
    if (src === ar) { ctx.dodgeAway(b, m.pos, { x: m.pos.x - ar.side.x, z: m.pos.z - ar.side.z }, 3, null, ar.from); return }
    // Брызги ложатся в радиусе 4 (ThrownSplashPotion.applySplash), удар булавой — в 3.5: уйти надо на 4.5+ от точки. Ляжет
    // скоро (≤ 12 тиков) — спринт лицом по ходу (спиной вперёд — шагом, замер potion-above-3: 56 % зелий в цель); есть
    // время — пятиться, глядя на угрозу. От булавы — бежать, пока он не сел (mace-4: бой после рывка вёл назад под удар).
    const off = Math.hypot(m.pos.x - src.at.x, m.pos.z - src.at.z)
    const urgent = !!sm || (src.ticks ?? 99) <= 12
    ctx.dodgeAway(b, m.pos, src.at, src === cl ? cl.r + 2 : Math.max(2.5, 4.8 - off, sm ? (sm.ticks + 3) * 0.3 : 0) + Math.random(), sm ? () => { if (geared(pos[b.name])) b.cur = sm.name } : null, urgent ? null : sm ? sm.from : pt ? pt.at : null, !!(sm || pt))
  }
}
