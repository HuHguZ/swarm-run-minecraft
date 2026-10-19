'use strict'
// RPC демона — опасности: лава, вода, уворот, укрытие, мобы, слежка за угрозами.
// Фабрика методов над контекстом демона (rpc/context.ts); обработчики перенесены из src/index.ts.
import type { RpcContext } from './context'

function hazardMethods ({ session, gameClock, state }: RpcContext) {
  return {
    // Залить лаву водой и забрать воду (12.10, арена: «лаву водой — заранее»): вода в клетку лавы (ведро целится в верх
    // блока под ней — obsidian.pourOnto), источник рядом с водой застывает; через 0.5 с ведро назад.
    douse_lava: async (p: any = {}) => session.runIntent('douse_lava', async () => {
      const bot = session.require()
      const o = require('../obsidian')
      const Vec3 = require('vec3')
      if (!p.at) throw new Error('нужна точка at')
      const at = new Vec3(p.at.x, p.at.y, p.at.z).floored()
      if (bot.entity.position.offset(0, 1.62, 0).distanceTo(at.offset(0.5, 0.5, 0.5)) > 4.5) return { ok: false, why: 'далеко' }
      if (!bot.inventory.items().some(i => i.name === 'water_bucket')) return { ok: false, why: 'нет ведра воды' }
      const ok = await o.pourOnto(bot, at.offset(0, -1, 0))
      if (ok) { await gameClock.sleep(500); await o.scoopWater(bot, at) }
      return { ok, why: ok ? 'залил' : 'не вылилась' }
    }, { timeoutMs: 4000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    // Вода мешает (пользователь 14.10: «из-за воды тупят — против течения стоят, пусть вылезают, блоки ставят или плывут»;
    // «круто, если воду будут убирать блоками или вёдрами, если мешает»): источники в 4.5 бл. от глаз — пустым ведром
    // зачерпнуть (obsidian.scoopWater), нет ведра — блок в источник по видимой грани (не в свою клетку); убирать нечего —
    // выплыть к берегу (escapeWater, 3 с).
    clear_water: async (p: any = {}) => session.runIntent('clear_water', async (ctl) => {
      const bot = session.require()
      const mv = require('../movement')
      if (!mv.inWater(bot)) return { ok: false, why: 'не в воде' }
      const eye = bot.entity.position.offset(0, 1.62, 0), feet = bot.entity.position.floored()
      const { placeBlockAt, pickFiller } = require('../build')
      const o = require('../obsidian')
      const sources = o.visibleSources(bot, 'water', 5).filter(b => eye.distanceTo(b.position.offset(0.5, 0.5, 0.5)) <= 4.5)
      const how = []
      for (const s of sources.slice(0, 3)) {
        if (ctl.aborted) break
        if (bot.inventory.items().some(i => i.name === 'bucket') && await o.scoopWater(bot, s.position).catch(() => false)) { how.push('ведром'); continue }
        const mine = s.position.x === feet.x && s.position.z === feet.z && s.position.y - feet.y >= 0 && s.position.y - feet.y <= 1
        if (!mine && pickFiller(bot) && (await placeBlockAt(bot, s.position, { honest: true, timeoutMs: 1000, ctl }).catch(() => null))?.ok) how.push('блоком')
      }
      if (how.length) return { ok: true, removed: how.length, how: `убрал воду (${how.join(', ')})` }
      const w = await mv.escapeWater(bot, ctl, { timeoutMs: 3000 }).catch(() => null)
      return { ok: !!w?.ok, how: w?.ok ? 'выплыл из воды' : `в воде: источника ${sources.length ? 'не убрать' : 'не видно'}, не выплыл` }
    }, { timeoutMs: 6000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    // Рывок уворота (12.10: «уворачиваясь — бегать и прыгать, а не шагать»): развернуться в сторону ухода, спринт и прыжки
    // ticks тиков, без поиска пути. Перед рывком — 3 клетки по ходу: без лавы/огня и с полом не глубже 4 бл.; опасно —
    // назад или вбок.
    evade: async (p: any = {}) => session.runIntent('evade', async (ctl) => {
      const bot = session.require()
      const n = Math.hypot(p.dir?.x || 0, p.dir?.z || 0)
      if (!n) return { ok: false, why: 'нет направления' }
      // Куда бежать — с учётом стен (12.10: «уворачиваясь, бежит в стенку и упирается — геометрию не считает»): 8 направлений
      // от желаемого, по каждому — чистый пробег тела до 4 бл. (flee.runLength: стены и ширина тела, подъём на блок с местом
      // над головой, обрыв не глубже 3, лава/огонь); короче 2 — нельзя. Цена: уклон от желаемого, недобег, замкнутость конца.
      const fl = require('../flee')
      // В воде (14.10: «в воде тупят, когда от булавы надо увернуться»: путь к берегу — до 5 с, «к берегу не вышло», а булава
      // садится за секунду; 13.10: «застрял в воде — я его просто расстреливал»): сразу вплавь по ходу рывка, всплывая и
      // глядя на угрозу; стен и пола там не мерить. Щит от булавы ставит драйвер (swarm_hold) — в воде так же.
      const mv = require('../movement')
      const water = mv.inWater(bot)
      let dx = p.dir.x / n, dz = p.dir.z / n, runLen = 9
      if (!water) {
        const base = Math.atan2(p.dir.z / n, p.dir.x / n)
        const all = [0, 1, -1, 2, -2, 3, -3, 4].map(k => {
          const a = base + k * Math.PI / 4
          const dir = { x: Math.cos(a), z: Math.sin(a) }
          // До 6 бл.: из брызг зелья (радиус 4) за один рывок.
          const run = fl.runLength(bot, dir, 6, 3, p.arena)
          return { dir, run, c: Math.abs(k) * 2 + (6 - run.len) * 2 + (run.len >= 2 ? fl.enclosure(bot, run.end) * 0.5 : 0) }
        })
        // Тесно (галерея, лестница, гребень Колизея; 13.10: «зелья кидаю — стоят»: 19 раз «некуда» за 3 мин): годится и шаг
        // в 1 бл.; совсем некуда, а dropOk (зелье, булава) — спрыгнуть до 6 бл.: падение дешевле вреда II.
        let pickFrom = all.filter(o => o.run.len >= 2)
        if (!pickFrom.length) pickFrom = all.filter(o => o.run.len >= 1)
        if (!pickFrom.length && p.dropOk) pickFrom = all.map(o => ({ ...o, run: fl.runLength(bot, o.dir, 6, 6, p.arena) })).filter(o => o.run.len >= 1)
        const cands = pickFrom.sort((a, b) => a.c - b.c)
        if (!cands.length) {
          // Яма (13.10: «проваливаются в яму с сундуком — лечу на них, вылезти не успевают»): над головой свободно — вверх:
          // заряд ветра под ноги в прыжке (подброс ~7 бл.), нет — прыжок и свой блок под ноги.
          const head = bot.blockAt(bot.entity.position.offset(0, 2, 0))
          if (head && head.boundingBox === 'empty') {
            const wc = bot.inventory.items().find(i => i.name === 'wind_charge')
            try { if (bot.usingHeldItem) bot.deactivateItem() } catch {}
            if (wc) {
              await bot.equip(wc, 'hand')
              bot.setControlState('jump', true); await bot.waitForTicks(2); bot.setControlState('jump', false)
              await bot.look(bot.entity.yaw, -Math.PI / 2, true); bot.activateItem(); await bot.waitForTicks(6)
              return { ok: true, how: 'ветром из ямы' }
            }
            const c0 = bot.entity.position.floored()
            bot.setControlState('jump', true); await bot.waitForTicks(5); bot.setControlState('jump', false)
            const r = await require('../build').placeBlockAt(bot, c0, { honest: true, timeoutMs: 1000, ctl }).catch(() => null)
            if (r?.ok) return { ok: true, how: 'блок под себя' }
          }
          return { ok: false, why: 'некуда: стены, обрыв или лава со всех сторон' }
        }
        dx = cands[0].dir.x; dz = cands[0].dir.z; runLen = cands[0].run.len
      }
      bot.pathfinder?.setGoal(null)
      // Ел/пил — бросить: с едой у рта бег вдвое медленнее.
      try { if (bot.usingHeldItem) bot.deactivateItem() } catch {}
      // Смотреть — на угрозу (look: стрелок, падающий, зелье; 12.10: «уворачиваются, глядя в стенку — смотреть на объект,
      // в сторону — только когда бегут туда»): клавиши — относительно взгляда, спринт — только при беге вперёд. Без look —
      // взгляд по ходу (уход из облака, от лавы).
      const look = p.look && Number.isFinite(p.look.x) ? new (require('vec3'))(p.look.x, p.look.y, p.look.z) : null
      const keys = () => {
        const yaw = bot.entity.yaw
        const fwd = -Math.sin(yaw) * dx - Math.cos(yaw) * dz
        const side = Math.cos(yaw) * dx - Math.sin(yaw) * dz
        bot.setControlState('forward', fwd > 0.38); bot.setControlState('back', fwd < -0.38)
        bot.setControlState('right', side > 0.38); bot.setControlState('left', side < -0.38)
        bot.setControlState('sprint', fwd > 0.38)
      }
      if (look) await bot.lookAt(look, true); else await bot.look(Math.atan2(-dx, -dz), 0, true)
      // Не дольше чистого пробега (≈0.3 бл/тик спринтом): дальше runLength не смотрел — там может быть стена.
      const ticks = Math.max(3, Math.min(30, Math.round(p.ticks ?? 10), Math.ceil(runLen / 0.3)))
      try {
        for (let t = 0; t < ticks && !ctl.aborted; t++) {
          if (look) bot.lookAt(look, true).catch(() => {})
          if (!fl.insideArena(bot.entity.position.offset(dx, 0, dz), p.arena)) break
          keys()
          bot.setControlState('jump', water || !!p.jump && !!bot.entity.onGround)
          await gameClock.sleep(50)
        }
      } finally { bot.clearControlStates() }
      return { ok: true, dir: { x: Math.round(dx * 100) / 100, z: Math.round(dz * 100) / 100 } }
    }, { timeoutMs: 3000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
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

export { hazardMethods }
