'use strict'
// Замок у моря и нижний город: погреба, морская стена, ворота, капкан, город и дома, убранство погребов.

import { st, stairs, slab, hash, LV, roundTower } from './common'

// ------------------------------------------------------------------ погреба

function buildCellars (ctx) {
  const { B } = ctx
  const M = ctx.masonry
  // Помещение в скале: коробка с облицовкой, сводом (перевёрнутые ступени
  // вдоль длинных стен) и столбами через каждые 4.
  const vault = (x0, y0, z0, x1, y1, z1, { floor = 'stone_bricks', pillars = true, axis = 'x' }: any = {} as Record<string, any>) => {
    B.box(x0 - 1, y0 - 1, z0 - 1, x1 + 1, y1 + 1, z1 + 1, 'stone_bricks')
    for (let x = x0 - 1; x <= x1 + 1; x++) for (let y = y0 - 1; y <= y1 + 1; y++) for (let z = z0 - 1; z <= z1 + 1; z++) B.S(x, y, z, M(x, y, z))
    B.air(x0, y0, z0, x1, y1, z1)
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) B.S(x, y0 - 1, z, (x + z) % 2 ? floor : 'polished_andesite')
    // Свод: у длинных стен под потолком — перевёрнутые ступени.
    if (axis === 'x') {
      for (let x = x0; x <= x1; x++) { B.S(x, y1, z0, stairs('stone_bricks', 'north', 'top')); B.S(x, y1, z1, stairs('stone_bricks', 'south', 'top')) }
    } else {
      for (let z = z0; z <= z1; z++) { B.S(x0, y1, z, stairs('stone_bricks', 'west', 'top')); B.S(x1, y1, z, stairs('stone_bricks', 'east', 'top')) }
    }
    if (pillars) {
      for (let x = x0 + 4; x <= x1 - 4; x += 5) {
        for (let z = z0 + 4; z <= z1 - 4; z += 5) {
          B.column(x, z, y0, y1, 'polished_andesite')
          B.S(x, y1, z, 'chiseled_stone_bricks')
          for (const [dx, dz, f] of [[1, 0, 'west'], [-1, 0, 'east'], [0, 1, 'north'], [0, -1, 'south']]) B.S(x + dx, y1, z + dz, stairs('stone_bricks', f, 'top'))
        }
      }
    }
  }
  ctx.cellar = {} as Record<string, any>
  // Этаж 23 (пол — y 22): большой склад, винный погреб, сокровищница.
  vault(-25, 23, 4, -3, 27, 14) // склад
  vault(-1, 23, 4, 9, 27, 14, { pillars: false }) // винный погреб
  vault(11, 23, 7, 19, 26, 14, { pillars: false }) // сокровищница
  // Этаж 16 (пол — y 15): темница и цистерна.
  vault(-25, 16, 5, -9, 20, 14, { pillars: false }) // темница
  vault(-6, 16, 3, 10, 21, 14) // цистерна
  ctx.cellar = { store: [-25, 23, 4, -3, 27, 14], wine: [-1, 23, 4, 9, 27, 14], treasury: [11, 23, 7, 19, 26, 14], dungeon: [-25, 16, 5, -9, 20, 14], cistern: [-6, 16, 3, 10, 21, 14] }
}

// ------------------------------------------------------------- морская стена

function buildSeaWall (ctx) {
  const { B } = ctx
  const M = ctx.masonry
  const x0 = -43; const x1 = 39
  // Тело стены z 48..50 от дна до y 10; обход поверху.
  for (let x = x0; x <= x1; x++) {
    for (let z = 48; z <= 50; z++) {
      for (let y = -18; y <= 10; y++) B.S(x, y, z, M(x, y, z))
    }
    // Машикули: консоли на z 51 (y 9), парапет над ними.
    B.S(x, 9, 51, stairs('stone_bricks', 'north', 'top'))
    B.S(x, 10, 51, x % 2 ? 'stone_bricks' : slab('stone_bricks', 'top'))
    B.S(x, 11, 51, 'stone_bricks')
    if (x % 2 === 0) B.S(x, 12, 51, slab('stone_bricks'))
    // Внутренний край — низкий бортик.
    B.S(x, 11, 47, slab('stone_bricks'))
  }
  // Боковые стены квартала (x −44 и 40) от стены до подпорной стены.
  for (const x of [x0 - 1, x1 + 1]) {
    for (let z = 36; z <= 50; z++) {
      for (let y = -18; y <= 10; y++) B.S(x, y, z, M(x, y, z))
      B.S(x, 11, z, 'stone_bricks'); if (z % 2 === 0) B.S(x, 12, z, slab('stone_bricks'))
    }
  }
  // Лестницы на обход: вдоль внутренней грани стены (z 47), подъём 9.
  B.flight(-30, 47, 'east', 1, 'north', 2, 9, { f: 'stone_bricks', fill: 'stone_bricks', yFill: 1 })
  B.flight(28, 47, 'west', 1, 'north', 2, 9, { f: 'stone_bricks', fill: 'stone_bricks', yFill: 1 })
  // Башни.
  const towers = [[-44, 49, true], [-18, 51, false], [16, 51, false], [40, 49, true]]
  for (const [cx, cz, corner] of (towers as Array<any>)) {
    roundTower(ctx, {
      cx, cz, r: corner ? 5 : 4, yTop: corner ? 18 : 15, yBase: -18, yFloor0: 2, floors: [10], roofFloor: 'stone_bricks',
      cone: corner ? { k: 2, f: 'deepslate_tiles' } : null,
      windows: [{ y: 4, h: 2, angles: [Math.PI / 2, Math.PI / 2 - 0.9, Math.PI / 2 + 0.9] }, { y: 12, h: 2, angles: [Math.PI / 2, 0, Math.PI] }],
      doors: [{ y: 11, dir: 'east', door: false }, { y: 11, dir: 'west', door: false }]
    })
    // Дверь с улицы: башня стоит на стыке боковой и морской стен, прямой
    // выход на север упёрся бы в боковую стену — дверь в клетке у её края.
    if (corner) {
      const dxs = cx < 0 ? 1 : -1
      for (const z of [44, 45, 46]) for (let y = 2; y <= 4; y++) B.S(cx + dxs, y, z, '')
      B.door(cx + dxs, 2, 45, 'north', 'spruce_door'); B.S(cx + dxs, 4, 45, stairs('stone_bricks', 'south', 'top'))
    }
  }
}

// --------------------------------------------------------------- ворота

function buildGate (ctx) {
  const { B } = ctx
  const M = ctx.masonry
  // Дамба: x −2..2 от ворот на юг до края; откосы ступенями.
  for (let z = 52; z <= 70; z++) {
    for (let x = -6; x <= 6; x++) {
      if (Math.hypot(x, z) > 68.5) continue
      const ax = Math.abs(x)
      let top
      if (ax <= 2) top = 1
      else if (ax === 3) top = 1
      else if (ax === 4) top = 0
      else if (ax === 5) top = -1
      else top = -2
      for (let y = -18; y <= top; y++) B.S(x, y, z, M(x, y, z))
      if (ax <= 2) B.S(x, 1, z, (x + z) % 3 === 0 ? 'polished_andesite' : 'stone_bricks')
      if (ax === 3) { B.S(x, 2, z, 'stone_brick_wall') }
      if (ax >= 4 && ax <= 5) B.S(x, top, z, stairs('stone_bricks', x > 0 ? 'west' : 'east'))
    }
    if (z % 6 === 0 && z >= 60) for (const x of [-3, 3]) { B.S(x, 3, z, 'stone_brick_wall'); B.S(x, 4, z, st('lantern', { hanging: 'false', waterlogged: 'false' })) }
  }
  // Ров перед воротами (z 55..57) под подъёмным мостом.
  for (let z = 55; z <= 57; z++) {
    for (let x = -3; x <= 3; x++) {
      for (let y = -6; y <= 1; y++) B.S(x, y, z, y <= -1 ? 'water' : '')
      B.S(x, -7, z, 'stone_bricks')
    }
    for (let x = -2; x <= 2; x++) B.S(x, 1, z, 'spruce_planks') // мост опущен
    for (const x of [-3, 3]) B.S(x, 2, z, 'spruce_fence')
  }
  // Надвратный корпус x −5..5, z 46..54.
  for (let x = -5; x <= 5; x++) {
    for (let z = 46; z <= 54; z++) {
      for (let y = -18; y <= 17; y++) B.S(x, y, z, M(x, y, z))
    }
  }
  // Проезд x −1..1, y 2..6, стрельчатый верх.
  for (let z = 46; z <= 54; z++) {
    for (let x = -1; x <= 1; x++) { for (let y = 2; y <= 6; y++) B.S(x, y, z, ''); B.S(x, 1, z, 'stone_bricks') }
    B.S(-1, 7, z, stairs('stone_bricks', 'west', 'top')); B.S(1, 7, z, stairs('stone_bricks', 'east', 'top')); B.S(0, 7, z, '')
  }
  // Решётка поднята: видна верхняя часть.
  for (let x = -1; x <= 1; x++) { B.S(x, 6, 53, 'iron_bars'); B.S(x, 7, 53, 'iron_bars') }
  // Обрамление арки снаружи и изнутри.
  for (const z of [55, 45]) {
    const out = z === 55 ? 'south' : 'north'
    for (let y = 2; y <= 8; y++) { B.S(-2, y, z, 'chiseled_stone_bricks'); B.S(2, y, z, 'chiseled_stone_bricks') }
    B.S(-1, 8, z, stairs('stone_bricks', 'west', 'top')); B.S(1, 8, z, stairs('stone_bricks', 'east', 'top')); B.S(0, 8, z, 'chiseled_stone_bricks'); B.S(0, 9, z, 'chiseled_stone_bricks')
    void out
  }
  // Караульня над проездом: y 9..15, окна на юг.
  B.air(-4, 9, 47, 4, 14, 53)
  for (let x = -4; x <= 4; x++) for (let z = 47; z <= 53; z++) B.S(x, 8, z, 'spruce_planks')
  for (const x of [-3, 0, 3]) { B.S(x, 11, 54, 'glass_pane'); B.S(x, 12, 54, 'glass_pane'); B.S(x, 13, 54, stairs('stone_bricks', 'south', 'top')) }
  // Верх: машикули и зубцы по периметру.
  const per = []
  for (let x = -6; x <= 6; x++) per.push([x, 55])
  for (let z = 54; z >= 45; z--) per.push([6, z])
  for (let x = 6; x >= -6; x--) per.push([x, 45])
  for (let z = 45; z <= 54; z++) per.push([-6, z])
  per.forEach(([x, z]: any) => {
    const dirIn = z === 55 ? 'north' : z === 45 ? 'south' : x === 6 ? 'west' : 'east'
    B.S(x, 16, z, stairs('stone_bricks', dirIn, 'top'))
    B.S(x, 17, z, 'stone_bricks')
  })
  B.crenel(per, 18, 'stone_bricks')
  for (let x = -5; x <= 5; x++) for (let z = 46; z <= 54; z++) B.S(x, 17, z, 'stone_bricks')
  // Флаги над воротами.
  B.banner(-3, 13, 56, 'south', 'blue'); B.banner(3, 13, 56, 'south', 'blue')
  B.S(-3, 14, 55, 'stone_bricks'); B.S(3, 14, 55, 'stone_bricks')
  // Башни по бокам ворот.
  for (const sx of [-1, 1]) {
    roundTower(ctx, {
      cx: sx * 6, cz: 55, r: 3.5, yTop: 21, yBase: -18, yFloor0: 9, floors: [15], cone: { k: 2.2, f: 'deepslate_tiles' },
      windows: [{ y: 4, h: 2, angles: [Math.PI / 2] }, { y: 11, h: 2, angles: [Math.PI / 2, sx > 0 ? 0 : Math.PI] }, { y: 17, h: 2, angles: [Math.PI / 2] }]
    })
  }
  // Вход в караульню с обхода морской стены (y 11, z 49): двери в боковых
  // стенах корпуса, внутри — площадка и ступень вниз к полу (y 9).
  for (const sx of [-1, 1]) {
    B.door(sx * 5, 11, 49, sx < 0 ? 'east' : 'west', 'spruce_door'); B.S(sx * 5, 13, 49, 'stone_bricks')
    B.S(sx * 4, 9, 49, 'stone_bricks'); B.S(sx * 4, 10, 49, 'stone_bricks'); B.S(sx * 4, 11, 49, ''); B.S(sx * 4, 12, 49, '')
    B.S(sx * 4, 9, 50, stairs('stone_bricks', 'north'))
  }
  // Проходы из караульни в боковые башни ворот (угол x ±4, z 53 — кольцо башни).
  for (const sx of [-1, 1]) { B.S(sx * 4, 9, 53, ''); B.S(sx * 4, 10, 53, '') }
  // Фонари в проезде.
  B.lanternHang(0, 6, 48); B.lanternHang(0, 6, 51)
  // Кольцо света у ворот.
  B.S(-2, 5, 56, st('wall_torch', { facing: 'south' })); B.S(2, 5, 56, st('wall_torch', { facing: 'south' }))
}

// ------------------------------------------------------- привратный капкан
//
//   Ультимативная ловушка замка: гость входит через подъёмный мост над рвом
//   в проезд надвратной башни (killbox x −1..1, y 2..6, z 46..54). Три
//   ступени, всё редстоуном, управление и сброс — из караульни наверху:
//     1) мост-провал: центр настила на липких поршнях; растяжка на мосту
//        (z 56) убирает настил — падение в ров с магмой на дне;
//     2) двойная решётка: растяжка в проезде (z 52) роняет обе решётки
//        (железные прутья на липких поршнях у z 54 и z 46) — killbox заперт;
//     3) «кипящая смола» и стрелы: потолочные раздатчики с лавой в машикулях
//        (x 0, z 48/50/52) и боковые раздатчики со стрелами в бойницах стен.
//   Параметр p.trap: 'armed' — взведена (как строится в мире), 'sprung' —
//   показать сработавшей (для рендера). Скрытая проводка в толще стен;
//   тонкую доводку поршней/решёток делаем на сервере после постройки.
function buildTrap (ctx) {
  const { B, p } = ctx
  const sprung = p.trap === 'sprung'
  // Редстоун-примитивы (block states 1.21).
  const wire = () => st('redstone_wire', { power: '0', north: 'none', south: 'none', east: 'none', west: 'none' })
  const spis = (facing, ext) => st('sticky_piston', { facing, extended: ext ? 'true' : 'false' })
  const disp = facing => st('dispenser', { facing, triggered: 'false' })
  const lever = (face, facing, on) => st('lever', { face, facing, powered: on ? 'true' : 'false' })
  const rwall = (facing, lit) => st('redstone_wall_torch', { facing, lit: lit ? 'true' : 'false' })
  const trip = () => st('tripwire', { attached: 'true', disarmed: 'false', east: 'false', north: 'true', south: 'true', west: 'false', powered: sprung ? 'true' : 'false' })
  const hook = (facing) => st('tripwire_hook', { facing, attached: 'true', powered: sprung ? 'true' : 'false' })

  // ===== 1. Мост-провал над рвом (z 55..57) =====
  // Края x ±2 — неподвижный камень-парапет; центр x −1..1 — настил из люков
  // (крышки), что распахиваются от рычага/растяжки: под ними ров с магмой.
  const deck = open => st('spruce_trapdoor', { facing: 'north', half: 'bottom', open: open ? 'true' : 'false', powered: sprung ? 'true' : 'false', waterlogged: 'false' })
  for (let z = 55; z <= 57; z++) {
    for (const x of [-2, 2]) B.S(x, 1, z, 'stone_bricks') // парапет-рельсы
    for (let x = -1; x <= 1; x++) {
      B.S(x, 1, z, deck(sprung)) // взведена — люк закрыт (проход); сработала — распахнут
      B.S(x, 0, z, ''); B.S(x, -6, z, 'magma_block') // «кипящее» дно рва под водой
    }
  }
  // Растяжка поперёк моста (z 56, y 2) с крючками на парапете.
  B.S(-2, 2, 56, hook('east')); B.S(2, 2, 56, hook('west'))
  for (let x = -1; x <= 1; x++) B.S(x, 2, 56, trip())

  // ===== 2. Двойная решётка (guillotine) на липких поршнях =====
  // zg 53 — вход со стороны рва, zg 47 — выход во двор. Взведена: прутья
  // подняты в потолочную нишу (y 7,8), липкий поршень над ними убран (в
  // караульне); сработала — поршень гонит прутья вниз, проём y 2..6 заперт.
  for (const zg of [53, 47]) {
    for (let x = -1; x <= 1; x++) {
      for (let y = 2; y <= 8; y++) B.S(x, y, zg, '') // очистить проём и нишу
      if (sprung) { for (let y = 2; y <= 6; y++) B.S(x, y, zg, 'iron_bars'); B.S(x, 8, zg, spis('down', true)) } // решётка опущена, поршень выдвинут
      else { B.S(x, 7, zg, 'iron_bars'); B.S(x, 8, zg, 'iron_bars'); B.S(x, 9, zg, spis('down', false)) } // решётка поднята, поршень-лебёдка в караульне
      B.S(x, 10, zg, 'redstone_block') // источник для поршня-лебёдки
    }
  }
  // Растяжка-триггер в проезде (z 51): роняет обе решётки и запускает раздатчики.
  B.S(-2, 2, 51, hook('east')); B.S(2, 2, 51, hook('west'))
  for (let x = -1; x <= 1; x++) B.S(x, 2, 51, trip())

  // ===== 3. «Кипящая смола» и стрелы =====
  // Потолочные раздатчики с лавой в машикулях по оси.
  for (const z of [48, 50, 52]) {
    B.S(0, 7, z, ''); B.S(0, 8, z, disp('down'))
    if (sprung) for (let y = 3; y <= 6; y++) B.S(0, y, z, 'lava') // льётся лава
  }
  // Боковые бойницы со стрелами: раздатчики в стенах x −2 / x 2 бьют в проём.
  for (const z of [48, 51]) {
    B.S(-2, 4, z, disp('east')); B.S(-3, 4, z, wire())
    B.S(2, 4, z, disp('west')); B.S(3, 4, z, wire())
    // Узкие смотровые щели наружу — только видимость бойницы.
    B.S(-2, 5, z, 'stone_brick_wall'); B.S(2, 5, z, 'stone_brick_wall')
  }

  // ===== Проводка и пульт в караульне (y 8..9) =====
  // Вертикальные шахты редстоуна в толще боковых стен (x ±2..±3) — от пола
  // караульни к поршням/раздатчикам; подробная доводка — на сервере.
  for (const x of [-3, 3]) for (let y = 5; y <= 8; y++) B.S(x, y, 50, wire())
  // Пульт: три рычага на приподнятой стойке у северной стены караульни,
  // с табличками. Взведена — все рычаги в исходном (капкан готов).
  const px = -3; const pz = 48
  for (let i = 0; i < 3; i++) {
    B.S(px + i, 8, pz, 'polished_andesite'); B.S(px + i, 9, pz, lever('floor', 'south', false))
    B.S(px + i, 8, pz + 1, wire())
  }
  B.sign(px, 10, pz - 1, 'south', ['', 'МОСТ', 'РЕШЁТКИ', 'ЛАВА'])
  B.S(px, 8, pz + 2, rwall('south', true))
  // Аварийный сброс (поднять всё) — рычаг у окна.
  B.S(2, 10, 53, lever('wall', 'north', false))

  // ===== Тайная ловушка сокровищницы: провал-каменный мешок =====
  trapTreasury(ctx)
}

// Сокровищница (x 11..19, пол y 22): под приманкой-золотом плита; шаг на неё
// убирает пол-плиты (липкие поршни), вор падает в каменный мешок (oubliette)
// на 10 блоков ниже — решётки, паутина, кости; сверху захлопывается люк.
function trapTreasury (ctx) {
  const { B, p } = ctx
  const sprung = p.trap === 'sprung'
  const wire = () => st('redstone_wire', { power: '0', north: 'none', south: 'none', east: 'none', west: 'none' })
  const spis = (facing, ext) => st('sticky_piston', { facing, extended: ext ? 'true' : 'false' })
  // Каменный мешок под сокровищницей: шахта x 14..16, z 9..11, дно y 12.
  B.box(13, 11, 8, 17, 21, 12, 'stone_bricks')
  B.air(14, 12, 9, 16, 21, 11)
  for (let x = 14; x <= 16; x++) for (let z = 9; z <= 11; z++) B.S(x, 12, z, 'polished_andesite') // дно
  // Решётки-стены каземата и цепи по углам.
  for (let y = 13; y <= 20; y++) for (let x = 14; x <= 16; x++) for (const z of [9, 11]) if (!(x === 15)) B.S(x, y, z, 'iron_bars')
  for (let y = 13; y <= 20; y++) for (const x of [14, 16]) B.S(x, y, 10, 'iron_bars')
  // Обстановка каменного мешка: солома, паутина, кости, череп — «прежние гости».
  B.S(15, 12, 10, 'hay_block'); B.S(14, 13, 9, 'cobweb'); B.S(16, 13, 11, 'cobweb')
  B.S(14, 12, 11, st('bone_block', { axis: 'y' })); B.S(16, 12, 9, st('skeleton_skull', { rotation: '8', powered: 'false' }))
  B.S(15, 15, 10, st('iron_chain', { axis: 'y', waterlogged: 'false' })); B.S(15, 16, 10, st('iron_chain', { axis: 'y', waterlogged: 'false' }))
  // Пол-приманка (y 22) над шахтой: липкие поршни утягивают плиты вниз.
  for (let x = 14; x <= 16; x++) for (let z = 9; z <= 11; z++) {
    B.S(x, 21, z, spis('up', !sprung)) // поршень под плитой
    B.S(x, 22, z, sprung ? '' : ((x + z) % 2 ? 'polished_andesite' : 'smooth_stone')) // плита пола
    B.S(x, 20, z, wire())
  }
  // Приманка: золото и эндер-сундук уже стоят рядом (15,z11); добавим кучу золота.
  if (!sprung) { B.S(15, 23, 10, 'gold_block'); B.S(14, 23, 10, 'gold_block'); B.S(16, 23, 10, 'gold_block') }
  // Скрытая нажимная плита-приманка перед золотом.
  if (!sprung) B.S(15, 23, 11, st('polished_blackstone_pressure_plate', { powered: 'false' }))
  B.sign(12, 24, 10, 'east', ['', 'Не бери', 'золото', ''])
}

// -------------------------------------------------------------- нижний город

function buildTown (ctx) {
  const { B } = ctx
  const y0 = LV.S0
  // Улица: мостовая уже есть; колодец на площади.
  const well = (cx, cz) => {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const x = cx + dx; const z = cz + dz
        if (dx === 0 && dz === 0) { for (let y = -6; y <= y0 - 1; y++) B.S(x, y, z, 'water'); continue }
        B.S(x, y0, z, 'stone_bricks'); B.S(x, y0 + 1, z, slab('stone_bricks'))
      }
    }
    for (const [dx, dz] of [[-1, -1], [1, 1]]) { B.S(cx + dx, y0 + 2, cz + dz, 'spruce_fence'); B.S(cx + dx, y0 + 3, cz + dz, 'spruce_fence') }
    B.S(cx - 1, y0 + 4, cz - 1, stairs('spruce_planks', 'east')); B.S(cx, y0 + 4, cz, slab('spruce_planks')); B.S(cx + 1, y0 + 4, cz + 1, stairs('spruce_planks', 'west'))
    B.S(cx, y0 + 3, cz, st('iron_chain', { axis: 'y', waterlogged: 'false' }))
    B.S(cx, y0 + 2, cz, st('lantern', { hanging: 'true', waterlogged: 'false' }))
  }
  well(0, 41)
  // Дома: ряд вдоль подпорной стены (z 37..42), фасад на улицу (z 42),
  // верхний этаж — фахверк с выносом на улицу (z 43).
  const houses = [
    { x0: -42, x1: -33, kind: 'stable', roof: 'spruce_planks', ridge: 'x' },
    { x0: -31, x1: -24, kind: 'smithy', roof: 'deepslate_tiles', ridge: 'z' },
    { x0: -22, x1: -16, kind: 'bakery', roof: 'bricks', ridge: 'z' },
    { x0: -14, x1: -8, kind: 'house', roof: 'deepslate_tiles', ridge: 'z' },
    { x0: 8, x1: 17, kind: 'inn', roof: 'bricks', ridge: 'x' },
    { x0: 19, x1: 24, kind: 'shop', roof: 'deepslate_tiles', ridge: 'z' }
  ]
  ctx.houses = houses
  for (const h of houses) house(ctx, h)
}

function house (ctx, h) {
  const { B } = ctx
  const y0 = LV.S0
  const { x0, x1 } = h
  const z0 = 37; const z1 = 42
  const up0 = y0 + 5 // пол второго этажа (блок)
  const top = up0 + 5 // верх стен
  const stone = (x, y, z) => hash(x, y, z, 77) < 0.3 ? 'cobblestone' : hash(x, y, z, 78) < 0.2 ? 'mossy_cobblestone' : 'stone_bricks'
  const frame = 'stripped_dark_oak_log'
  const plaster = 'white_terracotta'
  const stable = h.kind === 'stable'
  // Первый этаж — камень.
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      const edge = x === x0 || x === x1 || z === z0 || z === z1
      for (let y = y0; y < up0; y++) B.S(x, y, z, edge ? stone(x, y, z) : '')
      B.S(x, y0 - 1, z, stable ? 'coarse_dirt' : 'spruce_planks')
      if (!stable) B.S(x, up0, z, 'spruce_planks')
    }
  }
  // Второй этаж — фахверк с выносом на улицу (z1 + 1).
  const zf = z1 + 1
  if (!stable) {
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= zf; z++) {
        const edge = x === x0 || x === x1 || z === z0 || z === zf
        B.S(x, up0, z, 'spruce_planks')
        for (let y = up0 + 1; y <= top; y++) {
          if (!edge) { B.S(x, y, z, ''); continue }
          const post = x === x0 || x === x1 || (z === zf && (x - x0) % 3 === 0) || (z === z0)
          const beam = y === up0 + 1 || y === top
          const diag = z === zf && ((x - x0) % 3 === 1 && y === up0 + 2)
          B.S(x, y, z, post ? st(frame, { axis: 'y' }) : beam ? st(frame, { axis: 'x' }) : diag ? st(frame, { axis: 'x' }) : plaster)
        }
      }
      B.S(x, up0 - 1, zf, stairs('dark_oak_planks', 'north', 'top')) // консоли выноса
    }
    B.S(x0, up0, zf, st(frame, { axis: 'z' })); B.S(x1, up0, zf, st(frame, { axis: 'z' }))
  }
  // Крыша.
  const rz1 = stable ? z1 : zf
  const ye = (stable ? up0 : top) + 1
  const sl = stable ? 1 : 2
  if (h.ridge === 'x') B.gable(x0, x1, z0, rz1, 'x', ye, { f: h.roof, slope: sl, gable: stable ? 'spruce_planks' : plaster })
  else B.gable(x0, x1, z0, rz1, 'z', ye, { f: h.roof, slope: sl, gable: stable ? 'spruce_planks' : plaster })
  // Дымоход у задней стены.
  if (!stable) { const cx = x0 + 1; for (let y = y0; y <= top + 9; y++) B.S(cx, y, z0, 'bricks'); B.S(cx, top + 10, z0, st('campfire', { facing: 'north', lit: 'true', signal_fire: 'false', waterlogged: 'false' })) }
  // Дверь, окна первого этажа.
  const dx = Math.floor((x0 + x1) / 2)
  if (stable) {
    for (let x = dx - 1; x <= dx + 1; x++) for (let y = y0; y <= y0 + 2; y++) B.S(x, y, z1, '')
    B.S(dx - 1, y0 + 3, z1, stairs('spruce_planks', 'west', 'top')); B.S(dx + 1, y0 + 3, z1, stairs('spruce_planks', 'east', 'top'))
  } else {
    B.door(dx, y0, z1, 'north', 'spruce_door')
    B.S(dx, y0 + 2, z1, stairs('stone_bricks', 'south', 'top'))
  }
  for (const wx of [x0 + 1, x1 - 1]) if (Math.abs(wx - dx) > 1) { B.S(wx, y0 + 1, z1, 'glass_pane'); B.S(wx, y0 + 2, z1, 'glass_pane'); B.S(wx, y0 + 3, z1 + 1, st('spruce_trapdoor', { facing: 'south', half: 'top', open: 'false', powered: 'false', waterlogged: 'false' })) }
  if (!stable) for (let x = x0 + 1; x < x1; x += 2) { B.S(x, up0 + 2, zf, 'glass_pane'); B.S(x, up0 + 3, zf, 'glass_pane') }
  // Вывеска.
  const names = { stable: 'Конюшня', smithy: 'Кузница', bakery: 'Пекарня', house: 'Дом', inn: 'Таверна', shop: 'Лавка' }
  B.sign(dx + 1 <= x1 - 1 ? dx + 1 : dx - 1, y0 + 2, z1 + 1, 'south', ['', names[h.kind], '', ''])
  furnishHouse(ctx, h, { z0, z1, zf, up0, top })
}

function furnishHouse (ctx, h, { z0, z1, zf, up0 }: any) {
  const { B } = ctx
  const y = LV.S0
  const { x0, x1 } = h
  const ix0 = x0 + 1; const ix1 = x1 - 1; const iz0 = z0 + 1; const iz1 = z1 - 1 // низ: z 38..41
  const upY = up0 + 1
  const dx = Math.floor((x0 + x1) / 2) // дверь (z1) — от неё к задней стене сквозной проход x = dx
  // Всё стоит вдоль стен: задняя (z iz0), боковые (x ix0 / ix1); проход x = dx
  // и клетка перед лестницей свободны.
  if (h.kind === 'stable') {
    // Денники у задней стены (глубина 2) за заборами-перегородками; у каждого
    // сено и поилка. Передний ряд (z 40..41) — проход от ворот.
    const stalls = [[ix0, ix0 + 1], [ix0 + 3, ix0 + 4], [ix0 + 6, ix0 + 7]]
    for (const [a, b] of stalls) {
      B.S(a, y, iz0, 'hay_block'); B.S(b, y, iz0, st('water_cauldron', { level: '3' }))
      if (b + 1 < ix1) for (let z = iz0; z <= iz0 + 1; z++) B.S(b + 1, y, z, 'spruce_fence')
    }
    B.S(ix1, y, iz0, 'hay_block'); B.S(ix1, y + 1, iz0, 'hay_block')
    B.S(ix0, y, iz1, st('composter', { level: '0' })); B.chest(ix1, y, iz1, 'west')
    B.lanternHang(dx, up0 - 1, iz0 + 2)
    return
  }
  // Лестница в дальнем левом углу, люк над ней; подход — справа (ix0 + 1, iz0).
  for (let yy = y; yy <= up0; yy++) B.S(ix0, yy, iz0, st('ladder', { facing: 'south', waterlogged: 'false' }))
  const put = (x, z, s) => { if (x === dx || (x === ix0 + 1 && z === iz0) || (x === ix0 && z === iz0)) return; B.S(x, y, z, s) }
  const hood = (xa, xb) => { for (let x = xa; x <= xb; x++) B.S(x, y + 1, iz0, 'bricks') }
  if (h.kind === 'smithy') {
    // Горн у задней стены справа, наковальня и точило — вдоль правой стены,
    // закалка (вода, лава) — у левой.
    put(ix1, iz0, st('blast_furnace', { facing: 'south', lit: 'true' })); put(ix1 - 1, iz0, st('furnace', { facing: 'south', lit: 'false' })); hood(ix1 - 1, ix1)
    put(ix1 - 2, iz0, 'smithing_table')
    put(ix1, iz0 + 1, st('anvil', { facing: 'north' })); put(ix1, iz0 + 2, st('grindstone', { face: 'floor', facing: 'west' })); put(ix1, iz1, st('chest', { facing: 'west', type: 'single', waterlogged: 'false' }))
    put(ix0, iz0 + 2, st('water_cauldron', { level: '3' })); put(ix0, iz1, 'lava_cauldron')
  } else if (h.kind === 'bakery') {
    // Печи с кирпичным колпаком у задней стены, мука и зерно в бочках справа,
    // столик для теста у левой стены.
    put(ix1, iz0, st('smoker', { facing: 'south', lit: 'true' })); put(ix1 - 1, iz0, st('furnace', { facing: 'south', lit: 'true' })); hood(ix1 - 1, ix1)
    put(ix1, iz0 + 1, 'crafting_table'); B.barrel(ix1, y, iz0 + 2, 'west'); B.barrel(ix1, y, iz1, 'west'); B.barrel(ix1, y + 1, iz1, 'up')
    put(ix0, iz0 + 2, 'hay_block'); B.table(ix0, iz1, ix0, iz1, y, 'spruce_planks')
  } else if (h.kind === 'house') {
    // Кухня у задней стены, обеденный стол со скамьёй — у левой.
    put(ix1, iz0, st('furnace', { facing: 'south', lit: 'false' })); put(ix1 - 1, iz0, 'crafting_table')
    B.barrel(ix1, y, iz0 + 1, 'west'); put(ix1, iz1, st('chest', { facing: 'west', type: 'single', waterlogged: 'false' }))
    B.table(ix0, iz0 + 2, ix0, iz1, y, 'oak_planks'); B.bench(ix0 + 1, iz0 + 2, ix0 + 1, iz1, y, 'east', 'oak_planks')
  } else if (h.kind === 'inn') {
    // Стойка с бочками справа у задней стены, два стола со скамьями по
    // сторонам прохода, коптильня у лестницы.
    for (let x = dx + 2; x <= ix1; x++) { B.barrel(x, y, iz0, 'south'); B.barrel(x, y + 1, iz0, 'south') }
    B.table(dx + 2, iz0 + 1, ix1 - 1, iz0 + 1, y, 'spruce_planks')
    put(dx - 1, iz0, st('smoker', { facing: 'south', lit: 'true' }))
    B.table(ix0 + 1, iz0 + 2, ix0 + 1, iz1, y, 'spruce_planks'); B.bench(ix0, iz0 + 2, ix0, iz1, y, 'west', 'spruce_planks')
    B.table(ix1 - 1, iz0 + 2, ix1 - 1, iz1, y, 'spruce_planks'); B.bench(ix1, iz0 + 2, ix1, iz1, y, 'east', 'spruce_planks')
    B.candles(ix0 + 1, y + 1, iz0 + 2, 3); B.candles(ix1 - 1, y + 1, iz1, 3)
  } else if (h.kind === 'shop') {
    // Мастерская лавки у задней стены, товар — в бочках и сундуке справа,
    // прилавок слева у входа.
    put(ix1, iz0, st('loom', { facing: 'south' })); put(ix1, iz0 + 1, 'fletching_table')
    B.barrel(ix1, y, iz0 + 2, 'west'); put(ix1, iz1, st('chest', { facing: 'west', type: 'single', waterlogged: 'false' }))
    put(ix0, iz0 + 2, 'cartography_table'); B.table(ix0, iz1, ix0, iz1, y, 'spruce_planks')
  }
  B.lanternHang(dx, up0 - 1, iz0 + 2)
  // Второй этаж (z 38..42): кровати изголовьем к задней стене, сундуки у
  // фасада, ковёр посередине; вокруг люка (ix0, iz0) свободно.
  const beds = h.kind === 'inn' ? [ix0 + 2, ix0 + 3, ix1 - 1, ix1] : [ix1]
  const colors = ['red', 'blue', 'green', 'yellow']
  beds.forEach((bx, i) => B.bed(bx, upY, iz0 + 1, 'north', colors[i % 4]))
  B.chest(ix1, upY, zf - 1, 'north')
  if (h.kind === 'inn') B.chest(ix0 + 2, upY, zf - 1, 'north')
  B.carpet(ix0 + 1, iz0 + 2, ix1 - 1, zf - 2, upY, 'brown')
  B.lanternHang(dx, up0 + 4, iz0 + 2)
}

// ------------------------------------------------------ убранство погребов

function furnishCellars (ctx) {
  const { B } = ctx
  // Склад (x −25..−3, z 4..14, пол 23): ряды двойных сундуков по стенам и
  // стеллажи посередине, бочки, таблички по рядам.
  {
    const y = 23
    const rows = [['Зерно', 'и мука'], ['Инструменты', ''], ['Ткани', 'и шерсть'], ['Руда', 'и слитки'], ['Оружие', 'и стрелы'], ['Разное', '']]
    let k = 0
    for (let x = -24; x <= -5; x += 4) {
      // У северной стены — сундуки в два яруса лицом на юг.
      B.chest2(x, y, 4, 'south'); B.chest2(x, y + 1, 4, 'south')
      // У южной стены — лицом на север (кроме прохода к двери x −14).
      if (Math.abs(x - -14) > 1 && Math.abs(x + 1 - -14) > 1) { B.chest2(x + 1, y, 14, 'north'); B.chest2(x + 1, y + 1, 14, 'north') }
      const t = rows[k++ % rows.length]
      B.sign(x, y + 2, 5, 'south', ['', t[0], t[1], ''])
    }
    // Стеллажи посередине: бочки в два яруса с проходами.
    for (let x = -23; x <= -5; x++) {
      if ((x + 23) % 5 === 4) continue
      for (const z of [8, 10]) { B.barrel(x, y, z, z === 8 ? 'north' : 'south'); if ((x + z) % 2) B.barrel(x, y + 1, z, 'up') }
    }
    for (const x of [-22, -16, -10, -5]) B.lanternHang(x, 27, 9)
    B.lanternHang(-14, 27, 12); B.lanternHang(-20, 27, 6)
    B.S(-24, y, 12, 'crafting_table'); B.S(-24, y, 11, st('lectern', { facing: 'east', has_book: 'false', powered: 'false' }))
  }
  // Винный погреб (x −1..9, z 4..14): бочки на козлах вдоль стен, столик.
  {
    const y = 23
    for (let x = -1; x <= 9; x++) {
      B.barrel(x, y, 4, 'south'); B.barrel(x, y + 1, 4, 'south') // стеллаж в один ряд — до каждой бочки дотянуться
      if (Math.abs(x - 4) > 1) { B.barrel(x, y, 14, 'north'); B.barrel(x, y + 1, 14, 'north') }
    }
    B.table(1, 9, 3, 10, y, 'spruce_planks'); B.S(6, y, 10, st('brewing_stand', { has_bottle_0: 'true', has_bottle_1: 'false', has_bottle_2: 'true' }))
    B.S(7, y, 10, st('water_cauldron', { level: '3' }))
    B.candles(2, y + 1, 9, 3); B.lanternHang(4, 27, 8); B.lanternHang(4, 27, 12)
    B.sign(0, y + 2, 6, 'south', ['', 'Винный', 'погреб', ''])
  }
  // Сокровищница (x 11..19, z 7..14): за железной дверью — золото, сундуки.
  {
    const y = 23
    for (let x = 11; x <= 19; x++) { B.S(x, y, 7, 'gold_block'); if (x % 2) B.S(x, y + 1, 7, 'gold_block') }
    for (const x of [11, 19]) for (let z = 8; z <= 12; z++) { B.S(x, y, z, z % 2 ? 'emerald_block' : 'lapis_block') }
    B.chest2(13, y, 8, 'south'); B.chest2(16, y, 8, 'south')
    B.S(15, y, 11, st('ender_chest', { facing: 'south', waterlogged: 'false' }))
    B.carpet(12, 10, 18, 13, y, 'red')
    B.lanternHang(15, 26, 10)
    B.sign(14, y + 2, 8, 'south', ['', 'Казна', '', ''])
  }
  // Темница (x −25..−9, z 5..14, пол 16): камеры у северной стены за
  // решётками, коридор у южной; солома, цепи, факелы.
  {
    const y = 16
    for (let cx = -24; cx <= -12; cx += 4) {
      for (let z = 5; z <= 9; z++) for (const x of [cx - 1, cx + 3]) for (let yy = y; yy <= 20; yy++) if (x >= -25 && x <= -9) B.S(x, yy, z, 'stone_bricks')
      for (let x = cx; x <= cx + 2; x++) for (let yy = y; yy <= 20; yy++) B.S(x, yy, 10, yy === 20 ? 'stone_bricks' : 'iron_bars')
      B.door(cx + 1, y, 10, 'south', 'iron_door')
      B.S(cx + 1, y, 11, st('stone_button', { face: 'floor', facing: 'south', powered: 'false' })) // открыть — только из коридора
      B.S(cx, y, 5, 'hay_block'); B.S(cx + 2, y, 6, st('iron_chain', { axis: 'y', waterlogged: 'false' })); B.S(cx + 2, y + 1, 6, st('iron_chain', { axis: 'y', waterlogged: 'false' }))
      B.S(cx + 1, y + 3, 5, st('wall_torch', { facing: 'south' }))
    }
    for (let x = -22; x <= -10; x += 4) B.S(x, y + 3, 14, st('wall_torch', { facing: 'north' }))
    B.S(-24, y, 13, 'barrel'); B.S(-23, y, 14, 'crafting_table')
  }
  // Цистерна (x −6..10, z 3..14, пол 16): бассейн с водой, обход по краю.
  {
    for (let x = -4; x <= 8; x++) {
      for (let z = 5; z <= 12; z++) {
        const pillar = (x === -2 || x === 3) && (z === 7 || z === 12)
        if (pillar) continue
        B.S(x, 15, z, 'water'); B.S(x, 14, z, 'water'); B.S(x, 13, z, 'stone_bricks')
      }
    }
    for (let x = -5; x <= 9; x++) for (const z of [4, 13]) B.S(x, 16, z, slab('stone_bricks'))
    for (let z = 4; z <= 13; z++) for (const x of [-5, 9]) B.S(x, 16, z, slab('stone_bricks'))
    B.lanternHang(1, 21, 8); B.lanternHang(6, 21, 8); B.lanternHang(-3, 21, 10)
    B.S(1, 16, 14, 'cauldron')
  }
}

export { buildCellars, buildSeaWall, buildGate, buildTrap, trapTreasury, buildTown, house, furnishHouse, furnishCellars }
