'use strict'
// RPC демона — наблюдение: status/peek, жесты, глаза, оценка обстановки.
// Фабрика методов над контекстом демона (rpc/context.ts); обработчики перенесены из src/index.ts.
import type { RpcContext } from './context'

function observationMethods ({ session, cfg, bus, vision, gameClock, state }: RpcContext) {
  // Чары того, что на теле, в руках и в рюкзаке (арена с чарами, 2026-09-26):
  // арена сверяет с ними выдачу — status { enchants: true }. Без параметра status
  // прежний: мозгу чары в каждом ответе ни к чему. Слоты — окна игрока: 5–8
  // броня, 9–44 рюкзак и хотбар, 45 левая рука. Читается сам компонент
  // enchantments (enchant.enchantsOf), а не prismarine-item.enchants.
  // Что поле есть (хоть пустое) — ещё и знак арене, что демон умеет
  // зачарованные инструменты (gamedata.fixEnchants): старый демон параметр
  // молча пропускает.
  function enchantedGear (bot) {
    if (!bot || !bot.inventory) return []
    const { enchantsOf } = require('../enchant')
    const out = []
    bot.inventory.slots.forEach((it, slot) => {
      if (!it || slot < 5) return
      const list = enchantsOf(bot, it)
      if (list.length) out.push({ slot, name: it.name, ench: Object.fromEntries(list.map(e => [e.name, e.level])) })
    })
    return out
  }

  function statusDetail (p) {
    return {
      fairPlay: cfg.fairPlay,
      server: `${cfg.host}:${cfg.port}`,
      rescuing: session.current?.name === 'fly_to' && !!session.current.params?.rescue && !!session.current.ctl && !session.current.ctl.aborted,
      // Неделимая связка тела (utility/fight riptideSmash): рой не шлёт новых заданий, пока не кончится.
      combo: session.bot?._ndCombo && session.bot._ndCombo.until > gameClock.now() ? session.bot._ndCombo.kind : null,
      ...(p?.swarm ? { at: session.bot?.entity?.position, sightings: require('../swarm-senses').swarmSightings(session.bot, p.swarmAllies), ownEnchants: enchantedGear(session.bot), windOut: session._windOut?.log.splice(0), pearls: require('../combat/pearl-watch').enemyPearls(session.bot) } : {}),
      ...(p && p.items ? {
        items: session.bot?.inventory?.slots?.slice(5).filter(Boolean).map(it => require('../pvp/combat-observe').itemObs(session.bot, it)) || [],
        storage: session.bot?.inventory?.slots ? Array.from({ length: 36 }, (_, index) => {
          const it = session.bot.inventory.slots[index + 9]
          return it ? { ...require('../pvp/combat-observe').itemObs(session.bot, it),
            plain: !it.nbt && !(it.components?.length) && !(it.removedComponents?.length) && !(it.componentMap?.size) && !(it.metadata) } : null
        }) : null
      } : {}),
      ...(p && p.foeEstimate ? { foeEstimate: require('../pvp/combat-observe').readFoeEstimate(session.bot, p.foeEstimate) } : {}),
      ...(p && p.enchants ? { enchants: enchantedGear(session.bot) } : {}),
      // Последний отчёт дуэли (pvp.duel кладёт при конце боя): арена берёт его, если ответ fight пришёл пустым (S7d).
      ...(p && p.lastDuel ? { lastDuel: session.bot?._ndLastDuel || null } : {}),
      ...(p && p.totem ? { totem: require('../totem').snapshot(session.bot) } : {}),
      // Летящие вредные зелья и игроки со взрывным зельем в руке (threats.dangers) — арене для уворота.
      ...(p && p.dangers && session.bot?.entity ? { dangers: require('../threats').dangers(session.bot, { foes: p.foes ?? state.dangerWatch?.foes }) } : {}),
      ...(p && p.physics && session.bot?.entity ? { physics: {
        pos: session.bot.entity.position, velocity: session.bot.entity.velocity,
        onGround: session.bot.entity.onGround, pose: session.bot.entity.pose,
        isInWater: !!session.bot.entity.isInWater, isInLava: !!session.bot.entity.isInLava,
        clutch: { waterPlan: !!session.bot._ndClutch?.waterPlan,
          stats: Object.fromEntries(['water_plans', 'water_saved', 'water_failed', 'ladders', 'saved', 'placed', 'soft_plans', 'soft_saved', 'soft_failed'].map(key => [key, session.bot._ndClutch?.stats?.[key] ?? 0])),
          lastDecision: session.bot._ndClutch?.lastDecision ? { action: session.bot._ndClutch.lastDecision.action, why: session.bot._ndClutch.lastDecision.why } : null },
        sprintJump: session.bot._ndSprintJump ? { jumps: session.bot._ndSprintJump.jumps, skipped: session.bot._ndSprintJump.skipped } : null,
        controls: Object.fromEntries(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].map(key => [key, session.bot.getControlState(key)])), jumpTicks: session.bot.jumpTicks,
        worldLoaded: [-8, 0, 8].every(x => [-8, 0, 8].every(z => !!session.bot.blockAt(session.bot.entity.position.offset(x, -1, z)))),
        height: session.bot.physics?.playerHeight, halfWidth: session.bot.physics?.playerHalfWidth,
        gravity: session.bot.physics?.gravity, attributes: session.bot.entity.attributes,
        // Отладка «стоит на месте при живом пути» (регрессия спуска 30.09): флаги pathfinder'а и рефлекс края.
        pathfinder: session.bot.pathfinder ? { mining: session.bot.pathfinder.isMining(), building: session.bot.pathfinder.isBuilding(),
          moving: session.bot.pathfinder.isMoving(), goal: !!session.bot.pathfinder.goal } : null,
        targetDig: session.bot.targetDigBlock ? session.bot.targetDigBlock.position : null,
        simWrapped: !!(session.bot.physics && session.bot._ndSimOrig && session.bot.physics.simulatePlayer !== session.bot._ndSimOrig)
      } } : {})
    }
  }

  return {
    status: async (p) => session.immediate(async () => statusDetail(p)),
    // Наблюдатель сцены рядом с работающей кампанией: состояние и враги рядом БЕЗ выемки шины событий
    // (status/situation через immediate() забирают события у мозга — emergency/refuge/damage пропадали бы).
    peek: async (p) => {
      const bot = session.bot
      let foes = []
      try { if (bot && bot.entity) foes = require('../flee').hostilesAround(bot, 24).slice(0, 8).map(h => ({ name: h.e.name, d: Math.round(h.d * 10) / 10, dy: Math.round((h.e.position.y - bot.entity.position.y) * 10) / 10 })) } catch {}
      return { status: 'done', detail: { ...statusDetail(p), foes, busy: session.current ? session.current.name : null, refuging: !!(session.autopilot && session.autopilot.refuging), water: !!bot?.entity && require('../movement').inWater(bot) }, events: [], state: session.state() }
    },
    // Жест (гонка в Колизее, 10.10: «эмоции чаще — кивать, махать, присаживаться»): nod | shake | wave | crouch, at — на кого смотреть.
    emote: async (p: any = {}) => session.immediate(async () => {
      const bot = session.require()
      const wait = ms => new Promise<void>(r => gameClock.setTimeout(r, ms))
      if (p.at) await session.turnTo(p.at)
      const yaw = bot.entity.yaw; const pitch = bot.entity.pitch
      const kind = p.kind || 'wave'
      for (let k = 0; k < 3; k++) {
        if (kind === 'nod') { await bot.look(yaw, pitch - 0.5, true); await wait(150); await bot.look(yaw, pitch + 0.2, true); await wait(150) }
        else if (kind === 'shake') { await bot.look(yaw + 0.5, pitch, true); await wait(150); await bot.look(yaw - 0.5, pitch, true); await wait(150) }
        else if (kind === 'crouch') { bot.setControlState('sneak', true); await wait(130); bot.setControlState('sneak', false); await wait(130) }
        else { bot.swingArm(); await wait(220) }
      }
      if (kind !== 'wave') await bot.look(yaw, pitch, true)
      return { emote: kind }
    }),
    // Честное восприятие (S10, perception/): mode f3 | pie | pie_arcs | heard | seen | surface | entities | stats | knowledge
    // | sweep | pie_seek (ходом: пеленги «пирога» → оценка места) | без mode — сводка.
    perceive: async (p: any = {}) => p && p.mode === 'pie_seek'
      ? session.runIntent('pie_seek', ctl => { session.require(); session.updateMovements(); return require('../perception/senses').pieSeek(session, ctl, p) },
        { timeoutMs: (Math.min(600, p.timeoutSeconds ?? 120) + 20) * 1000, params: p })
      : session.immediate(async () => { session.require(); return require('../perception/senses').perceive(session, p || {}) }),
    // Actual eyesight. Returns the PNG alongside the usual envelope so the brain
    // gets the picture and the state header in one round trip.
    look: async (p: any = {}) => {
      session.require()
      if (p.at) await session.turnTo(p.at)
      const shot = await vision.capture(p)
      return {
        status: 'done',
        detail: { size: `${shot.width}x${shot.height}`, lookedAt: p.at || null },
        image: shot.image,
        mime: shot.mime,
        events: bus.drain(),
        state: session.state()
      }
    },
    loot_seen: async (p) => session.immediate(async () => {
      session.require()
      return { chests: require('../loot').seen(session, { radius: (p && p.radius) || 24 }) }
    }),
    // Разбор врагов вокруг — без боя и без движения тела.
    assess: async (p) => session.immediate(async () => {
      session.require()
      const r = require('../assess').plan(session.bot, { radius: (p && p.radius) || 24 })
      if (!r) return { text: 'не в игре' }
      const { first, ...rest } = r
      return rest
    })
  }
}

export { observationMethods }
