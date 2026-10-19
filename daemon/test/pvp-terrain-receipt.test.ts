import test from 'node:test'
import assert from 'node:assert/strict'
import { createTerrain } from '../src/pvp/terrain'
const Vec3: typeof import('vec3').Vec3 = require('vec3')

function fixture() {
  let now = 0
  const notes: string[] = [], controls: Array<[string, boolean]> = [], cuts: string[] = []
  const blocks = new Set<string>()
  const held: Record<string, boolean> = {}
  let stepped = false
  const key = p => `${p.x},${p.y},${p.z}`
  const ctx: Record<string, any> = {
    bot: { entity: { position: new Vec3(.5, 118, .5) }, async lookAt() {} },
    entity: { position: new Vec3(5, 120, .5) }, ctl: { aborted: false }, st: { blocks: 7 },
    PILLAR_MS: 500, TICK_MS: 50, gameClock: { now: () => now }, simulateSteps: true,
    pickFiller: () => ({ name: 'cobblestone' }), countOf: () => 32, headroom: () => true,
    pathTo() {}, clear() {}, noteBuild() {}, buildGuard: () => ({}), guardCtl: () => ctx.ctl,
    buildDone: () => false, towerShield() {}, async holdWeapon() {}, used: (s: string) => notes.push(s),
    async towerUp() { return { ok: false, placed: 0, why: ['нет низкой грани для выхода из воды'] } },
    solid: (_bot, p) => blocks.has(key(p)),
    tools: { async breakFast(_bot, p) { cuts.push(key(p)); blocks.delete(key(p)); return { ok: true } } },
    set(name: string, value: boolean) { controls.push([name, value]); held[name] = value; if (name === 'jump' && value) stepped = false },
    async sleep(ms: number) {
      now += ms
      if (ctx.simulateSteps && held.forward && held.jump && !stepped) {
        // The caller observes a completed ordinary stair step; this is not a physics test.
        ctx.bot.entity.position = ctx.bot.entity.position.offset(1, 1, 0); stepped = true
      }
    }
  }
  return { ctx, notes, controls, cuts, blocks, climb: () => createTerrain(ctx).climbOut({ depth: 2, rimY: 120 }) }
}

test('refused tower is not a successful pit escape or imaginary block spend', async () => {
  const f = fixture()
  assert.equal(await f.climb(), false)
  assert.equal(f.ctx.st.blocks, 7)
  assert.deepEqual(f.notes, [])
  assert.deepEqual(f.controls, [])
})

test('throwing tower still cannot manufacture a pit escape receipt', async () => {
  const f = fixture(); f.ctx.towerUp = async () => { throw new Error('cancelled placement') }
  assert.equal(await f.climb(), false)
  assert.equal(f.ctx.st.blocks, 7)
  assert.deepEqual(f.notes, [])
})

test('partial tower preserves confirmed vertical and support blocks without claiming exit', async () => {
  const f = fixture()
  f.ctx.towerUp = async () => {
    f.ctx.bot.entity.position.y = 119
    return { ok: false, placed: 1, supportPlaced: 1 }
  }
  assert.equal(await f.climb(), false)
  assert.equal(f.ctx.st.blocks, 9)
  assert.deepEqual(f.notes, [])
})

test('confirmed complete tower counts auxiliary support and reports the actual receipt', async () => {
  const f = fixture()
  f.ctx.towerUp = async () => {
    f.ctx.bot.entity.position.y = 120
    return { ok: true, placed: 2, supportPlaced: 1 }
  }
  assert.equal(await f.climb(), true)
  assert.equal(f.ctx.st.blocks, 10)
  assert.deepEqual(f.notes, ['выбрался из ямы столбом (3 бл.)'])
})

test('refused tower preserves the existing stair fallback and verifies arrival', async () => {
  const f = fixture()
  for (const key of ['1,118,0', '1,119,0', '2,119,0']) f.blocks.add(key)
  assert.equal(await f.climb(), true)
  assert.equal(f.ctx.bot.entity.position.y, 120)
  assert.deepEqual(f.cuts, ['1,119,0'])
  assert.equal(f.ctx.st.blocks, 7)
  assert.deepEqual(f.notes, ['вырубил ступени из ямы'])
})

test('failed stair movement after a tower refusal does not become another false success', async () => {
  const f = fixture()
  f.blocks.add('1,118,0')
  f.ctx.simulateSteps = false
  assert.equal(await f.climb(), false)
  assert.equal(f.ctx.st.blocks, 7)
  assert.deepEqual(f.notes, [])
})

test('cancellation preserves a partial receipt without starting the stair fallback', async () => {
  const f = fixture(); f.blocks.add('1,119,0')
  f.ctx.towerUp = async () => {
    f.ctx.ctl.aborted = true
    return { ok: false, placed: 1 }
  }
  assert.equal(await f.climb(), false)
  assert.equal(f.ctx.st.blocks, 8)
  assert.deepEqual(f.controls, [])
  assert.deepEqual(f.notes, [])
})

test('a build safety abort keeps its consumed-action return and real partial count', async () => {
  const f = fixture(); f.blocks.add('1,119,0')
  f.ctx.towerUp = async () => ({ ok: false, placed: 1, supportPlaced: 1 })
  f.ctx.buildDone = () => true
  assert.equal(await f.climb(), true)
  assert.equal(f.ctx.st.blocks, 9)
  assert.deepEqual(f.controls, [])
  assert.deepEqual(f.notes, [], 'consumed action must not claim that the pit was escaped')
})

test('cancel during the post-tower look cannot start a lateral step', async () => {
  const f = fixture(); f.blocks.add('1,119,0')
  f.ctx.towerUp = async () => {
    f.ctx.bot.entity.position.y = 120
    return { ok: true, placed: 2 }
  }
  f.ctx.bot.lookAt = async () => { f.ctx.ctl.aborted = true }
  assert.equal(await f.climb(), false)
  assert.equal(f.ctx.st.blocks, 9)
  assert.deepEqual(f.controls, [])
  assert.deepEqual(f.notes, [])
})


test('a failed opening retries on a changed block or usable tool, never clock age alone', async () => {
  let now = 1000, digs = 0, state = 1, ms = 200
  const target = new Vec3(2, 0, 0), hit = { position: new Vec3(1, 1, 0), stateId: state, name: 'stone' }
  const ctx: any = { bot: { entity: { position: new Vec3(0, 0, 0) }, world: { raycast: () => ({ ...hit, stateId: state }) } },
    entity: { position: target }, EYE: 1.62, Vec3, gameClock: { now: () => now }, ready: () => true, rest() {},
    tools: { bestFor: () => ({ ms, item: { name: 'stone_pickaxe' } }), breakFast: async () => { digs++; return { ok: false, why: 'no block receipt' } } },
    pathTo() {}, clear() {}, holdWeapon: async () => {}, used() {}, pick: { faceAim: () => null } }
  const terrain = createTerrain(ctx)
  assert.equal(await terrain.punchThrough(), false)
  now += 60000; await terrain.punchThrough(); assert.equal(digs, 1)
  ms = 100; await terrain.punchThrough(); assert.equal(digs, 2)
  state++; await terrain.punchThrough(); assert.equal(digs, 3)
})

test('a bucket without a liquid receipt fails and does not resend until its placement cause changes', async () => {
  let now = 1000, uses = 0, floor = 'stone', liquid = 'air', succeeds = false
  const cell = new Vec3(2, 0, 0), bucket = { name: 'water_bucket', slot: 36, count: 1 }
  const bot: any = { entity: { position: new Vec3(0, 0, 0) }, heldItem: bucket,
    blockAt: p => ({ position: p, name: p.y < 0 ? floor : liquid, boundingBox: p.y < 0 ? 'block' : 'empty' }),
    lookAt: async () => {}, activateItem: () => { uses++; if (succeeds) liquid = 'water' } }
  const ctx: any = { bot, ctl: { aborted: false }, Vec3, gameClock: { now: () => now },
    pick: { faceAim: () => cell.offset(.5, 0, .5) }, bucketLanding: () => ({ cell }),
    holdItem: async () => true, blockName: (_b, p) => bot.blockAt(p).name, sleep: async ms => { now += ms }, used() {} }
  const terrain = createTerrain(ctx)
  assert.equal(await terrain.useOnGroundAt(bucket, cell, 'water'), false)
  now += 60000
  assert.equal(await terrain.useOnGroundAt(bucket, cell, 'water'), false)
  assert.equal(uses, 1)
  floor = 'dirt'; succeeds = true
  assert.equal(await terrain.useOnGroundAt(bucket, cell, 'water'), true)
  assert.equal(uses, 2)
})

test('tower shield stays up for the released bolt corridor, not its old four-hundred-ms tail', async () => {
  let now = 1000, lowered = 0
  const watch = { drawAt: 500, loadedAt: 500, shots: 0 }
  const ctx: any = { bot: { entity: { position: new Vec3(0, 0, 0) }, lookAt: async () => {} },
    entity: { isValid: true, position: new Vec3(8, 0, 0), equipment: [{ name: 'crossbow' }] }, prof: { player: true },
    guard: { stats: { worn: true }, raise: async up => { if (!up) lowered = now; return true } },
    bowWatch: watch, gameClock: { now: () => now }, ctl: { aborted: false }, EYE: 1.62, TOWER_SAFE_DRAW_MS: 500,
    raySees: () => true, TICK_MS: 50, process: { env: {} }, st: {}, ready: () => true, rest() {}, used() {},
    threats: { incoming: () => now < 2000 ? [{ name: 'arrow' }] : [], dangers: () => ({ arrows: [] }) },
    sleep: async ms => { now += ms; watch.drawAt = 0; watch.loadedAt = 0; watch.shots = 1 } }
  assert.equal(await createTerrain(ctx).towerShield(), 'waited')
  assert.equal(lowered, 2000, 'lower only once the observed bolt no longer intersects the body')
})
