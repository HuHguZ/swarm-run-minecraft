const Vec3 = require('../../daemon/node_modules/vec3')
const REG = require('../../daemon/node_modules/minecraft-data')('1.21.11')
const dragon = require('../../daemon/src/dragon')
const P = 65
function world (extra) {
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
const bot = { entity: { position: new Vec3(8.5, P - 3, 0.5), yaw: 0, pitch: 0, height: 1.8, onGround: true }, blockAt: world(new Map()), entities: {} as Record<string, any>, inventory: { items: () => [] }, game: { dimension: 'the_end' }, registry: REG }
for (const dy of [-1, 0, 1, 2]) {
  const t = Date.now()
  const c = dragon.pillarPlan(bot, P, { dy })
  console.log('dy', dy, c ? { H: c.H, F: c.F, yb: c.yb, B: c.B, feetY: c.feet.y, dig: c.dig, K: c.place.K, Kobs: c.place.obsidian, face: c.place.face, sup: c.sup, obs: c.obs, nObs: c.nObs, floating: c.floating, expo: c.expo, seen: c.seen, cost: c.cost.toFixed(1), n: dragon.pillarPlan.all.length } : dragon.pillarPlan.why, Date.now() - t, 'ms')
}

{ const t0 = Date.now(); const c = dragon.pillarPlanAuto(Object.assign(bot, { inventory: { items: () => [{ name: 'obsidian', count: 4 }] } }), P); console.log('auto', Date.now() - t0, 'ms', c && { yb: c.yb, H: c.H, B: c.B, feetY: c.feet.y, K: c.place.K, sup: c.sup, supCob: c.supCob, nObs: c.nObs, seen: c.seen, expo: c.expo }) }
