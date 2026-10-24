'use strict'
import type { Session } from '../session'
import * as gameClock from '../game-clock'
import mineflayer = require('mineflayer')
import * as tickPlugins from '../tick-plugins'
import mcDataLoader = require('minecraft-data')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { xyz, pathKeepAlive } from '../movement'
import combat = require('../combat')
import { withTimeout } from '../build'
import * as gamedata from '../gamedata'
import * as worlds from '../worlds'
import * as edges from '../edges'
import * as blockmoves from '../blockmoves'
import rideMod = require('../ride')
import { steerIntoDig } from './shared'
const { pathfinder } = tickPlugins

function connect (this: Session, { bootstrapPaused }: any = {}): Promise<any> {
    if (bootstrapPaused !== undefined) {
      if (typeof bootstrapPaused !== 'boolean') throw new TypeError('bootstrapPaused must be boolean')
      this.bootstrapPaused = bootstrapPaused
    }
    if (this.connecting) return this.connecting
    if (this.bot && this.bot.entity) return Promise.resolve({ already: true, state: this.state() })

    this.connecting = new Promise((resolve, reject) => {
      const bot = mineflayer.createBot({
        host: this.cfg.host,
        port: this.cfg.port,
        username: this.cfg.username,
        version: this.cfg.version,
        auth: this.cfg.auth,
        plugins: tickPlugins.plugins,
        hideErrors: false,
        // ND_RESPAWN_MS (арена 10.10: «не вижу, как боты умирают — сразу в зрители»): не возрождаться сразу — тело лежит
        // ND_RESPAWN_MS (анимация смерти видна всем), потом запрос возрождения (respawnNudge с этим периодом).
        respawn: !(Number(process.env.ND_RESPAWN_MS) > 0)
      })
      this.bot = bot
      gameClock.bind(bot)
      // Autopilot starts before connect. Replace its initial wall timer with
      // this connection's game timer, also on every reconnect.
      this.autopilot?.stop()
      this.autopilot?.start()
      this.wireHealth(bot)
      bot.ndPlayPolicy = this.playPolicy
      ;(require('../client-loaded') as typeof import('../client-loaded')).install(bot)
      // Поправка данных игры до первого блока: у руд и обсидиана не тот
      // материал, и копка шла в 6-8 раз дольше ванильной (gamedata.js).
      gamedata.fixMaterials(bot.registry)
      bot.once('inject_allowed', () => { gamedata.fixMaterials(bot.registry) })
      // Доски из ободранного бревна и древесины — рецепт из тега (gamedata.js).
      bot.once('inject_allowed', () => { try { gamedata.fixPlanks(bot.registry); gamedata.fixWhiteWool(bot.registry) } catch {} })
      // Имена атрибутов в пакете (скорость и прочее) — gamedata.js.
      bot.once('inject_allowed', () => { try { gamedata.fixAttributes(bot) } catch {} })
      bot.once('inject_allowed', () => { try { gamedata.fixBreath(bot) } catch {} })
      // Луч с NaN/бесконечностью (скорость тела NaN) — вечный цикл RaycastIterator: сравнения с NaN ложны, дистанция не
      // кончается (бой роя 24.10: демон крутил pearlOut → throw.landing → raycast 70 минут, тело стояло). Мир заново
      // создаётся при смене измерения — обёртка на каждом spawn.
      bot.on('spawn', () => {
        const w: any = bot.world
        if (!w || w._ndRayGuard) return
        const ray = w.raycast.bind(w); w._ndRayGuard = true
        const ok = (v: any) => v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
        w.raycast = (from: any, dir: any, range: number, match?: any) => ok(from) && ok(dir) && Number.isFinite(range) ? ray(from, dir, range, match) : null
      })
      if (process.env.ND_SLIME_SIZE === '1') bot.once('inject_allowed', () => { try { gamedata.fixSlimeSize(bot) } catch {} })
      bot.loadPlugin(pathfinder)

      let settled = false
      const fail = (err) => {
        if (settled) return
        settled = true
        if (this.bot === bot) this.bot = null
        reject(err)
      }

      bot.once('spawn', async () => {
        if (settled) return
        try {
          try { if (bot.physics) bot.physics.playerHalfWidth = Math.fround(0.6) / 2 } catch {}
          ;(require('../swimming') as typeof import('../swimming')).install(bot)
          // Предметы на земле: скорость из пакета появления и физика полёта (drops.js) —
          // иначе брошенное видно в точке броска до секунды.
          try { (require('../drops') as typeof import('../drops')).install(bot) } catch {}
          // Рюкзак после окон сверяется с сервером (invsync.js): иначе верстак,
          // кирка и прочее «пропадают» у клиента, оставаясь у сервера.
          try { (require('../invsync') as typeof import('../invsync')).install(bot) } catch {}
          // Сколько секунд куча после смерти реально тикала (lootclock.js).
          try { (require('../lootclock') as typeof import('../lootclock')).install(this) } catch {}
          // Кровать-точка возрождения: сервер сбросил — забыть (bedtime.js).
          try { (require('../bedtime') as typeof import('../bedtime')).install(this) } catch {}
          // Постройки игры глазами раз в 8 с → память и structure_seen (structures.js).
          try { (require('../structures') as typeof import('../structures')).install(this) } catch {}
          // Глаза + память увиденного и слух (perception/, S10; ND_EYES=0 — без обхода глаз).
          try { (require('../perception/eyes') as typeof import('../perception/eyes')).install(this); ;(require('../perception/senses') as typeof import('../perception/senses')).installHearing(bot) } catch {}
          // Шар гаста отбивается из любого дела, а не только в четырёх навыках Ада (ne-guard.swatInstall; b6 14.10: сброс
          // шаром — 3 смерти из 9, в том числе на ожидании и ходьбе к бастиону).
          try { (require('../ne-guard') as typeof import('../ne-guard')).swatInstall(bot) } catch {}
          // Искажённый лес Ада глазами (нилий в прорисовке + луч) → память «искажённый лес (ад)» (S1e, nether-forest.js).
          try { (require('../nether-forest') as typeof import('../nether-forest')).install(this) } catch {}
          // Слез / сброшен / телепортирован из седла — mineflayer этого не видит
          // (ride.js patchVehicle): без правки bot.vehicle висит вечно.
          try { rideMod.patchVehicle(bot) } catch {}
          this.mcData = mcDataLoader(bot.version)
          this.updateMovements(true)
          this.watchDrop()
          this.wire()
          this.tactics.attach(bot)
          await withTimeout(bot.waitForChunksToLoad(), 12000, 'чанки вокруг игрока не загрузились — вход не готов', gameClock.wall)
          await this.waitUntilWorldLoaded(10000)
          if (settled || this.bot !== bot) return
          this.journal.append('вход', `зашёл на сервер как ${bot.username} (${bot.version})`, bot.entity.position)
          settled = true
          resolve({ ok: true, state: this.state() })
        } catch (err) {
          fail(err)
          try { bot.quit('вход не готов') } catch {}
        }
      })
      bot.once('error', fail)
      bot.once('kicked', reason => fail(new Error('kicked: ' + JSON.stringify(reason))))
      bot.once('end', reason => fail(new Error('вход прерван: ' + String(reason))))
    }).finally(() => { this.connecting = null })

    return this.connecting
}

function noteDeathCause (this: Session): void {
    const d = this.lastDeath
    const c = this.pendingCause
    if (!d || !c || d.causeNoted || Math.abs(d.at - c.at) > 5000) return
    // Строка о себе, но не всякая — только о смерти (death.* в en_us).
    if (!/died|slain|shot|blew up|fell|burn|lava|drown|suffocat|killed|pricked|froze|starved|withered|impaled|squashed|fireball|flames|hit the ground|swim|struck|walked into|squished|poked|skewered|obliterated|experienced kinetic/i.test(c.text)) return
    d.causeNoted = true
    try {
      this.journal.patch(s => {
        const rec = s.deaths && s.deaths[s.deaths.length - 1]
        if (rec && !rec.cause) rec.cause = c.text
        if (/lava/i.test(c.text) && d.pos && (d.dimension || 'overworld') === 'overworld') {
          s.places = s.places || {}
          if (!s.places['лава']) s.places['лава'] = { x: d.pos.x, y: d.pos.y, z: d.pos.z, dimension: 'overworld', note: `сгорел тут: ${c.text}` }
        }
      })
    } catch {}
}

// Blocks until the column we are standing in is actually readable, so the
// first observe() after connect returns real terrain instead of nulls.
async function waitUntilWorldLoaded (this: Session, timeoutMs = 10000): Promise<boolean> {
    const bot = this.bot
    const deadline = gameClock.wall.now() + timeoutMs
    while (gameClock.wall.now() < deadline) {
      try {
        const feet = bot.blockAt(bot.entity.position.offset(0, -1, 0))
        if (feet && (bot.health ?? 0) > 0) return true
      } catch {}
      await gameClock.wall.sleep(200)
    }
    return false
}

function disconnect (this: Session, reason = 'по команде'): { ok: boolean } {
    this.cancel()
    this.bootstrapPaused = false
    if (this.bot) {
      this.journal.append('выход', reason, this.bot.entity && this.bot.entity.position)
      try { this.bot.quit(reason) } catch {}
      this.bot = null
    }
    return { ok: true }
}

function wireHealth (this: Session, bot): void {
    if (bot.ndHealthTracked) return
    bot.ndHealthTracked = true
    let hit = null
    try {
      bot._client.on('damage_event', pk => {
        if (this.bot !== bot || !bot.entity || !pk || pk.entityId !== bot.entity.id) return
        const src = pk.sourceCauseId > 0 && bot.entities ? bot.entities[pk.sourceCauseId - 1] : null
        hit = { cause: gamedata.damageTypeName(pk.sourceTypeId) || `type_${pk.sourceTypeId}`, source: src ? (src.username || src.name) : null, at: gameClock.now(), body: gamedata.bodySnapshot(bot) }
      })
    } catch {}
    // Mineflayer starts with hp20 before the first server update. That first
    // value is saved state, not an attack; track it before spawn as well.
    let last = null
    bot.on('health', () => {
      if (this.bot !== bot) return
      const hp = bot.health ?? 20
      if (last !== null && hp < last) {
        const typed = hit && gameClock.now() - hit.at <= 250 ? hit : null
        if (typed) hit = null
        // Принятый урон падения спуска (navigation/descent.ts, гибкость): не рвать им goto.
        const planned = bot._ndExpectFall && gameClock.now() < bot._ndExpectFall.until && last - hp <= bot._ndExpectFall.max && (!typed || typed.cause === 'fall')
        // Журнал урона (разбор смертей 15.10: «откуда 20 → 7 на 2-й минуте» не восстанавливался): причина, кто, что делал, где.
        if (process.env.ND_HURT_LOG !== '0') { const p = bot.entity?.position; console.log('[hurt] ' + JSON.stringify({ lost: Math.round((last - hp) * 10) / 10, hp: Math.round(hp * 10) / 10, cause: typed?.cause || null, by: typed?.source || null, doing: this.current?.name || null, at: p ? [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)] : null, t: Math.round(gameClock.now() / 1000), body: gamedata.bodySnapshot(bot, hp <= 0), hitBody: typed?.body })) }
        if (planned) console.log('[descent] принятый урон падения', JSON.stringify({ lost: last - hp, hp }))
        else this.bus.emit('damage', { health: Math.round(hp), lost: Math.round(last - hp), ...(typed ? { cause: typed.cause, ...(typed.source ? { source: typed.source } : {}) } : {}) })
      }
      if (last !== null && hp > 0 && hp <= this.cfg.lowHealth && last > this.cfg.lowHealth) {
        this.bus.emit('low_health', { health: Math.round(hp) })
      }
      last = hp
      this.lastHealth = hp
      // The initial dead state must still request respawn after the server
      // starts accepting client commands.
      if (hp <= 0 && !this.respawnNudge) {
        this.respawnNudge = gameClock.wall.setInterval(() => {
          if (this.bot !== bot || (bot.health ?? 20) > 0) { gameClock.wall.clearInterval(this.respawnNudge); this.respawnNudge = null; return }
          try { bot._client.write('client_command', bot.supportFeature('respawnIsPayload') ? { payload: 0 } : { actionId: 0 }) } catch {}
        }, Number(process.env.ND_RESPAWN_MS) > 0 ? Number(process.env.ND_RESPAWN_MS) : 3000)
      }
    })
}

function wire (this: Session): void {
    const bot = this.bot
    this.wireHealth(bot)

    combat.trackAttackers(this)

    // В каком мире тело: событие dimension на «устроился», чистка сущностей
    // прошлого мира (worlds.js).
    worlds.installWorldTracker(this, bot)

    // Physics heartbeat. A frozen body and a body with no path look identical
    // from the outside; the tick rate tells them apart.
    this.ticks = 0
    bot.on('physicsTick', () => {
      this.ticks++; bot._ndPhysicsTicks = this.ticks
      const e = bot.entity, trail = bot._ndBodyTrail ||= []
      if (e?.position && e.velocity) trail.push([bot.ndClock?.ticks ?? null, e.position.x, e.position.y, e.position.z, e.velocity.x, e.velocity.y, e.velocity.z, !!e.onGround, bot.oxygenLevel ?? null])
      if (trail.length > 40) trail.shift()
    })
    bot.on('respawn', () => { bot._ndBodyTrail = [] })
    // Падение в выкопанную клетку перед следующей копкой — не проезжать её (steerIntoDig выше). Узлы — живой массив
    // pathfinder'а (path_update отдаёт тот же массив, что он сдвигает по ходу).
    bot.on('physicsTick', () => {
      try {
        const nodes = this.pathNodes
        if (!nodes || !nodes.length || !bot.pathfinder || !bot.pathfinder.isMoving()) return
        const c = steerIntoDig(bot.entity, nodes[0])
        if (!c) return
        bot.look(c.yaw, bot.entity.pitch, true).catch(() => {})
        bot.setControlState('sprint', false)
        bot.setControlState('jump', false)
        bot.setControlState('back', false)
        bot.setControlState('left', false)
        bot.setControlState('right', false)
        bot.setControlState('forward', c.forward)
        if (!this.steerSaid || gameClock.now() - this.steerSaid > 5000) { this.steerSaid = gameClock.now(); console.log('[path] в воздухе перед копкой — веду в колонну узла', JSON.stringify({ at: nodes[0].x + ',' + nodes[0].y + ',' + nodes[0].z })) }
      } catch {}
    })

    // Ведро воды при падении с высоты — всегда, не только в бою (edges.js):
    // с арены в небе бот падал на землю и разбивался (2026-09-25).
    edges.installFallGuard(this)
    // Исполнитель моста на ходу — после сторожа падения (общая рука lockHand; сорвался — клатч раньше нас в тике).
    if (blockmoves.on()) blockmoves.install(this)
    // Своё отбрасывание — в полную силу, как у игрока (mineflayer делил его
    // на 8000: бот стоял под ударами как вкопанный, edges.fixSelfKnockback).
    edges.fixSelfKnockback(bot)
    // Предмет в ходу (еда, питьё, лук, щит) — ход ×0.2 и без спринта, как у
    // ванильного клиента (itemuse.js, просьба 2026-09-26 играть честно).
    ;(require('../itemuse') as typeof import('../itemuse')).install(bot)
    // Копать только самым быстрым инструментом (tools.js install): паутину —
    // мечом, а не булыжником в руке после столба (арена 2026-09-26).
    ;(require('../tools') as typeof import('../tools')).install(bot)
    // Не смотреть эндермену в глаза между делом (gaze.ts): взгляд вперёд на ходу злил их (cl-al 14.10).
    ;(require('../gaze') as typeof import('../gaze')).install(this, bot)
    // По магме — крадучись (careful.ts): присевшего она не жжёт, тактика не рвёт путь к сундуку руин.
    ;(require('../careful') as typeof import('../careful')).install(this, bot)
    // Удар только по тому, что клиент игры взял бы в прицел (pick.js): сервер
    // прямую видимость не проверяет, и боты били сквозь стенку коробки.
    ;(require('../pick') as typeof import('../pick')).install(bot)
    // Титры после выходного портала — всегда ответ perform_respawn (credits.ts): иначе игрок вне мира, часы стоят.
    ;(require('../credits') as typeof import('../credits')).install(bot)
    // Бег вприпрыжку на прямых ровных участках пути (sprintjump.js; по умолчанию вкл., ND_SPRINT_JUMP=0 — выкл.).
    try { (require('../sprintjump') as typeof import('../sprintjump')).install(bot) } catch {}
    // Свет чанков — со своей перестановкой x (prismarine-chunk 1.41, lightfix.js).
    ;(require('../lightfix') as typeof import('../lightfix')).install(bot)
    // Часы удара и фильтр ходов с NaN (melee.install) — сразу, а не с первым боем: без боя тело слало ход с NaN, и Paper
    // выкидывал «Invalid move player packet received» (бой роя 24.10: 30u, 30r).
    ;(require('../melee') as typeof import('../melee')).install(bot)
    // Заряженный арбалет — только прицельным выстрелом (ranged.guardCrossbow).
    ;(require('../ranged') as typeof import('../ranged')).guardCrossbow(bot)
    // Install after tool/pick wrappers; attach for ALL intents, including gold,
    // pearls, ne_route/ne_burrow and crafting, not just bastion/farmRods callers.
    if ((require('../reflex-lock') as typeof import('../reflex-lock')).on()) (require('../ne-guard') as typeof import('../ne-guard')).attach(this)
    bot.on('nd_mlg', (e) => console.log('[mlg]', JSON.stringify({ ...e, y: bot.entity && Math.round(bot.entity.position.y * 10) / 10, hp: bot.health })))

    // Рюкзак полон (pack.js через collectNearbyDrops): выбросил дешёвое ради
    // дорогого — факт; выбросить нечего — мозгу решать про схрон.
    bot.on('nd_tossed', (e) => this.bus.emit('tossed', e))
    bot.on('nd_bag_full', (e) => {
      const now = gameClock.now()
      if (this.bagFullSaid && now - this.bagFullSaid < 20000) return
      this.bagFullSaid = now
      this.bus.emit('bag_full', { ...e, text: `РЮКЗАК ПОЛОН: ${e.item}×${e.count} лежит на ${e.at.x},${e.at.y},${e.at.z}, а выкинуть дешевле нечего — поставь схрон (mc_cache) или разгрузись (mc_pack tidy)` })
    })

    bot.on('chat', (username, message, translate) => {
      if (username === bot.username) return
      if (translate === 'chat.type.admin') return
      this.bus.emit('chat', { from: username, text: message })
      this.journal.append('чат', `<${username}> ${message}`, bot.entity && bot.entity.position)
    })

    bot.on('whisper', (username, message) => {
      if (username === bot.username) return
      this.bus.emit('chat', { from: username, text: message, whisper: true })
    })

    // Возрождение: флаг копки pathfinder'а, оставшийся от копки до смерти, вешал все goto («застрял на air у air»,
    // isMining() навсегда — регрессия спуска 30.09). tools.install обрывает такую копку; здесь — страховка.
    bot.on('spawn', () => {
      if ((require('../tools') as typeof import('../tools')).unstickPathfinderDig(bot)) console.log('[path] флаг копки после смерти сброшен')
    })
    bot.on('death', () => {
      const pos = bot.entity ? xyz(bot.entity.position) : null
      this.bus.emit('death', { pos })
      this.journal.patch(s => {
        let bag = null
        try { bag = bot.inventory.items().map(i => ({ name: i.name, count: i.count })) } catch {}
        s.deaths.push({ at: new Date().toISOString(), pos, dimension: worlds.worldOf(bot), recovered: false, bag: bag || undefined })
        if (s.deaths.length > 50) s.deaths.splice(0, s.deaths.length - 50)
      })
      this.journal.append('смерть', `умер${pos ? '' : ' (координаты неизвестны)'}`, bot.entity && bot.entity.position)
      this.lastDeath = { at: gameClock.now(), pos, dimension: worlds.worldOf(bot) }
      this.noteDeathCause()
    })
    // Причина смерти — строка сервера «NeuroRun tried to swim in lava»; она
    // приходит рядом с update_health, раньше или позже него.
    bot.on('messagestr', (msg) => {
      const t = String(msg || '')
      if (!t.startsWith(bot.username + ' ') || t.length > 160) return
      this.pendingCause = { text: t, at: gameClock.now() }
      this.noteDeathCause()
    })

    bot.on('playerJoined', p => {
      if (p.username !== bot.username) this.bus.emit('player_joined', { username: p.username })
    })
    bot.on('playerLeft', p => this.bus.emit('player_left', { username: p.username }))

    bot.on('kicked', reason => {
      if (this.bot !== bot) return
      this.bus.emit('kicked', { reason: JSON.stringify(reason) })
      this.bot = null
    })
    bot.on('end', reason => {
      if (this.bot !== bot) return
      this.bus.emit('disconnected', { reason: String(reason) })
      this.bot = null
    })
    bot.on('error', err => {
      console.error('[bot error]', err && err.stack ? err.stack : String(err))
      this.bus.emit('error_event', { error: String((err && err.message) || err) })
    })

    // Узел-метка на ходу, пока поиск идёт: иначе pathfinder сбрасывает путь «stuck» через 3.5 с поиска, хотя тело
    // бежит по нему (movement.pathKeepAlive; ND_PATH_KEEPALIVE=0 — выкл.).
    this.pathKeep = pathKeepAlive(bot)
    // Pathfinder diagnostics. A goal that silently never moves the bot is the
    // hardest failure to read from the outside, so keep the raw search result.
    bot.on('path_update', r => {
      this.notePath(r)
      console.log('[path]', JSON.stringify(this.lastPath))
      // Отладка спуска (регрессия 30.09): узлы пути с копкой/стройкой — ND_DEBUG_PATH=1.
      if (process.env.ND_DEBUG_PATH && r.path && r.path.length) {
        const me = bot.entity ? bot.entity.position.floored() : null
        console.log('[path] nodes', JSON.stringify({ me, drop: bot.pathfinder.movements && bot.pathfinder.movements.maxDropDown,
          nodes: r.path.slice(0, 14).map(n => `${n.x},${n.y},${n.z}${n.toBreak && n.toBreak.length ? ' b' + n.toBreak.length : ''}${n.toPlace && n.toPlace.length ? ' p' + n.toPlace.length : ''}${n.ndBridge ? ' M' : ''}${n.ndDescend ? ' S' : ''}${n.parkour ? ' J' : ''}`) }))
      }
    })
    bot.on('goal_reached', () => console.log('[path] goal_reached'))
    bot.on('path_reset', reason => {
      console.log('[path] reset:', reason)
      // «stuck» — 3.5 с без нового узла: где тело и на каком узле встало (рельеф, mv-spr: несколько на ногу). Путь ещё
      // живой (resetPath шлёт событие до path = []).
      if (reason === 'stuck') {
        // Застрял на узле — его клетки на 30 с дороже для поиска: новый путь идёт в обход, а не той же ступенью под навесом
        // (колизей 10.10: «прыгают на месте, ставя блоки» — 18 перестроек к узлу 2 бл. выше тела, потолок над прыжком).
        try { for (const q of (Array.isArray(this.pathNodes) ? this.pathNodes.slice(0, 2) : [])) (this.stuckCells ||= new Map()).set(`${Math.floor(q.x)},${Math.floor(q.y)},${Math.floor(q.z)}`, gameClock.now() + 30000); this.updateMovements(true) } catch {}
        try {
          const e = bot.entity
          const n = Array.isArray(this.pathNodes) ? this.pathNodes.slice(0, 2) : []
          const nm = (x, y, z) => { const b = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))); return b ? b.name : '?' }
          console.log('[stuck-node]', JSON.stringify({ pos: [e.position.x, e.position.y, e.position.z].map(v => Math.round(v * 100) / 100), g: e.onGround, w: !!e.isInWater,
            v: [e.velocity.x, e.velocity.y, e.velocity.z].map(v => Math.round(v * 100) / 100),
            nodes: n.map(q => ({ at: [q.x, q.y, q.z], b: q.toBreak ? q.toBreak.length : 0, p: q.toPlace ? q.toPlace.length : 0, j: !!q.parkour, br: !!q.ndBridge, d: !!q.ndDescend,
              feet: nm(q.x, q.y, q.z), head: nm(q.x, q.y + 1, q.z), under: nm(q.x, q.y - 1, q.z) })),
            c: ['forward', 'back', 'jump', 'sprint', 'sneak'].filter(k => bot.getControlState(k)) }))
        } catch {}
      }
    })
}

export { connect, noteDeathCause, waitUntilWorldLoaded, disconnect, wireHealth, wire }
