'use strict'
// Офлайн-проверка плана R (02.10, поток dragon): node farm/dragon/offline/rplan.js [P] — чаша/столб по EndPodiumFeature,
// план runnerPlan текущего dragon.js, по ярусам: ноги, точка ставки на грани K, угол взгляда к оси F→H (изголовье), запас до 45°.
const fs = require('fs'), path = require('path'), vm = require('vm'), Module = require('module')
const file = path.resolve(__dirname, '../../../daemon/src/dragon.js'), req = Module.createRequire(file), Vec3 = req('vec3')
const src = fs.readFileSync(file, 'utf8') + '\nmodule.exports.__R={runnerPlan,LABENV,faceClickFacing,faceClick,exposure};'
const m = { exports: {} }
new vm.Script(Module.wrap(src), { filename: file }).runInThisContext()(m.exports, req, m, file, path.dirname(file))
const d = m.exports.__R, P = Number(process.argv[2] || 68), o = P - 4, cells = new Map(), key = (x, y, z) => `${x},${y},${z}`
function blockAt (p) {
  const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z), r = x * x + z * z + (y - o) ** 2
  let name = y < o ? 'end_stone' : 'air'
  if (y >= o - 1 && r < 12.25) name = y < o ? (r < 6.25 ? 'bedrock' : 'end_stone') : y === o && r >= 6.25 ? 'bedrock' : 'air'
  if (x === 0 && z === 0 && y >= o && y < P) name = 'bedrock'
  if (y === P - 2 && Math.abs(x) + Math.abs(z) === 1) name = 'wall_torch'
  name = cells.get(key(x, y, z)) || name
  const solid = !['air', 'wall_torch'].includes(name)
  return { name, position: new Vec3(x, y, z), boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] }
}
const bot = { entity: { position: new Vec3(0.5, P - 4, -1.5), onGround: true }, entities: {}, blockAt, inventory: { items: () => [{ name: 'obsidian', count: 4 }] } }
d.LABENV.ND_RUNNER = '1'
const plan = d.runnerPlan(bot, P)
if (!plan) { console.log('нет плана', JSON.stringify(d.runnerPlan.why)); process.exit(1) }
for (const c of plan.labExtra) cells.set(c.slice(0, 3).join(','), c[3] === 'air' ? 'air' : 'obsidian')
for (const p of plan.runnerLevels) {
  cells.set(key(0, P, p.F.z), p.yb > P ? 'cobblestone' : 'air')
  for (const dx of [0, 0.1, -0.1]) for (const dz of [0, 0.1, -0.1]) {
    const eye = plan.feet.offset(dx, 1.62, dz)
    const want = { x: p.H.x - p.F.x, z: p.H.z - p.F.z }
    const f = d.faceClickFacing(bot, eye, new Vec3(p.place.K.x, p.place.K.y, p.place.K.z), p.place.face, want, { minCos: 0.0 })
    const yaw = f ? Math.acos(Math.min(1, f.cos)) * 180 / Math.PI : null
    // угол именно от точки плана (её бот и берёт на подходе)
    const dv = p.place.point.minus(eye), a = Math.acos((dv.x * want.x + dv.z * want.z) / Math.hypot(dv.x, dv.z)) * 180 / Math.PI
    if (dx === 0 && dz === 0) console.log(`yb P+${p.yb - P} ноги ${plan.feet} K ${JSON.stringify(p.place.K)} точка ${p.place.point} угол плана ${a.toFixed(1)}° лучший ${yaw && yaw.toFixed(1)}° len ${f && f.len.toFixed(2)} expo ${p.expo}`)
    else console.log(`   сдвиг ${dx},${dz}: угол точки плана ${a.toFixed(1)}°, лучший ${yaw && yaw.toFixed(1)}°`)
  }
}
