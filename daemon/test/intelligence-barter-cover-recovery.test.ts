import test = require('node:test')
import assert = require('node:assert/strict')
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import { Vec3 } from 'vec3'
import { declSource } from './source-fixture'

const filename = require.resolve('../src/bastion/bastion')
const localRequire = createRequire(filename)
const source = () => fs.readFileSync(filename, 'utf8')
const pointKey = at => `${at.x},${at.y},${at.z}`

function coverFixture({ floor = 'blackstone', known = true, acknowledgeMove = true, denyFill = false } = {}) {
  const SL = localRequire('../sealed')
  const actual = new Map([['63,39,113', 'air'], ['63,40,113', 'air'], ['63,38,113', 'gravel'],
    ['63,39,112', 'air'], ['63,40,112', 'air'], ['63,38,112', floor]])
  let movements = 0
  const bot = {
    health: 20, game: { dimension: 'the_nether' },
    entity: { position: new Vec3(63.5, 39, 113.5), onGround: true },
    blockAt(at) {
      const name = actual.get(pointKey(at.floored())) ?? 'blackstone'
      if (name === 'unloaded') return null
      return { name, boundingBox: name === 'air' || name === 'lava' ? 'empty' : 'block', shapes: name === 'air' || name === 'lava' ? [] : [[0, 0, 0, 1, 1, 1]] }
    },
    clearControlStates() {}, pathfinder: { setGoal() {} }
  }
  const own = new Set(known ? ['63,39,113', '63,40,113', '63,39,112', '63,40,112'] : ['63,39,113', '63,40,113'])
  const session = { bot }
  const ctl = { aborted: false }
  const st = { sealedState: { own }, sealedDone: false }
  const require = name => name === '.././sealed' ? { ...SL, fillerCount: () => 20, async fillCell(_bot, at) {
    if (denyFill) return false
    actual.set(pointKey(at), 'blackstone')
    return true
  } } : name === '.././tunnel' ? { ownSet: () => own, rememberOwn() {} }
    : name === '.././navigation/parkour' ? { async executeJump(gotBot, gotCtl, target, options) {
      assert.equal(gotBot, bot); assert.equal(gotCtl, ctl); assert.equal(options.allowWalk, true)
      movements++
      if (acknowledgeMove) bot.entity.position = target
      return { ok: true }
    } } : localRequire(name)
  // sealBody — в bastion/defense.ts, prepareBarterCover — в bastion/barter-site.ts (рядом с bastion.ts: spec те же);
  // режим FAST_SAFE теперь goldMode.fastSafe (bastion/gold-mode.ts).
  const text = declSource(localRequire.resolve('./defense'), 'sealBody') + '\n' +
    declSource(localRequire.resolve('./barter-site'), 'prepareBarterCover')
  assert.ok(text.includes('async function sealBody(') && text.includes('async function prepareBarterCover('))
  const run = new Function('require', 'Vec3', 'worlds', 'fullCover', 'SIDES4', 'gameClock', 'goldMode', 'pocketOpen', 'log', 'xyz',
    text + '\nreturn prepareBarterCover;')(
    require, Vec3, { worldOf: () => 'the_nether' }, b => !!b && b.boundingBox === 'block',
    [[1, 0], [-1, 0], [0, 1], [0, -1]], { now: () => 0 }, { fastSafe: true }, () => true, () => {}, at => ({ x: at.x, y: at.y, z: at.z }))
  return { bot, st, movements: () => movements, run: () => run(session, ctl, st, 60000) }
}

test('barter moves off confirmed gravel into a known native firm cell before sealing its cover', async () => {
  const f = coverFixture()
  const result = await f.run()
  assert.equal(result.ok, true)
  assert.equal(f.movements(), 1)
  assert.deepEqual(f.bot.entity.position.floored(), new Vec3(63, 39, 112))
  assert.equal(f.st.sealedDone, true)
})

test('unknown or hazardous support, an unconfirmed movement, and rejected walls never assert barter cover', async () => {
  for (const options of [{ floor: 'gravel' }, { floor: 'lava' }, { floor: 'unloaded' }, { known: false },
    { acknowledgeMove: false }, { denyFill: true }]) {
    const f = coverFixture(options)
    assert.equal((await f.run()).ok, false, JSON.stringify(options))
    assert.equal(f.st.sealedDone, false)
    if ('floor' in options || 'known' in options) assert.equal(f.movements(), 0)
  }
})

test('remote carried-gold barter physically approaches the known site before checking its actual cover', async () => {
  const text = source()
  const begin = text.slice(text.indexOf('const memoSave =')).search(/if \(mode === ["']barter["'] && st\.sealed\) \{/)
    + text.indexOf('const memoSave =')
  const end = text.indexOf('const done =', begin)
  assert.ok(begin > 0 && end > begin)
  for (const reached of [true, false]) {
    const bot = { entity: { position: new Vec3(2.5, 63, 4.5) } }
    const session = { bot }
    const ctl = { aborted: false }
    const rec = { x: 87, y: 35, z: 139 }
    const st = { sealed: true, sealedState: null as null | { own: Set<string>; fails: unknown[]; exposed: boolean },
      blocks: 0, bribed: 0, traded: 0, chests: [], gained: {}, gold: new Map(), pred: new Map(), fights: [], tossed: [] }
    let routes = 0, covers = 0
    const require = name => name === '.././nether-route' ? {
      enabled: () => true, gridOf: () => ({}), async routeTo(gotSession, gotCtl, params) {
        assert.equal(gotSession, session); assert.equal(gotCtl, ctl)
        assert.ok(params.timeoutSeconds <= 540 - 180, 'the route preserves setup and receipt budget')
        routes++
        bot.entity.position = new Vec3(reached ? 80.5 : 40.5, 39, reached ? 130.5 : 60.5)
        return { ok: reached, steps: 42, own: new Set(['40,39,60', '40,40,60']), why: reached ? undefined : 'budget' }
      }
    } : name === '.././tunnel' ? { rememberOwn() {} } : localRequire(name)
    const outBegin = text.indexOf('const out = (')
    const outEnd = text.indexOf('if (worlds.worldOf(bot)', outBegin)
    assert.ok(outBegin > 0 && outEnd > outBegin)
    const out = new Function('st', 'mode', 'bot', 'p', 't0', 'gameClock', 'BF', 'countOf', 'fireRes', 'Vec3',
      text.slice(outBegin, outEnd) + '\nreturn out;')(
      st, 'barter', bot, {}, 0, { now: () => 0 }, { enabled: () => true }, () => 0, () => 0, Vec3)
    const run = new Function('mode', 'st', 'rec', 'bot', 'session', 'ctl', 'deadline', 'gameClock', 'Vec3', 'require', 'lavaWatched',
      'prepareBarterCover', 'memoSave', 'log', 'out', `return (async () => { ${text.slice(begin, end)} return { reached: true }; })();`)
    const result = await run('barter', st, rec, bot, session, ctl, 540000, { now: () => 0 }, Vec3, require,
      async (_bot, _ctl, action) => action(ctl), async () => { covers++; return { ok: true } }, () => {}, () => {}, out)
    assert.equal(routes, 1)
    assert.equal(covers, reached ? 1 : 0)
    assert.equal(st.sealedState?.own.has('40,39,60'), true, 'a real partial route preserves its actual own cells')
    if (!reached) {
      assert.equal(result.barterRetry, 'budget')
      assert.deepEqual(result.sealed.fails, [], 'the actual report retains a valid native state contract')
      assert.equal(result.sealed.exposed, true, 'a partial route never claims a protected cover')
    }
  }
})

test('s1c: no protected cover near the site — carried gold is bartered in the open when the risk is low, never with low hp', async () => {
  const text = source()
  const begin = text.slice(text.indexOf('const memoSave =')).search(/if \(mode === ["']barter["'] && st\.sealed\) \{/)
    + text.indexOf('const memoSave =')
  const end = text.indexOf('const done =', begin)
  for (const hp of [20, 10]) {
    const bot = { health: hp, entity: { position: new Vec3(80.5, 39, 130.5) } }
    const st: any = { sealed: true, sealedState: null, blocks: 0, bribed: 0, traded: 0, chests: [], gained: {}, gold: new Map(), pred: new Map(), fights: [], tossed: [] }
    let rounds = 0
    const out = (stopped = null) => ({ stopped })
    const run = new Function('mode', 'st', 'rec', 'bot', 'session', 'ctl', 'deadline', 'gameClock', 'Vec3', 'require', 'lavaWatched',
      'prepareBarterCover', 'memoSave', 'log', 'out', 'countOf', 'keep', 'goldWorn', 'mobs', 'isBaby', 'unpackGold', 'barterRound',
      `return (async () => { ${text.slice(begin, end)} return { reached: true }; })();`)
    const result = await run('barter', st, { x: 87, y: 35, z: 139 }, bot, { bot }, { aborted: false }, 540000, { now: () => 0 }, Vec3, localRequire,
      async (_b, _c, action) => action({ aborted: false }), async () => ({ ok: false, why: 'стены не замкнуты' }), () => {}, () => {}, out,
      (_b, name) => name === 'gold_ingot' ? 20 : 0, 0, () => true, (_b, name) => name === 'piglin' ? [{ id: 5 }] : [], () => false,
      async () => {}, async () => { rounds++; return { spent: 20, pearls: 2 } })
    if (hp === 20) {
      assert.equal(rounds, 1)
      assert.deepEqual(result.openBarter, { spent: 20, pearls: 2 })
    } else {
      assert.equal(rounds, 0, 'low hp keeps the old refusal')
      assert.match(String(result.stopped), /укрытие для бартера не подтверждено/)
    }
  }
})
