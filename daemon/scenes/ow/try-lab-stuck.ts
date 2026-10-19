'use strict'
import * as gameClock from '../../src/game-clock'
// Застревания (поток unstuck, 02.10.2026): стенды по настоящим случаям из журналов фермы (research/stuck-cases.md),
// goto с лестницей выхода (unstuck:true) против без неё (unstuck:false) на одном демоне; режимы чередуются в паре.
// Стенд в небе (y 200) — чужой рельеф не мешает. Каждый стенд строится один раз образцом (x 9000+), перед пробой —
// /clone образца на место пробы (стенд всегда одинаковый, прошлые копки и блоки не мешают).
//   pond      — яма-пруд 3×3 глубиной 2, берег на 2 выше воды (water-exit: «сухой клетки рядом нет — из воды не выбраться»);
//   lavapit   — карман 1×2 в незераке, над потолком лава, к цели 8 бл. сплошного незерака (pit-roof/goto-empty, Ад:
//               «из ямы вылез на 0 — сверху lava», neF-S26-1); lavapit0 — то же без кирки («кирки в рюкзаке нет вовсе»);
//   kelp      — озеро глубиной 4 с ламинарией и травой, тело на дне, берег на 1 выше воды ([stuck-node] в воде, «застрял на
//               kelp у air»);
//   canopy    — тело на кроне ели (листва в 3 слоя, 7 над землёй), цель на земле («застрял на air у spruce_leaves»);
//   mangrove  — болото: ил, вода, корни мангров с ковром мха, низкая листва («застрял на mud у mangrove_roots»);
//   warped    — искажённый лес Ада: нилий, стебли, наросты на высоте головы, корни («застрял на air у warped_wart_block»);
//   gravel    — штрек 1×2 в камне, впереди стенка, над ней гравий (buried / «завалило»);
//   lavafield — Ад: цель в 70 бл. через поле лавовых луж (goto-timeout «Took to long»), срок 90 с;
//   powder    — яма рыхлого снега поперёк пути («застрял на powder_snow» → смерть от холода).
// Режимы: base — goto без лестницы (unstuck:false), unstuck — с ней (unstuck:true). Остальное — по умолчанию демона.
//   node dist/farm/farm.js run try-lab-stuck.js --slots 27-28 --tag st-1 SCENES=pond,lavapit,kelp MODES=base,unstuck REPS=5
// Метрики: ok (дошёл), ms (время goto), minHp, blocks (строительных ушло), ladder (detail.unstuck), error.
import * as fs from 'fs'
import { connect, createKit, sleep } from '../lib/scene-kit'

const F = Number(process.env.FLOOR || 200)
const TIMEOUT = Number(process.env.GOTO_SEC || 60)

// Псевдослучай по клетке (смещение от начала стенда) — стенд одинаковый всегда.
const hash = (x, z, s = 0) => { let h = (x * 73856093) ^ (z * 19349663) ^ (s * 83492791); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296 }

const KIT_STD = ['iron_pickaxe', 'cobblestone 64', 'bread 8', 'iron_shovel', 'iron_axe']

// box — от начала стенда (cx, cz): [[dx1, y1, dz1], [dx2, y2, dz2]]; start/goal — тоже относительно.
const SCENES = {
  pond: {
    box: [[-6, F - 6, -6], [14, F + 4, 6]],
    start: [0.5, F - 5, 0.5], goal: [10, F, 0], bar: KIT_STD,
    async build (b) {
      await b.fill([-6, F - 6, -6], [14, F - 1, 6], 'stone')
      await b.fill([-1, F - 5, -1], [1, F - 4, 1], 'water')
      await b.fill([-1, F - 3, -1], [1, F - 1, 1], 'air')
    }
  },
  lavapit: lavapitScene(true),
  lavapit0: lavapitScene(false),
  kelp: {
    box: [[-3, F - 6, -6], [16, F + 4, 6]],
    start: [0.5, F - 4, 0.5], goal: [13, F + 1, 0], bar: KIT_STD,
    async build (b) {
      await b.fill([-3, F - 6, -6], [16, F, 6], 'stone')
      await b.fill([-2, F - 4, -5], [8, F - 1, 5], 'water')
      await b.fill([-2, F, -5], [8, F + 4, 5], 'air')
      for (let x = -1; x <= 7; x++) {
        for (let z = -4; z <= 4; z++) {
          if (x === 0 && z === 0) continue
          const r = hash(x, z, 1)
          if (r < 0.28) {
            const top = F - 4 + Math.floor(hash(x, z, 2) * 3)
            for (let y = F - 4; y < top; y++) await b.set(x, y, z, 'kelp_plant')
            await b.set(x, top, z, 'kelp[age=25]')
          } else if (r < 0.5) await b.set(x, F - 4, z, 'seagrass')
          else if (r < 0.6) { await b.set(x, F - 4, z, 'tall_seagrass[half=lower]'); await b.set(x, F - 3, z, 'tall_seagrass[half=upper]') }
        }
      }
    }
  },
  canopy: {
    box: [[-4, F - 2, -4], [14, F + 9, 4]],
    start: [2.5, F + 7, 0.5], goal: [12, F, 0], bar: ['iron_pickaxe', 'cobblestone 64', 'bread 8'],
    async build (b) {
      await b.fill([-4, F - 2, -4], [14, F - 1, 4], 'grass_block')
      await b.fill([-3, F + 4, -3], [3, F + 6, 3], 'spruce_leaves[persistent=true]')
      await b.fill([0, F, 0], [0, F + 5, 0], 'spruce_log')
    }
  },
  mangrove: {
    box: [[-3, F - 4, -6], [17, F + 5, 6]],
    start: [-1.5, F, 0.5], goal: [16, F, 0], bar: KIT_STD,
    async build (b) {
      await b.fill([-3, F - 4, -6], [17, F - 1, 6], 'mud')
      await b.fill([-3, F - 1, -6], [-1, F - 1, 6], 'grass_block')
      await b.fill([15, F - 1, -6], [17, F - 1, 6], 'grass_block')
      for (let x = 0; x <= 14; x++) {
        for (let z = -5; z <= 5; z++) {
          const r = hash(x, z, 3)
          if (r < 0.35) {
            await b.set(x, F - 1, z, 'water')
            if (hash(x, z, 4) < 0.3) await b.set(x, F - 2, z, 'water')
          } else if (r < 0.55) {
            const h = 1 + Math.floor(hash(x, z, 5) * 2)
            await b.fill([x, F, z], [x, F + h - 1, z], 'mangrove_roots')
            if (hash(x, z, 6) < 0.5) await b.set(x, F + h, z, 'moss_carpet')
          } else if (r < 0.62) await b.set(x, F, z, 'moss_carpet')
          if (hash(x, z, 7) < 0.18) await b.set(x, F + 2, z, 'mangrove_leaves[persistent=true]')
        }
      }
    }
  },
  warped: {
    box: [[-3, F - 2, -6], [17, F + 6, 6]],
    start: [-1.5, F, 0.5], goal: [16, F, 0], bar: ['iron_pickaxe', 'netherrack 64', 'bread 8'],
    async build (b) {
      await b.fill([-3, F - 2, -6], [17, F - 2, 6], 'netherrack')
      await b.fill([-3, F - 1, -6], [17, F - 1, 6], 'warped_nylium')
      for (let x = 0; x <= 14; x++) {
        for (let z = -5; z <= 5; z++) {
          const r = hash(x, z, 9)
          if (r < 0.08) await b.fill([x, F, z], [x, F + 4, z], 'warped_stem')
          else if (r < 0.3) await b.set(x, F + 1 + (hash(x, z, 10) < 0.5 ? 0 : 1), z, 'warped_wart_block')
          else if (r < 0.45) await b.set(x, F, z, 'warped_roots')
          else if (r < 0.5) await b.set(x, F, z, 'warped_fungus')
          if (r >= 0.08 && hash(x, z, 11) < 0.25) await b.set(x, F + 3, z, 'warped_wart_block')
        }
      }
    }
  },
  // Ад, дальняя цель через поле лавовых луж (goto-timeout: «Took to long to decide path», Ад 46 эпизодов; neF-map26-2,
  // neF-bB24-3): 70 бл., лужи 35 % плиток 2×2, столбы; стены по краям — с поля не упасть.
  lavafield: {
    box: [[-3, F - 3, -17], [74, F + 3, 17]], sec: 90,
    start: [-1.5, F, 0.5], goal: [71, F, 0], bar: ['iron_pickaxe', 'netherrack 64', 'bread 8'],
    async build (b) {
      await b.fill([-3, F - 3, -17], [74, F - 1, 17], 'netherrack')
      await b.fill([-3, F, -17], [74, F + 2, -17], 'netherrack')
      await b.fill([-3, F, 17], [74, F + 2, 17], 'netherrack')
      // Лужи и столбы плитками 2×2 (меньше команд на сборку образца).
      for (let x = 3; x <= 65; x += 2) {
        for (let z = -15; z <= 13; z += 2) {
          const r = hash(x, z, 33) // соль 33: поле проходимо, путь ~45 плиток против 32 по прямой
          if (r < 0.35) await b.fill([x, F - 1, z], [x + 1, F - 1, z + 1], 'lava')
          else if (r < 0.42) await b.fill([x, F, z], [x, F + 1, z], 'netherrack')
        }
      }
    }
  },
  // Рыхлый снег поперёк пути (ow-E1 слот 10: «застрял на powder_snow у air» → смерть от холода): яма 7×9 глубиной 3.
  powder: {
    box: [[-3, F - 5, -5], [17, F + 4, 5]],
    start: [-1.5, F, 0.5], goal: [14, F, 0], bar: KIT_STD,
    async build (b) {
      await b.fill([-3, F - 5, -5], [17, F - 1, 5], 'stone')
      await b.fill([-3, F, -5], [17, F + 2, -5], 'stone')
      await b.fill([-3, F, 5], [17, F + 2, 5], 'stone')
      await b.fill([3, F - 3, -4], [9, F - 1, 4], 'powder_snow')
    }
  },
  gravel: {
    box: [[-3, F - 2, -3], [14, F + 6, 3]],
    start: [-1.5, F, 0.5], goal: [10, F, 0], bar: ['iron_pickaxe', 'bread 8'],
    async build (b) {
      await b.fill([-3, F - 2, -3], [14, F + 6, 3], 'stone')
      await b.fill([-2, F, 0], [12, F + 1, 0], 'air')
      await b.fill([3, F, 0], [4, F + 1, 0], 'stone')
      await b.fill([2, F + 2, 0], [5, F + 4, 0], 'gravel')
    }
  }
}

function lavapitScene (pick) {
  return {
    box: [[-4, F - 2, -4], [13, F + 5, 4]],
    start: [0.5, F, 0.5], goal: [10, F, 0], bar: pick ? ['iron_pickaxe', 'bread 8'] : ['bread 8'],
    async build (b) {
      await b.fill([-4, F - 2, -4], [13, F + 4, 4], 'netherrack')
      await b.fill([-1, F + 3, -1], [1, F + 3, 1], 'lava')
      await b.fill([0, F, 0], [0, F + 1, 0], 'air')
      await b.fill([9, F, -1], [12, F + 1, 1], 'air')
    }
  }
}

// Строитель в точке (ox, oz): координаты x/z — смещения.
function builder (kit, ox, oz) {
  return {
    fill: (a, c, block) => kit.fillExact('overworld', [[ox + a[0], a[1], oz + a[2]], [ox + c[0], c[1], oz + c[2]]], block),
    set: (x, y, z, block) => kit.cmd(`/setblock ${ox + x} ${y} ${oz + z} minecraft:${block}`)
  }
}
const absBox = (sc, ox, oz) => [[ox + sc.box[0][0], sc.box[0][1], oz + sc.box[0][2]], [ox + sc.box[1][0], sc.box[1][1], oz + sc.box[1][2]]]

const TEMPLATE_X = 9000; const TEMPLATE_Z = 9000
const built = new Set()
async function template (kit, name, idx) {
  const sc = SCENES[name]
  const ox = TEMPLATE_X + idx * 40; const oz = TEMPLATE_Z
  if (!built.has(name)) {
    const box = absBox(sc, ox, oz)
    await kit.forceload('overworld', box)
    await kit.fillExact('overworld', box, 'air')
    await sc.build(builder(kit, ox, oz))
    built.add(name)
  }
  return { ox, oz }
}

async function main () {
  const slot = Number(process.env.FARM_SLOT)
  if (!(slot >= 1 && slot <= 32) || process.env.ND_WS !== `ws://127.0.0.1:${8800 + slot}` || process.env.MC_USERNAME !== `NeuroFarm${slot}`) throw new Error('только ферма')
  const names = String(process.env.SCENES || 'pond,lavapit,kelp,canopy').split(',').filter(Boolean)
  for (const n of names) if (!SCENES[n]) throw new Error('сцена? ' + n)
  const MODES = String(process.env.MODES || 'base,unstuck').split(',').filter(Boolean)
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
    await kit.randomReset()
    await kit.cmd('/time set day')
    await kit.cmd('/weather clear')
    await kit.cmd('/gamemode creative')
    let k = 0
    for (let rep = 0; rep < REPS; rep++) {
      for (const name of names) {
        const order = (rep + k) % 2 ? [...MODES].reverse() : MODES
        for (const mode of order) {
          k++
          await trial(conn, kit, { slot, name, mode, k, rep, idx: Object.keys(SCENES).indexOf(name) })
        }
      }
    }
  } finally {
    try { await conn.call('disconnect') } catch {}
    conn.close()
  }
}

async function trial (conn, kit, { slot, name, mode, k, rep, idx }: any) {
  const sc = SCENES[name]
  const cx = 6000 + (k % 8) * 40; const cz = 6000
  const r: Record<string, any> = { slot, scene: name, mode, rep, ok: false }
  try {
    await conn.call('stop').catch(() => {})
    await kit.cmd('/gamemode creative')
    await kit.cmd('/clear @s')
    await kit.ensureWorld('overworld', { tp: `${TEMPLATE_X + idx * 40 + 0.5} ${F + 14} ${TEMPLATE_Z + 0.5}` })
    const t = await template(kit, name, idx)
    const src = absBox(sc, t.ox, t.oz)
    const dst = absBox(sc, cx, cz)
    await kit.forceload('overworld', dst)
    await kit.cmd(`/tp @s ${cx + 0.5} ${F + 14} ${cz + 0.5}`)
    const cl = await kit.cmd(`/clone ${src[0].join(' ')} ${src[1].join(' ')} ${dst[0].join(' ')} replace`)
    if (cl && cl.ok === false) throw new Error('clone: ' + JSON.stringify(cl).slice(0, 200))
    await kit.cmd('/kill @e[type=item,distance=..40]')
    for (let i = 0; i < sc.bar.length; i++) await kit.cmd(`/item replace entity @s hotbar.${i} with minecraft:${sc.bar[i]}`)
    const sx = cx + sc.start[0]; const sy = sc.start[1]; const sz = cz + sc.start[2]
    const yaw = -90
    await kit.cmd(`/tp @s ${sx} ${sy} ${sz} ${yaw} 0`)
    await sleep(1200)
    await kit.cmd('/effect give @s minecraft:instant_health 1 5 true')
    await kit.cmd('/effect give @s minecraft:saturation 1 5 true')
    await kit.cmd('/gamemode survival')
    await sleep(1000)
    let s0 = (await conn.call('status')).state
    const off = s => Math.abs(s.pos.x - Math.floor(sx)) > 1 || Math.abs(s.pos.z - Math.floor(sz)) > 1 || Math.abs(s.pos.y - Math.floor(sy)) > 2
    for (let i = 0; i < 3 && off(s0); i++) {
      await kit.cmd(`/tp @s ${sx} ${sy} ${sz} ${yaw} 0`)
      await sleep(1500)
      s0 = (await conn.call('status')).state
    }
    r.start = { pos: s0.pos, hp: s0.health }
    if (off(s0)) throw new Error(`не на старте: ${JSON.stringify(s0.pos)}`)
    const inv0 = s0.inventory || {} as Record<string, any>
    const track = []
    let going = true
    const poll = (async () => {
      while (going) {
        const s = await conn.call('status').catch(() => null)
        if (s && s.state) track.push({ t: gameClock.now(), y: s.state.pos.y, hp: s.state.health })
        await sleep(200)
      }
    })()
    const gx = cx + sc.goal[0]; const gy = sc.goal[1]; const gz = cz + sc.goal[2]
    const t0 = gameClock.now()
    const SEC = sc.sec || TIMEOUT
    const params = { x: gx, y: gy, z: gz, range: 1, timeoutSeconds: SEC, unstuck: mode === 'unstuck' }
    let g = await conn.call('goto', params)
    // Урон (лава, падение) рвёт goto «damage» — как кампания: позвать ещё раз, пока есть время.
    // Горит (лава рядом) — урон рвёт goto каждую секунду: пауза 1 с и снова, пока есть срок (до 10 раз).
    for (let i = 0; i < 10 && g.status === 'interrupted' && gameClock.now() - t0 < SEC * 1000 - 5000; i++) {
      r.reGoto = (r.reGoto || 0) + 1
      await sleep(1000)
      g = await conn.call('goto', { ...params, timeoutSeconds: Math.max(5, Math.round(SEC - (gameClock.now() - t0) / 1000)) })
    }
    r.ms = gameClock.now() - t0
    await sleep(500)
    going = false
    await poll
    const s1 = (await conn.call('status')).state
    r.goto = { status: g.status, error: g.error ? String(g.error).slice(0, 300) : null, attempts: g.detail && g.detail.attempts, stopped: g.detail && g.detail.stopped ? String(g.detail.stopped).slice(0, 200) : undefined }
    if (g.detail && g.detail.unstuck) r.ladder = g.detail.unstuck
    r.end = { pos: s1.pos, hp: s1.health }
    r.minHp = Math.min(...track.map(p => p.hp), s1.health)
    const inv1 = s1.inventory || {} as Record<string, any>
    r.blocks = ['cobblestone', 'netherrack'].reduce((n, it) => n + Math.max(0, (inv0[it] || 0) - (inv1[it] || 0)), 0)
    r.arrived = Math.abs(s1.pos.x - (gx + 0.5)) <= 2 && Math.abs(s1.pos.z - (gz + 0.5)) <= 2 && Math.abs(s1.pos.y - gy) <= 1.5
    r.ok = r.arrived && s1.health > 0
  } catch (e) { r.error = e.message }
  fs.appendFileSync(process.env.LAB_OUT, JSON.stringify(r) + '\n')
  console.log(JSON.stringify({ slot: r.slot, scene: r.scene, mode: r.mode, ok: r.ok, ms: r.ms, minHp: r.minHp, blocks: r.blocks, goto: r.goto && r.goto.status, ladder: r.ladder && r.ladder.rungs, error: r.error || (r.goto && r.goto.error) }))
  return r
}

main().catch(e => { console.error(e); process.exitCode = 1 })
