'use strict'
const gameClock = require('./src/game-clock')
// 1 против 2 (duo.js, 2026-09-26): NeuroDown защищается, NeuroDown2 и NeuroBuild
// бьют его вдвоём (одна команда, огонь по своим выключен — иначе взмах мечом
// задевает напарника, и они начинают драться между собой). Счёт на раунд:
// сколько NeuroDown прожил, сколько снял с них (сумма их потерь хп — кроме него
// их никто не бьёт), сколько получил, кого убил. Прогон «до» — демон NeuroDown с
// ND_DUO=0, «после» — без него; напарники одни и те же.
//   A=ws://127.0.0.1:8791 B=ws://127.0.0.1:8792 C=ws://127.0.0.1:8793 node try-duo.js <метка> [раундов] [набор]
//
// Сытость (2026-09-26): раньше каждый раунд всем давали эффект насыщения
// 1 с × 21 — это сытость 20 и НАСЫЩЕНИЕ 20, а с ним FoodData.tick лечит 1 хп за
// 10 тиков, пока насыщение есть (≈13 хп за первые 7 с урона). В живом бою 2
// на 1 такого нет. Прогон DUO_SAT=0 без эффекта нападающим сломался на 7-м
// раунде: их сытость шла из раунда в раунд вниз (бег, удары — истощение), а
// демон защитника вис на качелях выбора цели (duo.js). Теперь по умолчанию
// (DUO_SAT не задан или 0) — всем троим сытость 20 и насыщение ≈1: эффект
// насыщения, затем 3 с голода 256-го уровня (MobEffects.HUNGER:
// causeFoodExhaustion(0.005·256) = 1.28 за тик; FoodData.tick: истощение > 4 —
// минус 1 насыщения, одно за тик) — 60 тиков, 76.8 истощения, 19 насыщения.
// DUO_SAT=20 — как было (всем насыщение 20).
const WebSocket = require('ws')
const fs = require('fs')
const path = require('path')

// Both bots share server ticks; keep the first connection as the time source.
let clockSource = null
function client (url) {
  clockSource ??= url
  const ws = new WebSocket(url)
  let id = 0
  const pending = new Map()
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString()); if (url === clockSource) gameClock.follow(m.clock || m.result?.state?.clock || m.result?.clock)
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
  })
  const ready = new Promise<any>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  // Без ответа — не висеть вечно (демон мог зависнуть): предел на вызов.
  const call = (method, params: any = {} as Record<string, any>, limitMs = method === 'fight' ? 200000 : 15000) => new Promise<any>((resolve, reject) => {
    const rid = ++id
    const t = gameClock.wall.setTimeout(() => { if (pending.delete(rid)) reject(new Error(`${method}: нет ответа ${limitMs} мс`)) }, limitMs)
    pending.set(rid, { resolve: (v) => { gameClock.wall.clearTimeout(t); resolve(v) }, reject: (e) => { gameClock.wall.clearTimeout(t); reject(e) } })
    ws.send(JSON.stringify({ id: rid, method, params }))
  })
  return { ws, ready, call }
}
const sleep = ms => gameClock.sleep(ms)
const A = client(process.env.A || 'ws://127.0.0.1:8791')
const B = client(process.env.B || 'ws://127.0.0.1:8792')
const C = client(process.env.C || 'ws://127.0.0.1:8793')
const NA = 'NeuroDown'; const NB = 'NeuroDown2'; const NC = 'NeuroBuild'
const LABEL = process.argv[2] || 'run'
const ROUNDS = Number(process.argv[3] || 6)
const KIT = process.argv[4] || 'iron'
const LOG = path.join(__dirname, `try-duo-${LABEL}.log`)
const log = (...a) => { const l = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(l); fs.appendFileSync(LOG, l + '\n') }
async function cmd (text) { await A.call('say', { text }); await sleep(30) }

const X = 1000; const Y = 150; const Z = 1000; const R = 15
const ROUND_MS = 75000

const KITS = {
  // Ближний бой без расходников: разница — только в том, как стоит и кого бьёт.
  iron: { body: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'], a: ['iron_sword', 'cobweb 4'], foe: ['iron_sword'] },
  // Со щитами и яблоками — ближе к арене.
  full: { body: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'shield'], a: ['iron_sword', 'iron_axe', 'cobweb 4', 'golden_apple 2', 'cobblestone 32'], foe: ['iron_sword', 'iron_axe', 'golden_apple 2', 'cobblestone 32'] },
  // Всплеск (2026-09-26): у защитника то, чем добивают, — булава с зарядами
  // ветра (удар с 6–8 бл. по железу ≈ 30 хп: броня 15 режет большой удар до
  // минимума, CombatRules.getDamageAfterAbsorb), вред II броском (12 магией мимо
  // брони), арбалет, лава, паутина; нападающие — как в iron.
  burst: {
    body: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'],
    a: ['iron_sword', 'mace', 'wind_charge 16', 'splash_potion[potion_contents={potion:"minecraft:strong_harming"}] 1', 'splash_potion[potion_contents={potion:"minecraft:strong_harming"}] 1', 'crossbow[enchantments={quick_charge:3}]', 'arrow 16', 'lava_bucket', 'cobweb 4', 'cobblestone 32'],
    foe: ['iron_sword']
  }
}
// Сытость на старте раунда (см. шапку): 0 — насыщение ≈1, 20 — как было.
const SAT = Number(process.env.DUO_SAT || 0)
const SLOT = { helmet: 'armor.head', chestplate: 'armor.chest', leggings: 'armor.legs', boots: 'armor.feet', shield: 'weapon.offhand' }

async function arena () {
  await cmd(`/fill ${X - R} ${Y - 1} ${Z - R} ${X + R} ${Y - 1} ${Z + R} minecraft:stone`)
  await cmd(`/fill ${X - R} ${Y} ${Z - R} ${X + R} ${Y + 8} ${Z + R} minecraft:air`)
  for (const [x1, z1, x2, z2] of [[X - R - 1, Z - R - 1, X + R + 1, Z - R - 1], [X - R - 1, Z + R + 1, X + R + 1, Z + R + 1], [X - R - 1, Z - R - 1, X - R - 1, Z + R + 1], [X + R + 1, Z - R - 1, X + R + 1, Z + R + 1]]) {
    await cmd(`/fill ${x1} ${Y - 1} ${z1} ${x2} ${Y + 4} ${z2} minecraft:glass`)
  }
  // Рельеф один и тот же каждый раунд: два столба, стенка, угол — есть что
  // поставить за спину и чем закрыться от второго.
  await cmd(`/fill ${X - 2} ${Y} ${Z + 4} ${X - 2} ${Y + 2} ${Z + 4} minecraft:stone`)
  await cmd(`/fill ${X + 3} ${Y} ${Z - 5} ${X + 3} ${Y + 2} ${Z - 5} minecraft:stone`)
  await cmd(`/fill ${X - 9} ${Y} ${Z - 6} ${X - 5} ${Y + 1} ${Z - 6} minecraft:stone`)
  await cmd(`/fill ${X - 11} ${Y} ${Z + 7} ${X - 11} ${Y + 1} ${Z + 11} minecraft:stone`)
  await cmd(`/fill ${X - 11} ${Y} ${Z + 7} ${X - 7} ${Y + 1} ${Z + 7} minecraft:stone`)
  await cmd(`/kill @e[type=item,x=${X},y=${Y},z=${Z},distance=..40]`)
}

async function equip (who, items, body) {
  await cmd(`/clear ${who}`)
  await cmd(`/effect clear ${who}`)
  for (const b of body) {
    const k = b.replace(/^.*_/, '')
    await cmd(`/item replace entity ${who} ${SLOT[k] || SLOT[b]} with minecraft:${b}`)
  }
  for (const it of items) {
    const [n, c] = it.split(' ')
    await cmd(`/give ${who} minecraft:${n} ${c || 1}`)
  }
}

// Здоровье и смерть: с мгновенным возрождением опрос раз в 250 мс ноль не
// видит (первый прогон: «получил 99, жив» — умер и возродился трижды), поэтому
// смерть — по событию death в ленте демона и по итогу fight.
async function probe (c) {
  const st = await c.call('status').catch(() => null)
  if (!st) return null
  const dead = (st.events || []).some(e => e && e.type === 'death')
  const h = st.state && typeof st.state.health === 'number' ? st.state.health : null
  return { h, dead }
}
async function hpOf (c) { const p = await probe(c); return p ? p.h : null }
const diedIn = r => !!(r && ((r.detail && r.detail.died) || (r.status === 'interrupted' && r.by && r.by.type === 'death') || (r.events || []).some(e => e && e.type === 'death')))

async function round (n) {
  const kit = KITS[KIT]
  await Promise.all([A.call('stop').catch(() => {}), B.call('stop').catch(() => {}), C.call('stop').catch(() => {})])
  // Отвалившегося (кик, вылет) — обратно на сервер; мёртвого — дождаться живым.
  await Promise.all([A.call('connect').catch(() => {}), B.call('connect').catch(() => {}), C.call('connect').catch(() => {})])
  for (const c of [A, B, C]) { for (let i = 0; i < 20; i++) { const h = await hpOf(c).catch(() => null); if (h > 0) break; await sleep(500) } }
  await arena()
  for (const [who, items] of [[NA, kit.a], [NB, kit.foe], [NC, kit.foe]]) await equip(who, items, kit.body)
  await cmd(`/tp ${NA} ${X - 6} ${Y} ${Z} -90 0`)
  await cmd(`/tp ${NB} ${X + 5} ${Y} ${Z - 3} 90 0`)
  await cmd(`/tp ${NC} ${X + 5} ${Y} ${Z + 3} 90 0`)
  // Сытость 20 всем, насыщение — SAT (шапка): насыщение 20, потом голод его выжигает.
  for (const who of [NA, NB, NC]) {
    await cmd(`/effect give ${who} minecraft:instant_health 1 10 true`)
    await cmd(`/effect give ${who} minecraft:saturation 1 20 true`)
  }
  if (SAT < 20) {
    await sleep(1150)
    for (const who of [NA, NB, NC]) await cmd(`/effect give ${who} minecraft:hunger 3 255 true`)
    await sleep(3150)
    for (const who of [NA, NB, NC]) await cmd(`/effect clear ${who} minecraft:hunger`)
    for (const who of [NA, NB, NC]) await cmd(`/effect give ${who} minecraft:instant_health 1 10 true`)
  }
  await sleep(1500)
  const t0 = gameClock.now()
  const hp = { [NA]: await hpOf(A), [NB]: await hpOf(B), [NC]: await hpOf(C) }
  const lost = { [NA]: 0, [NB]: 0, [NC]: 0 }
  const died: Record<string, any> = {} as Record<string, any>
  const over: Record<string, any> = { done: false }
  let aDetail = null
  const cl = { [NA]: A, [NB]: B, [NC]: C }
  // Счёт хп: сумма падений — урон (лечение между опросами не мешает).
  const watch = gameClock.setInterval(async () => {
    for (const who of [NA, NB, NC]) {
      if (died[who]) continue
      const p = await probe(cl[who])
      if (!p) continue
      if (p.dead) { if (hp[who] != null) lost[who] += hp[who]; died[who] = gameClock.now() - t0; continue }
      const h = p.h
      if (h == null) continue
      if (hp[who] != null && h < hp[who]) lost[who] += hp[who] - h
      hp[who] = h
      if (h <= 0 && !died[who]) died[who] = gameClock.now() - t0
    }
    if (died[NA] || (died[NB] && died[NC]) || gameClock.now() - t0 > ROUND_MS) {
      if (!over.done) { over.done = true; for (const c of [A, B, C]) c.call('stop').catch(() => {}) }
    }
  }, 250)
  const fightLoop = async (c, me, foes) => {
    let turn = 0
    while (!over.done) {
      const left = foes.filter(f => !died[f])
      if (!left.length) break
      const r = await c.call('fight', { target: left[turn++ % left.length], allowPlayer: true, timeoutSeconds: Math.max(5, Math.round((ROUND_MS - (gameClock.now() - t0)) / 1000)), retreatAtHealth: 2 }).catch(e => ({ status: 'failed', error: e.message }))
      if (c === A && r && r.detail) aDetail = aDetail ? { ...r.detail, tricks: { ...(aDetail.tricks || {} as Record<string, any>), ...(r.detail.tricks || {} as Record<string, any>) } } : r.detail
      if (diedIn(r) && !died[me]) { if (hp[me] != null) lost[me] += hp[me]; died[me] = gameClock.now() - t0 }
      if (died[NA] || (died[NB] && died[NC])) { if (!over.done) { over.done = true; for (const x of [A, B, C]) x.call('stop').catch(() => {}) } }
      if (over.done) break
      await sleep(r && r.status === 'failed' ? 800 : 200)
    }
  }
  await Promise.all([fightLoop(A, NA, [NB, NC]), fightLoop(B, NB, [NA]), fightLoop(C, NC, [NA])])
  while (!over.done) await sleep(200)
  gameClock.clearInterval(watch)
  const alive = died[NA] ? died[NA] / 1000 : null
  const kills = [NB, NC].filter(w => died[w] && (!died[NA] || died[w] < died[NA])).length
  const out = {
    round: n,
    alive: alive == null ? `>${Math.round((gameClock.now() - t0) / 1000)}` : +alive.toFixed(1),
    dealt: Math.round(lost[NB] + lost[NC]),
    taken: Math.round(lost[NA]),
    kills,
    result: died[NA] ? 'погиб' : kills === 2 ? 'убил обоих' : 'время'
  }
  const tr = aDetail && aDetail.tricks ? Object.entries<any>(aDetail.tricks).filter(([k]: any) => /1 против 2|разворот|паутина|булава|вред|арбалет|лава|добив|зелье/.test(k)).map(([k, v]: any) => `${k}×${v}`).join(' | ') : ''
  log(`[${LABEL}] ${JSON.stringify(out)} ${tr}`)
  await sleep(2500)
  return { ...out, aliveN: alive == null ? (gameClock.now() - t0) / 1000 : alive }
}

;(async () => {
  try {
    await A.ready; await B.ready; await C.ready
    await Promise.all([A.call('connect'), B.call('connect'), C.call('connect')])
    for (const c of [A, B, C]) await c.call('temper', { enabled: false }).catch(() => {})
    await cmd('/difficulty normal')
    await cmd('/gamerule spawn_mobs false')
    await cmd('/gamerule do_immediate_respawn true')
    await cmd('/gamerule send_command_feedback false')
    await cmd('/time set day')
    await cmd('/weather clear')
    await cmd('/team add duo')
    await cmd('/team modify duo friendlyFire false')
    await cmd(`/team join duo ${NB} ${NC}`)
    await cmd(`/team leave ${NA}`)
    for (const who of [NA, NB, NC]) await cmd(`/spawnpoint ${who} ${X} ${Y} ${Z}`)
    await cmd(`/tp ${NA} ${X - 6} ${Y} ${Z}`); await cmd(`/tp ${NB} ${X + 5} ${Y} ${Z - 3}`); await cmd(`/tp ${NC} ${X + 5} ${Y} ${Z + 3}`)
    await sleep(2500)
    const res = []
    for (let n = 1; n <= ROUNDS; n++) res.push(await round(n))
    const avg = k => Math.round(res.reduce((s, r) => s + r[k], 0) / res.length * 10) / 10
    log(`[${LABEL}] ИТОГ ${res.length} раундов (${KIT}): жил в среднем ${avg('aliveN')} с, снял ${avg('dealt')} хп, получил ${avg('taken')}, убил ${res.reduce((s, r) => s + r.kills, 0)} (обоих — ${res.filter(r => r.kills === 2).length} раз)`)
  } catch (e) {
    console.error('FAILED', e.stack || e.message)
    process.exitCode = 1
  } finally {
    for (const c of [A, B, C]) { try { await c.call('stop') } catch {} ; c.ws.close() }
  }
})()
