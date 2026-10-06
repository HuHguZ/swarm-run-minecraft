'use strict'
const gameClock = require('./src/game-clock')
// Мост на ходу / ожидание поиска / жемчуг / бег на НАСТОЯЩЕМ рельефе (поток movement, 02.10.2026): нет ли регресса там,
// где провалов нет или они не те, что на стенде. Ноги: старт S (/spreadplayers на поверхность) → цель T в 40–90 блоках
// (по XZ, goto без y). Каждая нога проходится всеми режимами по очереди, каждый раз — от того же S (телепорт обратно).
// Мобов нет, день. Меряем: дошёл, время, урон, «падение» (спуск > 4 блоков за секунду), блоков ушло, жемчуга ушло,
// истощение голода (exhaust, по серверу: 4 = одна единица насыщения/еды).
// Режим — набор слов: base (старый goto), wait, bridge, pearl, sprint (через «+», напр. bridge+sprint); def — всё по умолчанию.
//   node farm/farm.js run try-lab-mv-terrain.js --slots 27-28 --tag mv-terr-1 LEGS=10 MODES=base,wait,bridge SEED=7
const fs = require('fs')
const path = require('path')
const net = require('net')
const { connect, createKit, sleep } = require('./scene-kit')

// RCON своего слота (ответ /data get в latest.log не пишется — только игроку).
function rcon (cmd, timeoutMs = 5000) {
  const props = fs.readFileSync(path.join(__dirname, '..', 'farm', `server-${process.env.FARM_SLOT}`, 'server.properties'), 'utf8')
  const prop = k => { const line = props.split(/\r?\n/).find(l => l.startsWith(k + '=')); return line ? line.slice(k.length + 1) : null }
  return new Promise<any>((resolve, reject) => {
    const pkt = (id, type, body) => {
      const b = Buffer.from(body, 'utf8')
      const buf = Buffer.alloc(14 + b.length)
      buf.writeInt32LE(10 + b.length, 0); buf.writeInt32LE(id, 4); buf.writeInt32LE(type, 8); b.copy(buf, 12)
      return buf
    }
    const sock = net.connect(Number(prop('rcon.port')), '127.0.0.1', () => sock.write(pkt(1, 3, prop('rcon.password'))))
    let acc = Buffer.alloc(0)
    let authed = false
    const t = gameClock.wall.setTimeout(() => { sock.destroy(); reject(new Error('rcon timeout')) }, timeoutMs)
    sock.on('data', d => {
      acc = Buffer.concat([acc, d])
      while (acc.length >= 4) {
        const len = acc.readInt32LE(0)
        if (acc.length < len + 4) break
        const id = acc.readInt32LE(4)
        const body = acc.slice(12, len + 2).toString('utf8')
        acc = acc.slice(len + 4)
        if (!authed) {
          if (id === -1) { gameClock.wall.clearTimeout(t); sock.end(); return reject(new Error('rcon auth')) }
          authed = true
          sock.write(pkt(2, 2, cmd))
        } else { gameClock.wall.clearTimeout(t); sock.end(); return resolve(body) }
      }
    })
    sock.on('error', e => { gameClock.wall.clearTimeout(t); reject(e) })
  })
}

// Голод: истощение (exhaustion) клиенту не видно — читаем у сервера. Спринт 0.1/блок (spigot.yml sprint-multiplier),
// шаг 0 (other-multiplier 0.0), прыжок 0.05, прыжок в беге 0.2; 4 истощения = 1 ед. насыщения (потом еды).
async function hunger () {
  const get = async (k) => {
    const out = await rcon(`data get entity ${process.env.MC_USERNAME} ${k}`)
    const m = /entity data: (-?[0-9.]+)/.exec(out)
    return m ? Number(m[1]) : NaN
  }
  return { food: await get('foodLevel'), sat: await get('foodSaturationLevel'), ex: await get('foodExhaustionLevel') }
}

// Булыжник в коробке — в воздух (RCON, кусками ≤ 32768 блоков: предел /fill).
async function clean (a, b) {
  let n = 0
  const dy = b[1] - a[1] + 1
  const step = Math.max(1, Math.floor(Math.sqrt(32768 / dy)))
  for (let x = a[0]; x <= b[0]; x += step) {
    for (let z = a[2]; z <= b[2]; z += step) {
      const out = await rcon(`fill ${x} ${a[1]} ${z} ${Math.min(b[0], x + step - 1)} ${b[1]} ${Math.min(b[2], z + step - 1)} minecraft:air replace minecraft:cobblestone`)
      const m = /filled ([0-9]+)/.exec(out)
      if (m) n += Number(m[1])
    }
  }
  return n
}

function rng (seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 } }

async function main () {
  const slot = Number(process.env.FARM_SLOT)
  if (!(slot >= 1 && slot <= 32) || process.env.ND_WS !== `ws://127.0.0.1:${8800 + slot}` || process.env.MC_USERNAME !== `NeuroFarm${slot}`) throw new Error('только ферма')
  const LEGS = Number(process.env.LEGS || 8)
  const MODES = String(process.env.MODES || 'base,wait,bridge').split(',').filter(Boolean)
  const R = rng(Number(process.env.SEED || 7) * 1000 + slot)
  const X0 = Number(process.env.X0 || 1200); const Z0 = Number(process.env.Z0 || -800)
  // ONLY=4,7 — только эти ноги (ГСЧ ног идёт как обычно: те же старты и цели, что в полной серии с тем же SEED).
  const ONLY = process.env.ONLY ? new Set(String(process.env.ONLY).split(',').map(Number)) : null
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
    await kit.randomReset()
    await kit.cmd('/time set day')
    await kit.cmd('/weather clear')
    await kit.cmd('/kill @e[type=!player,distance=..200]')
    for (let leg = 0; leg < LEGS; leg++) {
      const sx = Math.round(X0 + (R() - 0.5) * 600); const sz = Math.round(Z0 + (R() - 0.5) * 600)
      const a = R() * Math.PI * 2; const d = 40 + R() * 50
      const tx = Math.round(sx + Math.cos(a) * d); const tz = Math.round(sz + Math.sin(a) * d)
      if (ONLY && !ONLY.has(leg)) continue
      const order = leg % 2 ? [...MODES].reverse() : MODES
      // Старт ноги — один на все режимы: первый ставит /spreadplayers, остальные — /tp в ту же точку (в mv-terr-1
      // spreadplayers разводил режимы по разным местам: y 64 и y 33 в овраге).
      const start: Record<string, any> = {} as Record<string, any>
      for (const mode of order) await trial(conn, kit, { slot, leg, mode, sx, sz, tx, tz, start })
    }
  } finally {
    try { await conn.call('disconnect') } catch {}
    conn.close()
  }
}

async function trial (conn, kit, { slot, leg, mode, sx, sz, tx, tz, start = {} as Record<string, any> }: any) {
  const r: Record<string, any> = { slot, leg, mode, from: [sx, sz], to: [tx, tz], ok: false }
  try {
    await kit.cmd('/gamemode creative')
    await kit.cmd('/clear @s')
    await kit.ensureWorld('overworld', { tp: `${sx + 0.5} 200 ${sz + 0.5}` })
    await kit.forceload('overworld', [[Math.min(sx, tx) - 16, 0, Math.min(sz, tz) - 16], [Math.max(sx, tx) + 16, 0, Math.max(sz, tz) + 16]]).catch(() => {})
    if (start.pos) await kit.cmd(`/tp @s ${start.pos.x} ${start.pos.y} ${start.pos.z}`)
    else await kit.cmd(`/spreadplayers ${sx} ${sz} 0 4 false @s`)
    await sleep(1500)
    const bar = ['iron_pickaxe', 'cobblestone 64', 'bread 8', 'ender_pearl 16', 'iron_shovel', 'iron_axe']
    for (let i = 0; i < bar.length; i++) await kit.cmd(`/item replace entity @s hotbar.${i} with minecraft:${bar[i]}`)
    await kit.cmd('/item replace entity @s inventory.0 with minecraft:cobblestone 64')
    await kit.cmd('/effect give @s minecraft:instant_health 1 5 true')
    await kit.cmd('/effect give @s minecraft:saturation 1 5 true')
    await kit.cmd('/gamemode survival')
    await sleep(1500)
    const s0 = (await conn.call('status')).state
    if (!start.pos) start.pos = { x: Math.floor(s0.pos.x) + 0.5, y: Math.round(s0.pos.y), z: Math.floor(s0.pos.z) + 0.5 }
    r.start = { pos: s0.pos, hp: s0.health }
    const inv0 = s0.inventory
    const track = []
    let going = true
    const poll = (async () => {
      while (going) {
        const s = await conn.call('status').catch(() => null)
        if (s && s.state) track.push({ t: gameClock.now(), y: s.state.pos.y, hp: s.state.health })
        await sleep(150)
      }
    })()
    const pearl = /pearl/.test(mode) ? { reserve: 0, minGain: 4, hpMin: 10 } : false
    // def — как в демоне по умолчанию (мост, ожидание поиска, бег по своим правилам: верхний мир, не болото, сыт).
    const params = mode === 'def' ? { x: tx, z: tz, range: 2, timeoutSeconds: 90 }
      : { x: tx, z: tz, range: 2, timeoutSeconds: 90, bridge: /bridge/.test(mode), pathWait: mode !== 'base', pearl, sprint: /sprint/.test(mode) }
    const h0 = await hunger().catch(() => null)
    const t0 = gameClock.now()
    let g = await conn.call('goto', params)
    for (let i = 0; i < 2 && g.status === 'interrupted' && gameClock.now() - t0 < 85000; i++) { r.reGoto = (r.reGoto || 0) + 1; g = await conn.call('goto', params) }
    r.ms = gameClock.now() - t0
    await sleep(500)
    going = false
    await poll
    const s1 = (await conn.call('status')).state
    const h1 = await hunger().catch(() => null)
    if (h0 && h1) r.exhaust = Math.round((4 * ((h0.sat - h1.sat) + (h0.food - h1.food)) + (h1.ex - h0.ex)) * 100) / 100
    r.goto = { status: g.status, error: g.error || null }
    r.end = { pos: s1.pos, hp: s1.health }
    r.minHp = Math.min(...track.map(p => p.hp), s1.health)
    let drop = 0
    for (let i = 0; i < track.length; i++) for (let j = i + 1; j < track.length && track[j].t - track[i].t <= 1000; j++) drop = Math.max(drop, track[i].y - track[j].y)
    r.drop = Math.round(drop * 10) / 10
    r.fell = drop > 4
    r.blocks = Math.max(0, (inv0.cobblestone || 0) - (s1.inventory.cobblestone || 0))
    r.pearls = Math.max(0, (inv0.ender_pearl || 0) - (s1.inventory.ender_pearl || 0))
    r.away = Math.round(Math.hypot(s1.pos.x - (tx + 0.5), s1.pos.z - (tz + 0.5)))
    r.ok = r.away <= 3 && s1.health > 0
    // Свои блоки (булыжник: мост, столб, клатч) — убрать: следующий режим идёт по той же ноге с того же старта, и чужой
    // мост менял ему дорогу (mv-spr-2, нога 9: мост в 13 блоков на y 79 от первого режима, второй встал на его краю).
    const ys = track.map(p => p.y).concat([s0.pos.y, s1.pos.y])
    r.cleaned = await clean([Math.min(sx, tx) - 16, Math.floor(Math.min(...ys)) - 3, Math.min(sz, tz) - 16], [Math.max(sx, tx) + 16, Math.ceil(Math.max(...ys)) + 2, Math.max(sz, tz) + 16]).catch(() => null)
  } catch (e) { r.error = e.message }
  fs.appendFileSync(process.env.LAB_OUT, JSON.stringify(r) + '\n')
  console.log(JSON.stringify({ slot, leg, mode, ok: r.ok, ms: r.ms, away: r.away, exhaust: r.exhaust, minHp: r.minHp, drop: r.drop, blocks: r.blocks, pearls: r.pearls, goto: r.goto && r.goto.status, error: r.error }))
}

main().catch(e => { console.error(e); process.exitCode = 1 })
