'use strict'
import { REPO_ROOT } from '../../src/paths'
import * as gameClock from '../../src/game-clock'
// Ферма: пять пар baseline/fixed. Команды только задают лабораторный старт;
// добыча еды затем идёт настоящей campaign.js. Основной run не допускается.
// Старый campaign сохранён до правок еды; демон у обеих групп одинаковый.
import * as fs from 'fs'
import path = require('path')
import * as crypto from 'crypto'
import { spawn } from 'child_process'
import { connect, createKit, sleep } from '../lib/scene-kit'

const SLOT = Number(process.env.FARM_SLOT)
const WS = process.env.ND_WS
const PLAYER = process.env.MC_USERNAME
const OUT = process.env.LAB_OUT
const ROOT = REPO_ROOT
const BUDGET = Number(process.env.FOOD_BUDGET || 180)
const OFFSET = Number(process.env.FOOD_OFFSET || 0)
const COMPARE = process.env.FOOD_COMPARE || 'campaign'
const VARIANT = SLOT % 2 ? 'baseline' : 'fixed'
const PAIR = Math.ceil(SLOT / 2)
const CENTERS = [[600, 600], [1000, -500], [-700, 650], [-1200, -650], [900, 1200]]
const FOOD = /^(cooked_.+|beef|porkchop|mutton|chicken|rabbit|cod|salmon|bread|baked_potato|golden_carrot|apple|carrot|sweet_berries|melon_slice|pumpkin_pie|golden_apple|mushroom_stew|beetroot_soup|rabbit_stew|dried_kelp|cookie)$/
const stock = h => Object.entries<any>(h.inventory || {} as Record<string, any>).reduce((sum, [name, n]: any) => sum + (FOOD.test(name) ? n : 0), 0)
const KIT = ['stone_pickaxe 2', 'stone_sword', 'stone_axe', 'shield', 'iron_chestplate', 'iron_leggings',
  'iron_boots', 'cooked_beef 5', 'oak_log 10', 'cobblestone 96', 'coal 16', 'furnace', 'crafting_table',
  'white_bed', 'flint_and_steel', 'water_bucket']
if (COMPARE === 'combat') KIT.push('bow', 'arrow 16')

async function main () {
  if (!Number.isInteger(SLOT) || SLOT < 1 || SLOT > 10 ||
      WS !== `ws://127.0.0.1:${8800 + SLOT}` || PLAYER !== `NeuroFarm${SLOT}` || !OUT) {
    throw new Error('сцена разрешена только через farm run на слотах 1–10')
  }
  const conn = connect(WS)
  const result: Record<string, any> = { compare: COMPARE, variant: VARIANT, pair: PAIR, at: new Date().toISOString(),
    labFixture: true, fixtureItems: KIT, budget: BUDGET, ok: false }
  let child = null
  let timer = null
  let t0 = null
  let stdout = ''
  let stderr = ''
  let serverMark = 0
  const logFile = process.env.ND_SERVER_LOG
  try {
    await conn.ready
    await conn.call('connect')
    const status = await conn.call('status')
    if (status.detail.server !== `127.0.0.1:${25600 + SLOT}`) throw new Error('не тот сервер — команды отменены')
    const kit = createKit({ call: conn.call, heard: conn.heard, logFile, player: PLAYER })
    await kit.cmd('/gamemode survival')
    await kit.setDifficulty('normal')
    await kit.gamerule('spawn_mobs', 'true')
    await kit.gamerule('keep_inventory', 'true')
    await kit.cmd('/time set 1000')
    await kit.cmd('/weather clear')
    await kit.cmd('/clear @s')
    for (const item of KIT) await kit.cmd(`/give @s minecraft:${item}`)
    await kit.cmd('/effect clear @s')
    await kit.cmd('/effect give @s minecraft:slow_falling 30 0 true')
    let [x, z] = CENTERS[PAIR - 1].map(n => n + OFFSET)
    await kit.ensureWorld('overworld', { tp: `${x} 160 ${z}` })
    const located = await conn.call('ask', { command: `/locate biome minecraft:plains`, match: 'nearest|Could not', ms: 30000 })
    const line = ((located.detail || {} as Record<string, any>).lines || []).find(s => /nearest/.test(s)) || ''
    const place = /\[(-?\d+), (~|-?\d+), (-?\d+)\]/.exec(line)
    if (!place) throw new Error('не найден сухой старт в plains: ' + line)
    x = Number(place[1]); z = Number(place[3])
    await kit.must(`/spreadplayers ${x} ${z} 0 8 under 120 false @s`, /^Spread /, 'сухой старт не найден', { ms: 30000 })
    await sleep(1500)
    await kit.cmd('/effect clear @s minecraft:slow_falling')
    await kit.cmd('/effect give @s minecraft:instant_health 1 5 true')
    await kit.cmd('/effect give @s minecraft:saturation 1 20 true')
    await conn.call('armor')
    if (COMPARE === 'combat') await conn.call('play_mode', { mode: 'speedrun', arrowReserve: 16 })
    const start = (await conn.call('status')).state
    const terrain = (await conn.call('observe', { radius: 4, fair: false })).detail?.terrain || {} as Record<string, any>
    result.startBiome = start.biome
    result.standingOn = terrain.standingOn
    if (/water|lava/.test(terrain.standingOn || '')) throw new Error('старт в воде/лаве не является корректной сценой охоты')
    if (start.dimension !== 'overworld' || stock(start) !== 5 || start.health < 19) {
      throw new Error('не подтверждён одинаковый старт: ' + JSON.stringify(start))
    }
    result.start = start.pos
    result.startFood = stock(start)
    // Вторая половина пары получает точно ту же исходную позицию: её мир
    // независим, а сид тот же. Запись первой половины не трогает карту.
    const pairFile = path.join(path.dirname(OUT), `pair-${PAIR}-start.json`)
    if (VARIANT === 'baseline') {
      fs.writeFileSync(pairFile, JSON.stringify(start.pos))
    } else {
      const until = gameClock.wall.now() + 90000
      while (!fs.existsSync(pairFile) && gameClock.wall.now() < until) await gameClock.wall.sleep(200)
      if (!fs.existsSync(pairFile)) throw new Error('нет исходной позиции второй половины пары')
      const p = JSON.parse(fs.readFileSync(pairFile, 'utf8'))
      await kit.ensureWorld('overworld', { tp: `${p.x + 0.5} ${p.y} ${p.z + 0.5}` })
      await sleep(500)
      result.start = ((await conn.call('status')).state || {} as Record<string, any>).pos
    }
    const liveLog = path.join(path.dirname(OUT), `slot-${SLOT}-campaign.log`)
    // У пары совпадают и место, и курс. Иначе сравнивались бы разные стада.
    result.heading = (PAIR - 1) * 1.3
    // Нынешняя кампания — вход campaign.js и части campaign/: курс ей задаёт ND_HEADING. Старый снимок одним файлом
    // (baseline сравнения 28.09) — правкой текста в копии, как раньше.
    const entry = path.join(__dirname, '..', '..', 'campaign.js')
    let source = entry
    if (VARIANT === 'baseline' && COMPARE === 'campaign') {
      const original = fs.readFileSync(path.join(ROOT, 'run/backups/2026-09-28-food-ab/campaign.js'), 'utf8')
      const headingDecl = 'let heading = Math.random() * 2 * Math.PI'
      if (!original.includes(headingDecl)) throw new Error('не узнаю исходную политику направления')
      result.sourceSha256 = crypto.createHash('sha256').update(original).digest('hex')
      source = path.join(path.dirname(OUT), `slot-${SLOT}-policy.js`)
      fs.writeFileSync(source, original
        // The policy copy lives in LAB_OUT, outside daemon/src.
        .replace(/require\((['"])\.\/src\/game-clock\1\)/g, () => `require(${JSON.stringify(path.join(__dirname, '..', '..', 'src', 'game-clock'))})`)
        .replace("const LOG = path.join(__dirname, 'campaign.log')", "const LOG = process.env.ND_CAMPAIGN_LOG || path.join(__dirname, 'campaign.log')")
        .replace(headingDecl, `let heading = ${result.heading}`))
    } else {
      const hash = crypto.createHash('sha256').update(fs.readFileSync(entry))
      const body = path.join(path.dirname(entry), 'campaign')
      for (const f of (fs.readdirSync(body, { recursive: true }) as string[]).filter(f => f.endsWith('.js')).sort()) hash.update(fs.readFileSync(path.join(body, f)))
      result.sourceSha256 = hash.digest('hex')
    }
    serverMark = fs.readFileSync(logFile, 'utf8').length
    t0 = gameClock.now()
    child = spawn(process.execPath, [source, 'food'], { cwd: path.join(__dirname, '..', '..'), windowsHide: true,
      env: { ...process.env, NODE_PATH: path.join(REPO_ROOT, 'daemon/node_modules'), ND_CAMPAIGN_LOG: liveLog, ND_HEADING: String(result.heading) },
      stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', b => { stdout += b.toString(); process.stdout.write(b) })
    child.stderr.on('data', b => { stderr += b.toString(); process.stderr.write(b) })
    result.exitCode = await new Promise<any>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', code => resolve(code))
      timer = gameClock.setTimeout(() => { result.timedOut = true; child.kill() }, BUDGET * 1000)
    })
    gameClock.clearTimeout(timer)
    result.seconds = Math.round((gameClock.now() - t0) / 1000)
    await conn.call('stop')
    const end = ((await conn.call('status')) || {} as Record<string, any>).state || {} as Record<string, any>
    result.food = stock(end)
    result.gainedFood = result.food - result.startFood
    result.hp = end.health
    result.arrowsSpent = KIT.includes('bow') ? 16 - Object.entries<any>(end.inventory || {} as Record<string, any>).reduce((n, [k, v]: any) => n + (/arrow$/.test(k) ? v : 0), 0) : 0
    result.shots = (stdout.match(/выстрелы: \d+/g) || [] as string[]).reduce((n: number, s: string) => n + Number(s.split(': ')[1]), 0)
    result.end = end.pos
    const lines = fs.readFileSync(logFile, 'utf8').slice(serverMark).split('\n')
      .filter(l => l.includes(`]: ${PLAYER} `) && !/issued server command|joined|left|lost connection|logged in/.test(l))
    result.causes = lines.filter(l => /was|died|burn|fell|lava|drown|blew|killed|slain|fireball|flames|withered|shot/.test(l))
      .map(l => l.replace(/^.*\]: /, '').trim())
    result.deaths = result.causes.length
    result.walks = (stdout.match(/\bgoto \{/g) || []).length
    result.fights = (stdout.match(/\bfight \{/g) || []).length
    result.surfaceCalls = (stdout.match(/\bsurface \{/g) || []).length
    result.falseArrivals = 0
    for (const line of stdout.split('\n')) {
      const m = /goto (\{.*?\}) → done .*?\((-?\d+),(-?\d+),(-?\d+)\)/.exec(line)
      if (!m) continue
      const p = JSON.parse(m[1])
      if (Math.hypot(+m[2] - p.x, +m[4] - p.z) > (p.range || 2) + 1.5) result.falseArrivals++
    }
    result.ok = result.food >= 8 && result.deaths === 0
    if (stderr.trim()) result.stderr = stderr.trim().slice(-1200)
  } catch (error) {
    result.error = error.stack || error.message
    result.seconds = t0 ? Math.round((gameClock.now() - t0) / 1000) : 0
  } finally {
    if (timer) gameClock.clearTimeout(timer)
    if (child && child.exitCode === null && !child.killed) child.kill()
    await conn.call('stop').catch(() => {})
    await conn.call('disconnect', { reason: 'лабораторная проверка окончена' }).catch(() => {})
    fs.appendFileSync(OUT, JSON.stringify(result) + '\n')
    console.log('РЕЗУЛЬТАТ:', JSON.stringify(result))
    conn.close()
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })
