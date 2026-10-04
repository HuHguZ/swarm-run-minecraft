'use strict'
// Блочный клатч от падения (edges.js, сторож падения, 30.09.2026): падаем там, где вода
// не годится — Ад, нет ведра, посадка на листву, — блок на видимую грань, и тело садится
// на него с безопасной высоты. Стенд в закрытой коробке (в Аду — от лавы вокруг):
//   wall — тело стоит на одном блоке, прилепленном к стене 3×(H+3); блок убирают
//          (/setblock air) — тело падает вдоль стены с высоты H над полом;
//   edge — тело на краю висящей площадки 4×3 (под ней пусто до пола), стойка брони
//          в 2 блоках сзади; /damage 0.01 от неё — отброс 0.4 с края.
// Пол — камень/незерак, FLOOR=leaves — листва (с ведром воды в хотбаре: вода в листву
// уходит, спасать должен блок). Меряем урон от падения (события damage с cause=fall
// и минимум хп), где встало тело, сколько блоков ушло.
//   node farm/farm.js run try-lab-clutch.js --slots 29-32 --tag clutch-1 SITES=wall,edge DIMS=overworld,the_nether HS=8,12,20,30 REPS=3
//   node farm/farm.js run try-lab-clutch.js --slots 29-32 --tag clutch-leaves SITES=wall,edge DIMS=overworld FLOOR=leaves BUCKET=1 HS=8,20,30 REPS=3
const fs = require('fs')
const { connect, createKit, sleep } = require('./scene-kit')

const list = (v, def) => String(v || def).split(',').map(s => s.trim()).filter(Boolean)

async function main () {
  const slot = Number(process.env.FARM_SLOT)
  if (!(slot >= 1 && slot <= 32) || process.env.ND_WS !== `ws://127.0.0.1:${8800 + slot}` || process.env.MC_USERNAME !== `NeuroFarm${slot}`) throw new Error('только ферма')
  const SITES = list(process.env.SITES, 'wall,edge')
  const DIMS = list(process.env.DIMS, 'overworld,the_nether')
  const HS = list(process.env.HS, '8,12,20,30').map(Number).filter(h => h >= 4 && h <= 40)
  const REPS = Math.max(1, Number(process.env.REPS || 1))
  const FLOOR = process.env.FLOOR || 'solid'
  const BUCKET = process.env.BUCKET === '1'
  const conn = connect(process.env.ND_WS)
  await conn.ready
  try {
    const c0 = await conn.call('connect')
    if (c0.status !== 'done') throw new Error('connect: ' + (c0.error || c0.status))
    const st0 = await conn.call('status')
    if (st0.detail.server !== `127.0.0.1:${25600 + slot}`) throw new Error('сервер не фермы')
    const kit = createKit({ call: conn.call, heard: conn.heard, logFile: process.env.ND_SERVER_LOG, player: process.env.MC_USERNAME })
    // У Paper правила — у каждого мира свои: в Аду без send_command_feedback телепорт туда
    // молчит, и kit ждёт ответа впустую (слот 29, clutch-base: в его Аду log_admin_commands=false —
    // ответа нет и в latest.log). Сначала — во всех мирах сцены.
    for (const d of DIMS) {
      await kit.cmd(`/execute in minecraft:${d} run gamerule send_command_feedback true`)
      await kit.cmd(`/execute in minecraft:${d} run gamerule log_admin_commands true`)
      await kit.cmd(`/execute in minecraft:${d} run gamerule spawn_mobs false`)
    }
    await kit.gamerule('send_command_feedback', 'true')
    await kit.gamerule('spawn_mobs', 'false')
    await kit.gamerule('advance_time', 'false')
    await kit.cmd('/time set day')
    await kit.cmd('/weather clear')
    let k = 0
    for (let rep = 0; rep < REPS; rep++) {
      for (const site of SITES) {
        for (const dim of DIMS) {
          for (const H of HS) {
            k++
            await trial(conn, kit, { slot, site, dim, H, k, rep, floor: FLOOR, bucket: BUCKET })
          }
        }
      }
    }
  } finally {
    try { await conn.call('disconnect') } catch {}
    conn.close()
  }
}

async function trial (conn, kit, { slot, site, dim, H, k, rep, floor, bucket }) {
  const nether = dim === 'the_nether'
  const M = nether ? 'netherrack' : 'stone'
  const B = nether ? 'netherrack' : 'cobblestone'
  // Стенды по кругу из 4 мест на мир: чанки уже сгенерированы и удержаны.
  const cx = 3000 + (k % 4) * 40; const cz = 3000
  const F = nether ? 40 : 200
  const r = { slot, site, dim, H, rep, floor, bucket, ok: false }
  const w = (s) => `/execute in minecraft:${dim} run ${s}`
  try {
    await kit.cmd('/gamemode creative')
    await kit.cmd('/clear @s')
    await kit.cmd('/kill @e[type=minecraft:armor_stand,tag=ndkb]')
    // Телепорт в новый мир ждёт генерации чанков — ответ бывает дольше окна kit (6 с).
    for (let i = 0; ; i++) {
      try { await kit.ensureWorld(dim, { tp: `${cx + 0.5} ${F + H + 4} ${cz + 0.5}` }); break } catch (e) { if (i >= 2) throw e; await sleep(2000) }
    }
    await kit.forceload(dim, [[cx - 7, F, cz - 7], [cx + 13, F, cz + 7]])
    // Оболочка (в Аду — от лавы и пустот вокруг), внутри пусто: 17×11, к краю в +x — 10 блоков
    // воздуха, чтобы отброс не долетал до стенки коробки.
    await kit.fillExact(dim, [[cx - 7, F - 3, cz - 7], [cx + 13, F + H + 8, cz + 7]], M)
    await kit.fillExact(dim, [[cx - 5, F, cz - 5], [cx + 11, F + H + 6, cz + 5]], 'air')
    if (floor === 'leaves') await kit.fillExact(dim, [[cx - 5, F - 1, cz - 5], [cx + 11, F - 1, cz + 5]], 'oak_leaves[persistent=true]')
    if (site === 'wall') {
      await kit.fillExact(dim, [[cx - 1, F, cz - 1], [cx - 1, F + H + 2, cz + 1]], M)
      await kit.fillExact(dim, [[cx, F + H - 1, cz], [cx, F + H - 1, cz]], M)
    } else {
      await kit.fillExact(dim, [[cx - 3, F + H - 1, cz - 1], [cx, F + H - 1, cz + 1]], M)
    }
    await kit.cmd('/clear @s')
    const bar = ['iron_sword', 'iron_pickaxe', `${B} 32`, 'bread 8', 'torch 16', 'oak_log 4', bucket ? 'water_bucket' : 'crafting_table', 'stone_axe', 'stone_shovel']
    for (let i = 0; i < 9; i++) await kit.cmd(`/item replace entity @s hotbar.${i} with minecraft:${bar[i]}`)
    await kit.cmd(w(`tp @s ${cx + 0.5} ${F + H} ${cz + 0.5} -90 0`))
    if (site === 'edge') await kit.cmd(w(`summon minecraft:armor_stand ${cx - 1.5} ${F + H} ${cz + 0.5} {Tags:["ndkb"],NoGravity:1b}`))
    await sleep(1500)
    // Сытость — чтобы тело не взялось есть посреди опыта; урон всё равно виден по событиям
    // damage (cause=fall) — они точные, реген их не прячет.
    await kit.cmd('/effect give @s minecraft:saturation 1 5 true')
    await kit.cmd('/effect give @s minecraft:instant_health 1 5 true')
    await kit.cmd('/gamemode survival')
    await sleep(1500)
    const s0 = (await conn.call('status')).state
    r.start = { pos: s0.pos, hp: s0.health }
    if (Math.abs(s0.pos.y - (F + H)) > 0.05 || s0.health < 19.5) throw new Error(`не на месте: ${JSON.stringify(s0.pos)} хп ${s0.health}`)
    const blocks0 = s0.inventory[B] || 0
    // Трек: хп, высота, на земле ли — каждые ~60 мс.
    const track = []
    let going = true
    const poll = (async () => {
      while (going) {
        const s = await conn.call('status', { physics: true }).catch(() => null)
        if (s && s.state) track.push({ t: Date.now(), y: s.state.pos.y, x: s.state.pos.x, hp: s.state.health, g: !!(s.detail && s.detail.physics && s.detail.physics.onGround) })
        await sleep(60)
      }
    })()
    const t0 = Date.now()
    if (site === 'wall') await kit.cmd(w(`setblock ${cx} ${F + H - 1} ${cz} minecraft:air`))
    else await kit.cmd(`/damage @s 0.01 minecraft:mob_attack by @e[type=minecraft:armor_stand,tag=ndkb,limit=1]`)
    // Ждём, пока тело не простоит на земле 1.5 с (или 8 с всего).
    for (;;) {
      await sleep(100)
      const last = track[track.length - 1]
      const since = track.filter(p => p.t > Date.now() - 1500)
      if (Date.now() - t0 > 1200 && since.length >= 5 && since.every(p => p.g) && last) break
      if (Date.now() - t0 > 8000) break
    }
    going = false
    await poll
    const s1 = (await conn.call('status')).state
    r.ms = Date.now() - t0
    r.end = { pos: s1.pos, hp: s1.health }
    const after = track.filter(p => p.t >= t0)
    r.minHp = Math.min(...after.map(p => p.hp), s1.health)
    r.peak = Math.max(...after.map(p => p.y), s0.pos.y)
    r.landY = Math.round(s1.pos.y * 100) / 100
    r.fall = Math.round((r.peak - s1.pos.y) * 100) / 100
    r.drift = Math.round((s1.pos.x - s0.pos.x) * 100) / 100
    const falls = kit.between(t0, Date.now() + 1000, 'damage').filter(e => e.cause === 'fall')
    r.fallHits = falls.map(e => e.lost)
    r.blocks = blocks0 - (s1.inventory[B] || 0)
    r.water = bucket ? (s1.inventory.water_bucket || 0) > 0 : null
    r.dead = s1.health <= 0
    // Без урона: ни одного урона от падения, хп не ниже старта больше, чем на толчок 0.01.
    r.ok = !r.dead && falls.length === 0 && r.minHp >= r.start.hp - 0.05
  } catch (e) { r.error = e.message }
  try { await kit.cmd('/kill @e[type=minecraft:armor_stand,tag=ndkb]') } catch {}
  fs.appendFileSync(process.env.LAB_OUT, JSON.stringify(r) + '\n')
  console.log(JSON.stringify({ slot: r.slot, site: r.site, dim: r.dim, H: r.H, ok: r.ok, fall: r.fall, landY: r.landY, drift: r.drift, minHp: r.minHp, fallHits: r.fallHits, blocks: r.blocks, ms: r.ms, error: r.error }))
  return r
}

main().catch(e => { console.error(e); process.exitCode = 1 })
