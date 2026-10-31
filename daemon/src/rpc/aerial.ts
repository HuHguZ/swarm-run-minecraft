'use strict'
// RPC демона — полёт и рывки: элитры, ветер, жемчуг, спасение.
// Фабрика методов над контекстом демона (rpc/context.ts); обработчики перенесены из src/index.ts.
import type { RpcContext } from './context'
import { LAUNCH_BACK } from '../mace/consts'
import * as gameClock from '../game-clock'

function aerialMethods ({ session }: RpcContext) {
  const methods = {
    // Долететь на элитрах и сесть рядом с целью (12.10, арена: «на элитрах не могут залететь ко мне — садиться в любую
    // точку, к игроку, и бить»): клетка посадки — свободная, с полом без лавы/воды в 1.5–3.5 бл. от цели; элитры — на
    // тело (нагрудник после посадки назад); маршрут — ворота над серединой пути и посадка (combat/flight-route).
    fly_to: async (p: any = {}) => session.runIntent('fly_to', async (ctl) => {
      const bot = session.require()
      const sky = require('../elytra')
      const Vec3 = require('vec3')
      if (!p.at) throw new Error('нужна точка at')
      const k = sky.kit(bot)
      if (!k.elytra || (!p.rescue && k.rockets < 2 + sky.RESCUE_ROCKETS)) return { ok: false, why: k.elytra && k.rockets ? `ракет ${k.rockets} — запас на спасение` : 'нет элитр или ракет' }
      // Escape and landing read their boundary from arena, while the rescue RPC also accepts killY separately.
      if (p.rescue && p.arena && Number.isFinite(p.killY)) p = { ...p, arena: { ...p.arena, killY: p.killY } }
      const W = sky.worldOf(bot, { observed: !!p.arena })
      const t = new Vec3(p.at.x, p.at.y, p.at.z)
      const inside = at => require('../combat/team-wind').windInside(at, p.arena)
      if (!inside(t) || (!p.rescue && !inside(bot.entity.position))) return { ok: false, why: 'outside_arena' }
      // В спасении сначала ищем ближайшую площадку, к заданной точке идём лишь пока местной нет.
      if (p.rescue) {
        const hpBefore = bot.health
        const rescueUntil = gameClock.now() + (p.timeoutSeconds ?? 15) * 1000
        const minFloorY = Number.isFinite(p.killY) ? p.killY + 1 : -Infinity
        const rescueCtl = sky.flightControl(bot, ctl)
        // В яме у врага сухой пол ещё не спасение: с ракетой и открытым верхом уходим вверх и прочь.
        if (k.rockets > 0 && sky.headroom(W, bot.entity.position, 6) >= 4) {
          const sight = require('../pvp/last-seen').createLastSeen(bot)
          try {
            const foe = (session._ndFoes || []).map(name => sight.observe(bot.players?.[name]?.entity))
              .filter(e => e && sight.visible(e)).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
            if (foe) {
              const r = await sky.escape(bot, rescueCtl, foe, { arena: p.arena ? { ...p.arena, y: t.y } : null })
              const ok = !!r.ok && (bot.health ?? 0) > 0 && !rescueCtl.aborted
              if (ok || (bot.health ?? 0) <= 0 || rescueCtl.aborted || gameClock.now() >= rescueUntil) return { ...r, ok, why: ok ? null : (bot.health ?? 0) <= 0 ? 'death' : rescueCtl.aborted ? 'flight_superseded' : r.note,
                hp: Math.round(hpBefore - bot.health) }
            }
          } finally { sight.close() }
        }
        // Failed escape may still leave us airborne without support: use the remaining rescue time locally.
        const pickLanding = () => {
          const options = { near: bot.entity.position, floorY: Math.max(bot.entity.position.y, t.y), depth: 80, minFloorY,
            inside: (x, z) => inside({ x, y: bot.entity.position.y, z }) }
          const local = sky.landingSpot(bot, W, options)
          // landingSpot starts six blocks above floorY; the known field may be below that scan window.
          return local || (options.floorY + 6 - options.depth > t.y ? sky.landingSpot(bot, W, { ...options, floorY: t.y }) : null)
        }
        if (!bot.entity.onGround && !sky.wearingElytra(bot)) {
          let sw = await sky.swapChest(bot, 'elytra', { hand: 'main', ctl: rescueCtl })
          if (!sw.ok && !rescueCtl.aborted) { await bot.waitForTicks(1); sw = await sky.swapChest(bot, 'elytra', { hand: 'main', ctl: rescueCtl }) }
          if (!sw.ok) return { ok: false, why: 'элитры: ' + sw.why }
        }
        // Раскрытие не требует ракет и свободного потолка для прыжка.
        if (!bot.entity.onGround && !sky.gliding(bot.entity) && !sky.startGlide(bot)) return { ok: false, why: 'не раскрыл элитры' }
        if (!sky.plainRocket(bot.inventory.slots[45]) && k.rockets > 0) await sky.toHotbar(bot, sky.plainRocket)
        let landing = pickLanding()
        let cruiseY = Math.max(bot.entity.position.y + 4, t.y + 4, minFloorY)
        const from = bot.entity.position.clone()
        const exit = from.y < (landing?.y ?? t.y)
          ? (require('../elytra/ceiling-exit') as typeof import('../elytra/ceiling-exit')).ceilingExit(W, from, inside) : null
        let probes = 0
        const flight = await sky.fly(bot, rescueCtl, {
          arena: p.arena, maxMs: Math.max(0, rescueUntil - gameClock.now()),
          phase: 'спасение', noRocket: () => false, useReserve: true,
          goal: () => {
            if (!landing && ++probes % 20 === 0) landing = pickLanding()
            const me = bot.entity.position
            const detour = exit?.(me, landing?.y ?? t.y, cruiseY, minFloorY)
            if (detour) return detour
            // Until a support is visible, rise above the obstruction instead of circling at a lower cruise height.
            if (!landing) cruiseY = Math.max(cruiseY, me.y + Math.min(4, sky.headroom(W, me, 6) - 1))
            const at = landing
              ? new Vec3(landing.x, landing.y + Math.min(4, sky.headroom(W, landing, 6) - 1), landing.z)
              : new Vec3(t.x, cruiseY, t.z)
            return { kind: 'point', at, minY: landing ? landing.y : cruiseY }
          },
          rocketIf: s => !landing || s.p.y < landing.y || s.v.y < -0.5,
          until: () => landing && bot.entity.position.y >= landing.y && bot.entity.velocity.y > -0.5 &&
            Math.hypot(bot.entity.position.x - landing.x, bot.entity.position.z - landing.z) < 2 ? 'над площадкой' : null
        })
        const { supportAt, containsWater } = require('../navigation/geometry') as typeof import('../navigation/geometry')
        const touchWorld = p.arena ? require('../pvp/search').observedCollision(bot) : bot
        const inspectTouch = at => {
          const inArena = !!at && inside(at)
          const minY = !!at && at.y >= minFloorY
          const shape = inArena && minY ? supportAt(touchWorld, at, .04) : null
          const f = shape ? { top: shape.top } : null
          const dry = !!shape && !containsWater(shape.block) && W.landingSafe(at)
          const support = !!shape
          return { ok: inArena && minY && dry && support, at: at ? { x: at.x, y: at.y, z: at.z } : null,
            inside: inArena, minY, minFloorY, floor: f || null, dry, support }
        }
        const safeTouch = at => inspectTouch(at).ok
        const safeGround = () => bot.entity.onGround && safeTouch(bot.entity.position)
        const beforeTouch = inspectTouch(bot.entity.position)
        const flightTouch = inspectTouch(flight.ground)
        const onGroundBefore = !!bot.entity.onGround
        const landed = onGroundBefore && beforeTouch.ok || flightTouch.ok ? { ok: true, ground: flight.ground } : landing && flight.why === 'над площадкой' && !rescueCtl.aborted
          ? await sky.land(bot, rescueCtl, { at: landing, arena: p.arena }) : { ok: false, why: flight.why }
        if (safeGround() && sky.wearingElytra(bot)) await sky.chestDown(bot, rescueCtl, { arena: p.arena })
        // Report the completed touchdown, not a later onGround sample after an awaited chest swap.
        const landedTouch = inspectTouch(landed.ground)
        const currentTouch = inspectTouch(bot.entity.position)
        const alive = (bot.health ?? 0) > 0
        const active = !rescueCtl.aborted
        const touchdown = !!landed.ok || landedTouch.ok
        const ok = touchdown && currentTouch.ok && alive && active
        const why = ok ? null : !alive ? 'death' : !active ? 'flight_superseded'
          : landed.why === 'сел' || flight.why === 'сел' ? 'unsafe_contact' : landed.why || 'не сел безопасно'
        const contact = ok ? undefined : { flightWhy: flight.why, landedWhy: landed.why, onGroundBefore,
          before: beforeTouch, flight: flightTouch, landed: landedTouch, current: currentTouch,
          touchdown, alive, active, onGround: !!bot.entity.onGround }
        return { ok, why, landing, hp: Math.round(hpBefore - bot.health), contact }
      }
      // Гребень на линии полёта (13.10: «летят ко мне сквозь стену Колизея, бьются, получают урон и уходят — облёт надо
      // считать»): верх наблюдаемого твёрдого в колонках вдоль прямой (шаг 1 бл., без 2 бл. у старта и у цели).
      // Высота полёта — над гребнем и стартом +4, над целью +8; посадка — только с открытым небом до этой высоты (в нишу
      // под навесом на элитрах не сесть — тогда отказ, пусть идёт пешком/копает).
      const me0 = bot.entity.position
      const yHi = Math.floor(Math.max(me0.y, t.y)) + 48; const yLo = Math.floor(Math.min(me0.y, t.y)) - 2
      // Unknown still blocks body forecasts, but cannot establish an obstacle's height or a landing support.
      const solidTop = (x, y, z) => {
        const f = W.floorBelow(Math.floor(x) + .5, y, Math.floor(z) + .5, 0)
        return f && !f.lava && !f.water && f.top > y ? f.top : null
      }
      const tops = new Map<string, number>()
      const topAt = (x, z) => {
        const key = `${Math.floor(x)},${Math.floor(z)}`
        if (tops.has(key)) return tops.get(key)
        let top = yLo
        for (let y = yHi; y >= yLo; y--) { const found = solidTop(x, y, z); if (found != null) { top = found; break } }
        tops.set(key, top); return top
      }
      const ridgeTo = at => {
        const H0 = Math.hypot(at.x - me0.x, at.z - me0.z)
        let ridge = { y: -Infinity, x: (me0.x + at.x) / 2, z: (me0.z + at.z) / 2, d: H0 / 2 }
        for (let d = 2; d <= H0 - 2; d += 1) {
          const x = me0.x + (at.x - me0.x) * d / H0; const z = me0.z + (at.z - me0.z) * d / H0
          const y = topAt(x, z); if (y > ridge.y) ridge = { y, x, z, d }
          // Ниже пика тоже бывает крыша: не начинать посадку до её дальнего края; ранний подъём сохраняем.
          else if (y > at.y + 1.5) ridge = { ...ridge, x, z }
        }
        // Только общий пол не требует обхода; при спуске с крыши начинаем посадку за её дальним краем.
        if (ridge.y <= Math.min(me0.y, at.y)) ridge = { ...ridge, x: (me0.x + at.x) / 2, z: (me0.z + at.z) / 2, d: H0 / 2 }
        return ridge
      }
      let ridge = ridgeTo(t)
      let cruise = Math.max(ridge.y + 4, me0.y + 4, t.y + 8)
      if (cruise > yHi) return { ok: false, why: 'гребень выше 48 бл. — не перелететь' }
      const noKnownCeiling = (x, y0, z, until = cruise) => { for (let y = Math.floor(y0) + 2; y <= until; y++) if (solidTop(x, y, z) != null) return false; return true }
      const landingChecks = { support: 0, fluid: 0, bounds: 0, occupied: 0, ceiling: 0 }
      let recoveredSupports = 0
      const landingFloor = (x, y, z, depth) => {
        let floor = W.floorBelow(x, y, z, depth)
        if (floor) return floor
        // Search observed supports below unknown space; the flight forecast still blocks unknown cells.
        for (let Y = Math.floor(y) - 1; !floor && Y >= Math.floor(y) - depth; Y--) floor = W.floorBelow(x, Y, z, 0)
        if (floor) recoveredSupports++
        return floor
      }
      const landingFits = (x, z, fl, minY, maxY) => {
        const why = !fl ? 'support' : fl.lava || fl.water ? 'fluid'
          : !inside({ x, y: fl.top, z }) || !(fl.top >= minY && fl.top <= maxY) ? 'bounds'
            : W.boxHit(x, fl.top, z, 1.8) ? 'occupied' : !noKnownCeiling(x, fl.top, z) ? 'ceiling' : null
        if (why) landingChecks[why]++
        return !why
      }
      let landing = null
      let rejectedApproaches = 0
      const tryLanding = at => {
        const nextRidge = ridgeTo(at), nextCruise = Math.max(nextRidge.y + 4, me0.y + 4, t.y + 8, at.y + 4)
        if (nextCruise > yHi || !noKnownCeiling(at.x, at.y, at.z, nextCruise)) { rejectedApproaches++; return false }
        landing = at; ridge = nextRidge; cruise = nextCruise; return true
      }
      for (const r of [1.5, 2.5, 3.5]) for (let a = 0; a < 8 && !landing; a++) {
        const x = Math.floor(t.x + Math.cos(a * Math.PI / 4) * r) + 0.5; const z = Math.floor(t.z + Math.sin(a * Math.PI / 4) * r) + 0.5
        for (const dy of [0, 1, -1]) {
          const fl = landingFloor(x, Math.floor(t.y) + dy, z, 2)
          if (landingFits(x, z, fl, t.y - 1.5, t.y + 1.5) && tryLanding({ x, y: fl.top, z })) break
        }
        if (landing) break
      }
      // У цели навес (галерея, ниша) — сесть на ближайшую открытую площадку до 8 бл. (на 3 ниже — на 10 выше цели) и дойти
      // пешком (13.10: «сижу в нычке под навесом — ни один не прилетел»).
      let walkIn = false
      if (!landing) {
        const candidates = []
        for (let r = 2; r <= 8; r++) for (let a = 0; a < 16; a++) {
          const x = Math.floor(t.x + Math.cos(a * Math.PI / 8) * r) + 0.5; const z = Math.floor(t.z + Math.sin(a * Math.PI / 8) * r) + 0.5
          const fl = landingFloor(x, Math.floor(t.y) + 10, z, 14)
          if (!landingFits(x, z, fl, t.y - 3, t.y + 10)) continue
          const c = r + Math.abs(fl.top - t.y) * 0.7
          candidates.push({ c, x, y: fl.top, z })
        }
        for (const at of candidates.sort((a, b) => a.c - b.c)) {
          if (tryLanding({ x: at.x, y: at.y, z: at.z })) { walkIn = true; break }
        }
      }
      if (!landing) return { ok: false, why: 'негде сесть у цели (под навесом или занято)', landingStage: rejectedApproaches ? 'approach' : 'selection', rejectedApproaches, landingChecks, recoveredSupports }
      if (!ctl.aborted) ctl = sky.flightControl(bot, ctl)
      if (ctl.aborted) return { ok: false, why: 'flight_superseded' }
      if (!sky.wearingElytra(bot)) {
        // В падении клик инвентаря сервер иногда не принимает — ещё раз через тик.
        let sw = await sky.swapChest(bot, 'elytra', { hand: 'main', ctl })
        if (!sw.ok && !ctl.aborted && !bot.entity.onGround) { await bot.waitForTicks(1); sw = await sky.swapChest(bot, 'elytra', { hand: 'main', ctl }) }
        if (!sw.ok) return { ok: false, why: 'элитры: ' + sw.why }
      }
      if (ctl.aborted) return { ok: false, why: 'flight_superseded' }
      // В падении (спасение из пропасти) — раскрыть сразу; маршрут дальше без взлёта с земли (runFlightRoute: уже летим).
      if (!bot.entity.onGround && !sky.gliding(bot.entity)) sky.startGlide(bot)
      const me = bot.entity.position
      const h = Math.hypot(landing.x - me.x, landing.z - me.z)
      const along = h > 2 ? { x: landing.x - me.x, y: 0, z: landing.z - me.z } : { x: 0, y: 1, z: 0 }
      // Подъём над собой нужен перед высоким препятствием, а не перед полом ниже стартовой площадки.
      const gates: any[] = []
      if (ridge.y > me.y && ridge.d < cruise - me.y) gates.push({ id: 'подъём', center: { x: me.x, y: cruise, z: me.z }, normal: { x: 0, y: 1, z: 0 }, radius: 5 })
      gates.push({ id: 'над гребнем', center: { x: ridge.x, y: cruise, z: ridge.z }, normal: along, radius: 4 })
      let r: any = null
      try { r = await require('../combat/flight-route').runFlightRoute(session, ctl, { gates, landing, timeoutSeconds: p.timeoutSeconds ?? 20, arena: p.arena }) } catch (e: any) { r = { ok: false, stopped: e.message } }
      try { if (!ctl.aborted && !sky.gliding(bot.entity) && sky.wearingElytra(bot)) await sky.swapChest(bot, 'chest', { ctl }) } catch {}
      // Дальше пешком — боем драйвера (fight сам идёт к цели); goto отсюда ждал бы конца этого же полёта.
      return { ok: !!r?.ok && !ctl.aborted, walkIn, why: ctl.aborted ? 'flight_superseded' : r?.stopped || null, at: { ...bot.entity.position },
        landing: r?.landing || null, ground: r?.ground || null, plannedLanding: landing, landingError: r?.landingError ?? null,
        ridge: Math.round(ridge.y), cruise: Math.round(cruise), rejectedApproaches, recoveredSupports, hp: r?.hpBefore != null ? Math.round(r.hpBefore - r.hp) : null }
    }, { timeoutMs: ((p.timeoutSeconds ?? 20) + 10) * 1000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    // Только таран копьём по игроку target (сцена pvp/try-lance: точность захода без выбора хода боя): passes заходов,
    // итог каждого — по used(), касания — его damage_event с причиной «я» за весь таран (не только пока копьё в деле).
    lance: async (p: any = {}) => session.runIntent('lance', async (ctl) => {
      const bot = session.require()
      // После телепорта сущность цели приходит не сразу — ждать до 40 тиков.
      let e = bot.players?.[p.target]?.entity
      for (let i = 0; !e && i < 40 && !ctl.aborted; i++) { await bot.waitForTicks(1); e = bot.players?.[p.target]?.entity }
      if (!e) return { ok: false, why: 'цели не видно' }
      const L = require('../combat/aerial-lance')
      const track = require('../bow').trackTarget(e)
      const stats: any = {}
      const passes: string[] = []
      const hurts: number[] = []
      const clock = require('../game-clock')
      const onHurt = (pk: any) => { if (bot.entity && L.ownSpearHit(pk, bot.entity.id, e.id)) hurts.push(clock.now()) }
      bot._client.on('damage_event', onHurt)
      const used = (s: string) => { const m = /^элитры: таран(?: копьём)? — (.+?)(?: \(план.*)?$/.exec(s); if (m && m[1] !== 'разбег') passes.push(m[1]) }
      try {
        const out = await L.lance(bot, ctl, e, { vel: () => track.vel(), stats, used, passes: p.passes ?? 8, maxMs: (p.maxSeconds ?? 60) * 1000, arena: p.arena || null })
        return { ...out, results: passes, hurts, stats: { lanceEarly: stats.lanceEarly, lanceBail: stats.lanceBail, lanceTrace: stats.lanceTrace, rockets: stats.rockets } }
      } finally { bot._client.removeListener('damage_event', onHurt) }
    }, { timeoutMs: ((p.maxSeconds ?? 60) + 20) * 1000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    ledge_to: async (p: any = {}) => session.runIntent('ledge_to', ctl => require('../navigation/parkour').ledgeTo(session, ctl, p), { timeoutMs: Math.max(1, Math.min(20, p.timeoutSeconds ?? 8)) * 1000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    wind_receive: async (p: any = {}) => session.runIntent('wind_receive', ctl => require('../combat/team-wind').windReceive(session, ctl, p), { timeoutMs: 10000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    wind_boost: async (p: any = {}) => session.runIntent('wind_boost', ctl => require('../combat/team-wind').windBoost(session, ctl, p), { timeoutMs: 10000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    wind_report: async (p: any = {}) => ({ status: 'done', detail: p.pairProgress ? await require('../combat/team-wind').windPairProgress(session, p) : require('../combat/enemy-wind-execute').enemyWindReport(session, p), events: [], state: session.state() }),
    enemy_wind_plan: async (p: any = {}) => ({ status: 'done', detail: await require('../combat/enemy-wind-execute').enemyWindPlan(session, p), events: [], state: session.state() }),
    // Засада на жемчуг врага (combat/pearl-ambush): к точке приземления любым способом и взлёт булавой к его появлению.
    pearl_ambush: async (p: any = {}) => session.runIntent('pearl_ambush', ctl => require('../combat/pearl-ambush').pearlAmbush(session, ctl, p), { timeoutMs: 9000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    // Ловушка или подкоп в точке жемчуга (combat/pearl-trap): лава / паутина в клетку появления или вскрыть блок удара.
    pearl_trap: async (p: any = {}) => session.runIntent('pearl_trap', ctl => require('../combat/pearl-trap').pearlTrap(session, ctl, p), { timeoutMs: 9000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    // Испытание (пользователь 24.10: «пусть некоторые боты тестово кидают жемчуг тупо вверх»): бросок прямо вверх с места и
    // бег прочь на runMs — ошибка человека, которую рой должен наказать (засада, ловушка, подкоп).
    pearl_test_up: async (p: any = {}) => session.runIntent('pearl_test_up', async () => {
      const bot = session.require(), pearl = bot.inventory.items().find((i: any) => i.name === 'ender_pearl')
      if (!pearl) return { ok: false, why: 'нет жемчуга' }
      await bot.equip(pearl, 'hand')
      await bot.look(bot.entity.yaw, Math.PI / 2 - .02, true)
      bot.activateItem()
      const yaw = Math.random() * Math.PI * 2
      await bot.look(yaw, 0, true)
      bot.setControlState('forward', true); bot.setControlState('sprint', true)
      await gameClock.sleep(Math.min(4000, Number(p.runMs) || 2500))
      bot.clearControlStates()
      return { ok: true, from: bot.entity.position.floored() }
    }, { timeoutMs: 6000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    // Облёт подброшенного врага на элитрах (combat/wing-orbit): кружить на его высоте, рефлекс сброса бросает заряды.
    wing_orbit: async (p: any = {}) => session.runIntent('wing_orbit', ctl => require('../combat/wing-orbit').wingOrbit(session, ctl, p), { timeoutMs: ((p.seconds ?? 12) + 15) * 1000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    // Спрыгнуть от врага с высоты (combat/jump-down): from — где он, край — в стороне от него, падение дёшево.
    jump_down: async (p: any = {}) => session.runIntent('jump_down', ctl => require('../combat/jump-down').jumpDown(session, ctl, p), { timeoutMs: 8000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    pearl_potion: async (p: any = {}) => session.runIntent('pearl_potion', ctl => require('../combat/pearl-ambush').pearlPotion(session, ctl, p), { exclusive: false, timeoutMs: 8000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    pearl_pop: async (p: any = {}) => session.runIntent('pearl_pop', ctl => require('../combat/pearl-ambush').pearlPop(session, ctl, p), { exclusive: false, timeoutMs: 5000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    // Разгон стрелой (combat/arrow-boost): boost_lance — стоять с копьём на врага foe и ждать толчка; boost_shot — пустить
    // слабую стрелу «Отдачи» в своего ally, чтобы его бросило к foe (draw — тиков натяжения: второму стрелку больше).
    boost_lance: async (p: any = {}) => session.runIntent('boost_lance', ctl => require('../combat/arrow-boost').boostLanceRpc(session, ctl, p), { timeoutMs: 12000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    boost_shot: async (p: any = {}) => session.runIntent('boost_shot', ctl => require('../combat/arrow-boost').boostShotRpc(session, ctl, p), { timeoutMs: 12000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    wind_out: async (p: any = {}) => session.runIntent('wind_out', ctl => require('../combat/enemy-wind-execute').enemyWindExecute(session, ctl, p), { exclusive: false, timeoutMs: 5000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    // Прыжок на заряде ветра в точку (wind-leap.ts): to — клетка, куда встать (ноги); dryRun — только план.
    wind_leap: async (p: any = {}) => session.runIntent('wind_leap', async (ctl) => {
      session.require()
      if (p.toward) return require('../wind-leap').leapToward(session, ctl, p.toward, { dryRun: !!p.dryRun, arena: p.arena })
      if (!p.to) throw new Error('нужна точка to или toward')
      return require('../wind-leap').leap(session, ctl, p.to, { dryRun: !!p.dryRun, arena: p.arena })
    }, { timeoutMs: 10000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    // Спасение при падении в пропасть (13.10, арена: «ботов сбивают в обрыв — ничего не успевают сделать»): падаю
    // (v.y < −0.5), а пола выше смертельной высоты killY подо мной в 80 бл. нет — элитры (из рюкзака на тело в воздухе) и
    // ракеты есть: раскрыть и лететь к safe (fly_to: над гребнем, посадка с открытым небом). Конфиг — от драйвера арены.
    rescue_config: async (p: any = {}) => {
      session._rescue = p.off ? null : { safe: p.safe, killY: Number(p.killY),
        arena: p.arena ? { ...p.arena, y: p.arena.y ?? p.safe?.y, killY: Number(p.killY) } : null }
      const bot = session.bot
      // Реактивный сброс ветром живёт там же, где знание арены и линии смерти (rescue_config раз в 20 с всем ботам).
      if (bot && p.arena && !p.off) require('../combat/wind-out').installWindOut(session)
      if (bot && !bot._ndRescue) {
        require('../elytra').install(bot)
        bot._ndRescue = true
        let busyRescue = false
        bot.on('physicsTick', () => {
          const cfg = session._rescue; const b = bot.entity
          if (session.bot !== bot || !cfg || busyRescue || !b || b.onGround || b.isInWater || (bot.health ?? 0) <= 0) return
          // Медленное планирование тоже пересекает зону смерти (c31: vy=-0.086).
          const killSoon = b.velocity.y < 0 && b.position.y + b.velocity.y * 8 <= cfg.killY + 1
          const sky = require('../elytra')
          const S = sky.install(bot)
          // Без рулевого возврат нужен уже за границей: outside обрывает прогноз раньше опасного снижения.
          const outside = b.elytraFlying && !S.driving && cfg.arena &&
            !(require('../combat/team-wind') as typeof import('../combat/team-wind')).windInside(b.position, cfg.arena)
          const unmanaged = b.elytraFlying && !S.driving && !session.current && !session.reflex
          if (b.velocity.y > -0.25 && !killSoon && !outside && !unmanaged) return
          const W = sky.worldOf(bot, { observed: !!cfg.arena })
          const f = W.floorBelow(b.position.x, b.position.y, b.position.z, 80)
          const fd = S.fd + Math.max(0, (S.lastY ?? b.position.y) - b.position.y)
          if (b.elytraFlying) {
            // Обычный управляемый полёт не перебиваем; авария — смертельное касание или зона смерти в прогнозе.
            const r = sky.rollout(W, b.position, b.velocity, b.yaw, b.pitch, bot.fireworkRocketDuration || 0, 8, { fd, arena: cfg.arena })
            const lethal = r.kind === 'floor' && Math.max(0, Math.floor(r.fd + 1e-6 - 3)) >= bot.health
            if (!lethal && r.p.y > cfg.killY + 1 && !outside && !unmanaged) return
          }
          const fall = f ? fd + Math.max(0, b.position.y - f.top) : Infinity
          const damage = Math.max(0, Math.floor(fall + 1e-6 - 3))
          if (!b.elytraFlying && f && f.top >= cfg.killY + 1 && !f.lava && (f.water || damage < bot.health)) return
          const k = sky.kit(bot)
          // Без элитр с ракетами планер до линии смерти не дотянет — жемчуг обратно на Колизей (пользователь 25.10).
          const hasPearl = bot.inventory.items().some(i => i.name === 'ender_pearl') || bot.inventory.slots[45]?.name === 'ender_pearl'
          if (!(k.elytra && k.rockets > 0) && hasPearl && !b.elytraFlying) {
            busyRescue = true
            console.log('[rescue] падаю в пропасть — жемчуг', JSON.stringify({ at: require('../game-clock').now(), y: Math.round(b.position.y), vy: b.velocity.y, hp: bot.health, elytra: !!k.elytra, rockets: k.rockets, killY: cfg.killY }))
            session.runIntent('pearl_to', ctl => require('../combat/emergency-escape').pitPearl(bot, ctl, { killY: cfg.killY, arena: cfg.arena, foes: (session._ndFoes || []).map(n => bot.players?.[n]?.entity?.position).filter(Boolean) }),
              { timeoutMs: 8000, interruptOn: ['death', 'kicked', 'disconnected'], params: { rescue: true } })
              .then(r => console.log('[rescue]', JSON.stringify(r?.detail || r))).catch(() => {}).finally(() => { busyRescue = false })
            return
          }
          if (!k.elytra) return
          busyRescue = true
          console.log(outside || unmanaged ? '[rescue] полёт без рулевого — элитры' : '[rescue] падаю в пропасть — элитры', JSON.stringify({ at: require('../game-clock').now(), wallAt: require('../game-clock').wall.now(), y: Math.round(b.position.y), vy: b.velocity.y, fd, hp: bot.health, rockets: k.rockets, floor: f ? f.top : null, killY: cfg.killY }))
          methods.fly_to({ at: cfg.safe, killY: cfg.killY, arena: cfg.arena, timeoutSeconds: 15, rescue: true }).then(r => console.log('[rescue]', JSON.stringify(r?.detail || r))).catch(() => {}).finally(() => { busyRescue = false })
        })
      }
      return { status: 'done', detail: { on: !!session._rescue } }
    },
    // Сдуть с края (13.10, арена: человек так сбрасывает ботов с Колизея — «ветром не могут в меня попасть»): он у обрыва
    // (за ним по линии от меня падение 5+ бл. или пусто в 1–2 бл.) — заряд ветра в пол у его ног с моей стороны с
    // упреждением (заряд 1.5 б/т без гравитации): всплеск толкает «центр → глаза» — от меня, за край. Честно: точка видна.
    wind_push: async (p: any = {}) => session.runIntent('wind_push', async ctl => {
      const bot = session.require(), sight = require('../pvp/last-seen').createLastSeen(bot)
      try {
        const e = sight.observe(bot.players?.[p.target]?.entity)
        if (!e || !sight.visible(e)) return { ok: false, fired: false, why: 'цель не видна' }
        // Принудительный толчок команды тоже бессмыслен в паутине (q8): её сперва разбирают.
        if ([0, 1].some(dy => bot.blockAt(e.position.offset(0, dy, 0).floored())?.name === 'cobweb')) return { ok: false, fired: false, why: 'цель в паутине' }
        // Всплеск — 2.4 бл. от точки у его ног: свой рядом с целью улетит вместе с ней (DeepSeek, разбор сброса 21.10).
        if ((p.allies || []).some((n: string) => { const a = bot.players?.[n]?.entity; return a && a.position.distanceTo(e.position) < 3 })) return { ok: false, fired: false, why: 'свой у цели' }
        const mace = require('../mace')
        if (!p.force && !mace.pushPlan(bot, e, { sees: true, theyUp: e.position.y > bot.entity.position.y + 2 })) return { ok: false, fired: false, why: 'толкать сейчас невыгодно' }
        const result = await mace.windPush(bot, e, { vel: () => sight.observe(e)?.velocity || { x: 0, y: 0, z: 0 } })
        return { ...result, ok: !!result.fired }
      } finally { sight.close() }
    }, { timeoutMs: 3000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    // Прыжок на заряде ветра (10.10: «зарядами ветра передвигаться — подкидывать себя, убегать, подниматься высоко»):
    // up — заряд строго под ноги и сразу прыжок; toward {x,z} — разбег к точке, в прыжке заряд под ноги чуть позади:
    // взрыв толкает вперёд и вверх. Перезарядка заряда 10 тиков; times ≤ 3 подряд.
    wind_jump: async (p) => session.runIntent('wind_jump', async (ctl) => {
      const bot = session.require()
      const wind = require('../mace/hands') as typeof import('../mace/hands')
      wind.install(bot)
      const n = Math.max(1, Math.min(3, p?.times ?? 1))
      let used = 0
      const y0 = bot.entity.position.y
      // Потолок ближе 5 блоков — взлёт упрётся (10.10: «в комнате кидают в потолок, зацикленно»); вперёд — стена ближе 3.
      const feet0 = bot.entity.position.floored()
      for (let dy = 2; dy <= 5; dy++) { const b = bot.blockAt(feet0.offset(0, dy, 0)); if (b && b.boundingBox === 'block') return { used: 0, rise: 0, why: `потолок в ${dy} бл.` } }
      if (p?.toward && !p?.up) {
        const dx = p.toward.x - bot.entity.position.x; const dz = p.toward.z - bot.entity.position.z; const l = Math.hypot(dx, dz) || 1
        for (let k = 1; k <= 3; k++) for (const dy of [0, 1, 2]) { const b = bot.blockAt(bot.entity.position.offset(dx / l * k, dy, dz / l * k).floored()); if (b && b.boundingBox === 'block') return { used: 0, rise: 0, why: `стена впереди в ${k} бл.` } }
      }
      for (let k = 0; k < n && !ctl.aborted; k++) {
        const wc = bot.inventory.items().find(i => i.name === 'wind_charge')
        if (!wc) break
        await bot.equip(wc, 'hand')
        bot.clearControlStates()
        let yaw = bot.entity.yaw
        if (p?.toward) {
          const dx = p.toward.x - bot.entity.position.x; const dz = p.toward.z - bot.entity.position.z
          yaw = Math.atan2(-dx, -dz)
          await bot.look(yaw, 0, true)
          if (!p.up) {
            bot.setControlState('sprint', true); bot.setControlState('forward', true)
            await bot.waitForTicks(3)
          } else await bot.waitForTicks(1)
        } else await bot.waitForTicks(1) // Отпустить прежний автопрыжок перед отрывом.
        const flat = p?.toward && !p?.up
        if (flat) bot.setControlState('jump', true)
        // Вверх — бросок с земли и сразу прыжок; по ходу — на первом тике спринт-отрыва.
        const fired = await wind.fireWind(bot, moved => !ctl.aborted &&
          (wind.selfWindAim(bot, { moved, yaw, back: flat ? LAUNCH_BACK : 0 }) || wind.selfWindAim(bot, { moved })), {
          hand: 'main', before: () => { bot.setControlState('jump', !flat && bot.entity.onGround); bot.setControlState('forward', false); bot.setControlState('sprint', false) }
        })
        if (fired.fired && !flat) await wind.nextTick(bot)
        bot.setControlState('jump', false)
        if (!fired.fired) return { used, rise: 0, why: fired.why }
        used++
        await bot.waitForTicks(Math.max(0, fired.shot.ticks - (flat ? 0 : 1)))
        if (p?.toward) { await bot.look(yaw, 0, true); bot.setControlState('forward', true); bot.setControlState('sprint', true) }
        await bot.waitForTicks(Math.max(0, 10 - fired.shot.ticks))
      }
      bot.setControlState('sprint', false); bot.setControlState('forward', false)
      for (let t = 0; t < 40 && !bot.entity.onGround && !ctl.aborted; t++) await bot.waitForTicks(1)
      return { used, rise: Math.round((bot.entity.position.y - y0) * 10) / 10, at: { x: Math.round(bot.entity.position.x), y: Math.round(bot.entity.position.y), z: Math.round(bot.entity.position.z) } }
    }, { timeoutMs: 8000, interruptOn: ['death', 'kicked', 'disconnected'], params: p || {} }),
    // Жемчуг туда, где не достать (10.10: «закидываю жемчуг высоко на Колизей, чтобы никто не достал — боты так не
    // думают»): бросок к точке to (крыша яруса, вершина) — pearl-hop.hopTo без проверки выгоды против пешего пути.
    pearl_to: async (p) => session.runIntent('pearl_to', async (ctl) => {
      const bot = session.require()
      if (!p?.to) throw new Error('нужна точка to')
      if (p.observed === true) return require('../swarm-position').pearlToPosition(session, ctl, { to: p.to, arena: p.arena })
      const ph = require('../pearl-hop')
      const from = bot.entity.position.clone()
      const r = await ph.hopTo(bot, p.to, { reserve: 0, minGain: -999, hpMin: 3, maxHops: p.maxHops ?? 1, arriveR: 3, walkSec: 999, edgeOk: !!p.edgeOk, yTop: p.yTop ?? 30, abortIf: () => ctl.aborted })
      const me = bot.entity.position
      // loose — «куда-нибудь прочь»: удача, если перенёсся на 6+ бл.
      const ok = Math.hypot(me.x - p.to.x, me.y - p.to.y, me.z - p.to.z) <= 4 || (!!p.loose && me.distanceTo(from) >= 6)
      return { ok, hops: r.hops, stop: r.stop, why: r.why, at: { x: Math.round(me.x), y: Math.round(me.y), z: Math.round(me.z) } }
    }, { timeoutMs: 12000, interruptOn: ['death', 'kicked', 'disconnected'], params: p || {} })
  }
  return methods
}

export { aerialMethods }
