'use strict'
// RPC демона — опасности: финт, укрытие, слежка за угрозами, мобы рядом.
// Фабрика методов над контекстом демона (rpc/context.ts); обработчики перенесены из src/index.ts.
import type { RpcContext } from './context'

function hazardCoverMethods ({ session, gameClock, state }: RpcContext) {
  return {
    // Джук под прицелом (12.10, арена: «целюсь из лука — стоят; стрейфить, прыгать, заранее, как только нацеливаюсь»;
    // замер farm/scenes/arena-archer-test: рывки по 0.3 с с паузами — 80 % попаданий с 8 бл.). Пока стрелок (from) целится в меня
    // или летит его стрела — без пауз зигзаг поперёк линии на него: отрезки случайной длины (3–9 тиков), сторона меняется
    // случайно (не строго через раз — упреждение человека не угадает), по стенам — flee.runLength (упёрся — в другую
    // сторону или назад от него). Взгляд — на стрелка; прыжки — с долей jumpy. Летит стрела — сразу поперёк её хода.
    // retreat — уходить от него (зигзагом назад): ответить нечем. Конец — прицела нет 6 тиков подряд или maxTicks.
    juke: async (p: any = {}) => session.runIntent('juke', async (ctl) => {
      const bot = session.require()
      const V = require('vec3'); const fl = require('../flee'); const th = require('../threats')
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
          if (!shooter || !sight.visible(shooter)) break
          const me = bot.entity.position
          const d = th.dangers(bot, { foes: [name], radius: 64 })
          const aimed = d.aims.some(a => a.name === name); const arrow = d.arrows[0]
          quiet = aimed || arrow ? 0 : quiet + 1
          if (quiet >= 6) break
          let ax = shooter.position.x - me.x; let az = shooter.position.z - me.z; const L = Math.hypot(ax, az) || 1; ax /= L; az /= L
          // advance — зигзаг на стрелка (соло-арена 14.10: «с лука расстрелял, даже не уворачивались» — стрейф на месте и бегство
          // по прямой давали тир); дошёл до удара — дальше бой.
          if (p.advance && L < 4) break
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
    // Укрыться от стрелка (12.10, арена: «когда целюсь сверху — забегать под меня»; «блоками заставиться, чтобы стрелы не
    // убивали»): клетка в maxRun бл., откуда его глаз не видно (луч perception.raySees: под стену, на которой он стоит, за
    // выступ), спуск не больше 4, — бегом (movement.travelXZ); нет такой или не дошёл — стена из своих блоков на линии
    // огня в клетке к нему, снизу вверх (опора — пол), до 3 в высоту, если он выше; ставит честно, пока луч не закрыт.
    take_cover: async (p: any = {}) => session.runIntent('take_cover', async (ctl) => {
      const bot = session.require()
      const V = require('vec3'); const { raySees, eyePos } = require('../perception')
      const { standableY, travelXZ } = require('../movement'); const { placeBlockAt, pickFiller } = require('../build')
      const foe = bot.players[String(p.from || '')]?.entity
      if (!foe || !require('../pvp/last-seen').seesPlayer(bot, foe)) return { ok: false, why: 'не вижу его' }
      if (p.arena) return require('../flee').smartFlee(session, ctl, { foes: [foe.id], arena: p.arena, timeoutMs: 3000, reason: 'ищу укрытие от видимой угрозы' })
      const eye = () => foe.position.offset(0, 1.62, 0)
      const seen = () => raySees(bot, eyePos(bot), eye())
      if (!seen()) return { ok: true, how: 'уже не видно' }
      bot.pathfinder?.setGoal(null)
      const me = bot.entity.position; const f0 = me.floored()
      const maxRun = Math.max(2, Math.min(12, p.maxRun ?? 7))
      const spots = []
      for (let r = 1; r <= maxRun; r++) {
        const n = Math.max(8, Math.round(r * 6))
        for (let k = 0; k < n; k++) {
          const a = k / n * 2 * Math.PI
          const x = Math.floor(me.x + Math.cos(a) * r); const z = Math.floor(me.z + Math.sin(a) * r)
          if (spots.some(o => o.x === x && o.z === z)) continue
          const y = standableY(bot, x, f0.y, z)
          if (y == null || y < f0.y - 4 || y > f0.y + 1) continue
          if (raySees(bot, new V(x + 0.5, y + 1.62, z + 0.5), eye()) || raySees(bot, new V(x + 0.5, y + 0.9, z + 0.5), eye())) continue
          spots.push({ x, y, z, r })
        }
        if (spots.length >= 4) break
      }
      const tried = []
      for (const sp of spots.slice(0, 3)) {
        if (ctl.aborted) break
        const run = await travelXZ(bot, ctl, sp.x + 0.5, sp.z + 0.5, { range: 0.5, retries: 0, y: sp.y, deadline: gameClock.now() + 1200 + sp.r * 350 }).catch(e => ({ ok: false, error: e.message }))
        tried.push(`${sp.x},${sp.y},${sp.z}${run.ok ? '' : ' ✗'}`)
        if (!seen()) return { ok: true, how: 'укрытие', at: sp, tried }
      }
      if (p.blocks === false || !pickFiller(bot)) return { ok: false, why: spots.length ? 'не добежал до укрытия' : 'укрытия нет, блоков нет', tried }
      // Стена: клетка к нему (по большей оси), снизу вверх; он выше на 35°+ — третий блок.
      const here = bot.entity.position; const ff = here.floored()
      const dx = foe.position.x - here.x; const dz = foe.position.z - here.z
      const step = Math.abs(dx) >= Math.abs(dz) ? new V(Math.sign(dx), 0, 0) : new V(0, 0, Math.sign(dz))
      const steep = (foe.position.y - here.y) / (Math.hypot(dx, dz) || 1) > 0.7
      let placed = 0
      for (const h of steep ? [0, 1, 2] : [0, 1]) {
        if (ctl.aborted) break
        const c = ff.plus(step).offset(0, h, 0)
        const b = bot.blockAt(c)
        if (b && b.boundingBox === 'block') continue
        const r = await placeBlockAt(bot, c, { honest: true, timeoutMs: 1000, ctl }).catch(() => null)
        if (r?.ok && !r.already) placed++
        if (!seen()) return { ok: true, how: `стена ${placed}`, tried }
      }
      return { ok: false, why: `стена ${placed}, луч открыт`, tried }
    }, { timeoutMs: 8000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    watch_dangers: async (p: any = {}) => { state.dangerWatch = p.on === false ? null : { foes: Array.isArray(p.foes) ? p.foes.map(String) : [] }; session._ndFoes = state.dangerWatch?.foes; return { status: 'done', detail: { on: !!state.dangerWatch } } },
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
