'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
// Режим — правила решения, без сервера и физики. Интеграцию выстрелов
// отдельно проверяет ферма с настоящим луком и 16 стрелами у каждой пары.
const { canUseRanged, decideFight, configure } = require('../src/play-policy')
const make = (mode = 'speedrun', inventory: any = {} as Record<string, any>) => ({
  playPolicy: { mode, arrowReserve: 16, foodTarget: 8, resources: { blaze_rod: 7, ender_pearl: 14, string: 3 } },
  bot: { inventory: { items: () => Object.entries<any>(inventory).map(([name, count]: any) => ({ name, count })) } }
})

test('спидран не тратит ни обычные, ни дефицитные стрелы на мирных животных', () => {
  for (const name of ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom']) {
    assert.equal(canUseRanged(make('speedrun', { arrow: 64 }), { name }), false, name)
  }
})
test('свободная игра и явное разрешение допускают лук', () => {
  assert.equal(canUseRanged(make('free', { arrow: 1 }), { name: 'cow' }), true)
  assert.equal(canUseRanged(make(), { name: 'cow' }, { allowRanged: true }), true)
})
test('боевой запас сохраняется и пересчитывается по мере расхода', () => {
  assert.equal(canUseRanged(make('speedrun', { arrow: 17 }), { name: 'skeleton' }), true)
  assert.equal(canUseRanged(make('speedrun', { arrow: 16 }), { name: 'skeleton' }), false)
  assert.equal(canUseRanged(make('speedrun', { arrow: 8, spectral_arrow: 9 }), { name: 'skeleton' }), true)
})
test('спидран не стреляет в эндермена, который телепортируется от стрел', () => {
  assert.equal(canUseRanged(make('speedrun', { arrow: 64 }), { name: 'enderman' }), false)
})
test('охота прекращается при достаточном запасе еды, ручной приказ исполняется', () => {
  const s = make('speedrun', { cooked_beef: 6, porkchop: 2 })
  assert.equal(decideFight(s, { name: 'cow' }, { purpose: 'food' }).skip, true)
  assert.equal(decideFight(s, { name: 'cow' }, { purpose: 'command' }).skip, false)
})
test('бой за ресурс нужен только до достижения его цели', () => {
  assert.equal(decideFight(make('speedrun', { ender_pearl: 13 }), { name: 'enderman' }, { purpose: 'resource' }).skip, false)
  assert.equal(decideFight(make('speedrun', { ender_pearl: 12, ender_eye: 2 }), { name: 'enderman' }, { purpose: 'resource' }).skip, true)
  assert.equal(decideFight(make(), { name: 'zombie' }, { purpose: 'resource' }).skip, true)
})
test('шерсть на заданное число кроватей считается вместе с готовыми кроватями', () => {
  const p = { purpose: 'resource', resourceGoal: { item: 'wool', count: 6 } }
  assert.equal(decideFight(make('speedrun', { white_bed: 1, brown_wool: 2 }), { name: 'sheep' }, p).skip, false)
  assert.equal(decideFight(make('speedrun', { white_bed: 1, brown_wool: 2, white_wool: 1 }), { name: 'sheep' }, p).skip, true)
})
test('защита допустима независимо от дропа, автоматическая зачистка выключена', () => {
  const d = decideFight(make(), { name: 'zombie' }, { purpose: 'defense' })
  assert.equal(d.skip, false)
  assert.equal(d.clearArea, 0)
  assert.equal(decideFight(make('free'), { name: 'zombie' }, {} as Record<string, any>).clearArea, 10)
  assert.equal(decideFight(make(), { name: 'zombie' }, { clearArea: 20 }).clearArea, 20)
})
test('неизвестный режим и отрицательный запас не меняют прежние правила', () => {
  const before = make().playPolicy
  assert.throws(() => configure(before, { mode: 'whatever' }), /режим/)
  assert.throws(() => configure(before, { arrowReserve: -1 }), /arrowReserve/)
  assert.equal(before.mode, 'speedrun')
  assert.equal(before.arrowReserve, 16)
})
test('переключение в free сохраняет пользовательские настройки для следующего спидрана', () => {
  const p = configure(make().playPolicy, { mode: 'free' })
  assert.equal(p.mode, 'free')
  assert.equal(p.arrowReserve, 16)
  assert.equal(p.resources.ender_pearl, 14)
})

test('RPC смены режима сохраняет правила, сообщает их в состоянии и отменяет старое намерение', async () => {
  const { Session } = require('../src/session')
  const journal = { state: {} as Record<string, any>, patch: fn => fn(journal.state) }
  const s = new Session({} as Record<string, any>, { drain: () => [] }, journal)
  await s.setPlayMode({ mode: 'speedrun' })
  let directorStops = 0
  s.director = { stop: () => { directorStops++ } }
  let aborted = 0
  s.current = { name: 'fight', ctl: { abort: () => { aborted++ } } }
  const r = await s.setPlayMode({ mode: 'free' })
  assert.equal(r.status, 'done')
  assert.equal(r.state.playPolicy.mode, 'free')
  assert.equal(journal.state.playPolicy.mode, 'free')
  assert.equal(aborted, 1)
  assert.equal(directorStops, 1, 'старый директор тоже уступает управление свободной игре')
  const restored = new Session({} as Record<string, any>, { drain: () => [] }, journal)
  assert.equal(restored.playPolicy.mode, 'free')
})
