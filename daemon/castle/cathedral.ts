'use strict'
// Собор на вершине и его убранство.

import { st, stairs, slab, hash, OPP, dirTo, CAT_PAL, ZC, CAT } from './common'

// -------------------------------------------------------------------- собор

function buildCathedral (ctx) {
  const { B } = ctx
  const F = CAT.F
  const zc = ZC
  const CP = CAT_PAL[ctx.p.cat] || CAT_PAL.tuff
  const { T, TP, TC, TCB, TW, TPW } = CP
  B.pinCap = TCB
  const dzOf = z => Math.abs(z - zc)
  const inApse = (x, z, r) => x > CAT.ax && Math.hypot(x - CAT.ax, z - zc) <= r
  const glassAisle = (a, y) => (y >= F + 7 ? 'yellow_stained_glass_pane' : ((a + y) % 3 === 0 ? 'red_stained_glass_pane' : 'blue_stained_glass_pane'))
  const glassWin = (y0, h) => (a, y) => (y >= y0 + h - 1 ? 'yellow_stained_glass_pane' : ((a + y) % 3 === 0 ? 'red_stained_glass_pane' : 'blue_stained_glass_pane'))
  const glassHigh = (a, y) => (y >= 51 ? 'purple_stained_glass_pane' : ((a * 3 + y) % 4 === 0 ? 'red_stained_glass_pane' : (a + y) % 4 === 1 ? 'light_blue_stained_glass_pane' : 'blue_stained_glass_pane'))

  // ---- 1. Основание: цоколь и пол (весь план собора).
  const planX0 = CAT.xW - 2; const planX1 = CAT.ax + 15
  for (let x = planX0; x <= planX1; x++) {
    for (let z = zc - 20; z <= zc + 20; z++) {
      const dz = dzOf(z)
      let inside = false
      if (x >= CAT.xW && x <= CAT.ax && dz <= 11) inside = true
      if (x >= CAT.xW && x <= CAT.xT && dz <= 16) inside = true // башни
      if (x >= CAT.xC0 && x <= CAT.xC1 && dz <= 18) inside = true // трансепт
      if (inApse(x, z, 11.5)) inside = true
      if (!inside) continue
      B.S(x, F - 1, z, (x + z) % 2 ? 'polished_andesite' : 'smooth_stone')
    }
  }

  // ---- 2. Стены приделов (|dz| = 11) и обхода, приделы внутри — воздух.
  const aisleTop = F + 11 // верх стены придела (y 41)
  for (let x = CAT.xT + 1; x <= CAT.ax; x++) {
    if (x >= CAT.xC0 && x <= CAT.xC1) continue
    for (const s of [-1, 1]) {
      const z = zc + s * 11
      for (let y = F; y <= aisleTop; y++) B.S(x, y, z, T)
      B.S(x, F, z, TP) // цоколь
    }
  }
  for (let x = CAT.ax; x <= CAT.ax + 12; x++) {
    for (let z = zc - 12; z <= zc + 12; z++) {
      const r = Math.hypot(x - CAT.ax, z - zc)
      if (x <= CAT.ax) continue
      if (r > 10.5 && r <= 11.5) { for (let y = F; y <= aisleTop; y++) B.S(x, y, z, T); B.S(x, F, z, TP) }
    }
  }
  // Своды приделов: потолок y 39..40 (перевёрнутые ступени у стен), кровля
  // приделов — односкатная от 42 у стены к 46 у нефа.
  for (let x = CAT.xW; x <= CAT.ax + 11; x++) {
    for (let z = zc - 10; z <= zc + 10; z++) {
      const dz = dzOf(z)
      const apse = x > CAT.ax
      const r = apse ? Math.hypot(x - CAT.ax, z - zc) : dz
      if (x >= CAT.xC0 && x <= CAT.xC1) continue
      if (!apse && (dz < 7 || x <= CAT.xT)) continue
      if (apse && (r <= 6.5 || r > 10.5)) continue
      // Своды придела.
      B.S(x, F + 10, z, T); B.S(x, F + 11, z, T)
      const outer = apse ? r > 9.5 : dz === 10
      const innerSide = apse ? r <= 7.5 : dz === 7
      if (outer || innerSide) {
        const toAxis = apse ? dirTo(CAT.ax - x, zc - z, true) : (z < zc ? 'south' : 'north')
        B.S(x, F + 9, z, stairs(T, outer ? OPP[toAxis] : toAxis, 'top'))
      }
      // Кровля придела.
      const t = apse ? (10.5 - r) : (10 - dz) // 0 у внешней стены
      const yr = F + 12 + Math.floor(t)
      B.S(x, yr, z, t % 1 >= 0.5 || (Math.floor(t) % 2 === 1) ? stairs('deepslate_tiles', apse ? dirTo(CAT.ax - x, zc - z, true) : (z < zc ? 'south' : 'north')) : 'deepslate_tiles')
      for (let y = F + 12; y < yr; y++) B.S(x, y, z, T)
    }
  }
  // Свес кровли приделов над стенами.
  for (let x = CAT.xT + 1; x <= CAT.ax; x++) {
    if (x >= CAT.xC0 && x <= CAT.xC1) continue
    for (const s of [-1, 1]) { B.S(x, F + 12, zc + s * 12, stairs('deepslate_tiles', s < 0 ? 'south' : 'north')); B.S(x, F + 11, zc + s * 12, stairs(T, s < 0 ? 'south' : 'north', 'top')) }
  }

  // ---- 3. Аркада и стены нефа (|dz| = 6) с трифорием и верхними окнами.
  const naveTop = 56
  const arcade = (x, z, along, isPier) => {
    for (let y = F; y <= naveTop; y++) B.S(x, y, z, T)
    if (isPier) { B.S(x, F, z, TP); B.S(x, F + 8, z, TC); return }
  }
  const pierXs = [...CAT.piers, CAT.xC0, CAT.xC1, 16, CAT.ax]
  for (let x = CAT.xT + 1; x <= CAT.ax; x++) {
    if (x > CAT.xC0 && x < CAT.xC1) continue
    for (const s of [-1, 1]) {
      const z = zc + s * 6
      const isPier = pierXs.includes(x)
      arcade(x, z, 'x', isPier)
    }
  }
  // Проёмы аркады, трифорий, окна — по пролётам.
  const bays = []
  const allPiers = [CAT.xT, ...CAT.piers, CAT.xC0]
  for (let i = 0; i < allPiers.length - 1; i++) bays.push([allPiers[i], allPiers[i + 1]])
  bays.push([CAT.xC1, 16], [16, CAT.ax])
  for (const [pa, pb] of bays) {
    const a0 = pa + 1; const a1 = pb - 1
    const w = a1 - a0 + 1 // 5
    for (const s of [-1, 1]) {
      const z = zc + s * 6
      const P = B.plane('x', z, s < 0 ? 'north' : 'south')
      // Арка аркады: проём y 30..37, стрельчатый верх.
      for (let a = a0; a <= a1; a++) for (let y = F; y <= F + 7; y++) P.set(a, y, '')
      P.set(a0, F + 7, stairs(T, P.lo, 'top')); P.set(a1, F + 7, stairs(T, P.hi, 'top'))
      P.set(a0 + 1, F + 8, stairs(T, P.lo, 'top')); P.set(a1 - 1, F + 8, stairs(T, P.hi, 'top'))
      P.set(a0 + 2, F + 8, ''); P.set(a0 + 2, F + 9, TC)
      // Трифорий: y 41..43, три малые арки.
      for (const a of [a0, a0 + 2, a1]) { P.set(a, F + 11, ''); P.set(a, F + 12, ''); P.set(a, F + 13, stairs(T, P.in, 'top')) }
      for (let a = a0; a <= a1; a++) P.set(a, F + 10, TP)
      // Верхнее окно (клересторий): 3 шириной со средником, y 46..51, острие 53.
      B.lancet(P, a0 + 1, F + 16, 3, 6, { famName: T, glass: glassHigh, mullion: true, sill: false })
      // Окно придела: в стене |dz| = 11.
      const Pa = B.plane('x', zc + s * 11, s < 0 ? 'north' : 'south')
      B.lancet(Pa, a0 + 1, F + 2, 3, 5, { famName: T, glass: glassAisle, mullion: true })
      void w
    }
  }
  // Апсида: кольцо опор r 6 (стена до верха нефа), проёмы аркады, окна.
  const apseAng = []
  for (let k = -3; k <= 3; k++) apseAng.push(k * Math.PI / 7)
  for (let x = CAT.ax + 1; x <= CAT.ax + 7; x++) {
    for (let z = zc - 7; z <= zc + 7; z++) {
      const r = Math.hypot(x - CAT.ax, z - zc)
      if (r > 5.5 && r <= 6.6) for (let y = F; y <= naveTop; y++) B.S(x, y, z, T)
    }
  }
  for (const ang of apseAng) {
    // Проём аркады и окно: клетки у луча.
    for (let x = CAT.ax + 1; x <= CAT.ax + 7; x++) {
      for (let z = zc - 7; z <= zc + 7; z++) {
        const r = Math.hypot(x - CAT.ax, z - zc)
        if (!(r > 5.5 && r <= 6.6)) continue
        const a = Math.atan2(z - zc, x - CAT.ax)
        const da = Math.abs(a - ang)
        if (da < 0.2) {
          for (let y = F; y <= F + 7; y++) B.S(x, y, z, '')
          for (let y = F + 16; y <= F + 22; y++) B.S(x, y, z, glassHigh(x + z, y))
        }
      }
    }
    // Окна обхода: в кольце r 11 между контрфорсами.
    for (const d of [-0.1, 0.1]) {
      const a = ang + Math.PI / 14 + d * 0
      const ex = Math.round(CAT.ax + Math.cos(a) * 11); const ez = Math.round(zc + Math.sin(a) * 11)
      if (ex <= CAT.ax) continue
      for (let y = F + 2; y <= F + 7; y++) B.S(ex, y, ez, glassAisle(ex + ez, y))
    }
  }

  // ---- 4. Свод нефа, хора и трансепта; крыша.
  const vaultProfile = { 5: 50, 4: 52, 3: 53, 2: 54, 1: 55, 0: 55 }
  const vaultCell = (x, z, dz, along, ribs) => {
    const yv = vaultProfile[dz]
    for (let y = yv; y <= naveTop; y++) B.S(x, y, z, T)
    if (dz >= 1) {
      const toWall = along === 'x' ? (z < zc ? 'north' : 'south') : (x < CAT.xC0 + 6 ? 'west' : 'east')
      B.S(x, yv, z, stairs(ribs ? TP : T, toWall, 'top'))
    }
  }
  for (let x = CAT.xW + 1; x <= CAT.ax; x++) {
    for (let z = zc - 5; z <= zc + 5; z++) {
      const dz = dzOf(z)
      const rib = pierXs.includes(x) || x === CAT.xT
      vaultCell(x, z, dz, 'x', rib)
    }
  }
  // Трансепт: свод вдоль z.
  for (let z = zc - 17; z <= zc + 17; z++) {
    if (dzOf(z) <= 5) continue
    for (let x = CAT.xC0 + 1; x <= CAT.xC1 - 1; x++) {
      const d = Math.abs(x - (CAT.xC0 + CAT.xC1) / 2)
      vaultCell(x, z, Math.round(d), 'z', dzOf(z) % 6 === 0)
    }
  }
  // Апсида: полукупол.
  for (let x = CAT.ax + 1; x <= CAT.ax + 6; x++) {
    for (let z = zc - 6; z <= zc + 6; z++) {
      const r = Math.hypot(x - CAT.ax, z - zc)
      if (r > 5.5) continue
      const yv = vaultProfile[Math.min(5, Math.round(r))]
      for (let y = yv; y <= naveTop; y++) B.S(x, y, z, T)
      if (r >= 1) B.S(x, yv, z, stairs(T, dirTo(x - CAT.ax, z - zc, true), 'top'))
    }
  }
  // Стены трансепта (x = −2 и 10 при |dz| 12..18) и торцы (|dz| = 18).
  for (let z = zc - 18; z <= zc + 18; z++) {
    const dz = dzOf(z)
    if (dz < 11) continue
    for (const x of [CAT.xC0, CAT.xC1]) for (let y = F; y <= naveTop; y++) B.S(x, y, z, T)
  }
  for (const s of [-1, 1]) {
    const z = zc + s * 18
    for (let x = CAT.xC0; x <= CAT.xC1; x++) for (let y = F; y <= naveTop; y++) B.S(x, y, z, T)
    for (let x = CAT.xC0 + 1; x <= CAT.xC1 - 1; x++) for (let zz = zc + s * 7; s < 0 ? zz >= zc + s * 17 : zz <= zc + s * 17; zz += s) for (let y = F; y < 50; y++) if (dzOf(zz) >= 7) B.S(x, y, zz, '')
  }
  // Приделы в трансепте открыты: убрать стены |dz| = 11 внутри трансепта
  // (их там и нет), открыть проход нефа в трансепт — аркада средокрестия.
  for (let z = zc - 17; z <= zc + 17; z++) for (let x = CAT.xC0 + 1; x <= CAT.xC1 - 1; x++) for (let y = F; y < 50; y++) if (dzOf(z) <= 17) B.S(x, y, z, '')
  for (let x = CAT.xC0 + 1; x <= CAT.xC1 - 1; x++) for (let z = zc - 17; z <= zc + 17; z++) { const dz = dzOf(z); const yv = dz <= 5 ? vaultProfile[dz] : vaultProfile[Math.round(Math.abs(x - 4))]; for (let y = F; y < Math.min(yv, 50); y++) B.S(x, y, z, '') }
  // Внутри нефа — воздух под сводом.
  for (let x = CAT.xW + 1; x <= CAT.ax + 5; x++) {
    for (let z = zc - 5; z <= zc + 5; z++) {
      if (x > CAT.ax && Math.hypot(x - CAT.ax, z - zc) > 5.5) continue
      const dz = dzOf(z)
      const yv = x > CAT.ax ? vaultProfile[Math.min(5, Math.round(Math.hypot(x - CAT.ax, z - zc)))] : vaultProfile[dz]
      for (let y = F; y < yv; y++) B.S(x, y, z, '')
    }
  }
  // Приделы — воздух.
  for (let x = CAT.xT + 1; x <= CAT.ax + 11; x++) {
    for (let z = zc - 10; z <= zc + 10; z++) {
      const dz = dzOf(z)
      const apse = x > CAT.ax
      const r = apse ? Math.hypot(x - CAT.ax, z - zc) : dz
      if (apse ? (r > 6.6 && r <= 10.5) : (dz >= 7 && dz <= 10)) for (let y = F; y < F + 9; y++) B.S(x, y, z, '')
      if (!apse && dz >= 7 && dz <= 10) {
        const toWall = z < zc ? 'north' : 'south'
        if (dz === 10) B.S(x, F + 9, z, stairs(T, toWall, 'top'))
        else if (dz === 7) B.S(x, F + 9, z, stairs(T, OPP[toWall], 'top'))
        else B.S(x, F + 9, z, '')
      }
    }
  }
  // Крыша нефа и хора: 2:1, конёк ~67; трансепт поперёк; апсида — полуконус.
  const roofE = naveTop + 1
  for (let x = CAT.xW + 1; x <= CAT.ax; x++) for (const s of [-1, 1]) { B.S(x, roofE, zc + s * 6, TW) }
  B.gable(CAT.xW + 1, CAT.ax, zc - 5, zc + 5, 'x', roofE, { f: 'deepslate_tiles', slope: 2, gable: T, ov: 0, ends: false })
  B.gable(CAT.xC0 + 1, CAT.xC1 - 1, zc - 17, zc + 17, 'z', roofE, { f: 'deepslate_tiles', slope: 2, gable: T, ov: 0 })
  for (let x = CAT.ax + 1; x <= CAT.ax + 7; x++) {
    for (let z = zc - 7; z <= zc + 7; z++) {
      const r = Math.hypot(x - CAT.ax, z - zc)
      if (r > 6.5) continue
      if (r > 5.5) { B.S(x, roofE, z, TW); continue }
      const yt = roofE - 1 + Math.round((5.5 - r) * 2)
      for (let y = roofE; y < yt; y++) B.S(x, y, z, 'deepslate_tiles')
      B.S(x, yt, z, r < 0.7 ? 'deepslate_tiles' : stairs('deepslate_tiles', dirTo(CAT.ax - x, zc - z, true)))
    }
  }

  // ---- 5. Контрфорсы с пинаклями и аркбутаны.
  const buttress = (x, s) => {
    for (let dzz = 12; dzz <= 14; dzz++) {
      const z = zc + s * dzz
      const topY = dzz === 12 ? F + 21 : dzz === 13 ? F + 17 : F + 12
      for (let y = F - 1; y <= topY; y++) B.S(x, y, z, T)
      B.S(x, F, z, TP)
      B.S(x, topY + 1, z, stairs(T, s < 0 ? 'south' : 'north'))
    }
    B.pinnacle(x, F + 22, zc + s * 12, T, 4)
    B.pinnacle(x, F + 13, zc + s * 14, T, 2)
    // Аркбутан: от контрфорса (|dz| 11, y 48) к стене нефа (|dz| 7, y 52).
    for (let dzz = 7; dzz <= 11; dzz++) {
      const z = zc + s * dzz
      const yt = F + 18 + (11 - dzz)
      B.S(x, yt, z, stairs(T, s < 0 ? 'south' : 'north'))
      B.S(x, yt - 1, z, T)
      if (dzz >= 9) B.S(x, yt - 2, z, stairs(T, s < 0 ? 'north' : 'south', 'top'))
    }
    B.S(x, F + 11, zc + s * 11, T)
  }
  for (const x of [...CAT.piers, 16, CAT.ax]) for (const s of [-1, 1]) buttress(x, s)
  // Контрфорсы апсиды: радиальные.
  for (let k = 0; k < apseAng.length - 1; k++) {
    const a = (apseAng[k] + apseAng[k + 1]) / 2
    const cells = []
    for (let r = 11.5; r <= 14.5; r += 0.25) {
      const x = Math.round(CAT.ax + Math.cos(a) * r); const z = Math.round(zc + Math.sin(a) * r)
      if (!cells.some(c => c[0] === x && c[1] === z)) cells.push([x, z, r])
    }
    cells.forEach(([x, z, r]: any) => {
      const topY = r < 12.5 ? F + 21 : r < 13.5 ? F + 17 : F + 12
      for (let y = F - 1; y <= topY; y++) B.S(x, y, z, T)
      B.S(x, F, z, TP)
    })
    const [px, pz] = cells[0]
    B.pinnacle(px, F + 22, pz, T, 4)
    const [ox, oz] = cells[cells.length - 1]
    B.pinnacle(ox, F + 13, oz, T, 2)
    // Аркбутан к стене апсиды (r 6.6 → 11).
    for (let r = 7; r <= 11; r++) {
      const x = Math.round(CAT.ax + Math.cos(a) * r); const z = Math.round(zc + Math.sin(a) * r)
      const yt = F + 18 + (11 - r)
      B.S(x, yt, z, stairs(T, dirTo(CAT.ax - x, zc - z, true)))
      B.S(x, yt - 1, z, T)
    }
  }

  // ---- 6. Западный фасад: две башни, портал, галерея, роза, фронтон.
  const towerTop = 72
  for (const s of [-1, 1]) {
    const zc0 = zc + s * 12 // центр башни (|dz| 7..17)
    const tx0 = CAT.xW; const tx1 = CAT.xT
    const tz0 = zc0 - 5; const tz1 = zc0 + 5
    for (let x = tx0; x <= tx1; x++) {
      for (let z = tz0; z <= tz1; z++) {
        const edge = x === tx0 || x === tx1 || z === tz0 || z === tz1
        for (let y = F; y <= towerTop; y++) B.S(x, y, z, edge ? T : '')
        if (!edge) B.S(x, towerTop, z, T)
      }
    }
    // Угловые контрфорсы башен со ступенчатыми уступами.
    for (const [cx, cz] of [[tx0, tz0], [tx0, tz1], [tx1, tz0], [tx1, tz1]]) {
      const ox = cx === tx0 ? -1 : 1; const oz = cz === tz0 ? -1 : 1
      if (cx === tx1 && Math.abs(cz - zc) < 8) continue // к нефу
      for (const [bx, bz, depth] of [[cx + ox, cz, 2], [cx, cz + oz, 2]]) {
        for (let y = F; y <= towerTop - 4; y++) {
          const k = y < F + 16 ? 2 : y < F + 32 ? 1 : 0
          if (k >= 1) B.S(bx, y, bz, T)
          if (k >= 2) B.S(bx + (bx === cx ? 0 : ox), y, bz + (bz === cz ? 0 : oz), T)
        }
        B.S(bx + (bx === cx ? 0 : ox), F + 16, bz + (bz === cz ? 0 : oz), stairs(T, bx === cx ? (oz < 0 ? 'south' : 'north') : (ox < 0 ? 'east' : 'west')))
        void depth
      }
      B.pinnacle(cx + ox, towerTop - 3, cz + oz, T, 5)
    }
    // Окна башен: ярусы.
    for (const [Pl, aC] of [[B.plane('z', tx0, 'west'), zc0], [B.plane('x', s < 0 ? tz0 : tz1, s < 0 ? 'north' : 'south'), (tx0 + tx1) / 2]]) {
      B.lancet(Pl, aC - 1, F + 17, 3, 7, { famName: T, glass: glassWin(F + 17, 7), mullion: true, frame: TP })
      // Звонница: две высокие арки с деревянными жалюзи.
      const louver = () => st('spruce_trapdoor', { facing: Pl.in, half: 'top', open: 'false', powered: 'false', waterlogged: 'false' })
      for (const off of [-3, 2]) B.lancet(Pl, aC + off, F + 30, 2, 9, { famName: T, glass: louver, sill: true, frame: TP })
      Pl.set(aC, F + 40, TCB); Pl.set(aC, F + 39, TCB)
      // Глухая аркада внизу (ниши).
      for (const off of [-4, -1, 2]) {
        for (let y = F + 2; y <= F + 9; y++) for (let a = aC + off; a <= aC + off + 1; a++) { Pl.set(a, y, '', 0); Pl.set(a, y, T, -1) }
        for (let a = aC + off; a <= aC + off + 1; a++) Pl.set(a, F + 1, TP, 0)
        Pl.set(aC + off, F + 9, stairs(T, Pl.lo, 'top'), 0); Pl.set(aC + off + 1, F + 9, stairs(T, Pl.hi, 'top'), 0)
      }
    }
    // Карнизные тяги по периметру башни.
    for (const yb of [F + 14, F + 28, towerTop - 1]) {
      for (let x = tx0 - 1; x <= tx1 + 1; x++) {
        for (let z = tz0 - 1; z <= tz1 + 1; z++) {
          const ed = x === tx0 - 1 || x === tx1 + 1 || z === tz0 - 1 || z === tz1 + 1
          if (!ed || B.G(x, yb, z)) continue
          B.S(x, yb, z, stairs(T, x === tx0 - 1 ? 'east' : x === tx1 + 1 ? 'west' : z === tz0 - 1 ? 'south' : 'north', 'top'))
        }
      }
    }
    // Галерея наверху: парапет с ажуром и пинакли по углам.
    for (let x = tx0 - 1; x <= tx1 + 1; x++) for (let z = tz0 - 1; z <= tz1 + 1; z++) {
      const edge = x === tx0 - 1 || x === tx1 + 1 || z === tz0 - 1 || z === tz1 + 1
      if (!edge) continue
      B.S(x, towerTop, z, stairs(T, x === tx0 - 1 ? 'east' : x === tx1 + 1 ? 'west' : z === tz0 - 1 ? 'south' : 'north', 'top'))
      B.S(x, towerTop + 1, z, TW)
    }
    // Винтовая лестница с земли в звонницу: площадки через 7 (30 … 58),
    // первая — к проходу в неф/придел (у восточной стены, ближе к оси).
    const bcx = (tx0 + tx1) / 2
    const land = s < 0 ? 'east' : 'north'
    B.spiral(bcx, zc0, 4.2, F, F + 28, { f: T, rev: 7, landDir: land, newel: T })
    // Пол звонницы (58) — вокруг колодца лестницы и над нижней частью
    // последнего марша (ступени там ниже 55 — голове хватает).
    const land0 = { north: -Math.PI / 2, east: 0 }[land]
    for (let x = tx0 + 1; x < tx1; x++) {
      for (let z = tz0 + 1; z < tz1; z++) {
        const dx = x - bcx; const dz = z - zc0
        if (Math.hypot(dx, dz) > 4.2) { B.S(x, F + 27, z, 'spruce_planks'); continue }
        if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1) continue
        let th = Math.atan2(dz, dx) - land0 + Math.PI / 8
        th = ((th % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
        const sec = Math.floor(th / (2 * Math.PI) * 16) % 16
        if (sec >= 2 && sec <= 9) B.S(x, F + 27, z, 'spruce_planks') // над нижней частью марша — пол (голове хватает)
      }
    }
    // Колокола — на балках под звонницей (y 61), в углах над полом:
    // с пола до языка рукой подать.
    for (const bz of [zc0 - 3, zc0 + 3]) for (let x = tx0 + 1; x < tx1; x++) B.S(x, F + 31, bz, st('dark_oak_log', { axis: 'x' }))
    for (const bx of [tx0 + 1, tx1 - 1]) for (const bz of [zc0 - 3, zc0 + 3]) B.S(bx, F + 30, bz, st('bell', { attachment: 'ceiling', facing: 'north', powered: 'false' }))
    for (let x = tx0 + 1; x < tx1; x++) for (let z = tz0 + 1; z < tz1; z++) B.S(x, F + 37, z, 'dark_oak_planks')
    // Шпилёк.
    B.spire((tx0 + tx1) / 2, zc0, 3.6, towerTop + 1, 14, { f: 'oxidized_cut_copper', grate: 'oxidized_copper_grate', crocket: true, every: 4, cross: 'z' })
  }
  // Центр фасада между башнями: стена x = xW от F до 64.
  const PW = B.plane('z', CAT.xW, 'west')
  for (let z = zc - 6; z <= zc + 6; z++) for (let y = F; y <= 66; y++) B.S(CAT.xW, y, z, T)
  // Стены нефа между башнями (|dz| = 6).
  for (let x = CAT.xW + 1; x <= CAT.xT; x++) for (const s of [-1, 1]) for (let y = F; y <= naveTop; y++) B.S(x, y, zc + s * 6, T)
  // Портал: три ступени архивольтов (x −39, −38, −37), двери в x −37.
  for (let z = zc - 6; z <= zc + 6; z++) for (let y = F - 1; y <= F + 14; y++) { B.S(CAT.xW - 1, y, z, T); B.S(CAT.xW - 2, y, z, T) }
  for (let z = zc - 4; z <= zc + 4; z++) B.S(CAT.xW - 3, F - 1, z, stairs(T, 'east'))
  const portal = (x, half, h) => {
    for (let z = zc - half; z <= zc + half; z++) for (let y = F; y < F + h; y++) B.S(x, y, z, '')
    B.S(x, F + h, zc - half, stairs(T, 'north', 'top')); B.S(x, F + h, zc + half, stairs(T, 'south', 'top'))
    for (let z = zc - half + 1; z <= zc + half - 1; z++) B.S(x, F + h, z, '')
    if (half >= 2) { B.S(x, F + h + 1, zc - half + 1, stairs(T, 'north', 'top')); B.S(x, F + h + 1, zc + half - 1, stairs(T, 'south', 'top')); for (let z = zc - half + 2; z <= zc + half - 2; z++) B.S(x, F + h + 1, z, '') }
    if (half >= 3) { B.S(x, F + h + 2, zc, '') }
  }
  portal(CAT.xW - 2, 5, 10); portal(CAT.xW - 1, 4, 9); portal(CAT.xW, 3, 7)
  // Тимпан над дверьми: всё открытое в арке выше дверей — резной камень.
  for (let z = zc - 3; z <= zc + 3; z++) for (let y = F + 2; y <= F + 10; y++) if (!B.G(CAT.xW, y, z)) B.S(CAT.xW, y, z, (y + z) % 2 ? TCB : TC)
  // Перемычка и резьба до острия арки.
  for (let z = zc - 2; z <= zc + 2; z++) {
    B.S(CAT.xW, F + 2, z, slab(TP, 'top'))
    for (let y = F + 3; y <= F + 7; y++) if (Math.abs(z - zc) + (y - F - 3) <= 3) B.S(CAT.xW, y, z, (y + z) % 2 ? TCB : TC)
  }
  for (let z = zc - 2; z <= zc + 2; z++) { B.door(CAT.xW, F, z, 'east', 'dark_oak_door', z < zc ? 'left' : 'right') }
  for (const z of [zc - 3, zc + 3]) for (let y = F; y <= F + 6; y++) B.S(CAT.xW, y, z, y === F + 6 ? TC : TPW)
  for (const z of [zc - 4, zc + 4]) for (let y = F; y <= F + 7; y++) B.S(CAT.xW - 1, y, z, y === F + 7 ? TC : TPW)
  for (const z of [zc - 5, zc + 5]) for (let y = F; y <= F + 8; y++) B.S(CAT.xW - 2, y, z, y === F + 8 ? TC : TPW)
  // Вимперг — треугольник над порталом.
  for (let i = 0; i <= 6; i++) {
    for (const s of [-1, 1]) B.S(CAT.xW - 2, F + 13 + i, zc + s * (6 - i), stairs(T, s < 0 ? 'south' : 'north'))
    for (let z = zc - (6 - i) + 1; z <= zc + (6 - i) - 1; z++) B.S(CAT.xW - 2, F + 13 + i, z, T)
  }
  B.S(CAT.xW - 3, F + 15, zc, TCB); B.S(CAT.xW - 3, F + 14, zc, stairs(T, 'east', 'top'))
  B.pinnacle(CAT.xW - 2, F + 20, zc, T, 3)
  for (const s of [-1, 1]) B.pinnacle(CAT.xW - 2, F + 15, zc + s * 6, T, 2)
  // Галерея королей: ниши y 47..50 по x −37.
  for (let z = zc - 6; z <= zc + 6; z++) {
    B.S(CAT.xW - 1, F + 16, z, stairs(T, 'east', 'top'))
    B.S(CAT.xW - 1, F + 21, z, stairs(T, 'east', 'top'))
    if ((z - zc) % 2 === 0) { for (let y = F + 17; y <= F + 19; y++) B.S(CAT.xW, y, z, ''); B.S(CAT.xW, F + 17, z, TP); B.S(CAT.xW, F + 18, z, TPW); B.S(CAT.xW, F + 20, z, stairs(T, 'east', 'top')) }
    for (let y = F + 16; y <= F + 21; y++) if ((z - zc) % 2 !== 0) B.S(CAT.xW - 1, y, z, y === F + 16 || y === F + 21 ? stairs(T, 'east', 'top') : TPW)
  }
  // Роза: центр y 58, R 5.
  B.rose(PW, zc, 58, 6.3, { famName: T, spokes: 8, colors: ['yellow', 'blue', 'red', 'blue', 'purple'], ring: TC, boss: TCB })
  // Фронтон над розой и балюстрада.
  for (let z = zc - 6; z <= zc + 6; z++) { B.S(CAT.xW, 65, z, T); B.S(CAT.xW - 1, 65, z, stairs(T, 'east', 'top')); B.S(CAT.xW - 1, 66, z, TW) }
  for (let i = 0; i <= 6; i++) {
    for (let z = zc - (6 - i); z <= zc + (6 - i); z++) B.S(CAT.xW, 66 + i, z, T)
    for (const s of [-1, 1]) B.S(CAT.xW - 1, 67 + i, zc + s * (6 - i), stairs(T, s < 0 ? 'south' : 'north'))
  }
  for (const y of [68, 69]) B.S(CAT.xW, y, zc, 'glass_pane')
  B.pinnacle(CAT.xW - 1, 73, zc, T, 3)

  // ---- 7. Торцы трансепта: портал, роза, фронтон, башенки по углам.
  for (const s of [-1, 1]) {
    const z = zc + s * 18
    const out = s < 0 ? 'north' : 'south'
    const P = B.plane('x', z, out)
    const xm = (CAT.xC0 + CAT.xC1) / 2 // 4
    // Портал.
    for (let x = xm - 2; x <= xm + 2; x++) for (let y = F - 1; y <= F + 9; y++) P.set(x, y, T, 1)
    for (let x = xm - 1; x <= xm + 1; x++) for (let y = F; y <= F + 4; y++) { P.set(x, y, '', 1); P.set(x, y, y === F + 2 ? slab(TP, 'top') : y > F + 2 ? TCB : '', 0) }
    P.set(xm - 1, F + 5, stairs(T, 'west', 'top'), 1); P.set(xm + 1, F + 5, stairs(T, 'east', 'top'), 1); P.set(xm, F + 5, TCB, 1)
    P.set(xm - 1, F + 5, stairs(T, 'west', 'top'), 0); P.set(xm + 1, F + 5, stairs(T, 'east', 'top'), 0); P.set(xm, F + 5, TCB, 0)
    B.door(xm - 1, F, z, OPP[out], 'dark_oak_door', 'left'); B.door(xm, F, z, OPP[out], 'dark_oak_door', 'left'); B.door(xm + 1, F, z, OPP[out], 'dark_oak_door', 'right')
    for (let i = 0; i <= 3; i++) { P.set(xm - (3 - i), F + 10 + i, stairs(T, 'east'), 1); P.set(xm + (3 - i), F + 10 + i, stairs(T, 'west'), 1); for (let x = xm - (3 - i) + 1; x < xm + (3 - i); x++) P.set(x, F + 10 + i, T, 1) }
    B.pinnacle(xm, F + 14, z + s, T, 2)
    // Окна-ланцеты над порталом, роза.
    for (const off of [-4, 3]) B.lancet(P, xm + off, F + 4, 2, 7, { famName: T, glass: glassAisle })
    B.rose(P, xm, 49, 4.6, { famName: T, spokes: 10, colors: ['yellow', 'red', 'blue', 'red', 'blue'], ring: TC, boss: TCB })
    // Фронтон трансепта над кровлей (y 57..67) с ажурным окошком.
    for (let i = 0; i <= 6; i++) {
      for (let x = xm - (6 - i); x <= xm + (6 - i); x++) B.S(x, 57 + i * 1.5 | 0, z, T)
    }
    for (let y = 57; y <= 66; y++) { const hw = Math.max(0, 6 - Math.floor((y - 57) / 1.5)); for (let x = xm - hw; x <= xm + hw; x++) B.S(x, y, z, T); if (hw >= 1) { P.set(xm - hw - 1, y, stairs(T, 'east'), 1); P.set(xm + hw + 1, y, stairs(T, 'west'), 1) } }
    P.set(xm, 60, 'purple_stained_glass_pane'); P.set(xm, 61, 'purple_stained_glass_pane')
    B.pinnacle(xm, 67, z, T, 3)
    // Угловые башенки трансепта.
    for (const cx of [CAT.xC0 - 1, CAT.xC1 + 1]) {
      for (let y = F - 1; y <= 64; y++) { B.S(cx, y, z, T); B.S(cx, y, z + s, T) }
      B.S(cx, 57, z + s, TCB)
      B.pinnacle(cx, 65, z, T, 4)
      B.pinnacle(cx, 58, z + s, T, 2)
    }
  }

  // ---- 8. Башня средокрестия и шпиль.
  const ctop = 73
  const tx0 = CAT.xC0; const tx1 = CAT.xC1; const tz0 = zc - 6; const tz1 = zc + 6
  for (let x = tx0; x <= tx1; x++) {
    for (let z = tz0; z <= tz1; z++) {
      const edge = x === tx0 || x === tx1 || z === tz0 || z === tz1
      for (let y = roofE; y <= ctop; y++) B.S(x, y, z, edge ? T : '')
      if (!edge) B.S(x, ctop, z, T)
    }
  }
  for (const [Pl, a0] of [[B.plane('x', tz0, 'north'), tx0], [B.plane('x', tz1, 'south'), tx0], [B.plane('z', tx0, 'west'), tz0], [B.plane('z', tx1, 'east'), tz0]]) {
    const louver = () => st('spruce_trapdoor', { facing: Pl.in, half: 'top', open: 'false', powered: 'false', waterlogged: 'false' })
    for (const off of [2, 8]) B.lancet(Pl, a0 + off, 61, 3, 8, { famName: T, glass: louver, mullion: true, frame: TP })
    for (let a = a0; a <= a0 + 12; a++) { Pl.set(a, 60, stairs(T, Pl.in, 'top'), 1); Pl.set(a, ctop, stairs(T, Pl.in, 'top'), 1); Pl.set(a, ctop + 1, TW, 1) }
  }
  for (const [cx, cz] of [[tx0, tz0], [tx0, tz1], [tx1, tz0], [tx1, tz1]]) {
    const ox = cx === tx0 ? -1 : 1; const oz = cz === tz0 ? -1 : 1
    for (let y = roofE; y <= ctop; y++) { B.S(cx + ox, y, cz, T); B.S(cx, y, cz + oz, T); B.S(cx + ox, y, cz + oz, T) }
    B.pinnacle(cx + ox, ctop + 1, cz + oz, T, 6)
  }
  B.spire((tx0 + tx1) / 2, zc, 5.6, ctop + 1, 30, { f: 'oxidized_cut_copper', grate: 'oxidized_copper_grate', crocket: true, every: 4, cross: 'z' })

  // ---- 9. Башня-фонарь: свод средокрестия вскрыт до потолка башни (73) —
  // свет золотых витражей падает в собор с высоты ~40 блоков. Потолок —
  // лазурное «небо» с золотым солнцем, от него вниз — лучи (концевые стержни).
  const lx0 = tx0 + 1; const lx1 = tx1 - 1; const lz0 = tz0 + 1; const lz1 = tz1 - 1
  const lcx = (tx0 + tx1) / 2
  for (let x = lx0; x <= lx1; x++) for (let z = lz0; z <= lz1; z++) for (let y = 50; y < ctop; y++) B.S(x, y, z, '')
  for (let x = lx0; x <= lx1; x++) {
    for (let z = lz0; z <= lz1; z++) {
      const dx = x - lcx; const dz = z - zc; const r = Math.hypot(dx, dz)
      const ray = (dx === 0 || dz === 0 || Math.abs(dx) === Math.abs(dz)) && r <= 5.8
      B.S(x, ctop, z, r <= 1.1 ? 'glowstone' : r <= 2.3 ? 'gold_block' : ray ? ((Math.round(r) % 2) ? 'gold_block' : 'yellow_glazed_terracotta') : ((x * 7 + z * 3) % 11 === 0 ? 'glowstone' : 'lapis_block'))
    }
  }
  // Лучи: кольца стержней разной длины, свисают с «неба».
  for (let k = 0; k < 16; k++) {
    const a = k * Math.PI / 8
    for (const [rr, base] of [[2.6, 7], [4.2, 4]]) {
      const x = Math.round(lcx + Math.cos(a) * rr); const z = Math.round(zc + Math.sin(a) * rr)
      if (x < lx0 || x > lx1 || z < lz0 || z > lz1 || B.G(x, ctop - 1, z)) continue
      const len = base + Math.floor(hash(x, 0, z, 91) * 6)
      for (let i = 1; i <= len; i++) B.S(x, ctop - i, z, st('end_rod', { facing: 'down' }))
    }
  }
  // Жалюзи башни — золотые витражи (свет «оттуда»).
  const lantGlass = (a, y) => (y >= 67 ? 'white_stained_glass_pane' : ((a + y) % 4 === 0 ? 'orange_stained_glass_pane' : 'yellow_stained_glass_pane'))
  for (const [Pl, a0] of [[B.plane('x', tz0, 'north'), tx0], [B.plane('x', tz1, 'south'), tx0], [B.plane('z', tx0, 'west'), tz0], [B.plane('z', tx1, 'east'), tz0]]) {
    for (const off of [2, 8]) B.lancet(Pl, a0 + off, 61, 3, 8, { famName: T, glass: lantGlass, mullion: true, frame: TP, sill: false })
  }

  // ---- 10. Окулюс над алтарём: в полукуполе апсиды и кровле — колодец с
  // жёлтым стеклом наверху; из него к престолу свисают лучи.
  const ox = CAT.ax + 2
  for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const x = ox + dx; const z = zc + dz
    let yt = -1
    for (let y = 70; y >= 50; y--) if (B.G(x, y, z)) { yt = y; break }
    const yv = vaultProfile[Math.min(5, Math.round(Math.hypot(x - CAT.ax, z - zc)))]
    for (let y = yv; y < yt; y++) B.S(x, y, z, '')
    B.S(x, yt, z, 'yellow_stained_glass')
    if (dx || dz) B.S(x, yv, z, stairs(TP, dirTo(dx, dz, true), 'top'))
  }
  for (let y = 50; y <= 53; y++) B.S(ox, y, zc, st('end_rod', { facing: 'down' }))
}

// --------------------------------------------------------- убранство собора

function furnishCathedral (ctx) {
  const { B } = ctx
  const F = CAT.F; const zc = ZC
  const { T, TP, TCB } = CAT_PAL[ctx.p.cat] || CAT_PAL.tuff
  // Скамьи в нефе: ряды через 2 по x, лицом к алтарю (на восток).
  for (let x = CAT.xT + 2; x <= CAT.xC0 - 2; x += 2) {
    for (let z = zc - 4; z <= zc + 4; z++) {
      if (Math.abs(z - zc) <= 1) continue
      B.S(x, F, z, stairs('spruce_planks', 'west'))
    }
  }
  // Ковровая дорожка по оси.
  B.carpet(CAT.xW + 1, zc - 1, CAT.ax - 2, zc + 1, F, 'red')
  // Хор: скамьи хора вдоль стен лицом к оси.
  for (let x = CAT.xC1 + 1; x <= CAT.ax - 3; x++) { B.S(x, F, zc - 5, stairs('dark_oak_planks', 'north')); B.S(x, F, zc + 5, stairs('dark_oak_planks', 'south')) }
  // Алтарь на возвышении в апсиде.
  for (let x = CAT.ax - 2; x <= CAT.ax + 4; x++) for (let z = zc - 4; z <= zc + 4; z++) if (Math.hypot(x - CAT.ax, z - zc) <= 5.5 || x <= CAT.ax) B.S(x, F, z, x === CAT.ax - 2 ? stairs(TP, 'east') : TP)
  for (let z = zc - 1; z <= zc + 1; z++) { B.S(CAT.ax + 2, F + 1, z, TCB); B.S(CAT.ax + 2, F + 2, z, 'white_carpet') }
  B.candles(CAT.ax + 2, F + 2, zc - 1, 3); B.candles(CAT.ax + 2, F + 2, zc + 1, 3)
  B.S(CAT.ax + 2, F + 2, zc, 'gold_block')
  B.S(CAT.ax + 1, F + 1, zc - 3, st('lectern', { facing: 'west', has_book: 'false', powered: 'false' }))
  // Золотой крест за алтарём.
  for (let y = F + 3; y <= F + 7; y++) B.S(CAT.ax + 4, y, zc, 'gold_block')
  B.S(CAT.ax + 4, F + 6, zc - 1, 'gold_block'); B.S(CAT.ax + 4, F + 6, zc + 1, 'gold_block')
  // Люстры: по пролёту нефа и хора, в средокрестии — большая.
  for (const x of [-32, -23, -17, -11, -5, 13, 19]) B.chandelier(x, 49 - (x > 10 ? 0 : 0), zc, 5, true)
  B.chandelier(4, 49, zc - 11, 4, true); B.chandelier(4, 49, zc + 11, 4, true)
  // Свет в приделах и обходе: фонари на цепях.
  for (let x = CAT.xT + 3; x <= CAT.ax; x += 6) for (const s of [-1, 1]) B.chandelier(x, F + 8, zc + s * 9, 1, false)
  for (const a of [-1, 0, 1]) { const x = Math.round(CAT.ax + Math.cos(a) * 8.5); const z = Math.round(zc + Math.sin(a) * 8.5); B.chandelier(x, F + 8, z, 1, false) }
  // Купель у входа.
  B.S(CAT.xT - 2, F, zc + 3, TP); B.S(CAT.xT - 2, F + 1, zc + 3, st('water_cauldron', { level: '3' }))
  // Проходы из башен в неф и приделы.
  for (const s of [-1, 1]) for (let y = F; y <= F + 6; y++) { for (let dz = 7; dz <= 10; dz++) B.S(CAT.xT, y, zc + s * dz, y <= F + 5 ? '' : stairs(T, 'west', 'top')) }

  // ---- Кафедра проповедника у последней опоры нефа (x −8, север):
  // помост 3×2 на высоте 3, лесенка с запада, аналой с Евангелием лицом к
  // пастве, резной навес-резонатор с золотым крестом.
  {
    const zp = zc - 5; const zq = zc - 4 // у аркады / над скамьями
    for (let x = -9; x <= -7; x++) {
      for (const z of [zp, zq]) { B.S(x, F, z, TP); B.S(x, F + 1, z, T); B.S(x, F + 2, z, 'dark_oak_planks') }
      B.S(x, F + 1, zq, stairs(T, 'south', 'top')) // резной поясок к нефу
    }
    B.S(-10, F, zp, T); B.S(-10, F + 1, zp, stairs('dark_oak_planks', 'east')); B.S(-11, F, zp, stairs('dark_oak_planks', 'east'))
    B.S(-9, F + 3, zq, 'dark_oak_fence'); B.S(-7, F + 3, zq, 'dark_oak_fence'); B.S(-7, F + 3, zp, 'dark_oak_fence')
    B.S(-8, F + 3, zq, st('lectern', { facing: 'north', has_book: 'true', powered: 'false' }))
    B.nbt(-8, F + 3, zq, '{Book:{id:"written_book",components:{written_book_content:{title:"Евангелие",author:"Иоанн",pages:["И свет во тьме светит, и тьма не объяла его. Ин 1:5"]}}}}')
    for (let x = -9; x <= -7; x++) for (const z of [zp, zq]) B.S(x, F + 6, z, slab('dark_oak_planks', 'top'))
    for (let y = F + 7; y <= F + 9; y++) B.S(-8, y, zp, 'gold_block')
    B.S(-9, F + 8, zp, 'gold_block'); B.S(-7, F + 8, zp, 'gold_block')
  }

  // ---- Распятие над входом в хор (x 11): крест тёмного дуба с золотым
  // средокрестием на цепях из-под свода — видно от портала через весь неф.
  {
    const xr = CAT.xC1 + 1
    for (let y = F + 12; y <= F + 19; y++) B.S(xr, y, zc, st('stripped_dark_oak_log', { axis: 'y' }))
    for (const dz of [-2, -1, 1, 2]) B.S(xr, F + 17, zc + dz, st('stripped_dark_oak_log', { axis: 'z' }))
    B.S(xr, F + 17, zc, 'gold_block')
    B.S(xr - 1, F + 17, zc, st('lantern', { hanging: 'false', waterlogged: 'false' }))
    for (let y = F + 20; y < 55; y++) B.S(xr, y, zc, st('iron_chain', { axis: 'y', waterlogged: 'false' }))
  }

  // ---- Крестный путь: 14 стояний по стенам приделов — крест и табличка
  // у каждого простенка (опоры нефа и хора), по кругу от северо-запада.
  {
    const ST = [['I', 'Иисуса', 'осуждают', 'на смерть'], ['II', 'Иисус', 'берёт крест', ''], ['III', 'Иисус падает', 'в первый раз', ''], ['IV', 'Иисус', 'встречает', 'Мать'],
      ['V', 'Симон', 'помогает', 'нести крест'], ['VI', 'Вероника', 'отирает', 'лик Иисуса'], ['VII', 'Иисус падает', 'во второй раз', ''], ['VIII', 'Иисус', 'утешает', 'женщин'],
      ['IX', 'Иисус падает', 'в третий раз', ''], ['X', 'С Иисуса', 'снимают', 'одежды'], ['XI', 'Иисуса', 'пригвождают', 'ко кресту'], ['XII', 'Иисус', 'умирает', 'на кресте'],
      ['XIII', 'Тело Иисуса', 'снимают', 'с креста'], ['XIV', 'Тело Иисуса', 'полагают', 'во гроб']]
    // Простенки приделов (опоры нефа и хора) — по 6 на сторону, и два — в
    // обходе апсиды между окнами: север с запада на восток, обход, юг обратно.
    const xs = [...CAT.piers, 16, CAT.ax]
    const amb = a => { const x = Math.round(CAT.ax + Math.cos(a) * 10); const z = Math.round(zc + Math.sin(a) * 10); return [x, z, dirTo(CAT.ax - x, zc - z, true)] }
    const spots = [...xs.map(x => [x, zc - 10, 'south']), amb(-Math.PI / 7), amb(Math.PI / 7), ...xs.slice().reverse().map(x => [x, zc + 10, 'north'])]
    spots.forEach(([x, z, face]: any, i) => {
      const [ax, az] = face === 'north' || face === 'south' ? [1, 0] : [0, 1]
      for (let y = F + 3; y <= F + 5; y++) B.S(x, y, z, st('stripped_dark_oak_log', { axis: 'y' }))
      for (const k of [-1, 1]) B.S(x + ax * k, F + 4, z + az * k, st('stripped_dark_oak_log', { axis: ax ? 'x' : 'z' }))
      B.sign(x, F + 2, z, face, ST[i], 'dark_oak')
      B.candles(x, F, z, 1, 'white')
    })
  }
}

export { buildCathedral, furnishCathedral }
