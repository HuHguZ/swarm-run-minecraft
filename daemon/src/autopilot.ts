'use strict'
const gameClock = require('./game-clock')
const { escapeWater, inWater, sleep } = require('./movement')
const {
  equipBestTool, missingHarvestTool, toolPlan, toolBudget, itemNamed, plankCount
} = require('./items')
const { withTimeout } = require('./build')
const { HOSTILES, retreat, nearestHostile } = require('./combat')
const lootMod = require('./loot')
const { equipBestArmor } = require('./armor')
const { eat, craft, place, bestFood, RISKY_FOOD } = require('./actions')
const social = require('./social')
const gestures = require('./gestures')
const survival = require('./combat-safety')

// Сырое, у чего в печи есть жареная пара (рецепты smelting 1.21.11:
// beef, porkchop, mutton, chicken, rabbit, cod, salmon, potato).
const COOKABLE = /^(beef|porkchop|mutton|chicken|rabbit|cod|salmon|potato)$/

// Номер урона in_wall (удушье в блоке) в реестре damage_type 1.21.11 — реестр по
const IN_WALL_DAMAGE = 22

const SELF_GUARDED = new Set([
  'fight', 'retaliate', 'defend', // бой (pvp.js): крепость, отход, лечение — свои
  // shelter (нора) — не здесь: её копка 8–15 с, урон её не рвёт, и под мобом тело теряло 14 хп за копку (разбор
  // смертей fresh-A1..A4: 17 из 98 — в норе у бьющего моба). Отход (коробка/бег) эту копку перехватывает.
  'flee', 'refuge', 'escape_fire', 'sleep', // уже уходит
  'blaze', 'pearls', 'bastion', 'nether_tunnel', // долгие дела Ада со своей защитой (штрек, окоп, яма)
  'dragon'
])
// Урон, за которым стоит моб (тип damage_event 1.21.11, gamedata.DAMAGE_TYPES).
const MOB_DAMAGE = /^(mob_attack|mob_attack_no_aggro|arrow|mob_projectile|player_attack|trident|sting|spit|fireball|unattributed_fireball|explosion|player_explosion|wither_skull|sonic_boom|thrown|indirect_magic|spear|mace_smash|wind_charge)$/
const EMERGENCY = {
  // Не чаще раза в 30 с от начала прошлого отхода (он сам длится 15–120 с);
  // дребезг без лечения отсекает взвод на 16 хп.
  cooldownMs: 30000,
  // Гистерезис: после отхода ветка снова взводится, только когда хп
  // поднялось до 16 (там же refuge считает «вылечился»).
  rearmHp: 16,
  // Нижняя граница порога отхода (lowHealth для combat-safety.inspect): см. emergency().
  minHp: 12,
  mobHurtMs: 15000,
  contact: 8,
  // Ходячий дойдёт, если он на нашем уровне (±4) и не дальше 12 бл.
  walkDy: 4,
  walkDist: 12
}

// отбежать (survival.dodgeCreeper). Механика 1.21.11 (Creeper.SwellGoal): шипеть начинает с < 3 бл., гаснет дальше
const CREEPER = { swellDist: 7, closeDist: 3.3, cooldownMs: 2500, everyTicks: 2 }
// Дела, которые урон не рвёт (session.js HOLDING): у печи, верстака, сундука тело стоит и не отвечает.
const HOLD_INTENTS = new Set(['smelt', 'craft', 'chest_put', 'chest_take', 'pack', 'sort', 'stash', 'enchant', 'brew', 'cook'])
// Эти сами отвечают за крипера (бой pvp.js — удар и отход) или уже уходят.
const CREEPER_GUARDED = new Set(['fight', 'retaliate', 'defend', 'flee', 'refuge', 'escape_fire', 'dragon'])
// flee — один раз, не require() на каждый тик у крипера (S9).
let fleeMod
const fleeLazy = () => fleeMod || (fleeMod = require('./flee'))
let fightkitMod
const fightkitLazy = () => fightkitMod || (fightkitMod = require('./fightkit'))
function creeperNeed (bot) {
  if (!bot.entity || (bot.health ?? 0) <= 0) return null
  const gm = bot.game && bot.game.gameMode
  if (gm === 'creative' || gm === 'spectator') return null
  const me = bot.entity.position
  let best = null
  for (const e of (Object.values(bot.entities || {}) as any)) {
    if (!e || e.name !== 'creeper' || !e.position || e.isValid === false) continue
    const d = e.position.distanceTo(me)
    if (d > CREEPER.swellDist) continue
    let swelling = false
    try { swelling = fleeLazy().creeperSwelling(bot, e) } catch {}
    if (!swelling && d > CREEPER.closeDist) continue
    // Шипящий в зоне урона (≤ 5 бл.: normal 43/16.75/5.1 на 0/3/5 бл., MOBS.md) — раньше ближнего нешипящего (ревью Codex
    // surv-camp-deaths 02.10); дальше 5 шипящий бьёт ~1 хп — тогда ближний (он вот-вот зашипит вплотную).
    const hot = x => x.swelling && x.d <= 5
    const cand = { e, d, swelling }
    if (!best || (hot(cand) && !hot(best)) || (hot(cand) === hot(best) && d < best.d)) best = cand
  }
  return best
}

// Имя типа урона по номеру: одна копия реестра в gamedata (dev-A, H1); пока её
// нет — та же таблица боя (dragon.DAMAGE_TYPES, тест сверяет номер in_wall).
function damageTypeName (id) {
  try { const g = require('./gamedata'); if (typeof g.damageTypeName === 'function') return g.damageTypeName(id) } catch {}
  try { return require('./dragon').DAMAGE_TYPES[id] || null } catch { return null }
}

// Нужен ли отход прямо сейчас. Чистая функция по телу и последнему урону:
// null — нет, иначе { hp, threshold, from, dist, why }.
function emergencyNeed (bot, { lastHurt = null, lowHealth = 8, now = gameClock.now() }: any = {}) {
  const hp = bot.health ?? 20
  if (!bot.entity || hp <= 0 || hp >= EMERGENCY.rearmHp) return null
  // Горим или в лаве — это огонь, не моб: тушение и огнестойкость (fightkit,
  // extinguish), escape_fire кампании.
  let burning = false
  try { burning = !!bot.entity.isInLava || (bot.entity.metadata && (bot.entity.metadata[0] & 0x01) !== 0) } catch {}
  if (burning) return null
  const mobHurt = !!(lastHurt && lastHurt.byMob && now - lastHurt.at < EMERGENCY.mobHurtMs)
  let safety
  try { safety = survival.inspect(bot, { minHealth: lowHealth }) } catch { return null }
  if (!safety || safety.action === 'dead' || !safety.threats.length || hp > safety.threshold) return null
  const DOC = require('./flee').DOCTRINE
  const me = bot.entity.position
  const reach = []
  for (const t of safety.threats) {
    if (t.anticipated) continue
    const e = bot.entities && bot.entities[t.id]
    if (!e || !e.position) continue
    const doc = DOC[e.name] || {}
    const shoots = doc.range && t.distance <= doc.range
    const walks = doc.radius > 0 && Math.abs(e.position.y - me.y) <= EMERGENCY.walkDy && t.distance <= EMERGENCY.walkDist
    if (shoots || walks) reach.push({ e, t })
  }
  if (!reach.length) return null
  reach.sort((a, b) => a.t.distance - b.t.distance)
  const first = reach[0]
  // Контакт: ходячий вплотную или стрелок, который нас видит и достаёт (inspect
  // берёт только тех, кто в прямой видимости) — следующий размен уже идёт.
  const contact = first.t.distance <= EMERGENCY.contact ||
    reach.some(x => (DOC[x.e.name] || {}).range >= x.t.distance)
  // Хп ушло не от моба (голод, падение, огонь) и моб ещё не рядом — не повод.
  if (!mobHurt && !contact) return null
  return {
    hp: Math.round(hp),
    threshold: safety.threshold,
    from: first.e.name,
    dist: Math.round(first.t.distance * 10) / 10,
    foes: reach.length,
    why: mobHurt ? `бьёт ${lastHurt.source || first.e.name} (${lastHurt.type})` : `${first.e.name} в ${Math.round(first.t.distance)} бл.`
  }
}

class Autopilot {
  declare session: any
  declare cfg: any
  declare busy: any
  declare lastPhase: any
  declare timer: any
  declare refuging: any
  declare temperBot: any
  declare grudges: any
  declare damageBot: any
  declare damageDimension: string | undefined
  declare inWallAt: any
  declare emergencyArmed: any
  declare lastHurt: any
  declare dodging: any
  declare lootRunning: any
  declare lootScanAt: any
  declare lootAnnounced: any
  declare stuck: any
  declare wetSince: any
  declare announced: any
  declare creeperBot: any
  declare freeing: any
  declare dodgeAt: any
  declare emergencyAt: any
  declare lastHp: any
  declare buriedSince: any
  declare dugTotal: any
  declare buriedSaidAt: any
  declare fleeing: any
  declare lastQuickArmor: any
  declare lastArmorCheck: any
  declare toolCheckAt: any
  declare toolSig: any
  declare toolSaid: any
  declare toolSaidAt: any
  declare toolFails: any
  declare toolNextTry: any
  declare lastBeat: any
  declare lastTicks: any

  constructor (session, cfg) {
    this.session = session
    this.cfg = cfg
    this.busy = false
    this.lastPhase = null
    this.timer = null
  }

  start () {
    if (this.timer) return
    this.timer = gameClock.setInterval(() => { this.tick().catch(() => {}) }, 1000)
  }

  stop () {
    if (this.timer) gameClock.clearInterval(this.timer)
    this.timer = null
  }

  bodyBusy () {
    const cur = this.session.current
    return !!((cur && cur.name !== 'wait') || this.refuging || this.session.reflex)
  }

  hookTemper (bot) {
    if (this.temperBot === bot) return
    this.temperBot = bot
    this.grudges = new Map()
    bot.on('entityHurt', (victim, source) => {
      if (victim !== bot.entity || !source || !social.isPlayerEntity(source)) return
      const name = source.username
      if (!name || name === bot.username) return
      this.provoked(name)
    })
  }

  // Когда нас последний раз душило в блоке (damage_event с in_wall). Нужен одному
  // правилу: во время боя с драконом брать управление только при удушье.
  hookDamage (bot) {
    if (this.damageBot === bot || !bot._client) return
    this.damageBot = bot
    this.inWallAt = 0
    this.lastHurt = null
    this.damageDimension = String(bot.game?.dimension || '')
    bot.on?.('respawn', () => this.syncDamageContext(bot))
    bot.on?.('game', () => this.syncDamageContext(bot))
    // Гистерезис EMERGENCY: снова взводится, как только хп дошло до 16 — по
    let lastHp = bot.health ?? 20
    if (typeof bot.on === 'function') {
      bot.on('health', () => {
        const hp = bot.health ?? 0
        if (hp >= EMERGENCY.rearmHp) this.emergencyArmed = true
        if (hp < lastHp && hp > 0 && hp < EMERGENCY.rearmHp) setImmediate(() => { this.emergency(bot).catch(() => {}) })
        lastHp = hp
      })
    }
    bot._client.on('damage_event', pk => {
      if (!bot.entity || !pk || pk.entityId !== bot.entity.id) return
      this.syncDamageContext(bot)
      if (pk.sourceTypeId === IN_WALL_DAMAGE) this.inWallAt = gameClock.now()
      // Кто и чем ударил последним — для EMERGENCY (моб или не моб).
      const type = damageTypeName(pk.sourceTypeId) || `type_${pk.sourceTypeId}`
      const src = pk.sourceCauseId > 0 && bot.entities ? bot.entities[pk.sourceCauseId - 1] : null
      const byMob = MOB_DAMAGE.test(type) || !!(src && src !== bot.entity && src.name && src.name !== 'player' && !src.username)
      this.lastHurt = { at: gameClock.now(), type, byMob, source: src ? (src.username || src.name) : null, sourceId: src && src !== bot.entity ? src.id : null, dimension: String(bot.game?.dimension || '') }
      if (byMob && process.env.ND_HURT_WAKE === '1' && !this.refuging && !this.dodging) {
        const cur = this.session.current
        if (cur && HOLD_INTENTS.has(cur.name)) {
          const ev = this.session.bus.emit('damage', { health: Math.round(bot.health ?? 0), cause: type, source: src ? (src.username || src.name) : undefined, woke: cur.name })
          this.interruptFor(ev)
          this.takeTheMouth(bot).catch(() => {})
        }
      }
    })
  }

  syncDamageContext (bot) {
    const dimension = String(bot.game?.dimension || '')
    const preparation = /^(creative|spectator)$/.test(bot.game?.gameMode || '')
    const changed = this.damageDimension !== undefined && this.damageDimension !== dimension
    const stale = this.lastHurt?.dimension !== undefined && this.lastHurt.dimension !== dimension
    if (preparation || stale || changed && this.lastHurt?.dimension !== dimension) this.lastHurt = null
    if (preparation || changed) this.inWallAt = 0
    this.damageDimension = dimension
  }

  provoked (name) {
    if (this.session.playPolicy?.mode === 'speedrun') return
    const t = this.session.temper
    if (!t || !t.enabled) return
    const cur = this.session.current
    // Уже в бою с кем-то: второго бой pvp.js видит сам (разворот на того,
    // кто бьёт в спину), новый retaliate только засорял события «ДЕРУСЬ».
    if (cur && cur.name === 'retaliate') return
    // Мозг сам дерётся с ним же — не мешать.
    if (cur && cur.name === 'fight') return
    const now = gameClock.now()
    const rec = this.grudges.get(name) || { hits: [] }
    rec.hits = rec.hits.filter(at => now - at < t.windowMs)
    rec.hits.push(now)
    this.grudges.set(name, rec)
    const n = rec.hits.length
    const answer = n >= 2 || Math.random() < t.firstHitChance
    this.session.bus.emit('provoked', {
      name,
      hits: n,
      answer,
      chance: n >= 2 ? 1 : t.firstHitChance
    })
    if (answer) this.retaliate(name, n)
  }

  retaliate (name, hits) {
    const t = this.session.temper
    this.session.bus.emit('retaliating', { name, hits })
    this.session.retaliate(name, {
      timeoutSeconds: t.fightSeconds,
      calmAfterMs: t.calmAfterMs,
      retreatAtHealth: t.retreatAtHealth
    }).then(r => {
      const g = this.grudges.get(name)
      if (g) g.hits = []
      if (!r || r.already) return
      this.session.bus.emit('retaliated', {
        name,
        outcome: r.killed ? 'убил' : r.died ? 'погиб' : r.calmed ? 'остыл' : r.retreated ? 'ушёл' : r.lost ? 'потерял из виду' : r.error ? 'ошибка' : 'бой прерван',
        hp: r.hp,
        swings: r.swings,
        landed: r.landed,
        crits: r.crits,
        tricks: r.tricks,
        error: r.error
      })
    }).catch(() => {})
  }

  lootIfSeen (bot) {
    if (this.bodyBusy() || this.lootRunning || this.session.lootAuto === false) return
    const now = gameClock.now()
    if (now - (this.lootScanAt || 0) < 5000) return
    this.lootScanAt = now
    if ((bot.health ?? 20) < 12) return
    if (nearestHostile(bot, 16)) return
    let list
    try { list = lootMod.seen(this.session, { radius: 24 }) } catch { return }
    if (!this.lootAnnounced) this.lootAnnounced = new Set()
    for (const c of list) {
      const k = `${c.at.x},${c.at.y},${c.at.z}`
      if (!c.lootable && !this.lootAnnounced.has(k)) {
        this.lootAnnounced.add(k)
        this.session.bus.emit('loot_seen', c)
      }
    }
    const t = list.find(c => c.lootable)
    if (!t) return
    this.lootRunning = true
    this.session.bus.emit('looting', { kind: t.kind, guess: t.guess, at: t.at })
    this.session.autoLoot(t)
      .then(r => { if (r && !r.busy) this.session.bus.emit('looted', { guess: t.guess, at: t.at, took: r.took, stopped: r.stopped, error: r.error }) })
      .catch(() => {})
      .finally(() => { this.lootRunning = false })
  }

  async tick () {
    const bot = this.session.bot
    if (!bot || !bot.entity || this.busy) return
    this.session.tactics?.attach(bot)
    this.hookTemper(bot)
    this.hookDamage(bot)
    this.syncDamageContext(bot)
    this.hookCreeper(bot)
    // Жесты людей (присед, прыжки, взгляд, брошенный предмет) — на слушателях,
    // не в этом тике: gestures.js.
    gestures.hook(this, bot)
    this.busy = true
    try {
      await this.escapeWaterIfIdle(bot)
      await this.freeIfBuried(bot)
      if (this.stuck) { this.heartbeat(bot); return }
      // Мало хп и враг, который дойдёт, — бросить дело и в укрытие.
      await this.emergency(bot).catch(e => console.error('[emergency]', (e && e.message) || e))
      // Горю — огнестойкость; хп мало и враг рядом — золотое яблоко раньше бегства
      // (fightkit.js). Своё хранит от повторов, ошибки не наши — молча.
      await fightkitLazy().autoUse(this, bot).catch(() => {})
      await this.extinguish(bot).catch(() => {})
      await this.fleeIfDying(bot)
      await this.eatIfHungry(bot)
      await this.wearArmor(bot)
      await this.keepTools(bot)
      this.lootIfSeen(bot)
      await social.noticePlayers(this).catch(e => console.error('[social]', (e && e.message) || e))
      this.noteDayPhase(bot)
      this.heartbeat(bot)
    } finally {
      this.busy = false
    }
  }

  async extinguish (bot) {
    if (this.session.tempo) return
    let burning = false
    try { burning = (bot.entity.metadata[0] & 0x01) !== 0 } catch {}
    let fireRes = false
    try {
      const eff = bot.registry.effectsByName.fire_resistance || bot.registry.effectsByName.FireResistance
      fireRes = !!(eff && bot.entity.effects && bot.entity.effects[eff.id])
    } catch {}
    if (!burning || fireRes || inWater(bot) || bot.entity.isInWater) return
    if (/nether/.test(String((bot.game && bot.game.dimension) || ''))) return
    const wb = bot.inventory.items().find(i => i.name === 'water_bucket')
    if (wb) {
      try {
        await bot.equip(wb, 'hand')
        await bot.look(bot.entity.yaw, -Math.PI / 2, true)
        bot.activateItem()
        await sleep(400)
        const empty = bot.inventory.items().find(i => i.name === 'bucket')
        if (empty) {
          await bot.equip(empty, 'hand')
          await bot.look(bot.entity.yaw, -Math.PI / 2, true)
          bot.activateItem()
          await sleep(150)
        }
      } catch {}
      this.session.bus.emit('extinguished', { how: 'water_bucket' })
      return
    }
    const hp = bot.health ?? 20
    if (this.bodyBusy() && hp > 10) return
    const waterId = bot.registry.blocksByName.water && bot.registry.blocksByName.water.id
    if (waterId === undefined) return
    const me = bot.entity.position
    const pool = bot.findBlocks({ matching: waterId, maxDistance: 10, count: 12 }).map(v => bot.blockAt(v))
      .filter(b => b && Math.abs(b.position.y - me.y) <= 3)
      .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0]
    if (!pool) return
    const { goals } = require('mineflayer-pathfinder')
    try {
      bot.pathfinder.setGoal(new goals.GoalBlock(pool.position.x, pool.position.y, pool.position.z))
      const t0 = gameClock.now()
      while (gameClock.now() - t0 < 5000 && !bot.entity.isInWater) await sleep(100)
    } catch {}
    try { if (bot.entity.isInWater) bot.pathfinder.setGoal(null) } catch {}
    if (bot.entity.isInWater) this.session.bus.emit('extinguished', { how: 'water', at: { x: pool.position.x, y: pool.position.y, z: pool.position.z } })
  }

  // death the autopilot exists to prevent. Only runs when no intent is active,
  async escapeWaterIfIdle (bot) {
    const busy = this.bodyBusy()
    if (!inWater(bot) || busy) {
      this.wetSince = null
      return
    }
    if (!this.wetSince) { this.wetSince = gameClock.now(); return }
    if (gameClock.now() - this.wetSince < 3000) return

    this.wetSince = null
    const result = await escapeWater(bot, { aborted: false, onAbort: [] })
    if (result.wasInWater) {
      this.session.bus.emit(result.ok ? 'left_water' : 'stuck_in_water', { target: result.target || null })
    }
  }

  declare buriedBy: any

  // The column while it is in flight. Only our own square counts: gravel two
  // blocks to the side is somebody else's problem.
  declare fallingOverhead: any

  // cancelling whatever swing is in flight (digging.js:127), and that
  async takeTheMouth (bot) {
    const cur = this.session.current
    try { if (cur && cur.ctl) cur.ctl.abort() } catch {}
    try { bot.pathfinder.setGoal(null) } catch {}
    try { bot.clearControlStates() } catch {}
    try { bot.stopDigging() } catch {}
    // It may be inside equipBestTool with a swing already queued behind it;
    // mining.js:220 is the 120ms it takes to come back and see the abort.
    await sleep(200)
  }

  interruptFor (ev) {
    const bus = this.session.bus
    if (!bus || !bus.waiters) return
    for (const w of (Array.from(bus.waiters) as any)) {
      bus.waiters.delete(w)
      try { w.resolve(ev) } catch {}
    }
  }

  hookCreeper (bot) {
    if (this.creeperBot === bot || typeof bot.on !== 'function') return
    this.creeperBot = bot
    let n = 0
    bot.on('physicsTick', () => {
      if (this.session.tactics?.enabled()) return
      if (++n % CREEPER.everyTicks) return
      if (process.env.ND_CREEPER_DODGE === '0' || this.dodging || this.refuging || this.freeing) return
      if (bot !== this.session.bot) return
      let need = null
      try { need = creeperNeed(bot) } catch {}
      if (need) this.creeperReflex(bot, need).catch(e => console.error('[creeper]', (e && e.message) || e))
    })
  }

  async creeperReflex (bot, need) {
    if (this.dodging || this.refuging || this.freeing) return
    // Пауза между уклонами — не для шипящего: фитиль 30 тиков не ждёт 2.5 с (camp2 02.10: «dodge OK» → через 15 с взрыв).
    if (!need.swelling && gameClock.now() - (this.dodgeAt || 0) < CREEPER.cooldownMs) return
    const cur = this.session.current
    const busy = !!(cur && cur.name !== 'wait')
    // Бой (fight/retaliate/defend) сам отвечает за крипера-цель, но не за чужого, шипящего за спиной: шипит в зоне урона
    // (≤ 5 бл.) — бросить бой и уйти (ревью Codex surv-camp-deaths 02.10: 14 смертей от крипера, часть — посреди боя).
    const fightHot = /^(fight|retaliate|defend)$/.test(cur && cur.name) && need.swelling && need.d <= 5
    if (busy && CREEPER_GUARDED.has(cur.name) && !fightHot) return
    this.dodging = true
    this.refuging = true
    this.dodgeAt = gameClock.now()
    const t0 = gameClock.now()
    const bus = this.session.bus
    const dist = Math.round(need.d * 10) / 10
    try {
      const ev = bus.emit('emergency', { hp: Math.round(bot.health ?? 0), from: 'creeper', dist, foes: 1, kind: 'creeper',
        why: `крипер ${need.swelling ? 'шипит' : 'вплотную'} в ${dist} бл.`, during: busy ? cur.name : null })
      if (busy) this.interruptFor(ev)
      const r = await require('./survival').runDodgeCreeper(this.session, { id: need.e.id })
      const d = (r && r.detail) || {}
      console.log('[creeper]', JSON.stringify({ dist0: dist, swelling: need.swelling, during: busy ? cur.name : null, ...d }))
      bus.emit('refuge', { how: 'dodge', code: d.code || (r && r.status !== 'done' ? String(r.status).toUpperCase() : null), hp0: d.hp0, hp: d.hp ?? Math.round(bot.health ?? 0),
        healed: !!d.healed, seconds: Math.round((gameClock.now() - t0) / 1000), note: d.note, by: r && r.by ? r.by.type : undefined })
    } finally {
      this.dodging = false
      this.refuging = false
      this.dodgeAt = gameClock.now()
    }
  }

  async emergency (bot) {
    if (this.session.tactics?.enabled()) { this.session.tactics.update(true); return }
    if (this.session.reflex) return
    if (process.env.ND_EMERGENCY === '0' || this.session.emergencyOff) return
    if (!bot || !bot.entity || bot !== this.session.bot) return
    if (this.refuging || this.freeing) return
    const hp = bot.health ?? 20
    if (this.emergencyArmed === false) {
      if (hp >= EMERGENCY.rearmHp) this.emergencyArmed = true
      else return
    }
    if (gameClock.now() - (this.emergencyAt || 0) < EMERGENCY.cooldownMs) return
    const cur = this.session.current
    const busy = !!(cur && cur.name !== 'wait')
    if (busy && SELF_GUARDED.has(cur.name)) return
    const need = emergencyNeed(bot, { lastHurt: this.lastHurt, lowHealth: Math.max(EMERGENCY.minHp, this.cfg.lowHealth) })
    if (!need) return
    this.emergencyAt = gameClock.now()
    this.emergencyArmed = false
    const ev = this.session.bus.emit('emergency', { ...need, during: busy ? cur.name : null })
    if (busy) {
      this.interruptFor(ev)
      await this.takeTheMouth(bot)
    }
    this.refuging = true
    const t0 = gameClock.now()
    let run
    try {
      run = require('./survival').runRefuge(this.session, { why: `emergency: ${need.why}`, minHp: EMERGENCY.rearmHp, maxSeconds: 120 })
    } catch (e) {
      this.refuging = false
      throw e
    }
    Promise.resolve(run).then(r => {
      // runIntent отхода выгреб шину в свой ответ, который никто не читает:
      // вернуть события (и прервавший его чат) в шину — мозгу.
      const bus = this.session.bus
      if (r && bus && Array.isArray(bus.buffer)) {
        const back = [...(r.by ? [r.by] : []), ...(r.events || [])]
        if (back.length) { bus.buffer.unshift(...back); if (typeof bus.trim === 'function') bus.trim() }
      }
      const d = (r && r.detail) || {}
      this.session.bus.emit('refuge', {
        how: d.how || null,
        code: d.code || r?.code || (r && r.status !== 'done' ? String(r.status).toUpperCase() : null),
        hp0: d.hp0 ?? need.hp,
        hp: d.hp ?? Math.round(bot.health ?? 0),
        healed: !!d.healed,
        seconds: Math.round((gameClock.now() - t0) / 1000),
        by: r && r.by ? r.by.type : undefined,
        note: d.note || r?.error || undefined,
        // Для разбора (сцена, журнал): что увидел, почему так, что делал.
        look: d.look,
        choice: d.choice,
        steps: Array.isArray(d.steps) && d.steps.length ? d.steps.slice(0, 8) : undefined,
        ate: d.ate,
        placed: d.placed,
        held: d.held
      })
      const cut = (d.aborted || !r || r.status !== 'done') && !(r && r.by) && !d.healed
      if (cut && gameClock.now() - t0 < 5000) {
        this.emergencyArmed = true
        this.emergencyAt = gameClock.now() - EMERGENCY.cooldownMs + 3000
      }
    }).catch(() => {}).finally(() => {
      this.refuging = false
    })
  }

  declare freeIfBuried: any

  declare visibleBurialBlock: any

  // throttled: an alarm that is raised once must be cancelled once. `dug` is
  declare freed: any

  // Being beaten to death while the brain is between thoughts is not a
  // decision worth waking anyone up for. Run first, explain later.
  async fleeIfDying (bot) {
    if (this.bodyBusy() || this.fleeing) return
    const hp = bot.health ?? 20

    const me = bot.entity.position
    const threat = bot.nearestEntity(e =>
      e && e.name && HOSTILES.has(e.name) && e.position && e.position.distanceTo(me) < 12)
    if (!threat && survival.safeGround(bot)) return
    const safety = survival.inspect(bot, { target: threat, minHealth: Math.max(12, this.cfg.lowHealth) })
    if (safety.action === 'fight' || safety.action === 'dead') return

    this.fleeing = true
    this.session.bus.emit('fleeing', { from: threat?.name || 'опасный блок', health: Math.round(hp), reason: safety.reason, threshold: safety.threshold })
    const run = async ctl => {
      await survival.disengage(this.session, ctl, () => require('./flee').hostilesAround(bot, 16).map(h => h.e))
      if (threat && !ctl.aborted) await retreat(this.session, ctl, threat, { timeoutMs: 12000 })
    }
    try {
      // With the tactics on, this idle flight is a low-priority lease (reflex-lock): one owner of the body, and a tactical
      // action cancels it instead of pausing it under its own lease and letting the stale flight resume afterwards.
      if (this.session.tactics?.enabled?.()) await require('./reflex-lock').start(this.session, run, { source: 'fleeIfDying', owner: 'Tactical', priority: 1 })
      else await run({ aborted: false, onAbort: [] })
    } catch {
    } finally {
      this.fleeing = false
    }
  }

  async eatIfHungry (bot) {
    // mineflayer's consume() opens by cancelling any bite already in flight.
    if (this.bodyBusy() || this.session.eating) return
    const hurt = (bot.health ?? 20) < 20 && (bot.food ?? 20) < 18
    if ((bot.food ?? 20) > this.cfg.eatBelowFood && !hurt) return
    if (!this.session.mcData) return
    const pick = bestFood(bot, this.session.mcData)
    if (!pick) return
    if (/^(spider_eye|poisonous_potato|pufferfish|suspicious_stew)$/.test(pick.name) &&
        ((bot.food ?? 20) > 6 || (bot.health ?? 20) < 8)) return
    if (RISKY_FOOD.test(pick.name) && (bot.food ?? 20) > this.cfg.eatBelowFood) return
    if (COOKABLE.test(pick.name) && (bot.food ?? 20) > 6) {
      const bite = (this.session.mcData.foodsByName[pick.name] || {}).foodPoints || 0
      const items = bot.inventory.items()
      const stone = items.filter(i => /^(cobblestone|cobbled_deepslate|blackstone)$/.test(i.name)).reduce((n, i) => n + i.count, 0)
      const canCook = items.some(i => /^(furnace|smoker)$/.test(i.name)) || stone >= 8
      if (canCook && (bot.food ?? 20) + bite < 18) return
    }

    // lived here took the first edible item in the bag, which on 1.21.11 means
    this.session.eating = true
    const r = await eat(this.session, {}).catch(() => null).finally(() => { this.session.eating = false })
    if (r && r.ate) this.session.bus.emit('ate', { item: r.ate, food: r.food })
  }

  // death in a shirt is exactly the sort of thing the brain should never have
  async wearArmor (bot) {
    const now = gameClock.now()
    const SLOT = { 5: /_helmet$/, 6: /_chestplate$/, 7: /_leggings$/, 8: /_boots$/ }
    const emptyFillable = Object.entries(SLOT).some(([s, re]) => !bot.inventory.slots[s] && bot.inventory.items().some(i => re.test(i.name)))
    if (emptyFillable && !this.session.armorBusy && !this.session.eating && (!this.lastQuickArmor || now - this.lastQuickArmor > 1000)) {
      this.lastQuickArmor = now
      try {
        const r = await equipBestArmor(this.session, { aborted: false, onAbort: [] }, { confirmMs: 250 })
        if (r && r.equipped && r.equipped.length) this.session.bus.emit('armor', { equipped: r.equipped.map(e => e.item), defense: r.defense })
      } catch {}
      return
    }
    if (this.bodyBusy()) return
    if (this.lastArmorCheck && now - this.lastArmorCheck < 15000) return
    this.lastArmorCheck = now
    try {
      const r = await equipBestArmor(this.session, { aborted: false, onAbort: [] })
      if (r && r.equipped && r.equipped.length) {
        this.session.bus.emit('armor', { equipped: r.equipped.map(e => e.item), defense: r.defense })
      }
    } catch {
      // Equipping races with eating and with combat all the time; a failed
      // swap is retried on the next pass and is not worth reporting.
    }
  }

  // Armour in the bag while being beaten to death in a shirt is embarrassing; a
  async keepTools (bot) {
    if (this.bodyBusy() || this.session.eating || this.session.crafting) return
    // (session.js follow/cancel keep the flag) — and a table stood up under a
    if (this.session.followGoal) return
    const mcData = this.session.mcData
    if (!mcData) return
    // A chest or furnace the brain left open: bot.craft would fight it for the
    // window, and an unclosed window blocks every window after it (README).
    if (bot.currentWindow) return

    // Rate-limited like wearArmor and for the same reason: it walks the whole
    // inventory and the recipe table, and neither changes between ticks.
    const now = gameClock.now()
    if (now < (this.toolCheckAt || 0)) return
    this.toolCheckAt = now + 15000

    const job = toolPlan(bot, mcData)
    if (!job) { this.toolSig = null; this.toolSaid = null; this.toolSaidAt = 0; this.toolFails = 0; return }

    const me = bot.entity.position
    const threat = bot.nearestEntity(e =>
      e && e.name && HOSTILES.has(e.name) && e.position && e.position.distanceTo(me) < 10)
    if (threat) return

    // The backoff is per situation, not per clock: a bag that changed is a new
    const sig = `${job.kind}:${job.item || 'нечем'}:${job.left}`
    if (sig !== this.toolSig) { this.toolSig = sig; this.toolFails = 0; this.toolNextTry = 0 }
    if (now < (this.toolNextTry || 0)) return

    if (!job.item) {
      const stale = this.toolSaid !== sig || now - (this.toolSaidAt || 0) > 300000
      if (stale) {
        const first = this.toolSaid !== sig
        this.toolSaid = sig
        this.toolSaidAt = now
        this.session.bus.emit('no_tool', { kind: job.kind, left: job.left, why: job.why })
        // The journal is the durable copy and it only needs the first telling:
        // the repeats are for whoever is listening, not for the record.
        if (first) {
          try {
            this.session.journal.append('инструмент',
              `сам чинить не берусь: ${job.kind}, осталось ${job.left} — ${job.why}`,
              bot.entity.position)
          } catch {}
        }
      }
      return
    }
    this.toolSaid = null
    this.toolSaidAt = 0

    this.session.crafting = true
    const ctl = { aborted: false, onAbort: [] }
    try {
      await this.bounded('крафт инструмента', bot, 45000, async () => {
        // Sticks first and separately: they come out of the 2x2 grid with no
        // table at all, and at depth the bag holds planks and never sticks.
        for (const pre of job.pre) await craft(this.session, ctl, { item: pre, count: 1 })
        if (!await this.tableUnderfoot(bot, ctl)) {
          throw new Error('верстак не поставить: ни стола рядом, ни досок на новый')
        }
        await craft(this.session, ctl, { item: job.item, count: 1 })
      })
    } catch (err) {
      // Whatever lost the race is still running inside mineflayer; stop it
      // reaching for another block after we have given up on it.
      ctl.aborted = true
      this.toolTrouble(bot, job, String((err && err.message) || err))
      return
    } finally {
      this.session.crafting = false
    }

    // table on 1.21.11 has been seen to consume the ingredients and return
    const left = toolBudget(bot, job.kind)
    if (!(left > job.left)) {
      this.toolTrouble(bot, job, `крафт прошёл, а ${job.item} в рюкзаке не прибавилось`)
      return
    }
    this.toolFails = 0
    this.toolSig = null
    this.session.bus.emit('tool', { made: job.item, kind: job.kind, was: job.left, left })
    try {
      this.session.journal.append('инструмент',
        `сам сделал ${job.item}: было ${job.left} ударов, стало ${left}`, bot.entity.position)
    } catch {}
  }

  // A routine must never take that walk. It holds the tick loop, and the tick
  async tableUnderfoot (bot, ctl) {
    const mcData = this.session.mcData
    const id = mcData.blocksByName.crafting_table.id
    const near = () => bot.findBlock({ matching: [id], maxDistance: 3 })
    if (near()) return true
    if (!itemNamed(bot, 'crafting_table')) {
      // The 2x2 grid makes a table without needing one, which is the whole
      // reason this can be done standing still at y=-58.
      if (plankCount(bot) < 4) return false
      await craft(this.session, ctl, { item: 'crafting_table', count: 1 })
    }
    await place(this.session, ctl, { block: 'crafting_table' })
    return !!near()
  }

  // The clock is the backstop for the case where nothing hurts and the window
  async bounded (label, bot, ms, work) {
    const startHp = bot.health ?? 20
    const started = gameClock.now()
    let watch = null
    const giveUp = new Promise((_, reject) => {
      watch = gameClock.setInterval(() => {
        if ((bot.health ?? 20) < startHp - 1) reject(new Error(`${label}: здоровье падает, бросаю`))
        else if (gameClock.now() - started > ms) reject(new Error(`${label}: не уложился в ${Math.round(ms / 1000)}с`))
      }, 250)
    })
    try {
      return await Promise.race([work(), giveUp])
    } finally {
      gameClock.clearInterval(watch)
      try { bot.pathfinder.setGoal(null) } catch {}
      try { bot.clearControlStates() } catch {}
    }
  }

  // table is unreliable on 1.21.11 by design of the server, not of this code,
  toolTrouble (bot, job, why) {
    this.toolFails = (this.toolFails || 0) + 1
    const wait = Math.min(300000, 15000 * Math.pow(2, this.toolFails))
    this.toolNextTry = gameClock.now() + wait
    // A window left open by a half-finished craft blocks every window after it.
    try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch {}
    this.session.bus.emit('no_tool', {
      kind: job.kind,
      need: job.item,
      left: job.left,
      why,
      attempt: this.toolFails,
      retryInSeconds: Math.round(wait / 1000)
    })
  }

  // Logs the physics tick rate once every 5s. Healthy is ~20/s; anything near
  // zero means the body is frozen and no amount of pathfinding will help.
  heartbeat (bot) {
    const now = gameClock.now()
    if (!this.lastBeat) { this.lastBeat = now; this.lastTicks = this.session.ticks || 0; return }
    if (now - this.lastBeat < 5000) return
    const ticks = this.session.ticks || 0
    const rate = ((ticks - this.lastTicks) / ((now - this.lastBeat) / 1000)).toFixed(1)
    const e = bot.entity
    const p = e.position
    const below = bot.blockAt(p.offset(0, -0.5, 0))
    console.log(
      `[beat] ${rate} tps onGround=${e.onGround} water=${inWater(bot)}/${!!e.isInWater} hp=${Math.round(bot.health ?? 0)}` +
      ` y=${p.y.toFixed(2)} below=${below ? below.name : 'void'} busy=${this.session.current ? this.session.current.name : '-'}`
    )
    this.lastBeat = now
    this.lastTicks = ticks
  }

  noteDayPhase (bot) {
    if (!bot.time) return
    const t = bot.time.timeOfDay
    const phase = t < 12000 ? 'day' : (t < 13000 ? 'dusk' : (t < 23000 ? 'night' : 'dawn'))
    if (phase !== this.lastPhase) {
      if (this.lastPhase !== null && (phase === 'dusk' || phase === 'dawn')) {
        this.session.bus.emit(phase === 'dusk' ? 'dusk' : 'dawn', {})
      }
      this.lastPhase = phase
    }
  }
}

Object.assign(Autopilot.prototype, require('./autopilot/suffocation'))

module.exports = { Autopilot, IN_WALL_DAMAGE, SELF_GUARDED, EMERGENCY, emergencyNeed, MOB_DAMAGE, CREEPER, creeperNeed }
