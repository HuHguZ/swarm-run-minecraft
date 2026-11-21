import test from 'node:test'
import assert from 'node:assert/strict'
import { createSwarmDriver } from './swarm/swarm-driver'
import { Block, block } from '../daemon/test/tick-plugins-fixture'
import { chestTake } from '../daemon/src/containers/chest'
import { base as nativeBase, scene as nativeScene } from '../daemon/test/swarm-chest-lid-fixture'
import * as gameClock from '../daemon/src/game-clock'

// Staged match Q, repeat-upper-1794575455441: default autonomous blue and the
// chest/poses at +1456 ms. Only the observer's window, body and vision are inputs.
const chest = { x: 664, y: 150, z: 578 }
const guard = { x: 664.53, y: 150.5, z: 579.56 }
const foe = { x: 665.5, y: 150.5, z: 581.14 }
async function replay(items = ['netherite_helmet'], nativeWork?: (p) => Promise<any>, read?: (p) => Promise<any>, chests = () => [chest]) {
  let now = 1000
  const calls = [], pos: any = {}, opened = { count: 0 }
  const bot: any = { name: 'Y', team: 'blue', c: { async call(method, p) {
    calls.push({ method, p })
    if (method === 'blocks_around') return { detail: { found: chests() } }
    if (method === 'chest_take') { opened.count++; if (read) { try { const r = await read(p); return r.status ? r : { status: 'interrupted', detail: r } } catch { return { status: 'failed' } } } return { status: 'interrupted', partial: true, detail: { at: chest, full: true, contents: Object.fromEntries(items.map(n => [n, 1])), took: {} } } }
    if (method === 'swarm_work') return { status: 'done', detail: nativeWork && p.chestLid ? await nativeWork(p) : { ok: true, done: true, kind: p.kind, at: p.at, after: p.kind === 'place' ? p.item : 'air' } }
    return { status: 'done', detail: {} }
  } } }
  pos.Y = { p: { ...guard }, hp: 20, inv: { cobblestone: 64, iron_sword: 1, stone_pickaxe: 1 }, armor: { torso: 'diamond_chestplate' } }
  const ally: any = { name: 'Ally', team: 'blue', c: bot.c }
  pos.Ally = { ...pos.Y, p: { ...guard, x: 620 } }
  const driver = createSwarmDriver({ bots: [bot, ally], arms: true, pos, now: () => now, hostile: (_, id) => id === 'V' || id === 'W',
    home: () => guard, alive: () => true, arena: { x: 600.5, y: 120, z: 600.5, r: 85, killY: 111 }, chestTops: [{ ...chest, tier: 5 }], log() {} })
  await driver.turn(bot)
  assert.equal(opened.count, 1, 'the bot learns the remainder through a real driver chest_take')
  now += 6957
  const sight = (extra: any = {}) => driver.observe(bot, [{ id: 'V', position: foe, velocity: { x: 0, y: 0, z: -.22 }, visible: true, equipment: { weapon: 'stone_axe', armor: [] }, ...extra }])
  const work = () => calls.filter(c => c.method === 'swarm_work' && c.p.chestLid)
  return { calls, driver, bot, ally, pos, sight, work, advance: (n: number) => { now += n }, turn: () => driver.turn(bot) }
}
test('Q guard caps a contested valuable chest once and an ally reopens it once danger clears', async () => {
  const f = await replay()
  f.sight(); await f.turn(); await f.turn()
  assert.deepEqual(f.work().map(w => [w.p.kind, w.p.item, w.p.at]), [['place', 'cobblestone', { ...chest, y: 151 }]])
  f.advance(11000); f.pos.Ally.p = guard
  await f.driver.turn(f.ally)
  assert.deepEqual(f.work().map(w => w.p.kind), ['place', 'dig'])
})

test('after uncovering Q stock the ally recovers the helmet in that turn, from the protected window', async () => {
  const native = nativeScene(), reader = native.bot, logs = []
  const other = { ...chest, z: chest.z + 3 }
  let surveyed = [chest], stored = 1, carried = 0, first = true
  try {
    reader.openContainer = async () => reader.currentWindow = {
      inventoryStart: 27, inventoryEnd: 63, slots: Array(63).fill(null),
      containerItems: () => stored ? [{ name: 'netherite_helmet', count: stored }] : [],
      containerCount: () => stored, count: () => carried,
      withdraw: async (_type, _metadata, n) => { stored -= n; carried += n },
      close: () => { reader.currentWindow = null }
    }
    const read = async p => {
      assert.deepEqual({ x: p.x, y: p.y, z: p.z }, chest)
      const receipt = await chestTake({ bot: reader, mcData: reader.registry }, { aborted: false, onAbort: [] }, { ...p, ...(first && { count: 0 }) })
      logs.push(receipt)
      if (first) { first = false; return receipt }
      return { status: 'done', detail: receipt }
    }
    const work = async p => {
      if (p.kind === 'dig') {
        delete reader.entities[2]; delete reader.players.V
        reader.canDigBlock = () => true
        reader.entity.onGround = true
        reader.dig = async target => {
          const air = block('air', target.position)
          native.cells.set(target.position.toString(), air)
          reader._client.emit('block_change', { location: target.position, type: air.stateId })
        }
      }
      return native.call(p)
    }
    const f = await replay(undefined, work, read, () => surveyed)
    f.sight(); await f.turn()
    f.pos.Ally.p = guard; surveyed = [other, chest]; f.advance(11000)
    await f.driver.turn(f.ally)
    assert.deepEqual(f.work().map(c => c.p.kind), ['place', 'dig'])
    assert.equal(carried, 1, 'another player can open the chest before the next scheduled turn')
    assert.equal(stored, 0)
    assert.deepEqual(logs.at(-1).took, { netherite_helmet: 1 })
  } finally { reader.emit('end') }
})

test('only a still safe and owned return continues from lid removal into the protected window', async () => {
  for (const mode of ['visible rival', 'hidden rival', 'rescue', 'cancelled', 'refilled', 'changed cover']) {
    let afterDig = () => {}
    const f = await replay(undefined, async p => {
      if (p.kind === 'dig') {
        afterDig()
        if (mode === 'changed cover') return { ok: false, why: 'lid_changed' }
      }
      return { ok: true, done: true, at: p.at, after: p.kind === 'dig' ? 'air' : p.item }
    })
    f.sight(); await f.turn()
    f.advance(11000); f.pos.Ally.p = guard
    afterDig = () => {
      if (mode.endsWith('rival')) f.driver.observe(f.ally, [{ id: 'V', position: foe, visible: mode === 'visible rival' }])
      if (mode === 'rescue') f.pos.Ally.rescuing = true
      if (mode === 'cancelled') f.ally.swarmTurnOwner.cancelled = true
      if (mode === 'refilled') f.driver.refill(chest)
    }
    await f.driver.turn(f.ally)
    const after = f.calls.slice(f.calls.findIndex(c => c.method === 'swarm_work' && c.p.kind === 'dig') + 1)
    if (mode === 'changed cover') {
      assert.ok(after.findIndex(c => c.method === 'blocks_around') >= 0)
      assert.ok(after.findIndex(c => c.method === 'chest_take') > after.findIndex(c => c.method === 'blocks_around'), 'ordinary loot can inspect the newly exposed chest')
    } else assert.equal(after.some(c => c.method === 'chest_take'), mode === 'hidden rival', mode)
  }
})

test('a returning ally keeps both double chest claims until its transfer receipt', async () => {
  const partner = { ...chest, x: chest.x + 1 }, stock = { netherite_chestplate: 2 }
  let reads = 0, release, entered
  const inWindow = new Promise(resolve => { entered = resolve })
  const pending = new Promise(resolve => { release = resolve })
  const f = await replay(undefined, undefined, async () => {
    if (++reads === 1) return { at: chest, chestPartner: partner, chestSlots: 54, full: true, contents: stock, took: {} }
    entered()
    await pending
    return { status: 'done', detail: { at: chest, chestPartner: partner, chestSlots: 54, contents: {}, took: stock } }
  })
  f.sight(); await f.turn()
  f.advance(11000); f.pos.Ally.p = guard
  const returning = f.driver.turn(f.ally)
  try {
    await Promise.race([inWindow, returning])
    const owners = f.driver.snapshot().blue.tasks.filter(t => t.id.startsWith('chest:') && t.claim).map(t => t.claim.owner)
    assert.deepEqual(owners, ['Ally', 'Ally'])
    await f.turn()
    assert.equal(reads, 2, 'the opposite half does not admit another picker')
  } finally { release(); await returning }
  assert.equal(f.driver.snapshot().blue.tasks.some(t => t.id.startsWith('chest:') && t.claim), false)
})

test('a formerly valuable protected chest may be empty on return', async () => {
  let reads = 0
  const f = await replay(undefined, undefined, async () => ++reads === 1
    ? { at: chest, full: true, contents: { netherite_helmet: 1 }, took: {} }
    : { status: 'done', detail: { at: chest, contents: {}, took: {} } })
  f.sight(); await f.turn()
  f.advance(11000); f.pos.Ally.p = guard
  const before = f.calls.length
  await f.driver.turn(f.ally)
  assert.equal(reads, 2)
  assert.equal(f.calls.slice(before).some(c => c.method === 'armor'), false, 'no transfer was observed')
  await f.driver.turn(f.ally)
  assert.equal(reads, 2, 'the inspected empty window supersedes the old helmet report')
})

test('a second guard can protect the scout’s reported stock when the guard sees the approaching rival', async () => {
  for (const mode of ['fresh', 'radio-only', 'expired', 'refilled', 'scout-looting']) {
    const native = nativeScene()
    try {
      const f = await replay(undefined, native.call)
      f.pos.Y.p = { ...guard, x: 620 }
      f.pos.Ally.p = guard
      if (mode === 'expired') f.advance(45001)
      if (mode === 'refilled') f.driver.refill(chest)
      if (mode === 'scout-looting') f.bot.last = { m: 'chest_take', pending: true, p: chest }
      f.driver.observe(mode === 'radio-only' ? f.bot : f.ally, [
        { id: 'V', position: foe, velocity: { x: 0, y: 0, z: -.22 }, visible: true, equipment: { weapon: 'stone_axe', armor: [] } }
      ])
      await f.driver.turn(f.ally)
      assert.equal(native.bot.packets.filter(p => p.name === 'block_place').length, mode === 'fresh' ? 1 : 0, mode)
    } finally { native.bot.emit('end') }
  }
})

test('Q interrupted window and real relative movement reach a crouched placement through driver.turn and swarm_work', async t => {
  const native = nativeScene()
  let sensorTime = 100000; t.mock.method(gameClock, 'now', () => sensorTime)
  try {
    const f = await replay(undefined, native.call)
    for (const dz of [4096, -2048, -2048]) {
      sensorTime += 250; f.advance(250)
      const own = native.sightAfterMove(dz)
      f.driver.observe(f.bot, own)
    }
    assert.equal(native.rival.velocity.norm(), 0, 'normal client position updates do not populate the entity velocity')
    f.advance(1); f.driver.observe(f.ally, [{ id: 'V', position: foe, visible: true }])
    await f.turn(); await f.turn()
    assert.equal(native.bot.packets.filter(p => p.name === 'block_place').length, 1)
    assert.deepEqual(f.work().map(w => w.p.kind), ['place'])
    assert.equal(native.bot.blockAt(native.rival.position.floored().offset(-1, 1, -3)).name, 'cobblestone')
  } finally { native.bot.emit('end') }
})
test('late confirmation after the guard lost its turn still lets the team remove its block', async () => {
  let sent, ack
  const started = new Promise<void>(resolve => { sent = resolve })
  const f = await replay(undefined, async p => {
    if (p.kind === 'place') { sent(); await new Promise(resolve => { ack = resolve }) }
    return { kind: p.kind, at: p.at, after: p.kind === 'place' ? p.item : 'air', ok: true, done: true }
  })
  f.sight(); const running = f.turn(); await started
  f.bot.swarmTurnOwner.cancelled = true; f.driver.release(f.bot)
  f.advance(11000); f.pos.Ally.p = guard
  await f.driver.turn(f.ally)
  assert.deepEqual(f.work().map(w => w.p.kind), ['place'])
  ack(); await running; await f.driver.turn(f.ally)
  assert.deepEqual(f.work().map(w => w.p.kind), ['place', 'dig'])
})

for (const paired of [false, true]) test(`concurrent guards cap ${paired ? 'one shared double window' : 'two independently threatened chests'}`, async () => {
  const other = { ...chest, x: chest.x + (paired ? 1 : 4) }
  let inspected = chest
  let confirm: () => void
  let held = new Promise<void>(resolve => { confirm = resolve })
  let sent: () => void
  let started = new Promise<void>(resolve => { sent = resolve })
  const f = await replay(undefined, async p => {
    if (p.at.x === chest.x) { sent(); await held }
    return { at: p.at, after: p.kind === 'dig' ? 'air' : p.item, ok: true, done: true }
  }, async p => ({ at: { x: p.x, y: p.y, z: p.z }, chestSlots: paired ? 54 : 27,
    ...(paired ? { chestPartner: other } : {}), contents: { netherite_helmet: 1 }, full: true, took: {} }), () => [inspected])
  if (!paired) {
    inspected = other
    f.pos.Ally.p = { ...guard, x: other.x + .3 }
    await f.driver.turn(f.ally)
    assert.ok(f.calls.some(c => c.method === 'chest_take' && c.p.x === other.x), 'the second stock was inspected')
  }
  f.pos.Ally.p = { ...guard, x: 620 }
  f.sight({ position: { ...foe, x: chest.x - .5 } })
  const first = f.turn()
  try {
    await Promise.race([started, first])
    assert.equal(f.work().length, 1)
    if (paired) f.advance(3001) // The board lease expires while the body still awaits its placement receipt.
    f.pos.Ally.p = { ...guard, x: paired ? other.x + .5 : other.x - .5 }
    f.driver.observe(f.ally, [{ id: 'W', position: { ...foe, x: other.x + 1.5 }, velocity: { x: 0, y: 0, z: -.22 },
      visible: true, equipment: { weapon: 'stone_axe', armor: [] } }])
    await f.driver.turn(f.ally)
    assert.deepEqual(f.work().map(c => [c.p.at.x, c.p.rival.id]), paired ? [[chest.x, 'V']] : [[chest.x, 'V'], [other.x, 'W']])
  } finally { confirm(); await first }
  if (!paired) {
    f.advance(11000)
    held = new Promise<void>(resolve => { confirm = resolve })
    started = new Promise<void>(resolve => { sent = resolve })
    const open = f.turn()
    try {
      await Promise.race([started, open])
      await f.driver.turn(f.ally)
      assert.deepEqual(f.work().filter(c => c.p.kind === 'dig').map(c => c.p.at.x), [chest.x, other.x])
    } finally { confirm(); await open }
  }
})

for (const target of ['other', 'this', 'generic', 'opening elsewhere']) test(`a closer allied looter assigned to ${target} chest`, async () => {
  const f = await replay()
  f.pos.Ally.p = { ...guard, x: chest.x + 1, z: chest.z + 1 }
  f.ally.swarmTask = { kind: 'loot', position: { ...chest, x: target === 'other' ? 670 : chest.x },
    data: target === 'generic' ? { improvement: 1 } : { lootTier: 5, lootSeconds: 10 } }
  if (target === 'opening elsewhere') f.ally.last = { m: 'chest_take', pending: true, p: { ...chest, x: chest.x + 2 } }
  f.sight(); await f.turn()
  assert.equal(f.work().length, target === 'this' ? 0 : 1)
})

test('each guard remembers its own blocked lid and rechecks it when the placement window renews', async () => {
  let clear = false
  const f = await replay(undefined, async p => clear ? { ok: true, done: true, at: p.at, after: p.item } : { ok: false, why: 'lid_unavailable' })
  const far = { ...guard, x: 620 }
  const act = async (who, other) => {
    f.pos[who.name].p = guard
    f.pos[other.name].p = far
    f.driver.observe(who, [{ id: 'V', position: foe, velocity: { x: 0, y: 0, z: -.22 }, visible: true, equipment: { weapon: 'stone_axe', armor: [] } }])
    await f.driver.turn(who)
  }
  await act(f.bot, f.ally)
  await act(f.ally, f.bot)
  assert.equal(f.work().length, 2)
  await act(f.bot, f.ally)
  assert.equal(f.work().length, 2, 'another guard’s refusal must not erase ours')
  clear = true
  f.advance(1001)
  await act(f.bot, f.ally)
  await act(f.bot, f.ally)
  assert.equal(f.work().length, 3, 'a cleared opening admits one new placement')
})
test('Q guard preserves uninspected, empty, low-value, reserved and uncontested loot and personal escape', async () => {
  for (const mode of ['empty', 'cheap', 'refill', 'hidden', 'far', 'stopped', 'leaving', 'ally', 'rescue', 'arrow', 'noBlock']) {
    const f = await replay(mode === 'empty' ? [] : mode === 'cheap' ? ['dirt'] : undefined)
    if (mode === 'refill') f.driver.refill(chest)
    if (mode === 'ally') f.ally.last = { m: 'chest_take', pending: true, p: chest }
    if (mode === 'rescue') f.pos.Y.rescuing = true
    if (mode === 'arrow') f.bot.arrowThreat = { at: 7957, active: true }
    if (mode === 'noBlock') f.pos.Y.inv = { iron_sword: 1, glass: 10 }
    f.sight(mode === 'hidden' ? { visible: false, nametag: true } : mode === 'far' ? { position: { ...foe, x: 683 } } :
      mode === 'stopped' || mode === 'leaving' ? { velocity: { x: 0, y: 0, z: mode === 'stopped' ? 0 : .22 } } : {})
    await f.turn(); assert.equal(f.work().length, 0, mode)
  }
})

test('two guards share a double chest window, both leases and one physical cover', async () => {
  const pair = nativeBase.offset(1, 0, 0), partner = { x: pair.x, y: pair.y, z: pair.z }
  const stock = { netherite_helmet: 1 }
  for (const mode of ['place', 'opposite looter', 'opposite opening', 'opposite restock', 'round reset', 'refusal', 'split', 'repaired', 'foreign']) {
    const native = nativeScene(), scout = nativeScene(native.cells), b = native.bot
    let nearest = chest
    try {
      for (const [at, side] of [[nativeBase, 'left'], [pair, 'right']] as const) {
        const half = Block.fromProperties('chest', { type: side, facing: 'north', waterlogged: 'false' }, 0)
        half.position = at; native.cells.set(at.toString(), half)
      }
      const read = async p => {
        const reader = scout.bot
        reader.openContainer = async () => reader.currentWindow = {
          inventoryStart: 54, containerItems: () => [{ name: 'netherite_helmet', count: 1 }], close: () => { reader.currentWindow = null }
        }
        return chestTake({ bot: reader, mcData: reader.registry }, { aborted: false, onAbort: [] }, { ...p, count: 0 })
      }
      let pending, settle
      const entered = new Promise<void>(resolve => { pending = resolve })
      const work = async p => {
        if (p.kind === 'dig') {
          const digger = scout.bot
          delete digger.entities[2]; delete digger.players.V
          digger.canDigBlock = () => true
          digger.entity.onGround = true
          digger.dig = async target => {
            const air = block('air', target.position)
            native.cells.set(target.position.toString(), air)
            digger._client.emit('block_change', { location: target.position, type: air.stateId })
          }
          return scout.call(p)
        }
        pending()
        if (mode === 'place' || mode === 'round reset' || mode === 'refusal') await new Promise(resolve => { settle = resolve })
        return mode === 'refusal' ? { ok: false, why: 'lid_unavailable' } : native.call(p)
      }
      const f = await replay(Object.keys(stock), work, read, () => [nearest])
      f.pos.Y.p = { ...guard, x: 620 }; f.pos.Ally.p = guard
      const see = () => f.driver.observe(f.ally, [{ id: 'V', position: foe, velocity: { x: 0, y: 0, z: -.22 }, visible: true, equipment: { weapon: 'stone_axe', armor: [] } }])
      if (mode === 'foreign') {
        const top = nativeBase.offset(0, 1, 0); native.cells.set(top.toString(), block('stone', top))
      }
      if (mode === 'opposite looter') f.bot.last = { m: 'chest_take', pending: true, p: { at: partner } }
      if (mode === 'opposite restock') f.driver.refill(partner)
      if (mode === 'opposite opening') b._client.emit('block_action', { location: pair, blockId: b.blockAt(pair).type, byte1: 1, byte2: 1 })
      see()
      const turn = f.driver.turn(f.ally)
      const keys = [chest, partner].map(p => 'chest:' + [p.x, p.y, p.z].join(','))
      const owners = () => (f.driver.snapshot().blue?.tasks || []).filter(t => keys.includes(t.id) && t.claim).map(t => [t.id, t.claim.owner]).sort()
      if (mode === 'place' || mode === 'round reset' || mode === 'refusal') {
        await Promise.race([entered, turn])
        assert.deepEqual(owners(), keys.map(key => [key, 'Ally']), mode)
        if (mode === 'round reset') f.driver.reset()
        settle()
      }
      await turn
      assert.deepEqual(owners(), [], mode)
      const placed = ['place', 'round reset', 'split', 'repaired'].includes(mode)
      assert.equal(b.packets.filter(p => p.name === 'block_place').length, Number(placed), mode)
      if (mode === 'place') {
        f.driver.refill(partner)
        nearest = partner
        f.advance(11000); f.pos.Y.p = { ...guard, x: partner.x + .8 }
        await f.driver.turn(f.bot)
        const dig = f.work().filter(c => c.p.kind === 'dig')
        assert.equal(dig.length, 1)
        assert.deepEqual(dig[0].p.at, { ...chest, y: chest.y + 1 })
        assert.deepEqual(dig[0].p.chestPartner, partner)
        assert.equal(native.cells.get(nativeBase.offset(0, 1, 0).toString()).name, 'air', 'owner mined the exact cover, with a native receipt')
        const reopened = await read({ ...partner, item: 'all', visibleOnly: true, stay: true })
        assert.deepEqual(reopened.at, partner); assert.deepEqual(reopened.contents, stock)
        await f.driver.turn(f.ally)
        assert.equal(f.work().filter(c => c.p.kind === 'dig').length, 1)
      }
      if (mode === 'split' || mode === 'repaired') {
        const west = nativeBase.offset(-1, 0, 0)
        for (const [at, side] of [[nativeBase, mode === 'split' ? 'single' : 'right'], [pair, 'single'], [west, 'left']] as const) {
          const half = Block.fromProperties('chest', { type: side, facing: 'north', waterlogged: 'false' }, 0)
          half.position = at; native.cells.set(at.toString(), half)
        }
        f.advance(11000); f.pos.Y.p = { x: 664, y: 150.5, z: 580.25 }; scout.bot.entity.position.set(664,150.5,580.25)
        await f.driver.turn(f.bot); await f.driver.turn(f.bot); await f.driver.turn(f.bot)
        const attempts = f.work().filter(c => c.p.kind === 'dig').map(c => c.p)
        assert.equal(attempts.length, 2, mode)
        assert.deepEqual(attempts[0].chestPartner, partner)
        assert.deepEqual(attempts[1].chestPartner, mode === 'split' ? undefined : { x: west.x, y: west.y, z: west.z })
        assert.equal(native.cells.get(nativeBase.offset(0, 1, 0).toString()).name, 'air')
      }
      if (mode === 'foreign') {
        await f.driver.turn(f.ally)
        f.advance(11000); await f.driver.turn(f.bot)
        assert.equal(f.work().filter(c => c.p.kind === 'dig').length, 0)
        assert.equal(native.cells.get(nativeBase.offset(0, 1, 0).toString()).name, 'stone')
      }
      if (mode === 'round reset') {
        f.advance(11000); await f.driver.turn(f.ally)
        assert.equal(f.work().filter(c => c.p.kind === 'dig').length, 0)
      }
    } finally { native.bot.emit('end'); scout.bot.emit('end') }
  }
})
