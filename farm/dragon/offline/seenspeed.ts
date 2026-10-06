'use strict'
// Скорость и проверка smDragonSeen (02.10): мир — чаша/столб + станция R, тело в нескольких точках; сверка с Codex seenmodel.
const fs = require('fs'), path = require('path'), vm = require('vm'), Module = require('module')
const file = path.resolve(__dirname, '../../../daemon/src/dragon.js'), req = Module.createRequire(file), Vec3 = req('vec3')
const src = fs.readFileSync(file, 'utf8') + '\nmodule.exports.__S={smCompile,smDragonSeen,bedDamage};'
const m = { exports: {} as Record<string, any> }
new vm.Script(Module.wrap(src), { filename: file }).runInThisContext()(m.exports, req, m, file, path.dirname(file))
const S = m.exports.__S, ref = require('../../../codex-lab/dragon-seen/seenmodel.js')
const P = 66, o = P - 4, cells = new Map([['-1,65,0', 'obsidian'], ['-1,65,-1', 'obsidian'], ['-1,66,-1', 'obsidian'], ['-1,67,-1', 'obsidian']])
function name (x, y, z) {
  const r = x * x + z * z + (y - o) ** 2
  let n = y < o ? 'end_stone' : 'air'
  if (y >= o - 1 && r < 12.25) n = y < o ? (r < 6.25 ? 'bedrock' : 'end_stone') : y === o && r >= 6.25 ? 'bedrock' : 'air'
  if (x === 0 && z === 0 && y >= o && y < P) n = 'bedrock'
  return cells.get(`${x},${y},${z}`) || n
}
const bot = { blockAt: p => { const n = name(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)); return { name: n, shapes: n === 'air' ? [] : [[0, 0, 0, 1, 1, 1]] } } }
let t: any = Date.now()
const snap = S.smCompile(bot, [-16, P - 6, -16, 16, P + 16, 16], (x, y, z) => x === 0 && (z === 0 || z === -1) && y >= P && y <= P + 1)
console.log('снимок', Date.now() - t, 'мс, коллайдеров', snap.colliders.length)
const ext = [[0, P, -1, 1, P + 1, 0]]
for (const [bx, by, bz] of [[-4, P + 1.5, 3], [3, P + 0.3, -5], [0, P + 3, 6], [-6, P + 2, -2]]) {
  for (const yb of [P, P + 1]) {
    const c = new Vec3(0.5, yb + 0.5, 0.5)
    t = process.hrtime.bigint()
    const s1 = S.smDragonSeen(snap, c, new Vec3(bx, by, bz), yb > P ? ext : [])
    const ms = Number(process.hrtime.bigint() - t) / 1e6
    const w = (x, y, z) => { if (yb > P && x === 0 && y === P && z === -1) return { name: 'cobblestone', shapes: [[0, 0, 0, 1, 1, 1]] }; if (x === 0 && (z === 0 || z === -1) && y >= P && y <= P + 1) return { name: 'air', shapes: [] }; const n = name(x, y, z); return { name: n, shapes: n === 'air' ? [] : [[0, 0, 0, 1, 1, 1]] } }
    const s2 = ref.dragonSeenOf(ref.compileWorld(w, [-16, P - 6, -16, 16, P + 16, 16]), [c.x, c.y, c.z], [bx, by, bz])
    console.log(`тело ${bx},${by},${bz} ярус P+${yb - P}: seen ${s1.toFixed(4)} (Codex ${s2.toFixed(4)}) ${ms.toFixed(2)} мс`)
  }
}
