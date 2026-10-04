'use strict'
// Проверки модели замка (castle.js) без сервера:
//   1. имена и состояния блоков — есть ли такие в игре (minecraft-data 1.21.11);
//   2. свет: где может заспавниться моб (блочный свет 0 на месте, куда он
//      встаёт, — colosseum-light: BFS света и хитбоксы мобов);
//   3. команды: сколько, не длиннее ли 250 (чат бота).
//   node castle-check.js [--fix]   — отчёт; --fix печатает, сколько света добавил бы

const C = require('./colosseum')
const LG = require('./colosseum-light')
const CS = require('./castle')

function validate (g) {
  const mc = require('minecraft-data')('1.21.11')
  const bad = []
  for (let v = 1; v < g.pal.length; v++) {
    const s = g.pal[v]
    const { name, props } = C.parse(s)
    const b = mc.blocksByName[name]
    if (!b) { bad.push(`нет блока: ${s}`); continue }
    const states = new Map((b.states || []).map(x => [x.name, x]))
    for (const [k, val] of Object.entries(props)) {
      const stt = states.get(k)
      if (!stt) { bad.push(`${name}: нет свойства ${k} (${s})`); continue }
      if (stt.type === 'bool' && val !== 'true' && val !== 'false') bad.push(`${name}.${k}=${val}: не bool`)
      if (stt.type === 'enum' && !stt.values.includes(val)) bad.push(`${name}.${k}=${val}: нет в [${stt.values.join(',')}]`)
      if (stt.type === 'int') { const n = Number(val); const max = stt.num_values - 1 + (stt.values ? Number(stt.values[0]) : 0); if (!Number.isInteger(n) || n < (stt.values ? Number(stt.values[0]) : 0) || n > max) bad.push(`${name}.${k}=${val}: вне 0..${max}`) }
    }
  }
  return bad
}

// Места спавна без блочного света (верхний мир: блочный свет 0 — спавн
// возможен при тёмном небе).
function spawnDark (g) {
  const T = LG.tables(g)
  const L = LG.blockLight(g, T)
  const MOBS = [['зомби', 0.6, 1.95], ['паук', 1.4, 0.9]]
  const water = new Set(g.pal.map((s, i) => /^water/.test(s) ? i : -1).filter(i => i >= 0))
  const dark = []; let spots = 0
  for (let y = g.y0 + 1; y < g.y1 - 2; y++) {
    for (let z = g.z0 + 1; z < g.z1; z++) {
      for (let x = g.x0 + 1; x < g.x1; x++) {
        const below = g.data[g.i(x, y - 1, z)]
        if (!T.surface[below]) continue
        const i = g.i(x, y, z)
        const feet = g.data[i]; const head = g.data[g.i(x, y + 1, z)]
        if (T.fullColl[feet] || T.fullColl[head] || water.has(feet)) continue
        if (!MOBS.some(([, w, h]) => LG.fits(g, T, x, y, z, w, h))) continue
        spots++
        if (L[i] === 0) dark.push([x, y, z])
      }
    }
  }
  return { spots, dark, L, T }
}

module.exports = { validate, spawnDark }

if (require.main === module) {
  const t0 = Date.now()
  const m = CS.model()
  console.log(`модель: ${m.stats.blocks} блоков, палитра ${m.g.pal.length}, ${Date.now() - t0} мс`)
  const bad = validate(m.g)
  console.log(bad.length ? `СОСТОЯНИЯ (${bad.length}):\n  ` + bad.join('\n  ') : 'состояния: все валидны')
  const t1 = Date.now()
  const r = spawnDark(m.g)
  console.log(`свет: мест для спавна ${r.spots}, тёмных ${r.dark.length} (${Date.now() - t1} мс)`)
  const groups = {}
  for (const [x, y, z] of r.dark) { const k = `y${y}`; (groups[k] = groups[k] || []).push(`${x},${z}`) }
  for (const [k, v] of Object.entries(groups).sort((a, b) => Number(a[0].slice(1)) - Number(b[0].slice(1)))) console.log(`  ${k}: ${v.length} — ${v.slice(0, 10).join(' ')}${v.length > 10 ? ' …' : ''}`)
  if (CS.commands) {
    const t2 = Date.now()
    const cmds = CS.commands(m, { X: 0, Y: 63, Z: 0 })
    console.log(`команды: ${cmds.length} (fill ${cmds.filter(c => c.startsWith('/fill')).length}), самая длинная ${Math.max(...cmds.map(c => c.length))}, ${Date.now() - t2} мс`)
  }
}
