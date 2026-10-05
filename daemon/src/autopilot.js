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

// Blocks that come back down the moment the cell under them is emptied. There
// is no gravity flag in minecraft-data — pc/1.21.9/blocks.json gives gravel
// only `material: mineable/shovel` — so the list is by name, taken from that
// file. soul_sand and dripstone_block are deliberately absent: they look like
// the others and do not fall.
const FALLS = new Set([
  'gravel', 'suspicious_gravel', 'sand', 'red_sand', 'suspicious_sand',
  'anvil', 'chipped_anvil', 'damaged_anvil', 'dragon_egg',
  'pointed_dripstone', 'scaffolding',
  'white_concrete_powder', 'orange_concrete_powder', 'magenta_concrete_powder',
  'light_blue_concrete_powder', 'yellow_concrete_powder', 'lime_concrete_powder',
  'pink_concrete_powder', 'gray_concrete_powder', 'light_gray_concrete_powder',
  'cyan_concrete_powder', 'purple_concrete_powder', 'blue_concrete_powder',
  'brown_concrete_powder', 'green_concrete_powder', 'red_concrete_powder',
  'black_concrete_powder'
])

// The autopilot handles everything the brain should never be woken up for.
// Decided during design: routine is rules, not reasoning.
// Номер урона in_wall (удушье в блоке) в реестре damage_type 1.21.11 — реестр по
// алфавиту имён; тот же список — DAMAGE_TYPES в dragon.js (тест сверяет).
const IN_WALL_DAMAGE = 22

// ------------------------------------------------------------- EMERGENCY
// Аварийный отход (research/05-synthesis.md F.2, F.5; H6). Хп ниже порога
// размена (combat-safety.evaluate) и враг, который нас видит и может дойти, —
// бросить текущее дело и уйти в укрытие (survival.refuge), как бросает его
// завал (freeIfBuried). Намерения ниже берегут себя сами — у них свой страж
// хп и свой отход; их EMERGENCY не рвёт, им только событие. Список — здесь,
// у единственного, кто его читает.
const SELF_GUARDED = new Set([
  'fight', 'retaliate', 'defend', // бой (pvp.js): крепость, отход, лечение — свои
  // shelter (нора) — не здесь: её копка 8–15 с, урон её не рвёт, и под мобом тело теряло 14 хп за копку (разбор
  // смертей fresh-A1..A4: 17 из 98 — в норе у бьющего моба). Отход (коробка/бег) эту копку перехватывает.
  'flee', 'refuge', 'escape_fire', 'sleep', // уже уходит
  'blaze', 'pearls', 'bastion', 'nether_tunnel', // долгие дела Ада со своей защитой (штрек, окоп, яма)
  'dragon'
])
// Урон, за которым стоит моб (тип damage_event 1.21.11, gamedata.DAMAGE_TYPES).
// Голод, падение, огонь, лава, удушье, кактус, ягоды — не моб: коробка от них
// не спасает, на них отвечают рефлексы и кампания.
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
  // Урон от моба за последние 15 с — или ходячий враг ближе 8 бл. (зомби
  // 2.3 бл/с, а мы к нему шагом 4.3: с 5 бл. контакт через полсекунды — тик
  // автопилота раз в секунду его пропускал, первый прогон сцены).
  mobHurtMs: 15000,
  contact: 8,
  // Ходячий дойдёт, если он на нашем уровне (±4) и не дальше 12 бл.
  walkDy: 4,
  walkDist: 12
}

// ------------------------------------------------------------- КРИПЕР
// Крипер шипит рядом или подошёл вплотную, а тело занято делом (копает, строит спиной к нему) — бросить дело и
// отбежать (survival.dodgeCreeper). Механика 1.21.11 (Creeper.SwellGoal): шипеть начинает с < 3 бл., гаснет дальше
// 7 бл.; фитиль 30 тиков. Тик автопилота раз в секунду этого не ловит — проверка на physicsTick через тик.
// По умолчанию включено (замер survival 02.10–03.10: ловушка «крипер» 3/4 → 14/14); ND_CREEPER_DODGE=0 — выключить.
const CREEPER = { swellDist: 7, closeDist: 3.3, cooldownMs: 2500, everyTicks: 2 }
// Дела, которые урон не рвёт (session.js HOLDING): у печи, верстака, сундука тело стоит и не отвечает.
const HOLD_INTENTS = new Set(['smelt', 'craft', 'chest_put', 'chest_take', 'pack', 'sort', 'stash', 'enchant', 'brew', 'cook'])
// Эти сами отвечают за крипера (бой pvp.js — удар и отход) или уже уходят.
const CREEPER_GUARDED = new Set(['fight', 'retaliate', 'defend', 'flee', 'refuge', 'escape_fire', 'dragon'])
function creeperNeed (bot) {
  if (!bot.entity || (bot.health ?? 0) <= 0) return null
  const gm = bot.game && bot.game.gameMode
  if (gm === 'creative' || gm === 'spectator') return null
  const me = bot.entity.position
  let best = null
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e.name !== 'creeper' || !e.position || e.isValid === false) continue
    const d = e.position.distanceTo(me)
    if (d > CREEPER.swellDist) continue
    let swelling = false
    try { swelling = require('./flee').creeperSwelling(bot, e) } catch {}
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
function emergencyNeed (bot, { lastHurt = null, lowHealth = 8, now = gameClock.now() } = {}) {
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

  // One question asked in six places, and until today six answers to it: three
  // routines wrote `current && current.name !== 'wait'` and three wrote a bare
  // `current`. The two are not the same rule. mc_wait is the brain idling and
  // listening — the MCP instructions end with «закончил дело и ждёшь человека —
  // паркуйся в mc_wait(280)» — and runIntent sets `current` even for
  // exclusive:false (session.js), so a parked brain looked exactly like a busy
  // body. The three routines that read it that way then stood down for the full
  // 280 seconds: no meal below food 16, no armour out of the bag, no replacement
  // pickaxe. Waiting is the one intent during which the autopilot should be
  // doing the most, not the least.
  //
  // Note this is not `this.busy`, which is the tick loop's own re-entrancy
  // guard and says nothing about the body.
  bodyBusy () {
    const cur = this.session.current
    // Аварийный отход (emergency) — тоже тело занято, даже если mc_wait мозга
    // переписал session.current: бегство и еда автопилота поверх коробки
    // вытащили бы тело наружу.
    return !!((cur && cur.name !== 'wait') || this.refuging || this.session.reflex)
  }

  // ------------------------------------------------------------- характер
  //
  // Ударили — отвечаем, но не всегда с первого раза: человек мог задеть
  // случайно, промахнуться по мобу, проверить, живой ли бот. Первый удар —
  // бросок кубика (session.temper.firstHitChance), второй за окно windowMs —
  // ответ наверняка. Бой ведёт pvp.js через session.retaliate; он кончается
  // сам, когда обидчик перестал бить и отошёл (calmAfterMs).
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
    // Гистерезис EMERGENCY: снова взводится, как только хп дошло до 16 — по
    // событию здоровья, а не по тику (хп бывает на 16+ меньше секунды).
    // И проверка отхода сразу по удару, а не на следующем тике (до секунды —
    // это ещё удар-два).
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
      if (pk.sourceTypeId === IN_WALL_DAMAGE) this.inWallAt = gameClock.now()
      // Кто и чем ударил последним — для EMERGENCY (моб или не моб).
      const type = damageTypeName(pk.sourceTypeId) || `type_${pk.sourceTypeId}`
      const src = pk.sourceCauseId > 0 && bot.entities ? bot.entities[pk.sourceCauseId - 1] : null
      const byMob = MOB_DAMAGE.test(type) || !!(src && src !== bot.entity && src.name && src.name !== 'player' && !src.username)
      this.lastHurt = { at: gameClock.now(), type, byMob, source: src ? (src.username || src.name) : null }
      // Удар моба посреди «стоячего» дела (печь, верстак, сундук) — разбудить мозг сразу (ND_HURT_WAKE=1): эти дела
      // рвёт только low_health (≤ 8), и зомби у печи ночью снимал 20 → 7, пока не сработал отход (camp1 02.10, слот 20:
      // smelt → «прервано: emergency» на 7 хп, смерть в бегстве). Мозг ответит сам (answerThreat: бой или отход).
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

  // Увидел сундук на постройке игры — сходить и забрать, когда вокруг тихо.
  // Чей-то сундук (или непонятно чей) — только сказать мозгу, раз на сундук.
  // Не ждёт в тике: лут идёт своим ходом, как реванш.
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
    this.hookTemper(bot)
    this.hookDamage(bot)
    this.hookCreeper(bot)
    // Жесты людей (присед, прыжки, взгляд, брошенный предмет) — на слушателях,
    // не в этом тике: gestures.js.
    gestures.hook(this, bot)
    this.busy = true
    try {
      await this.escapeWaterIfIdle(bot)
      await this.freeIfBuried(bot)
      // A body inside a block loses two hit points a second and everything
      // below is worth less than those seconds — a craft least of all, since
      // it holds this whole loop for as long as it takes to place a table and
      // open it. That is not a hypothetical: the run that died of suffocation
      // spent part of its last thirty seconds making a pickaxe.
      if (this.stuck) { this.heartbeat(bot); return }
      // Мало хп и враг, который дойдёт, — бросить дело и в укрытие.
      await this.emergency(bot).catch(e => console.error('[emergency]', (e && e.message) || e))
      // Горю — огнестойкость; хп мало и враг рядом — золотое яблоко раньше бегства
      // (fightkit.js). Своё хранит от повторов, ошибки не наши — молча.
      await require('./fightkit').autoUse(this, bot).catch(() => {})
      await this.extinguish(bot).catch(() => {})
      await this.fleeIfDying(bot)
      await this.eatIfHungry(bot)
      await this.wearArmor(bot)
      await this.keepTools(bot)
      this.lootIfSeen(bot)
      // Noticing a person is a rule; what to say to them is reasoning, so this
      // one only emits and turns the head. Its errors are logged rather than
      // swallowed and rather than thrown: a throw here would take the heartbeat
      // below with it, and a body whose tick rate stopped printing looks
      // exactly like a body that froze.
      await social.noticePlayers(this).catch(e => console.error('[social]', (e && e.message) || e))
      this.noteDayPhase(bot)
      this.heartbeat(bot)
    } finally {
      this.busy = false
    }
  }

  // Горю вне боя (2026-09-26, пользователь: «когда горит — учитывает ли воду
  // рядом? если ведра нет, просто в воду забежать, чтобы потушиться»). Бой
  // тушится сам (pvp.js, пока идёт — session.tempo); здесь остальное: лава в
  // шахте, огонь, фаербол, молния. Ведро воды — под ноги и сразу обратно в
  // ведро; нет ведра — к ближайшей воде в 10 блоках, если тело свободно или хп
  // уже мало (огонь снимает по 1 в секунду). В Аду вода испаряется — там ни то
  // ни другое (огнестойкость — fightkit.autoUse выше).
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

  // Drowning in a river while nobody is looking is exactly the kind of stupid
  // death the autopilot exists to prevent. Only runs when no intent is active,
  // so it never fights the brain for control.
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

  // «Голова в воздухе» is not «откопался», and the difference is a fact about
  // the world rather than a count of swings.
  //
  // An empty head cell lies in two measured ways. First, mineflayer writes the
  // air itself: finishDigging calls bot._updateBlockState(pos, 0)
  // (mineflayer/lib/plugins/digging.js:158), which is setBlockStateId in
  // blocks.js:246-248 — so blockAt() reads air the instant bot.dig resolves,
  // before the server has said anything at all. Second, a gravel column on its
  // way into that cell is not a block anywhere: it is a `falling_block` entity
  // (minecraft-data pc/1.21.9/entities.json, id 50) for the ~7 ticks a
  // one-block fall takes, and the cell it came from reads air too. Case 3 of
  // try-buried is exactly that shape: three gravel over the head, and the old
  // rule called every gap between two swings «свободен».
  //
  // So the question asked of the world is: head cell empty, nothing that falls
  // resting straight above it, nothing already in the air over us. `block` is
  // what to swing at; null means the only useful move is to wait for it to land.
  buriedBy (bot) {
    const head = bot.blockAt(bot.entity.position.offset(0, 1.2, 0))
    if (head && head.boundingBox === 'block') return { name: head.name, block: head }
    // The falling half of the rule only ever *keeps* an alarm open; it never
    // opens one. A body at full health under a gravel block that has not moved
    // yet is not suffocating, and «ЗАДЫХАЮСЬ» on 20 hp is a lie — the
    // control case (убежище) is worth more than the corner case.
    if (!this.announced) return null
    const above = bot.blockAt(bot.entity.position.offset(0, 2.2, 0))
    if (above && above.boundingBox === 'block' && FALLS.has(above.name)) {
      return { name: above.name, block: null }
    }
    const drop = this.fallingOverhead(bot)
    return drop ? { name: drop, block: null } : null
  }

  // The column while it is in flight. Only our own square counts: gravel two
  // blocks to the side is somebody else's problem.
  fallingOverhead (bot) {
    const me = bot.entity.position
    for (const e of Object.values(bot.entities || {})) {
      if (!e || e.name !== 'falling_block' || !e.position) continue
      if (Math.floor(e.position.x) !== Math.floor(me.x)) continue
      if (Math.floor(e.position.z) !== Math.floor(me.z)) continue
      const dy = e.position.y - me.y
      if (dy > 0 && dy < 6) return 'падающий блок'
    }
    return null
  }

  // One mouth, and the rescue has to hold it. mineflayer's dig() opens by
  // cancelling whatever swing is in flight (digging.js:127), and that
  // cancellation rejects the *current* dig task with «Digging aborted»
  // (digging.js:189) — the module keeps exactly one `diggingTask`. So the
  // intent's next swing kills ours precisely as ours killed its. mining.js:220
  // re-swings 120ms after a refusal and a block of deepslate takes ~750ms
  // (hardness 3.0, iron pick, prismarine-block digTime), so the rescue lost
  // every race it entered: case 2 of try-buried reported `still_buried` with
  // zero blocks out while the pickaxe was perfectly good. Cancelling one swing
  // was never enough — the intent has to stop digging altogether. It checks
  // ctl.aborted before every swing (mining.js:195), so this ends the fight in
  // about a tenth of a second, and the intent answers the brain honestly with
  // «прервано» instead of silently losing its swings to us.
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

  // Прерванному намерению — честная причина: { status: 'interrupted', by:
  // {type: 'emergency'} }, как от любого прерывания шины (session.runIntent
  // ждёт bus.nextInterrupt). Типа emergency в списках interruptOn нет, поэтому
  // ждущие отпускаются здесь напрямую — все: и намерение, и mc_wait мозга.
  interruptFor (ev) {
    const bus = this.session.bus
    if (!bus || !bus.waiters) return
    for (const w of Array.from(bus.waiters)) {
      bus.waiters.delete(w)
      try { w.resolve(ev) } catch {}
    }
  }

  hookCreeper (bot) {
    if (this.creeperBot === bot || typeof bot.on !== 'function') return
    this.creeperBot = bot
    let n = 0
    bot.on('physicsTick', () => {
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

  // EMERGENCY (H6): хп ≤ порога combat-safety и враг, который видит и дойдёт.
  // Не самоохраняемое намерение — перехватить (takeTheMouth) и уйти в укрытие
  // (survival.runRefuge). Не по пустякам: гистерезис (взвод на 16 хп), не чаще
  // раза в 30 с, не от голода/падения/огня (emergencyNeed). ND_EMERGENCY=0 —
  // выключить (основной мир до правки кампании, см. research/dev-B-refuge.md).
  async emergency (bot) {
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
    // Порог отхода — не ниже 12 хп: порог размена combat-safety для одного зомби без брони — 8 (2 удара + 2), и
    // отход начинался на 6–8 хп вплотную к нему (fresh-A5 30.09: смелт ночью 20 → 2, отход с 6 — «прижали»).
    // Коробки с 7–9 хп вставали и лечили (A5: 7 → 17, 8 → 20, 9 → 19), но запас на стройку нужен.
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
      // Отход оборвало чужое намерение (мозг или кампания позвали своё в ту же
      // секунду) — это не отход, а гонка: не ждать 30 с, снова через 3 с, если
      // опасность ещё тут. Смерть и чат — не гонка.
      const cut = (d.aborted || !r || r.status !== 'done') && !(r && r.by) && !d.healed
      if (cut && gameClock.now() - t0 < 5000) {
        this.emergencyArmed = true
        this.emergencyAt = gameClock.now() - EMERGENCY.cooldownMs + 3000
      }
    }).catch(() => {}).finally(() => {
      this.refuging = false
    })
  }

  // A body left standing in the world between sessions is not safe just because
  // nobody is driving it. The bot was found floating inside terrain with its
  // health quietly draining from 20 to 5 over an idle hour: suffocation fires
  // no event, has no mob to report, and looks from the outside exactly like
  // nothing happening at all. Digging our own head out stops it.
  //
  // It also has to work while the bot is *working*, which it did not, and that
  // cost the diamond run of 2026-08-31: gravel came down inside a drift, and
  // the body then suffocated through a tunnel, a pickaxe craft and a climb
  // before the server wrote «NeuroDown suffocated in a wall». Suffocation
  // happens because the bot is digging, so the one routine that answers it
  // cannot be the one routine that only runs when the bot is idle.
  //
  // The signal that makes that safe is a pair: eye level solid AND health
  // falling. Nothing legitimate produces both. The intents that put a block
  // near the head put it at feet+2 — shelter roofs there, and towerUp refuses
  // to jump into a ceiling at all — never at eye level, and none of them cost
  // health. (mineflayer does receive the real damage type: the 1.20+
  // `damage_event` packet carries sourceTypeId, which would name `in_wall`
  // outright. It is thrown away in entities.js:377-381, and the damage_type
  // registry is not among the ones loadDimensionCodec keeps, so resolving the
  // id would mean decoding registry_data by hand — a version-fragile
  // dependency for a fact the world and the health bar already agree on.)
  //
  // Reports three states and not two: 'freed' (out), 'digging_out' (still in
  // it, but blocks are coming out) and 'still_buried' (nothing came out — no
  // tool, bedrock, a block that will not break). The middle one exists because
  // the brain's answer to it is «не мешай», and to the last one «иди на
  // выручку»; with only two names a bot clearing a gravel column looked
  // exactly like a bot walled in with bare hands.
  async freeIfBuried (bot) {
    // Sampled before every early return, because the drop between two ticks is
    // the whole signal and a tick that returned early still saw it.
    const hp = bot.health ?? 20
    const losing = hp < (this.lastHp ?? hp)
    this.lastHp = hp
    if (this.freeing) return

    const head = this.buriedBy(bot)
    if (!head) {
      // Out of the wall by any means — our own swing, a falling column that
      // settled elsewhere, the drift we were interrupting digging the cell out
      // from under us, or a player with a shovel. Measured in try-buried case
      // 2: the tunnel cleared the block itself between the alarm and the
      // rescue, the rescue found nothing to do, and the brain was left holding
      // a 'buried' that never resolved. An alarm has to be cancelled by
      // whoever raised it.
      this.buriedSince = null
      this.stuck = false
      this.freed(bot, null)
      return
    }
    // Бой с драконом (30.09, агент «дракон»): у головы там бывает свой же блок —
    // столб у клетки, вода ведра, подставка, яма с крышкой, — а хп падает от
    // облаков и крыльев. Пара «голова в блоке + хп падает» обрывала бой: v2-26 —
    // верхушка столба с водой, обрыв на 4 хп, следующий вызов начался в облаке,
    // смерть. Во время намерения dragon — только настоящее удушье (in_wall за 2 с).
    const cur0 = this.session.current
    if (cur0 && cur0.name === 'dragon' && gameClock.now() - (this.inWallAt || 0) > 2000) return
    this.stuck = true
    if (!this.buriedSince) this.buriedSince = gameClock.now()

    const busy = this.bodyBusy()
    // A body already at the low-health line with its head inside a block gets
    // no grace period and no deference to the intent: whatever is taking the
    // health, the head being in stone is not survivable on top of it, and the
    // debounce is the window a burial can end in a death without ever having
    // been reported — try-buried case 5 went 20 hp to `death` with not one
    // `buried` in the log.
    const dire = hp <= this.cfg.lowHealth
    if (!losing && !dire) {
      // Not suffocating yet. Idle, the old rule stands: standing in a doorway
      // for a tick is normal, being inside stone for two seconds is not. Busy,
      // stay out of the intent's way entirely — without the health signal there
      // is nothing here to tell a wall from a ceiling being built on purpose.
      if (busy) return
      if (gameClock.now() - this.buriedSince < 2000) return
    }
    // ...and when health is falling there is no wait at all: the two-second
    // debounce is four hit points, and the pair has already said what this is.

    this.buriedSince = null
    this.freeing = true
    const during = busy ? (this.session.current ? this.session.current.name : 'refuge') : null
    // One alarm per burial. The attempt below repeats every tick while the
    // body is dying — and it should — but «меня завалило» is a fact, and a
    // fact repeated once a second is noise.
    // Deliberately does NOT touch buriedSaidAt: that timestamp throttles the
    // *outcome* chatter below, and stamping it here swallowed the first
    // outcome entirely — the alarm went out and what came of it never did.
    if (!this.announced) {
      this.announced = true
      // Counted for the whole burial, not for one pass. The bag and the report
      // used to disagree out loud: try-buried case 3 ended with gravel×2 in the
      // rucksack and `dug: 0` in the event, because the counter was a local
      // that died with the pass and the 10s throttle below swallowed whichever
      // pass had done the work. Two true numbers measuring different things
      // read as one of them lying.
      this.dugTotal = 0
      this.session.bus.emit('buried', { block: head.name, health: Math.round(hp), during })
    }

    let why = null
    try {
      if (during) await this.takeTheMouth(bot)

      // Gravel and sand pour straight back into the cell we just emptied, and a
      // column of it coming down is the ordinary way to get buried in a drift,
      // not the exotic one — one swing is not a rescue. Bounded by the clock
      // rather than by a swing count, because waiting out a falling block is
      // part of the work and must not spend an attempt.
      const until = gameClock.now() + 6000
      for (let i = 0; i < 12 && gameClock.now() < until; i++) {
        const now = this.buriedBy(bot)
        if (!now) break
        if (!now.block) {
          // Nothing solid to hit: the column is in the air on its way into the
          // cell. Swinging at air here is what used to be counted as a rescue.
          await sleep(200)
          continue
        }
        const cell = now.block
        // bot.dig on bedrock never completes and would hang this routine for
        // as long as the bot lives, which here is about ten seconds.
        if (cell.name === 'bedrock') { why = 'над головой бедрок'; break }
        const problem = this.session.mcData
          ? missingHarvestTool(bot, cell, this.session.mcData)
          : null
        // Без нужного инструмента — рукой, если рука ломает быстрее, чем
        // убьёт удушье (1 хп за 10 тиков): камень рукой — 7.5 с (без верного
        // инструмента делитель 100 вместо 30, BlockBehaviour.getDestroyProgress),
        // это 15 хп. Дроп не нужен — нужен воздух. 2026-09-26 (13:16) тело без
        // кирки задохнулось в камне на y=29 за 14 с, ни разу не ударив.
        let handMs = null
        if (problem) {
          try { handMs = cell.digTime(null, false, false, false, [], bot.entity.effects) } catch {}
          const hpMs = ((bot.health ?? 20) - 1) * 500
          if (!(Number.isFinite(handMs) && handMs < hpMs)) { why = problem; break }
        }
        // Per swing, not per rescue. One refused swing used to abort all four
        // attempts through the outer catch, which is how a stolen `bot.dig`
        // turned into «заперт» with a good pickaxe in hand.
        try {
          await equipBestTool(bot, cell)
          await withTimeout(bot.dig(cell), Math.max(8000, (handMs || 0) + 1500), `${cell.name} не ломается`)
          this.dugTotal++
          why = null
        } catch (e) {
          why = String((e && e.message) || e)
          try { bot.stopDigging() } catch {}
        }
        // 250ms was less than the fall it was waiting for: a block drops one
        // cell in about seven ticks, and the cell reads air the whole time
        // (see buriedBy). Re-reading early is what made a live column look
        // like an empty shaft.
        await sleep(400)
      }
      const feet = bot.blockAt(bot.entity.position)
      const footProblem = feet && this.session.mcData
        ? missingHarvestTool(bot, feet, this.session.mcData)
        : null
      if (feet && feet.boundingBox === 'block' && feet.name !== 'bedrock' && !footProblem) {
        try {
          await equipBestTool(bot, feet)
          await withTimeout(bot.dig(feet), 8000, `${feet.name} не ломается`)
          this.dugTotal++
        } catch (e) {
          why = String((e && e.message) || e)
          try { bot.stopDigging() } catch {}
        }
      }
    } catch (e) {
      why = String((e && e.message) || e)
      try { bot.stopDigging() } catch {}
    } finally {
      this.freeing = false
    }

    // Three states, because the brain has three different answers to them and
    // the old two lumped the first two together. Measured in try-buried case 3:
    // a gravel column was being cleared a block at a time — three swings, three
    // refills — and every pass reported `still_buried`, which is what a walled
    // in bot with no pickaxe also reports. «Я выгребаюсь» and «я заперт» read
    // identically, and one of them wants to be left alone while the other wants
    // rescuing.
    const left = this.buriedBy(bot)
    this.stuck = !!left
    if (!this.stuck) { this.freed(bot, during); return }

    // Still in it. Throttled, unlike the closing report: the pass repeats every
    // tick and low_health fires on its own at 8 hp, which does interrupt.
    const now = gameClock.now()
    if (now - (this.buriedSaidAt || 0) <= 10000) return
    this.buriedSaidAt = now

    const dug = this.dugTotal || 0
    if (dug > 0) {
      // Progress, not paralysis. The cell keeps being refilled — gravel and
      // sand pour back in faster than one pass can empty them — but blocks are
      // coming out and the next pass starts one block further along.
      this.session.bus.emit('digging_out', {
        block: left.name,
        health: Math.round(bot.health ?? 0),
        dug,
        during
      })
      return
    }

    // Nothing came out at all, in this pass or any pass of this burial — `dug`
    // is the running total, so this branch is the honest «ни одного блока».
    // The one that wants help: no tool, bedrock, or a block that will not
    // break. `why` is only trustworthy here — in the branch above it would have
    // to explain three swings that worked.
    this.session.bus.emit('still_buried', {
      block: left.name,
      health: Math.round(bot.health ?? 0),
      dug,
      during,
      why: why || 'блок не поддался'
    })
    try {
      this.session.journal.append('завал',
        `не смог откопаться: ${left.name} над головой, ${why || 'блок не поддался'}` +
        (during ? ` (шло намерение ${during})` : ''), bot.entity.position)
    } catch {}
  }

  // The closing bracket of a burial, and the only report that is never
  // throttled: an alarm that is raised once must be cancelled once. `dug` is
  // the whole burial's count and not the last pass's, so a column cleared over
  // four passes is not reported as «рассосалось само» on the strength of the
  // one pass that happened to swing at nothing.
  freed (bot, during) {
    this.buriedSaidAt = 0
    const dug = this.dugTotal || 0
    this.dugTotal = 0
    if (!this.announced) return
    this.announced = false
    this.session.bus.emit('freed', {
      dug,
      // Nothing was swung and the way out is clear anyway — the burial ended
      // by itself, or someone else ended it. Worth saying, because it means
      // the alarm was not something this routine solved.
      byItself: dug === 0,
      health: Math.round(bot.health ?? 0),
      during
    })
  }

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
    try {
      // Same retreat the brain gets: cover against archers, distance against
      // everything else. The autopilot used to run in a straight line, which
      // against a skeleton is just a slower way to die.
      const ctl = { aborted: false, onAbort: [] }
      await survival.disengage(this.session, ctl, () => require('./flee').hostilesAround(bot, 16).map(h => h.e))
      if (threat) await retreat(this.session, ctl, threat, { timeoutMs: 12000 })
    } catch {
    } finally {
      this.fleeing = false
    }
  }

  async eatIfHungry (bot) {
    // Skipped while an intent runs, for the same reason an armour swap is:
    // mineflayer's consume() opens by cancelling any bite already in flight.
    // This ticks every second and a bite takes 2.5s, so an autopilot meal
    // landing inside the brain's own meal was not a rare race — below the
    // hunger threshold it was the normal case, and both sides came back
    // empty-handed. Measured: two RPC failures in the diamond run, both in
    // the fight that killed the bot. session.eating is the flag the brain's own
    // eat() sets and is the half of this check that actually answers that race;
    // mc_wait is not an intent that bites.
    if (this.bodyBusy() || this.session.eating) return
    // Ранен — есть до 18: здоровье само восстанавливается только при
    // сытости 18 и выше (FoodData.tick: foodLevel >= 18 → +1 хп раз в 80
    // тиков). Порог «голоден» (eatBelowFood, 16) это не ловил: кампания
    // 2026-09-25 простояла 4 минуты на 4 хп при сытости 17 с сырым мясом в
    // рюкзаке — не ела, потому что «не голодна», и не лечилась, потому что 17.
    const hurt = (bot.health ?? 20) < 20 && (bot.food ?? 20) < 18
    if ((bot.food ?? 20) > this.cfg.eatBelowFood && !hurt) return
    if (!this.session.mcData) return
    // Что съестся. Паучий глаз и ядовитая картошка травят (яд тикает до 1 хп),
    // иглобрюх ещё и тошнит — это еда только от настоящего голода (6 и ниже,
    // когда уже не бегается) и не на последних хп. Гнилая плоть и сырая курица
    // только вешают голод — ради «подлечиться» при сытости 16-17 их не едим.
    // 2026-09-25 в мире пользователя: сытость 17, ранен — съел паучий глаз.
    const pick = bestFood(bot, this.session.mcData)
    if (!pick) return
    if (/^(spider_eye|poisonous_potato|pufferfish|suspicious_stew)$/.test(pick.name) &&
        ((bot.food ?? 20) > 6 || (bot.health ?? 20) < 8)) return
    if (RISKY_FOOD.test(pick.name) && (bot.food ?? 20) > this.cfg.eatBelowFood) return
    // Сырое мясо, которое печь сделает втрое сытнее (баранина 2 → 6, говядина
    // 3 → 8), — не есть «подлечиться», если кусок до 18 всё равно не дотянет:
    // лечения не будет, а мясо пропало. Кампания 2026-09-26: каждая овца
    // съедалась сырой на сытости 11-15, и за два дня охоты в рюкзаке не
    // появилось ни куска жареного. Настоящий голод (6 и ниже) — ест.
    // Только если жарить есть на чём: печь в рюкзаке или 8 булыжника на неё.
    // Без печи и камня (после смерти, деревянной киркой) сытость 8 с
    // семнадцатью кусками сырого — это голод без лечения (2026-09-26, 12:30).
    if (COOKABLE.test(pick.name) && (bot.food ?? 20) > 6) {
      const bite = (this.session.mcData.foodsByName[pick.name] || {}).foodPoints || 0
      const items = bot.inventory.items()
      const stone = items.filter(i => /^(cobblestone|cobbled_deepslate|blackstone)$/.test(i.name)).reduce((n, i) => n + i.count, 0)
      const canCook = items.some(i => /^(furnace|smoker)$/.test(i.name)) || stone >= 8
      if (canCook && (bot.food ?? 20) + bite < 18) return
    }

    // The brain's own eat(), not a second implementation of it. The copy that
    // lived here took the first edible item in the bag, which on 1.21.11 means
    // a fish bucket (minecraft-data lists buckets as food) before a steak —
    // and it swallowed every error, so none of that was visible anywhere.
    this.session.eating = true
    const r = await eat(this.session, {}).catch(() => null).finally(() => { this.session.eating = false })
    if (r && r.ate) this.session.bus.emit('ate', { item: r.ate, food: r.food })
  }

  // Walking around with a full iron set in the backpack while being beaten to
  // death in a shirt is exactly the sort of thing the brain should never have
  // to remember. Rate-limited because it walks the inventory every call, and
  // skipped while an intent is running so a swap cannot land mid-swing.
  async wearArmor (bot) {
    const now = gameClock.now()
    // Пустой слот брони при броне в рюкзаке — надеть сразу (раз в секунду), даже
    // посреди намерения: голым драться хуже, чем пара кликов (арена 2026-09-25:
    // «когда у тебя есть броня — сразу автоматом быстро надевать»).
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

  // The sister routine to wearArmor, for the tool the body cannot move without.
  // Armour in the bag while being beaten to death in a shirt is embarrassing; a
  // pickaxe worn out at y=-58 is fatal. Measured on the diamond run: two iron
  // picks were 500 swings, the descent spent 475 of them, and the bot ended
  // standing on bedrock-adjacent deepslate with 208 cobblestone, 16 planks and
  // a crafting table in the bag — ten seconds of work for a player, and it just
  // stood there. Rules, not reasoning.
  async keepTools (bot) {
    // Skipped while an intent runs for a stronger version of wearArmor's
    // reason: this one places a block, walks to it and opens a window. Two
    // crafts at once is a window race, and a table dropped under the feet of a
    // running dig_down is a step the staircase did not plan for.
    // session.eating is the same flag the brain's own eat() sets — it is an
    // immediate op, so session.current stays null right through a meal.
    if (this.bodyBusy() || this.session.eating || this.session.crafting) return
    // The one thing mc_wait does not settle. follow() sets a GoalFollow that
    // outlives the call and keeps walking the body while wait() blocks
    // (session.js follow/cancel keep the flag) — and a table stood up under a
    // walking body is out of reach by the time the window would open, while this
    // routine's own teardown (bounded, below) clears the pathfinder goal on the
    // way out and would end the follow the brain never cancelled.
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

    // Placing a table and standing over it for several seconds next to a
    // zombie is how the body dies while the brain is between thoughts, and
    // this routine fires exactly when there is nothing to fight back with.
    const me = bot.entity.position
    const threat = bot.nearestEntity(e =>
      e && e.name && HOSTILES.has(e.name) && e.position && e.position.distanceTo(me) < 10)
    if (threat) return

    // The backoff is per situation, not per clock: a bag that changed is a new
    // question and deserves an immediate answer, while the same bag asked again
    // gets the same failure. The old autopilot eatIfHungry retried a doomed
    // action every second forever and nobody ever saw it.
    const sig = `${job.kind}:${job.item || 'нечем'}:${job.left}`
    if (sig !== this.toolSig) { this.toolSig = sig; this.toolFails = 0; this.toolNextTry = 0 }
    if (now < (this.toolNextTry || 0)) return

    if (!job.item) {
      // Cannot be fixed from the bag, or can only be fixed by spending loot the
      // routine does not get to spend. Silence here is what stranded the bot,
      // so it is said out loud — 'no_tool' is buffered, not an interrupt: news,
      // not an emergency.
      //
      // Said again every five minutes while the situation lasts, not once ever.
      // The bus is drained by *whatever answers next*, and that is not always
      // the brain: mc_status, mc_say and every autopilot-era RPC empty it too.
      // A fact stated exactly once into a queue anyone can empty is
      // indistinguishable from a fact never stated — which is the whole failure
      // this routine exists to prevent. Five minutes is the same number the
      // craft backoff caps at, and this state is not going anywhere by itself.
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

    // The bag is the verdict, not the absence of a throw: crafting through a
    // table on 1.21.11 has been seen to consume the ingredients and return
    // without the item (README).
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

  // actions.js -> ensureTable answers "get me to a table" by walking to any one
  // it can see within twenty blocks, and that walk is a pathfinder.goto with no
  // timeout, no abort hook, and the movements of whatever intent ran last —
  // canDig included, because session.craft is one of the few intents that never
  // calls updateMovements. On 2026-08-31 that cost the brain a 60s timeout and
  // eleven levels of altitude: the intent returned `timeout`, the goal stayed
  // set, and the body kept walking back down the drift toward a table it had
  // left behind.
  //
  // A routine must never take that walk. It holds the tick loop, and the tick
  // loop is what keeps the bot from suffocating. So: stand a table up where we
  // are. Four planks and about a second, and it is a block we usually get back.
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

  // The longest thing this class does, and it runs inside the tick loop: while
  // it waits, freeIfBuried does not. So it is bounded twice, and health is the
  // tighter of the two — two hit points going down means we are being
  // suffocated or eaten, and the answer to both is "not now, and not here".
  // The clock is the backstop for the case where nothing hurts and the window
  // simply never opens (mineflayer waits 20s for windowOpen, twice, and the
  // table is unreliable on 1.21.11 by the server's doing, not ours).
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
      // Losing a race does not stop what lost it. Anything still holding a
      // pathfinder goal or a key would keep moving the body long after this
      // routine reported failure — the exact shape of the eleven-level drop.
      try { bot.pathfinder.setGoal(null) } catch {}
      try { bot.clearControlStates() } catch {}
    }
  }

  // A craft that failed is not a reason to hammer the table once a second. The
  // table is unreliable on 1.21.11 by design of the server, not of this code,
  // so back off geometrically and cap it: 30s, 1m, 2m, 4m, then every 5m until
  // something in the bag changes and resets the signature.
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

module.exports = { Autopilot, IN_WALL_DAMAGE, SELF_GUARDED, EMERGENCY, emergencyNeed, MOB_DAMAGE, CREEPER, creeperNeed }
