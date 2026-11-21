'use strict'
// RPC демона — опасности: лава, вода, уворот (финт, укрытие, слежка, мобы — rpc/hazards-cover.ts).
// Фабрика методов над контекстом демона (rpc/context.ts); обработчики перенесены из src/index.ts.
import type { RpcContext } from './context'

function evadeLanes(bot, p, n, maxDrop) {
  const fl = require('../flee')
  const base = Math.atan2(p.dir.z / n, p.dir.x / n)
  const all = [0, 1, -1, 2, -2, 3, -3, 4].map(k => {
    const a = base + k * Math.PI / 4
    const dir = { x: Math.cos(a), z: Math.sin(a) }
    // До 6 бл.: из брызг зелья (радиус 4) за один рывок.
    const run = fl.runLength(bot, dir, 6, maxDrop, p.arena)
    return { dir, run, c: Math.abs(k) * 2 + (6 - run.len) * 2 + (run.len >= 2 ? fl.enclosure(bot, run.end) * 0.5 : 0) }
  })
  // Тесно (галерея, лестница, гребень Колизея; 13.10: «зелья кидаю — стоят»: 19 раз «некуда» за 3 мин): годится и шаг
  // в 1 бл.; совсем некуда, а dropOk (зелье, булава) — спрыгнуть до 6 бл.: падение дешевле вреда II.
  // minRun — отскок из-под булавы (dangers): пробег короче — не отскок, а щит; тесных шагов тогда не брать.
  let pickFrom = all.filter(o => o.run.len >= Math.max(2, p.minRun || 0))
  if (p.minRun && !pickFrom.length) return []
  if (!pickFrom.length) pickFrom = all.filter(o => o.run.len >= 1)
  if (!pickFrom.length && p.dropOk) pickFrom = all.map(o => ({ ...o, run: fl.runLength(bot, o.dir, 6, 6, p.arena) })).filter(o => o.run.len >= 1)
  return pickFrom.sort((a, b) => a.c - b.c)
}

const burstTicks = (p, len) => Math.max(3, Math.min(30, Math.round(p.ticks ?? 10), Math.ceil(len / .3)))

// Admission is read-only. A current route keeps its keys unless a floor escape can actually stop.
function floorAdmission(bot, p, n) {
  const budget = { frames: 179, cells: 128 }
  const forecast = () => {
    const seen = (require('../pvp/search') as typeof import('../pvp/search')).observedCollision(bot)
    return (require('../navigation/floor-escape') as typeof import('../navigation/floor-escape')).floorEscapeForecast(bot, seen, budget, p.arena)
  }
  let dirty = true, start, velocity, grounded
  const events = ['physicsTick', 'blockUpdate', 'chunkColumnLoad', 'chunkColumnUnload']
  const invalidate = () => { dirty = true }
  const changed = () => dirty || !bot.entity.position.equals(start) || !bot.entity.velocity.equals(velocity) || grounded !== bot.entity.onGround
  for (const e of events) bot.on(e, invalidate)
  const plan = {
    candidates: [] as ReturnType<typeof evadeLanes>, burst: null as { hold: number; jump: boolean } | null,
    dir: null as { x: number; z: number } | null, why: '', changed, forecast,
    get start() { return start },
    close() { for (const e of events) bot.removeListener(e, invalidate) },
    admit() {
      if (!changed()) return !plan.why
      dirty = false; start = bot.entity.position.clone(); velocity = bot.entity.velocity.clone(); grounded = bot.entity.onGround
      plan.burst = null; plan.dir = null; plan.why = ''
      if ((require('../movement') as typeof import('../movement')).inWater(bot)) return true
      plan.candidates = evadeLanes(bot, p, n, 0)
      if (!plan.candidates.length) {
        const head = bot.blockAt(start.offset(0, 2, 0))
        if (head?.boundingBox === 'empty' && (bot.inventory.items().some(i => i.name === 'wind_charge') || require('../build').pickFiller(bot))) return true
        plan.why = 'некуда: стены, обрыв или лава со всех сторон'
        return false
      }
      const predict = forecast()
      for (const { dir, run } of plan.candidates) {
        const burst = predict(burstTicks(p, run.len), !!p.jump, Math.atan2(-dir.x, -dir.z))
        if (burst) { plan.burst = burst; plan.dir = dir; return true }
        if (!budget.frames) break
      }
      plan.why = 'некуда сойти и остановиться на опоре'
      return false
    }
  }
  return plan
}

function hazardMethods ({ session, gameClock }: RpcContext) {
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
    // Динамит рядом (датчик threats: горящий и его цепочка): бег прочь от всех зарядов разом, пока они в досягаемости
    // (tactics/blast.dodgeBlast — конец по миру, не по сроку); бежать некуда, а щит есть — щит к заряду.
    dodge_blast: async (p: any = {}) => {
      const B: typeof import('../tactics/blast') = require('../tactics/blast')
      const body = session.require(), enemies = Array.isArray(p.enemies) ? p.enemies : undefined
      const current = () => session.bot === body && (B.blastNear(body)?.alarm || B.actionableInstantBlasts(body, enemies).length > 0)
      const triggered = p.instant === true || !!enemies?.length
      if (triggered && !current()) return { status: 'failed', code: 'ACTION_EXPIRED', notStarted: true, error: 'угроза взрыва исчезла' }
      return session.runIntent('dodge_blast', async (ctl) => {
        const bot = session.require(), me = bot.entity.position
        // A worn shield is absent from inventory.items(). TNT has a fuse; a crystal or charged anchor has none.
        const late = B.tntCharges(bot, me).some(c => c.primed && c.position.distanceTo(me) + 0.26 * c.fuse < B.TNT_REACH)
        const { findShield } = require('../combat/shield') as typeof import('../combat/shield')
        if (late && B.shieldableBlast(bot, enemies) && findShield(bot)) return { late: true, ...await B.shieldBlast(session, ctl, enemies) }
        const ran = await B.dodgeBlast(session, ctl, enemies)
        return ran.cornered && !ctl.aborted && B.shieldableBlast(bot, enemies) && findShield(bot)
          ? { ...ran, shield: await B.shieldBlast(session, ctl, enemies) } : ran
      }, { timeoutMs: 8000, interruptOn: ['death', 'kicked', 'disconnected'], params: p, canStart: triggered ? current : undefined })
    },
    // Вне боя — снять паутину; боевой выбор щита/резки/воды/жемчуга делает webTurn.
    clear_web: async (p: any = {}) => session.runIntent('clear_web', async (ctl) => {
      const bot = session.require()
      const { webCells } = require('../hazards') as typeof import('../hazards')
      const pick = require('../pick') as typeof import('../pick')
      const tools = require('../tools') as typeof import('../tools')
      const { directThreat } = require('../swarm-work') as typeof import('../swarm-work')
      const webs = () => webCells(bot)
      if (p.allies && (!Array.isArray(p.allies) || p.allies.length > 128 || p.allies.some(n => typeof n !== 'string' || n.length > 32))) return { ok: false, cut: 0, left: webs().length, why: 'invalid_allies' }
      const hp0 = bot.health ?? 20
      const threatened = ms => {
        const ranged = p.force !== true
        if (ranged && (bot.health ?? 20) < hp0 || directThreat(bot, p.allies || [], ms, undefined, { ranged })) return 'direct_threat'
        const foes = (Object.values(bot.entities || {}) as any[]).filter(e => e?.username && !(p.allies || []).includes(e.username)).map(e => e.username)
        const smash = (require('../threats') as typeof import('../threats')).smashes(bot, foes)[0]
        return smash && smash.ticks * 50 <= ms + 250 ? 'incoming_smash' : ''
      }
      if (!webs().length) return { ok: true, cut: 0, left: 0, why: 'не в паутине' }
      bot.pathfinder?.setGoal(null); bot.clearControlStates()
      const items = bot.inventory.items()
      const cutter = items.some(i => /_sword$|^shears$/.test(i.name))
      const water = !cutter && !/nether/.test(String(bot.game?.dimension || '')) && items.find(i => i.name === 'water_bucket')
      const walk = await (require('../navigation/web-exit') as typeof import('../navigation/web-exit')).webExitPlan(bot, ctl,
        Math.min(...webs().map(at => tools.bestFor(bot, bot.blockAt(at)).ms), water ? 1500 : Infinity))
      if (ctl.aborted) return { ok: false, cut: 0, left: webs().length, why: 'interrupted' }
      if (walk) {
        const why = threatened(walk.ticks * 50)
        if (why) return { ok: false, cut: 0, left: webs().length, why }
        const { executePlan } = require('../navigation/parkour/execute') as typeof import('../navigation/parkour/execute')
        const { settledLanding } = require('../navigation/parkour/model') as typeof import('../navigation/parkour/model')
        const out = await executePlan(bot, ctl, walk, state => !webs().length && settledLanding(bot, state, walk.target, .12))
        const left = webs().length
        if (process.env.ND_SWARM_TRACE === '1') console.log('[web-exit]', JSON.stringify({ ok: out.ok && !left, why: out.why, ticks: out.ticks, left, target: walk.target, at: bot.entity.position }))
        return { ok: out.ok && !left, cut: 0, left, how: 'walk', why: out.why, ticks: out.ticks }
      }
      const hit = water && pick.blockOnRay(bot, pick.eyeOf(bot), { x: 0, y: -1, z: 0 }, 4.5, /^(water|lava|bubble_column)$/)
      const source = hit?.pos?.offset(0, 1, 0)
      if (water && hit?.block.name === 'cobweb' && source.y > webs()[0].y && /^(air|cave_air|void_air)$/.test(bot.blockAt(source)?.name || '')) {
        const why = threatened(1500)
        if (why) return { ok: false, cut: 0, left: webs().length, why }
        await bot.equip(water, 'hand')
        if (ctl.aborted) return { ok: false, cut: 0, left: webs().length, why: 'interrupted' }
        await bot.look(bot.entity.yaw, -Math.PI / 2, true)
        await gameClock.sleep(50)
        if (!ctl.aborted) bot.activateItem()
        for (let t = 0; t < 30 && !ctl.aborted && webs().length; t++) {
          const why = threatened((30 - t) * 50)
          if (why) return { ok: false, cut: 0, left: webs().length, why }
          await gameClock.sleep(50)
        }
        if (!webs().length) return { ok: true, cut: 0, left: 0, how: 'water' }
      }
      let cut = 0, why = '', remaining = 0, started = 0
      const stop = () => { try { bot.stopDigging() } catch {} }
      ctl.onAbort.push(stop)
      // Новая угроза не ждёт до 40 с ручной резки: отпустить дело, чтобы драйвер поднял щит или начал бой.
      const check = () => {
        if (why || ctl.aborted) return
        const leftMs = Math.max(0, remaining - (gameClock.now() - started))
        why = threatened(leftMs)
        if (why) stop()
      }
      const watch = gameClock.setInterval(check, 50)
      try {
        while (!ctl.aborted && !why && webs().length) {
          const eye = pick.eyeOf(bot)
          // blockAim не имеет обращённой грани, когда глаза внутри контура паутины; прицел всё равно берёт её при t=0.
          const at = webs().find(c => {
            const to = c.offset(.5, .5, .5).minus(eye), length = to.norm()
            return length < 1e-6 || pick.blockOnRay(bot, eye, to.scaled(1 / length), length + .01)?.pos.equals(c)
          })
          if (!at) { why = 'web_not_in_pick'; break }
          const block = bot.blockAt(at), before = webs().length
          remaining = tools.bestFor(bot, block).ms; started = gameClock.now()
          check()
          if (why) break
          await bot.lookAt(at.offset(.5, .5, .5), true)
          if (ctl.aborted || why) break
          try { await bot.dig(block, false, null, ctl) } catch (e) { why ||= String(e?.message || e) }
          if (bot.blockAt(at)?.name !== 'cobweb') cut++
          if (webs().length >= before) { why ||= 'web_not_removed'; break }
        }
      } finally {
        gameClock.clearInterval(watch)
        const k = ctl.onAbort.indexOf(stop); if (k >= 0) ctl.onAbort.splice(k, 1)
      }
      const left = webs().length
      return { ok: left === 0, cut, left, how: 'cut', why: ctl.aborted ? 'interrupted' : why }
    }, { timeoutMs: 45000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    // Срезать паутину на союзнике (пользователь 25.10: «пусть просят союзников с оружием вытащить из паутины, это же рой»):
    // мечом или ножницами, только видимые прицелом клетки в 4.5 бл. Подходит к нему драйвер.
    cut_ally_web: async (p: any = {}) => session.runIntent('cut_ally_web', async (ctl) => {
      const { cutAllyWeb }: typeof import('../pvp/cut-ally-web') = require('../pvp/cut-ally-web')
      return cutAllyWeb(session.require(), ctl, String(p.target || ''))
    }, { timeoutMs: 8000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    // Рывок уворота (12.10: «уворачиваясь — бегать и прыгать, а не шагать»): развернуться в сторону ухода, спринт и прыжки
    // ticks тиков, без поиска пути. Перед рывком — 3 клетки по ходу: без лавы/огня и с полом не глубже 4 бл.; опасно —
    // назад или вбок.
    evade: async (p: any = {}) => {
      const n = Math.hypot(p.dir?.x || 0, p.dir?.z || 0)
      const floorCheck = n && Number.isFinite(p.maxDrop) && p.maxDrop <= 0 && !Number.isFinite(p.look?.x) && !p.minRun
      const body = floorCheck && session.require()
      const floor = body?.physics?.simulatePlayer ? floorAdmission(body, p, n) : null
      const denied = () => ({ status: 'failed', code: 'NO_SAFE_EVADE', notStarted: true, error: floor.why, detail: { ok: false, why: floor.why } })
      const worker = async ctl => {
        const bot = session.require()
        if (floor && (bot !== body || !floor.admit())) return { ok: false, why: floor.why || 'тело сменилось' }
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
        const maxDrop = Number.isFinite(p.maxDrop) ? Math.max(0, Math.min(3, p.maxDrop)) : 3
        let dx = p.dir.x / n, dz = p.dir.z / n, runLen = 9
        if (!water) {
          const cands = floor?.candidates ?? evadeLanes(bot, p, n, maxDrop)
          if (p.minRun && !cands.length) return { ok: false, why: `некуда отскочить на ${p.minRun} бл.` }
          if (!cands.length) {
            // Яма (13.10: «проваливаются в яму с сундуком — лечу на них, вылезти не успевают»): над головой свободно — вверх:
            // заряд ветра под ноги в прыжке (подброс ~7 бл.), нет — прыжок и свой блок под ноги.
            const head = bot.blockAt(bot.entity.position.offset(0, 2, 0))
            if (head && head.boundingBox === 'empty') {
              const wc = bot.inventory.items().find(i => i.name === 'wind_charge')
              try { if (bot.usingHeldItem) bot.deactivateItem() } catch {}
              if (wc) {
                const wind = require('../mace/hands') as typeof import('../mace/hands')
                wind.install(bot)
                await bot.equip(wc, 'hand')
                bot.clearControlStates(); await bot.waitForTicks(1)
                const fired = await wind.fireWind(bot, moved => !ctl.aborted && wind.selfWindAim(bot, { moved }), {
                  hand: 'main', before: () => bot.setControlState('jump', bot.entity.onGround)
                })
                if (fired.fired) await wind.nextTick(bot)
                bot.setControlState('jump', false)
                if (fired.fired) { await bot.waitForTicks(6); return { ok: true, how: 'ветром из ямы' } }
              }
              const c0 = bot.entity.position.floored()
              bot.setControlState('jump', true); await bot.waitForTicks(5); bot.setControlState('jump', false)
              const r = await require('../build').placeBlockAt(bot, c0, { honest: true, timeoutMs: 1000, ctl }).catch(() => null)
              if (r?.ok) return { ok: true, how: 'блок под себя' }
            }
            return { ok: false, why: 'некуда: стены, обрыв или лава со всех сторон' }
          }
          dx = cands[0].dir.x; dz = cands[0].dir.z; runLen = cands[0].run.len
          if (floor?.dir) { dx = floor.dir.x; dz = floor.dir.z }
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
        // Не дольше чистого пробега (≈0.3 бл/тик спринтом): дальше runLength не смотрел — там может быть стена.
        let ticks = floor?.burst?.hold ?? burstTicks(p, runLen)
        let jump = floor?.burst?.jump ?? !!p.jump
        try {
          if (ctl.aborted) return { ok: false, why: 'прервано' }
          if (look) await bot.lookAt(look, true); else await bot.look(Math.atan2(-dx, -dz), 0, true)
          if (ctl.aborted || !bot.entity) return { ok: false, why: 'прервано' }
          if (floor?.burst && floor.changed()) {
            const updated = floor.forecast()(ticks, jump, bot.entity.yaw)
            if (!updated) return { ok: false, why: 'положение или опора изменились до начала схода' }
            ticks = updated.hold; jump = updated.jump
          }
          for (let t = 0; t < ticks && !ctl.aborted; t++) {
            if (look) bot.lookAt(look, true).catch(() => {})
            if (!fl.insideArena(bot.entity.position.offset(dx, 0, dz), p.arena)) break
            // Во время подкопа прежняя опора могла исчезнуть; в прыжке пол ниже ног сам по себе нормален.
            if (!water && maxDrop === 0 && bot.entity.onGround && fl.runLength(bot, { x: dx, z: dz }, 1, 0, p.arena).len < 1) {
              if (floor?.burst && bot.entity.position.distanceTo(floor.start) >= 1 && floor.forecast()(0, false, bot.entity.yaw)) break
              return { ok: false, why: 'пол по ходу исчез' }
            }
            keys()
            bot.setControlState('jump', water || jump && !!bot.entity.onGround)
            await gameClock.sleep(50)
          }
        } finally { bot.clearControlStates() }
        return { ok: true, dir: { x: Math.round(dx * 100) / 100, z: Math.round(dz * 100) / 100 } }
      }
      try {
        // runIntent releases a tactical reflex before canStart, but waits for an emergency landing.
        const reflex = floor && session.reflex && require('../reflex-lock').owner(session)
        if (reflex && reflex.owner !== 'Emergency' && !floor.admit()) return denied()
        const result = await session.runIntent('evade', worker, { timeoutMs: 3000, interruptOn: ['death', 'kicked', 'disconnected'], params: p,
          canStart: floor && (() => session.require() === body && floor.admit()) })
        return result?.notStarted && result.code === 'ACTION_EXPIRED' && floor?.why ? denied() : result
      } finally { floor?.close() }
    },
  }
}

export { hazardMethods }
