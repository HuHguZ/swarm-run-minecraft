'use strict'
// Терраса S1, дворец и вершина: большая лестница, сад, дворец, западная лестница, куртина, комнаты дворца.

import { st, stairs, slab, OPP, dirTo, LV, SUMMIT, summitSd, PAL, roundTower, tree } from './common'

// ------------------------------------------------ большая лестница S0 → S1

function buildGrandStair (ctx) {
  const { B } = ctx
  // Марш вдоль подпорной стены: z 37..38, от x 25 (y 2) на восток до x 38
  // (верх 16), на арках; площадка x 39, вход на террасу через проём.
  const z0 = 37; const z1 = 38
  B.flight(25, z0, 'east', 2, 'south', LV.S0, 14, { f: 'stone_bricks', fill: 'stone_bricks', yFill: LV.S0 - 1, clear: 4 })
  for (let x = 25; x <= 38; x++) {
    // Арки под маршем (кладовые): проём через два.
    if ((x - 25) % 3 === 1 && x < 36) for (let y = LV.S0; y <= Math.min(LV.S0 + (x - 25) - 2, LV.S0 + 3); y++) B.S(x, y, z1, '')
    // Перила снаружи марша; две нижние ступени — во всю ширину (вход с улицы:
    // с запада марш упирается в стену лавки).
    if (x <= 26) {
      for (let y = LV.S0 - 1; y < LV.S0 + (x - 25); y++) B.S(x, y, z1 + 1, ctx.masonry(x, y, z1 + 1))
      B.S(x, LV.S0 + (x - 25), z1 + 1, stairs('stone_bricks', 'east'))
      continue
    }
    B.S(x, LV.S0 + (x - 25) + 1, z1 + 1, 'stone_brick_wall')
    for (let y = LV.S0 - 1; y <= LV.S0 + (x - 25); y++) B.S(x, y, z1 + 1, ctx.masonry(x, y, z1 + 1))
  }
  // Площадка наверху и проём в парапете террасы.
  for (let z = z0; z <= z1 + 1; z++) for (let y = LV.S0 - 1; y <= LV.S1 - 1; y++) B.S(39, y, z, 'stone_bricks')
  for (let x = 37; x <= 39; x++) for (let y = LV.S1; y <= LV.S1 + 3; y++) B.S(x, y, 36, '')
  B.S(39, LV.S1, z1 + 1, 'stone_brick_wall'); B.S(39, LV.S1, z0, '')
  // Фонари на перилах.
  for (let x = 27; x <= 38; x += 4) B.S(x, LV.S0 + (x - 25) + 2, z1 + 1, st('lantern', { hanging: 'false', waterlogged: 'false' }))
}

// ---------------------------------------------------------------- терраса S1

function buildTerraceS1 (ctx) {
  const { B } = ctx
  const y = LV.S1
  // Парапет с зубцами по краям площадок (где снаружи ниже).
  const byZone = new Map()
  for (const e of ctx.edges) { if (!e.zn.edge) continue; (byZone.get(e.zn) || byZone.set(e.zn, []).get(e.zn)).push(e) }
  for (const [zn, list] of byZone) {
    list.sort((a, b) => a.x - b.x || a.z - b.z)
    list.forEach((e, i) => {
      if (B.G(e.x, zn.top + 1, e.z)) return
      B.S(e.x, zn.top + 1, e.z, 'stone_bricks')
      if ((e.x + e.z) % 2 === 0) B.S(e.x, zn.top + 2, e.z, slab('stone_bricks'))
    })
  }
  // Сад на западе: грядки, дорожки, фонтан; на востоке — деревья и лавки.
  const bed = (x0, z0, x1, z1, crop) => {
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const water = (z === Math.floor((z0 + z1) / 2)) && (x === Math.floor((x0 + x1) / 2))
        B.S(x, y - 1, z, water ? 'water' : 'farmland[moisture=7]')
        if (!water) B.S(x, y, z, st(crop, crop === 'beetroots' ? { age: '3' } : { age: '7' }))
      }
    }
    for (let x = x0 - 1; x <= x1 + 1; x++) for (const z of [z0 - 1, z1 + 1]) B.S(x, y - 1, z, 'spruce_planks')
    for (let z = z0; z <= z1; z++) for (const x of [x0 - 1, x1 + 1]) B.S(x, y - 1, z, 'spruce_planks')
  }
  bed(-47, 29, -43, 31, 'wheat'); bed(-41, 29, -37, 31, 'carrots'); bed(-47, 33, -43, 35, 'potatoes'); bed(-41, 33, -37, 35, 'beetroots')
  // Фонтан перед дворцом.
  const fx = 10; const fz = 32
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const edge = Math.abs(dx) === 2 || Math.abs(dz) === 2
      B.S(fx + dx, y - 1, fz + dz, edge ? 'stone_bricks' : 'water')
      if (edge) B.S(fx + dx, y, fz + dz, slab('stone_bricks'))
    }
  }
  B.S(fx, y - 2, fz, 'stone_bricks'); B.S(fx, y - 1, fz, 'stone_bricks'); B.S(fx, y, fz, 'stone_brick_wall'); B.S(fx, y + 1, fz, 'chiseled_stone_bricks'); B.S(fx, y + 2, fz, 'water')
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) B.S(fx + dx, y + 1, fz + dz, stairs('stone_bricks', dirTo(-dx, -dz, true) === 'east' ? 'west' : OPP[dirTo(dx, dz, true)], 'top'))
  // Деревья на востоке террасы.
  for (const [tx, tz] of [[32, 30], [36, 34], [30, 34]]) tree(B, tx, y, tz, 'oak', 4)
  // Лавки у фонтана.
  B.bench(7, 29, 7, 29, y, 'north', 'spruce_planks'); B.bench(13, 29, 13, 29, y, 'north', 'spruce_planks')
  // Фонари на столбах вдоль террасы.
  for (let x = -44; x <= 40; x += 9) { if (x > -32 && x < 28) continue; B.S(x, y, 36, 'stone_brick_wall'); B.S(x, y + 1, 35, '') }
  for (const x of [-28, -18, -8, 4, 16, 24]) { B.S(x, y, 35, 'stone_brick_wall'); B.S(x, y + 1, 35, 'stone_brick_wall'); B.S(x, y + 2, 35, st('lantern', { hanging: 'false', waterlogged: 'false' })) }
}

// -------------------------------------------------------------------- дворец

function buildPalace (ctx) {
  const { B } = ctx
  const { x0, x1, zN, zS, A, Bf, Cf, top } = PAL
  const M = ctx.masonry
  // Коробка стен, перекрытия.
  for (let x = x0; x <= x1; x++) {
    for (let z = zN; z <= zS; z++) {
      const edge = x === x0 || x === x1 || z === zN || z === zS
      for (let y = A - 1; y <= top; y++) B.S(x, y, z, edge ? M(x, y, z) : '')
      B.S(x, A - 1, z, 'stone_bricks')
      if (!edge) {
        B.S(x, Bf - 1, z, (x % 4 === 0) ? st('stripped_dark_oak_log', { axis: 'z' }) : 'spruce_planks')
        B.S(x, Cf - 1, z, (x % 4 === 0) ? st('stripped_dark_oak_log', { axis: 'z' }) : 'dark_oak_planks')
      }
    }
  }
  // Пояса (карнизы-слезники) по южному фасаду.
  for (let x = x0; x <= x1; x++) {
    for (const y of [Bf - 1, Cf - 1]) { B.S(x, y, zS, 'polished_andesite'); B.S(x, y, zS + 1, stairs('stone_bricks', 'north', 'top')) }
  }
  // Контрфорсы через 6 по югу.
  const bays = []
  for (let x = x0 + 3; x <= x1 - 3; x += 6) bays.push(x)
  const butX = []
  for (let bx = x0; bx <= x1; bx += 6) {
    if (bx === x0 || bx >= x1) continue
    if (bx >= -9 && bx <= 2) continue // винтовая башня и главный вход (x 0..1)
    butX.push(bx)
  }
  // Окна: A — пары с решёткой, B — стрельчатые 3, C — высокие с витражом.
  const PSouth = B.plane('x', zS, 'south'); const PNorth = B.plane('x', zN, 'north')
  const hallGlass = (a, y) => ((a + y) % 5 === 0 ? 'light_blue_stained_glass_pane' : (y > Cf + 4 ? 'yellow_stained_glass_pane' : 'white_stained_glass_pane'))
  const WF = 'polished_diorite' // белые переплёты — как у собора
  for (const c of bays) {
    if (c >= -9 && c <= -1) { // винтовая башня
      B.lancet(PSouth, c - 1, Cf + 2, 3, 5, { famName: WF, glass: hallGlass, mullion: true })
      continue
    }
    B.lancet(PSouth, c, A + 1, 1, 2, { famName: 'stone_bricks', glass: () => 'iron_bars' })
    B.lancet(PSouth, c - 1, Bf + 1, 3, 3, { famName: WF, mullion: true })
    B.lancet(PSouth, c - 1, Cf + 2, 3, 5, { famName: WF, glass: hallGlass, mullion: true, frame: 'polished_diorite' })
  }
  for (const c of bays) B.lancet(PNorth, c - 1, Cf + 2, 3, 4, { famName: WF, glass: hallGlass, mullion: true })
  // Главный вход (A) — двойная дверь x 0..1 с порталом.
  B.door(0, A, zS, 'north', 'dark_oak_door', 'left'); B.door(1, A, zS, 'north', 'dark_oak_door', 'right')
  for (let y = A; y <= A + 3; y++) { B.S(-1, y, zS + 1, 'chiseled_stone_bricks'); B.S(2, y, zS + 1, 'chiseled_stone_bricks') }
  B.S(0, A + 2, zS, 'stone_bricks'); B.S(1, A + 2, zS, 'stone_bricks')
  B.S(0, A + 3, zS + 1, stairs('stone_bricks', 'west', 'top')); B.S(1, A + 3, zS + 1, stairs('stone_bricks', 'east', 'top'))
  B.S(0, A + 4, zS + 1, 'chiseled_stone_bricks'); B.S(1, A + 4, zS + 1, 'chiseled_stone_bricks')
  B.banner(-1, A + 5, zS + 1, 'south', 'red'); B.banner(2, A + 5, zS + 1, 'south', 'red')
  B.S(-1, A + 6, zS + 1, 'stone_bricks'); B.S(2, A + 6, zS + 1, 'stone_bricks')
  // Двери на вершину (C, север) — к собору.
  for (const dx of [-5, 17]) { B.door(dx, Cf, zN, 'south', 'dark_oak_door'); B.S(dx, Cf + 2, zN, stairs('stone_bricks', 'north', 'top')) }
  // Верх: машикули и зубцы по югу, ход по стене; крыша 2:1.
  for (let x = x0; x <= x1; x++) {
    B.S(x, top, zS + 1, stairs('stone_bricks', 'north', 'top'))
    B.S(x, top + 1, zS + 1, (x % 2) ? 'stone_bricks' : slab('stone_bricks', 'top'))
    B.S(x, top + 2, zS + 1, 'stone_bricks')
    if (x % 2 === 0) B.S(x, top + 3, zS + 1, slab('stone_bricks'))
    B.S(x, top + 1, zS, 'stone_bricks')
  }
  // Контрфорсы: два уступа, над парапетом — пинакли.
  for (const bx of butX) {
    for (let y = A - 1; y <= top + 3; y++) B.S(bx, y, zS + 1, M(bx, y, zS + 1))
    for (let y = A - 1; y <= Bf + 2; y++) B.S(bx, y, zS + 2, M(bx, y, zS + 2))
    B.S(bx, Bf + 3, zS + 2, stairs('stone_bricks', 'north'))
    B.S(bx, A + 2, zS + 3, stairs('stone_bricks', 'north')); for (let y = A - 1; y <= A + 1; y++) B.S(bx, y, zS + 3, M(bx, y, zS + 3))
    B.pinnacle(bx, top + 4, zS + 1, 'stone_bricks', 3, 'chiseled_stone_bricks')
  }
  B.gable(x0, x1, zN, zS - 1, 'x', top + 2, { f: 'deepslate_tiles', slope: 2, gable: 'stone_bricks', ov: 0, ridge: 'deepslate_tile_wall' })
  // Трубы каминов (кухня, горница, зал) — над коньком.
  for (const cx of [-28, 1, 10]) {
    for (let y = top + 1; y <= top + 11; y++) for (const dx of [0, 1]) for (const dz of [0, 1]) B.S(cx + dx, y, zN + dz, 'bricks')
    for (const dx of [-1, 0, 1, 2]) for (const dz of [-1, 0, 1, 2]) if (dx < 0 || dx > 1 || dz < 0 || dz > 1) B.S(cx + dx, top + 11, zN + dz, stairs('stone_bricks', dx < 0 ? 'east' : dx > 1 ? 'west' : dz < 0 ? 'south' : 'north', 'top'))
    B.S(cx, top + 12, zN, st('campfire', { facing: 'north', lit: 'true', signal_fire: 'false', waterlogged: 'false' }))
  }
  // Слуховые окна (люкарны) на южном скате над каждой второй аркой.
  for (const c of bays.filter(c => !(c >= -9 && c <= -1))) {
    const zc = zS - 2
    for (let dx = -1; dx <= 1; dx++) for (let y = top + 3; y <= top + 5; y++) B.S(c + dx, y, zc, dx === 0 && y < top + 5 ? 'glass_pane' : 'stone_bricks')
    B.S(c - 1, top + 6, zc, stairs('deepslate_tiles', 'east')); B.S(c + 1, top + 6, zc, stairs('deepslate_tiles', 'west')); B.S(c, top + 6, zc, 'deepslate_tiles'); B.S(c, top + 7, zc, slab('deepslate_tiles'))
    B.S(c, top + 7, zc - 1, 'deepslate_tiles'); B.pinnacle(c, top + 8, zc, 'stone_bricks', 1)
  }
  // Угловые башни и винтовая лестница.
  const lvls = [A - 1, Bf - 1, Cf - 1]
  roundTower(ctx, { cx: x0, cz: zS, r: 4.5, yTop: top + 6, yFloor0: A, floors: lvls, ladder: false, cone: { k: 2.2, f: 'deepslate_tiles' }, windows: [{ y: Bf + 1, h: 3, angles: [Math.PI * 0.75, Math.PI] }, { y: Cf + 2, h: 4, angles: [Math.PI * 0.6, Math.PI, Math.PI * 1.25] }, { y: A + 2, h: 2, angles: [Math.PI * 0.75] }] })
  roundTower(ctx, { cx: x1, cz: zS, r: 4.5, yTop: top + 6, yFloor0: A, floors: lvls, ladder: false, cone: { k: 2.2, f: 'deepslate_tiles' }, windows: [{ y: Bf + 1, h: 3, angles: [Math.PI * 0.25, 0] }, { y: Cf + 2, h: 4, angles: [Math.PI * 0.4, 0, -Math.PI * 0.25] }, { y: A + 2, h: 2, angles: [Math.PI * 0.25] }] })
  // Проходы из угловых башен во дворец на каждом этаже.
  // Кольцо башни (r 4.5 вокруг угла) входит в комнату дугой; дверь — там,
  // где кольцо в один блок: x ±4 от центра, z = zS − 1.
  for (const [tx, sx] of [[x0, 1], [x1, -1]]) {
    for (const ly of [A, Bf, Cf]) B.door(tx + sx * 4, ly, zS - 1, sx > 0 ? 'east' : 'west', 'spruce_door')
  }
  // Винтовая башня у входа: центр (−5, 30).
  const tcx = -5; const tcz = 30
  roundTower(ctx, { cx: tcx, cz: tcz, r: 4.5, yTop: top + 4, yFloor0: A, floors: [], crenel: false, cone: { k: 2.4, f: 'deepslate_tiles' }, windows: [{ y: A + 3, h: 2, angles: [Math.PI / 2] }, { y: Bf + 3, h: 2, angles: [Math.PI / 2 + 0.7] }, { y: Cf + 3, h: 3, angles: [Math.PI / 2 - 0.7, Math.PI / 2 + 0.7] }] })
  B.spiral(tcx, tcz, 3.4, A, Cf + 7, { f: 'stone_bricks', rev: 7, landDir: 'north' })
  for (const ly of [A, Bf, Cf]) {
    for (let z = zS - 1; z <= zS + 1; z++) for (let y = ly; y <= ly + 2; y++) B.S(tcx, y, z, '')
    B.door(tcx, ly, zS - 1, 'north', 'spruce_door')
    B.S(tcx, ly - 1, zS, 'stone_bricks'); B.S(tcx, ly - 1, zS + 1, 'stone_bricks')
  }
  // Перегородки этажей и комнаты.
  furnishPalace(ctx)
}

// ------------------------------------------------ западная лестница S1 → S2

function buildWestStair (ctx) {
  const { B } = ctx
  // x −48..−46 (3 шириной), с z 31 (пол 16) на север до z 18 (верх 30).
  const xs = -48; const w = 3
  B.flight(xs, 31, 'north', w, 'east', LV.S1, 14, { f: 'stone_bricks', fill: 'stone_bricks', yFill: -18 })
  for (let i = 0; i < 14; i++) {
    const z = 31 - i; const y = LV.S1 + i
    for (const x of [xs - 1, xs + w]) {
      for (let yy = -18; yy <= y; yy++) B.S(x, yy, z, ctx.masonry(x, yy, z))
      B.S(x, y + 1, z, 'stone_brick_wall')
    }
    for (let x = xs; x < xs + w; x++) for (let yy = y + 1; yy <= y + 4; yy++) B.S(x, yy, z, '')
  }
  // Проём в парапете сверху и снизу.
  for (let x = xs; x < xs + w; x++) { for (let y = LV.S2; y <= LV.S2 + 2; y++) { B.S(x, y, 17, ''); B.S(x, y, 16, '') } B.S(x, LV.S2 - 1, 17, 'stone_bricks') }
  for (const z of [22, 27]) for (const x of [xs - 1, xs + w]) B.S(x, LV.S1 + (31 - z) + 2, z, st('lantern', { hanging: 'false', waterlogged: 'false' }))
}

// ---------------------------------------------------- куртина на вершине

function buildSummitWalls (ctx) {
  const { B, Hat } = ctx
  const y = LV.S2
  // Парапет по краю плато (клетки плато, у которых сосед снаружи ниже).
  for (let x = SUMMIT.x0 - 1; x <= SUMMIT.x1 + 1; x++) {
    for (let z = SUMMIT.z0 - 1; z <= SUMMIT.z1 + 1; z++) {
      if (summitSd(x, z) > 0) continue
      if (x >= PAL.x0 - 1 && x <= PAL.x1 + 1 && z >= 14) continue // дворец
      if (x >= -49 && x <= -44 && z >= 14) continue
      let edge = false
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (summitSd(x + dx, z + dz) > 0 && Hat(x + dx, z + dz) < y - 2) edge = true
      if (!edge) continue
      for (let yy = y - 4; yy < y; yy++) B.S(x, yy, z, ctx.masonry(x, yy, z))
      B.S(x, y, z, 'stone_bricks')
      if ((x + z) % 2 === 0) { B.S(x, y + 1, z, 'stone_bricks'); B.S(x, y + 2, z, slab('stone_bricks')) } else B.S(x, y + 1, z, slab('stone_bricks'))
    }
  }
  // Башни по краю.
  const towers = [[-47, -30, 5], [-8, -35, 4.5], [37, -30, 5], [45, -7, 4.5]]
  for (const [cx, cz, r] of towers) {
    const dirIn = dirTo(-cx, -cz - 9, true)
    roundTower(ctx, {
      cx, cz, r, yTop: y + 11, yFloor0: y, floors: [y + 5], cone: { k: 2.2, f: 'deepslate_tiles' },
      windows: [{ y: y + 2, h: 2, angles: [Math.atan2(cz + 9, cx), Math.atan2(cz + 9, cx) + 1.2, Math.atan2(cz + 9, cx) - 1.2] }, { y: y + 7, h: 2, angles: [Math.atan2(cz + 9, cx), Math.atan2(cz + 9, cx) + 1.6, Math.atan2(cz + 9, cx) - 1.6] }],
      doors: [{ y, dir: dirIn }]
    })
    B.lanternHang(cx, y + 4, cz); B.lanternHang(cx, y + 10, cz)
  }
}

// ------------------------------------------------------------ комнаты дворца

// Кнопки железной двери (x, y, z) в северной стене: на полу по обе стороны
// прямо перед дверью — сосед нижней половины, дверь получает сигнал.
function ironButtons (B, x, y, z) {
  B.S(x, y, z + 1, st('stone_button', { face: 'floor', facing: 'north', powered: 'false' }))
  B.S(x, y, z - 1, st('stone_button', { face: 'floor', facing: 'north', powered: 'false' }))
}

function furnishPalace (ctx) {
  const { B } = ctx
  const { x0, x1, zN, zS, A, Bf, Cf } = PAL
  const iz0 = zN + 1; const iz1 = zS - 1 // 17..26
  const M = ctx.masonry
  const part = (x, y0, y1, doorZ) => {
    for (let z = iz0; z <= iz1; z++) for (let y = y0; y <= y1; y++) B.S(x, y, z, M(x, y, z))
    if (doorZ !== undefined) B.door(x, y0, doorZ, 'east', 'spruce_door')
  }
  // ---- Этаж A (16): кухня | кладовая | караульня (вход) | оружейная | амбар.
  part(-17, A, Bf - 2, 21); part(-9, A, Bf - 2, 21); part(3, A, Bf - 2, 21); part(13, A, Bf - 2, 21)
  // Кухня x −29..−18: очаг у западной стены, печи, коптильни, стол, бочки.
  for (let z = 19; z <= 24; z++) { B.S(-29, A, z, 'bricks'); B.S(-29, A + 4, z, 'bricks') }
  for (let z = 20; z <= 23; z++) { B.S(-29, A, z, 'campfire[facing=east,lit=true,signal_fire=false,waterlogged=false]'); for (let y = A + 1; y <= A + 3; y++) B.S(-29, y, z, '') }
  for (let z = 19; z <= 24; z++) B.S(-28, A + 4, z, stairs('bricks', 'west', 'top'))
  for (let y = A; y <= Bf + 10; y++) for (let z = 20; z <= 23; z++) if (y > A + 4) B.S(-30, y, z, 'bricks')
  for (let x = -27; x <= -23; x++) { B.S(x, A, 17, st(x % 2 ? 'smoker' : 'furnace', { facing: 'south', lit: 'true' })) }
  for (let x = -27; x <= -23; x++) B.S(x, A + 1, 17, 'bricks')
  B.table(-26, 21, -21, 22, A, 'spruce_planks')
  for (let z = 23; z <= 26; z++) { B.barrel(-19, A, z); B.barrel(-19, A + 1, z) }
  B.S(-24, A, 26, st('water_cauldron', { level: '3' })); B.S(-23, A, 26, 'crafting_table'); B.S(-22, A, 26, st('decorated_pot', { facing: 'north', cracked: 'false', waterlogged: 'false' })) // (−25, 26) — дверь башни
  B.chandelier(-23, Bf - 2, 21, 1, false); B.lanternHang(-20, Bf - 2, 18)
  // Кладовая x −16..−10: сундуки рядами, бочки.
  for (let x = -15; x <= -11; x += 2) { B.chest2(x, A, 17, 'south'); B.chest2(x, A + 1, 17, 'south') } // пары (x, x − 1); x −17 — перегородка
  for (let x = -16; x <= -10; x++) { B.barrel(x, A, 26, 'north') }
  // Стеллаж посередине (x −15..−12): проходы к дверям x −17 и −9 (z 21) свободны.
  for (const x of [-14, -12]) B.chest2(x, A, 22, 'south')
  for (const x of [-15, -13]) B.chest2(x, A, 21, 'north')
  B.lanternHang(-13, Bf - 2, 19); B.lanternHang(-13, Bf - 2, 24)
  B.sign(-12, A + 2, 18, 'south', ['', 'Кладовая', '', ''])
  // Караульня x −8..2: столы, стойки, вход во дворец и к лестнице.
  B.table(-6, 20, -2, 20, A, 'spruce_planks'); B.bench(-6, 19, -2, 19, A, 'south'); B.bench(-6, 21, -2, 21, A, 'north')
  B.S(2, A, 17, 'cartography_table'); B.chest2(-7, A, 17, 'south')
  B.chandelier(-3, Bf - 2, 21, 1, true)
  // Двери в погреба (север, этаж A): темница и цистерна.
  // Железная дверь в темницу — в углу кладовой (x −10), мимо сундуков.
  B.door(-10, A, zN, 'north', 'iron_door'); B.S(-10, A + 2, zN, 'stone_bricks')
  for (let z = zN - 1; z >= 15; z--) for (let y = A; y <= A + 2; y++) B.S(-10, y, z, '')
  ironButtons(B, -10, A, zN)
  B.door(1, A, zN, 'north', 'spruce_door')
  for (let z = zN - 1; z >= 15; z--) for (let y = A; y <= A + 2; y++) B.S(1, y, z, '')
  // Оружейная x 4..12: стойки для брони (сущности — в списке), точило, наковальня.
  B.S(5, A, 17, 'smithing_table'); B.S(6, A, 17, st('grindstone', { face: 'floor', facing: 'south' })); B.S(7, A, 17, st('anvil', { facing: 'east' }))
  for (let x = 8; x <= 12; x += 2) B.chest2(x, A, 17, 'south')
  B.S(12, A, 26, 'fletching_table'); for (let x = 5; x <= 11; x++) B.S(x, A, 26, st('spruce_trapdoor', { facing: 'north', half: 'bottom', open: 'false', powered: 'false', waterlogged: 'false' }))
  B.chandelier(8, Bf - 2, 21, 1, true)
  ctx.armorStands = [[5, A, 24, 'north'], [7, A, 24, 'north'], [9, A, 24, 'north'], [11, A, 24, 'north']]
  // Амбар x 14..25: сено, мешки (бочки), компостер.
  for (let x = 20; x <= 25; x++) for (let z = 17; z <= 20; z++) for (let y = A; y <= A + ((x + z) % 3 === 0 ? 2 : 1); y++) B.S(x, y, z, 'hay_block')
  for (let x = 15; x <= 18; x++) { B.barrel(x, A, 17); B.barrel(x, A + 1, 17) }
  B.S(15, A, 25, st('composter', { level: '0' })); B.chest2(16, A, 26, 'north')
  B.lanternHang(19, Bf - 2, 22)

  // ---- Этаж B (23): гостевые | библиотека | горница | опочивальня.
  part(-17, Bf, Cf - 2, 21); part(-1, Bf, Cf - 2, 21); part(13, Bf, Cf - 2, 21)
  // Гостевые x −29..−18.
  B.bed(-28, Bf, 18, 'south', 'blue'); B.bed(-25, Bf, 18, 'south', 'green'); B.bed(-22, Bf, 18, 'south', 'yellow')
  for (const x of [-27, -24, -21]) B.chest(x, Bf, 17, 'south')
  B.carpet(-28, 22, -19, 25, Bf, 'light_gray')
  B.lanternHang(-24, Cf - 2, 22)
  // Библиотека x −16..−2: полки по стенам, кафедры, стол зачарования в нише.
  for (let x = -16; x <= -2; x++) for (let y = Bf; y <= Bf + 3; y++) { if (x % 5 !== 0 && Math.abs(x + 14) > 1) B.S(x, y, 17, (x + y) % 3 ? 'bookshelf' : st('chiseled_bookshelf', { facing: 'south', slot_0_occupied: 'true', slot_1_occupied: 'true', slot_2_occupied: 'false', slot_3_occupied: 'true', slot_4_occupied: 'false', slot_5_occupied: 'true' })) }
  // Ниша зачарования: стол, вокруг — 15 полок через один воздух.
  const ex = -9; const ez = 23
  B.S(ex, Bf, ez, 'enchanting_table')
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== 2) continue
    if (dz === 2 && Math.abs(dx) <= 1) continue // вход
    B.S(ex + dx, Bf, ez + dz, 'bookshelf'); if (dz === -2 || Math.abs(dx) === 2) B.S(ex + dx, Bf + 1, ez + dz, 'bookshelf')
  }
  for (const [lx, lz] of [[-14, 21], [-4, 21]]) B.S(lx, Bf, lz, st('lectern', { facing: 'south', has_book: 'false', powered: 'false' }))
  B.table(-15, 24, -13, 25, Bf, 'dark_oak_planks'); B.bench(-15, 26, -13, 26, Bf, 'north', 'dark_oak_planks')
  B.candles(-14, Bf + 1, 24, 3); B.candles(-4, Bf + 1, 24, 2)
  B.table(-4, 23, -2, 24, Bf, 'dark_oak_planks') // клетка (−5, 25) — выход с винтовой лестницы
  B.chandelier(-12, Cf - 2, 21, 1, true); B.chandelier(-5, Cf - 2, 21, 1, false)
  // Горница x 0..12: камин, ковёр, кресла, стол.
  // Камин x 8..12 (дверь в винный погреб — x 4, в стороне).
  for (let x = 8; x <= 12; x++) { B.S(x, Bf, 17, 'bricks'); B.S(x, Bf + 3, 17, 'bricks') }
  for (let x = 9; x <= 11; x++) { B.S(x, Bf, 17, 'campfire[facing=south,lit=true,signal_fire=false,waterlogged=false]'); B.S(x, Bf + 1, 17, ''); B.S(x, Bf + 2, 17, '') }
  for (let x = 8; x <= 12; x++) B.S(x, Bf + 3, 18, stairs('bricks', 'north', 'top'))
  B.carpet(3, 20, 11, 25, Bf, 'red')
  B.bench(8, 23, 8, 23, Bf, 'west', 'dark_oak_planks'); B.bench(12, 23, 12, 23, Bf, 'east', 'dark_oak_planks') // кресла у торцов стола; (12, 21) — дверь
  B.table(9, 23, 11, 23, Bf, 'dark_oak_planks'); B.candles(10, Bf + 1, 23, 3)
  B.chandelier(9, Cf - 2, 22, 1, true)
  // Опочивальня x 14..25: кровать с балдахином, сундуки, эндер-сундук.
  const bx = 19; const bz = 18
  B.bed(bx, Bf, bz + 1, 'north', 'red'); B.bed(bx + 1, Bf, bz + 1, 'north', 'red')
  for (const [px, pz] of [[bx - 1, bz], [bx + 2, bz], [bx - 1, bz + 2], [bx + 2, bz + 2]]) { B.S(px, Bf, pz, 'dark_oak_fence'); B.S(px, Bf + 1, pz, 'dark_oak_fence'); B.S(px, Bf + 2, pz, 'dark_oak_fence') }
  for (let x = bx - 1; x <= bx + 2; x++) for (let z = bz; z <= bz + 2; z++) B.S(x, Bf + 3, z, 'red_wool')
  B.chest2(17, Bf, 17, 'south'); B.chest2(15, Bf, 26, 'north'); B.S(24, Bf, 17, st('ender_chest', { facing: 'south', waterlogged: 'false' })) // x 15 — дверь в сокровищницу
  B.carpet(15, 21, 24, 25, Bf, 'purple')
  B.S(23, Bf, 17, 'crafting_table'); B.S(24, Bf, 23, st('lectern', { facing: 'west', has_book: 'false', powered: 'false' })) // (24, 25) — выход из башни
  B.chandelier(20, Cf - 2, 23, 1, true)
  // Двери в погреба (север, этаж B): склад, винный погреб, сокровищница.
  for (const [dx, mat] of [[-14, 'spruce_door'], [4, 'spruce_door'], [15, 'iron_door']]) {
    B.door(dx, Bf, zN, 'north', mat)
    for (let z = zN - 1; z >= 15; z--) for (let y = Bf; y <= Bf + 2; y++) B.S(dx, y, z, '')
    if (mat === 'iron_door') ironButtons(B, dx, Bf, zN)
  }

  // ---- Этаж C (30): совет/сокровищница-казна | большой зал.
  part(-13, Cf, PAL.top - 1, 21)
  // Совет x −29..−14: круглый стол, кресла, карты, флаги.
  B.table(-24, 20, -19, 23, Cf, 'dark_oak_planks')
  for (let x = -24; x <= -19; x++) { B.S(x, Cf, 19, stairs('dark_oak_planks', 'north')); B.S(x, Cf, 24, stairs('dark_oak_planks', 'south')) }
  B.S(-25, Cf, 21, stairs('dark_oak_planks', 'west')); B.S(-25, Cf, 22, stairs('dark_oak_planks', 'west'))
  B.S(-28, Cf, 17, 'cartography_table'); B.chest2(-17, Cf, 17, 'south')
  B.chandelier(-21, PAL.top - 1, 21, 3, true)
  for (const x of [-27, -23, -19, -15]) B.banner(x, Cf + 4, iz0, 'south', 'blue')
  // Большой зал x −12..25: помост с троном на востоке, длинные столы, камины, флаги.
  B.carpet(-11, 21, 20, 22, Cf, 'red')
  // Длинные столы вдоль стен; южный — с разрывом у двери винтовой лестницы (x −5).
  for (const zt of [18, 25]) {
    for (const [a, b] of zt === 25 ? [[-9, -7], [-3, 17]] : [[-9, 17]]) {
      B.table(a, zt, b, zt, Cf, 'dark_oak_planks')
      B.bench(a, zt + (zt === 18 ? 1 : -1), b, zt + (zt === 18 ? 1 : -1), Cf, zt === 18 ? 'south' : 'north', 'spruce_planks')
    }
    for (let x = -8; x <= 16; x += 4) if (x !== -4) B.candles(x, Cf + 1, zt, 3)
  }
  // Помост z 17..23; у южной стены (z 24..26) — проход к двери угловой башни.
  for (let x = 21; x <= 25; x++) for (let z = iz0; z <= 23; z++) B.S(x, Cf, z, x === 21 || z === 23 ? stairs('polished_andesite', x === 21 ? 'east' : 'north') : 'polished_andesite')
  B.table(23, 18, 23, 20, Cf + 1, 'dark_oak_planks')
  B.S(25, Cf + 1, 21, stairs('quartz_stairs', 'east')); B.S(25, Cf + 1, 22, stairs('quartz_stairs', 'east'))
  B.S(25, Cf + 2, 21, 'gold_block'); B.S(25, Cf + 2, 22, 'gold_block')
  for (const z of [18, 25]) B.banner(26 - 1, Cf + 4, z, 'west', 'red')
  // Камины у северной стены.
  for (const cx of [1, 10]) { // дверь на вершину — x −5 и 17, камины в стороне
    for (let x = cx - 2; x <= cx + 2; x++) { B.S(x, Cf, 17, 'bricks'); B.S(x, Cf + 4, 17, 'bricks'); B.S(x, Cf + 4, 18, stairs('bricks', 'north', 'top')) }
    for (let x = cx - 1; x <= cx + 1; x++) { B.S(x, Cf, 17, 'campfire[facing=south,lit=true,signal_fire=false,waterlogged=false]'); for (let y = Cf + 1; y <= Cf + 3; y++) B.S(x, y, 17, '') }
  }
  for (const x of [-10, 2, 8, 14, 20]) { B.banner(x, Cf + 5, iz1, 'north', 'red'); B.banner(x, Cf + 5, iz0, 'south', 'red') }
  for (const x of [-8, -1, 6, 13, 20]) B.chandelier(x, PAL.top - 1, 21, 3, true)
  // Сундуки стражи у входов.
  B.chest(-11, Cf, 17, 'south')
}

export { buildGrandStair, buildTerraceS1, buildPalace, buildWestStair, buildSummitWalls, ironButtons, furnishPalace }
