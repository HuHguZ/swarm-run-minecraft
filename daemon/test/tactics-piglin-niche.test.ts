import test from 'node:test'
import assert from 'node:assert/strict'
import { candidates, piglinNiche } from '../src/tactics/state'

// Пиглины без нашего золота (ревью Codex 14.10, codex-lab/piglin-defense-20261014): закрытая ниша рядом рвёт их луч без
// открытого бега — BlockOff выше CreateDistance и LastStand, а при других угрозах выбор прежний.
const make = (n = 1, changes: Record<string, any> = {}): import('../src/tactics/state').TacticalState => ({ at: 0, health: 20, food: 20, armor: 0, weapon: true, shield: true,
  enemies: Array.from({ length: n }, (_, i) => ({ id: i + 1, kind: 'piglin', distance: 4, threatening: true, player: false, hit: 8 })),
  incomingProjectiles: 0, burning: false, lava: false, fireResistance: false, explosion: false, dangerousFall: false,
  emergencyController: false, inWater: false, cover: false, portal: false, escapeRoute: true, blocks: 128, water: false,
  edible: true, canFight: false, contact: true, shelter: 'BlockOff', niche: true, protectedEncounter: false, ...changes })

for (const n of [1, 2, 3]) test(`пиглинов ${n}: ниша (BlockOff) первой`, () => {
  assert.equal(candidates(make(n))[0].id, 'BlockOff')
})

test('загнан в угол при 4 хп — всё равно ниша, а не последний бой', () => {
  assert.equal(candidates(make(3, { health: 4, escapeExhausted: true }))[0].id, 'BlockOff')
})

// Пиглин уже вплотную (≤ 3.5 бл.) бьёт раз в секунду сквозь стройку — там ответ дуэль со щитом, а не ниша (сцена try-lab-ne-piglin).
test('пиглин вплотную — не ниша', () => {
  assert.equal(piglinNiche(make(1, { enemies: [{ id: 1, kind: 'piglin', distance: 1.6, threatening: true, player: false, hit: 4 }] })), false)
})

for (const changes of [{ niche: false }, { shield: false }, { failedEscapes: ['BlockOff'] }, { lava: true }, { burning: true },
  { enemies: [{ id: 1, kind: 'piglin', distance: 4, threatening: true, player: false, hit: 8 }, { id: 2, kind: 'piglin_brute', distance: 4, hit: 13, threatening: true, player: false }] },
  { enemies: [{ id: 1, kind: 'piglin', distance: 4, threatening: true, player: false, hit: 8 }, { id: 2, kind: 'hoglin', distance: 4, hit: 8, threatening: true, player: false }] }
]) test(`без ниши по правилу: ${JSON.stringify(Object.keys(changes))}`, () => {
  assert.equal(piglinNiche(make(1, changes)), false)
})
