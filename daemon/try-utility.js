'use strict'
const gameClock = require('./src/game-clock')
// Подручное (utility.js, 2026-09-26): удочка, трезубец, «Тягун», хорус, ловушки —
// по сцене на приём. NeuroDown (A) дерётся, NeuroDown2 (B) — цель (стоит, не
// бьёт), NeuroBuild (C) — судья: спрашивает сервер (/data get entity) и читает
// ответ (RPC ask). Что проверяется:
//  · удочка: B на столбе 1×1 в 3 бл.; A дёргает — поплавок зацепил (метаданные
//    hooked_entity), сервер записал B скорость рывка (Motion = 0.1 × (A − поплавок)),
//    прочность удочки −5; B падает — это его «клиент» (installRodPull);
//  · трезубец с «Верностью»: 8 урона без брони, вернулся в рюкзак;
//  · «Тягун» под дождём: рывок, сколько пролетел, касание 8;
//  · хорус: A в паутине на 5 хп — ушёл прыжком, куда и насколько;
//  · лава на B в паутине; коробка 1×2 и наковальня сверху — урон.
//   A=ws://127.0.0.1:8791 B=ws://127.0.0.1:8792 C=ws://127.0.0.1:8793 node try-utility.js [сцены через запятую]
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
  const ready = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const rid = ++id
    pending.set(rid, { resolve, reject })
    ws.send(JSON.stringify({ id: rid, method, params }))
  })
  return { ws, ready, call }
}
const sleep = ms => gameClock.sleep(ms)
const A = client(process.env.A || 'ws://127.0.0.1:8791')
const B = client(process.env.B || 'ws://127.0.0.1:8792')
const C = client(process.env.C || 'ws://127.0.0.1:8793')
const NA = 'NeuroDown'; const NB = 'NeuroDown2'; const NC = 'NeuroBuild'
const ONLY = (process.argv[2] || 'rod,trident,riptide,chorus,lava,anvil').split(',')
const LOG = path.join(__dirname, 'try-utility.log')
const log = (...a) => { const l = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(l); fs.appendFileSync(LOG, l + '\n') }
async function cmd (text) { await C.call('say', { text }); await sleep(40) }
async function ask (command, match = null, ms = 1500) { const r = await C.call('ask', { command, match, ms }).catch(e => ({ lines: ['ошибка ' + e.message] })); return (r && r.lines) || [] }

const X = 1060; const Y = 150; const Z = 1000

async function stage (name, { setup, fightMs = 12000, probe = null }) {
  await Promise.all([A.call('stop').catch(() => {}), B.call('stop').catch(() => {})])
  await cmd(`/fill ${X - 12} ${Y - 1} ${Z - 12} ${X + 12} ${Y - 1} ${Z + 12} minecraft:stone`)
  await cmd(`/fill ${X - 12} ${Y} ${Z - 12} ${X + 12} ${Y + 10} ${Z + 12} minecraft:air`)
  for (const [x1, z1, x2, z2] of [[X - 13, Z - 13, X + 13, Z - 13], [X - 13, Z + 13, X + 13, Z + 13], [X - 13, Z - 13, X - 13, Z + 13], [X + 13, Z - 13, X + 13, Z + 13]]) await cmd(`/fill ${x1} ${Y - 1} ${z1} ${x2} ${Y + 4} ${z2} minecraft:glass`)
  await cmd(`/kill @e[type=item,x=${X},y=${Y},z=${Z},distance=..30]`)
  await cmd(`/kill @e[type=trident,x=${X},y=${Y},z=${Z},distance=..30]`)
  for (const who of [NA, NB]) { await cmd(`/clear ${who}`); await cmd(`/effect clear ${who}`) }
  await cmd(`/tp ${NC} ${X} ${Y} ${Z - 10}`)
  await setup()
  for (const who of [NA, NB]) { await cmd(`/effect give ${who} minecraft:instant_health 1 10 true`); await cmd(`/effect give ${who} minecraft:saturation 1 20 true`) }
  await sleep(1200)
  const hpB0 = await hpOf(B)
  const probeRun = probe ? probe() : null
  const r = await A.call('fight', { target: NB, allowPlayer: true, timeoutSeconds: Math.round(fightMs / 1000), retreatAtHealth: 1 }).catch(e => ({ status: 'failed', error: e.message }))
  const probed = probeRun ? await probeRun : null
  const hpB1 = await hpOf(B)
  const d = r.detail || {}
  const tricks = Object.entries(d.tricks || {}).filter(([k]) => /удочк|трезуб|Тягун|хорус|ловушк|подручное|лава|наковальн|коробк/.test(k)).map(([k, v]) => `${k}×${v}`).join(' | ')
  log(`[${name}] B хп ${hpB0} -> ${hpB1} | A: ${tricks || '(подручного не было)'}${probed ? ' | сервер: ' + probed : ''}`)
  await Promise.all([A.call('stop').catch(() => {}), B.call('stop').catch(() => {})])
  return { r, hpB0, hpB1 }
}
async function hpOf (c) { const st = await c.call('status').catch(() => null); return st && st.state ? Math.round(st.state.health * 10) / 10 : null }
async function posOf (c) { const st = await c.call('status').catch(() => null); return st && st.state && st.state.pos ? st.state.pos : null }

;(async () => {
  try {
    await A.ready; await B.ready; await C.ready
    await Promise.all([A.call('connect'), B.call('connect'), C.call('connect')])
    for (const c of [A, B, C]) await c.call('temper', { enabled: false }).catch(() => {})
    await cmd('/gamerule send_command_feedback true')
    await cmd('/team leave NeuroDown2')
    await cmd('/difficulty normal')
    await cmd('/weather clear')
    await cmd(`/tp ${NA} ${X} ${Y + 1} ${Z}`); await cmd(`/tp ${NB} ${X} ${Y + 1} ${Z + 3}`); await cmd(`/tp ${NC} ${X} ${Y + 1} ${Z - 10}`)
    await sleep(2500)

    if (ONLY.includes('rod')) {
      // B на столбе 1×1 высотой 3 в 8 блоках; A — удочка и меч.
      const res = await stage('удочка: со столба', {
        fightMs: 9000,
        setup: async () => {
          await cmd(`/fill ${X} ${Y} ${Z + 8} ${X} ${Y + 2} ${Z + 8} minecraft:stone`)
          await cmd(`/tp ${NB} ${X + 0.5} ${Y + 3} ${Z + 8.5} 180 0`)
          await cmd(`/tp ${NA} ${X + 0.5} ${Y} ${Z + 0.5} 0 0`)
          await cmd(`/give ${NA} minecraft:fishing_rod`); await cmd(`/give ${NA} minecraft:iron_sword`)
        },
        // Судья: Motion у B на сервере, пока A тянет (рывок — это setDeltaMovement на сервере).
        probe: () => (async () => {
          const seen = []
          const t0 = gameClock.now()
          while (gameClock.now() - t0 < 6000) {
            const lines = await ask(`/data get entity ${NB} Motion`, 'Motion|has the following', 600)
            const l = lines.find(x => /Motion|has the following/.test(x))
            if (l) { const m = l.match(/\[([^\]]+)\]/); if (m && !/^\s*0\.0d?,\s*-0\.0784/.test(m[1])) seen.push(`${((gameClock.now() - t0) / 1000).toFixed(1)}с [${m[1]}]`) }
            await sleep(150)
          }
          const rod = await ask(`/data get entity ${NA} Inventory[{id:"minecraft:fishing_rod"}].components`, 'damage|has the following|Found no', 1200)
          return `Motion B не ноль: ${seen.slice(0, 4).join('; ') || 'нет'} | удочка A: ${rod.filter(x => /damage|components|Found/.test(x)).join(' ').slice(0, 160)}`
        })()
      })
      const p = await posOf(B)
      log(`[удочка] B после: ${p ? `y=${p.y.toFixed(2)} (столб — ${Y + 3})` : '?'}`)
    }

    if (ONLY.includes('trident')) {
      await stage('трезубец с «Верностью»', {
        fightMs: 7000,
        setup: async () => {
          await cmd(`/tp ${NB} ${X + 0.5} ${Y} ${Z + 12.5} 180 0`)
          await cmd(`/tp ${NA} ${X + 0.5} ${Y} ${Z + 0.5} 0 0`)
          await cmd(`/give ${NA} minecraft:trident[enchantments={loyalty:3}]`); await cmd(`/give ${NA} minecraft:iron_sword`)
        },
        probe: () => (async () => { await sleep(6500); const inv = await A.call('status').catch(() => null); const n = inv && inv.state && inv.state.inventory ? Object.entries(inv.state.inventory).filter(([k]) => /trident/.test(k)).map(([k, v]) => `${k}×${v}`).join(',') : '?'; return `трезубец у A через 6.5 с: ${n || 'нет'}` })()
      })
    }

    if (ONLY.includes('riptide')) {
      await cmd('/weather rain')
      await sleep(1500)
      await stage('«Тягун III» под дождём', {
        fightMs: 7000,
        setup: async () => {
          await cmd(`/tp ${NB} ${X + 0.5} ${Y} ${Z + 10.5} 180 0`)
          await cmd(`/tp ${NA} ${X + 0.5} ${Y} ${Z + 0.5} 0 0`)
          await cmd(`/give ${NA} minecraft:trident[enchantments={riptide:3}]`); await cmd(`/give ${NA} minecraft:iron_sword`)
        }
      })
      await cmd('/weather clear')
    }

    if (ONLY.includes('chorus')) {
      await stage('хорус: в паутине на 5 хп', {
        fightMs: 7000,
        setup: async () => {
          await cmd(`/tp ${NB} ${X + 0.5} ${Y} ${Z + 5.5} 180 0`)
          await cmd(`/tp ${NA} ${X + 0.5} ${Y} ${Z + 0.5} 0 0`)
          await cmd(`/setblock ${X} ${Y} ${Z} minecraft:cobweb`)
          await cmd(`/give ${NA} minecraft:chorus_fruit 4`); await cmd(`/give ${NA} minecraft:iron_sword`)
          await cmd(`/give ${NB} minecraft:iron_sword`)
        },
        probe: () => (async () => {
          await sleep(300)
          await cmd(`/damage ${NA} 15 minecraft:generic`)
          const p0 = await posOf(A)
          await sleep(5000)
          const p1 = await posOf(A)
          return p0 && p1 ? `A сдвинулся на ${Math.hypot(p1.x - p0.x, p1.z - p0.z).toFixed(1)} бл. по горизонтали, по высоте ${(p1.y - p0.y).toFixed(1)}` : '?'
        })()
      })
    }

    if (ONLY.includes('lava')) {
      await stage('лава на застрявшего в паутине', {
        fightMs: 6000,
        setup: async () => {
          await cmd(`/tp ${NB} ${X + 0.5} ${Y} ${Z + 4.5} 180 0`)
          await cmd(`/setblock ${X} ${Y} ${Z + 4} minecraft:cobweb`)
          await cmd(`/tp ${NA} ${X + 0.5} ${Y} ${Z + 0.5} 0 0`)
          await cmd(`/give ${NA} minecraft:lava_bucket`); await cmd(`/give ${NA} minecraft:iron_sword`)
        }
      })
      await cmd(`/fill ${X - 5} ${Y} ${Z - 5} ${X + 5} ${Y + 4} ${Z + 10} minecraft:air replace minecraft:lava`)
    }

    if (ONLY.includes('anvil')) {
      await stage('коробка 1×2 и наковальня', {
        fightMs: 12000,
        setup: async () => {
          await cmd(`/tp ${NB} ${X + 0.5} ${Y} ${Z + 3.5} 180 0`)
          await cmd(`/setblock ${X} ${Y} ${Z + 3} minecraft:cobweb`)
          await cmd(`/tp ${NA} ${X + 0.5} ${Y} ${Z + 0.5} 0 0`)
          await cmd(`/give ${NA} minecraft:anvil 2`); await cmd(`/give ${NA} minecraft:cobblestone 32`); await cmd(`/give ${NA} minecraft:iron_sword`)
        }
      })
    }
    await cmd('/gamerule send_command_feedback false')
  } catch (e) {
    console.error('FAILED', e.stack || e.message)
    process.exitCode = 1
  } finally {
    for (const c of [A, B, C]) { try { await c.call('stop') } catch {} ; c.ws.close() }
  }
})()
