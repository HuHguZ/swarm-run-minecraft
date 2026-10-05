'use strict'
const gameClock = require('./src/game-clock')
// Мост на ходу против обычного goto (blockmoves.js, поток movement 02.10.2026).
// Стенд в небе (y 200, чужой рельеф не мешает), один и тот же для обоих режимов; режимы чередуются в паре.
//   gapW_R   — провал шириной W поперёк пути, длиной 2R+1 по z; обход — перемычка в конце провала (z = R+1..R+3);
//              под провалом пол на 12 ниже (сорвался — 9 урона, не смерть).
//   riverW   — река шириной W, глубина 4, по z без конца: обычный goto плывёт.
//   valleyW  — долина шириной W, глубиной 6 в сплошном камне, без обхода: обычный goto копает лестницу.
//   flat     — контроль: ровная плита.
//   lakeW_R  — лавовое озеро шириной W, длиной 2R+1, обход по перемычке в конце (жемчуг: mode pearl).
// Режимы: base — goto как есть (bridge:false, pathWait:false); wait — goto ждёт поиск, не сдаётся на пустом частичном
// пути (pathWait:true); bridge — мост на ходу (bridge:true, ждёт поиск).
//   node farm/farm.js run try-lab-mv-gap.js --slots 27-28 --tag mv-gap-1 SCENES=gap4_10,river8,valley6,flat MODES=base,bridge REPS=3
// Метрики: ms (время goto), ok (дошёл), minHp, fell (ниже уровня плиты > 0.6), blocks (булыжника ушло), resets.
const fs = require('fs')
const { connect, createKit, sleep } = require('./scene-kit')

const F = Number(process.env.FLOOR || 200)

function parse (name) {
  let m = /^gap(\d+)_(\d+)$/.exec(name)
  if (m) return { kind: 'gap', W: Number(m[1]), R: Number(m[2]) }
  m = /^lake(\d+)_(\d+)$/.exec(name)
  if (m) return { kind: 'lake', W: Number(m[1]), R: Number(m[2]) }
  m = /^river(\d+)$/.exec(name)
  if (m) return { kind: 'river', W: Number(m[1]), R: 12 }
  m = /^valley(\d+)$/.exec(name)
  if (m) return { kind: 'valley', W: Number(m[1]), R: 12, D: 6 }
  m = /^cliff(\d+)_(\d+)$/.exec(name)
  if (m) return { kind: 'cliff', W: 4, H: Number(m[1]), R: Number(m[2]) }
  if (name === 'flat') return { kind: 'flat', W: 4, R: 6 }
  throw new Error('сцена? ' + name)
}

async function build (kit, sc, cx, cz) {
  const { kind, W, R } = sc
  const x1 = cx - 4; const x2 = cx + W + 12; const z1 = cz - R - 2; const z2 = cz + R + 5
  await kit.forceload('overworld', [[x1, F, z1], [x2, F, z2]])
  // Обрыв — чистить и ниже пола (ступени прошлых заходов в том же месте стенда).
  await kit.fillExact('overworld', [[x1, Math.min(F - 14, F - (sc.H || 0) - 3), z1], [x2, F + 6, z2]], 'air')
  if (kind === 'valley') {
    await kit.fillExact('overworld', [[x1, F - 9, z1], [x2, F - 1, z2]], 'stone')
    await kit.fillExact('overworld', [[cx + 1, F - sc.D, z1], [cx + W, F - 1, z2]], 'air')
    return
  }
  if (kind === 'cliff') {
    // Обрыв высотой H: плато x ≤ cx (ноги на F), низ — x > cx (ноги на F − H); обход — лестница вниз по 1 в конце
    // обрыва (z = R+1..R+3). Цель внизу, ведра нет.
    const H = sc.H
    await kit.fillExact('overworld', [[x1, F - H - 2, z1], [x2, F - H - 1, z2]], 'stone')
    await kit.fillExact('overworld', [[x1, F - H, z1], [cx, F - 1, z2]], 'stone')
    for (let i = 1; i < H; i++) await kit.fillExact('overworld', [[cx + i, F - H, cz + R + 1], [cx + i, F - 1 - i, cz + R + 3]], 'stone')
    return
  }
  if (kind === 'lake') {
    // Лавовое озеро поперёк пути (как в Аду): мост над лавой запрещён, обход — перемычка z = R+1..R+3.
    await kit.fillExact('overworld', [[x1, F - 3, z1], [x2, F - 1, z2]], 'stone')
    await kit.fillExact('overworld', [[cx + 1, F - 2, cz - R], [cx + W, F - 1, cz + R]], 'lava')
    await kit.fillExact('overworld', [[cx + 1, F - 3, cz + R + 4], [cx + W, F - 1, z2]], 'air')
    await kit.fillExact('overworld', [[cx + 1, F - 3, z1], [cx + W, F - 1, cz - R - 1]], 'air')
    return
  }
  if (kind === 'river') {
    await kit.fillExact('overworld', [[x1, F - 10, z1], [x2, F - 1, z2]], 'stone') // дно в 5 слоёв: в mv-gap-5 тело прокопало 1 слой и ушло вниз
    await kit.fillExact('overworld', [[cx + 1, F - 5, z1], [cx + W, F - 1, z2]], 'water')
    return
  }
  // gap / flat: плита в 1 блок, пол безопасности на 12 ниже.
  await kit.fillExact('overworld', [[x1, F - 1, z1], [x2, F - 1, z2]], 'stone')
  if (kind === 'gap') {
    await kit.fillExact('overworld', [[x1, F - 13, z1], [x2, F - 13, z2]], 'stone')
    await kit.fillExact('overworld', [[cx + 1, F - 1, cz - R], [cx + W, F - 1, cz + R]], 'air')
    // Обход: перемычка z = R+1..R+3 остаётся; дальше по z — тоже провал (иначе обход вокруг всего стенда).
    await kit.fillExact('overworld', [[cx + 1, F - 1, cz + R + 4], [cx + W, F - 1, z2]], 'air')
    await kit.fillExact('overworld', [[cx + 1, F - 1, z1], [cx + W, F - 1, cz - R - 1]], 'air')
  }
}

async function main () {
  const slot = Number(process.env.FARM_SLOT)
  if (!(slot >= 1 && slot <= 32) || process.env.ND_WS !== `ws://127.0.0.1:${8800 + slot}` || process.env.MC_USERNAME !== `NeuroFarm${slot}`) throw new Error('только ферма')
  const SCENES = String(process.env.SCENES || 'gap4_10,river8,valley6,flat').split(',').filter(Boolean)
  const MODES = String(process.env.MODES || 'base,bridge').split(',').filter(Boolean)
  const REPS = Number(process.env.REPS || 2)
  const conn = connect(process.env.ND_WS)
  await conn.ready
  try {
    const c0 = await conn.call('connect')
    if (c0.status !== 'done') throw new Error('connect: ' + (c0.error || c0.status))
    const st0 = await conn.call('status')
    if (st0.detail.server !== `127.0.0.1:${25600 + slot}`) throw new Error('сервер не фермы')
    const kit = createKit({ call: conn.call, heard: conn.heard, logFile: process.env.ND_SERVER_LOG, player: process.env.MC_USERNAME })
    await kit.gamerule('send_command_feedback', 'true')
    await kit.gamerule('spawn_mobs', 'false')
    await kit.gamerule('advance_time', 'false')
    await kit.cmd('/random reset *')
    await kit.cmd('/time set day')
    await kit.cmd('/weather clear')
    let k = 0
    for (let rep = 0; rep < REPS; rep++) {
      for (const name of SCENES) {
        // Порядок режимов в паре — по очереди, чтобы прогрев/нагрузка не шли всегда в пользу одного.
        const order = (rep + k) % 2 ? [...MODES].reverse() : MODES
        for (const mode of order) {
          k++
          await trial(conn, kit, { slot, name, mode, k, rep })
        }
      }
    }
  } finally {
    try { await conn.call('disconnect') } catch {}
    conn.close()
  }
}

async function trial (conn, kit, { slot, name, mode, k, rep }) {
  const sc = parse(name)
  const cx = 4000 + (k % 12) * 40; const cz = 4000 + slot * 0
  const r = { slot, scene: name, mode, rep, ok: false }
  try {
    // Прошлое намерение (goto, оборванный по времени) — снять: клавиши и цель pathfinder'а не должны пережить телепорт.
    await conn.call('stop').catch(() => {})
    await kit.cmd('/gamemode creative')
    await kit.cmd('/clear @s')
    await kit.ensureWorld('overworld', { tp: `${cx + 0.5} ${F + 4} ${cz + 0.5}` })
    await build(kit, sc, cx, cz)
    const bar = ['iron_pickaxe', 'cobblestone 64', 'bread 8', 'ender_pearl 16']
    for (let i = 0; i < bar.length; i++) await kit.cmd(`/item replace entity @s hotbar.${i} with minecraft:${bar[i]}`)
    await kit.cmd('/item replace entity @s inventory.0 with minecraft:cobblestone 64')
    await kit.cmd(`/tp @s ${cx + 0.5} ${F} ${cz + 0.5} -90 0`)
    await sleep(1200)
    await kit.cmd('/effect give @s minecraft:instant_health 1 5 true')
    await kit.cmd('/effect give @s minecraft:saturation 1 5 true')
    await kit.cmd('/gamemode survival')
    await sleep(1000)
    let s0 = (await conn.call('status')).state
    // Телепорт изредка не доходит (4 из 108 в mv-gap-1: тело осталось в прошлом стенде) — ещё раз.
    for (let i = 0; i < 3 && (Math.abs(s0.pos.y - F) > 0.1 || Math.abs(s0.pos.x - (cx + 0.5)) > 0.6); i++) {
      await kit.cmd(`/tp @s ${cx + 0.5} ${F} ${cz + 0.5} -90 0`)
      await sleep(1500)
      s0 = (await conn.call('status')).state
    }
    r.start = { pos: s0.pos, hp: s0.health }
    if (Math.abs(s0.pos.y - F) > 0.1) throw new Error(`не на плите: ${JSON.stringify(s0.pos)}`)
    const cobble0 = s0.inventory.cobblestone || 0
    const track = []
    let going = true
    const poll = (async () => {
      while (going) {
        const s = await conn.call('status').catch(() => null)
        if (s && s.state) track.push({ t: gameClock.now(), y: s.state.pos.y, hp: s.state.health })
        await sleep(100)
      }
    })()
    const gx = cx + sc.W + 8
    const gy = sc.kind === 'cliff' ? F - sc.H : F
    const t0 = gameClock.now()
    const pearl = /pearl/.test(mode) ? { reserve: 0, minGain: 3, hpMin: 10 } : false
    let g = await conn.call('goto', { x: gx, y: gy, z: cz, range: 1, timeoutSeconds: 75, bridge: /bridge/.test(mode), pathWait: mode !== 'base', pearl, sprint: /sprint/.test(mode) })
    // Урон жемчуга (5 хп) рвёт goto как «damage» (events.js QUIET_DAMAGE его не знает) — как кампания: позвать ещё раз.
    for (let i = 0; i < 2 && g.status === 'interrupted' && gameClock.now() - t0 < 70000; i++) {
      r.reGoto = (r.reGoto || 0) + 1
      g = await conn.call('goto', { x: gx, y: gy, z: cz, range: 1, timeoutSeconds: 75, bridge: /bridge/.test(mode), pathWait: mode !== 'base', pearl, sprint: /sprint/.test(mode) })
    }
    r.ms = gameClock.now() - t0
    await sleep(600)
    going = false
    await poll
    const s1 = (await conn.call('status')).state
    r.goto = { status: g.status, error: g.error || null, attempts: g.detail && g.detail.attempts }
    r.end = { pos: s1.pos, hp: s1.health }
    r.minHp = Math.min(...track.map(p => p.hp), s1.health)
    r.minY = Math.round(Math.min(...track.map(p => p.y), s1.pos.y) * 100) / 100
    r.fell = r.minY < gy - 0.6 && sc.kind !== 'valley' && sc.kind !== 'river' && sc.kind !== 'lake'
    r.blocks = Math.max(0, cobble0 - (s1.inventory.cobblestone || 0))
    r.pearls = Math.max(0, (s0.inventory.ender_pearl || 0) - (s1.inventory.ender_pearl || 0))
    if (g.detail && g.detail.pearl) r.pearlRun = g.detail.pearl
    r.arrived = Math.abs(s1.pos.x - (gx + 0.5)) <= 2 && Math.abs(s1.pos.z - (cz + 0.5)) <= 2 && Math.abs(s1.pos.y - gy) <= 1
    r.ok = r.arrived && s1.health > 0
  } catch (e) { r.error = e.message }
  fs.appendFileSync(process.env.LAB_OUT, JSON.stringify(r) + '\n')
  console.log(JSON.stringify({ slot: r.slot, scene: r.scene, mode: r.mode, ok: r.ok, ms: r.ms, minHp: r.minHp, fell: r.fell, blocks: r.blocks, pearls: r.pearls, goto: r.goto && r.goto.status, error: r.error }))
  return r
}

main().catch(e => { console.error(e); process.exitCode = 1 })
