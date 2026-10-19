'use strict'
import { goals } from 'mineflayer-pathfinder'
import { sleep, flat, v3, keyOf, count } from './common'
import { BEDS, CONTAINER_NAMES, DOOR_NAMES, KINDS } from './kinds'
import { lootedSet } from './memory'
import { walk, canReach, digAt, pickUp, clearMobs, piglinsNear, seenNear, containersNear } from './site'
import { digToSee, digDown, ladderDown } from './dig'

// ------------------------------------------------------------------ обработчики

const HANDLERS = {
  // Данж и шахта: мобов — перебить, спавнер — сломать (ифритов не трогаем).
  async spawner (session, ctl, rec, out) {
    const bot = session.bot
    await clearMobs(session, ctl, out)
    const sp = bot.findBlocks({ matching: [bot.registry.blocksByName.spawner.id], point: v3(rec), maxDistance: KINDS[rec.kind].lootR, count: 4 })
    for (const s of sp) {
      if (ctl.aborted) break
      const hasPick = count(bot, /_pickaxe$/) > 0
      if (!hasPick) { out.lines.push('⚠ спавнер цел: без кирки ломать 25 с — лутаю быстро'); break }
      const r = await digAt(session, ctl, s, { maxMs: 12000 })
      out.disarmed.push(r.ok ? `спавнер ${s.x},${s.y},${s.z} сломан — мобы больше не появятся` : `спавнер не сломал: ${r.why}`)
      await clearMobs(session, ctl, out, { rounds: 2 })
    }
  },

  // Пустынный храм (DesertPyramidPiece 1.21.11): под центром пола (синяя терракота) шахта 3×3 в 11 блоков, на её дне
  // нажимная плита над 9 TNT, сундуки — в нишах в 2 блоках от плиты по сторонам света. Как спидраннер: встать на пол над
  // нишей сундука и копать под собой — колодец кончается на крышке сундука, плита в стороне; оттуда видно и плиту
  // (снять рукой: сломать можно, наступить — нет), и остальные три ниши. Без шаблона — только видимое (X-ray плиты убран).
  async desert (session, ctl, rec, out, p) {
    const bot = session.bot
    const tf = rec.tf
    const chests = ((tf && tf.chests) || []).filter(c => !lootedSet(session).has(keyOf(c)))
    if (!chests.length) { out.lines.push(tf ? '▸ сундуки храма уже взяты' : '▸ храм не узнан по шаблону — только видимое'); return }
    const me = bot.entity.position
    const c = chests.sort((a, b) => me.distanceTo(v3(a)) - me.distanceTo(v3(b)))[0]
    // Пол над нишей — на 11 выше сундука (локальные y кода: сундук −11, пол 0); встать на него, в столб сундука.
    try { await walk(session, ctl, new goals.GoalBlock(c.x, c.y + 12, c.z), 60000) } catch (e) { out.lines.push(`⚠ к полу над сундуком храма: ${e.message}`) }
    const f = bot.entity.position.floored()
    if (f.x !== c.x || f.z !== c.z) { out.lines.push('⚠ не встал над нишей сундука — без колодца'); return }
    const d = await digDown(session, ctl, { maxDepth: 14 })
    out.lines.push(d.chest ? `▸ храм: колодец над нишей до сундука ${d.chest.x},${d.chest.y},${d.chest.z} (${d.dug} бл.)` : `⚠ колодец храма: ${d.stopped || 'сундука под собой нет'}`)
    // Плита — без коллизии (луч прицела по коробке её не берёт): видна, если луч входит в её клетку (eyes.seesNow; клиент
    // целится по контуру — тонкая плитка). Стоять рядом с ней тоже нельзя: её TOUCH_AABB — почти вся клетка, рамка тела
    // у края соседней клетки в неё заходит (ферма 14.10, храм 352,794: шаг к дальнему сундуку — взрыв 9 TNT).
    const plate = tf.extra && tf.extra.plate
    let gone = false
    if (plate && (require('../perception/eyes') as typeof import('../perception/eyes')).seesNow(bot, plate)) {
      const b = bot.blockAt(v3(plate))
      if (b && b.name === 'stone_pressure_plate') {
        const r = await digAt(session, ctl, plate, { maxMs: 4000, walkMs: 0 })
        if (r.ok) { gone = true; out.disarmed.push('нажимная плита над 9 TNT снята руками (ломать можно, наступать — нет)'); rec.plate = plate }
      } else if (b) gone = true // плиты уже нет
    }
    if (!gone) {
      rec.stay = true
      // Плита цела — по камере не ходить: только сундуки в досягаемости отсюда.
      const eye = bot.entity.position.offset(0, 1.62, 0)
      const near = c => eye.distanceTo(v3(c).offset(0.5, 0.5, 0.5)) <= 4.3
      const far = tf.chests.filter(c => !near(c))
      if (far.length) out.lines.push(`⚠ плита над TNT цела — дальние сундуки храма (${far.length}) не беру`)
      rec.tf = { ...tf, chests: tf.chests.filter(near) }
    }
  },

  // Храм в джунглях (JungleTemplePiece): два сундука в подвале — за рычагами и в конце коридора с растяжками у раздатчиков.
  // Сундуки — по шаблону, к ним — копать по лучу; нить и крючки не копаются и пути их обходят (TRAP_BLOCKS). Видимые
  // растяжки шаблона: ножницы — срезать (TripWireBlock: ножницы ставят DISARMED), без них — сломать крюк (не стреляет).
  async jungle (session, ctl, rec, out) {
    const bot = session.bot
    const pick: typeof import('../pick') = require('../pick')
    const traps = ((rec.tf && rec.tf.extra && rec.tf.extra.traps) || []).filter(q => pick.blockSeen(bot, v3(q), { range: 24 }))
    const shears = bot.inventory.items().find(i => i.name === 'shears')
    let n = 0
    for (const q of traps) {
      if (ctl.aborted) break
      const b = bot.blockAt(v3(q))
      if (!b || (shears ? b.name !== 'tripwire' : b.name !== 'tripwire_hook')) continue
      const r = await digAt(session, ctl, q, { tool: shears ? 'shears' : null, maxMs: 4000 })
      if (r.ok) n++
    }
    if (n) out.disarmed.push(shears ? `нить растяжек срезана ножницами: ${n}` : `крюки растяжек сломаны: ${n} (нить без ножниц стреляет)`)
  },

  // Иглу (IglooPieces): подвал в половине; люк — под ковром в полу (3,0,5 верха); подвала нет — там снег (postProcess).
  // Войти, снять ковёр над люком, посмотреть: люк — открыть, вниз по лестнице, сундук лаборатории — по шаблону.
  async igloo (session, ctl, rec, out) {
    const bot = session.bot
    const b = rec.tf && rec.tf.extra && rec.tf.extra.igloo
    if (!b) return
    rec.tf.chests = []
    if (!await digToSee(session, ctl, b.carpet, { ms: 30000 })) { out.lines.push('⚠ иглу: до ковра над люком не добрался'); return }
    const carpet = bot.blockAt(v3(b.carpet))
    if (carpet && /_carpet$/.test(carpet.name)) await digAt(session, ctl, b.carpet, { maxMs: 2000, walkMs: 1 })
    if (!(require('../pick') as typeof import('../pick')).blockSeen(bot, v3(b.hatch), { range: 4.6 })) { out.lines.push('⚠ иглу: люка не вижу'); return }
    const hatch = bot.blockAt(v3(b.hatch))
    if (!hatch || !/_trapdoor$/.test(hatch.name)) { out.lines.push(`▸ иглу без подвала: под ковром ${hatch ? hatch.name : '—'}`); return }
    // Люк — открыть: открытый люк над лестницей той же стороны (igloo/top: oak_trapdoor facing=north, лестницы north) —
    // тоже лестница, наверх через него (сломанный — наверху нет опоры: ферма 14.10, иглу 163,-218 — 25 с на краю).
    // Створка занимает 3/16 клетки: вниз — в середину свободной части (ladderDown); не провалился — сломать люк.
    try { if (String(hatch.getProperties().open) === 'false') { await bot.activateBlock(hatch); await sleep(300) } } catch {}
    const y0 = Math.floor(bot.entity.position.y)
    rec.ladderUp = { x: b.hatch.x, y: b.hatch.y, z: b.hatch.z } // наверх — и после неудачного спуска
    let bottom = await ladderDown(session, ctl, b.hatch, 30000)
    if (bottom === null && !ctl.aborted && (await digAt(session, ctl, b.hatch, { maxMs: 6000, walkMs: 1 })).ok) bottom = await ladderDown(session, ctl, b.hatch, 30000)
    if (bottom === null || bottom > y0 - 8) { out.lines.push('⚠ иглу: по лестнице вниз не спустился'); return }
    out.lines.push(`▸ иглу: подвал, спустился на ${y0 - bottom} бл.`)
    rec.tf.chests = [{ x: b.chest.x, y: bottom, z: b.chest.z, table: b.chest.table, p: 1 }]
  },

  // Руины портала: сундук, потом золотые блоки (бартер) и счёт обсидиана.
  async portal () {},
  // Сундуки деревни — в домах, снаружи их не видно (ферма 14.10, сид 6520139407132075259: три сундука в 20–38 бл. от центра, глаза —
  // ни одного, «пирог» видит). Как игрок: к видимым дверям домов, открыть, заглянуть — сундук внутри попадает в глаза, дальше
  // общий лут. До 6 дверей, ближние первыми; хватит, как только виден неоткрытый сундук.
  async village (session, ctl, rec, out, p) {
    const bot = session.bot
    const R = rec.lootR || KINDS.village.lootR
    const fresh = () => containersNear(session, rec, R, rec.yR || 16).filter(q => !lootedSet(session).has(keyOf(q)))
    // Дома узнаны по шаблонам — где сундуки, известно (общий лут копает к ним); заглядывать в двери не нужно. Узнано 3+ дома и
    // ни в одном сундука нет — тоже (обход дверей — 25–129 с, cs-7 14.10: 146 с впустую).
    if (fresh().length || (rec.tf && (rec.tf.chests.length || (rec.tf.extra && rec.tf.extra.houses >= 3)))) return
    const doors = seenNear(bot, DOOR_NAMES, rec, R, 24).filter(d => (bot.blockAt(d)?.getProperties?.().half ?? 'lower') === 'lower')
      .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position)).slice(0, 6)
    let peeked = 0
    for (const d of doors) {
      if (ctl.aborted || fresh().length) break
      try { await walk(session, ctl, new goals.GoalNear(d.x, d.y, d.z, 1), 20000) } catch { continue }
      const door = bot.blockAt(d)
      try { if (door && String(door.getProperties?.().open) === 'false') { await bot.activateBlock(door); await sleep(300) } } catch {}
      try { (require('../perception/eyes') as typeof import('../perception/eyes')).nearest(bot, CONTAINER_NAMES, { fresh: true, max: 1 }) } catch {}
      peeked++
    }
    if (peeked) out.lines.push(`▸ деревня: заглянул в ${peeked} двер. — сундуков на виду ${fresh().length}`)
  },

  // Бастион: брутья — отказ без force; открытие сундуков проверяет глаза пиглинов.
  async bastion (session, ctl, rec, out, p) {
    const bot = session.bot
    const brutes = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'piglin_brute' && e.position && e.position.distanceTo(bot.entity.position) < 24)
    const gold = count(bot, /^golden_(helmet|chestplate|leggings|boots)$/) > 0
    const worn = [5, 6, 7, 8].some(s => bot.inventory.slots[s] && /^golden_/.test(bot.inventory.slots[s].name))
    if ((brutes.length || !worn) && !p.force) {
      out.lines.push(`⚠ бастион: ${brutes.length ? `брутьев рядом ${brutes.length} — бьют всегда` : ''}${!worn ? `${brutes.length ? '; ' : ''}золотой брони на мне нет${gold ? ' (в рюкзаке есть — надень)' : ''} — пиглины нападут` : ''}. Не лезу; force:true — на свой страх`)
      out.abort = true
    }
  },

  // Город Края: элитры в рамке на корабле — ударить рамку, подобрать.
  async endcity (session, ctl, rec, out) {
    const bot = session.bot
    for (const e of ((Object.values(bot.entities) as any[]) as any)) {
      if (ctl.aborted) break
      if (!e || !/item_frame$/.test(e.name || '') || !e.position) continue
      if (flat(e.position, rec) > 60 || frameItem(bot, e) !== 'elytra') continue
      try {
        await walk(session, ctl, new goals.GoalNear(e.position.x, e.position.y, e.position.z, 2), 60000)
        await bot.lookAt(e.position, true)
        bot.attack(e)
        await sleep(400)
        await pickUp(bot, ctl, 5, 5000)
        out.disarmed.push(count(bot, 'elytra') ? 'элитры сняты с рамки' : 'рамку ударил, элитр в рюкзаке нет')
      } catch (err) { out.lines.push(`⚠ элитры: ${err.message}`) }
    }
  },

  async generic () {},
  async avoid () {}
}

// Что в рамке: предмет в метаданных сущности.
function frameItem (bot, e) {
  for (const v of ((Object.values(e.metadata || {}) as any[]) as any)) {
    if (!v || typeof v !== 'object') continue
    const id = v.itemId ?? v.blockId ?? (v.present && v.itemId)
    if (typeof id === 'number' && bot.registry.items[id]) return bot.registry.items[id].name
  }
  return null
}

// После сундуков: добыча вне сундуков по виду постройки.
async function extras (session, ctl, rec, out, p) {
  const bot = session.bot
  const R = bot.registry.blocksByName
  // Пустынный храм: 9 TNT под плитой. Плита снята — копать безопасно
  // (TNT от кирки не взрывается).
  if (rec.kind === 'desert_pyramid' && rec.plate && p.tnt === true) { // TNT спидрану не нужен (дракон — кроватями): только по просьбе
    const pp = v3(rec.plate)
    const feet = bot.entity.position.floored()
    let tnt = 0
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (ctl.aborted) break
        const col = pp.offset(dx, 0, dz)
        if (col.x === feet.x && col.z === feet.z) continue
        const t = pp.offset(dx, -2, dz)
        const tb = bot.blockAt(t)
        if (!tb || tb.name !== 'tnt') continue
        const fl = pp.offset(dx, -1, dz)
        const fb = bot.blockAt(fl)
        if (fb && fb.boundingBox === 'block' && canReach(bot, fl)) await digAt(session, ctl, fl, { maxMs: 4000, walkMs: 1 })
        if (canReach(bot, t)) { const r = await digAt(session, ctl, t, { maxMs: 2000, walkMs: 1 }); if (r.ok) tnt++ }
      }
    }
    if (tnt) {
      // Шашки упали в яму на 2 ниже — спуститься и собрать.
      try { await walk(session, ctl, new goals.GoalNear(pp.x, pp.y - 2, pp.z, 1), 8000) } catch {}
      await pickUp(bot, ctl, 4, 5000)
      out.disarmed.push(`TNT из-под плиты: ${tnt} шашек выкопано (${count(bot, 'tnt')} в рюкзаке)`)
    }
  }
  // Руины портала: золотые блоки (1 блок = 9 слитков на бартер) и счёт обсидиана.
  if (rec.kind === 'ruined_portal' || rec.kind === 'ruined_portal_nether') {
    const gold = seenNear(bot, ['gold_block'], rec, 12, 6)
    if (gold.length && count(bot, /^(iron|diamond|netherite)_pickaxe$/) > 0 && p.gold !== false && !(rec.kind === 'ruined_portal_nether' && piglinsNear(bot).length)) {
      let n = 0
      for (const g of gold) { if (ctl.aborted) break; const r = await digAt(session, ctl, g, { maxMs: 8000 }); if (r.ok) n++ }
      await pickUp(bot, ctl, 6, 5000)
      if (n) out.disarmed.push(`золотых блоков: ${n} (×9 слитков — бартер с пиглинами за жемчуг)`)
    }
    const obs = seenNear(bot, ['obsidian'], rec, 12, 64).length
    const cry = seenNear(bot, ['crying_obsidian'], rec, 12, 64).length
    const have = count(bot, 'obsidian')
    const dpick = count(bot, /^(diamond|netherite)_pickaxe$/) > 0
    const lighter = count(bot, /^(flint_and_steel|fire_charge)$/) > 0
    rec.note = `обсидиан: в рамке ${obs}, плачущий ${cry} (для рамки не годится), в рюкзаке ${have}`
    out.portal = { frameObsidian: obs, crying: cry, bagObsidian: have, need: 10, diamondPick: dpick, lighter }
    out.lines.push(have >= 10
      ? `▸ обсидиана ${have} — хватит на рамку 4×5 без углов (10); ${lighter ? 'огниво есть' : 'огниво: железо + кремень'} → mc_portal`
      : dpick
        ? `▸ обсидиан: ${have} в рюкзаке + ${obs} в рамке руин (алмазная кирка есть — выкопать) → на рамку нужно 10`
        : `▸ обсидиан: ${have} из 10; рамку руин без алмазной кирки не выкопать — достроить отливкой из лавы ведром воды (mc_obsidian), ${cry} плачущих не годятся`)
  }
  // Деревня: кровати (ночь, дракон), сено на хлеб, спелые грядки.
  if (rec.kind === 'village') {
    const beds = count(bot, /_bed$/)
    const want = Math.max(0, (p.beds ?? 3) - beds)
    if (want > 0) {
      const found = seenNear(bot, BEDS.filter(n => R[n]), rec, KINDS.village.lootR, 16)
      const heads = []
      for (const q of found) {
        const b = bot.blockAt(q)
        let part = null
        try { part = b.getProperties().part } catch {}
        if (part === 'head' || part === null) heads.push(q)
      }
      let got = 0
      for (const h of heads) {
        if (ctl.aborted || got >= want) break
        if ((Object.values(bot.entities) as any[]).some((e : any) => e && e.name === 'villager' && e.position && e.position.distanceTo(h) < 1.5)) continue
        const before = count(bot, /_bed$/)
        const r = await digAt(session, ctl, h, { maxMs: 3000 })
        if (r.ok) { await pickUp(bot, ctl, 4, 4000); if (count(bot, /_bed$/) > before) got++ }
      }
      if (got) out.disarmed.push(`кроватей из домов: ${got} (стало ${count(bot, /_bed$/)}) — ночь и взрывы у дракона`)
    }
    const edible = count(bot, /^(bread|cooked_[a-z_]+|baked_potato|golden_carrot|apple|carrot)$/)
    if (edible < 16 && p.food !== false) {
      const hay = seenNear(bot, ['hay_block'], rec, KINDS.village.lootR, 3)
      let n = 0
      for (const h of hay.slice(0, 2)) { if (ctl.aborted) break; const r = await digAt(session, ctl, h, { maxMs: 3000 }); if (r.ok) n++ }
      const crops = []
      for (const [name, ripe] of [['wheat', 7], ['carrots', 7], ['potatoes', 7], ['beetroots', 3]]) {
        if (!R[name]) continue
        for (const q of seenNear(bot, [name], rec, 48, 24)) {
          const b = bot.blockAt(q)
          let age: any = -1
          try { age = b.getProperties().age } catch {}
          if (age >= ripe) crops.push(q)
        }
      }
      let c = 0
      for (const q of crops.slice(0, 12)) { if (ctl.aborted) break; const r = await digAt(session, ctl, q, { maxMs: 1500 }); if (r.ok) c++ }
      await pickUp(bot, ctl, 8, 6000)
      if (n || c) out.disarmed.push(`еда: сена ${n} (×9 пшеницы = 3 хлеба), спелых грядок ${c}`)
    }
  }
}

export { HANDLERS, extras }
