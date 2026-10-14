// Быстрый спуск со скалы (S6c 07.10): A/B «спуск вкл/выкл» в одном сеансе, на одном демоне (goto {descent:false} — выкл).
//   node farm/farm.js run try-descent.js --slots 17 --tag s6c-desc-water LAYOUT=water REPEAT=6
// Скала 24 бл. (плато x 4300..4310, z 3795..3805, верх ног 164), пол y 140 вокруг, медленный путь — лестница на западе
// (24 ступени вниз, потом назад по полу). Цель — на полу к востоку.
//   LAYOUT=water       — пруд 3×3 глубиной 2 в 3 бл. от стены (без ведра); LAYOUT=web — паутина 3×3 там же, на полу;
//   LAYOUT=ledges      — уступы по 3 вниз через щель в 1 бл. (pathfinder их не берёт, прыжки паркура — да);
//   LAYOUT=wall        — гладкая стена, 64 булыжника в хотбаре (блок на грань стены в падении, клатч deep);
//   LAYOUT=bucket      — гладкая стена, ведро воды (MLG pathfinder'а — одинаково в обоих плечах, замер базы);
//   LAYOUT=nether      — то же, что ledges, но в Аду (незерак, лава на полу в стороне; NO_BLOCKS=1 — без незерака в рюкзаке);
//   LAYOUT=flex        — уступы, первый на 5 ниже (2 хп при полном хп — по правилу гибкости);
//   LAYOUT=ridge       — спуск НА ХОДУ: старт в 28 бл. от пруда, pathfinder идёт вдоль края к лестнице, сторож descent.watch.
//   LAYOUT=boat        — гладкая стена, лодка и каменный топор (14.10: лодка под себя в падении, разбить, подобрать);
//                        HEIGHT=20|30|40 — высота скалы (по умолчанию 24).
// MIN_GAIN=-60 — спуск без сравнения с пешим путём (замер самого приёма; в строке forced).
// Строка на заход: ticks (игровые), wallMs, hp, урон, смерть, дошёл ли, какой спуск выбран, сколько блоков поставлено.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
const { connect, createKit } = require('./scene-kit')

export async function runDescent(): Promise<void> {
  const slot = Number(process.env.FARM_SLOT)
  assert.ok(Number.isInteger(slot) && slot >= 1 && slot <= 32 && slot !== 29, 'descent: farm slot other than the author map (29)')
  assert.equal(process.env.ND_WS, `ws://127.0.0.1:${8800 + slot}`)
  const connection = connect(process.env.ND_WS); await connection.ready
  const player = process.env.MC_USERNAME
  const kit = createKit({ call: connection.call, heard: connection.heard, logFile: process.env.ND_SERVER_LOG, player })
  const rcon = (command: string) => execFileSync(process.execPath, [path.resolve(__dirname, '../farm/farm.js'), 'rcon', String(slot), command], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
  const status = async () => connection.call('status', { physics: true })
  const layout = process.env.LAYOUT || 'water'
  const nether = layout === 'nether'
  const dim = nether ? 'the_nether' : 'overworld'
  const X0 = 4300; const Z0 = 3800; const FLOOR = 140; const TOP = FLOOR + Number(process.env.HEIGHT || 24)
  const W = Math.max(30, TOP - FLOOR + 6) // лестница медленного пути на запад — длиной в высоту
  const rock = nether ? 'netherrack' : 'stone'
  // LAYOUT=ridge (сторож на ходу): длинное плато вдоль z, старт на севере у восточного края, лестница — на юге; пруд на
  // востоке посередине; goto к цели к востоку от пруда — pathfinder идёт на юг вдоль края, мимо пруда.
  const ridge = layout === 'ridge'
  const start = ridge ? [X0 + 8.5, TOP, Z0 - 28.5] : [X0 + 4.5, TOP, Z0 + .5]
  const goal = ridge ? [X0 + 38, FLOOR, Z0 - 10] : [X0 + 38, FLOOR, Z0]
  const box = (a: number[], b: number[], block: string) => kit.fillExact(dim, [a, b], block)
  async function build(): Promise<void> {
    await box([X0 - W, FLOOR - 6, Z0 - 32], [X0 + 50, TOP + 12, Z0 + 32], 'air')
    await box([X0 - W, FLOOR - 6, Z0 - 32], [X0 + 50, FLOOR - 1, Z0 + 32], rock)
    if (ridge) {
      await box([X0, FLOOR, Z0 - 30], [X0 + 10, TOP - 1, Z0 + 5], rock)
      for (let i = 1; i <= TOP - FLOOR; i++) await box([X0 + 7, FLOOR, Z0 + 5 + i], [X0 + 9, TOP - 1 - i, Z0 + 5 + i], rock)
      return
    }
    await box([X0, FLOOR, Z0 - 5], [X0 + 10, TOP - 1, Z0 + 5], rock)
    // Медленный путь: лестница на запад вдоль z = Z0 (ступень на клетку), сплошной откос.
    for (let i = 1; i <= TOP - FLOOR; i++) await box([X0 - i, FLOOR, Z0 - 1], [X0 - i, TOP - 1 - i, Z0 + 1], rock)
  }
  // Перед каждым заходом: восток от скалы заново (поставленные клатчем блоки, вода из ведра), плюс раскладка.
  async function reset(): Promise<void> {
    await box([X0 - W, TOP, Z0 - 32], [X0 + 10, TOP + 12, Z0 + 12], 'air')
    await box([X0 + 11, FLOOR, Z0 - 32], [X0 + 50, TOP + 12, Z0 + 12], 'air')
    await box([X0 + 11, FLOOR - 3, Z0 - 32], [X0 + 50, FLOOR - 1, Z0 + 12], rock)
    if (layout === 'water') await box([X0 + 14, FLOOR - 2, Z0 - 1], [X0 + 16, FLOOR - 1, Z0 + 1], 'water')
    if (ridge) await box([X0 + 14, FLOOR - 2, Z0 - 11], [X0 + 16, FLOOR - 1, Z0 - 9], 'water')
    if (layout === 'web') await box([X0 + 14, FLOOR, Z0 - 1], [X0 + 16, FLOOR, Z0 + 1], 'cobweb')
    if (layout === 'ledges' || layout === 'flex' || nether) {
      for (let i = 0; i < 8; i++) {
        // flex: первый уступ на 5 ниже (2 хп — гибкость: малый урон при полном хп, если быстрее), дальше по 3.
        const x = X0 + 12 + 3 * i; const top = TOP - 3 * (i + 1) - 1 - (layout === 'flex' ? 2 : 0)
        if (top < FLOOR) break
        await box([x, FLOOR, Z0 - 1], [x + 1, top, Z0 + 1], rock)
      }
      if (nether) await box([X0 + 20, FLOOR - 1, Z0 + 6], [X0 + 26, FLOOR - 1, Z0 + 9], 'lava')
    }
  }
  try {
    await connection.call('connect'); assert.equal((await status()).detail.server, `127.0.0.1:${25600 + slot}`)
    await connection.call('stop'); await connection.call('play_mode', { mode: 'free' })
    await kit.cmd('/gamemode creative'); await kit.ensureWorld(dim, { tp: start.join(' ') })
    await kit.cmd('/gamerule spawn_mobs false'); await kit.cmd('/gamerule advance_time false'); await kit.cmd('/time set 6000')
    await kit.cmd('/gamerule fall_damage true')
    await build()
    const repeat = Math.max(1, Number(process.env.REPEAT ?? 4))
    const arms = (process.env.ARMS || 'on,off').split(',')
    for (let trial = 0; trial < repeat * arms.length; trial++) {
      const arm = arms[trial % arms.length]
      await connection.call('stop'); await kit.cmd('/gamemode creative')
      // Сначала к старту (чанки раскладки загружены): тело могло умереть и появиться на точке мира — fill вдали не идёт.
      await kit.ensureWorld(dim, { tp: start.join(' ') })
      await reset()
      await kit.cmd('/kill @e[type=!player,distance=..128]')
      await kit.cmd(`/execute in minecraft:${dim} run tp @s ${start.join(' ')} 90 0`)
      await kit.cmd('/clear @s')
      if (layout === 'wall') await kit.cmd('/give @s cobblestone 64')
      if (layout === 'boat') { await kit.cmd('/give @s oak_boat 1'); await kit.cmd('/give @s stone_axe 1') }
      if (layout === 'bucket') await kit.cmd('/give @s water_bucket 1')
      if (nether && process.env.NO_BLOCKS !== '1') await kit.cmd('/give @s netherrack 64')
      await kit.cmd('/effect give @s minecraft:instant_health 1 5 true')
      await kit.cmd('/effect give @s minecraft:saturation 1 20 true')
      await kit.cmd('/gamemode survival'); await kit.cmd('/effect give @s minecraft:instant_health 1 5 true'); await connection.call('wait', { seconds: 1 })
      const before = await status(); const mark = connection.heard.length; const wall0 = Date.now()
      const reply = await connection.call('goto', { x: goal[0], y: goal[1], z: goal[2], range: 1, timeoutSeconds: 120, descent: arm === 'on' ? (process.env.MIN_GAIN ? { minGain: Number(process.env.MIN_GAIN) } : {}) : false })
      const wallMs = Date.now() - wall0
      await connection.call('wait', { seconds: 1 })
      const after = await status()
      const ticks = (after.state.clock?.ticks ?? NaN) - (before.state.clock?.ticks ?? NaN)
      const end = after.detail.physics?.pos
      const died = connection.heard.slice(mark).some((event: { type: string }) => event.type === 'death') || after.state.health <= 0
      const away = end ? Math.hypot(end.x - (goal[0] + .5), end.z - (goal[2] + .5)) : null
      const detail = reply.detail || {}
      const clutch0 = before.detail.physics?.clutch?.stats ?? {}; const clutch1 = after.detail.physics?.clutch?.stats ?? {}
      const inv = after.state.inventory || {}
      const row = { physical: true, slot, trial, layout, arm, height: TOP - FLOOR, boats: Object.entries(inv).filter(([k]) => /_boat$/.test(k)).reduce((n, [, v]: any) => n + v, 0), status: reply.status, ticks, seconds: ticks / 20, wallMs, ticksPerWallSecond: ticks / (wallMs / 1000),
        hp: after.state.health, hpLost: 20 - after.state.health, died, away, ok: reply.status === 'done' && away !== null && away < 2.5 && !died,
        descent: detail.descent ?? null, error: reply.error ?? null, by: reply.by ?? null, placed: (clutch1.placed ?? 0) - (clutch0.placed ?? 0), saved: (clutch1.saved ?? 0) - (clutch0.saved ?? 0),
        lockstep: process.env.ND_LOCKSTEP === '1', forced: process.env.MIN_GAIN ? Number(process.env.MIN_GAIN) : null, clocks: { before: before.state.clock, after: after.state.clock } }
      console.log(JSON.stringify(row)); if (process.env.LAB_OUT) fs.appendFileSync(process.env.LAB_OUT, JSON.stringify(row) + '\n')
    }
  } finally {
    try { await connection.call('stop') } catch {}
    connection.close()
  }
}
if (require.main === module) runDescent().catch(error => { console.error(error); process.exitCode = 1 })
