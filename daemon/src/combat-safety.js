'use strict'
// Общая граница риска для боевых модулей. Тактика моба выбирает атаки,
// но не может отменить решение о сохранении жизни близостью противника.
const assess = require('./assess')
const { usesLeft } = require('./items')
const RISKY = /^(rotten_flesh|spider_eye|poisonous_potato|pufferfish|chicken|suspicious_stew)$/
const HOT = /^(lava|fire|soul_fire|magma_block|campfire|soul_campfire|cactus|sweet_berry_bush|wither_rose)$/

function safeGround (bot) {
  if (bot.entity?.isInLava) return false
  if (typeof bot.blockAt !== 'function') return true
  const p = bot.entity.position.floored()
  return [p, p.offset(0, 1, 0), p.offset(0, -1, 0)].every(q => {
    const b = bot.blockAt(q)
    return !!b && !HOT.test(b.name)
  })
}

// Цена боя (ND_FIGHT_COST=1, поток survival 02.10): «нечем лечиться» и «нет запаса еды» запрещали бой даже с одним
// зомби при 20 хп и каменном мече — бот бежал, зомби гнался, на бег сбегались другие. По журналам кампаний 02.10
// (survB-*, ow-E1..E3): после «нечем восстановить здоровье» смерть в 90 с — 12 из 25, после «нет запаса еды» — 9 из 26.
// Бой, который по расчёту assess.plan (урон мобов по таблице MOBS, наш dps по оружию, доля дошедших ударов) стоит
// мало, лечения не требует: разрешить, если хп ≥ порог размена + COST_K × ожидаемый урон. Толпа и сильный удар
// (порог ≥ 20) — по-прежнему уход. Без оружия — не бой.
const FIGHT_COST = () => process.env.ND_FIGHT_COST !== '0'
const COST_K = 2.5
function evaluate ({ health = 20, food = 20, foodPoints = 0, weapon = false,
  threats = [], observedHit = 0, minHealth = 8, phase = 'continue', instantHeal = false, dangerous = threats.length > 0, expected = null } = {}) {
  const hits = threats.filter(t => t.distance <= 16).map(t => t.hit).sort((a, b) => b - a)
  const hit = Math.max(observedHit, hits[0] || 0)
  // Два удара ближайшего + один второго: успеть выйти из контакта, а не
  // начинать бегство на том здоровье, которое съест следующий удар.
  const burst = hit * 2 + (hits[1] || 0)
  const threshold = Math.max(minHealth, burst + (hit ? 2 : 0))
  const healable = instantHeal || food + foodPoints >= 18
  const result = { action: 'fight', reason: null, health, food, foodPoints, healable,
    hit, burst, threshold: Math.round(threshold * 10) / 10, threats }
  if (health <= 0) return { ...result, action: 'dead', reason: 'тело погибло' }
  // Дёшево по расчёту — бой и без лечения (см. FIGHT_COST выше).
  // Не «дёшево»: крипер (взрыв), ведьма (зелья), утопленник (трезубец издали), больше двух врагов — модель dps для них
  // не годится (ревью Codex 02.10).
  // Только обычные мобы верхнего мира начала игры (белый список): бои Ада и Края (ифриты у спавнера — blaze.js) остаются
  // со своим запасом еды.
  const odd = threats.length > 2 || threats.some(t => !/^(zombie|husk|zombie_villager|spider|cave_spider|skeleton|stray|parched|bogged|slime|silverfish)$/.test(String(t.name || '')))
  const cheap = FIGHT_COST() && typeof expected === 'number' && weapon && !odd && threshold < 20 && health >= threshold + COST_K * expected
  if (cheap && dangerous && (!healable || food < 18 || (phase === 'start' && !instantHeal && foodPoints < Math.max(0, 18 - food) + 4))) {
    return { ...result, cost: expected, cheap: true }
  }
  if (phase === 'start' && dangerous && !weapon) return { ...result, action: 'leave', reason: 'нет пригодного оружия' }
  if (dangerous && !healable) return { ...result, action: 'leave', reason: 'нечем восстановить здоровье' }
  if (phase === 'start' && dangerous && !instantHeal && foodPoints < Math.max(0, 18 - food) + 4) {
    return { ...result, action: 'leave', reason: 'нет запаса еды после восстановления сытости' }
  }
  if (threshold >= 20) return { ...result, action: 'leave', reason: 'не переживу ближайший размен даже после лечения' }
  if (health <= threshold || (dangerous && food < 18)) {
    return { ...result, action: healable ? 'recover' : 'leave', reason: health <= threshold ? 'запас здоровья меньше ближайшего размена' : 'сытость не позволяет лечиться' }
  }
  return result
}

function inspect (bot, { target = null, entities = null, observedHit = 0, minHealth = 8,
  phase = 'continue', instantHeal = false, expectedEnemy = null } = {}) {
  const items = bot.inventory.items()
  const data = bot.registry?.foodsByName || require('minecraft-data')(bot.version).foodsByName
  const foodPoints = items.reduce((n, i) => n + (!RISKY.test(i.name) && !/_bucket$/.test(i.name)
    ? (data[i.name]?.foodPoints || 0) * i.count : 0), 0)
  instantHeal ||= items.some(i => /golden_apple$/.test(i.name))
  const weapon = items.some(i => /_(sword|axe)$|^trident$|^mace$|_spear$/.test(i.name) && usesLeft(i) >= 4)
  const gear = assess.gearOf([5, 6, 7, 8].map(i => bot.inventory.slots[i]))
  const threats = []
  const seen = new Set()
  const mobs = []
  let people = 0
  for (const e of [target, ...(entities || Object.values(bot.entities || {}))]) {
    if (!e?.position || e === bot.entity || e.isValid === false || seen.has(e.id)) continue
    seen.add(e.id)
    const base = assess.MOBS[e.name]
    const player = e.name === 'player' || !!e.username
    if (!base && !player) continue
    // Нейтральный моб становится участником только как цель/известный нападающий.
    if (e !== target && !entities && /^(enderman|piglin|zombified_piglin)$/.test(e.name)) continue
    if (player && e !== target && !entities) continue
    const distance = e.position.distanceTo(bot.entity.position)
    if (distance > 16 || !assess.inSight(bot, e)) continue
    const hand = e.equipment?.[0]?.name
    const damage = player ? ({ wooden_sword: 4, stone_sword: 5, iron_sword: 6, diamond_sword: 7,
      netherite_sword: 8, wooden_axe: 7, stone_axe: 9, iron_axe: 9, diamond_axe: 9, netherite_axe: 10,
      trident: 9, mace: 6 }[hand] || 4) : e.name === 'blaze' && distance < 3 ? 6 : base.dmg
    if (!player) mobs.push(e)
    else people++
    let hit = Math.round(assess.afterArmor(damage, gear.armor, gear.tough) * 10) / 10
    // ND_FIGHT_COST: моб с оружием в руке бьёт сильнее — тот же счёт, что assess.sizeUp (зомби с деревянным мечом 6,
    // утопленник с трезубцем 11). Ревью Codex (codex-lab/surv-camp-deaths, 02.10): safety брал базовый удар 3, и
    // «дешёвый бой» пропускал опасный.
    if (FIGHT_COST() && !player && hand && !(e.name === 'blaze' && distance < 3)) {
      try { const z = assess.sizeUp(bot, e, gear); if (z && typeof z.hit === 'number' && z.hit > hit) hit = z.hit } catch {}
    }
    threats.push({ id: e.id, name: e.username || e.name, distance, hit })
  }
  if (!threats.length && expectedEnemy && assess.MOBS[expectedEnemy]) {
    const damage = expectedEnemy === 'blaze' ? 6 : assess.MOBS[expectedEnemy].dmg
    threats.push({ name: expectedEnemy, distance: 3, hit: assess.afterArmor(damage, gear.armor, gear.tough), anticipated: true })
  }
  // Ожидаемый урон боя с видимыми мобами (assess.plan) — для ND_FIGHT_COST; с людьми — не считаем.
  let expected = null
  if (FIGHT_COST() && !people && mobs.length) {
    try { const p = assess.plan(bot, { entities: mobs, radius: 16 }); if (p && p.foes) expected = p.expectedDamage } catch {}
  }
  const result = evaluate({ health: bot.health ?? 0, food: bot.food ?? 0, foodPoints, expected,
    weapon, threats, observedHit, minHealth, phase, instantHeal,
    dangerous: !!expectedEnemy || !!(target && (assess.MOBS[target.name] || target.username || target.name === 'player')) || threats.length > 0 })
  if (result.action !== 'dead' && !safeGround(bot)) return { ...result,
    action: result.healable ? 'recover' : 'leave', hazard: true, reason: 'опасность под ногами: нельзя стоять и лечиться' }
  return result
}

function watch (bot) {
  let hp = bot.health ?? 20
  let hits = []
  const health = () => {
    const next = bot.health ?? 0
    if (next < hp && next > 0) hits.push({ at: Date.now(), lost: hp - next })
    hp = next
  }
  bot.on('health', health)
  const hit = () => {
    hits = hits.filter(h => Date.now() - h.at < 8000)
    return Math.max(0, ...hits.map(h => h.lost))
  }
  return { hit, check: opts => inspect(bot, { ...opts, observedHit: hit() }),
    close: () => bot.removeListener('health', health) }
}

// Использует существующий PvP-отрыв с проверками пола и края, включая
// явно переданных игроков. clear означает разрыв ближнего контакта;
// луч от стрелка ещё должен закрыть модуль укрытия перед едой.
async function disengage (session, ctl, foes, { kite, ms = 4000 } = {}) {
  const bot = session.bot
  try { bot.pathfinder.setGoal(null) } catch {}
  bot.clearControlStates()
  const contact = () => (foes() || []).some(e => e?.position && e.isValid !== false &&
    e.position.distanceTo(bot.entity.position) < 8 && assess.inSight(bot, e))
  if ((bot.health ?? 0) <= 0 || ctl.aborted) return { clear: false, how: 'прервано' }
  const safe = () => !contact() && safeGround(bot)
  if (safe()) return { clear: true, how: 'контакта уже нет' }
  const run = kite || require('./tempo').kite
  const how = await run(bot, ctl, foes, { ms, until: safe, stop: () => (bot.health ?? 0) <= 0 })
  return { clear: !ctl.aborted && (bot.health ?? 0) > 0 && safe(), how, health: bot.health }
}

async function recover (session, ctl, { safe, until = 18, maxMs = 30000, eat } = {}) {
  const bot = session.bot
  const start = Date.now()
  const hp0 = bot.health
  const consume = eat || (() => require('./actions').eat(session, {}))
  let ate = 0
  let why = null
  let hazard = false
  const healthy = () => (bot.health ?? 0) >= until && (bot.food ?? 0) >= 18
  while (!ctl.aborted && (bot.health ?? 0) > 0) {
    if (!safeGround(bot)) { hazard = true; why = 'опасность под ногами: прерываю лечение'; break }
    if (!safe || !safe()) { why = 'небезопасно лечиться: контакт или линия огня'; break }
    if (healthy()) break
    if (Date.now() - start >= maxMs) { why = 'время восстановления закончилось'; break }
    if ((bot.food ?? 0) < 20) {
      const before = bot.food
      try { await consume() } catch {}
      if (bot.food > before) ate++
      else if (bot.food < 18) { why = 'сытость для лечения не восстановилась'; break }
    }
    await require('./movement').sleep(250)
  }
  return { rested: !ctl.aborted && (bot.health ?? 0) > 0 && healthy() && safeGround(bot) && !!safe?.(), hazard,
    why: why || (ctl.aborted ? 'прервано' : undefined), hp: `${hp0} -> ${bot.health}`, ate,
    seconds: Math.round((Date.now() - start) / 1000) }
}

module.exports = { evaluate, inspect, watch, disengage, recover, safeGround }
