import test from 'node:test'
import assert from 'node:assert/strict'
const AL = require('../arms-layout')

test('раскладка гонки: проверки проходят на 20 seed, зеркальна, тайники закрыты облицовкой, бюджеты сторон близки', () => {
  for (let s = 0; s < 20; s++) {
    const L = AL.generate(String(s))
    const v = AL.validate(L)
    assert.ok(v.ok, `seed ${s}: ${v.errs.join('; ')}`)
    assert.equal(v.shelves, 15)
    assert.equal(v.reach[0], v.reach[1], `seed ${s}: достижимость сторон`)
    assert.ok(L.budget.diff <= 0.15, `seed ${s}: перекос бюджета ${L.budget.diff}`)
    // Каждый сундук западной половины имеет зеркального на востоке (кроме оси).
    for (const c of L.chests.filter((q: any) => q.x < 0)) {
      const m = L.chests.find((q: any) => q.x === -c.x && q.y === c.y && q.z === c.z)
      assert.ok(m, `seed ${s}: ${c.id} без пары`)
      assert.deepEqual(m.items, c.items, `seed ${s}: ${c.id} и пара — одно содержимое`)
    }
    assert.equal(L.budget.west, L.budget.east)
    // С крыши можно спуститься на поле не прыжком в 5 бл. (лестницы у края поля).
    assert.ok(AL.reach(L.g, { x: -21, y: 5, z: 0 }).has('-10,0,0'), `seed ${s}: с крыши на поле`)
    const hidden = L.chests.filter((c: any) => c.tier === 2)
    assert.ok(hidden.length >= 4 && hidden.every((c: any) => c.cover && c.cover.length), `seed ${s}: тайники с облицовкой`)
    for (const c of L.chests) for (const it of c.items) assert.deepEqual(AL.checkItem(it), [], `seed ${s}: ${it}`)
  }
})

test('раскладка гонки: тот же seed — та же раскладка; опись сброса — воздух, массы, сундуки с содержимым', () => {
  const a = AL.generate('42'); const b = AL.generate('42')
  assert.deepEqual(a.chests.map((c: any) => [c.x, c.y, c.z, c.items]), b.chests.map((c: any) => [c.x, c.y, c.z, c.items]))
  const cmds = AL.commands(a, { X: 0, Y: 100, Z: 0 })
  assert.match(cmds[0], /^fill .* minecraft:air$/)
  const items = cmds.filter((c: string) => c.startsWith('item replace block'))
  assert.equal(items.length, a.chests.reduce((n: number, c: any) => n + c.items.length, 0))
  assert.ok(cmds.every((c: string) => !c.startsWith('/') && c.length < 32000))
})

test('проверка чар: неприменимые, сверх уровня и несовместимые — ошибки', () => {
  assert.deepEqual(AL.checkItem('diamond_sword[enchantments={sharpness:5}]'), [])
  assert.equal(AL.checkItem('diamond_sword[enchantments={sharpness:6}]').length, 1)
  assert.equal(AL.checkItem('bow[enchantments={sharpness:1}]').length, 1)
  assert.equal(AL.checkItem('diamond_sword[enchantments={sharpness:1,smite:1}]').length, 1)
})
