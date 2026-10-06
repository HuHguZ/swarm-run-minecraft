'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const dragon = require('../src/dragon')

// Тело дракона по трассе dtr-1-2 (2026-09-29, смерть на 556 с «slain by Ender
// Dragon»): пять заходов в коробки крыльев садящегося и взлетающего дракона —
// по три удара (5, в железе 2.5), подброс, падение; добил взлёт. Мир фермы:
// земля — ноги на 61, фонтан (столб bedrock 0,60..63,0) — верх 64, сидит на
// Y 63.8–64.9.
const registry = require('minecraft-data')('1.21.11')
const KEYS = registry.entitiesByName.ender_dragon.metadataKeys
function world (holes = []) {
  const hole = new Set(holes.map(([x, y, z]: any) => `${x},${y},${z}`))
  return p => {
    const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
    let s = y <= 60 && y >= 40
    if (x === 0 && z === 0 && y >= 60 && y <= 63) s = true
    if (hole.has(`${x},${y},${z}`)) s = false
    return { name: s ? 'end_stone' : 'air', boundingBox: s ? 'block' : 'empty', position: new Vec3(x, y, z) }
  }
}
function scene (me, holes?: any) {
  const meta = []
  meta[KEYS.indexOf('phase')] = 0
  meta[KEYS.indexOf('health')] = 200
  const d: Record<string, any> = { id: 700, name: 'ender_dragon', position: new Vec3(0, 80, 0), yaw: 0, metadata: meta, isValid: true }
  const bot: Record<string, any> = { registry, entity: { position: me, yaw: 0, pitch: 0 }, entities: { 700: d }, blockAt: world(holes) }
  const set = (ph, pos, yaw) => { meta[KEYS.indexOf('phase')] = ph; d.position = pos; d.yaw = yaw }
  return { bot, d, set }
}
const P = dragon.PHASE
const danger = (bot, now) => dragon.dangerAt(bot, bot.entity.position, { clouds: [], fireballs: [], ...dragon.dragonZones(bot, now) })

test('садится у фонтана: тело на земле в 6 блоках — в коробке крыльев (442 с)', () => {
  const { bot, set } = scene(new Vec3(-0.5, 61, -6.5))
  set(P.LANDING, new Vec3(0.2, 65.3, -3.8), 6.23)
  dragon.dragonZones(bot, 1000)
  set(P.LANDING, new Vec3(-0.1, 64.9, -1), 0.34)
  const bad = danger(bot, 1250)
  assert.ok(bad && /крыло|посадка/.test(bad.kind), `опасность не видна: ${JSON.stringify(bad)}`)
})

test('садится: в яме с ногами на верх фонтана − 4 — безопасно', () => {
  const { bot, set } = scene(new Vec3(-0.5, 60, -6.5), [[-1, 60, -7]])
  set(P.LANDING, new Vec3(0.2, 65.3, -3.8), 6.23)
  dragon.dragonZones(bot, 2000)
  set(P.LANDING, new Vec3(-0.1, 64.9, -1), 0.34)
  assert.equal(danger(bot, 2250), null)
})

test('взлёт вперёд по взгляду: тело в 9 блоках сбоку-спереди — в коридоре (555.8 с)', () => {
  const { bot, set } = scene(new Vec3(-1.3, 61, -8.5))
  set(P.TAKEOFF, new Vec3(1.1, 64.1, 0.8), 4.74)
  dragon.dragonZones(bot, 3000)
  set(P.TAKEOFF, new Vec3(-1.8, 64.1, 1.7), 4.54)
  const bad = danger(bot, 3250)
  assert.ok(bad && /крыло|взлёт/.test(bad.kind), `взлёт не виден: ${JSON.stringify(bad)}`)
})

test('слепой сидит 100 тиков: коридор взлёта — с 3.8 с сидения (взлёт на 4.6–5 с)', () => {
  const { bot, set } = scene(new Vec3(-1.3, 61, -8.5))
  set(P.SCANNING, new Vec3(1.1, 64.1, 0.8), 4.74)
  assert.equal(danger(bot, 10000), null, 'только сел — не беда')
  assert.equal(danger(bot, 11400), null, 'в начале посадки — не беда')
  const late = danger(bot, 14000)
  assert.ok(late && /взлёт/.test(late.kind), `слепой — коридор взлёта: ${JSON.stringify(late)}`)
  assert.ok(late.away && Math.abs((late.away.x - bot.entity.position.x) * Math.sin(4.74) + (late.away.z - bot.entity.position.z) * Math.cos(4.74)) < 1e-6, 'уходить поперёк оси взлёта')
  // В яме — не задевает и на взлёте.
  bot.entity.position = new Vec3(-1.3, 60, -8.5)
  bot.blockAt = world([[-2, 60, -9]])
  assert.equal(danger(bot, 14100), null)
})

test('отступ от головы: из-под шеи — вбок от оси, а не к голове (d8-17, 358 с)', () => {
  const { bot, set } = scene(new Vec3(2.9, 61, 2.7))
  set(P.FLAMING, new Vec3(1.2, 63.9, 1.1), 0.69)
  const d = bot.entities[700]
  const parts = dragon.partsOf(bot, d, null)
  const to = dragon.awayFromHead(d, parts, bot.entity.position, 4)
  const hc = parts.headC
  const before = Math.hypot(bot.entity.position.x - hc.x, bot.entity.position.z - hc.z)
  const after = Math.hypot(to.x - hc.x, to.z - hc.z)
  assert.ok(after > before + 1, `ближе к голове не становится: было ${before.toFixed(1)}, стало ${after.toFixed(1)}`)
  // Перед мордой — дальше вперёд.
  const front = parts.headC.offset(parts.dir.x * 2.5, 0, parts.dir.z * 2.5)
  const to2 = dragon.awayFromHead(d, parts, new Vec3(front.x, 61, front.z), 3)
  assert.ok(Math.hypot(to2.x - hc.x, to2.z - hc.z) > 4.5)
})

// ab-23 (30.09, 284–292 с): сидящий видящий высматривал, а тело стояло в 20.06
// блока — scanTargeting (20) его не нашёл, через 100 тиков таран. «Не ревёт» —
// ещё не «слепой», если мы были дальше 20: слепым считать, только побывав в
// круге после 25-го тика посадки.
test('слепой — только если были в 20 блоках после 25-го тика и рёва не было', () => {
  const d: Record<string, any> = { position: new Vec3(0.5, 64, 0.5) }
  const far = { entity: { position: new Vec3(-18.5, 62, 3.5) } }
  const near = { entity: { position: new Vec3(-12.5, 62, 3.5) } }
  const rec = { t0: 0, roared: false }
  dragon.noteNear(rec, d, far, 3000)
  assert.equal(dragon.blindKnown(rec, 5000), false, 'дальше 20 (19.4 по горизонтали, 19.5 в 3D — у края) — не знаем')
  const rec2: Record<string, any> = { t0: 0, roared: false }
  dragon.noteNear(rec2, d, near, 800)
  assert.equal(rec2.nearAt, undefined, 'до 25-го тика не считается')
  dragon.noteNear(rec2, d, near, 1300)
  assert.equal(dragon.blindKnown(rec2, 1600), false, 'рёв мог ещё не дойти')
  assert.equal(dragon.blindKnown(rec2, 1800), true)
  rec2.roared = true
  assert.equal(dragon.blindKnown(rec2, 5000), false, 'ревел — видящий')
  assert.ok(dragon.STAY_R <= dragon.SCAN_RANGE - 3, 'держаться с запасом внутри круга')
})

// c1-28 (30.09): 14 слепых посадок подряд — к голове шёл только с 1.6 с («ясно
// ли, слепой»), к взлёту не успевал. Слепота у дракона навсегда (Sensing не
// очищается): со второй посадки она известна сразу.
test('слепой со второй посадки — сразу; видящий — сразу «ревел»', () => {
  const near = { entity: { id: 7, position: new Vec3(-10.5, 62, 3.5) } }
  const d: Record<string, any> = { id: 501, position: new Vec3(0.5, 64, 0.5), yaw: 0 }
  const SC = dragon.PHASE.SCANNING
  // Посадка 1: слепой выясняется по ходу.
  const r1 = dragon.sitState(d, SC, 0)
  dragon.noteNear(r1, d, near, 1300)
  assert.equal(dragon.blindKnown(r1, 1800), true)
  dragon.sitState(null, null, 6000) // взлетел
  // Посадка 2: слепой с первого мига.
  const r2 = dragon.sitState(d, SC, 60000)
  assert.equal(dragon.blindKnown(r2, 60001), true, 'известен сразу')
  dragon.sitState(null, null, 66000)
  // Другой дракон ревёт — видящий; следующая его посадка — «ревел» сразу.
  const d2 = { id: 502, position: d.position, yaw: 0 }
  dragon.sitState(d2, dragon.PHASE.ROARING, 70000)
  dragon.sitState(null, null, 80000)
  const r3 = dragon.sitState(d2, SC, 90000)
  assert.equal(r3.roared, true)
  assert.equal(dragon.blindKnown(r3, 95000), false)
})

// Ревью Codex (30.09): «слепой» — только если в круге непрерывно (мелькнул и ушёл — не
// в счёт), и огонь без пойманного рёва — тоже «видящий».
test('слепой: мелькнул в круге и ушёл — не в счёт; огонь без рёва — видящий', () => {
  const d: Record<string, any> = { id: 601, position: new Vec3(0.5, 64, 0.5), yaw: 0 }
  const near = { entity: { position: new Vec3(-10.5, 62, 3.5) } }
  const far = { entity: { position: new Vec3(-25.5, 62, 3.5) } }
  const SC = dragon.PHASE.SCANNING
  const r = dragon.sitState(d, SC, 0)
  dragon.noteNear(r, d, near, 1300)
  dragon.noteNear(r, d, far, 1500)
  assert.equal(dragon.blindKnown(r, 2500), false, 'ушёл из круга — отсчёт заново')
  dragon.sitState(null, null, 6000)
  const d2 = { id: 602, position: d.position, yaw: 0 }
  dragon.sitState(d2, SC, 7000)
  const r2 = dragon.sitState(d2, dragon.PHASE.FLAMING, 9000)
  assert.equal(r2.roared, true, 'дышит огнём — значит видит')
})
