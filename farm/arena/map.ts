'use strict'
import { DIST_ROOT } from '../../daemon/src/paths'
// Поле и карта: гонка — раскладка arms-layout или Колизей (сброс арены каждый раунд, насесты), точки старта бойцов и
// падение с арены.
import { ROOT } from './context'
import { LAN_NAME } from './server'
import { makeStockChests } from './loot'
import type { ArenaContext } from './context'
import * as fs from 'fs'
import path = require('path')

// Гонка: карта у центра поля (ARMS_POS), Колизей из чистой копии, раскладка, насесты; первая набивка сундуков.
export async function setupArmsMap (ctx: ArenaContext) {
  const { i, COLOS_MAP, AL, L, X, Y, Z, bots, perches, rcon, log } = ctx
  await rcon(i, `forceload add ${X - L.half} ${Z - L.half} ${X + L.half} ${Z + L.half}`).catch(() => {})
  // Колизей — заново каждый раунд (10.10: «скидывай все блоки каждый раунд, а то засирается»): чистая копия постройки
  // лежит в стороне (X+400, снята один раз после полной перестройки), раунд — clone копии на место + раскладка (поле,
  // сундуки) поверх. Копия — слоями по 1 блоку (clone ≤ 32768 блоков). ARMS_RESET=0 — без копии, как было.
  let bad = 0
  ctx.restoreArena = async () => {
    const SX = 400; const h = L.half; const y0 = Y + L.y0; const y1 = Y + L.y1
    if (COLOS_MAP && process.env.ARMS_RESET !== '0') {
      const flagF = path.join(ROOT, 'farm', 'results', `colos-stash-${i}.json`)
      const want = `${X} ${Y} ${Z} h${h} y${L.y0}..${L.y1}`
      await rcon(i, `forceload add ${X + SX - h} ${Z - h} ${X + SX + h} ${Z + h}`).catch(() => {})
      let have = ''; try { have = JSON.parse(fs.readFileSync(flagF, 'utf8')).at } catch {}
      if (have !== want) {
        const t0 = Date.now()
        const CZB = require(path.join(DIST_ROOT, 'daemon', 'arena', 'build-colosseum'))
        const P = CZB.plan({ X, Y, Z, R: 24, ceilH: 16 })
        for (const c of [...P.clear, ...P.cmds, ...P.field]) await rcon(i, c.replace(/^\//, ''), 20000).catch(() => {})
        for (let y = y0; y <= y1; y++) await rcon(i, `clone ${X - h} ${y} ${Z - h} ${X + h} ${y} ${Z + h} ${X + SX - h} ${y} ${Z - h}`, 20000).catch(() => {})
        fs.writeFileSync(flagF, JSON.stringify({ at: want, builtAt: new Date().toISOString() }))
        log(`гонка: Колизей перестроен целиком и снят в копию (${P.cmds.length} команд, ${Math.round((Date.now() - t0) / 1000)} с)`)
      }
      const t1 = Date.now()
      for (let y = y0; y <= y1; y++) await rcon(i, `clone ${X + SX - h} ${y} ${Z - h} ${X + SX + h} ${y} ${Z + h} ${X - h} ${y} ${Z - h}`, 20000).catch(() => {})
      log(`гонка: Колизей восстановлен из копии за ${((Date.now() - t1) / 1000).toFixed(1)} с`)
    }
    bad = 0
    for (const c of AL.commands(L, { X, Y, Z })) { const r = await rcon(i, c, 20000).catch(e => String(e)); if (/Unknown|Incorrect|Expected|not loaded|Too many|timeout/i.test(r)) bad++ }
    // Точка возрождения людей — в центре поля на земле (10.10: «точка возрождения сломалась»: рельеф поля каждый раунд
    // новый, и старая точка оказалась в блоке — сервер сбросил её на спавн мира). Ищу 2 клетки воздуха над опорой.
    let sy = Y
    for (let y = Y; y < Y + 10; y++) if (/passed/.test(String(await rcon(i, `execute if block ${X} ${y} ${Z} minecraft:air if block ${X} ${y + 1} ${Z} minecraft:air unless block ${X} ${y - 1} ${Z} minecraft:air`).catch(() => '')))) { sy = y; break }
    // Люди — и из журнала входов (ctx.humanNames): list по RCON при 40 ботах обрезается, и человеку точка не ставилась —
    // возрождение на спавне мира, вне Колизея (14.10). Есть комната спавна — точка в ней (поворот в 1.21.11 — два числа).
    const ppl = [...new Set([...String(await rcon(i, 'list').catch(() => '')).replace(/^.*online:\s*/, '').split(/,\s*/).map(x => x.trim()), ...(ctx.humanNames || [])])].filter(x => x && x !== '...' && !x.startsWith(`NeuroFarm${i}`) && x !== LAN_NAME)
    for (const h of ppl) {
      const home = ctx.humanHome?.(h)
      await rcon(i, home ? `spawnpoint ${h} ${Math.floor(home.x)} ${Math.floor(home.y)} ${Math.floor(home.z)} ${home.yaw} 0` : `spawnpoint ${h} ${X} ${sy} ${Z}`).catch(() => {})
    }
    // Запасной спавн мира — в комнате людей, без разброса: точку возрождения могут застроить, и сервер кидает на спавн мира.
    const room = (L?.spawnRooms || []).find(r => r.team === (ctx.HUMAN_TEAM || 'red'))
    if (room) for (const c of [`setworldspawn ${X + room.spot.x} ${Y + room.spot.y} ${Z + room.spot.z}`, 'gamerule respawn_radius 0']) await rcon(i, c).catch(() => {})
    ctx.spawnAt = { x: X, y: sy, z: Z }
  }
  for (const b of bots) await rcon(i, `gamemode spectator ${b.name}`)
  await ctx.restoreArena()
  await rcon(i, `kill @e[type=!minecraft:player,x=${X - L.half},y=${Y + L.y0},z=${Z - L.half},dx=${2 * L.half},dy=${L.y1 - L.y0},dz=${2 * L.half}]`).catch(() => {})
  // Насесты (10.10: «жемчуг высоко на Колизей — никто не достанет»): клетки, где можно стоять, на крышах ярусов и
  // вершинах (модель постройки: опора, над ней 2 воздуха; 11+ над полем). Туда бросает жемчуг тот, кому не убежать.
  if (COLOS_MAP) {
    const g = require(path.join(DIST_ROOT, 'daemon', 'arena', 'build-colosseum')).plan({ X, Y, Z, R: 24, ceilH: 16 }).m.g
    const pal = (x, y, z) => (x < g.x0 || x > g.x1 || y < g.y0 || y > g.y1 || z < g.z0 || z > g.z1) ? 'air' : (g.pal[g.data[g.i(x, y, z)]] || 'air')
    const solid = (x, y, z) => { const n = pal(x, y, z); return n !== 'air' && !/air|slab|stairs|fence|wall|pane|bars|torch|lantern/.test(n) }
    for (let x = g.x0; x <= g.x1; x += 2) for (let z = g.z0; z <= g.z1; z += 2) for (let y = g.y1; y >= 11; y--) {
      if (!solid(x, y, z)) continue
      if (pal(x, y + 1, z) === 'air' && pal(x, y + 2, z) === 'air') perches.push({ x: X + x + 0.5, y: Y + y + 1, z: Z + z + 0.5 })
      break
    }
  }
  log(`гонка: карта seed ${L.seed} у ${X} ${Y} ${Z} — сундуков ${L.chests.length}, команд не прошло ${bad}`)
  ctx.stockChests = makeStockChests(ctx)
  await ctx.stockChests(1)
}

export function installPlaces (ctx: ArenaContext) {
  const { i, teams, N, X, Y, Z, L, rcon } = ctx
  const spot = (k, n) => { const a = 2 * Math.PI * k / n; return `${(X + 0.5 + Math.cos(a) * 14).toFixed(1)} ${Y + 1} ${(Z + 0.5 + Math.sin(a) * 14).toFixed(1)}` }
  // Команды — по своим сторонам поля (красные с запада, синие с востока); дезматч — кольцом.
  // Точка входа — центр своей стороны (команды) или кольца; ставит spreadplayers на свободный верх под барьерным
  // потолком (tp в рельеф: двое красных задохнулись в стене, 10.10).
  ctx.home = (b, k) => teams ? `${X + (b.team === 'red' ? -12 : 12)} ${Z + (k % 6) * 3 - 7}` : spot(k, N).split(' ').filter((_, j) => j !== 1).join(' ')
  ctx.place = (name, at) => rcon(i, `spreadplayers ${at} 0 3 under ${Y + 15} false ${name}`)
  // Гонка: старт — точки раскладки (запад красным, восток синим), пустыми; после смерти вещи при себе (keep_inventory).
  ctx.armsHome = (b, k) => { const s0 = L.spawns[b.team === 'red' ? 0 : 1]; return { x: X + s0.x + 0.5, y: Y + s0.y, z: Z + s0.z + ((k >> 1) % 12) - 6 + 0.5 } }
}

export function guardFalls (ctx: ArenaContext) {
  const { i, arms, bots, X, Y, Z, L, rcon } = ctx
  // Упал с Колизея — сразу смерть (12.10: «упал — лень подниматься наверх»): ниже нижнего яруса постройки на 3 бл., раз в секунду,
  // кроме зрителей; дальше обычный ход смерти (боец — в зрители, человек — набор и на свою сторону).
  // Спасение из пропасти (тело: rescue_config) — куда лететь и где смерть; раз в 20 с всем (переподключённым тоже).
  const rescueT = arms ? setInterval(() => { for (const b of bots) b.c.call('rescue_config', { safe: { x: X + 0.5, y: Y, z: Z + 0.5 }, killY: Y + L.y0 - 3 }).catch(() => {}) }, 20000) : null
  // Улетел за Колизей (элитры, заряд, жемчуг) дальше 8 бл. за границу арены — как упавший: оттуда путь в арену не строится
  // (стенд 15.10, 31ad на x 370: «точка подъёма вне арены» по кругу).
  const fallT = arms ? setInterval(() => {
    if (ctx.between) return
    rcon(i, `kill @a[gamemode=survival,x=${X - 200},z=${Z - 200},dx=400,dz=400,y=-64,dy=${Y + L.y0 - 3 + 64}]`).catch(() => {})
    for (const b of bots) {
      const p = ctx.pos?.[b.name]?.p
      if (!p || !ctx.alive?.(b.name) || (Math.abs(p.x - X) <= L.half + 8 && Math.abs(p.z - Z) <= L.half + 8)) { b.outSince = 0; continue }
      // 4 с на возврат (летит на элитрах над краем — ещё вернётся); дальше — как упавший.
      b.outSince = b.outSince || Date.now()
      if (Date.now() - b.outSince < 4000 || (b.outKillAt || 0) > Date.now()) continue
      b.outKillAt = Date.now() + 5000
      ctx.log?.(`🛫 ${b.name}: за пределами Колизея (${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}) — как упавший`)
      rcon(i, `execute unless entity @a[name=${b.name},x=${X - L.half - 8},z=${Z - L.half - 8},y=-64,dx=${2 * L.half + 16},dz=${2 * L.half + 16},dy=448] run kill ${b.name}`).catch(() => {})
    }
  }, 1000) : null
  return { rescueT, fallT }
}
