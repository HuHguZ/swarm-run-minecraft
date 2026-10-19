'use strict'
// RPC демона — опасности: лава, вода, уворот (финт, укрытие, слежка, мобы — rpc/hazards-cover.ts).
// Фабрика методов над контекстом демона (rpc/context.ts); обработчики перенесены из src/index.ts.
import type { RpcContext } from './context'

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
  }
}

export { hazardMethods }
