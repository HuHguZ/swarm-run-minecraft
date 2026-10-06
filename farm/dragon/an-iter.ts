// Сводка итерации (обе руки вместе): node an-iter.js <тег> <пар N>
const { execFileSync } = require('child_process')
const path = require('path')
const [tag, N] = process.argv.slice(2)
const out = execFileSync('node', [path.join(__dirname, 'an-pearl.js'), tag, N], { env: { ...process.env, ROWS: '1' } }).toString()
const R = out.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l)).filter(r => !r.none)
const med = a => { const v = a.filter(x => x != null).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : '-' }
const kb = R.filter(r => r.killBed != null).map(r => r.killBed)
const dm = R.flatMap(r => r.beds || []).filter(x => x != null)
const lines = out.split('\n').filter(l => /взрывы [AB]:садится/.test(l))
console.log(`${tag}: боёв ${R.length}; побед ≤4 ${kb.filter(k => k <= 4).length}, ≤5 ${kb.filter(k => k <= 5).length}, ≤6 ${kb.filter(k => k <= 6).length}; смертей ${R.filter(r => r.died).length}; урон p50 (все взрывы) ${med(dm)}; взрывов/бой ${(dm.length / R.length).toFixed(1)}; макс. цепочка p50 ${med(R.map(r => r.maxChain))}; станция p50 ${med(R.map(r => r.stationSecs))} с (есть ${R.filter(r => r.stationSecs != null).length}); видимость ${med(R.map(r => r.seen))}`)
console.log(lines.join('\n'))
