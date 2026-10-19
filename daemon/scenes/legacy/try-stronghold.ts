'use strict'
import { REPO_ROOT } from '../../src/paths'
import * as gameClock from '../../src/game-clock'
// От ока до горящего портала в Край — на НАСТОЯЩЕЙ крепости своего сервера
// (server-nether): /locate даёт, где она, сцена ставит тело в 60–80 блоках, а
// дальше всё делает демон теми же вызовами, что и мозг:
//   (а) mc_stronghold mode=find — два ока и пересечение лучей;
//   (б) mode=go — дойти, уточнить оком, прокопаться до кирпича;
//   (в) mode=room — найти комнату по коридорам, видя рамки только лучом;
//   (д) mode=fill с нехваткой глаз — отказ с need, ни одной рамки не тронуто;
//   (г) mode=fill — глаза в рамки, портал горит;
//   (е) портал правда работает: тело в центр 3x3 командой → the_end, и назад.
// SH_NEAR="x,z" — взять ближайшую к этой точке крепость (у зажжённой fill
// ответит «уже горит»).
// Ложь, которую ловит сцена: «портал горит» по словам намерения. Свидетель —
// блоки end_portal в observe fair:false (сервер, а не отчёт), и что тело
// осталось в верхнем мире (в Край — только шагом, и это не шаг).
//
// Цель ока — угол стартового чанка (getLocatePos, locateOffset ZERO), как и
// точка /locate; поэтому (а) сверяет память с /locate в пределах 40 блоков.
//
//   (з) room прямо с поверхности (так зовёт директор: find → room) — сам делает go;
//   (ж) fill enter:true — шагом в горящий портал, тело в the_end.
// Путь директора целиком: node try-stronghold.js аздгж.
// Запуск: node try-stronghold.js [абвдгежз] (демон NeuroNether на 8772; свой — ND_WS,
// MC_USERNAME, ND_SERVER_LOG, ND_MEMORY_DIR).
import path = require('path')
import { connect, createKit, sleep } from '../lib/scene-kit'

const WS = process.env.ND_WS || 'ws://127.0.0.1:8772'
const PLAYER = process.env.MC_USERNAME || 'NeuroNether'
const LOG = process.env.ND_SERVER_LOG || path.join(REPO_ROOT, 'server-nether/logs/latest.log')
const conn = connect(WS)
const call = conn.call
const kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })
const ONLY = process.argv[2] || 'абвдге'
let PORTAL = null

let failures = 0
function check (what, ok, saw?: any) {
  if (!ok) failures++
  console.log(`   [${ok ? ' OK ' : 'ПЛОХО'}] ${what}${saw === undefined ? '' : ` — вижу ${typeof saw === 'string' ? saw : JSON.stringify(saw)}`}`)
  return ok
}
const header = async () => ((await call('status')) || {} as Record<string, any>).state || {} as Record<string, any>
async function blocksNear (name, radius = 16) {
  const o = await call('observe', { radius, fair: false })
  return ((((o && o.detail) || {} as Record<string, any>).blocks) || []).find(b => b.name === name) || null
}
async function run (label, params) {
  const t0 = gameClock.now()
  const r = await call('stronghold', params)
  const d = r.detail || {} as Record<string, any>
  console.log(`   ${label}: ${r.status}${r.error ? ' ' + r.error : ''} за ${Math.round((gameClock.now() - t0) / 1000)}с — ${d.stopped || ''} ${d.note || ''}`)
  return { r, d }
}

conn.ready.then(async () => {
  await call('connect')
  await call('stop')
  try {
    const h0 = await header()
    if (h0.dimension !== 'overworld') {
      // /tp с высоты убивает (Грабли прогонов): замедленное падение — ДО телепорта.
      await kit.cmd('/effect give @s minecraft:slow_falling 30 0 true')
      await kit.cmd('/execute in minecraft:overworld run tp @s 0 100 0')
      await sleep(3000)
    }
    await kit.gamerule('spawn_mobs', 'false')
    await kit.setDifficulty('normal')
    await kit.cmd('/time set day')
    // Другая крепость: SH_NEAR="x,z" — искать ближайшую к этой точке (у уже
    // зажжённой fill ответит «уже горит»). Первое кольцо — 3 крепости через 120°.
    if (process.env.SH_NEAR && /[аб]/.test(ONLY)) {
      const [nx, nz] = process.env.SH_NEAR.split(',').map(Number)
      await kit.cmd('/effect give @s minecraft:slow_falling 60 0 true')
      // Сначала туда телом (чанки грузятся вокруг игрока), потом на поверхность:
      // spreadplayers в негенерированные чанки молчал 30 с.
      // /locate с высоты — поверхность не нужна (там может быть океан).
      await kit.cmd(`/execute in minecraft:overworld run tp @s ${nx} 200 ${nz}`)
      await sleep(5000)
    }
    // Ответ /locate в latest.log не пишется — только в чат игроку (RPC ask).
    const loc = await call('ask', { command: '/locate structure minecraft:stronghold', match: 'nearest', ms: 20000 })
    const line = (((loc && loc.detail) || {} as Record<string, any>).lines || []).find(l => /nearest/.test(l)) || ''
    const m = /\[(-?\d+), ~, (-?\d+)\]/.exec(line)
    if (!m) throw new Error(`крепость не найдена: ${JSON.stringify(loc && loc.detail)}`)
    const SX = Number(m[1]); const SZ = Number(m[2])
    console.log(`   /locate: крепость (угол чанка старта) на ${SX}, ${SZ}`)

    // Тело — в 70 блоках к северо-востоку, на поверхность.
    if (ONLY.includes('а') || ONLY.includes('б')) {
      await kit.cmd('/effect give @s minecraft:slow_falling 30 0 true')
      await kit.cmd('/clear @s')
      // Чанки сначала телом, потом на сушу в радиусе 30 (в воду spreadplayers не ставит).
      await kit.cmd(`/execute in minecraft:overworld run tp @s ${SX + 60} 200 ${SZ - 40}`)
      await sleep(5000)
      await kit.must(`/spreadplayers ${SX + 60} ${SZ - 40} 0 30 false @s`, /^Spread 1 (player|entity)/, 'не поставил тело на поверхность', { ms: 30000 })
      await sleep(3000)
      for (const g of ['diamond_pickaxe', 'iron_pickaxe', 'iron_sword', 'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'cooked_beef 32', 'ender_eye 16', 'torch 32']) {
        await kit.cmd(`/give @s minecraft:${g}`)
      }
      await sleep(1000)
      await call('armor', {} as Record<string, any>)
    }

    if (ONLY.includes('а')) {
      console.log('(а) find: два ока')
      const { d } = await run('find', { mode: 'find', sideways: 60, timeoutSeconds: 240 })
      const st = d.stronghold
      const off = st ? Math.round(Math.hypot(st.x - SX, st.z - SZ)) : null
      check('(а) крепость в памяти в 40 блоках от /locate', st && off <= 40, st ? `${st.x},${st.z} — ${off} бл. от ${SX},${SZ}` : d.stopped)
    }

    if (ONLY.includes('з')) {
      // Как зовёт директор: find → room, без go. room с поверхности сам
      // делает go (кирпича рядом не видно, «крепость» в памяти есть).
      console.log('(з) room прямо с поверхности: сам дойдёт и прокопается')
      const { d } = await run('room с поверхности', { mode: 'room', timeoutSeconds: 600 })
      check('(з) сначала go: дошёл до кирпича', !!(d.went && d.went.bricks), d.went || d.stopped)
      check('(з) рамки увидел', d.found === true && d.room && d.room.frames === 12, d.room || d.stopped)
      console.log(`   go: ${JSON.stringify(d.went)}; прошёл ${d.walked} бл., переходов ${d.legs}`)
    }

    if (ONLY.includes('б')) {
      console.log('(б) go: дойти, уточнить, прокопаться')
      const { d } = await run('go', { mode: 'go', timeoutSeconds: 400 })
      const h = await header()
      check('(б) дошёл до кирпича крепости', d.went === true && d.bricks, d.bricks || d.stopped)
      check('(б) уточнённый угол в 3 блоках от /locate', d.corner && Math.abs(d.corner.x - SX) <= 3 && Math.abs(d.corner.z - SZ) <= 3, d.corner)
      check('(б) тело ниже уровня моря (крепость ниже seaLevel-10)', h.pos && h.pos.y < 55, h.pos)
      console.log(`   броски: ${JSON.stringify(d.throws)}; выкопал ${d.dug}`)
    }

    if (ONLY.includes('в')) {
      console.log('(в) room: портальная комната по коридорам')
      const { d } = await run('room', { mode: 'room', timeoutSeconds: 540 })
      check('(в) рамки увидел', d.found === true && d.room && d.room.frames === 12, d.room || d.stopped)
      const fr = await blocksNear('end_portal_frame', 16)
      check('(в) сервер подтверждает рамки рядом (observe fair:false)', !!fr && fr.count >= 12, fr)
      console.log(`   прошёл ${d.walked} бл., переходов ${d.legs}, спавнер ${JSON.stringify(d.spawner)}`)
    }

    if (ONLY.includes('д')) {
      console.log('(д) fill без глаз: отказ')
      const had = ((await header()).inventory || {} as Record<string, any>).ender_eye || 0
      await kit.cmd('/clear @s minecraft:ender_eye')
      await kit.cmd('/give @s minecraft:ender_eye 2')
      await sleep(600)
      const { d } = await run('fill мало глаз', { mode: 'fill' })
      check('(д) need ender_eye, ни одной рамки не тронуто', d.need && d.need.what === 'ender_eye' && !d.placed, d.need)
      await kit.cmd('/clear @s minecraft:ender_eye')
      await kit.cmd(`/give @s minecraft:ender_eye ${Math.max(12, had)}`)
      await sleep(600)
    }

    if (ONLY.includes('г')) {
      console.log('(г) fill: глаза в рамки')
      const { d } = await run('fill', { mode: 'fill', timeoutSeconds: 240 })
      const ep = await blocksNear('end_portal', 16)
      const h = await header()
      check('(г) намерение говорит lit, 9 клеток', d.lit === true && d.portalBlocks >= 9, `${d.lit} ${d.portalBlocks}`)
      check('(г) сервер подтверждает end_portal (observe fair:false)', !!ep && ep.count >= 9, ep)
      check('(г) тело осталось в верхнем мире', h.dimension === 'overworld', h.dimension)
      console.log(`   вставил ${d.placed}, с оком ${d.withEye}/${d.frames}, не вышло ${JSON.stringify(d.failed)}`)
      PORTAL = d.portal || null
    }

    if (ONLY.includes('е') && !PORTAL) {
      // Отдельный прогон (е): портал — из памяти, если он там записан горящим.
      try {
        const mem = JSON.parse((require('fs') as typeof import('fs')).readFileSync(path.join(process.env.ND_MEMORY_DIR || path.join(REPO_ROOT, 'memory-nether'), 'state.json'), 'utf8'))
        const r = (mem.places || {} as Record<string, any>)['портал в Край']
        if (r && r.lit) PORTAL = { x: r.x, y: r.y, z: r.z }
      } catch {}
    }
    if (ONLY.includes('е') && PORTAL) {
      // Работает ли портал на самом деле: тело — в центр 3x3 (командой, не
      // шагом: сам бот в end_portal не шагает, pathfinder его обходит). Сервер
      // переносит мгновенно (EndPortalBlock: задержки нет). Потом назад.
      console.log('(е) портал переносит в Край')
      const t0 = gameClock.now()
      await kit.cmd(`/tp @s ${PORTAL.x + 0.5} ${PORTAL.y + 0.5} ${PORTAL.z + 0.5}`)
      let dim = null
      for (let i = 0; i < 30 && dim !== 'the_end'; i++) { await sleep(300); dim = (await header()).dimension }
      // Событие уходит на «устроился» (позиция + пол), а не на сам пакет: ждать
      // его, прежде чем уводить тело назад, иначе новый переход его отменит.
      let ev = []
      for (let i = 0; i < 25 && !ev.some(e => e.to === 'the_end'); i++) { await sleep(200); await header(); ev = kit.between(t0, gameClock.now(), 'dimension') }
      check('(е) в Крае: шапка the_end', dim === 'the_end', dim)
      check('(е) событие dimension overworld → the_end, via portal', ev.some(e => e.to === 'the_end' && e.via === 'portal'), ev.map(e => `${e.from}→${e.to} ${e.via}`))
      await kit.cmd('/effect give @s minecraft:slow_falling 30 0 true')
      await kit.cmd(`/execute in minecraft:overworld run tp @s ${PORTAL.x + 0.5} 120 ${PORTAL.z + 6.5}`)
      await sleep(3000)
      check('(е) вернулся в верхний мир', (await header()).dimension === 'overworld')
    }
    if (ONLY.includes('ж')) {
      // Войти шагом (fill enter:true): встать на рамку и шагнуть к центру.
      console.log('(ж) fill enter:true — шагом в портал')
      const t0 = gameClock.now()
      const { d } = await run('fill enter', { mode: 'fill', enter: true, timeoutSeconds: 120 })
      let h = await header()
      for (let i = 0; i < 20 && h.dimension !== 'the_end'; i++) { await sleep(300); h = await header() }
      const ev = kit.between(t0, gameClock.now(), 'dimension')
      check('(ж) entered:true и шапка the_end', d.entered === true && h.dimension === 'the_end', { entered: d.entered, dim: h.dimension, why: d.stopped, enter: d.enter })
      check('(ж) событие dimension → the_end, via portal', ev.some(e => e.to === 'the_end' && e.via === 'portal'), ev.map(e => `${e.from}→${e.to} ${e.via}`))
      const P = d.portal || PORTAL
      if (P && h.dimension === 'the_end') {
        await kit.cmd('/effect give @s minecraft:slow_falling 30 0 true')
        await kit.cmd(`/execute in minecraft:overworld run tp @s ${P.x + 0.5} 120 ${P.z + 6.5}`)
        await sleep(3000)
      }
    }
  } catch (e) {
    failures++
    console.log('   [ПЛОХО] сцена оборвалась:', e.message)
  } finally {
    try { await call('stop') } catch {}
    try { await kit.gamerule('spawn_mobs', 'true') } catch {}
    console.log(failures ? `\nИТОГ: ПЛОХО — ${failures}` : '\nИТОГ: всё зелёное')
    if (failures) process.exitCode = 1
    conn.close()
  }
}).catch(e => { console.error('ws:', e.message); process.exitCode = 1 })
