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
    // Динамит рядом (датчик threats: горящий и его цепочка): бег прочь от всех зарядов разом, пока они в досягаемости
    // (tactics/blast.dodgeBlast — конец по миру, не по сроку); бежать некуда, а щит есть — щит к заряду.
    dodge_blast: async (p: any = {}) => session.runIntent('dodge_blast', async (ctl) => {
      const B = require('../tactics/blast')
      const bot = session.require(), me = bot.entity.position
      // Не успеть: спринт ~0.26 бл/т за остаток фитиля не выводит из 8 бл. — щит к заряду (взрыв в bypasses_shield нет),
      // а не спина под взрыв (стенд бота-противника 22.10: фитиль 1 с у ног — убежал на 3 бл. и погиб).
      const late = B.tntCharges(bot, me).some(c => c.primed && c.position.distanceTo(me) + 0.26 * c.fuse < B.TNT_REACH)
      if (late && B.shieldableBlast(bot) && bot.inventory.items().some(i => i.name === 'shield')) return { late: true, ...await B.shieldBlast(session, ctl) }
      const ran = await B.dodgeBlast(session, ctl)
      return ran.cornered && !ctl.aborted && B.shieldableBlast(session.require()) ? { ...ran, shield: await B.shieldBlast(session, ctl) } : ran
    }, { timeoutMs: 8000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
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
        if (p.force === true) return ''
        if ((bot.health ?? 20) < hp0 || directThreat(bot, p.allies || [], ms)) return 'direct_threat'
        const foes = (Object.values(bot.entities || {}) as any[]).filter(e => e?.username && !(p.allies || []).includes(e.username)).map(e => e.username)
        const smash = (require('../threats') as typeof import('../threats')).smashes(bot, foes)[0]
        return smash && smash.ticks * 50 <= ms + 250 ? 'incoming_smash' : ''
      }
      if (!webs().length) return { ok: true, cut: 0, left: 0, why: 'не в паутине' }
      bot.pathfinder?.setGoal(null); bot.clearControlStates()
      const items = bot.inventory.items()
      const cutter = items.some(i => /_sword$|^shears$/.test(i.name))
      const water = !cutter && !/nether/.test(String(bot.game?.dimension || '')) && items.find(i => i.name === 'water_bucket')
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
      const bot = session.require()
      const { webCells } = require('../hazards') as typeof import('../hazards')
      const pick = require('../pick') as typeof import('../pick')
      const tools = require('../tools') as typeof import('../tools')
      const ally = bot.players?.[String(p.target || '')]?.entity
      if (!ally) return { ok: false, cut: 0, why: 'не вижу его' }
      if (!bot.inventory.items().some(i => /_sword$|^shears$/.test(i.name))) return { ok: false, cut: 0, why: 'нечем резать' }
      bot.pathfinder?.setGoal(null); bot.clearControlStates()
      let cut = 0, why = ''
      while (!ctl.aborted && webCells(bot, ally).length) {
        const at = webCells(bot, ally).find(c => pick.blockAim(bot, c, { range: 4.5, seeThrough: null }))
        if (!at) { why = 'не достаю'; break }
        const block = bot.blockAt(at)
        await tools.equipFastest(bot, block).catch(() => {})
        await bot.lookAt(pick.blockAim(bot, at, { range: 4.5, seeThrough: null }), true)
        try { await bot.dig(block, false, null, ctl) } catch (e) { why = String(e?.message || e); break }
        if (bot.blockAt(at)?.name === 'cobweb') { why = 'не срезалась'; break }
        cut++
      }
      return { ok: !webCells(bot, ally).length, cut, why: ctl.aborted ? 'interrupted' : why }
    }, { timeoutMs: 8000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
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
      const maxDrop = Number.isFinite(p.maxDrop) ? Math.max(0, Math.min(3, p.maxDrop)) : 3
      let dx = p.dir.x / n, dz = p.dir.z / n, runLen = 9
      if (!water) {
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
        if (p.minRun && !pickFrom.length) return { ok: false, why: `некуда отскочить на ${p.minRun} бл.` }
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
          // Во время подкопа прежняя опора могла исчезнуть; в прыжке пол ниже ног сам по себе нормален.
          if (!water && maxDrop === 0 && bot.entity.onGround && fl.runLength(bot, { x: dx, z: dz }, 1, 0, p.arena).len < 1) return { ok: false, why: 'пол по ходу исчез' }
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
