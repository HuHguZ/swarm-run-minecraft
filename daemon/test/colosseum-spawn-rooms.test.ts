import test from 'node:test'
import assert from 'node:assert/strict'
import * as C from '../arena/colosseum'
import * as CA from '../arena/colosseum-arms'

// Колизей + раскладка поверх (как в игре: копия постройки, затем команды раскладки) — сетка блоков относительно центра.
function world (seed: string) {
  const m = C.model({ R: 24, ceilH: 16 })
  const L = CA.generate(seed)
  for (const [x, y, z, b] of [...L.field, ...L.set]) m.g.set(x, y, z, b === 'air' ? '' : b.replace(/\{.*$/, ''))
  return { g: m.g, p: m.p, L }
}

test('комнаты спавна колизея: сквозные (тоннель и песок), широкие проходы, свет, сундуки внутри', () => {
  const { g, p, L } = world('team1')
  assert.equal(L.spawnRooms.length, 4)
  assert.deepEqual(L.spawnRooms.map((r: any) => r.team).sort(), ['blue', 'blue', 'red', 'red'])
  const air = (x, y, z) => !g.get(x, y, z) || /carpet|button|banner|lantern/.test(g.get(x, y, z))
  const stand = (x, z) => air(x, 0, z) && air(x, 1, z) && !air(x, -1, z)
  for (const r of L.spawnRooms) {
    const s = r.spot
    assert.ok(stand(s.x, s.z) && !g.get(s.x, 0, s.z), `${r.id}: точка — пол и два воздуха, без ковра`)
    // Обход по клеткам, где можно стоять (только уровень пола комнат): из комнаты есть путь в тоннель ворот и на песок.
    const seen = new Set([`${s.x},${s.z}`]); const q = [[s.x, s.z]]; let tunnel = false; let sand = false
    while (q.length && seen.size < 4000) {
      const [x, z] = q.shift() as number[]
      if (Math.abs(z) <= 1) tunnel = true
      if (C.foot(p.A1, p.B1, x, z).n < 0) { sand = true; continue }
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = `${x + dx},${z + dz}`
        if (!seen.has(k) && stand(x + dx, z + dz)) { seen.add(k); q.push([x + dx, z + dz]) }
      }
    }
    assert.ok(tunnel && sand, `${r.id}: сквозная — тоннель ${tunnel}, песок ${sand}`)
    // Широко: в стене тоннеля (|z| = 2) напротив комнаты проходимы ≥ 7 клеток, дверей нет нигде.
    const sx = Math.sign(s.x); const sz = Math.sign(s.z)
    let open = 0
    for (let u = 1; u <= 11; u++) if (stand(sx * (p.A1 + 5 + u), 2 * sz)) open++
    assert.ok(open >= 7, `${r.id}: проёмов к тоннелю ${open}`)
    // Портал на песок — 5 бл. в торце комнаты.
    let side = 0
    for (let v = 3; v <= 9; v++) if (stand(sx * (p.A1 + 5), v * sz)) side++
    assert.equal(side, 5, `${r.id}: портал на арену`)
    // Свет внутри комнаты.
    let lights = 0
    for (let u = 1; u <= 11; u++) for (let v = 3; v <= 9; v++) for (let y = 0; y <= 4; y++) if (/shroomlight|lantern|glowstone/.test(g.get(sx * (p.A1 + 5 + u), y, v * sz))) lights++
    assert.ok(lights >= 3, `${r.id}: свет ${lights}`)
    // Сундуки комнаты — внутри неё, над ними воздух (крышка открывается).
    const mine = L.chests.filter((c: any) => c.room === r.id)
    assert.equal(mine.length, 2)
    for (const c of mine) {
      assert.equal(c.kind, 'spawn')
      assert.ok(Math.abs(c.x) > p.A1 + 5 && Math.abs(c.x) < p.A1 + 17 && Math.abs(c.z) >= 3 && Math.abs(c.z) <= 9, `${c.id} в комнате`)
      assert.ok(air(c.x, c.y + 1, c.z), `${c.id}: над сундуком воздух`)
    }
  }
  assert.ok(!L.set.some(([, , , b]: any) => /_door|button/.test(b)), 'дверей и кнопок нет')
  // Комнаты не задевают другие сундуки и камеры: чужих сундуков в их габарите нет.
  for (const c of L.chests.filter((q: any) => q.kind !== 'spawn')) assert.ok(!(Math.abs(c.x) >= p.A1 + 5 && Math.abs(c.x) <= p.A1 + 17 && Math.abs(c.z) >= 2 && Math.abs(c.z) <= 10 && c.y >= -1 && c.y <= 4), `${c.id} внутри комнаты спавна`)
})

