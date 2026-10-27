'use strict'
// RPC демона — рой и команда: работа, коробка, позиции, помощь, уступка боя, баффы.
// Фабрика методов над контекстом демона (rpc/context.ts); обработчики перенесены из src/index.ts.
import type { RpcContext } from './context'

function swarmMethods ({ session, gameClock }: RpcContext) {
  return {
    // Подкоп к цели по прямой (13.10, арена: «если путь не находится — пусть тупо в прямую копают ко мне тоннель»): шаг по
    // большей из осей к цели (по очереди — почти прямая линия); цель выше — ступенька вверх (над головой и впереди на две
    // клетки), ниже — вниз; под ногами впереди пусто — свой блок (build.placeBlockAt, честно). Копает только клетки перед
    // собой (видно прицелом), лучшим инструментом (tools.install: bot.dig). Лава или вода у вскрытой клетки — стоп.
    // Итог: { ok, steps, dug, placed, why, at }; ok — дошёл до 2.5 бл. от цели.
    swarm_work: async (p: any = {}) => session.runIntent('swarm_work', ctl => require('../actions').swarmWork(session, ctl, p), { params: p, interruptOn: ['death', 'kicked', 'disconnected'] }),
    // Вещи на земле, что бот видит (пользователь 15.10: «бил деревянным мечом, а рядом трезубец лежал — постоянно поглядывать на
    // предметы вокруг»): сущности item в радиусе, луч до них — как до игрока (seesPlayer); имя, число, место, ближние первыми.
    items_near: async (p: any = {}) => session.immediate(async () => {
      const bot = session.require(), me = bot.entity.position, r = Math.min(16, p.radius || 8)
      const sees = require('../pvp/last-seen').seesPlayer
      const items: any[] = []
      for (const e of Object.values(bot.entities) as any[]) {
        if (!e || e.name !== 'item' || !e.position || e.position.distanceTo(me) > r) continue
        let it = null; try { it = e.getDroppedItem() } catch {}
        if (!it || !sees(bot, e)) continue
        items.push({ id: e.id, name: it.name, count: it.count, at: { x: e.position.x, y: e.position.y, z: e.position.z }, d: +e.position.distanceTo(me).toFixed(1) })
      }
      return { items: items.sort((a, b) => a.d - b.d).slice(0, 12) }
    }),
    // Замуроваться в своей клетке (кемпер в углу, пользователь 14.10: «блоками себя заставить»): стены в два блока и крыша,
    // по видимым граням (fortify.boxIn); итог — сколько поставил и замкнута ли коробка.
    // Коробка кемпера — из того, что он сам выломает быстро (с киркой — булыжник, без — земля/доски: refugeFiller): из своей
    // булыжной коробки рукой (10 с на блок) кемпер не выходил и лез по кругу «из ямы вылез на 0» (стенд 15.10).
    // Закрылся — тело помнит коробку (клетка, план, материал) и урон в ней (зелье сбоку проходит сквозь стену: 8 хп — опыт 15.10),
    // откуда летело — по последнему снаряду (onDanger). Реакция — swarm_hold { camp: true } (Codex 15.10).
    box_in: async (p: any = {}) => session.runIntent('box_in', async ctl => {
      const F = require('../fortify'), bot = session.require()
      const soft = F.refugeFiller(bot, 10)
      const material = soft && F.canBreakOut(bot, soft) ? soft.name : null
      // Мягкого нет, а твёрдый без кирки не выломать — не замуровываться (Codex 15.10: молчаливый откат к булыжнику — та же ловушка).
      if (!material && !F.canBreakOut(bot, F.hardFiller(bot) || soft)) return { placed: 0, sealed: false, why: 'выйти не смогу: нет мягких блоков и кирки' }
      const r = await F.boxIn(bot, { roof: true, ctl, timeoutMs: 1500, ...(material ? { material } : {}) })
      // Погиб или прервали во время стройки — коробку не запоминать (Codex 15.10: слушатель оставался после смерти).
      const sealed = !!r.sealed && !ctl.aborted && bot === session.bot && bot.health > 0
      if (sealed) {
        bot._ndCampBox?.close()
        const box: any = { cell: r.cell, plan: r.plan, mats: r.mats, hp: bot.health, hurt: r.why === 'по мне попали во время стройки' }
        const health = () => {
          if (bot.health < box.hp) { box.hurt = true; box.away = box.shot && gameClock.now() - box.shot.at <= 2000 ? box.shot.from : null }
          box.hp = bot.health
        }
        box.close = () => {
          bot.removeListener('health', health); bot.removeListener('death', box.close); bot.removeListener('end', box.close)
          if (bot._ndCampBox === box) delete bot._ndCampBox
        }
        bot._ndCampBox = box
        bot.on('health', health); bot.once('death', box.close); bot.once('end', box.close)
      }
      return { placed: r.placed, sealed, walls: r.walls, why: r.why, material: material || r.hard }
    }, { timeoutMs: 20000, interruptOn: ['death', 'kicked', 'disconnected'] }),
    // Выйти из своей коробки (кемпер получил другое дело или ранен в ней): пролом в сторону toward (или прочь от away — откуда
    // летело) и шаг наружу; итог — тело вне клетки (проход без шага — ещё не выход; Codex 15.10).
    box_out: async (p: any = {}) => session.runIntent('box_out', async ctl => {
      const F = require('../fortify'), bot = session.require()
      const box = bot._ndCampBox, cell = box?.cell || F.feetCell(bot)
      if (p.away && ![p.away.x, p.away.z].every(Number.isFinite)) return { left: false, why: 'invalid_away' }
      const outside = (q) => q.x !== cell.x || q.z !== cell.z || q.y < cell.y || q.y >= cell.y + 2
      if (outside(F.feetCell(bot))) { box?.close(); return { left: true, at: bot.entity.position } }
      if (!box && !F.enclosure(bot, cell).sealed && F.enclosure(bot, cell).open.some(s => s.feet && s.head)) return { left: false, why: 'не заперт', at: bot.entity.position }
      const out = await F.breakOut(bot, cell, { toward: p.toward || null, away: p.away || box?.away || null })
      if (ctl.aborted) return { left: false, why: 'прервано' }
      if (!out.ok) {
        await F.leaveSealedCell(session, ctl, p.toward || null)
        const left = !ctl.aborted && outside(F.feetCell(bot))
        if (left) { box?.close(); session.shelterBox = null }
        return { left, at: bot.entity.position, why: left ? null : out.steps?.join('; ') }
      }
      if (!require('../navigation/parkour').withinArena(bot, out.outside.offset(.5, 0, .5), p.arena)) return { left: false, why: 'выход за ареной' }
      const moved = await F.centerInCell(bot, 3000, out.outside, ctl)
      const left = !ctl.aborted && moved && outside(F.feetCell(bot))
      if (left) { box?.close(); session.shelterBox = null }
      return { left, at: bot.entity.position, why: left ? null : 'проход открыт, тело не вышло' }
    }, { timeoutMs: 25000, interruptOn: ['death', 'kicked', 'disconnected'] }),
    // Стойка; camp: true — кемпер в своей коробке: враг виден — fight, ранен — hurt (выйти и лечиться), дыра без врага — залатать.
    swarm_hold: async (p: any = {}) => session.runIntent('swarm_hold', async ctl => {
      const S = require('../swarm-position-work')
      if (p.camp !== true) return S.swarmHold(session, ctl, p)
      const F = require('../fortify'), bot = session.require(), box = bot._ndCampBox
      if (!box) return { camp: 'gone' }
      if (p.allies && (!Array.isArray(p.allies) || p.allies.length > 128 || p.allies.some(n => typeof n !== 'string'))) return { camp: 'stopped', why: 'invalid_allies' }
      const foe = () => require('../swarm-work').directThreat(bot, p.allies || [], 0, e => e, { ranged: false })
      // Сначала — ещё ли в коробке (вышедший бот не кемпер: бой снаружи иначе запускался каждым опросом — Codex 15.10).
      const inspect = () => {
        if (ctl.aborted) return { camp: 'stopped' }
        const here = F.feetCell(bot)
        if (here.x !== box.cell.x || here.z !== box.cell.z || here.y < box.cell.y || here.y >= box.cell.y + 2) { box.close(); return { camp: 'gone' } }
        const e = foe()
        if (e) return { camp: 'fight', target: e.username || e.id }
        if (box.hurt) return { camp: 'hurt', away: box.away || null }
        return null
      }
      let reaction = inspect()
      if (reaction || p.checkOnly) return reaction || { camp: 'hold' }
      const safe = { get aborted () { return ctl.aborted || box.hurt || !!foe() }, onAbort: ctl.onAbort }
      if (F.enclosure(bot, box.cell).sealed) {
        const watch = { get aborted () { return safe.aborted || !F.enclosure(bot, box.cell).sealed }, onAbort: ctl.onAbort }
        await S.swarmHold(session, watch, p)
      }
      reaction = inspect()
      if (reaction) return reaction
      let patched = 0
      if (!F.enclosure(bot, box.cell).sealed) {
        patched = await F.patch(bot, box.plan, { mats: box.mats, ctl: safe })
        if (!patched && !safe.aborted) await S.swarmHold(session, safe, p)
      }
      return inspect() || { camp: 'hold', patched, sealed: F.enclosure(bot, box.cell).sealed }
    }, { timeoutMs: p.camp === true ? 12000 : p.whileSmash || p.whileDraw ? 21000 : 5000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    swarm_pillar: async (p: any = {}) => session.runIntent('swarm_pillar', ctl => require('../swarm-position-work').swarmPillar(session, ctl, p), { timeoutMs: 30000, interruptOn: ['death', 'kicked', 'disconnected'] }),
    swarm_keep: async (p: any = {}) => session.immediate(async () => {
      if (p.cells !== undefined && (!Array.isArray(p.cells) || p.cells.length > 4096)) return { ok: false, why: 'invalid_cells' }
      if (p.clear === true) session.require()._ndCampBox?.close()
      return { ok: true, kept: require('../swarm-work').keepBlocks(session.require(), p.cells || [], { clear: p.clear === true }) }
    }),
    swarm_pose: async (p: any = {}) => session.immediate(async () => {
      const bot = session.require(), V = require('vec3')
      if (p.inspectOnly === true) {
        const points = p.cells === undefined ? [p.at] : p.cells
        const empty = p.cells === undefined ? { poses: [] } : { poses: [], cells: [] }
        if (!Array.isArray(points) || points.length > 64 || points.some(at => !at || ![at.x, at.y, at.z].every(Number.isSafeInteger))) return empty
        // An empty visible cell has no block outline. Reuse the combat LOS view, keeping hidden/unloaded cells unknown.
        const world = require('../pvp/search').observedCollision(bot), eye = require('../pick').eyeOf(bot)
        const cells = points.map(at => {
          const point = new V(at.x, at.y, at.z)
          const block = point.offset(.5, .5, .5).distanceTo(eye) <= 64 ? world.blockAt(point) : null
          const solid = block && !require('../navigation/geometry').HAZARD.test(block.name) && block.shapes?.some(s => s.every((n, i) => n === (i < 3 ? 0 : 1)))
          return { at, ...(block ? { existing: { name: block.name, solid: !!solid } } : {}) }
        })
        return p.cells === undefined ? { poses: [], ...(cells[0]?.existing ? { existing: cells[0].existing } : {}) } : { poses: [], cells }
      }
      if (p.cells !== undefined) return { poses: [], cells: [] }
      if (!p.at || ![p.at.x, p.at.y, p.at.z].every(Number.isSafeInteger)) return { poses: [] }
      const at = new V(p.at.x, p.at.y, p.at.z), seen = require('../pick').blockSeen(bot, at, { range: 64 })
      const block = seen && bot.blockAt(at), solid = block && !require('../navigation/geometry').HAZARD.test(block.name) && block.shapes?.some(s => s.every((n, i) => n === (i < 3 ? 0 : 1)))
      return { poses: p.inspectOnly ? [] : require('../swarm-senses').placementPoses(bot, p.at), ...(block ? { existing: { name: block.name, solid: !!solid } } : {}) }
    }),
    swarm_position: async (p: any = {}) => session.immediate(async () => {
      const bot = session.require()
      return require('../swarm-position').swarmPositions(bot, p)
    }),
    // Immediate mailbox update; leave combat events for the owner of the fight.
    // Помощь союзнику (командный бой): зелье лечения ему под ноги / стенка из двух блоков между ним и врагом.
    assist: async (p) => session.runIntent('assist', (ctl) => require('../pvp/team-assist').assist(session, p || {}, ctl), { timeoutMs: p?.mode === 'deny' || p?.mode === 'pickup' ? 9000 : 5000, params: p || {}, interruptOn: ['death', 'kicked', 'disconnected'] }),
    team_hint: async (p) => session.immediate(async () => require('../pvp/team-assist').hint(session, p || {})),
    fight_yield: async (p) => ({ status: 'done', detail: require('../combat').requestStrategicYield(session, p || {}), events: [], state: session.state() }),
    fight_guard: async (p) => ({ status: 'done', detail: require('../combat').requestFightGuard(session, p || {}), events: [], state: session.state() }),
    // Выпить баффы, которых на мне нет (арена 10.10: «пусть ускоряются жёстко и мочат»; в рюкзаках по 2–6 зелий, бой их
    // не пил). Зелье узнаётся по potion_contents (pvp.potionOf): скорость — swiftness, сила — strength, реген, огнестойкость.
    drink_buffs: async (p) => session.immediate(async () => {
      session.require()
      const bot = session.bot
      const { potionOf } = require('../pvp')
      const EFF = { swiftness: 'speed', strength: 'strength', regeneration: 'regeneration', fire_resistance: 'fire_resistance', turtle_master: 'resistance', leaping: 'jump_boost' }
      const want = (p && p.kinds) || ['swiftness', 'strength']
      const norm = (n) => String(n || '').toLowerCase().replace(/^minecraft:/, '').replace(/_/g, '')
      const has = (eff) => Object.values(bot.entity.effects || {}).some((e: any) => norm(bot.registry.effects?.[e.id]?.name) === norm(eff))
      const drunk = []
      for (const k of want) {
        if (has(EFF[k])) continue
        const it = bot.inventory.items().find(i => i.name === 'potion' && (potionOf(i) || '').replace(/^(long|strong)_/, '') === k)
        if (!it) continue
        try { await bot.equip(it, 'hand'); await bot.consume(); drunk.push(k) } catch {}
      }
      return { drunk }
    })
  }
}

export { swarmMethods }
