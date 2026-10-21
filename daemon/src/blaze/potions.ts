'use strict'
import * as gameClock from '../game-clock'
import { sleep } from '../movement'

// minecraft-data 1.21.11 зовёт эффекты по-старому, в PascalCase
// (effectsByName.FireResistance, id 11 — совпадает с номером в пакете
// entity_effect); по snake_case там пусто, и проверка «зелье уже действует»
// молча отвечала «нет».
// Огнестойкость, выпитая самим телом, — по часам (16.10: в сценах у спавнера entity.effects тела пуст всегда — эффекта клиент не видит,
// а сервер его дал; цикл боя пил все зелья подряд и сгорал после первых 3 мин). Зелье огнестойкости — 3600 тиков (jar Potions:
// fire_resistance 3600), взрывное — то же.
function frByClock (bot) { return !!bot._ndFrUntil && gameClock.now() < bot._ndFrUntil }
function hasEffect (bot, name) {
  if (name === 'fire_resistance' && frByClock(bot)) return true
  try {
    const pascal = String(name).split('_').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('')
    const eff = bot.registry.effectsByName[name] || bot.registry.effectsByName[pascal]
    return !!(eff && bot.entity.effects && bot.entity.effects[eff.id])
  } catch { return false }
}

// Огнестойкость, если она есть: шар — это огонь, и под зельем он не жжёт
// вовсе (fireball в #is_fire). Пьём заранее, а не на половине хп.
// Есть ли зелье огнестойкости (обычное или взрывное) — для боя мечом (blaze-melee.ts).
function drinkable (bot) {
  const { potionOf }: typeof import('../pvp') = require('../pvp')
  return bot.inventory.items().some(i => /^(potion|splash_potion)$/.test(i.name) && /fire_resistance$/.test(potionOf(i) || ''))
}
// Зелий FR на теле (обычные и взрывные).
function frCount (bot) {
  const { potionOf }: typeof import('../pvp') = require('../pvp')
  return bot.inventory.items().filter(i => /^(potion|splash_potion)$/.test(i.name) && /fire_resistance$/.test(potionOf(i) || '')).reduce((n, i) => n + i.count, 0)
}
// ND_BLZ_FR_BUDGET=1 (blz 21.10, набор полного прохода — 1 FR с бартера): последнее зелье — бою у трона, а не первому огню. Настоящий
// набор n77 (postbastion, 0/10): в 5 из 10 зелье ушло мимо трона — «ифриты видны (1, в 22 бл.) — бой отсюда» у портала (di-s19-2),
// ход и поиск крепости (bE1-s17-3, bE2-s18-3), горение от магмового куба (bE2-s18-2); к бою у спавнера FR уже не было.
// Пить можно: зелий 2+, в лаве, хп ≤ 6, трон рядом — спавнер (виден или в памяти этого мира) в 14 бл. или 3+ ифрита в 16 (их держит
// объём спавна у трона; одиночный ифрит — бродячий, крепость спавнит их и без спавнера).
function frSpendOk (bot, dead: Set<any> = new Set()) {
  if (process.env.ND_BLZ_FR_BUDGET !== '1') return true
  try {
    if (frCount(bot) >= 2 || bot.entity?.isInLava || (bot.health ?? 20) <= 6) return true
    if (!/nether/.test(String(bot.game?.dimension || ''))) return false
    const me = bot.entity.position
    const T: typeof import('./targets') = require('./targets')
    const rec = bot._ndReflexSession?.journal?.state?.places?.[T.SPAWNER_PLACE]
    if (rec && /nether/.test(String(rec.dimension || '')) && me.distanceTo(new (require('vec3').Vec3)(rec.x + 0.5, rec.y + 0.5, rec.z + 0.5)) <= 14) return true
    if (T.visibleSpawner(bot, bot.registry, 14)) return true
    return T.liveBlazes(bot, dead, 16).length >= 3
  } catch { return true }
}
// Обёртки рук на время глотка (ND_BLZ_DRINK_HOLD): одна установка на тело, счётчик вложенных глотков, снятие — когда последний кончился.
function drinkHold (bot) {
  const st = bot._ndDrinkHold ||= { depth: 0, orig: null, mine: new Set(), who: [], muted: 0, pendingGoal: null, ours: false }
  if (st.depth++ === 0) {
    st.mine = new Set(); st.who = []; st.muted = 0; st.pendingGoal = null; st.ours = false
    const o = st.orig = { equip: bot.equip, setQuickBarSlot: bot.setQuickBarSlot, moveSlotItem: bot.moveSlotItem, deactivateItem: bot.deactivateItem,
      activateItem: bot.activateItem, setGoal: bot.pathfinder?.setGoal }
    const caller = (tag: string) => { if (st.who.length < 4) st.who.push(tag + ': ' + String(new Error().stack || '').split('\n').slice(3, 6).map(l => l.trim().replace(/^at /, '').replace(/\(.*[\\/](dist-blz|daemon)[\\/]/, '(')).join(' < ')) }
    if (typeof o.equip === 'function') bot.equip = async (item, dest, ...rest) => {
      if (st.mine.has(item) || dest === 'off-hand') { st.ours = true; try { return await o.equip.call(bot, item, dest, ...rest) } finally { st.ours = false } }
      caller('equip ' + (item?.name || item)); st.muted++
    }
    if (typeof o.setQuickBarSlot === 'function') bot.setQuickBarSlot = (...a) => { if (st.ours) return o.setQuickBarSlot.apply(bot, a); caller('slot ' + a[0]); st.muted++ }
    if (typeof o.moveSlotItem === 'function') bot.moveSlotItem = async (...a) => { if (!st.ours) caller('move ' + a.join('>')); return o.moveSlotItem.apply(bot, a) }
    if (bot.pathfinder && typeof o.setGoal === 'function') bot.pathfinder.setGoal = (g, ...r) => { if (g == null) { st.pendingGoal = null; return o.setGoal.call(bot.pathfinder, g, ...r) } st.pendingGoal = [g, ...r]; caller('goal'); st.muted++ }
    if (typeof o.deactivateItem === 'function') bot.deactivateItem = () => { st.muted++ }
    if (typeof o.activateItem === 'function') bot.activateItem = (offHand?: boolean) => { if (!offHand) return o.activateItem.call(bot, offHand); st.muted++ }
  }
  let done = false
  return {
    orig: st.orig, mine: st.mine, who: st.who, muted: () => st.muted,
    release () {
      if (done) return
      done = true
      if (--st.depth > 0) return
      const o = st.orig
      bot.equip = o.equip; bot.setQuickBarSlot = o.setQuickBarSlot; bot.moveSlotItem = o.moveSlotItem; bot.deactivateItem = o.deactivateItem; bot.activateItem = o.activateItem
      if (bot.pathfinder && o.setGoal) { bot.pathfinder.setGoal = o.setGoal; if (st.pendingGoal) { try { o.setGoal.apply(bot.pathfinder, st.pendingGoal) } catch {} } }
      st.pendingGoal = null
    }
  }
}
async function drinkFireResistance (bot, { renew = false }: any = {}) {
  if (hasEffect(bot, 'fire_resistance') && !renew) return 'уже действует'
  const { potionOf }: typeof import('../pvp') = require('../pvp')
  const pot = bot.inventory.items().find(i => i.name === 'potion' && /fire_resistance$/.test(potionOf(i) || ''))
  if (!pot) {
    // Взрывное из бартера (8 из 469, как и обычное): бросить себе под ноги —
    // в центре облака действие полное (ThrownPotion: 1 − расстояние/4).
    const splash = bot.inventory.items().find(i => i.name === 'splash_potion' && /fire_resistance$/.test(potionOf(i) || ''))
    if (!splash) return null
    try {
      await bot.equip(splash, 'hand')
      await bot.look(bot.entity.yaw, -Math.PI / 2, true)
      bot.activateItem()
      await sleep(250)
      bot.deactivateItem()
      bot._ndFrUntil = gameClock.now() + 3600 * 50 - 2000
      return 'выпил fire_resistance'
    } catch (e) {
      return `взрывное не бросил: ${e.message}`
    }
  }
  const count = () => bot.inventory.items().filter(i => i.name === 'potion' && /fire_resistance$/.test(potionOf(i) || '')).reduce((n, i) => n + i.count, 0)
  // Выпито — по пустому флакону: зелье, переложенное в левую руку (автопилот, consumable-hands), тоже убывает из items(), а не выпито
  // (cn02-s19-1 21.10: «2 → 1», в руке ведро, шары жгли сразу).
  const bottles = () => bot.inventory.slots.reduce((n, i) => n + (i && i.name === 'glass_bottle' ? i.count : 0), 0)
  const before = count(), bottles0 = bottles()
  const drunk = () => bottles() > bottles0
  let error = null
  // Рука — зелью: путь pathfinder'а копает/ставит и меняет предмет в руке посреди глотка («Food is full» — consume видел кирку;
  // cm12-s19-1 21.10), щит в левой руке перебивает использование. Стоп хода и до двух попыток.
  try { bot.pathfinder?.setGoal?.(null) } catch {}
  try { if (bot.targetDigBlock) bot.stopDigging() } catch {}
  // Автопилот (еда, «горю → зелье», ведро) на время глотка — в сторону: session.eating его останавливает (cn03-s19-1: в руке ведро).
  const sess = bot._ndReflexSession, eating0 = sess?.eating
  if (sess) sess.eating = true
  // ND_BLZ_DRINK_HOLD=1: глоток рвали чужие руки (n53–n69, лог who): pathfinder (monitorMovement → equip блока под ноги и «использовать»
  // с зельем), клатч (clutch/guard-fire setQuickBarSlot), щит ne-guard/react и отбой шара swat (deactivateItem). Не выпито — 18–77 смен
  // руки за глоток, выпито — 2–3. На время глотка: чужой equip в руку и выбор слота — нет, чужая цель пути — отложить до конца глотка,
  // «отпустить предмет» и левая рука — не слушать. Обёртки — на теле одна на все глотки сразу (счётчик): второй глоток поверх первого
  // (клатч «лава внизу» посреди глотка боя) не должен сохранить чужую обёртку как «настоящую» и оставить её навсегда.
  const hold = process.env.ND_BLZ_DRINK_HOLD === '1'
  let held = 0
  const onHeld = () => { held++ }
  bot.on?.('heldItemChanged', onHeld)
  const H = hold ? drinkHold(bot) : null
  const deact = H ? H.orig.deactivateItem : bot.deactivateItem
  try {
  for (let k = 0; k < 2 && !drunk(); k++) {
    try {
      const it = bot.inventory.items().find(i => i.name === 'potion' && /fire_resistance$/.test(potionOf(i) || ''))
      if (!it) break
      try { deact.call(bot) } catch {}
      H?.mine.add(it)
      await bot.equip(it, 'hand')
      if (bot.heldItem?.name !== 'potion') { await sleep(100); continue }
      await bot.consume()
    } catch (e) { error = e.message }
    // Слот после глотка приходит отдельным пакетом и бывает позже конца consume (cm12: «before 2, after 2» — зелье ушло, срок не
    // поставлен, второе выпито зря): подождать до 10 тиков.
    // ND_BLZ_DRINK_HOLD: consume() mineflayer кончается раньше глотка на любой смене руки (heldItemChanged — и при досылке слота сервером:
    // подбор, полная синхронизация инвентаря), а повтор сперва «отпускает предмет» — сервер бросал глоток и начинал заново (held 21–25
    // без единого чужого вызова: rg-s19-2, df02, bA1). Зелье ещё в руке — ждать конца глотка по часам игры (32 тика + запас), не повторять.
    const waitMs = H && bot.heldItem?.name === 'potion' ? 2000 : 500
    for (let i = 0; i < waitMs / 50 && !drunk(); i++) await sleep(50)
  }
  } finally { if (sess) sess.eating = eating0; H?.release(); bot.removeListener?.('heldItemChanged', onHeld) }
  const after = count(), ok = drunk()
  if (ok) bot._ndFrUntil = gameClock.now() + 3600 * 50 - 2000
  // Разбор (cl14/cm12 21.10): выпито ли на самом деле.
  console.log('[blaze] огнестойкость', JSON.stringify({ before, after, ok, renew, error, held, ...(H ? { muted: H.muted(), ...(H.who.length ? { who: H.who } : {}) } : {}), until: bot._ndFrUntil ? Math.round((bot._ndFrUntil - gameClock.now()) / 1000) : null, hand: bot.heldItem?.name }))
  return ok ? 'выпил fire_resistance' : `зелье не выпил: ${error || 'глоток не прошёл'}`
}

export { hasEffect, drinkable, drinkFireResistance, drinkHold, frCount, frSpendOk }
