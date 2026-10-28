// Поток graph2 (sr27): кровати на дракона по пути (ND_GRAPH2_BEDS) — овцы на виду сейчас дешевле поиска перед Краем.
import test from 'node:test'
import assert from 'node:assert/strict'
import { fact, type FactValue, type WorldState } from '../src/core/world-state'
import { speedrunRegistry, dragonGoal } from '../src/core/speedrun'
import { plan } from '../src/core/strategy'
import { worldFromObservation } from '../src/environments/mineflayer'

function withEnv<T>(env: Record<string, string | undefined>, body: () => T): T {
  const old = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]))
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  try { return body() } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}
// Ранний верхний мир: каменная кирка, дерево, овцы на виду (situation.sheepSeen).
function early(sheep: number, inventory: Record<string, number> = {}, facts: Record<string, FactValue> = {}): WorldState {
  return worldFromObservation({ state: { dimension: 'overworld', health: 20, food: 20, pos: { x: 0, y: 70, z: 0 },
    inventory: { stone_pickaxe: 1, stone_axe: 1, oak_log: 3, crafting_table: 1, ...inventory } }, situation: { sheepSeen: sheep },
    known: {}, facts: Object.fromEntries(Object.entries({ nether_ready: false, end_ready: false, ...facts }).map(([k, v]) => [k, fact(v, 'observed', 0)])) }, 0)
}
const steps = (state: WorldState) => plan(speedrunRegistry({ eyes: 12, beds: 5 }), state, dragonGoal).steps.map(s => s.id)

test('graph2 beds: стадо на виду — шерсть сейчас (первый шаг), а не отдельный поход перед Краем', () => withEnv({ ND_GRAPH2_BEDS: '1' }, () => {
  const p = steps(early(4))
  assert.equal(p[0], 'CollectBedsNear')
  assert.equal(p.filter(id => id === 'CollectBedsNear').length, 1, 'овцы на виду — один раз: следующий шаг уводит от них')
}))

test('graph2 beds: одна овца без шерсти — кровати не выйдет, мимо; ночью — мимо; без флага — нет стратегии', () => {
  withEnv({ ND_GRAPH2_BEDS: '1' }, () => {
    assert.ok(!steps(early(1)).includes('CollectBedsNear'))
    assert.ok(steps(early(1, { white_wool: 2 })).includes('CollectBedsNear'), '2 шерсти + 1 овца = кровать')
    assert.ok(!steps(early(4, {}, { night: true })).includes('CollectBedsNear'))
    assert.ok(!steps(early(4, { white_wool: 15 })).includes('CollectBedsNear'), 'шерсть на 5 кроватей уже есть')
  })
  withEnv({ ND_GRAPH2_BEDS: undefined }, () => {
    assert.equal(speedrunRegistry({ eyes: 12, beds: 5 }).get('CollectBedsNear'), undefined)
    assert.ok(!steps(early(4)).includes('CollectBedsNear'))
  })
})
