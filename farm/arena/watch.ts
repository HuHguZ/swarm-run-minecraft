'use strict'
// Слежка за бойцами: тревога (враг подбегает — рвать дело), рой (swarm-driver) и враги глазами, обёртки вызовов
// демона, опрос состояния, сторож зависаний, мобы глазами, счёт и уборка.
import { ROOT, SOLO } from './context'
import { SPRINT, power, MOB_SPD, worthOf } from './gear'
import type { ArenaContext } from './context'
const fs = require('fs')
const path = require('path')

const dist3 = (a, c) => Math.hypot(a.x - c.x, a.y - c.y, a.z - c.z)

export function watchAlarm (ctx: ArenaContext) {
  const { teams, bots, names, pos, busy, teamOf } = ctx
  // Тревога (10.10: «подбегаю быстро — тупят, не реагируют, как будто не успевают; должны понимать, что я быстрый»):
  // раз в 250 мс у каждого бойца не в бою — кто доберётся до меня быстрее чем за 2 с (по его скорости, а не по блокам:
  // игрок со «Скоростью V» — 10+ бл/с), тот рвёт текущее дело (лут, путь, крафт); цикл бойца решит заново — бежать,
  // звать своих или драться. Не чаще раза в 1.5 с на бойца, иначе дело рвётся по кругу.
  return setInterval(() => {
    if (ctx.between) return
    for (const b of bots) {
      const m = pos[b.name]; if (!m?.p || !ctx.alive(b.name) || (b.alarmAt || 0) > Date.now()) continue
      // Бой и уход (жемчуг, заряд, подкоп, бег) — не рвать: это и есть ответ на угрозу.
      // Рывок/заливка/полёт (busy) — тоже ответ на угрозу (12.10, замер лучником: тревога гасила каждый стрейф через доли секунды).
      // Идёт к человеку (погоня, спуск к нему — _hunt) — это и есть ответ: не рвать (13.10: «скопились наверху» — тревога
      // обрывала спуск к нему каждые 5 с).
      if (b.last?.p?._hunt) continue
      if (busy.has(b.name) || (!b.looting && (/^(fight|drink_buffs|pearl_to|wind_jump|burrow|flee|block_behind|evade|douse_lava|fly_to|peek_shot|wind_leap|juke|take_cover|undercut)$/.test(b.last?.m || '') || b.waiting))) continue
      const en = ctx.enemiesOf(b, m.p)
      const t = (e) => Math.max(0, e.d - 3) / Math.max(e.spd, SPRINT)
      const hot = en.filter(e => t(e) < (SOLO && e.human ? 3.5 : 2) && (e.human || e.d < 6))
      if (!hot.length) continue
      b.alarmAt = Date.now() + 1500
      if (b.looting || b.climbing || Date.now() - (b.last?.at || 0) < 30000) { b.looting = false; b.c.call('stop').catch(() => {}) }
      const ours = names.filter(n => n !== b.name && teamOf(n) === b.team && ctx.alive(n) && dist3(pos[n].p, m.p) / SPRINT < 2.5).length
      if (teams) ctx.callout(b, 'cover', { foe: hot[0].n, foes: hot.length, mates: ours }, 6000, `прикройте! на меня ${ctx.short(hot[0].n)}${hot.length > 1 ? ` и ещё ${hot.length - 1}` : ''}`)
    }
  }, 250)
}

export function installSight (ctx: ArenaContext) {
  const { arms, bots, names, pos, humans, X, Y, Z, R, L, log } = ctx
  const arena = { x: X + .5, y: Y, z: Z + .5, r: R, killY: arms ? Y + L.y0 - 3 : undefined }
  ctx.swarmDriver = require('../swarm-driver').createSwarmDriver({ bots, pos, alive: ctx.alive, arms, arena,
    home: b => { if (arms) return ctx.armsHome(b, 0); const [x, z] = ctx.home(b, 0).split(/\s+/).map(Number); return { x, y: Y, z } }, log,
    hostile: ctx.hostile
  })
  ctx.enemiesOf = (b, at) => [
    ...ctx.swarmDriver.enemies(b).map(e => ({ n: e.id, p: e.position, spd: Math.hypot(e.velocity?.x || 0, e.velocity?.z || 0) * 20,
      geared: !!e.equipment?.weapon || !!e.equipment?.armor?.length, human: !names.includes(e.id),
      pow: power(20, e.equipment?.weapon ? { [e.equipment.weapon]: 1 } : {}, Object.fromEntries((e.equipment?.armor || []).map((n, k) => [k, n]))) })),
    // Мобы — те же враги (10.10: «от мобов бегут, а меня не видят»): что видит сам боец (демон, раз в секунду).
    ...((pos[b.name]?.mobs || []) as any[]).map(m => ({ n: `mob${m.id}`, id: m.id, p: m.p, spd: MOB_SPD[m.name] ?? 3, geared: true, human: false, mob: true, kind: m.name, pow: 0 }))
  ].map(e => ({ ...e, d: at ? dist3(e.p, at) : Infinity })).sort((a, c) => a.d - c.d)
  // Отход к своим (10.10: «один — иногда убегать к союзникам»; «не хардкодь блоки — адаптивно»). Без порогов в блоках:
  // враг сильнее моей силы «здесь» (я + свои, кто успеет за секунду) — к той группе своих, что даст больше силы на
  // секунду пути, если добегу раньше, чем он догонит (разрыв до удара / разница скоростей). Догонит раньше — драться.
  // Лезет к человеку (b.climbing) — другие задачи драйвера (обмен бронёй, «прикрываю», сундуки, сбор) его не дёргают
  // (13.10: «сижу в нычке — никто не дошёл»: путь наверх в 45 шагов находился, но подъём рвали обмены и прикрытие — 0–3 бл.
  // за 20 с). Пропускаются только ответы на угрозу, свой подъём (_climb) и стоп.
  // Человек ворвался (ближе 6 бл.) — подъём/подкоп уже не главное (13.10: «бот строит, я врываюсь — должен видеть меня и
  // решать: драться тем, что есть, или уходить, отбиваясь»): тревога рвёт дело, цикл выбирает бой или отход.
  const humanClose = (b) => { const p = pos[b.name]?.p; return !!p && Object.values(humans).some((h: any) => h.p && h.hp > 0 && Math.hypot(h.p.x - p.x, h.p.y - p.y, h.p.z - p.z) < 6) }
  const CLIMB_OK = /^(status|emote|look_at|armor|team_hint|mobs|rescue_config|wind_leap|dig_to|undercut|watch_dangers|evade|juke|take_cover|douse_lava|wind_jump|pearl_to|fly_to|mine)$/
  for (const b of bots) { const raw0 = b.c.call.bind(b.c); b.c.call = (m, p) => (b.climbing && !(p && p._climb) && !CLIMB_OK.test(m) && !(m === 'stop' && ctx.between) && !humanClose(b)) ? Promise.resolve({ status: 'skipped', detail: { why: 'лезу к цели' } }) : raw0(m, p) }
  // Открытый сундук — в opened: по нему таймер пополнения (ARMS_LOOT_X) знает, что пополнять. Раньше его отмечал старый
  // лут ffa, после роя — никто, и пополнение не работало вовсе (14.10). Ключ — как у L.chests (от центра карты), вторая
  // половина двойного — по pair.
  const same = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z
  const markOpened = at => { const c = L?.chests.find(c => same({ x: X + c.x, y: Y + c.y, z: Z + c.z }, at) || same(c.pair, at)); if (c) ctx.opened.add(`${c.x},${c.y},${c.z}`) }
  for (const b of bots) { const raw = b.c.call.bind(b.c); b.c.call = (m, p) => {
    p = { ...p, arena: p?.arena || arena }
    if (!/^(status|emote|look_at|armor|team_hint|stop|mobs|rescue_config|watch_dangers|swarm_keep)$/.test(m)) b.last = { m, at: Date.now(), p }
    const out = raw(m, p)
    if (m === 'chest_take') Promise.resolve(out).then(r => markOpened(r?.detail?.at || (Number.isFinite(p.x) ? { x: p.x, y: p.y, z: p.z } : null)), () => {})
    return out
  } }
}

export function watchStatus (ctx: ArenaContext) {
  const { teams, arms, bots, names, pos, busy, out, deadNow, labNeed, deathAt, rel, humans, X, Y, Z, L, STOPF, HUMAN_TEAM, teamOf, log } = ctx
  const mobInfo: Record<string, any> = {}
  // Мобы глазами бойцов — раз в секунду (только с мобами на арене: ARMS_MOBS).
  const mobPollT = process.env.ARMS_MOBS ? setInterval(() => {
    for (const b of bots) {
      if (!pos[b.name]?.p || deadNow.has(b.name)) continue
      b.c.call('mobs', { radius: 24 }).then(r => {
        const list = (r?.detail || r)?.mobs || []
        if (pos[b.name]) pos[b.name].mobs = list
        for (const m of list) mobInfo[`mob${m.id}`] = m
      }).catch(() => {})
    }
  }, 1000) : null
  // Сторож зависаний (10.10: «подвисают, ничего не делая — фармлю их»): живой боец 8 с на месте, рядом (3 бл.) нет
  // врага и он не ждёт нарочно (сбор, хилка) — в журнал, чем занят (последний вызов демона и сколько длится), и стоп:
  // цикл бойца выберет дело заново.
  const frozenT = setInterval(() => {
    if (ctx.between) return
    for (const b of bots) {
      const m = pos[b.name]
      if (!m?.p || !ctx.alive(b.name) || b.waiting || b.climbing || b.swarmReserved || b.swarmBusyUntil > Date.now() || b.swarmHoldUntil > Date.now() || busy.has(b.name) || (b.last?.m === 'craft' && Date.now() - b.last.at < 16000)) { b.anchor = null; continue }
      // A delayed status or paused native physics is not evidence that a route is physically stuck.
      if (!Number.isFinite(m.observedAt) || !Number.isFinite(m.frameAt) || Date.now() - Math.min(m.observedAt, m.frameAt) > 5000) { b.anchor = null; continue }
      if (!b.anchor || dist3(b.anchor.p, m.p) > 1) { b.anchor = { p: { ...m.p }, at: Date.now() }; continue }
      const still = Date.now() - b.anchor.at
      // Поход ещё считает путь (до 4 с в Колизее при 30 ботах) — до конца его времени не сбрасывать.
      if (b.last?.m === 'goto' && Date.now() - b.last.at < ((b.last.p?.timeoutSeconds || 10) + 2) * 1000) continue
      // Стойка роя (щит, засада, оцепление, ожидание у стройки) стоит нарочно: сброс рвал её 36 раз за 2.5 мин (арена 14.10).
      if (b.last?.m === 'swarm_hold' && Date.now() - b.last.at < ((b.last.p?.timeoutSeconds ?? 2) + 2) * 1000) continue
      // The old frozen anchor predates a fresh escape; allow its first movement sample.
      if (/^(flee|evade|juke)$/.test(b.last?.m || '') && Date.now() - b.last.at < Math.min(5, (b.last.p?.timeoutSeconds ?? 3) + 2) * 1000) continue
      // Враг вплотную, а я стою и не в бою — это хуже всего (10.10: «стоит рядом, не атакует, я ваншочу»): 3 с; иначе 5 с.
      const near = ctx.enemiesOf(b, m.p).some(e => e.d < 3)
      if ((near && b.last?.m === 'fight') || still < (b.last?.m === 'fight' ? 8000 : near ? 3000 : 5000)) continue
      const L0 = b.last || {}
      // Куда шёл и встал — туда 20 с не ходить (сундук, лидер): иначе тот же путь и та же стойка по кругу.
      if (L0.p && Number.isFinite(L0.p.x)) (b.badSpots ||= []).push({ x: L0.p.x, y: L0.p.y, z: L0.p.z, until: Date.now() + 20000 })
      if (b.following) b.followCd = Date.now() + 20000
      log(`🧊 ${b.name} стоит ${Math.round(still / 1000)} с — ${L0.m || '?'} ${L0.p?.item || L0.p?.target || L0.p?.mode || ''} (${L0.at ? Math.round((Date.now() - L0.at) / 1000) + ' с' : ''}) — сброс`)
      // Застрял наверху (крыша камеры, уступ галереи: спуск 6+ без воды pathfinder не планирует) — спрыгнуть.
      // Человек высоко (соло, 12.10: «поднимаются ко мне и встают» — спрыгивали и телепортировались на старт): наверху — охота, не застревание.
      if (m.p.y > Y + 3 && !(SOLO && Object.values(humans).some((h: any) => h.p && h.p.y > Y + 6))) b.needDrop = true
      // Шёл выше (галерея, ярус) и встал — подбросить себя зарядом ветра (10.10), если есть.
      else if (L0.p && Number.isFinite(L0.p.y) && L0.p.y - m.p.y >= 3 && (m.inv || {}).wind_charge && !((b.windCd || 0) > Date.now())) b.needLift = { x: L0.p.x, z: L0.p.z }
      b.c.call('stop').catch(() => {})
      b.anchor = { p: { ...m.p }, at: Date.now() }
    }
  }, 2000)
  // Позиции всех — раз в секунду (цель — ближайший живой).
  const statusPolling = new Set<string>()
  const poll = setInterval(() => {
    if (ctx.between) return
    const observedRound = ctx.round
    ctx.readDeaths()
    if (fs.existsSync(STOPF)) ctx.stop = true
    // Ход — по смещению за секунду (б/т); «ранен» — его хп упало (вспышка удара, видна глазами), в решения хп не идёт.
    for (const b of bots) {
      if (statusPolling.has(b.name)) continue
      statusPolling.add(b.name)
      // Наблюдение не старше запроса: демон снимает его, когда отвечает, — время приёма делало его свежее, чем оно есть
      // (под нагрузкой ответ идёт сотни мс; ревью 14.10).
      const asked = Date.now()
      b.c.call('status', {
      swarm: true, dangers: arms,
      swarmAllies: teams ? bots.filter(o => o.team === b.team).map(o => o.name) : []
    }).then(s => {
      if (ctx.between || ctx.round !== observedRound || !s?.state?.pos) return
      const was = pos[b.name]; const p = s.state.pos
      // Зелья (12.10: «кидаю зелья — стоят со щитом и помирают; видно же, что я взял зелье»): щит брызги не держит. Летит
      // вредное (или неизвестное) и ляжет в 4.5 бл. — рывок на 5 бл. от точки падения; у врага взрывное вредное в руке, а
      // свой стоит вплотную (≤ 2.5 бл.) — разойтись на 4, чтобы одно зелье не накрыло двоих.
      const dz = s.detail?.dangers
      if (dz && ctx.alive(b.name) && !out.has(b.name) && (b.potAt || 0) < Date.now()) {
        const holder = (dz.holders || []).find(hd => teams ? teamOf(hd.name) !== b.team && !(rel[b.team][hd.name] > 0) : true)
        const mate = holder && names.find(n => n !== b.name && teamOf(n) === b.team && ctx.alive(n) && pos[n]?.p && Math.hypot(pos[n].p.x - p.x, pos[n].p.z - p.z) <= 2.5)
        if (mate) { b.potAt = Date.now() + 3000; log(`🧪↔ ${b.name}: у ${holder.name} зелье в руке, рядом ${mate} — расходимся`); ctx.dodgeAway(b, p, pos[mate].p, 4, null, { x: holder.at.x, y: holder.at.y + 1.6, z: holder.at.z }) }
      }
      // Игровые тики (clock.ticks): на ускоренном сервере секунда стены — десятки игровых.
      const tick = s.state.clock?.ticks ?? 0
      const dt = was && was.p && tick > was.tick ? tick - was.tick : 0
      const v = dt ? { x: (p.x - was.p.x) / dt, y: (p.y - was.p.y) / dt, z: (p.z - was.p.z) / dt } : { x: 0, y: 0, z: 0 }
      // «Ранен» — только рядом с противником (≤ 8 бл.): своя посадка и удар о землю — не повод его добивать.
      const foeNear = (s.detail?.sightings || []).some(e => e.id !== b.name && teamOf(e.id) !== b.team && dist3(e.position, p) <= 8)
      const hurtTick = was && s.state.health < was.hp && foeNear ? tick : (was ? was.hurtTick : 0)
      if (was && teams) {
        const visibleHumans = (s.detail?.sightings || []).filter(e => !names.includes(e.id))
        const hNear = visibleHumans.filter(e => dist3(e.position, p) <= 4.5).map(e => e.id)
        const botFoeNear = (s.detail?.sightings || []).some(e => names.includes(e.id) && teamOf(e.id) !== b.team && dist3(e.position, p) <= 4.5)
        // Свой человек (ARMS_HUMAN_TEAM, огонь по своим выключен) ранить не может — урон рядом с ним не его (10.10: стрелы, падение
        // и взрывы записывались ему — «враг: красные все на него», и свои стреляли в него).
        if (hNear.length && s.state.health < was.hp - 0.5 && !botFoeNear && !(HUMAN_TEAM && b.team === HUMAN_TEAM)) ctx.relSay(b.team, hNear[0], -3, `ударил ${b.name}`)
        const cnt = (inv) => Object.values(inv || {}).reduce((a: number, n: any) => a + (Number(n) || 0), 0) as number
        const nearChest = arms && L.chests.some(c => Math.hypot(X + c.x - p.x, Y + c.y - p.y, Z + c.z - p.z) < 4)
        const gNear = visibleHumans.filter(e => dist3(e.position, p) <= 8).map(e => e.id)
        if (gNear.length && cnt(s.state.inventory) > cnt(was.inv) && !nearChest && !Object.keys(deathAt).some(k => deathAt[k].p && Math.hypot(deathAt[k].p.x - p.x, deathAt[k].p.z - p.z) < 6)) {
          const got = Object.entries(s.state.inventory || {}).filter(([n, c]: any) => c > ((was.inv || {})[n] || 0)).map(([n, c]: any) => [n, c - ((was.inv || {})[n] || 0)]) as [string, number][]
          const value = got.reduce((a, [n, c]) => a + worthOf(n) * (worthOf(n) >= 1 ? 1 : c), 0)
          log(`🎁 ${b.name} принял от ${gNear[0]}: ${got.map(([n, c]) => n + '×' + c).join(', ')} — ценность ${value.toFixed(1)}`)
          if (value >= 1) { ctx.relSay(b.team, gNear[0], Math.min(10, Math.round(value) + 1), `подарил ${b.name} ${got.map(([n]) => n).join(', ')}`); ctx.emote(b, 'crouch', ctx.eyeOf(gNear[0])).then(() => ctx.emote(b, 'wave')) }
        }
        const hHeal = visibleHumans.filter(e => dist3(e.position, p) <= 6).map(e => e.id)
        if (hHeal.length && s.state.health > was.hp + 3) ctx.relSay(b.team, hHeal[0], 2, `вылечил ${b.name}`)
      }
      const now = Date.now(), frame = s.state.physicsTicks ?? tick, clockId = s.state.clock?.id
      const frameAt = was?.frame === frame && was?.clockId === clockId ? (was.frameAt ?? now) : now
      pos[b.name] = { p, v, hp: s.state.health, hurtTick, tick, frame, clockId, frameAt, observedAt: now, pots: (s.state.inventory || {}).splash_potion || 0, inv: s.state.inventory || {}, armor: s.state.armor || {}, offHand: s.state.offHand || null, potions: s.state.potions || {}, enchants: s.detail?.ownEnchants || [], labNeed: labNeed[b.name] || [] }
      ctx.swarmDriver.observe(b, s.detail?.sightings || [], asked)
      if (!ctx.between && ctx.alive(b.name) && !/^(flee|evade|juke)$/.test(b.last?.m || '') && (b.panicAt || 0) <= Date.now() && ctx.swarmDriver.panic(b)) {
        b.panicAt = Date.now() + 1000
        ctx.swarmDriver.release(b)
        b.c.call('stop').catch(() => {})
      }
    }).catch(() => {}).finally(() => statusPolling.delete(b.name))
    }
  }, Number(process.env.FFA_POLL_MS || 250))
  return { mobPollT, frozenT, poll }
}

// Дроп, стрелы, опыт — раз в 30 с по габариту Колизея (вещи копились и тормозили игру). Ракеты и трезубцы в
// полёте не трогаем: ракета держит разгон элитр.
export function watchBoard (ctx: ArenaContext) {
  const { i, arms, BOX, rcon, log } = ctx
  return setInterval(() => {
    log('счёт (убил/умер) ' + ctx.board())
    fs.writeFileSync(path.join(ROOT, 'farm', `swarm-${i}.json`), JSON.stringify(ctx.swarmDriver.snapshot(), null, 2))
    for (const t of arms ? ['arrow', 'experience_orb'] : ['item', 'arrow', 'experience_orb']) rcon(i, `kill @e[type=${t},${BOX}]`).catch(() => {})
  }, 30000)
}
