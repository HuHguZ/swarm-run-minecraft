'use strict'
// Слежка за бойцами: тревога (враг подбегает — рвать дело), рой (swarm-driver) и враги глазами, обёртки вызовов
// демона, опрос состояния, сторож зависаний, мобы глазами, счёт и уборка.
import { arenaBounds, belowArenaFloor, ROOT, SOLO } from './context'
import { SPRINT, power, MOB_SPD, worthOf } from './gear'
import { teamOfHuman } from './humans'
import type { ArenaContext } from './context'
import { ascentActive } from '../swarm/swarm-driver/ascent'
import { underArrowFire, withOffHand } from '../swarm/swarm-driver/common'
import { assistTimeoutMs, swarmHoldTimeoutMs } from '../../daemon/src/swarm/common'
import * as fs from 'fs'
import path = require('path')
import { randomUUID } from 'node:crypto'

const dist3 = (a, c) => Math.hypot(a.x - c.x, a.y - c.y, a.z - c.z)
const HUNT_SIGHT_MS = 1500
const recentBody = (e, now) => now - e.seenAt < HUNT_SIGHT_MS && !e.nametag && !e.glowing

// Closest point on the observed ground run, within the same two-second alarm horizon.
function runsIntoReach(foe, me) {
  if (!foe.v || !foe.p || Math.abs(foe.p.y - me.y) >= 2.5) return false
  const dx = me.x - foe.p.x, dz = me.z - foe.p.z
  const { x, z } = foe.v, speed2 = x * x + z * z
  if (!speed2) return false
  const ticks = Math.min(40, (dx * x + dz * z) / speed2)
  return ticks > 0 && Math.hypot(dx - x * ticks, dz - z * ticks, foe.p.y - me.y) <= 3
}

// GoalNear uses block coordinates. An exact-height route also requires the actual landing height.
function atWalkGoal (p, goal) {
  if (goal?.arenaFloor) return false // Высоту в воздухе от подтверждённой посадки отличает тело.
  if (!p || !goal || ![p.x, p.z, goal.x, goal.z].every(Number.isFinite)) return false
  const dx = Math.floor(p.x) - Math.floor(goal.x), dz = Math.floor(p.z) - Math.floor(goal.z), range = goal.range ?? 2
  if (goal.y == null) return Math.hypot(dx, dz) <= Math.max(1, range)
  return Number.isFinite(p.y) && Number.isFinite(goal.y) && Math.hypot(dx, Math.floor(p.y) - Math.floor(goal.y), dz) <= range &&
    (!goal.exactY || Math.abs(p.y - goal.y) < .001)
}

function alarmThreat(e, me, now) {
  const seconds = Math.max(0, e.d - 3) / Math.max(e.spd, SPRINT)
  return (e.seenAt == null || recentBody(e, now)) && seconds < (SOLO && e.human ? 3.5 : 2) &&
    (e.human || e.d < 6 || e.geared && runsIntoReach(e, me))
}

function huntOver(g, me, e, now) {
  // Поход к противнику кончился: он виден (1.5 с) и либо уже рядом (3.5 бл. по горизонтали, не выше на 1.5 — дальше решает
  // бой: в 2–3 бл. от человека в яме бот 4 с «шёл к нему»), либо не там, куда иду (дальше 4 бл. от цели похода и ближе
  // ко мне, чем она). Отход — не погоня.
  const goal = { x: g.x, y: Number.isFinite(g.y) ? g.y : me.y, z: g.z }, far = dist3(goal, me)
  return e.p && recentBody(e, now) && (Math.hypot(e.p.x - me.x, e.p.z - me.z) <= 3.5 && e.p.y - me.y < 1.5 || dist3(e.p, goal) > 4 && e.d < far)
}

export function watchAlarm (ctx: ArenaContext) {
  const { teams, bots, names, pos, busy, teamOf } = ctx
  const cancelled = new WeakMap<object, { round: number, action: any }>()
  // Тревога (10.10: «подбегаю быстро — тупят, не реагируют, как будто не успевают; должны понимать, что я быстрый»):
  // раз в 250 мс у каждого бойца не в бою — кто доберётся до меня быстрее чем за 2 с (по его скорости, а не по блокам:
  // игрок со «Скоростью V» — 10+ бл/с), тот рвёт текущее дело (лут, путь, крафт); цикл бойца решит заново — бежать,
  // звать своих или драться. Одно текущее дело отменяется один раз; новое не наследует иммунитет старого.
  return setInterval(() => {
    if (ctx.between) return
    for (const b of bots) {
      const m = pos[b.name]; if (!m?.p || m.rescuing || belowArenaFloor(ctx, m.p) || !ctx.alive(b.name)) continue
      if (ascentActive(b, m)) continue
      // Бой и уход (жемчуг, заряд, подкоп, бег) — не рвать: это и есть ответ на угрозу.
      // Рывок/заливка/полёт (busy) — тоже ответ на угрозу (12.10, замер лучником: тревога гасила каждый стрейф через доли секунды).
      // Идёт к человеку (погоня, спуск к нему — _hunt) — это и есть ответ: не рвать (13.10: «скопились наверху» — тревога
      // обрывала спуск к нему каждые 5 с).
      // Но поход к его старому месту, когда он уже в другом и ближе цели похода (вбежал в комнату, спрыгнул), или когда он
      // уже рядом — не ответ: рвать (стенд бота-противника 22.10: лез ко мне наверх 5 с, а я стоял в 5 бл. от него).
      const hunting = b.last?.p?._hunt && !b.swarmTask?.data?.dig
      if (hunting && (!Number.isFinite(b.last.p.x) || !Number.isFinite(b.last.p.z) || /^(flee|recover)$/.test(b.swarmTask?.kind || ''))) continue
      // Выход из коробки и активный облёт уже отвечают на угрозу, даже если лут ещё числится за бойцом.
      if (b.campReacting || b.last?.m === 'wing_orbit' && b.last.pending === true) continue
      if (busy.has(b.name) || (!b.looting && (/^(fight|drink_buffs|pearl_to|wind_jump|burrow|flee|block_behind|evade|douse_lava|fly_to|peek_shot|wind_leap|juke|take_cover|undercut)$/.test(b.last?.m || '') || b.waiting))) continue
      const en = ctx.enemiesOf(b, m.p)
      const now = Date.now()
      const hot = en.filter(e => alarmThreat(e, m.p, now) && (!hunting || huntOver(b.last.p, m.p, e, now)))
      if (!hot.length) continue
      // При смертельном подкопе цену удара считает тело по оставшейся копке; обычную яму контакт по-прежнему прерывает.
      if (b.swarmTask?.data?.dig && (b.swarmTask.data.undermine || hot.every(e => e.d > 3.5))) continue
      const old = cancelled.get(b)
      if (old && old.round === ctx.round && old.action === b.last) continue
      cancelled.set(b, { round: ctx.round, action: b.last })
      if (b.looting || b.climbing || b.last && b.last.pending !== false) {
        if (hunting) b.lastHuntAlarm = { round: ctx.round }
        b.looting = false; b.c.call('stop').catch(() => {})
      }
      if (teams) {
        const ours = names.filter(n => n !== b.name && teamOf(n) === b.team && ctx.alive(n) && dist3(pos[n].p, m.p) / SPRINT < 2.5).length
        ctx.callout(b, 'cover', { foe: hot[0].n, foes: hot.length, mates: ours }, 6000, `прикройте! на меня ${ctx.short(hot[0].n)}${hot.length > 1 ? ` и ещё ${hot.length - 1}` : ''}`)
      }
    }
  }, 250)
}

export function installSight (ctx: ArenaContext) {
  const { i, arms, bots, names, pos, humans, X, Y, Z, R, L, rcon, log } = ctx
  const arena = arenaBounds(ctx)
  // Соло (люди против роя): натиск — бегут только на хилку, без обманок, голые сперва лутаются (14.10: «не атакуют»).
  // Укрытия для слабых (натиск): закрытые места колизея — камеры, галереи, лаборатория, оружейная, комнаты спавна.
  const hideouts = arms && L?.map === 'colosseum' ? [...L.areas.filter(a => /^(камера|галерея|лаборатория|оружейная)/.test(a.id)), ...(L.spawnRooms || []).filter(r => r.team !== (ctx.HUMAN_TEAM || 'red')).map(r => r.spot)]
    .map(a => ({ x: X + a.x + .5, y: Y + a.y, z: Z + a.z + .5, tier: (require('./loot') as typeof import('./loot')).tierOf(a.y) })) : []
  // Сундуки крыши и венца (ярусы 4–5, лучший лут) — тоже места обхода: пешком туда не дойти, только столбом с галереи 4 (dy 24)
  // (пользователь 15.10: «проверь, что сундуки с самой большой высоты лутают»; за ночной раунд их не открыли ни разу).
  const chestTops = arms && L?.map === 'colosseum' ? (L.chests || []).filter(c => c.y >= 30).map(c => ({ x: X + c.x + .5, y: Y + c.y, z: Z + c.z + .5, climbFrom: Y + 24, tier: (require('./loot') as typeof import('./loot')).tierOf(c.y) })) : []
  // Обрыв у цели (окружение — бить с другой стороны, чтобы отбросило вниз): по модели колизея с раскладкой — в 8 сторонах на
  // 1–3 бл. от него пола нет на 4+ бл. вниз. Модель — как построено (столбы и воронки раунда не видит).
  let edgeOf = null, digSites = null, surfaceY = null, ladderSites: any[] = []
  if (arms && L?.map === 'colosseum') {
    const C: typeof import('../../daemon/arena/colosseum') = require('../../daemon/arena/colosseum'); const g = C.model({ R: 24, ceilH: 16 }).g
    for (const [x, y, z, b] of [...L.field, ...L.set]) g.set(x, y, z, b === 'air' ? '' : b.replace(/\{.*$/, ''))
    // Пол поля (песок на −1) кладут команды раскладки, в модели его нет; лава ям — не пол (туда и скидывать).
    const solid = (x, y, z) => { const b = g.get(x, y, z); return b ? !/carpet|banner|lantern|button|torch|ladder|lava/.test(b) : y === -1 && Math.abs(x) <= L.R && Math.abs(z) <= L.R }
    edgeOf = p => {
      const rx = Math.floor(p.x - X), ry = Math.floor(p.y - Y), rz = Math.floor(p.z - Z)
      // Ближний обрыв, до которого тело долетит: стена на пути (ноги или голова) — не обрыв (Codex 15.10: бил «в обрыв» сквозь стену).
      // До расстояния подхода бойцов: дальнюю цепь ударов оценивает shoveHits, стена по пути прерывает луч.
      let best = null
      for (let k = 0; k < 8; k++) for (let t = 1; t <= 16; t++) {
        const dx = Math.round(Math.cos(k * Math.PI / 4) * t), dz = Math.round(Math.sin(k * Math.PI / 4) * t)
        // Стена — твёрдое выше его ног (нижняя плита пола под ногами — не стена; Codex 15.10).
        const wall = (x, y, z) => solid(x, y, z) && (floorTop(x, y, z) == null || floorTop(x, y, z) > p.y - Y + 1e-3)
        if (wall(rx + dx, ry, rz + dz) || wall(rx + dx, ry + 1, rz + dz)) break
        // Лава ямы вровень с полом — тоже обрыв (ваншот, пользователь 21.10: «скинул — и он умер сразу»): под ней песчаник,
        // и он считался полом — рой не заходил так, чтобы удар отправлял в яму.
        const lava = [ry - 1, ry].some(y => /lava/.test(g.get(rx + dx, y, rz + dz) || ''))
        let floor = false
        for (let y = ry - 1; y >= ry - 4 && !floor && !lava; y--) floor = solid(rx + dx, y, rz + dz)
        if (!floor) {
          // Глубина падения (shove.ts — убьёт ли): до первого пола ниже; пола нет — пустота (Infinity); лава вровень или на дне —
          // lava (насмерть ли — решает shove.ts по его броне: незерит с Защитой IV из ямы выходит, 21.10).
          let drop = Infinity, burns = lava
          if (!lava) for (let y = ry - 5; y >= ry - 64; y--) if (solid(rx + dx, y, rz + dz) || /lava/.test(g.get(rx + dx, y, rz + dz) || '')) { burns = /lava/.test(g.get(rx + dx, y, rz + dz) || ''); drop = burns ? Infinity : ry - (y + 1); break }
          // Смертельный в досягаемости важнее ближнего мелкого (DeepSeek, ревью 21.10): пустота, потом глубже 20, потом лава,
          // потом ближе.
          const rank = burns ? 1 : drop >= 20 ? 2 + (Number.isFinite(drop) ? 0 : 1) : 0
          if (!best || rank > best.rank || rank === best.rank && t < best.t) best = { t, k, drop, rank, burns }
          break
        }
      }
      return best ? { x: Math.cos(best.k * Math.PI / 4), z: Math.sin(best.k * Math.PI / 4), drop: best.drop, ...(best.burns ? { lava: true } : {}), at: best.t } : null
    }
    // Места для ям-ловушек: клетка пола этажа (галереи dy 8/16/24, крыша-терраса 31), под ней 2 блока, ниже — пустота 4+
    // (этаж ниже): вскрыть 2 — дыра с падением 6–8 бл. И земля за полем (dy 0): песок или песчаник на обсидиане фундамента
    // (dy −2), под ним пустота — вскрыть 2 под сильным или рядом с ним — насмерть (пользователь 22.10: «сильного, что не ходит
    // у обрыва, только подкопом быстрым можно убить и столкнуть»). drop — глубина падения (Infinity — пустота), tier —
    // какая кирка нужна (обсидиан — алмазная и лучше).
    const holeCells: any[] = []
    const mc = (require('../../daemon/node_modules/minecraft-data') as typeof import('../../daemon/node_modules/minecraft-data'))('1.21.11')
    const floorTop = (x, y, z) => { const b = g.get(x, y, z); if (C.sturdyFace(b, 'up')) return y + 1; return C.isSlab(b) && C.parse(b).props?.type === 'bottom' ? y + .5 : null }
    const handMs = b => { const d = b && mc.blocksByName[C.parse(b).name]; return !d || d.diggable === false || d.hardness < 0 ? Infinity : Math.ceil(d.hardness * (d.harvestTools ? 100 : 30)) * 50 }
    const tierOf = b => { const d = b && mc.blocksByName[C.parse(b).name]; return d?.harvestTools && !Object.keys(d.harvestTools).some(id => /^(wooden|stone|iron|golden)_pickaxe$/.test(mc.items[id]?.name || '')) ? 2 : 0 }
    for (let x = -L.half; x <= L.half; x++) for (let z = -L.half; z <= L.half; z++) for (const F of [0, 8, 16, 24, 31]) {
      if (!solid(x, F - 1, z) || solid(x, F, z) || solid(x, F + 1, z) || !solid(x, F - 2, z)) continue
      let y = F - 3; while (y >= F - 64 && !solid(x, y, z)) y--
      if (F - 3 - y < 4) continue
      const feet = floorTop(x, F - 1, z); if (feet == null) continue
      const stands = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dz]) => floorTop(x + dx, F - 1, z + dz) === feet && !solid(x + dx, F, z + dz) && !solid(x + dx, F + 1, z + dz))
        .flatMap(([dx, dz]) => {
          const sx = x + dx, sz = z + dz, lower = floorTop(sx, F - 2, sz)
          const upper = { x: X + sx + .5, y: Y + feet, z: Z + sz + .5 }
          // Нижняя стойка — верх реального блока/плиты из модели, только после квитанции снятого верха.
          return [upper, ...(lower != null ? [{ x: upper.x, y: Y + lower, z: upper.z,
            requiresClear: [{ x: X + sx, y: Y + F - 1, z: Z + sz }], support: { x: X + sx, y: Y + F - 2, z: Z + sz } }] : [])]
        })
      const blocks = [g.get(x, F - 1, z), g.get(x, F - 2, z)], tier = Math.max(...blocks.map(tierOf))
      if (stands.length) holeCells.push({ x, y: F - 1, z, F, feetY: Y + feet, stands, blocks, handMs: blocks.reduce((n, b) => n + handMs(b), 0), drop: y < F - 64 ? Infinity : feet - (y + 1), ...(tier ? { tier } : {}) })
    }
    const Block = require('../../daemon/node_modules/prismarine-block')(mc), { Vec3 } = require('../../daemon/node_modules/vec3')
    const pick: typeof import('../../daemon/src/pick') = require('../../daemon/src/pick')
    const nativeCells = new Map(), farCatalogue = new Map()
    const nativeAt = p => {
      p = p.floored(); const key = p.toString()
      if (!nativeCells.has(key)) {
        const parsed = C.parse(g.get(p.x, p.y, p.z) || 'air'), b = Block.fromProperties(parsed.name, parsed.props, 0)
        b.position = p; nativeCells.set(key, b)
      }
      return nativeCells.get(key)
    }
    const allStands = c => {
      if (farCatalogue.has(c)) return farCatalogue.get(c)
      const out = [...c.stands], target = new Vec3(c.x, c.F - 2, c.z), top = c.F - 1
      const removable = p => p.y === top && floorTop(p.x, top, p.z) === c.feetY - Y && !solid(p.x, c.F, p.z) && !solid(p.x, c.F + 1, p.z)
      for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
        if (Math.abs(dx) + Math.abs(dz) <= 1) continue
        const sx = c.x + dx, sz = c.z + dz, upper = floorTop(sx, top, sz)
        if (upper !== c.feetY - Y || solid(sx, c.F, sz) || solid(sx, c.F + 1, sz)) continue
        for (const lower of [false, true]) {
          const feet = lower ? floorTop(sx, c.F - 2, sz) : upper
          if (feet == null || Math.hypot(dx, dz, target.y + 1 - feet - 1.62) > 4.5) continue
          const position = new Vec3(sx + .5, feet, sz + .5), removed = new Map<string, any>()
          if (lower) { const p = new Vec3(sx, top, sz); removed.set(p.toString(), p) }
          // Ask the existing native face picker with removable top cells conditional, never with walls removed.
          const view: any = { entity: { position, width: .6, height: 1.8 }, entities: {}, blockAt: p => removable(p.floored()) ? nativeAt(new Vec3(p.x, c.F, p.z)) : nativeAt(p) }
          const face = pick.faceAim(view, target, new Vec3(0, 1, 0))
          if (!face) continue
          const eye = pick.eyeOf(view), delta = face.minus(eye), length = delta.norm(), direction = delta.scaled(1 / length)
          const actual = { blockAt: p => removed.has(p.floored().toString()) ? nativeAt(new Vec3(p.x, c.F, p.z)) : nativeAt(p) }
          let visible = false
          for (let n = 0; n < 16; n++) {
            const hit = pick.blockOnRay(actual, eye, direction, length + .01)
            if (hit?.pos.equals(target)) { visible = true; break }
            if (!hit || !removable(hit.pos) || !lower && hit.pos.x === sx && hit.pos.z === sz) break
            removed.set(hit.pos.toString(), hit.pos)
          }
          if (!visible) continue
          out.push({ x: X + position.x, y: Y + position.y, z: Z + position.z,
            support: { x: X + sx, y: Y + (lower ? c.F - 2 : top), z: Z + sz },
            requiresClear: [...removed.values()].map(p => ({ x: X + p.x, y: Y + p.y, z: Z + p.z })) })
        }
      }
      farCatalogue.set(c, out); return out
    }
    // Порядок x,z,F при равной дальности совпадает с порядком общего каталога.
    const columns = new Map<number, typeof holeCells>()
    const columnKey = (x: number, z: number) => (x + L.half) * (2 * L.half + 1) + z + L.half
    for (const cell of holeCells) {
      const key = columnKey(cell.x, cell.z)
      if (!columns.has(key)) columns.set(key, [])
      columns.get(key)!.push(cell)
    }
    digSites = p => {
      const rx = p.x - X, ry = p.y - Y, rz = p.z - Z, out: any[] = []
      // С самой клетки у него под ногами (пользователь 21.10: «включая поломку блоков под ногами врага») до 6 бл.: стоящему —
      // пол из-под ног, бегущему — яма впереди (порядок задаёт plan-jobs по его ходу).
      const near: { cell: any; distance: number }[] = []
      for (let x = Math.max(-L.half, Math.floor(rx) - 6); x <= Math.min(L.half, Math.floor(rx) + 6); x++) {
        for (let z = Math.max(-L.half, Math.floor(rz) - 6); z <= Math.min(L.half, Math.floor(rz) + 6); z++) {
          const column = columns.get(columnKey(x, z))
          if (!column) continue
          const distance = Math.hypot(x + .5 - rx, z + .5 - rz)
          if (distance > 6) continue
          for (const cell of column) {
            if (Math.abs(cell.F - ry) < 1.6) near.push({ cell, distance })
          }
        }
      }
      for (const { cell } of near.sort((a, b) => a.distance - b.distance)) {
        out.push({ ...cell, stands: allStands(cell), x: X + cell.x, y: Y + cell.y, z: Z + cell.z })
      }
      return out
    }
    log(`ямы-ловушки: мест в полах этажей ${holeCells.filter(c => c.F).length}, на земле над пустотой ${holeCells.filter(c => !c.F).length}`)
    const inside = (x, z) => Math.abs(x) <= L.half && Math.abs(z) <= L.half
    for (let x = -L.half; x <= L.half; x++) for (let z = -L.half; z <= L.half; z++) for (let F = 0; F <= 40; F++) {
      if (!C.sturdyFace(g.get(x, F - 1, z), 'up') || g.get(x, F, z) || g.get(x, F + 1, z)) continue
      for (const [name, [fx, fz]] of Object.entries(C.DIR) as [string, number[]][]) {
        const wx = x - fx, wz = z - fz, sx = x + fx, sz = z + fz
        if (!inside(wx, wz) || !inside(sx, sz) || !C.sturdyFace(g.get(sx, F - 1, sz), 'up') || g.get(sx, F, sz) || g.get(sx, F + 1, sz)) continue
        for (let top = F; top <= F + 9; top++) {
          if (!C.sturdyFace(g.get(wx, top, wz), name) || g.get(x, top, z) || g.get(x, top + 1, z)) break
          if (top - F + 1 < 3 || !C.sturdyFace(g.get(wx, top, wz), 'up') || g.get(wx, top + 1, wz) || g.get(wx, top + 2, wz)) continue
          ladderSites.push({ key: `${X + wx},${Y + F},${Z + wz},${fx},${fz}`, x: X + wx, y: Y + F, z: Z + wz, top: Y + top, face: { x: fx, z: fz } })
          break
        }
      }
    }
    log(`лестницы: мест у стен ${ladderSites.length}; по высоте основания: ${Object.entries(ladderSites.reduce((o, s) => (o[s.y - Y] = (o[s.y - Y] || 0) + 1, o), {})).map(([y, n]) => `${y}:${n}`).join(' ')}; примеры ${[0, 4, 8, 24].map(h => ladderSites.filter(s => s.y - Y === h).slice(0, 2).map(s => s.key + '→' + (s.top - Y)).join(' ')).join(' | ')}`)
    // Поверхность под точкой (подъём отрезками): верхняя клетка, где стоять, не выше top — ступень рядов, проход, крыша.
    // Замер 14.10: отрезки по поверхности — с песка на крышу за 58 с и 29 блоков без кирки; по прямой — внутрь засыпки рядов.
    surfaceY = (x, z, top) => { const rx = Math.floor(x - X), rz = Math.floor(z - Z); for (let y = Math.floor(top - Y); y >= -2; y--) if (solid(rx, y - 1, rz) && !solid(rx, y, rz) && !solid(rx, y + 1, rz)) return Y + y; return null }
  }
  let announcedAt = -Infinity
  ctx.swarmDriver = (require('../swarm/swarm-driver') as typeof import('../swarm/swarm-driver')).createSwarmDriver({ bots, pos, alive: ctx.alive, arms, arena, hideouts, chestTops, perches: ctx.perches,
    recentHuntAlarm: b => {
      const receipt = b.lastHuntAlarm
      if (!receipt || receipt.round !== ctx.round) return
      const at = Date.now(), me = pos[b.name].p
      const hot = ctx.enemiesOf(b, me).filter(e => e.p && e.seenAt != null && alarmThreat(e, me, at))
      if (!hot.length) { delete b.lastHuntAlarm; return }
      return goal => hot.some(e => huntOver(goal, me, e, at))
    },
    publicKills: () => Object.values(ctx.deathAt).filter(d => d.team && d.by).map(d => ({ team: d.team, by: d.by })), aggressive: SOLO && process.env.SWARM_AGGRO !== '0',
    humanNames: () => ctx.humanNames || [],
    sandSpot: arms && L?.map === 'colosseum' ? { x: X + 0.5, y: Y, z: Z + 10.5 } : null, edgeOf, digSites, surfaceY, ladderSites,
    announce: SOLO || process.env.ARMS_CHAT === '1' ? (text, color) => {
      const at = Date.now()
      if (at - announcedAt < 20000) return
      announcedAt = at
      return rcon(i, `tellraw @a ${JSON.stringify([{ text: '[рой] ', color: 'dark_aqua' }, { text, color }])}`)
    } : null,
    home: b => { if (arms) return ctx.armsHome(b, 0); const [x, z] = ctx.home(b, 0).split(/\s+/).map(Number); return { x, y: Y, z } }, log,
    hostile: (b, name) => ctx.hostile(b, name) && (!names.includes(name) || !ctx.deadNow.has(name) && !ctx.out.has(name))
  })
  if (arms && arena.ellipse) for (const b of bots) {
    if (bots.some(o => o !== b && o.team === b.team) && b.team)
      b.c?.windRadio?.(message => (message.type === 'wind_bid_done' || !ctx.between) && ctx.swarmDriver.windBid(b, message))
  }
  ctx.enemiesOf = (b, at) => [
    ...ctx.swarmDriver.enemies(b).map(e => ({ n: e.id, p: e.position, v: e.velocity, seenAt: e.seenAt, nametag: e.nametag, glowing: e.glowing,
      spd: Math.hypot(e.velocity?.x || 0, e.velocity?.z || 0) * 20,
      geared: !!e.equipment?.weapon || !!e.equipment?.armor?.length, human: !names.includes(e.id),
      pow: power(20, e.equipment?.weapon ? { [e.equipment.weapon]: 1 } : {}, Object.fromEntries((e.equipment?.armor || []).map((n, k) => [k, n]))) })),
    // Мобы — те же враги (10.10: «от мобов бегут, а меня не видят»): что видит сам боец (демон, раз в секунду).
    ...((pos[b.name]?.mobs || []) as any[]).map(m => ({ n: `mob${m.id}`, id: m.id, p: m.p, spd: MOB_SPD[m.name] ?? 3, geared: true, human: false, mob: true, kind: m.name, pow: 0 }))
  ].map(e => ({ ...e, d: at ? dist3(e.p, at) : Infinity })).sort((a, c) => a.d - c.d)
  // Отход к своим (10.10: «один — иногда убегать к союзникам»; «не хардкодь блоки — адаптивно»). Без порогов в блоках:
  // враг сильнее моей силы «здесь» (я + свои, кто успеет за секунду) — к той группе своих, что даст больше силы на
  // секунду пути, если добегу раньше, чем он догонит (разрыв до удара / разница скоростей). Догонит раньше — драться.
  // Лезет к человеку (b.climbing) — другие задачи драйвера (обмен бронёй, «прикрываю», сундуки, сбор) его не дёргают
  // (13.10: «сижу в нычке — никто не дошёл»: путь наверх в 45 шагов находился, но подъём рвали обмены и прикрытие — 0–3 бл.
  // за 20 с). Пропускаются только ответы на угрозу, свой подъём (_climb) и стоп.
  // Человек ворвался (ближе 6 бл.) — подъём/подкоп уже не главное (13.10: «бот строит, я врываюсь — должен видеть меня и
  // решать: драться тем, что есть, или уходить, отбиваясь»): тревога рвёт дело, цикл выбирает бой или отход.
  const enemyClose = (b) => {
    const p = pos[b.name]?.p, at = Date.now()
    return !!p && !!ctx.swarmDriver && ctx.swarmDriver.enemies(b).some(e => recentBody(e, at) && Math.abs(e.position.y - p.y) < 2.5 && dist3(e.position, p) < 6)
  }
  // Выход из лавы, уход от динамита и срез паутины — тоже ответ на угрозу: «лезу к цели» глушил их (стенд 22.10: «от динамита не
  // ушёл — skipped» у пятерых лезущих разом).
  // Реакции на жемчуг человека — тоже: он уже не там, куда лезут (стенд 25.10: засадчики в 14–20 бл. — «не взлетел — лезу к цели»,
  // встречено 0 из 15 жемчугов).
  const CLIMB_OK = /^(status|fight_guard|wind_report|enemy_wind_plan|emote|look_at|armor|team_hint|mobs|rescue_config|wind_leap|dig_to|undercut|watch_dangers|evade|juke|take_cover|douse_lava|lava_escape|dodge_blast|clear_web|wind_jump|pearl_to|fly_to|mine|cache_scan|pearl_ambush|pearl_trap|pearl_pop|pearl_potion|boost_lance|boost_shot)$/
  // Открытый сундук — в opened: по нему таймер пополнения (ARMS_LOOT_X) знает, что пополнять. Раньше его отмечал старый
  // лут ffa, после роя — никто, и пополнение не работало вовсе (14.10). Ключ — как у L.chests (от центра карты), вторая
  // половина двойного — по pair.
  const same = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z
  const markOpened = at => { const c = L?.chests.find(c => same({ x: X + c.x, y: Y + c.y, z: Z + c.z }, at) || same(c.pair, at)); if (c) ctx.opened.add(`${c.x},${c.y},${c.z}`) }
  const notStarted = new WeakMap<object, any>()
  const restoreOwner = (b, action, previous, round) => {
    // The native owner survived admission. Other unstarted requests may have replied first.
    let owner = previous
    while (owner && notStarted.has(owner)) owner = notStarted.get(owner)
    notStarted.set(action, owner)
    if (b.last === action) b.last = ctx.round === round && !ctx.between ? owner : null
  }
  for (const b of bots) { const raw = b.c.call.bind(b.c); b.c.call = (m, p) => {
    if (m === 'goto' && !ctx.between && b.shieldHold && b.shieldHold.round === ctx.round &&
        b.last?.m === 'swarm_hold' && b.last.pending && b.last.p?.whileSmash && b.last.round === ctx.round)
      return Promise.resolve({ status: 'failed', notStarted: true, code: 'DEFENSE_BUSY', error: 'держу щит к падающей булаве' })
    p = { ...p, arena: p?.arena || arena }
    // Мгновенные запросы (items_near, blocks_around) — не дело: перекрывали настоящее последнее, и сторож «сбрасывал items_near».
    const observation = m === 'parkour' && p.mode === 'options' || /^(status|observe|fight_guard|wind_report|enemy_wind_plan|wind_out|swarm_pose|swarm_position|emote|look_at|armor|team_hint|stop|mobs|rescue_config|watch_dangers|swarm_keep|items_near|blocks_around|cache_scan|pearl_plan)$/.test(m)
    const round = ctx.round
    const previous = b.last?.round === round ? b.last : null
    const action = observation ? null : (b.last = { m, round, at: Date.now(), p, pending: true, status: undefined as string | undefined, assisted: false, reached: false,
      ...(m === 'goto' && { walkOwner: b.swarmTurnOwner, idleAfterWalk: false }) })
    const out = raw(m, p)
    if (action) Promise.resolve(out).then(r => {
      action.pending = false
      action.status = r?.status
      if (r?.notStarted && (r.code === 'ACTION_EXPIRED' || m === 'goto' && r.code === 'DEFENSE_BUSY' ||
          m === 'evade' && r.code === 'NO_SAFE_EVADE')) {
        restoreOwner(b, action, previous, round)
        return
      }
      if (m === 'assist') action.assisted = r?.detail?.ok === true
      if (m === 'goto') {
        action.idleAfterWalk = r?.status === 'timeout' && r.state?.busy === null
        const at = r?.detail?.arrived
        action.reached = p.arenaFloor ? r?.status === 'done' && r.detail?.target?.mode === 'arenaFloor' && at?.y === p.y :
          atWalkGoal(at && p.exactY ? { ...at, y: r.detail.arrivedY } : at, p)
      }
      if (m === 'chest_take' && r?.detail?.at && ctx.round === round && !ctx.between) markOpened(r.detail.at)
      if (r?.code === 'RESCUE_BUSY' && pos[b.name]) pos[b.name].rescuing = true
    }, e => {
      action.pending = false
      if (m === 'goto' && e?.notStarted === true && e.code === 'ARENA_BOUNDARY') restoreOwner(b, action, previous, round)
    })
    return out
  } }
  // Обёртка подъёма — внешняя, после учёта b.last: пропущенный «лезу к цели» вызов (обмен, лут) не перезаписывает b.last
  // (копатель шёл к яме с _hunt, обмен перезаписывал его, тревога видела «не к человеку» и слала stop — 29 «cancelled»).
  for (const b of bots) { const raw0 = b.c.call.bind(b.c); b.c.call = (m, p) => {
    // Прицел не отбирает успешный подъём; аварийный evade, лава и взрыв проходят как прежде.
    const aim = /^(juke|take_cover)$/.test(m) || m === 'swarm_hold' && p?.whileDraw
    const own = !p?._climb && aim && ascentActive(b, pos[b.name])
    // Засада, ловушка, разгон к жемчугу идут до его появления — мелкие приказы их не рвут (бой роя 24.10: «прервали (бег)»
    // 11 из 50 засад — новый ход, реакция или stop за секунду до удара); проходят аварийные и запросы.
    // Враг вплотную (≤ 6 бл.) — засада уступает: бот стоял 5 с в «засаде», пока человек его рубил (игра пользователя 24.10).
    const punish = b.last?.pending !== false && /^(pearl_ambush|pearl_trap|boost_lance|boost_shot|wing_orbit)$/.test(b.last?.m || '') &&
      !/^(status|observe|fight_guard|wind_report|enemy_wind_plan|wind_out|swarm_pose|emote|look_at|armor|team_hint|mobs|rescue_config|watch_dangers|swarm_keep|items_near|blocks_around|cache_scan|pearl_plan|pearl_pop|pearl_potion|lava_escape|dodge_blast|evade|clear_web|douse_lava)$/.test(m)
    const climbing = b.climbing && !b.grabbing && !p?._climb && !CLIMB_OK.test(m) && !(m === 'swarm_hold' && p?.whileSmash)
    if (own || (punish || climbing) && !(m === 'stop' && ctx.between) && !enemyClose(b))
      return Promise.resolve({ status: 'skipped', detail: { why: punish ? `занят: ${b.last.m}` : 'лезу к цели' } })
    return raw0(m, p)
  } }
}

export function watchStatus (ctx: ArenaContext) {
  const { teams, arms, bots, names, pos, busy, out, deadNow, labNeed, rel, X, Y, Z, L, STOPF, HUMAN_TEAM, teamOf, log } = ctx
  const deathRadio = randomUUID()
  const mobInfo: Record<string, any> = {}
  let tailTraceAt = 0
  const panicStops = new WeakMap<object, { round: number, action: any }>()
  const spreading = new WeakMap<object, { round: number, holder: string, mate: string, action: any }>()
  const digging = new WeakMap<object, { round: number, action: any, cells: Set<string>, at: number }>()
  const holdClock = new WeakMap<object, { id: string | number, startTick: number, owner: string | null }>()
  const lifeStart = b => Math.max(ctx.roundT0 ?? 0, ctx.deathAt?.[b.name]?.at ?? 0)
  const ownsWalk = (b, action) => !action?.walkOwner || action.walkOwner === b.swarmTurnOwner && !action.walkOwner.cancelled
  // Мобы глазами бойцов — раз в секунду (только с мобами на арене: ARMS_MOBS).
  const mobPollT = process.env.ARMS_MOBS ? setInterval(() => {
    for (const b of bots) {
      if (!pos[b.name]?.p || deadNow.has(b.name)) continue
      b.c.call('mobs', { radius: 24 }).then(r => {
        const list = (r?.detail || r)?.mobs || []
        if (pos[b.name]) pos[b.name].mobs = list
        for (const m of list) mobInfo[`mob${m.id}`] = m
      }).catch(() => {})
    }
  }, 1000) : null
  // Сторож зависаний (10.10: «подвисают, ничего не делая — фармлю их»): живой боец 8 с на месте, рядом (3 бл.) нет
  // врага и он не ждёт нарочно (сбор, хилка) — в журнал, чем занят (последний вызов демона и сколько длится), и стоп:
  // цикл бойца выберет дело заново.
  // Работа на месте (копка, прокоп, кладка, коробка, лестница, динамит) — не зависание в пределах своего бюджета: сброс через
  // 6 с рвал прокоп и добычу посреди блока (арены 36–40: десятки «🧊 стоит 6 с — dig_to/mine — сброс»).
  const frozenT = setInterval(() => {
    if (ctx.between) return
    for (const b of bots) {
      const m = pos[b.name]
      const since = lifeStart(b), route = b.last
      if (belowArenaFloor(ctx, m?.p)) { b.anchor = null; continue }
      if (m?.p) {
        b.badSpots = (b.badSpots || []).filter(s => !s.from || (s.round === undefined || s.round === ctx.round) && (s.at === undefined || s.at >= since) && dist3(s.from, m.p) < 2).slice(-32)
        if (b.frozen && (b.frozen.round !== ctx.round || b.frozen.at < since || dist3(b.frozen.p, m.p) >= 2)) delete b.frozen
      }
      // Spectator/reset RPCs and late receipts can survive into the next life at the very same coordinates.
      const staleAction = route && ((route.round ?? ctx.round) !== ctx.round || route.at < since)
      const staleFrame = m && ((m.watchRound ?? ctx.round) !== ctx.round || m.frameAt < since || (m.hpAskedAt ?? m.observedAt) < since)
      const cancelledWalk = route?.m === 'goto' && route.pending === false && route.status === 'interrupted'
      if (staleAction || staleFrame || cancelledWalk || route?.pending === false && !ownsWalk(b, route)) { b.anchor = null; continue }
      if (b.anchor && (b.anchor.round !== undefined && b.anchor.round !== ctx.round || b.anchor.at < since)) b.anchor = null
      const ascending = ascentActive(b, m), run = b.swarmAscent
      // Под стрелами стоящий подъём один раз уступает выходу; старый RPC не останавливает новую аварию.
      if (!m?.rescuing && !ascending && run?.pending && run.stalled && !run.stopping && ctx.alive(b.name) && underArrowFire(b) &&
          m?.p && Number.isFinite(m.observedAt) && Number.isFinite(m.frameAt) && Date.now() - Math.min(m.observedAt, m.frameAt) <= 5000 &&
          !/^(Tactical|Emergency)$/.test(m.tactics?.owner || '') &&
          b.last?.pending !== false && b.last?.p?._climb && /^(goto|wind_leap|fly_to|pearl_to|ladder_up)$/.test(b.last?.m || '')) {
        run.stopping = true
        log(`🧊 ${b.name}: подъём встал под стрелами — ищу выход`)
        b.c.call('stop', { _climb: true }).catch(() => {})
      }
      // Стойка на месте (засада кемпера, кольцо щитов, оцепление) — её дело и есть стоять (кемпер в коробке: «стоит 6 с — сброс»).
      // (на месте: по дороге к засаде сторож нужен — зависший поход иначе не сбрасывался; Codex 15.10)
      if (!m?.p || m.rescuing || !ctx.alive(b.name) || b.waiting || b.climbing || b.swarmReserved || b.swarmTask?.data?.hold && b.swarmTask.position && dist3(b.swarmTask.position, m.p) < 1.5 ||
        // Приманка ложного отхода ест у сбора, насест — сидит и стреляет: на своём месте это дело, а не зависание (cl28a: «eat (0 с)» ×6 в начале раунда).
        (b.swarmTask?.data?.bait || b.swarmTask?.data?.perch) && b.swarmTask.position && dist3(b.swarmTask.position, m.p) < 3 || b.swarmExecuting && (b.swarmBusyUntil || ctx.swarmDriver?.holding?.(b)) || busy.has(b.name) || (b.last?.m === 'craft' && b.last.pending) || (/^(mine|dig_to|swarm_work|box_in|box_out|ladder_up|tnt_at)$/.test(b.last?.m || '') && Date.now() - b.last.at < ((b.last.p?.timeoutSeconds ?? 12) + 2) * 1000)) { b.anchor = null; continue }
      // A delayed status or paused native physics is not evidence that a route is physically stuck.
      if (!Number.isFinite(m.observedAt) || !Number.isFinite(m.frameAt) || Date.now() - Math.min(m.observedAt, m.frameAt) > 5000) { b.anchor = null; continue }
      // These actions have no travel destination. A failed lava exit is retried by dangerLava from a fresh hazard observation.
      const localAction = route?.m === 'swarm_work' || route?.m === 'swarm_hold' || route?.m === 'lava_escape'
      if (route?.pending === false) {
        const arrived = route.m === 'goto' && (route.reached || atWalkGoal(m.p, route.p))
        const leftEscape = route.m === 'flee' && b.swarmTask && b.swarmTask.kind !== 'flee'
        const finishedPickup = route.m === 'assist' && route.p?.mode === 'pickup'
        if (localAction || route.status === 'done' && (arrived || leftEscape || route.m === 'chest_take' || finishedPickup || route.assisted)) { b.anchor = null; continue }
      }
      if (b.last?.m === 'goto' && b.last.pending !== false && m.targetDig) {
        let work = digging.get(b)
        if (work?.round !== ctx.round || work.action !== b.last) digging.set(b, work = { round: ctx.round, action: b.last, cells: new Set(), at: b.last.at })
        const key = `${m.targetDig.x},${m.targetDig.y},${m.targetDig.z}`
        if (!work.cells.has(key)) { work.cells.add(key); work.at = Date.now() }
      }
      if (!b.anchor || dist3(b.anchor.p, m.p) > 1) { b.anchor = { p: { ...m.p }, at: Date.now(), round: ctx.round }; continue }
      // Свежий бой и начатое употребление предмета не наследуют неподвижность предыдущего дела.
      const ownStart = b.last?.m === 'fight' || (b.swarmTask?.kind === 'recover' && b.last?.pending && (b.last.m === 'eat' || b.last.m === 'antidote'))
      const still = Date.now() - (ownStart ? Math.max(b.anchor.at, b.last.at) : b.anchor.at)
      // Новый блок — работа на месте в том же бюджете; один застывший target или повтор клеток его не продлевает.
      const work = digging.get(b)
      if (b.last?.m === 'goto' && Date.now() - Math.max(b.last.at, work?.action === b.last && work.round === ctx.round ? work.at : 0) < ((b.last.p?.timeoutSeconds || 10) + 2) * 1000) continue
      if (b.last?.m === 'chest_take' && Date.now() - b.last.at < (Math.min(45, b.last.p?.timeoutSeconds ?? 45) + 4) * 1000) continue
      if (b.last?.m === 'assist' && Date.now() - b.last.at < assistTimeoutMs(b.last.p?.mode) + 1000) continue
      // Стойка роя (щит, засада, оцепление, ожидание у стройки) стоит нарочно: сброс рвал её 36 раз за 2.5 мин (арена 14.10).
      if (route?.m === 'swarm_hold') {
        const budget = swarmHoldTimeoutMs(route.p || {}) + 1000
        const sample = holdClock.get(route)
        if (Date.now() - route.at < budget || sample && sample.id === m.clockId &&
            (sample.owner !== 'swarm_hold' || (m.tick - sample.startTick) * 50 < budget)) continue
      }
      // The old frozen anchor predates a fresh escape; allow its first movement sample.
      if (/^(flee|evade|juke)$/.test(b.last?.m || '') && Date.now() - b.last.at < Math.min(5, (b.last.p?.timeoutSeconds ?? 3) + 2) * 1000) continue
      // Враг вплотную, а я стою и не в бою — это хуже всего (10.10: «стоит рядом, не атакует, я ваншочу»): 3 с; иначе 5 с.
      const near = ctx.enemiesOf(b, m.p).some(e => e.d < 3)
      if ((near && b.last?.m === 'fight') || still < (b.last?.m === 'fight' ? 8000 : near ? 3000 : 5000)) continue
      const L0 = b.last || {}
      const goal = localAction ? null : L0.p?.at || L0.p?.to || L0.p
      // Отказ конкретного подхода: снимается сменой стойки/раунда, а не ожиданием; читатель — swarm-driver (1b).
      if (goal && Number.isFinite(goal.x) && !(b.badSpots || []).some(s => dist3(s, goal) < 1)) (b.badSpots ||= []).push({ x: goal.x, y: goal.y, z: goal.z, from: { ...m.p }, round: ctx.round, at: Date.now() })
      log(`🧊 ${b.name} стоит ${Math.round(still / 1000)} с — ${L0.m || '?'} ${L0.p?.item || L0.p?.target || L0.p?.mode || ''} (${L0.at ? Math.round((Date.now() - L0.at) / 1000) + ' с' : ''}${L0.pending ? ', ждёт ответа' : ', ответ ' + (L0.status || '?')}; ход ${b.swarmTask?.kind || '-'}${b.swarmExecuting ? '' : ' вне хода'}${L0.p?.timeoutSeconds ? '; срок ' + L0.p.timeoutSeconds + ' с' : ''}${L0.p?.climb ? ', climb' : ''}; y ${m.p.y.toFixed(0)}${Number.isFinite(goal?.y) ? '→' + goal.y.toFixed(0) + ' в ' + Math.round(dist3(goal, m.p)) + ' бл.' : ''}) — ${L0.idleAfterWalk ? 'путь завершён, подход застрял' : 'сброс'}`)
      if (localAction) { b.anchor = null; b.c.call('stop').catch(() => {}); continue }
      // Участок подъёма мог закончиться на промежуточном ярусе. Отсюда можно искать новый подход к верхней цели.
      const ascendingRoute = L0.m === 'goto' && Number.isFinite(goal?.y) && goal.y > m.p.y
      const dropToField = !ascendingRoute && m.p.y > Y + 3 &&
        !(SOLO && ctx.swarmDriver?.enemies(b).some(e => !names.includes(e.id) && !e.nametag && !e.glowing &&
          Date.now() - e.seenAt < 1500 && e.position.y > Y + 6))
      // Второй сброс на том же месте (2 бл.) — путь отсюда не строится (желоб у края поля с дном из плачущего обсидиана:
      // «застрял на air у air», 31i 22 сброса за 196 с, 15.10): выбраться простыми шагами — dig_to к цели (прыжок, подкоп, блок).
      b.frozen = b.frozen && dist3(b.frozen.p, m.p) < 2 ? { ...b.frozen, n: b.frozen.n + 1 } : { p: { ...m.p }, round: ctx.round, at: Date.now(), n: 1 }
      const to = goal && Number.isFinite(goal.x) && Number.isFinite(goal.z) ? goal : { x: X + .5, y: Y, z: Z + .5 }
      const recovery = JSON.stringify([to.x, to.y, to.z, Object.keys(m.inv || {}).filter(n => /_(pickaxe|shovel|axe)$/.test(n)).sort()])
      const action = b.last, round = ctx.round
      const mayRecover = () => !ctx.between && ctx.round === round && lifeStart(b) === since && b.last === action && ownsWalk(b, action) && !busy.has(b.name) && ctx.alive(b.name) &&
        !pos[b.name]?.rescuing && !belowArenaFloor(ctx, pos[b.name]?.p)
      const stopWalk = () => action?.idleAfterWalk ? Promise.resolve() : b.c.call('stop').catch(() => {})
      if (b.frozen.n >= 2 && b.frozen.recovery !== recovery) stopWalk().then(() => {
        if (!mayRecover()) return
        b.frozen.recovery = recovery
        return b.c.call('dig_to', { at: { x: to.x, y: Number.isFinite(to.y) ? to.y : m.p.y, z: to.z }, arena: action?.p?.arena || arenaBounds(ctx), maxSteps: 4, timeoutSeconds: 6 })
      })
        .then(r => {
          if (ctx.round !== round || !r) return
          const d = r?.detail || r || {}
          if ((d.steps > 0 || d.dug > 0) && b.frozen?.recovery === recovery) delete b.frozen.recovery
          log(`🧊 ${b.name}: выбираюсь шагами — ${d.steps ?? 0} шаг., ${d.dug ?? 0} бл.${d.why ? ' (' + String(d.why).slice(0, 50) + ')' : ''}`)
        }).catch(() => {})
      // Застрял на крыше вне подъёма — спуск к полю с разрешённым падением. Резерв защищает спуск до ответа.
      else if (dropToField && !b.swarmReserved) {
        const token = {}, from = m.p.y
        b.swarmReserved = token
        stopWalk().then(() => !mayRecover() || b.swarmReserved !== token ? null :
          b.c.call('goto', { x: X + .5, y: Y, z: Z + .5, arenaFloor: true, timeoutSeconds: 8, climb: true, descent: { maxFallDamage: 8, minGain: 0 } }))
          .then(r => { if (r && ctx.round === round) log(`🪂 ${b.name}: спуск с высоты ${Math.round(from - Y)} — ${r.detail?.stopped || r.detail?.why || r.status || '?'} → y ${Math.round(r.detail?.arrived?.y ?? pos[b.name]?.p?.y ?? from)}`) })
          .catch(() => {}).finally(() => { if (b.swarmReserved === token) delete b.swarmReserved })
      } else stopWalk()
      b.anchor = { p: { ...m.p }, at: Date.now(), round: ctx.round }
    }
  }, 2000)
  // Разбор стояний у человека (ARENA_TRACE_NEAR=1, стенд бота-противника 22.10): раз в секунду — кто в 8 бл. от человека и чем занят.
  if (process.env.ARENA_TRACE_NEAR) setInterval(() => {
    if (ctx.between) return
    for (const b of bots) {
      const m = pos[b.name]
      if (!m?.p || !ctx.alive(b.name)) continue
      const h = (ctx.swarmDriver?.enemies(b) || []).filter(e => !names.includes(e.id) && Date.now() - e.seenAt < 1500).map(e => [e.id, dist3(e.position, m.p)] as [string, number]).sort((a, c) => a[1] - c[1])[0]
      if (!h || h[1] > 8) continue
      const L0 = b.last || {}, t = b.swarmTask
      log(`🔎 ${b.name} ${h[1].toFixed(1)} бл.: ${L0.m || '-'}${L0.pending ? '…' : ''} ${L0.at ? ((Date.now() - L0.at) / 1000).toFixed(1) + 'с' : ''} | ${t ? t.kind + (t.data?.hold ? '/' + t.data.hold : '') + (t.data?.target ? '→' + t.data.target : '') : '-'}${busy.has(b.name) ? ' busy' : ''}${b.climbing ? ' climb' : ''}${b.swarmExecuting ? '' : ' вне хода'}${b.swarmFightReply?.status === 'interrupted' ? ' перебит' : ''} v=${(Math.hypot(m.v.x, m.v.z) * 20).toFixed(1)}`)
    }
  }, 1000)
  // Позиции всех — раз в секунду (цель — ближайший живой).
  const statusPolling = new Set<string>()
  const poll = setInterval(() => {
    if (ctx.between) return
    const observedRound = ctx.round
    ctx.readDeaths()
    if (fs.existsSync(STOPF)) ctx.stop = true
    // Ход — по смещению за секунду (б/т); «ранен» — его хп упало (вспышка удара, видна глазами), в решения хп не идёт.
    // ND_TAIL_TRACE: хвост раунда (у стороны ≤ 2 живых) — раз в 10 с состояние каждого живого: дело, вызов и его возраст, хп, высота,
    // ближний враг доски (дистанция, сколько не видели). Разбор «почему не сходятся» (29.10). ponytail: снять после разбора.
    if (process.env.ND_TAIL_TRACE && ctx.arms && Date.now() - tailTraceAt >= 10000) {
      const live = bots.filter(o => ctx.alive(o.name) && !out.has(o.name))
      if (Math.min(live.filter(o => o.team === 'red').length, live.filter(o => o.team === 'blue').length) <= 2) {
        tailTraceAt = Date.now()
        log('🔎 хвост: ' + live.map(o => {
          const p = pos[o.name]?.p, foes = p ? (ctx.swarmDriver.enemies?.(o) || []) : []
          const near = foes.map(e => ({ e, d: Math.hypot(e.position.x - p.x, e.position.y - p.y, e.position.z - p.z) })).sort((x, y) => x.d - y.d)[0]
          return `${o.name.replace('NeuroFarm29', '') || '#'}(${o.team[0]}) ${o.swarmTask?.kind || '-'}→${o.swarmTask?.data?.target?.replace('NeuroFarm29', '') ?? '-'} ` +
            `${o.last?.m || '-'}${o.last?.pending ? '…' + Math.round((Date.now() - o.last.at) / 1000) + 'с' : ''} хп ${pos[o.name]?.hp ?? '?'} y ${p ? p.y.toFixed(0) : '?'}` +
            ` лук${pos[o.name]?.inv?.bow || 0}/арб${pos[o.name]?.inv?.crossbow || 0}/стр${pos[o.name]?.inv?.arrow || 0}/рак${pos[o.name]?.inv?.firework_rocket || 0} ед ${pos[o.name]?.food ?? "?"}/${Object.entries(pos[o.name]?.inv || {}).filter(([n]) => /^(bread|cooked_.*|golden_apple|enchanted_golden_apple|apple|baked_potato|golden_carrot|carrot|melon_slice|.*_stew)$/.test(n)).reduce((a, [, c]: any) => a + c, 0)}` +
            (near ? ` враг ${near.e.id.replace('NeuroFarm29', '') || '#'} ${near.d.toFixed(0)} бл. ${((Date.now() - near.e.seenAt) / 1000).toFixed(0)}с` : ' врагов нет') +
            // Цель дела: что знает доска (место, возраст, угроза) и где она на деле (телеметрия, только для разбора).
            (() => {
              const id = o.swarmTask?.data?.target, e = id && foes.find(f => f.id === id), q = id && pos[id]?.p
              if (!id || !p) return ''
              const dist = (a: any) => Math.hypot(a.x - p.x, a.y - p.y, a.z - p.z).toFixed(0)
              return ` | цель ${e ? `доска y ${e.position.y.toFixed(0)} ${dist(e.position)} бл. ${((Date.now() - e.seenAt) / 1000).toFixed(0)}с ${e.threat || '-'}` : 'нет на доске'}` +
                (q ? ` на деле y ${q.y.toFixed(0)} ${pos[id].gliding ? "летит" : "не летит"} ${dist(q)} бл. сдвиг ${e ? Math.hypot(q.x - e.position.x, q.z - e.position.z).toFixed(0) : '?'}` : '')
            })()
        }).join('; '))
      }
    }
    for (const b of bots) {
      // Демон молчит ≥ 20 с (cl53onD1: упал по нехватке памяти) — спросить сервер, держит ли он игрока: нет — выбыл, как погибший
      // (иначе его числили живым по старому месту, последний красный «жил» 6 мин и раунд кончался по времени). В игре — ждём.
      if (ctx.arms && b.silentSince && Date.now() - b.silentSince >= 20000 && !b.onlineCheck && !out.has(b.name) && !deadNow.has(b.name)) {
        b.onlineCheck = true
        const silenceAt = b.silentSince = Date.now()
        Promise.resolve(ctx.rcon(ctx.i, 'list')).then(r => {
          if (ctx.between || ctx.round !== observedRound || b.silentSince !== silenceAt || out.has(b.name) || deadNow.has(b.name)) return
          const list = /^There are (\d+) of a max of \d+ players online:\s*(.*)$/s.exec(String(r || '').trim())
          if (!list) return
          const online = list[2].split(',').map(n => n.trim()).filter(Boolean)
          if (online.length !== Number(list[1])) return
          if (!online.includes(b.name)) {
            // Из живых — сразу: цикл бойца ещё ждёт зависший вызов (стенд 29: 👻 через 2 мин после отказа), зритель и 👻 — им же.
            log(`🔌☠ ${b.name}: демон молчит, на сервере нет — выбыл`); deadNow.add(b.name); out.add(b.name); ctx.swarmDriver?.release?.(b); ctx.endRound?.()?.catch?.(() => {})
          }
        }).catch(() => {}).finally(() => { b.onlineCheck = false })
      }
      if (statusPolling.has(b.name)) continue
      statusPolling.add(b.name)
      b.silentSince ||= Date.now()
      // Наблюдение не старше запроса: демон снимает его, когда отвечает, — время приёма делало его свежее, чем оно есть
      // (под нагрузкой ответ идёт сотни мс; ревью 14.10).
      const asked = Date.now(), askedAction = b.last
      b.c.call('status', {
      swarm: true, deathScope: deathRadio + ':' + observedRound, dangers: arms, physics: b.last?.m === 'goto' && b.last.pending !== false,
      swarmAllies: teams ? bots.filter(o => o.team === b.team).map(o => o.name) : []
    }).then(s => {
      if (ctx.between || ctx.round !== observedRound) return
      if (s) b.silentSince = 0
      // Ответил без тела (выкинут сервером: «Invalid move player packet») — забыть старое место: иначе рой водил его по
      // стухшей позиции до конца раунда (бой роя 24.10, NeuroFarm30u), а цикл бойца ждёт pos и переподключает.
      if (s && !s.state?.pos) delete pos[b.name]
      const p = s?.detail?.at || s?.state?.pos, below = belowArenaFloor(ctx, p)
      if (s?.detail?.witnessedDeaths?.length) {
        const reports = !below && ctx.alive(b.name) ? s.detail.witnessedDeaths : s.detail.witnessedDeaths.filter(d => d.self)
        ctx.swarmDriver.observeDeaths?.(b, reports, asked)
      }
      if (!s?.state?.pos) return
      const was = pos[b.name]
      // Зелья (12.10: «кидаю зелья — стоят со щитом и помирают; видно же, что я взял зелье»): щит брызги не держит. Летит
      // вредное (или неизвестное) и ляжет в 4.5 бл. — рывок на 5 бл. от точки падения; у врага взрывное вредное в руке, а
      // свой стоит вплотную (≤ 2.5 бл.) — разойтись на 4, чтобы одно зелье не накрыло двоих.
      const dz = s.detail?.dangers
      if (!below && dz && !s.detail?.rescuing && ctx.alive(b.name) && !out.has(b.name)) {
        const holder = (dz.holders || []).find(hd => teams ? teamOf(hd.name) !== b.team && !(rel[b.team][hd.name] > 0) : true)
        // В рукопашной (враг в 3.5 бл.) не расходиться: отход на 4 бл. дарит ему удары, а бой рвался — каждый четвёртый
        // оборванный бой стенда 15×15 был «расходимся» (21.10: 24 из 94).
        // Идущий бой — тоже: человек держит зелье в руке не бросая, и «расходимся» рвал подход каждые 1–2 с (игра пользователя
        // 24.10: 61 из 65 боёв прерваны, 9 попаданий). От брошенного уходит рывок по точке падения выше.
        // Толпа (вплотную двое своих и больше) — расходиться и в идущем бою: на крыше колизея кучу накрывало одно зелье (игра
        // пользователя 25.10: «толпятся сверху — зельями херачу, подыхают»). Рукопашная в 3.5 бл. — по-прежнему стоять.
        const close = holder ? names.filter(n => n !== b.name && teamOf(n) === b.team && ctx.alive(n) && pos[n]?.p && Math.hypot(pos[n].p.x - p.x, pos[n].p.z - p.z) <= 2.5) : []
        const melee = (b.last?.m === 'fight' && b.last.pending !== false && close.length < 2) ||
          (s.detail?.sightings || []).some(e => e.id !== b.name && teamOf(e.id) !== b.team && dist3(e.position, p) <= 3.5)
        const mate = holder && !melee && close[0]
        const old = spreading.get(b)
        if (!holder || old && (!pos[old.mate]?.p || dist3(pos[old.mate].p, p) >= 4)) spreading.delete(b)
        if (mate && !busy.has(b.name) && !(b.last?.pending !== false && /^(evade|juke|flee)$/.test(b.last?.m || '')) && (!spreading.has(b) || old.round !== ctx.round || old.holder !== holder.name || old.mate !== mate || old.action !== b.last)) {
          spreading.set(b, { round: ctx.round, holder: holder.name, mate, action: b.last })
          log(`🧪↔ ${b.name}: у ${holder.name} зелье в руке, рядом ${mate} — расходимся`); ctx.dodgeAway(b, p, pos[mate].p, 4, null, { x: holder.at.x, y: holder.at.y + 1.6, z: holder.at.z })
        }
      }
      // Игровые тики (clock.ticks): на ускоренном сервере секунда стены — десятки игровых.
      const tick = s.state.clock?.ticks ?? 0
      const dt = was && was.p && tick > was.tick ? tick - was.tick : 0
      const v = dt ? { x: (p.x - was.p.x) / dt, y: (p.y - was.p.y) / dt, z: (p.z - was.p.z) / dt } : { x: 0, y: 0, z: 0 }
      // «Ранен» — только рядом с противником (≤ 8 бл.): своя посадка и удар о землю — не повод его добивать.
      const foeNear = (s.detail?.sightings || []).some(e => e.id !== b.name && teamOf(e.id) !== b.team && dist3(e.position, p) <= 8)
      const hurtTick = was && s.state.health < was.hp && foeNear ? tick : (was ? was.hurtTick : 0)
      if (!below && was && teams) {
        const visibleHumans = (s.detail?.sightings || []).filter(e => !names.includes(e.id))
        const hNear = visibleHumans.filter(e => dist3(e.position, p) <= 4.5).map(e => e.id)
        const botFoeNear = (s.detail?.sightings || []).some(e => names.includes(e.id) && teamOf(e.id) !== b.team && dist3(e.position, p) <= 4.5)
        // Свой человек (ARMS_HUMAN_TEAM, огонь по своим выключен) ранить не может — урон рядом с ним не его (10.10: стрелы, падение
        // и взрывы записывались ему — «враг: красные все на него», и свои стреляли в него).
        if (hNear.length && s.state.health < was.hp - 0.5 && !botFoeNear && !(teams && b.team === teamOfHuman(hNear[0], HUMAN_TEAM))) ctx.relSay(b.team, hNear[0], -3, `ударил ${b.name}`)
        const cnt = (inv) => Object.values(inv || {}).reduce((a: number, n: any) => a + (Number(n) || 0), 0) as number
        const nearChest = arms && L.chests.some(c => Math.hypot(X + c.x - p.x, Y + c.y - p.y, Z + c.z - p.z) < 4)
        const gNear = visibleHumans.filter(e => e.visible === true && dist3(e.position, p) <= 8).map(e => e.id)
        if (gNear.length && cnt(s.state.inventory) > cnt(was.inv) && !nearChest && !ctx.swarmDriver.knownDrops?.(b).some(d => dist3(d.p, p) < 6)) {
          const got = Object.entries(s.state.inventory || {}).filter(([n, c]: any) => c > ((was.inv || {})[n] || 0)).map(([n, c]: any) => [n, c - ((was.inv || {})[n] || 0)]) as [string, number][]
          const value = got.reduce((a, [n, c]) => a + worthOf(n) * (worthOf(n) >= 1 ? 1 : c), 0)
          log(`🎁 ${b.name} принял от ${gNear[0]}: ${got.map(([n, c]) => n + '×' + c).join(', ')} — ценность ${value.toFixed(1)}`)
          if (value >= 1) { ctx.relSay(b.team, gNear[0], Math.min(10, Math.round(value) + 1), `подарил ${b.name} ${got.map(([n]) => n).join(', ')}`); ctx.emote(b, 'crouch', ctx.eyeOf(gNear[0])).then(() => ctx.emote(b, 'wave')) }
        }
        const hHeal = visibleHumans.filter(e => dist3(e.position, p) <= 6).map(e => e.id)
        if (hHeal.length && s.state.health > was.hp + 3) ctx.relSay(b.team, hHeal[0], 2, `вылечил ${b.name}`)
      }
      const now = Date.now(), frame = s.state.physicsTicks ?? tick, clockId = s.state.clock?.id
      // The driver's extrapolated arena time can outrun a loaded body. Observe this request's
      // actual owner and count the native timeout from a confirmed sample on that body's clock.
      if (askedAction?.m === 'swarm_hold' && askedAction.pending && askedAction === b.last &&
          clockId != null && Number.isSafeInteger(s.state.clock.ticks) && s.state.busy !== undefined) {
        const prev = holdClock.get(askedAction)
        if (!prev || prev.id !== clockId || prev.owner !== s.state.busy) holdClock.set(askedAction, { id: clockId, startTick: tick, owner: s.state.busy })
      }
      const frameAt = was?.frame === frame && was?.clockId === clockId ? (was.frameAt ?? now) : now
      pos[b.name] = { p, v, hp: s.state.health, food: s.state.food, gliding: !!s.state.gliding, rescuing: !!s.detail?.rescuing, combo: s.detail?.combo || null, lance: s.state.lance || null, hurtTick, tick, frame, clockId, frameAt, observedAt: now, tactics: s.state.tactics, pots: (s.state.inventory || {}).splash_potion || 0, inv: withOffHand(s.state.inventory, s.state.offHand), attackArrows: s.state.attackArrows, armor: s.state.armor || {}, offHand: s.state.offHand || null, potions: s.state.potions || {}, enchants: s.detail?.ownEnchants || [], labNeed: labNeed[b.name] || [], water: !!s.detail?.water }
      pos[b.name].watchRound = observedRound
      pos[b.name].hpAskedAt = asked
      pos[b.name].loadedCrossbow = !!s.state.loadedCrossbow
      pos[b.name].targetDig = s.detail?.physics?.pathfinder?.mining ? s.detail.physics.targetDig : null
      pos[b.name].antidote = s.state.antidote ? { ...s.state.antidote, receivedAt: now } : undefined
      if (!below && dz && !pos[b.name].rescuing) b.c.onDanger?.({ pos: p, dangers: dz, observedAt: asked, status: true })
      // Реактивный сброс ветром (тело: combat/wind-out): попытки — в журнал, бросок — метка на цели для учёта смерти.
      for (const w of s.detail?.windOut || []) {
        if (w.kind === 'shield') { log(`🛡⬇ ${b.name}: ${w.target} падает с булавой (через ${w.ticks} т.) — щит к нему`); continue }
        if (w.kind === 'descend') { log(`🔨 ${b.name}: подброшен с булавой — удар сверху по ${w.target}: ${w.hit ? 'попал' : 'мимо'}`); continue }
        if (w.ally) { log(`🤸 ${b.name} → ${w.ally}: ${w.kind === 'volley' ? 'волейбол' : 'батут'} на ${w.target}, подброс ${w.kick} бл./т — ${w.fired ? (w.hit ? 'бросил, враг ранен в 2 с' : 'бросил, враг не ранен') : 'не бросил'}`); continue }
        log(`🌬↗ ${b.name} → ${w.target}: ${w.kind}, до края ${w.edge} бл.${w.air ? ', в воздухе' : ''}, прогноз +${w.progress} бл.${w.airGain ? `, в воздухе +${w.airGain} т.` : ''} — ${w.fired ? 'бросил' + (w.burst ? ', взрыв виден' : '') + (w.edgeAfter !== undefined ? `, через 8 т. до края ${w.edgeAfter} бл., y ${w.yAfter}` : '') + (w.foiled !== undefined ? (w.foiled ? `, заход сорван (прошёл в ${w.passed} бл.)` : `, заход не сорван (${w.passed} бл.)`) : '') : 'отказ: ' + (w.why || '?')} (план ${w.planMs} мс), я: до края ${L?.ellipse ? require('../../daemon/src/combat/team-wind').arenaRoom({ x: X + .5, z: Z + .5, r: 0, ellipse: L.ellipse }, p).toFixed(1) : '?'} бл., y ${p.y.toFixed(1)}${w.dbg ? ' | ' + w.dbg : ''}`)
        if (w.fired) (ctx.windOutAt ||= {})[w.target] = { by: b.name, at: Date.now(), kind: w.kind }
      }
      if (below) return
      if (s.detail?.breaches?.length && ctx.alive(b.name)) ctx.swarmDriver.observeBreaches?.(b, s.detail.breaches, asked)
      if (s.detail?.pearls?.length) ctx.swarmDriver.pearlObserve?.(b, s.detail.pearls)
      ctx.swarmDriver.observe(b, s.detail?.sightings || [], asked)
      const panic = ctx.swarmDriver.panic(b), oldPanic = panicStops.get(b)
      if (!panic) panicStops.delete(b)
      // Рефлекс опасности (выход из лавы, рывок от зелья и булавы — busy) паника не рвёт: «стоп» посреди выхода из лавы
      // оставлял тело в ней (стенд 15×15, 21.10: 5 из 16 смертей — «🌋 отхожу», «⚡ стоп», «в лаве»).
      if (!ctx.between && ctx.alive(b.name) && !pos[b.name].rescuing && !busy.has(b.name) && !ascentActive(b, pos[b.name]) && !/^(flee|evade|juke)$/.test(b.last?.m || '') && b.swarmTask?.kind !== 'flee' && panic && (!oldPanic || oldPanic.round !== ctx.round || oldPanic.action !== b.last)) {
        panicStops.set(b, { round: ctx.round, action: b.last })
        ctx.swarmDriver.release(b)
        log(`⚡ ${b.name}: паника (${b.panicWhy || '?'}) — стоп ${b.last?.m || '?'}`)
        b.c.call('stop').catch(() => {})
      }
    }).catch(() => {}).finally(() => statusPolling.delete(b.name))
    }
  }, Number(process.env.FFA_POLL_MS || 250))
  return { mobPollT, frozenT, poll }
}

// Дроп, стрелы, опыт — раз в 30 с по габариту Колизея (вещи копились и тормозили игру). Ракеты и трезубцы в
// полёте не трогаем: ракета держит разгон элитр.
export function watchBoard (ctx: ArenaContext) {
  const { i, arms, BOX, rcon, log } = ctx
  return setInterval(() => {
    log('счёт (убил/умер) ' + ctx.board())
    fs.writeFileSync(path.join(ROOT, 'farm', `swarm-${i}.json`), JSON.stringify(ctx.swarmDriver.snapshot(), null, 2))
    for (const t of arms ? ['arrow', 'experience_orb'] : ['item', 'arrow', 'experience_orb']) rcon(i, `kill @e[type=${t},${BOX}]`).catch(() => {})
  }, 30000)
}
