// Офлайн: станция у столба (pillarPlan) в плоском мире с точной чашей фонтана — есть ли, сколько обсидиана,
// где бот, видимость дракона из центра взрыва. node farm/dragon/an-pillarplan.js [P]
const REG = require('../../daemon/node_modules/minecraft-data')('1.21.11')
const Vec3 = require('../../daemon/node_modules/vec3')
const dragon = require('../../daemon/src/dragon')
const P = +(process.argv[2] || 65)
function world (P, extra = new Map()) {
  const o = P - 4
  return p => {
    const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
    const k = `${x},${y},${z}`
    if (extra.has(k)) { const n = extra.get(k); return { name: n, boundingBox: n === 'air' ? 'empty' : 'block', position: new Vec3(x, y, z), shapes: n === 'air' ? [] : [[0, 0, 0, 1, 1, 1]] } }
    const d2 = x * x + z * z
    let name = 'air'
    if (y <= o - 1 && y >= o - 20) name = 'end_stone'
    if (y === o) name = d2 < 6.25 ? 'air' : d2 < 12.25 ? 'bedrock' : 'end_stone'
    if (y === o - 1 && d2 < 12.25) name = 'bedrock'
    if (y > o && d2 < 12.25) name = 'air'
    if (x === 0 && z === 0 && y >= o && y <= o + 3) name = 'bedrock'
    if (y === o + 2 && Math.abs(x) + Math.abs(z) === 1) name = 'wall_torch'
    const solid = name !== 'air' && name !== 'wall_torch'
    return { name, boundingBox: solid ? 'block' : 'empty', position: new Vec3(x, y, z), shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] }
  }
}
const bot = { entity: { position: new Vec3(8.5, P - 3, 0.5), yaw: 0, pitch: 0, height: 1.8, onGround: true }, blockAt: world(P), entities: {} as Record<string, any>, inventory: { items: () => [] }, game: { dimension: 'the_end' }, registry: REG }
const t0 = Date.now()
const best = dragon.pillarPlan(bot, P)
console.log(`за ${Date.now() - t0} мс; вариантов ${dragon.pillarPlan.all.length}`)
console.log(dragon.pillarPlan.why)
for (const c of dragon.pillarPlan.all.slice(0, 8)) {
  console.log(JSON.stringify({ H: c.H, F: c.F, B: c.B, feetY: c.feet.y - P, dig: c.dig, K: c.place.K, Kobs: c.place.obsidian, obs: c.obs.map(o => [o[0], o[1] - P, o[2]]), floating: c.floating, seen: c.seen, cost: Math.round(c.cost * 10) / 10 }))
}
