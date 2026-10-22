'use strict'
// RPC демона — полёт и рывки: элитры, ветер, жемчуг, спасение.
// Фабрика методов над контекстом демона (rpc/context.ts); обработчики перенесены из src/index.ts.
import type { RpcContext } from './context'

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
      if (!k.elytra || k.rockets < 2) return { ok: false, why: 'нет элитр или ракет' }
      const W = sky.worldOf(bot, { observed: !!p.arena })
      const t = new Vec3(p.at.x, p.at.y, p.at.z)
      const inside = at => require('../combat/team-wind').windInside(at, p.arena)
      if (!inside(t) || !inside(bot.entity.position)) return { ok: false, why: 'outside_arena' }
      // Спасение из пропасти: элитры на тело, раскрыть и ракету вверх к цели — сразу, до расчёта гребня и посадки (до смертельной
      // высоты арены 7 бл.; rescue → fly_to погибал на y 110, не раскрывшись).
      if (p.rescue && !bot.entity.onGround) {
        if (!sky.wearingElytra(bot) && !(await sky.swapChest(bot, 'elytra', { hand: 'main' })).ok) { await bot.waitForTicks(1); await sky.swapChest(bot, 'elytra', { hand: 'main' }) }
        if (sky.wearingElytra(bot) && sky.startGlide(bot)) {
          const at0 = bot.entity.position
          await bot.look(Math.atan2(-(t.x - at0.x), -(t.z - at0.z)), Math.PI / 4, true).catch(() => {})
          sky.fireRocket(bot)
        }
      }
      // Гребень на линии полёта (13.10: «летят ко мне сквозь стену Колизея, бьются, получают урон и уходят — облёт надо
      // считать»): верх твёрдого в колонках вдоль прямой (шаг 1 бл., без 2 бл. у старта и у цели; непрогруженное — твёрдое).
      // Высота полёта — над гребнем +4 (не ниже +8 над концами); посадка — только с открытым небом до этой высоты (в нишу
      // под навесом на элитрах не сесть — тогда отказ, пусть идёт пешком/копает).
      const me0 = bot.entity.position
      const yHi = Math.floor(Math.max(me0.y, t.y)) + 48; const yLo = Math.floor(Math.min(me0.y, t.y)) - 2
      const topAt = (x, z) => { for (let y = yHi; y >= yLo; y--) if (W.solid(Math.floor(x), y, Math.floor(z))) return y + 1; return yLo }
      const H0 = Math.hypot(t.x - me0.x, t.z - me0.z)
      let ridge = { y: -Infinity, x: (me0.x + t.x) / 2, z: (me0.z + t.z) / 2, d: H0 / 2 }
      for (let d = 2; d <= H0 - 2; d += 1) {
        const x = me0.x + (t.x - me0.x) * d / H0; const z = me0.z + (t.z - me0.z) * d / H0
        const y = topAt(x, z); if (y > ridge.y) ridge = { y, x, z, d }
      }
      const cruise = Math.max(ridge.y + 4, Math.max(me0.y, t.y) + 8)
      if (cruise > yHi) return { ok: false, why: 'гребень выше 48 бл. — не перелететь' }
      const skyOpen = (x, y0, z) => { for (let y = Math.floor(y0) + 2; y <= cruise; y++) if (W.solid(Math.floor(x), y, Math.floor(z))) return false; return true }
      let landing = null
      for (const r of [1.5, 2.5, 3.5]) for (let a = 0; a < 8 && !landing; a++) {
        const x = Math.floor(t.x + Math.cos(a * Math.PI / 4) * r) + 0.5; const z = Math.floor(t.z + Math.sin(a * Math.PI / 4) * r) + 0.5
        for (const dy of [0, 1, -1]) {
          const fl = W.floorBelow(x, Math.floor(t.y) + dy, z, 2)
          if (fl && !fl.lava && !fl.water && inside({ x, y: fl.top, z }) && Math.abs(fl.top - t.y) <= 1.5 && !W.boxHit(x, fl.top, z, 1.8) && skyOpen(x, fl.top, z)) { landing = { x, y: fl.top, z }; break }
        }
        if (landing) break
      }
      // У цели навес (галерея, ниша) — сесть на ближайшую открытую площадку до 8 бл. (на 3 ниже — на 10 выше цели) и дойти
      // пешком (13.10: «сижу в нычке под навесом — ни один не прилетел»).
      let walkIn = false
      if (!landing) {
        let best = null
        for (let r = 2; r <= 8; r++) for (let a = 0; a < 16; a++) {
          const x = Math.floor(t.x + Math.cos(a * Math.PI / 8) * r) + 0.5; const z = Math.floor(t.z + Math.sin(a * Math.PI / 8) * r) + 0.5
          const fl = W.floorBelow(x, Math.floor(t.y) + 10, z, 14)
          if (!fl || fl.lava || fl.water || !inside({ x, y: fl.top, z }) || fl.top < t.y - 3 || fl.top > t.y + 10 || W.boxHit(x, fl.top, z, 1.8) || !skyOpen(x, fl.top, z)) continue
          const c = r + Math.abs(fl.top - t.y) * 0.7
          if (!best || c < best.c) best = { c, x, y: fl.top, z }
        }
        if (best) { landing = { x: best.x, y: best.y, z: best.z }; walkIn = true }
      }
      if (!landing) return { ok: false, why: 'негде сесть у цели (под навесом или занято)' }
      if (!sky.wearingElytra(bot)) {
        // В падении клик инвентаря сервер иногда не принимает — ещё раз через тик.
        let sw = await sky.swapChest(bot, 'elytra', { hand: 'main' })
        if (!sw.ok && !bot.entity.onGround) { await bot.waitForTicks(1); sw = await sky.swapChest(bot, 'elytra', { hand: 'main' }) }
        if (!sw.ok) return { ok: false, why: 'элитры: ' + sw.why }
      }
      // В падении (спасение из пропасти) — раскрыть сразу; маршрут дальше без взлёта с земли (runFlightRoute: уже летим).
      if (!bot.entity.onGround && !sky.gliding(bot.entity)) sky.startGlide(bot)
      const me = bot.entity.position
      const h = Math.hypot(landing.x - me.x, landing.z - me.z)
      const along = h > 2 ? { x: landing.x - me.x, y: 0, z: landing.z - me.z } : { x: 0, y: 1, z: 0 }
      // Ворота: гребень близко к старту (взлёт круче 1:1) — сначала подъём над собой; потом — над гребнем на высоте полёта.
      const gates: any[] = []
      if (ridge.d < cruise - me.y) gates.push({ id: 'подъём', center: { x: me.x, y: cruise, z: me.z }, normal: { x: 0, y: 1, z: 0 }, radius: 5 })
      gates.push({ id: 'над гребнем', center: { x: ridge.x, y: cruise, z: ridge.z }, normal: along, radius: 4 })
      let r: any = null
      try { r = await require('../combat/flight-route').runFlightRoute(session, ctl, { gates, landing, timeoutSeconds: p.timeoutSeconds ?? 20, arena: p.arena }) } catch (e: any) { r = { ok: false, stopped: e.message } }
      try { if (!sky.gliding(bot.entity) && sky.wearingElytra(bot)) await sky.swapChest(bot, 'chest') } catch {}
      // Дальше пешком — боем драйвера (fight сам идёт к цели); goto отсюда ждал бы конца этого же полёта.
      return { ok: !!r?.ok, walkIn, why: r?.stopped || null, landing, ridge: Math.round(ridge.y), cruise: Math.round(cruise), hp: r?.hpBefore != null ? Math.round(r.hpBefore - r.hp) : null }
    }, { timeoutMs: ((p.timeoutSeconds ?? 20) + 10) * 1000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    ledge_to: async (p: any = {}) => session.runIntent('ledge_to', ctl => require('../navigation/parkour').ledgeTo(session, ctl, p), { timeoutMs: Math.max(1, Math.min(20, p.timeoutSeconds ?? 8)) * 1000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    wind_receive: async (p: any = {}) => session.runIntent('wind_receive', ctl => require('../combat/team-wind').windReceive(session, ctl, p), { timeoutMs: 10000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    wind_boost: async (p: any = {}) => session.runIntent('wind_boost', ctl => require('../combat/team-wind').windBoost(session, ctl, p), { timeoutMs: 10000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
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
      session._rescue = p.off ? null : { safe: p.safe, killY: Number(p.killY) }
      const bot = session.bot
      if (bot && !bot._ndRescue) {
        bot._ndRescue = true
        let busyRescue = false
        bot.on('physicsTick', () => {
          const cfg = session._rescue; const b = bot.entity
          // Порог −0.25 б/т, а не −0.5 (14.10: «их легко в обрыв скидывать — не пытаются спастись»): смертельная высота арены — 7 бл.
          // под полем, на −0.5 тело уже в 2–3 бл. над ней, и спасение не успевало; ложный прыжок отсекает пол ниже (f.top).
          if (!cfg || busyRescue || !b || b.onGround || b.isInWater || b.elytraFlying || b.velocity.y > -0.25 || (bot.health ?? 0) <= 0) return
          const sky = require('../elytra')
          const f = sky.worldOf(bot).floorBelow(b.position.x, b.position.y, b.position.z, 80)
          // Внизу смертельная высота, лава — или само падение больше хп (+3): раскрыть. Раньше — только «внизу пусто»: бот
          // летел вдоль гребня, под ним мелькали уступы, и спасение включалось уже в зоне смерти (y 112 при killY 113).
          const fall = f ? b.position.y - f.top : Infinity
          if (f && f.top >= cfg.killY + 1 && !f.lava && fall <= (bot.health ?? 20) + 3) return
          const k = sky.kit(bot)
          if (!k.elytra || k.rockets < 1) return
          busyRescue = true
          console.log('[rescue] падаю в пропасть — элитры', JSON.stringify({ y: Math.round(b.position.y), floor: f ? f.top : null, killY: cfg.killY }))
          methods.fly_to({ at: cfg.safe, timeoutSeconds: 15, rescue: true }).then(r => console.log('[rescue]', JSON.stringify(r?.detail || r).slice(0, 200))).catch(() => {}).finally(() => { busyRescue = false })
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
        // Всплеск — 2.4 бл. от точки у его ног: свой рядом с целью улетит вместе с ней (DeepSeek, разбор сброса 21.10).
        if ((p.allies || []).some((n: string) => { const a = bot.players?.[n]?.entity; return a && a.position.distanceTo(e.position) < 3 })) return { ok: false, fired: false, why: 'свой у цели' }
        const mace = require('../mace')
        if (!p.force && !mace.pushPlan(bot, e, { sees: true, theyUp: e.position.y > bot.entity.position.y + 2 })) return { ok: false, fired: false, why: 'толкать сейчас невыгодно' }
        const result = await mace.windPush(bot, e, { vel: () => sight.observe(e)?.velocity || { x: 0, y: 0, z: 0 } })
        return { ...result, ok: !!result.fired }
      } finally { sight.close() }
    }, { timeoutMs: 3000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    // Прыжок на заряде ветра (10.10: «зарядами ветра передвигаться — подкидывать себя, убегать, подниматься высоко»):
    // up — заряд под ноги в прыжке (вверх ~7 бл.); toward {x,z} — разбег к точке, в прыжке заряд под ноги чуть позади:
    // взрыв толкает вперёд и вверх. Перезарядка заряда 10 тиков; times ≤ 3 подряд.
    wind_jump: async (p) => session.runIntent('wind_jump', async (ctl) => {
      const bot = session.require()
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
        let yaw = bot.entity.yaw
        if (p?.toward) {
          const dx = p.toward.x - bot.entity.position.x; const dz = p.toward.z - bot.entity.position.z
          yaw = Math.atan2(-dx, -dz)
          await bot.look(yaw, 0, true)
          bot.setControlState('sprint', true); bot.setControlState('forward', true)
          await bot.waitForTicks(3)
        }
        bot.setControlState('jump', true)
        await bot.waitForTicks(2)
        bot.setControlState('jump', false)
        // Вниз (вверх — строго под ноги; вперёд — под ноги, чуть за спину).
        // up — строго под ноги (подъём на ярус: вверх ~7 бл., в полёте — вперёд к цели); иначе — под ноги чуть за спину.
        const flat = p?.toward && !p?.up
        // Заряд — только в опору (13.10: «себе под ноги — только когда есть опора, а так пулял в никуда»): луч взгляда до
        // первого твёрдого блока в 3.5 бл., точка удара не дальше 2.3 от ног (всплеск достаёт до 2.4); за спиной пусто —
        // строго вниз; и там нет — не бросать.
        const burstAt = (yw, pt) => {
          const e = bot.entity.position.offset(0, 1.62, 0); const d = { x: -Math.sin(yw) * Math.cos(pt), y: Math.sin(pt), z: -Math.cos(yw) * Math.cos(pt) }
          for (let s = 0.2; s <= 3.5; s += 0.1) {
            const q = e.offset(d.x * s, d.y * s, d.z * s); const b = bot.blockAt(q.floored())
            if (b && b.boundingBox === 'block') return q.distanceTo(bot.entity.position) <= 2.3 ? q : null
          }
          return null
        }
        let ly = flat ? yaw + Math.PI : yaw; let lp = flat ? -1.25 : -Math.PI / 2
        if (!burstAt(ly, lp)) { ly = yaw; lp = -Math.PI / 2 }
        if (!burstAt(ly, lp)) { bot.setControlState('sprint', false); bot.setControlState('forward', false); return { used, rise: 0, why: 'нет опоры для заряда' } }
        await bot.look(ly, lp, true)
        bot.activateItem(); used++
        if (p?.toward) { await bot.waitForTicks(2); await bot.look(yaw, 0, true); bot.setControlState('forward', true); bot.setControlState('sprint', true) }
        await bot.waitForTicks(10)
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
