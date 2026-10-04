'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { classify, campaignFacts, mainDeathCause } = require('../scene-kit')

const L = (m, stage, body) => `[12:00:00 +${String(m).padStart(3)}м] ${stage.padEnd(10)} ${body}`

test('журнал кампании: ВЕХИ с минутами, последний этап и коды исходов', () => {
  const text = [
    L(0, '-', 'старт: пусто'),
    L(1, 'wood', 'ход 1: начинаю; рюкзак: пусто'),
    L(3, 'wood', 'mine {"block":"any_log"} → done hp20 еда20 (0,64,0) +{"oak_log":4}'),
    L(4, 'wood', 'ВЕХА wood: готово в 12:04:00, 4 мин от запуска'),
    L(5, 'stone', 'ход 2: начинаю; рюкзак: oak_log×4'),
    L(6, 'stone', 'goto {"x":1} → timeout hp20 еда20 (0,64,0) stopped: время вышло | код TIMEOUT'),
    L(7, 'stone', 'mine {"block":"stone"} → interrupted hp14 еда20 (0,64,0) прервано: damage | код DAMAGE')
  ].join('\n')
  const f = campaignFacts(text)
  assert.deepEqual(f.miles, { wood: 4 })
  assert.equal(f.lastStage, 'stone')
  assert.deepEqual(f.codes.map(c => c.code), ['OK', 'TIMEOUT', 'DAMAGE'])
})

test('класс провала — по тому, что остановило прогон', () => {
  assert.equal(classify({ ok: true }), 'OK')
  assert.equal(classify({ stoppedBy: 'БЛОКЕР: укрытие не закрыто — лечение ожиданием небезопасно' }), 'SHELTER_ABORT')
  assert.equal(classify({ stoppedBy: 'БЛОКЕР: обе норы не закрыты — ночное ожидание небезопасно' }), 'SHELTER_ABORT')
  assert.equal(classify({ stoppedBy: 'БЛОКЕР: не вышел из воды — лечение ожиданием небезопасно' }), 'SHELTER_ABORT')
  assert.equal(classify({ stoppedBy: 'БЛОКЕР: нет доступного шага (food·без прогресса, iron·нечем); одинаковые попытки прекращаю' }),
    'NO_STEP:food·без прогресса,iron·нечем')
  assert.equal(classify({ stoppedBy: 'БЛОКЕР: сторож — 45 мин без прогресса (последний этап iron)' }), 'WATCHDOG:iron')
  assert.equal(classify({ stoppedBy: 'БЛОКЕР: сторож — 46 мин без прогресса ни в одном этапе (последний этап food); останавливаю кампанию' }), 'WATCHDOG:food')
  assert.equal(classify({ stoppedBy: 'смертей 5', deaths: ['N was slain by Zombie', 'N was slain by Zombie', 'N was shot by Skeleton', 'N tried to swim in lava', 'N was slain by Zombie'] }),
    'DEATH_LOOP:Zombie')
  assert.equal(classify({ stoppedBy: 'кампания вышла (1)', exitCode: 1 }, L(9, 'iron', 'прогон упал: TypeError: x is not a function')), 'CRASH')
  const stuck = [L(1, 'iron', 'ход 3: начинаю; рюкзак: пусто')]
  for (let m = 130; m <= 150; m += 2) stuck.push(L(m, 'iron', 'goto {"x":1} → failed hp20 еда20 (0,0,0) ошибка: нет пути | код NO_PATH'))
  assert.equal(classify({ stoppedBy: 'время' }, stuck.join('\n')), 'STUCK:iron')
  assert.equal(classify({ stoppedBy: 'время' }, L(1, 'cast', 'ход 9: начинаю; рюкзак: пусто')), 'TIMEOUT:cast')
})

test('главная причина смертей — самая частая', () => {
  assert.equal(mainDeathCause(['NeuroFarm5 was shot by Skeleton', 'NeuroFarm5 tried to swim in lava', 'NeuroFarm5 was shot by Skeleton']), 'Skeleton')
  assert.equal(mainDeathCause(['NeuroFarm5 fell from a high place']), 'fall')
  assert.equal(mainDeathCause(['NeuroFarm20 was poked to death by a sweet berry bush while trying to escape Skeleton']), 'sweet_berry_bush')
  assert.equal(mainDeathCause(['NeuroFarm20 was shot by Skeleton while trying to escape Zombie']), 'Skeleton')
})
