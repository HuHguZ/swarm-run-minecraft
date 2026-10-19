'use strict'
// Бой «только кроватями» (2026-09-30): план кровати у головы сидящего, честный
// щелчок по видимой части кровати, набор на вход. Мир фермы: земля — ноги на 61,
// фонтан (столб bedrock 0,60..63,0) — верх 64, дракон сидит на Y 64.
import test = require('node:test')
import assert = require('node:assert/strict')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import dragon = require('../src/dragon')

const registry = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
const KEYS = registry.entitiesByName.ender_dragon.metadataKeys
function world (extra = new Map()) {
  return p => {
    const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
    const k = `${x},${y},${z}`
    if (extra.has(k)) {
      const name = extra.get(k)
      if (name === 'air') return { name, boundingBox: 'empty', position: new Vec3(x, y, z), shapes: [] }
      return { name, boundingBox: 'block', position: new Vec3(x, y, z), shapes: /_bed$/.test(name) ? [[0, 0, 0, 1, 0.5625, 1]] : [[0, 0, 0, 1, 1, 1]] }
    }
    let s = y <= 60 && y >= 40
    if (x === 0 && z === 0 && y >= 60 && y <= 63) s = true
    return { name: s ? 'end_stone' : 'air', boundingBox: s ? 'block' : 'empty', position: new Vec3(x, y, z), shapes: s ? [[0, 0, 0, 1, 1, 1]] : [] }
  }
}
function scene (yaw, { ph = dragon.PHASE.SCANNING, me = new Vec3(15.5, 61, 0.5), extra = new Map() }: any = {} as Record<string, any>) {
  const meta = []
  meta[KEYS.indexOf('phase')] = ph
  meta[KEYS.indexOf('health')] = 200
  const d: Record<string, any> = { id: 900, name: 'ender_dragon', position: new Vec3(0.5, 64, 0.5), yaw, metadata: meta, isValid: true }
  const bot = { registry, entity: { position: me, yaw: 0, pitch: 0 }, entities: { 900: d }, blockAt: world(extra) }
  return { bot, d, parts: dragon.partsOf(bot, d, null), extra }
}

test('голова по оси +x: кровать под головой, мы в трёх клетках за заслоном', () => {
  const { bot, d, parts } = scene(Math.PI / 2)
  const plan = dragon.bedsLayout(bot, d, parts, {} as Record<string, any>)
  assert.ok(plan, JSON.stringify(dragon.bedsLayout.why))
  // Изголовье — под головой (в клетке или соседней), кровать на земле (61).
  assert.ok(Math.hypot(plan.H.x + 0.5 - parts.headC.x, plan.H.z + 0.5 - parts.headC.z) <= 1.6)
  assert.equal(plan.y, 61)
  // Раскладка по одной оси: B — W — F — H.
  for (const [a, b, k] of [[plan.B, plan.H, 3], [plan.W, plan.H, 2], [plan.F, plan.H, 1]]) {
    assert.equal(b.x - a.x, plan.D.x * k); assert.equal(b.z - a.z, plan.D.z * k)
  }
  // Урон по голове — как у кровати на полтора-два блока ниже её низа.
  assert.ok(plan.expect >= 45 && plan.expect <= 62, `ожидаемый урон ${plan.expect}`)
  // Место не в коробках головы/шеи (с запасом) и не в чаше портала.
  assert.equal(dragon.hurtNear({ min: plan.feet.offset(-0.3, 0, -0.3), max: plan.feet.offset(0.3, 1.8, 0.3) }, parts), false)
  assert.ok(Math.hypot(plan.feet.x - 0.5, plan.feet.z - 0.5) >= 3.8)
})

test('любой угол посадки: план есть, место стоянки — вне коробок', () => {
  for (let yaw = 0; yaw < 2 * Math.PI; yaw += Math.PI / 8) {
    const { bot, d, parts } = scene(yaw)
    const plan = dragon.bedsLayout(bot, d, parts, {} as Record<string, any>)
    assert.ok(plan, `yaw ${yaw.toFixed(2)}: ${JSON.stringify(dragon.bedsLayout.why)}`)
    assert.equal(dragon.hurtNear({ min: plan.feet.offset(-0.3, 0, -0.3), max: plan.feet.offset(0.3, 1.8, 0.3) }, parts), false)
  }
})

test('облако огня: во время огня место кровати не в нём (и смелому), во время рёва — только в 3 шагах', () => {
  for (const yaw of [Math.PI / 2, 0, 0.7, 2.5]) {
    for (const ph of [dragon.PHASE.ROARING, dragon.PHASE.FLAMING]) {
      const { bot, d, parts } = scene(yaw, { ph })
      for (const brave of [false, true]) {
        const plan = dragon.bedsLayout(bot, d, parts, { brave })
        if (!plan || !plan.breathHit) continue
        assert.equal(ph, dragon.PHASE.ROARING, 'во время огня — в облаке')
        assert.ok(Math.hypot(plan.feet.x - bot.entity.position.x, plan.feet.z - bot.entity.position.z) <= 3)
      }
    }
  }
})

test('воронка у головы: план есть — на целом полу или с видимой досыпкой', () => {
  const extra = new Map()
  // Голова по +x в (7, 63, 0.5): выбить пол под всеми клетками у головы на один блок.
  for (let x = 5; x <= 9; x++) for (let z = -1; z <= 1; z++) extra.set(`${x},60,${z}`, 'air')
  const { bot, d, parts } = scene(Math.PI / 2, { extra })
  const plan = dragon.bedsLayout(bot, d, parts, {} as Record<string, any>)
  assert.ok(plan, JSON.stringify(dragon.bedsLayout.why))
  for (const f of plan.fills) assert.equal(f.y, plan.y - 1)
})

test('кровать и заслон стоят: щелчок — по видимой из глаз части изголовья', () => {
  const { bot, d, parts, extra } = scene(Math.PI / 2)
  const plan = dragon.bedsLayout(bot, d, parts, {} as Record<string, any>)
  extra.set(`${plan.H.x},${plan.y},${plan.H.z}`, 'red_bed')
  extra.set(`${plan.F.x},${plan.y},${plan.F.z}`, 'red_bed')
  extra.set(`${plan.W.x},${plan.y},${plan.W.z}`, 'cobblestone')
  bot.entity.position = plan.feet
  const hit = dragon.bedClickPoint(bot, plan)
  assert.ok(hit, 'кровать за заслоном не видно')
  assert.ok(/_bed$/.test(hit.block.name))
  // Точка — на верхе кровати, не дальше досягаемости руки.
  assert.ok(Math.abs(hit.point.y - (plan.y + 0.5625)) < 1e-6)
  assert.ok(hit.point.distanceTo(plan.feet.offset(0, 1.62, 0)) <= 4.5)
})

test('заслон в два блока: кровать не видно — не щёлкаем сквозь стену', () => {
  const { bot, d, parts, extra } = scene(Math.PI / 2)
  const plan = dragon.bedsLayout(bot, d, parts, {} as Record<string, any>)
  extra.set(`${plan.H.x},${plan.y},${plan.H.z}`, 'red_bed')
  extra.set(`${plan.F.x},${plan.y},${plan.F.z}`, 'red_bed')
  extra.set(`${plan.W.x},${plan.y},${plan.W.z}`, 'cobblestone')
  extra.set(`${plan.W.x},${plan.y + 1},${plan.W.z}`, 'cobblestone')
  bot.entity.position = plan.feet
  assert.equal(dragon.bedClickPoint(bot, plan), null)
})

test('набор на «только кровати»: кровати, блоки, еда; лук и стрелы не нужны', () => {
  const none = dragon.missing({ beds: 0, blocks: 0, food: 0, bow: 0, arrows: 0, weapon: null, pickaxe: null }, 'beds', null)
  assert.deepEqual(none.map(n => n.what).sort(), ['cobblestone', 'cooked_beef', 'red_bed'])
  const ok = dragon.missing({ beds: 12, blocks: 128, food: 16, bow: 0, arrows: 0, weapon: 'iron_sword', pickaxe: 'iron_pickaxe' }, 'beds', null)
  assert.deepEqual(ok, [])
  // На острове (бой идёт) — блоков хватит и 12, еда не спрашивается.
  const mid = dragon.missing({ beds: 3, blocks: 14, food: 0, bow: 0, arrows: 0 }, 'beds', { crystals: 10, caged: 2, island: true })
  assert.deepEqual(mid, [])
})

test('по умолчанию бой — «только кровати»: без режима вызов не просит лук и стрелы', async () => {
  const bot = {
    game: { dimension: 'the_end' },
    entity: { position: new Vec3(20, 61, 0), id: 1 },
    entities: {} as Record<string, any>,
    registry,
    health: 20,
    inventory: { items: () => [], slots: [] },
    blockAt: world()
  }
  const r = await dragon.dragon({ bot }, { onAbort: [], aborted: false }, {} as Record<string, any>)
  assert.equal(r.mode, 'beds')
  assert.ok(r.need && r.need.what === 'red_bed', JSON.stringify(r.needAll))
  assert.ok(!r.needAll.some(n => /arrow|bow/.test(n.what)))
})

test('двойная станция: X под головой, C рядом (через щит), мы вне круга поворота головы', () => {
  for (const yaw of [Math.PI / 2, 0, 0.7, 2.5, 3.9, 5.3]) {
    const { bot, d, parts } = scene(yaw, { ph: dragon.PHASE.FLAMING })
    const plan = dragon.bedsDouble(bot, d, parts, { brave: true })
    assert.ok(plan, `yaw ${yaw}: ${JSON.stringify(dragon.bedsDouble.why)}`)
    // X — у головы; C — в 2–4 от места головы сидя (взлёт первые 0.5 с — поворот
    // на месте, голова уходит вбок на ~3), не ближе двух клеток к X.
    const hx = plan.X.H.x + 0.5 - parts.headC.x; const hz = plan.X.H.z + 0.5 - parts.headC.z
    assert.ok(Math.hypot(hx, hz) <= 2.5, `X далеко от головы: ${Math.hypot(hx, hz)}`)
    const cx = plan.C.H.x + 0.5 - parts.headC.x; const cz = plan.C.H.z + 0.5 - parts.headC.z
    assert.ok(Math.hypot(cx, cz) <= 4.5, `C далеко: ${Math.hypot(cx, cz)}`)
    for (const a of [plan.C.F, plan.C.H]) for (const b of [plan.X.F, plan.X.H]) assert.ok(Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) >= 2)
    assert.ok(plan.shield.length >= 1)
    assert.ok(Math.hypot(plan.feet.x - d.position.x, plan.feet.z - d.position.z) >= 9.2, 'в круге поворота головы')
    // Место — вне коробок дракона (видимость и досягаемость щелчка проверяет сам план).
    assert.equal(dragon.hurtNear({ min: plan.feet.offset(-0.3, 0, -0.3), max: plan.feet.offset(0.3, 1.8, 0.3) }, parts), false)
    // Облако огня (мы в его круге): крышка в два блока — облако ляжет выше нас.
    if (plan.lid) assert.ok(plan.lid.y + plan.lid.h >= plan.y + 1.8)
  }
})

test('двойная станция: первая кровать посадки — не выше 50 сидячего урона', () => {
  const { bot, d, parts } = scene(Math.PI / 2, { ph: dragon.PHASE.FLAMING })
  const free = dragon.bedsDouble(bot, d, parts, { brave: true })
  const capped = dragon.bedsDouble(bot, d, parts, { brave: true, cap: 46 })
  assert.ok(free && capped)
  assert.ok(capped.X.expect <= 48, `ожидаемый урон первой ${capped.X.expect}`)
  assert.ok(free.X.expect >= capped.X.expect)
})

test('отрезок по клеткам: без концов, по пути', () => {
  const c = dragon.cellsOnSeg({ x: 0.5, z: 0.5 }, { x: 3.5, z: 0.5 }).map(k => `${k.x},${k.z}`).sort()
  assert.deepEqual(c, ['1,0', '2,0'])
})

test('взлёт: направление полёта запоминается, голова через 10 тиков повёрнута к нему на ≤ 32°', () => {
  const { d, parts } = scene(0) // голова к +z
  // Два взлёта этого дракона: тело улетело к +x.
  for (const t0 of [1000, 10000]) {
    d.position = new Vec3(0.5, 64, 0.5)
    dragon.noteTakeoff(d, dragon.PHASE.TAKEOFF, t0)
    d.position = new Vec3(8.5, 66, 0.5)
    dragon.noteTakeoff(d, dragon.PHASE.HOLDING, t0 + 2000)
  }
  d.position = new Vec3(0.5, 64, 0.5)
  assert.ok(Math.abs(dragon.takeoffAzOf(d)) < 0.05)
  const h = dragon.headAfterTakeoff(d, parts)
  // Голова сидя — (0.5, 7); к +x на 32°: x > 0.5, дуга радиуса 6.5 от тела.
  assert.ok(h.x > 3 && h.x < 4.5, `x ${h.x}`)
  assert.ok(Math.abs(Math.hypot(h.x - 0.5, h.z - 0.5) - 6.5) < 0.01)
})
