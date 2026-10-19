import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { cjsContext } from './cjs-context'

interface ArmorItem { name: string; slot: number; maxDurability: number; durabilityUsed: number }
function armorFixture(worn: string[] = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'],
    spares: string[] = ['golden_boots', 'golden_chestplate']) {
  let now = 0
  const slots: Array<ArmorItem | null> = Array(46).fill(null)
  const item = (name: string, slot: number): ArmorItem => ({ name, slot, maxDurability: name.includes('golden') ? 112 : 240, durabilityUsed: 0 })
  worn.forEach((name, index) => { slots[index + 5] = item(name, index + 5) })
  spares.forEach((name, index) => { slots[index + 9] = item(name, index + 9) })
  const clicks: string[] = []
  const goldCounts: number[] = []
  const timing = { afterSleep: null as (() => void) | null }
  const bot = { entity: {}, game: { dimension: 'the_nether' }, health: 20, currentWindow: null as null | object,
    inventory: { slots, selectedItem: null, items: () => slots.slice(9, 45).filter((entry): entry is ArmorItem => !!entry) },
    async equip(armor: ArmorItem, destination: string) {
      clicks.push(armor.name)
      const to = { head: 5, torso: 6, legs: 7, feet: 8 }[destination]!
      const old = slots[to]; const from = armor.slot
      slots[to] = armor; armor.slot = to
      slots[from] = old; if (old) old.slot = from
      goldCounts.push(slots.slice(5, 9).filter(entry => entry?.name.startsWith('golden_')).length)
    } }
  const module = { exports: {} as { equipBestArmor(session: unknown, ctl: unknown): Promise<{ equipped: unknown[]; defense: number }> } }
  runInNewContext(readFileSync(process.env.ARMOR_TEST_SOURCE ?? resolve(__dirname, '../src/armor.js'), 'utf8'), cjsContext({
    module, require: (name: string) => name === './game-clock' ? { now: () => now } : name === './movement'
      ? { sleep: async (milliseconds: number) => { now += milliseconds; timing.afterSleep?.() } } : undefined }))
  return { bot, clicks, goldCounts, timing, session: { bot }, equip: module.exports.equipBestArmor }
}

test('Nether armor equips owned gold at minimal defense loss and remains stable on the next tick', async () => {
  const f = armorFixture()
  const result = await f.equip(f.session, { aborted: false })
  assert.equal(result.defense, 14)
  assert.equal(result.equipped.length, 1)
  assert.equal(f.goldCounts.at(-1), 1)
  assert.equal((await f.equip(f.session, { aborted: false })).equipped.length, 0)
})

test('replacement gold is worn before the last old gold is upgraded', async () => {
  const f = armorFixture(['iron_helmet', 'iron_chestplate', 'iron_leggings', 'golden_boots'], ['iron_boots', 'golden_helmet'])
  const result = await f.equip(f.session, { aborted: false })
  assert.equal(result.defense, 15, 'the gold helmet costs no defense point while boots can upgrade')
  assert.deepEqual(f.clicks, ['golden_helmet', 'iron_boots'])
  assert.ok(f.goldCounts.every(count => count >= 1), 'no intermediate armor click removes piglin-safe armor')
})

test('one coordinated upgrade cannot remove both worn gold pieces', async () => {
  const f = armorFixture(['iron_helmet', 'iron_chestplate', 'golden_leggings', 'golden_boots'], ['iron_leggings', 'iron_boots'])
  await f.equip(f.session, { aborted: false })
  assert.equal(f.bot.inventory.slots[7]?.name, 'iron_leggings')
  assert.equal(f.bot.inventory.slots[8]?.name, 'golden_boots')
  assert.ok(f.goldCounts.every(count => count >= 1))
})

test('a rejected replacement keeps the last worn gold piece', async () => {
  const f = armorFixture(['iron_helmet', 'iron_chestplate', 'iron_leggings', 'golden_boots'], ['iron_boots', 'golden_helmet'])
  const equip = f.bot.equip.bind(f.bot)
  f.bot.equip = async (item, destination) => {
    if (item.name === 'golden_helmet') throw new Error('native equip refused')
    await equip(item, destination)
  }
  await f.equip(f.session, { aborted: false })
  assert.equal(f.bot.inventory.slots[8]?.name, 'golden_boots')
  assert.equal(f.clicks.includes('iron_boots'), false)
})

test('late native correction is observed before the last old gold piece is removed', async () => {
  const f = armorFixture(['iron_helmet', 'iron_chestplate', 'iron_leggings', 'golden_boots'], ['iron_boots', 'golden_helmet'])
  f.timing.afterSleep = () => {
    const replacement = f.bot.inventory.slots[5]!
    const previous = f.bot.inventory.slots[10]!
    f.bot.inventory.slots[5] = previous; previous.slot = 5
    f.bot.inventory.slots[10] = replacement; replacement.slot = 10
    f.timing.afterSleep = null
  }
  await f.equip(f.session, { aborted: false })
  assert.equal(f.bot.inventory.slots[5]?.name, 'iron_helmet')
  assert.equal(f.bot.inventory.slots[8]?.name, 'golden_boots')
  assert.equal(f.clicks.includes('iron_boots'), false)
})

test('the Nether gold constraint retains window and death equipment guards', async () => {
  const f = armorFixture()
  f.bot.currentWindow = {}
  assert.equal((await f.equip(f.session, { aborted: false })).equipped.length, 0)
  f.bot.currentWindow = null; f.bot.health = 0
  assert.equal((await f.equip(f.session, { aborted: false })).equipped.length, 0)
  assert.deepEqual(f.clicks, [])
})
