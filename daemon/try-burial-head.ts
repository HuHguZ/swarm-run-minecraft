// Separate farm fixture: no campaign, no map knowledge, a new player and a labelled artificial burial.
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import assert from 'node:assert/strict'
const slot = Number(process.env.FARM_SLOT)
assert.equal(slot, 24, 'this death replay is explicitly scoped to farm slot24')
const root = path.resolve(__dirname, '..')
const source = path.resolve(root, process.env.BURIAL_SOURCE || 'daemon')
const output = path.resolve(root, process.env.BURIAL_OUTPUT || 'codex-lab/burial-native-new.json')
const expected = process.env.EXPECT || 'new'
assert.ok(expected === 'old' || expected === 'new', 'explicit old/new result classification')
process.env.ND_SKILLS_LOG = output.replace(/\.json$/, '.skills.jsonl')
process.env.ND_TICK_RATE = '750'; process.env.ND_CLOCK = 'game'; process.env.ND_KNOWLEDGE = 'rsg'
const farmSource = fs.readFileSync(path.join(root, 'farm/farm.js'), 'utf8')
const rcon = new Function('net', `return ${farmSource.slice(farmSource.indexOf('function rcon('), farmSource.indexOf('function slotRcon('))}`)(net)
const properties = fs.readFileSync(path.join(root, 'farm/server-24/server.properties'), 'utf8')
const password = /^rcon.password=(.*)$/m.exec(properties)?.[1]?.trim()
assert.ok(password, 'farm RCON configuration must exist')
const command = (text: string) => rcon(25724, password, text)
const { Session } = require(path.join(source, 'src/session'))
const { EventBus } = require(path.join(source, 'src/events'))
const { Journal } = require(path.join(source, 'src/journal'))
const { Autopilot } = require(path.join(source, 'src/autopilot'))
const clock = require(path.join(source, 'src/game-clock'))
const bus = new EventBus()
const journal = new Journal(output.replace(/\.json$/, '.memory'))
const player = 'NeuroFarm24Head'
const cfg = { host: '127.0.0.1', port: 25624, username: player, version: '1.21.11', auth: 'offline', fairPlay: true,
  eatBelowFood: 16, lowHealth: 8 }
const session = new Session(cfg, bus, journal)
session.autopilot = new Autopilot(session, cfg)
const wallSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const events: any[] = []
const emit = bus.emit.bind(bus)
bus.emit = (type, detail) => { events.push({ type, game: clock.now(), ...detail }); return emit(type, detail) }
const reports: any[] = []
const edgeCase = process.env.BURIAL_CASE !== 'upper'
async function main() {
  await command(`op ${player}`)
  try {
    await session.connect()
    await command(`gamemode creative ${player}`)
    const bot = session.bot
    await command(`tp ${player} 240.5 100 240.5`)
    await bot.waitForChunksToLoad()
    await command('fill 237 98 237 243 105 243 minecraft:stone')
    await command('fill 240 100 240 240 104 240 minecraft:air')
    if (edgeCase) {
      await command('setblock 241 101 240 minecraft:gravel')
    } else {
      await command('setblock 240 100 240 minecraft:cobblestone_slab[type=bottom]')
      await command('setblock 240 102 240 minecraft:stone')
    }
    await command(`give ${player} minecraft:stone_pickaxe`)
    await command(`effect give ${player} minecraft:saturation 1 5 true`)
    await command(`effect give ${player} minecraft:instant_health 1 5 true`)
    await command(`tp ${player} ${edgeCase ? '240.9 100' : '240.5 100.5'} 240.5`)
    await wallSleep(120)
    const at = bot.entity.position.clone(), mark = events.length, started = clock.now()
    assert.ok(Math.abs(at.x - (edgeCase ? 240.9 : 240.5)) < .05 &&
      Math.abs(at.y - (edgeCase ? 100 : 100.5)) < .05 && Math.abs(at.z - 240.5) < .05, 'native body is at the requested test geometry')
    assert.equal(bot.blockAt(at.offset(0, 1.2, 0))?.name, 'air', 'the old centre probe must actually miss this fixture')
    assert.ok(bot.inventory.items().some(item => item.name === 'stone_pickaxe'), 'native inventory confirms escape tool')
    if (edgeCase) assert.equal(bot.blockAt(at.offset(.2, 1.62, 0))?.name, 'gravel', 'native client confirms the touching gravel')
    let deaths = 0, minimum = bot.health
    const snapshots: any[] = []
    bot.on('death', () => deaths++)
    const sample = () => {
      minimum = Math.min(minimum, bot.health)
      const pos = bot.entity.position.clone(), eye = require(path.join(source, 'src/pick')).eyeOf(bot)
      const buried = session.autopilot.buriedBy(bot)
      snapshots.push({ game: clock.now() - started, hp: bot.health, pos, eye,
        sample: bot.blockAt(pos.offset(0, 1.2, 0))?.name, eyeBlock: bot.blockAt(eye)?.name,
        buried: buried?.name ?? null, owner: require(path.join(source, 'src/reflex-lock')).owner(session)?.source })
    }
    bot._client.on('damage_event', sample)
    await command(`gamemode survival ${player}`)
    for (const until = Date.now() + 2000; Date.now() < until && !deaths;) { sample(); await wallSleep(10) }
    const report = { label: edgeCase ? 'artificial gravel at eye-footprint cell edge' : 'artificial stone eye-height burial on half slab', source, at, hp: bot.health, minimum, deaths,
      events: events.slice(mark), snapshots, state: session.state(), clock: clock.snapshot() }
    reports.push(report)
    console.log(JSON.stringify({ fixture: report.label, hp: report.hp, minimum, deaths,
      buried: report.events.filter(e => e.type === 'buried').length, freed: report.events.filter(e => e.type === 'freed'),
      first: snapshots[0], last: snapshots.at(-1) }))
    assert.equal(report.clock?.tickRate, 750, 'native game clock must follow configured farm rate')
    if (edgeCase && expected === 'old') {
      assert.equal(deaths, 1, 'old geometry must reproduce fatal missing rescue')
      assert.equal(report.events.filter(e => e.type === 'buried').length, 0)
    } else {
      assert.equal(deaths, 0, 'new rescue and safe low-ceiling control must survive')
      assert.ok(bot.health >= 18, 'escape preserves health before ordinary healing')
      if (edgeCase) assert.ok(report.events.some(e => e.type === 'freed' && e.dug > 0), 'visible obstruction was actually excavated')
      else assert.equal(report.events.filter(e => e.type === 'buried').length, 0, 'server crouching under a low ceiling is not burial')
    }
  } finally {
    try { session.autopilot.stop(); session.tactics.detach(); await session.disconnect({ reason: 'separate burial fixture complete' }) } catch {}
    try { await command(`deop ${player}`) } catch {}
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, JSON.stringify(reports, null, 2))
  }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1) })
