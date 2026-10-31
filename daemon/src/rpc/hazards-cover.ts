'use strict'
// RPC демона — опасности: финт, укрытие, слежка за угрозами, мобы рядом.
// Фабрика методов над контекстом демона (rpc/context.ts); обработчики перенесены из src/index.ts.
import type { RpcContext } from './context'
import * as pick from '../pick'
import { archerCover, archerCovered, steerArcherCover } from '../pvp/archer-cover'

function hazardCoverMethods ({ session, gameClock, state }: RpcContext) {
  const coverShooters = new Map<string, any>()
  return {
    // Джук под прицелом (12.10, арена: «целюсь из лука — стоят; стрейфить, прыгать, заранее, как только нацеливаюсь»;
    // замер farm/scenes/arena-archer-test: рывки по 0.3 с с паузами — 80 % попаданий с 8 бл.). Пока стрелок (from) целится в меня
    // или летит его стрела — без пауз зигзаг поперёк линии на него: отрезки случайной длины (3–9 тиков), сторона меняется
    // случайно (не строго через раз — упреждение человека не угадает), по стенам — flee.runLength (упёрся — в другую
    // сторону или назад от него). Взгляд — на стрелка; прыжки — с долей jumpy. Летит стрела — сразу поперёк её хода.
    // retreat — уходить от него (зигзагом назад): ответить нечем. Конец — прицела нет 6 тиков подряд или maxTicks.
    juke: async (p: any = {}) => session.runIntent('juke', async (ctl) => {
      const bot = session.require()
      const fl = require('../flee'); const th = require('../threats')
      const name = String(p.from || '')
      const maxTicks = Math.max(10, Math.min(200, Math.round(p.maxTicks ?? 80)))
      try { if (bot.usingHeldItem) bot.deactivateItem() } catch {}
      const jumpy = Number.isFinite(p.jumpy) ? p.jumpy : 0.6
      bot.pathfinder?.setGoal(null)
      const mvw = require('../movement')
      if (mvw.inWater(bot)) await mvw.escapeWater(bot, ctl, { timeoutMs: 5000 }).catch(() => null)
      let side = Math.random() < 0.5 ? 1 : -1; let segLeft = 0; let dx = 0; let dz = 0; let quiet = 0; let t = 0; let segs = 0
      const sight = require('../pvp/last-seen').createLastSeen(bot)
      let shooter = sight.observe(bot.players[name]?.entity)
      let cover = null
      const keys = () => {
        const yaw = bot.entity.yaw
        const fwd = -Math.sin(yaw) * dx - Math.cos(yaw) * dz
        const sd = Math.cos(yaw) * dx - Math.sin(yaw) * dz
        bot.setControlState('forward', fwd > 0.38); bot.setControlState('back', fwd < -0.38)
        bot.setControlState('right', sd > 0.38); bot.setControlState('left', sd < -0.38)
        bot.setControlState('sprint', fwd > 0.38)
      }
      try {
        for (; t < maxTicks && !ctl.aborted; t++) {
          shooter = sight.observe(bot.players[name]?.entity) || shooter
          if (!shooter) break
          const eye = shooter.position.offset(0, pick.eyeHeight(bot, shooter), 0)
          if (sight.visible(shooter)) coverShooters.set(name, { id: shooter.id, position: shooter.position.clone(), eye, at: gameClock.now() })
          if (!sight.visible(shooter) && !cover) break
          const me = bot.entity.position
          const d = th.dangers(bot, { foes: [name], radius: 64 })
          const aimed = d.aims.some(a => a.name === name); const arrow = d.arrows[0]
          if (!arrow?.side && archerCovered(bot, eye)) return { ok: true, how: 'укрытие', ticks: t, segments: segs }
          quiet = aimed || arrow ? 0 : quiet + 1
          if (quiet >= 6) break
          let ax = shooter.position.x - me.x; let az = shooter.position.z - me.z; const L = Math.hypot(ax, az) || 1; ax /= L; az /= L
          // advance — зигзаг на стрелка (соло-арена 14.10: «с лука расстрелял, даже не уворачивались» — стрейф на месте и бегство
          // по прямой давали тир); дошёл до удара — дальше бой.
          if (p.advance && L < 4) break
          if (aimed && t % 10 === 0) cover = archerCover(bot, eye, { arena: p.arena, advance: !!p.advance })
          if (!arrow?.side && cover && steerArcherCover(bot, cover)) {
            bot.lookAt(eye, true).catch(() => {})
            await gameClock.sleep(50); continue
          }
          if (arrow && arrow.side) { dx = arrow.side.x; dz = arrow.side.z; segLeft = 4 }
          else if (segLeft <= 0) {
            if (Math.random() < 0.65) side = -side
            // Шаг зигзага: поперёк линии стрелка (s — сторона), с уклоном назад (retreat) или вперёд, на него (advance).
            const zig = (s) => { let x = -az * s; let z = ax * s; const k = p.retreat ? -0.8 : p.advance ? 0.8 : 0; x = x * (k ? 0.6 : 1) + ax * k; z = z * (k ? 0.6 : 1) + az * k; const n = Math.hypot(x, z) || 1; return [x / n, z / n] }
            const [px, pz] = zig(side)
            // Упёрся бы в стену/обрыв — другая сторона, потом назад от стрелка (вперёд — прямо на него).
            const opts = p.advance ? [[px, pz], zig(-side), [ax, az]] : [[px, pz], [-px, -pz], [-ax, -az]]
            const ok = opts.find(([x, z]) => fl.runLength(bot, { x, z }, 2, 3, p.arena).len >= 1.2)
            if (!ok) break
            ;[dx, dz] = ok; segLeft = 3 + Math.floor(Math.random() * 7); segs++
            if (bot.entity.onGround && Math.random() < jumpy) bot.setControlState('jump', true)
          }
          if (!fl.insideArena(me.offset(dx, 0, dz), p.arena)) break
          bot.lookAt(shooter.position.offset(0, 1.6, 0), true).catch(() => {})
          keys()
          if (!bot.entity.onGround) bot.setControlState('jump', false)
          segLeft--
          await gameClock.sleep(50)
        }
      } finally { sight.close(); bot.clearControlStates() }
      return { ok: true, ticks: t, segments: segs }
    }, { timeoutMs: 15000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    // До двух секунд пешком за колонну/ступени по увиденным опорам. localOnly — без стройки и общего бегства.
    take_cover: async (p: any = {}) => session.runIntent('take_cover', async (ctl) => {
      const bot = session.require()
      const V = require('vec3')
      const { placeBlockAt, pickFiller } = require('../build')
      const name = String(p.from || '')
      const observe = () => {
        const raw = bot.players[name]?.entity
        if (!raw || !require('../pvp/last-seen').seesPlayer(bot, raw)) return null
        const seen = { id: raw.id, position: raw.position.clone(), eye: raw.position.offset(0, pick.eyeHeight(bot, raw), 0), at: gameClock.now() }
        coverShooters.set(name, seen); return seen
      }
      // fromAt — где его сейчас видят свои (доска роя): стенка от тарана, когда сам его не вижу (cl30 29.10: 29 из 29 стенок —
      // «не вижу его»). Только для стенки на месте (wall), не для бега к укрытию.
      const shared = p.wall && p.fromAt && [p.fromAt.x, p.fromAt.y, p.fromAt.z].every(Number.isFinite)
        ? { id: null, position: new V(p.fromAt.x, p.fromAt.y, p.fromAt.z), eye: new V(p.fromAt.x, p.fromAt.y + 1.62, p.fromAt.z), at: gameClock.now() } : null
      const remembered = observe() || coverShooters.get(name) || shared
      if (!remembered) return { ok: false, why: 'не вижу его' }
      // За занятой колонной остаёмся по последнему видимому лучу; на новый путь нужна свежая позиция стрелка.
      if (p.localOnly && archerCovered(bot, remembered.eye)) return { ok: true, how: 'укрытие' }
      if (gameClock.now() - remembered.at > 2000) return { ok: false, why: 'не вижу его' }
      let foe = remembered
      const eye = () => foe.eye
      const seen = () => !archerCovered(bot, eye())
      if (!seen()) return { ok: true, how: 'укрытие' }
      const me = bot.entity.position
      const nearer = p.nearerThan
      const nearerDistance = nearer && ['x', 'y', 'z'].every(k => Number.isFinite(nearer[k])) ? me.distanceTo(new V(nearer.x, nearer.y, nearer.z)) : Infinity
      const maxRun = Math.min(8.6, Math.max(0, Number(p.maxRun ?? 8.6)), nearerDistance)
      let cover = archerCover(bot, eye(), { arena: p.arena, maxRun })
      let coverEye = eye().clone()
      const tried = []
      if (cover && cover.distance < nearerDistance) {
        bot.pathfinder?.setGoal(null)
        const until = gameClock.now() + 2500
        try {
          while (!ctl.aborted && gameClock.now() < until && steerArcherCover(bot, cover)) {
            const latest = observe()
            if (latest) {
              const moved = latest.eye.distanceTo(coverEye) > .5
              foe = latest
              if (moved) {
                cover = archerCover(bot, eye(), { arena: p.arena, maxRun })
                coverEye = eye().clone()
                if (!cover || cover.distance >= nearerDistance) break
              }
            }
            if (!seen()) return { ok: true, how: 'укрытие', at: bot.entity.position.clone() }
            await bot.lookAt(eye(), true).catch(() => {})
            await gameClock.sleep(50)
          }
          if (!ctl.aborted && !seen()) return { ok: true, how: 'укрытие', at: bot.entity.position.clone() }
        } finally { bot.clearControlStates() }
        if (cover) tried.push(cover.at.toString())
      }
      if (p.localOnly) return { ok: false, why: cover ? 'не добежал до укрытия' : 'местного укрытия нет', tried }
      // wall — без бегства: местного укрытия нет, а блоки есть — стенка на месте (пользователь 25.10: «укрытия из блоков редко
      // строят, а это защищает от лучника»; арена прежде всегда уходила в бегство и до стройки не доходила).
      if (p.arena && !p.wall) return require('../flee').smartFlee(session, ctl, { foes: [foe.id].filter(Boolean), arena: p.arena, timeoutMs: 3000, reason: 'ищу укрытие от видимой угрозы' })
      if (p.blocks === false || !pickFiller(bot)) return { ok: false, why: cover ? 'не добежал до укрытия' : 'укрытия нет, блоков нет', tried }
      // Столб по самому лучу, затем соседние: по большей оси диагональный выстрел проходил мимо.
      const here = bot.entity.position
      const dx = foe.position.x - here.x; const dz = foe.position.z - here.z
      const length = Math.hypot(dx, dz) || 1
      const front = here.offset(dx / length * 1.5, 0, dz / length * 1.5).floored()
      const across = Math.abs(dx) >= Math.abs(dz) ? new V(0, 0, 1) : new V(1, 0, 0)
      const steep = (foe.position.y - here.y) / (Math.hypot(dx, dz) || 1) > 0.7
      let placed = 0
      for (const side of [0, -1, 1]) for (const h of steep ? [0, 1, 2] : [0, 1]) {
        if (ctl.aborted) break
        const c = front.plus(across.scaled(side)).offset(0, h, 0)
        const b = bot.blockAt(c)
        if (b && b.boundingBox === 'block') continue
        const r = await placeBlockAt(bot, c, { honest: true, timeoutMs: 1000, ctl }).catch(() => null)
        if (r?.ok && !r.already) placed++
        if (ctl.aborted) break
        const latest = observe(), moved = latest && latest.eye.distanceTo(eye()) > .5
        if (latest) foe = latest
        if (!seen()) return { ok: true, how: `стена ${placed}`, tried }
        if (moved) return { ok: false, why: `стена ${placed}, стрелок переместился`, tried }
      }
      return { ok: false, why: `стена ${placed}, луч открыт`, tried }
    }, { timeoutMs: 8000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    watch_dangers: async (p: any = {}) => { state.dangerWatch = p.on === false ? null : { foes: Array.isArray(p.foes) ? p.foes.map(String) : [] }; session._ndFoes = state.dangerWatch?.foes; if (session.bot) session.bot._ndFoes = session._ndFoes; return { status: 'done', detail: { on: !!state.dangerWatch } } },
    // Враждебные мобы рядом (видно глазами: тип, позиция, скорость, что в руке и на теле) — для общего списка врагов в
    // гонке (10.10: «от мобов бегут, а меня не видят; от нескольких целей сразу убегать не умеют»).
    mobs: async (p) => session.immediate(async () => {
      const bot = session.require()
      const { DOCTRINE } = require('../flee')
      const me = bot.entity.position; const R = p?.radius ?? 24
      const out = []
      for (const e of Object.values(bot.entities) as any[]) {
        if (!e || e === bot.entity || e.username || !e.position || !DOCTRINE[e.name]) continue
        const d = e.position.distanceTo(me); if (d > R) continue
        const eq = (e.equipment || []).map((it: any) => it ? it.name : null)
        out.push({ id: e.id, name: e.name, p: { x: e.position.x, y: e.position.y, z: e.position.z }, v: { x: e.velocity?.x || 0, z: e.velocity?.z || 0 }, d,
          held: eq[0] || null, armor: { feet: eq[2] || null, legs: eq[3] || null, torso: eq[4] || null, head: eq[5] || null } })
      }
      return { mobs: out }
    })
  }
}

export { hazardCoverMethods }
