'use strict'
const gameClock = require('./game-clock')
const { sleep } = require('./movement')
const { Vec3 } = require('vec3')

const log = (what, o) => console.log('[guard]', new Date().toTimeString().slice(0, 8), what, JSON.stringify(o))
// Стрелки — со своими ответами; ближний удар блейза также требует стража.
const MELEE = /^(piglin|piglin_brute|hoglin|zoglin|zombified_piglin|wither_skeleton|magma_cube|zombie|husk|vindicator)$/
// Blaze melee is dangerous even under fire resistance; distant fireballs stay
// with the ranged/fire handler. Protect crafting and walking after farmRods too.
const meleeName = n => MELEE.test(n || '') || (process.env.ND_GUARD_BLAZE !== '0' && n === 'blaze')
const HIDE_FROM = /^(piglin_brute|hoglin|zoglin)$/

function metaOf (bot, e, key) {
  try { const keys = bot.registry.entitiesByName[e.name].metadataKeys; const i = keys.indexOf(key); return i >= 0 ? e.metadata[i] : undefined } catch { return undefined }
}
// mob_flags бит 2 — «агрессивен» (ATTACK_TARGET у пиглинов, бруты/хоглины — при цели).
const aggressive = (bot, e) => ((Number(metaOf(bot, e, 'mob_flags')) || 0) & 4) !== 0
const isBaby = (bot, e) => !!metaOf(bot, e, 'baby')
function sees (bot, e) {
  try { const P = require('./perception'); return P.raySees(bot, P.eyePos(bot), e.position.offset(0, (e.height || 1.9) * 0.6, 0)) } catch { return true }
}

function worldIsNether (bot) { try { return require('./worlds').worldOf(bot) === 'the_nether' } catch { return false } }
// Сессия тела для сторожа (react без вызывающего). Зовут bastion/routeTo/farmRods на входе.
function attach (session) {
  const g = install(session && session.bot)
  if (g) {
    g.session = session
    if (require('./reflex-lock').on()) require('./reflex-lock').install(session)
  }
  return g
}
function install (bot) {
  if (!bot || !bot._client) return null
  if (bot._ndGuard) return bot._ndGuard
  const g: any = { hits: [] }
  const onDmg = pk => {
    try {
      if (!pk || !bot.entity || pk.entityId !== bot.entity.id) return
      const src = bot.entities[(pk.sourceCauseId ?? 0) - 1] || bot.entities[(pk.sourceDirectId ?? 0) - 1]
      if (!src || !src.position || src === bot.entity) return
      g.hits.push({ t: gameClock.now(), id: src.id, name: src.name || src.type, d: +src.position.distanceTo(bot.entity.position).toFixed(1) })
      if (/piglin/.test(src.name || '')) g.angerAt = gameClock.now()
      if (g.session?.tactics?.enabled()) {
        g.session.tactics.requestGuard().catch(() => null)
        if (g.hits.length > 24) g.hits.shift()
        return
      }
      // First attack, not second: own the hands before a health packet/craft
      // continuation arrives. The original intent remains alive under the lock.
      if (require('./reflex-lock').on() && g.session && g.session.bot === bot && worldIsNether(bot) && meleeName(src.name || '') && (src.name !== 'blaze' || src.position.distanceTo(bot.entity.position) < 3.5)) {
        react(g.session, g.session.current?.ctl || { aborted: false, onAbort: [] }, {
          force: { e: src, why: 'первый удар ' + src.name }, triggerAt: g.hits.at(-1).t
        }).catch(() => null)
        if (g.hits.length > 24) g.hits.shift()
        return
      }
      // Щит-рефлекс (ND_GUARD=1): удар ближнего моба, а ответ ещё не начат (тело считает план/крафтит/копает) — сразу
      // взгляд на него и щит на 1.2 с: удар меча пиглина щит снимает целиком, топор брута — первый (потом щит выбит на 5 с).
      if (process.env.ND_GUARD !== '0' && !g.reacting && meleeName(src.name || '') && src.position.distanceTo(bot.entity.position) < 4.5 && (src.name !== 'blaze' || src.position.distanceTo(bot.entity.position) < 3.5) &&
        bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield' && gameClock.now() - (g.shieldAt || 0) > 1500) {
        g.shieldAt = gameClock.now()
        bot.lookAt(src.position.offset(0, (src.height || 1.9) * 0.8, 0), true).catch(() => {})
        try { bot.activateItem(true) } catch {}
        gameClock.setTimeout(() => { try { if (!g.reacting && gameClock.now() - g.shieldAt >= 1100) bot.deactivateItem() } catch {} }, 1200)
      }
      if (g.hits.length > 24) g.hits.shift()
      // Сторож (ND_GUARD=1): второй удар ближнего моба за 4 с, а ответа нет (дело тела — ходьба к точке обзора, ожидание,
      // план — без проверок стража: B1-32 03.10, хоглин 7 ударов за 13 с при обходе бастиона) — ответ сам, мимо цикла дела.
      if (process.env.ND_GUARD !== '0' && !g.reacting && g.session && meleeName(src.name || '') && worldIsNether(bot) && (src.name !== 'blaze' || src.position.distanceTo(bot.entity.position) < 3.5)) {
        const now = gameClock.now()
        const recent = g.hits.filter(h => now - h.t < 4000 && meleeName(h.name || '') && (h.name !== 'blaze' || h.d < 3.5)).length
        if (recent >= 2 && now - (g.autoAt || 0) > 6000) {
          g.autoAt = now
          const ctl = { aborted: false, onAbort: [] }
          const onDeath = () => { ctl.aborted = true; for (const f of ctl.onAbort) { try { f() } catch {} } }
          bot.once('death', onDeath)
          log('сторож: ответа нет — отвечаю сам', { foe: src.name, hits: recent, hp: Math.round(bot.health ?? 0) })
          react(g.session, ctl, { force: { e: src, why: 'сторож: ' + src.name } }).catch(() => null).finally(() => bot.removeListener('death', onDeath))
        }
      }
    } catch {}
  }
  bot._client.on('damage_event', onDmg)
  // Крупный удар (≥ 6 хп за раз) от ближнего моба за последнюю секунду — сторож сразу, не ждать второго.
  let hp0 = bot.health ?? 20
  const onHealth = () => {
    try {
      const hp = bot.health ?? 20
      const drop = hp0 - hp
      hp0 = hp
      if (g.session?.tactics?.enabled()) { g.session.tactics.update(true); return }
      if (drop < 6 || process.env.ND_GUARD === '0' || g.reacting || !g.session || !worldIsNether(bot)) return
      const last = g.hits[g.hits.length - 1]
      if (!last || gameClock.now() - last.t > 1000 || !meleeName(last.name || '') || gameClock.now() - (g.autoAt || 0) < 6000) return
      const src = bot.entities[last.id]
      if (!src || !src.position || src.position.distanceTo(bot.entity.position) > 5.5 || (src.name === 'blaze' && src.position.distanceTo(bot.entity.position) >= 3.5)) return
      g.autoAt = gameClock.now()
      const ctl = { aborted: false, onAbort: [] }
      const onDeath = () => { ctl.aborted = true; for (const f of ctl.onAbort) { try { f() } catch {} } }
      bot.once('death', onDeath)
      log('сторож: крупный удар — отвечаю сам', { foe: src.name, drop: Math.round(drop), hp: Math.round(hp) })
      react(g.session, ctl, { force: { e: src, why: 'сторож: ' + src.name } }).catch(() => null).finally(() => bot.removeListener('death', onDeath))
    } catch {}
  }
  bot.on('health', onHealth)
  const GUARDED = /^(gold_block|raw_gold_block|gilded_blackstone|chest|trapped_chest|barrel|ender_chest|gold_ore|deepslate_gold_ore|nether_gold_ore|[a-z_]*shulker_box|[a-z_]*copper_chest[a-z_]*)$/
  const onDug = b => { try { if (b && GUARDED.test(b.name || '')) g.angerAt = gameClock.now() } catch {} }
  const onWin = w => { try { if (w && /chest|barrel|shulker|generic_9x3|generic_9x6/i.test(String(w.type || ''))) g.angerAt = gameClock.now() } catch {} }
  bot.on('diggingCompleted', onDug)
  bot.on('windowOpen', onWin)
  const onTick = () => {
    if (g.session?.tactics?.enabled()) { g.session.tactics.update(); return }
    if (!require('./reflex-lock').on() || !g.session || g.session.bot !== bot || g.reacting || g.session.reflex || !worldIsNether(bot) || (bot.health ?? 0) <= 0) return
    const h = hot(bot)
    if (h) react(g.session, g.session.current?.ctl || { aborted: false, onAbort: [] }, { force: h }).catch(() => null)
  }
  const onReflex = o => log('reflex', o)
  bot.on('physicsTick', onTick)
  bot.on('nd_guard_reflex', onReflex)
  bot.once('end', () => { g.ended = true; try { bot._client.removeListener('damage_event', onDmg); bot.removeListener('health', onHealth); bot.removeListener('physicsTick', onTick); bot.removeListener('nd_guard_reflex', onReflex); bot.removeListener('diggingCompleted', onDug); bot.removeListener('windowOpen', onWin) } catch {} })
  bot._ndGuard = g
  return g
}

// Ближние враги в r: брут/хоглин/зоглин/иссушитель — всегда; пиглин и зомби-пиглин — только злые (не малыши).
function meleeFoes (bot, r = 6) {
  const me = bot.entity.position
  return Object.values(bot.entities || {}).filter((e : any) => {
    if (!e || !e.position || e === bot.entity || e.isValid === false) return false
    const n = e.name || ''
    if (!meleeName(n)) return false
    if (e.position.distanceTo(me) > r) return false
    if (n === 'piglin') return aggressive(bot, e) && !isBaby(bot, e) && angryAtUs(bot)
    if (n === 'zombified_piglin') return aggressive(bot, e) && !isBaby(bot, e)
    return true
  }).sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))
}

// Пиглины злы на нас: 32 с после ломки/открытия охраняемого или удара пиглина; без золотой брони — всегда.
function angryAtUs (bot) {
  const g = bot._ndGuard
  if (g && gameClock.now() - (g.angerAt || 0) < 32000) return true
  try { return ![5, 6, 7, 8].some(s => bot.inventory.slots[s] && /^golden_/.test(bot.inventory.slots[s].name)) } catch { return false }
}

// Кто бьёт или вот-вот ударит: удар ближнего моба за ms (он жив и в 5 бл.) — или брут/хоглин/зоглин злой и видимый
// ближе near, или злой пиглин ближе 2. null — тихо.
function hot (bot, { ms = 1500, near = 3.0 }: any = {}) {
  if (!bot || !bot.entity) return null
  const g = install(bot)
  const now = gameClock.now()
  if (g) {
    for (let i = g.hits.length - 1; i >= 0; i--) {
      const h = g.hits[i]
      if (now - h.t > ms) break
      if (!meleeName(h.name || '') || (h.name === 'blaze' && h.d >= 3.5)) continue
      const e = bot.entities[h.id]
      if (e && e.isValid !== false && e.position && e.position.distanceTo(bot.entity.position) < 5.5 && (e.name !== 'blaze' || e.position.distanceTo(bot.entity.position) < 3.5)) return { e, why: 'удар ' + e.name }
    }
  }
  const me = bot.entity.position
  // Брут/хоглин бегут ~3.5 бл/с, яма — ~1 с: злой и видимый в 5 бл. — уже пора (иссушитель — в 3.5).
  for (const e of (meleeFoes(bot, Math.max(near + 4, 7)) as any)) {
    const d = e.position.distanceTo(me)
    const lim = e.name === 'wither_skeleton' ? near + 0.5 : near + 4
    // Мы выше на 2.5+ (свой столб) — он не достаёт: не повод строить ещё (иначе столб растёт каждый план хода).
    if (e.name === 'blaze') {
      // No mob_flags prerequisite: BlazeAttackGoal has its own target logic.
      if (d <= 2.7 && require('./pick').canHit(bot, e)) return { e, why: 'блейз вплотную' }
      continue
    }
    if (me.y - e.position.y >= 2.5) continue
    if ((HIDE_FROM.test(e.name) || e.name === 'wither_skeleton') && d <= lim && aggressive(bot, e) && sees(bot, e)) {
      // Издали (> 3 бл.) по тому же — не чаще раза в 20 с, пока он не ударил: брут за окном закрытого штрека виден и зол,
      // а пути к нам нет — без предела ответ шёл бы перед каждым ходом (D6-22: «брут видит в штреке» ×19, 13 мин).
      if (d > 3 && g) { g.pre = g.pre || new Map(); if (now - (g.pre.get(e.id) || 0) < 20000) continue; g.pre.set(e.id, now) }
      return { e, why: `${e.name} в ${d.toFixed(1)} бл.` }
    }
    if (/^(piglin|zombified_piglin)$/.test(e.name) && d <= 2.2 && gameClock.now() - (g && g.reactEnd || 0) > 3000) {
      let can = false
      try { can = require('./pick').canHit(bot, e) } catch {}
      if (can) return { e, why: `злой ${e.name} в ${d.toFixed(1)} бл.` }
    }
  }
  return null
}

function sealOn () { return process.env.ND_GUARD_SEAL !== '0' }
function cls (bot, v) { return require('./sealed').classOf(bot.blockAt(v)) }
// Клетка — толща (твёрдое: можно копать и стоять, не руда-охрана, не гравий).
function solidish (k, SL) { return k === SL.SOLID || k === SL.HOT }
function wallOk (k, SL) { return k === SL.SOLID || k === SL.HARD || k === SL.GUARD || k === SL.HOT }
// Можно ли уйти вниз на n клеток из клетки ног f: клетки f−1..f−n — копаемая толща, пол под ними твёрдый, стенки у
// клеток f−1..f−n — твёрдые (не воздух — пещера, не лава), под полом не лава.
function holeOk (bot, f, n) {
  const SL = require('./sealed')
  for (let i = 1; i <= n; i++) {
    const v = f.offset(0, -i, 0)
    if (!solidish(cls(bot, v), SL)) return false
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (!wallOk(cls(bot, v.offset(dx, 0, dz)), SL)) return false
  }
  const fl = cls(bot, f.offset(0, -n - 1, 0))
  if (!(fl === SL.SOLID || fl === SL.HARD || fl === SL.GUARD || fl === SL.HOT)) return false
  if (cls(bot, f.offset(0, -n - 2, 0)) === SL.FLUID) return false
  return true
}

// «Вниз на 2» (+ третья и пробка, если можно). { ok, depth, capped, cells: ['x,y,z' …] }.
async function hideDown (session, ctl) {
  const bot = session.bot
  const SL = require('./sealed')
  for (let i = 0; i < 6 && !bot.entity.onGround; i++) await sleep(50)
  if (!bot.entity.onGround) return { ok: false, why: 'не на земле' }
  const p = bot.entity.position
  const f = p.floored()
  // Стоит на неполном блоке (плита) — клетка ног выше пола: так не копаем.
  if (p.y - f.y > 0.05) return { ok: false, why: 'не на полном блоке' }
  if (!holeOk(bot, f, 2)) return { ok: false, why: 'под ногами не толща' }
  try { bot.pathfinder && bot.pathfinder.setGoal(null) } catch {}
  bot.clearControlStates()
  const cells = []
  for (let i = 1; i <= 2; i++) {
    const v = f.offset(0, -i, 0)
    const r = await SL.digCell(bot, v)
    if (r !== 'ok' && r !== 'air') return { ok: i > 1, depth: i - 1, why: 'копка: ' + r, cells }
    cells.push(SL.keyV(v))
    const ok = await SL.stepMove(bot, ctl, { kind: 'vdown', to: { x: v.x, y: v.y, z: v.z } })
    if (!ok) return { ok: false, depth: i - 1, why: 'не опустился', cells }
  }
  // Третья копка и пробка над головой (от арбалета и огня): клетка f−3 — толща, пол под ней твёрдый.
  let capped = false
  let depth = 2
  if (SL.fillerCount(bot) >= 1 && holeOk(bot, f.offset(0, -2, 0), 1)) {
    const v = f.offset(0, -3, 0)
    const r = await SL.digCell(bot, v)
    if (r === 'ok' || r === 'air') {
      cells.push(SL.keyV(v))
      if (await SL.stepMove(bot, ctl, { kind: 'vdown', to: { x: v.x, y: v.y, z: v.z } })) {
        depth = 3
        capped = await SL.fillCell(bot, f.offset(0, -1, 0))
        if (capped) cells.splice(cells.indexOf(SL.keyV(f.offset(0, -1, 0))), 1)
      }
    }
  }
  return { ok: true, depth, capped, cells }
}

// Сидеть в яме/на столбе, пока ближние рядом (≤ ms), есть, если голодно. Сверху (столб) — мечом по видимым.
let lastSitSwing = 0
async function sit (session, ctl, ms, { swing = false, hitStop = false }: any = {}) {
  const bot = session.bot
  const t0 = gameClock.now()
  let quiet = 0
  let swings = 0
  const g = bot._ndGuard
  while (!ctl.aborted && gameClock.now() - t0 < ms && (bot.health ?? 0) > 0) {
    // Бьют сквозь «коробку» (диагональ, щель) — сидеть дальше нельзя (V2-1 03.10: брут на (−1,+1,−1) — 3 удара за 13 с, смерть).
    if (hitStop && g && g.hits.some(h => h.t > t0 + 300 && gameClock.now() - h.t < 1500 && meleeName(h.name || ''))) return { s: Math.round((gameClock.now() - t0) / 1000), swings, hit: true, left: meleeFoes(bot, 6).length }
    const foes = meleeFoes(bot, 6)
    if (!foes.length) { if (!quiet) quiet = gameClock.now(); if (gameClock.now() - quiet > 3000) break } else quiet = 0
    if (swing && foes.length) {
      const pick = require('./pick')
      const e: any = foes[0]
      if (pick.canHit(bot, e) && gameClock.now() - lastSitSwing > 640) {
        try {
          const sw = bot.inventory.items().filter(i => /_sword$/.test(i.name)).sort((a, b) => rank(b) - rank(a))[0]
          if (sw && (!bot.heldItem || bot.heldItem.name !== sw.name)) await bot.equip(sw, 'hand')
          await bot.lookAt(e.position.offset(0, (e.height || 1.9) * 0.7, 0), true)
          bot.attack(e); lastSitSwing = gameClock.now(); swings++
        } catch {}
      }
    }
    if ((bot.food ?? 20) < 18 && (bot.health ?? 20) < 18) { try { await require('./actions').eat(session, ctl, {}) } catch {} }
    await sleep(250)
  }
  return { s: Math.round((gameClock.now() - t0) / 1000), swings, left: meleeFoes(bot, 6).length }
}
const rank = i => /netherite/.test(i.name) ? 5 : /diamond/.test(i.name) ? 4 : /iron/.test(i.name) ? 3 : /stone/.test(i.name) ? 2 : 1

const EXTRA_FILL = ['crying_obsidian', 'nether_bricks', 'red_nether_bricks', 'gilded_blackstone', 'chiseled_polished_blackstone', 'polished_blackstone_brick_stairs', 'soul_soil', 'magma_block', 'end_stone', 'obsidian']
function guardItem (bot) {
  const SL = require('./sealed')
  const n = SL.fillerName(bot)
  if (n) return n
  const items = bot.inventory.items()
  for (const name of EXTRA_FILL) {
    const c = items.filter(i => i.name === name).reduce((k, i) => k + i.count, 0)
    if (name === 'obsidian' ? c > 10 : c > 0) return name
  }
  return null
}
function guardCount (bot) {
  const SL = require('./sealed')
  const items = bot.inventory.items()
  let k = SL.fillerCount(bot)
  for (const name of EXTRA_FILL) { const c = items.filter(i => i.name === name).reduce((m, i) => m + i.count, 0); k += name === 'obsidian' ? Math.max(0, c - 10) : c }
  return k
}
async function guardFill (bot, v) {
  const SL = require('./sealed')
  const b = bot.blockAt(v)
  if (b && SL.classOf(b) !== SL.AIR && SL.classOf(b) !== SL.PARTIAL) return sealOn() ? fullWall(b) : true
  const item = guardItem(bot)
  if (!item) return false
  try { const r = await require('./build').placeBlockAt(bot, v, { item, timeoutMs: 1500 }); return !!(r && r.ok) } catch { return false }
}

// Коробка вокруг тела: блоки в открытые клетки у ног и головы (4 стороны) и над головой, ближние к врагу — первыми.
// Клетка, где стоит сущность, — не заложить (ok:false, если открытой осталась). { ok, placed, left }.
function fullWall (b) {
  return !!b && b.boundingBox === 'block' && !/lava|water|fire/.test(b.name || '') &&
    Array.isArray(b.shapes) && b.shapes.some(a => a.length === 6 && a.every((n, i) => n === (i < 3 ? 0 : 1)))
}
function shellCells (f) {
  const cells = []
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) for (let y = 0; y <= 2; y++) {
    if (x || z || y === 2) cells.push(f.offset(x, y, z))
  }
  return cells
}
type InteriorHostile = { id: number, position: { x: number, y: number, z: number }, width?: number, height?: number }
function interiorHostiles (bot, f): InteriorHostile[] {
  return (meleeFoes(bot, 6) as InteriorHostile[]).filter(e => {
    const half = (e.width || .6) / 2
    if (e.position.x + half <= f.x || e.position.x - half >= f.x + 1 ||
      e.position.z + half <= f.z || e.position.z - half >= f.z + 1 ||
      e.position.y >= f.y + 2 || e.position.y + (e.height || 1.8) <= f.y) return false
    try { return !!require('./pick').aim(bot, e, { range: 6 })?.point } catch { return false }
  })
}
function sealedAt (bot, f) {
  const p = bot.entity.position; const half = (bot.entity.width || 0.6) / 2
  // Knockback can put the body into a neighbouring cell while placements still
  // finish around the old cell. A shell around that cell is no longer cover.
  return p.y >= f.y && p.y + (bot.entity.height || 1.8) <= f.y + 2 &&
    p.x - half >= f.x && p.x + half <= f.x + 1 && p.z - half >= f.z && p.z + half <= f.z + 1 &&
    shellCells(f).every(v => fullWall(bot.blockAt(v))) && interiorHostiles(bot, f).length === 0
}
async function boxIn (bot, foe = null, { diag = false, ctl = null }: any = {}) {
  const SL = require('./sealed')
  const cancelled = () => ctl?.aborted || bot._ndGuard?.ended || (bot.health ?? 20) <= 0
  if (cancelled()) return { ok: false, placed: 0, cancelled: true }
  if (guardCount(bot) < 2) return { ok: false, why: 'нечем' }
  const f = bot.entity.position.floored()
  const interiorPressure = placed => {
    const occupants = interiorHostiles(bot, f)
    return occupants.length ? { ok: false, placed, left: [SL.keyV(f)], pressure: true, interior: occupants.map(e => e.id) } : null
  }
  const initialPressure = interiorPressure(0)
  if (initialPressure) return initialPressure
  const cells = []
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1]) cells.push(f.offset(dx, dy, dz))
  cells.push(f.offset(0, 2, 0))
  if (diag) for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) for (const dy of [0, 1]) cells.push(f.offset(dx, dy, dz))
  if (sealOn()) cells.splice(0, cells.length, ...shellCells(f))
  const open = v => { const b = bot.blockAt(v); return !!b && (SL.classOf(b) === SL.AIR || SL.classOf(b) === SL.PARTIAL || SL.classOf(b) === SL.FLUID) }
  const occupied = v => Object.values(bot.entities || {}).some((e : any) => e && e !== bot.entity && e.position && e.isValid !== false && e.name !== 'item' &&
    Math.abs(e.position.x - (v.x + 0.5)) < 0.5 + (e.width || 0.6) / 2 && Math.abs(e.position.z - (v.z + 0.5)) < 0.5 + (e.width || 0.6) / 2 &&
    e.position.y < v.y + 1 && e.position.y + (e.height || 1.8) > v.y)
  const todo = cells.filter(open).sort((a, b) => foe ? a.distanceTo(foe.position) - b.distanceTo(foe.position) : 0)
  if (sealOn() && todo.some(occupied)) return { ok: false, placed: 0, left: todo.filter(occupied).map(SL.keyV), pressure: true }
  // Сперва уровень ног (опора для уровня головы), ближние к врагу.
  todo.sort((a, b) => (a.y - b.y) || (foe ? a.distanceTo(foe.position) - b.distanceTo(foe.position) : 0))
  let placed = 0
  const left = []
  for (const v of todo) {
    if (cancelled()) return { ok: false, placed, left, cancelled: true }
    const pressure = interiorPressure(placed)
    if (pressure) return pressure
    if (occupied(v)) { left.push(SL.keyV(v)); continue }
    if (await guardFill(bot, v)) placed++; else left.push(SL.keyV(v))
  }
  if (cancelled()) return { ok: false, placed, left, cancelled: true }
  const finalPressure = interiorPressure(placed)
  if (finalPressure) return finalPressure
  if (sealOn()) {
    for (const v of cells) if (!fullWall(bot.blockAt(v)) && !left.includes(SL.keyV(v))) left.push(SL.keyV(v))
    return { ok: left.length === 0 && sealedAt(bot, f), placed, left }
  }
  return { ok: left.length === 0, placed, left }
}

// в прицеле (pick) — щит вниз, удар, щит снова. Враг дальше 3.2 и виден дольше 2 с — шаг к нему (щит поднят: арбалет).
async function duel (session, ctl, target, ms = 15000, { crowdOk = false, lastStand = false }: any = {}) {
  const bot = session.bot
  const pick = require('./pick')
  const sw = bot.inventory.items().filter(i => /_sword$/.test(i.name)).sort((a, b) => rank(b) - rank(a))[0]
  if (sw && (!bot.heldItem || bot.heldItem.name !== sw.name)) { try { await bot.equip(sw, 'hand') } catch {} }
  const hasShield = !!(bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield')
  let up = false
  const shield = on => { if (!hasShield || on === up) return; try { if (on) bot.activateItem(true); else bot.deactivateItem() } catch {} up = on }
  const t0 = gameClock.now()
  let last = 0; let swings = 0; let far = 0; let foe = target
  const out: any = { swings: 0 }
  try {
    while (!ctl.aborted && gameClock.now() - t0 < ms && (bot.health ?? 0) > 0) {
      if (!foe || foe.isValid === false || !bot.entities[foe.id]) {
        foe = meleeFoes(bot, 6)[0]
        if (!foe) { out.killed = true; break }
      }
      // Мало хп — уйти в коробку, если есть чем (иначе бой до конца: B2-3 03.10 — хп 7, стоп, коробки нет, смерть стоя).
      const canBox = guardCount(bot) >= 4
      if (((bot.health ?? 20) < 7 && canBox && !lastStand) || (!crowdOk && meleeFoes(bot, 6).length >= 3)) { out.stopped = (bot.health ?? 20) < 7 ? 'хп' : 'толпа'; break }
      // Не достать 4 с (за стеной, в щели, не подходит) — не стоять: бой не задался.
      if (gameClock.now() - Math.max(last, t0) > 4000 && !swings) { out.stopped = 'не достать'; break }
      const d = foe.position.distanceTo(bot.entity.position)
      if (foe.name === 'blaze' && d >= 3.5) { out.stopped = 'блейз вне ближнего боя'; break }
      try { await bot.lookAt(foe.position.offset(0, (foe.height || 1.9) * 0.75, 0), true) } catch {}
      if (gameClock.now() - last >= 640 && pick.canHit(bot, foe)) {
        shield(false)
        await sleep(50)
        try { bot.attack(foe); swings++; last = gameClock.now() } catch {}
        await sleep(50)
        shield(true)
      } else shield(true)
      if (d > 3.2 && sees(bot, foe)) { if (!far) far = gameClock.now() } else far = 0
      // Шаг к врагу — только если шаг безопасен (S4c 07.10, замечание проверки г): клавиша «вперёд» к ифриту/иссушителю за краем
      // моста вела тело в пустоту или лаву; moves.stepSafe — обрыв > 3, лава/огонь/магма под шагом.
      bot.setControlState('forward', !!(far && gameClock.now() - far > 2000 && d > 3.2 && d < 10) && require('./moves').stepSafe(bot, require('./moves').keyDir(bot, 'forward')))
      await sleep(60)
    }
  } finally { bot.setControlState('forward', false); shield(false) }
  out.swings = swings
  out.s = Math.round((gameClock.now() - t0) / 1000)
  return out
}

// Ответ на удар/угрозу вплотную. opts.onOwn(cells) — клетки ямы (свои для штрека). { acted, how, … }.
async function react (session, ctl, opts: any = {}) {
  if (ctl.aborted || !session.bot?.entity || (session.bot.health ?? 0) <= 0) return { acted: false, cancelled: true }
  const bot = session.bot
  const dimension = bot.game?.dimension
  const g = install(bot)
  const active = () => !ctl.aborted && session.bot === bot && !!bot.entity && (bot.health ?? 0) > 0 &&
    bot.game?.dimension === dimension && !g?.ended
  if (!active()) return { acted: false, cancelled: true }
  if (session.tactics?.enabled() && !opts._owned) {
    const result = await session.tactics.requestGuard()
    // A declined guard can resolve synchronously; native packets and aborts must still run.
    await new Promise<void>(resolve => setImmediate(resolve))
    return active() ? result : { acted: false, cancelled: true }
  }
  const h = opts.force || hot(session.bot, opts)
  if (!h) return { acted: false }
  const R = require('./reflex-lock')
  if (R.on() && !opts._owned) {
    return R.start(session, async sub => {
      // Immediate defensive action before a tower/box needs inventory clicks.
      const b = session.bot
      if (b.inventory.slots[45]?.name === 'shield') {
        try { await b.lookAt(h.e.position.offset(0, (h.e.height || 1.9) * .8, 0), true); b.activateItem(true) } catch {}
      } else if (require('./pick').canHit(b, h.e)) {
        try { await b.lookAt(h.e.position.offset(0, (h.e.height || 1.9) * .7, 0), true); b.attack(h.e) } catch {}
      }
      return react(session, sub, { ...opts, force: h, _owned: true })
    }, { triggerAt: opts.triggerAt ?? gameClock.now(), source: h.e.name })
  }
  // Ответ уже идёт (сторож отвечает сам) — дождаться его конца, а не второй поверх.
  if (g?.reacting && !g.reactionCtl?.aborted) { const tw = gameClock.now(); while (g.reacting && gameClock.now() - tw < 30000 && !ctl.aborted) await sleep(200); return ctl.aborted ? { acted: false, cancelled: true } : { acted: true, how: 'ждал ответа' } }
  if (g) { g.reacting = true; g.reactionCtl = ctl }
  try { return await reactCatch(session, ctl, opts, h) } finally { if (g?.reactionCtl === ctl) { g.reacting = false; g.reactEnd = gameClock.now() } }
}
async function reactCatch (session, ctl, opts, h) {
  try { return await reactBody(session, ctl, opts, h) } catch (e) {
    if (ctl.aborted || e.code === 'REFLEX_CANCELLED') return { acted: false, cancelled: true }
    log('ошибка ответа', { error: e.message, foe: h.e && h.e.name }); return { acted: true, how: 'ошибка', error: e.message }
  }
}
async function reactBody (session, ctl, opts, h) {
  const bot = session.bot
  const dimension = bot.game?.dimension
  const active = () => {
    if (ctl.aborted || session.bot !== bot || !bot.entity || (bot.health ?? 0) <= 0 || bot.game?.dimension !== dimension || bot._ndGuard?.ended) {
      throw Object.assign(new Error('guard: defensive action cancelled'), { code: 'REFLEX_CANCELLED' })
    }
  }
  const step = async work => { const result = await work; active(); return result }
  active()
  const t0 = gameClock.now()
  const hp0 = Math.round(bot.health ?? 0)
  try { bot.pathfinder && bot.pathfinder.setGoal(null) } catch {}
  bot.clearControlStates()
  const foes = meleeFoes(bot, 6)
  const e = h.e
  const wsk = foes.filter((f : any) => f.name === 'wither_skeleton').length
  const big = HIDE_FROM.test(e.name || '') || foes.some((f : any) => HIDE_FROM.test(f.name || '')) || foes.length >= 3 || wsk >= 2 || (bot.health ?? 20) < 9
  const out: any = { acted: true, why: h.why, foe: e.name, foes: foes.length, hp0 }
  if (big) {
    const f0 = bot.entity.position.floored()
    const air = v => { const b = bot.blockAt(v); return !!b && b.boundingBox === 'empty' && !/lava|water|fire/.test(b.name) }
    // Высота столба: проба 03.10 (2 брута) — с +2 брут достаёт (удары по ногам на y+2.00 от брута на y+0.00), берём +3.
    const PH = Math.max(2, Math.min(4, Number(process.env.ND_GUARD_PILLAR || 3)))
    let head = true
    for (let k = 2; k <= PH + 1; k++) if (!air(f0.offset(0, k, 0))) head = false
    // Столб — только на открытом (хотя бы 2 стороны у ног — воздух): из ямы бартера столб выводил к бруту у её рта (B1-3
    // 03.10: брут во рту ямы бил сверху, +2 — достаёт).
    const sidesOpen = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dz]) => air(f0.offset(dx, 0, dz))).length
    if (head && sidesOpen >= 2) {
      const y0 = bot.entity.position.y
      const ti = guardItem(bot)
      const tw = await step(require('./build').towerUp(bot, ctl, PH, { sneak: true, ...(ti ? { item: ti } : {}) }).catch(err => ({ ok: false, reason: err.message })))
      if (bot.entity.position.y >= y0 + PH - 0.1) {
        out.how = 'столб'
        out.sat = await step(sit(session, ctl, opts.sitMs ?? 25000, { swing: true }))
        bot.setControlState('sneak', false)
        // Врагов в 8 нет — слезть (копать столб под собой), иначе дальше план со столба.
        if (!meleeFoes(bot, 8).length && !ctl.aborted) { try { out.down = (await step(require('./pearls').pillarDown(bot, ctl, session.mcData, f0))).ok } catch {} }
        active()
        out.hp = Math.round(bot.health ?? 0); out.s = Math.round((gameClock.now() - t0) / 1000)
        log('ответ', out)
        return out
      }
      out.tower = tw && (tw.reason || tw.why || tw.placed)
    }
    // Коробка: клетка занята сущностью — щит к врагу и ещё раз (до 3 с): моб у рта ямы отходит на полшага.
    let bx: any = await step(boxIn(bot, e, { ctl }).catch(err => ({ ok: false, why: err.message })))
    const tb = gameClock.now()
    const hasShield = !!(bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield')
    while (!bx.ok && !bx.pressure && gameClock.now() - tb < 3000 && !ctl.aborted && (bot.health ?? 0) > 0 && bx.left && bx.left.length) {
      try { await bot.lookAt(e.position.offset(0, 1.6, 0), true) } catch {}
      if (hasShield) { try { bot.activateItem(true) } catch {} }
      await step(sleep(250))
      if (hasShield) { try { bot.deactivateItem() } catch {} }
      const nb: any = await step(boxIn(bot, e, { ctl }).catch(err => ({ ok: false, why: err.message })))
      bx = { ...nb, placed: (bx.placed || 0) + (nb.placed || 0) }
    }
    out.box = bx
    if (bx.ok) {
      if (opts.onOwn) { try { opts.onOwn([]) } catch {} }
      out.how = 'коробка'
      out.sat = await step(sit(session, ctl, opts.sitMs ?? 25000, { hitStop: true }))
      if (out.sat.hit && !ctl.aborted) {
        // Бьют сквозь коробку — заложить и диагонали (ноги и голова), снова сидеть; бьют и так — бой до конца.
        const bd = await step(boxIn(bot, e, { diag: true, ctl }).catch(err => ({ ok: false, why: err.message })))
        out.boxDiag = bd
        if (bd.ok) out.sat2 = await step(sit(session, ctl, opts.sitMs ?? 25000, { hitStop: true }))
        if ((!bd.ok || out.sat2?.hit) && !ctl.aborted) { out.last = await step(duel(session, ctl, e, 20000, { crowdOk: true, lastStand: true }).catch(err => ({ error: err.message }))); out.how = 'коробка → бой' }
      }
      out.hp = Math.round(bot.health ?? 0); out.s = Math.round((gameClock.now() - t0) / 1000)
      log('ответ', out)
      return out
    }
  }
  out.how = 'бой'
  const f: any = await step(duel(session, ctl, e, opts.duelMs ?? 15000, { crowdOk: big }).catch(err => ({ error: err.message })))
  out.duel = f
  out.killed = !!(f && f.killed)
  // Бой не задался (толпа, хп) — коробка.
  if (f && (f.stopped === 'хп' || f.stopped === 'толпа')) {
    const bx = await step(boxIn(bot, e, { ctl }).catch(err => ({ ok: false, why: err.message }))); out.box2 = bx
    if (bx.ok) { out.how = 'бой → коробка'; out.sat = await step(sit(session, ctl, opts.sitMs ?? 25000)) } else {
      // Коробки нет (враг в соседней клетке) — бой до конца, а не стоять (проба 03.10: брут вплотную под потолком — стоя смерть).
      out.last = await step(duel(session, ctl, e, 20000, { crowdOk: true, lastStand: true }).catch(err => ({ error: err.message })))
      out.how = 'бой до конца'
    }
  }
  out.hp = Math.round(bot.health ?? 0); out.s = Math.round((gameClock.now() - t0) / 1000)
  log('ответ', out)
  return out
}

function swatInstall (bot) {
  if (!bot || bot._ndSwat || typeof bot.on !== 'function') return bot && bot._ndSwat
  const st = { pend: null, last: new Map(), n: 0 }
  bot._ndSwat = st
  const onTick = () => {
    try {
      if (process.env.ND_GHAST_SWAT !== '1' || !bot.entity) return
      if (st.pend) {
        const fb = bot.entities[st.pend.id]
        const at = st.pend
        st.pend = null
        if (fb && fb.isValid !== false && fb.position) {
          bot.attack(fb)
          st.n++
          log('шар гаста: удар', { n: st.n, d: +fb.position.distanceTo(bot.entity.position.offset(0, 1.62, 0)).toFixed(1), ghast: at.ghast })
        }
        return
      }
      const eye = bot.entity.position.offset(0, 1.62, 0)
      let best = null
      for (const fb of (Object.values(bot.entities) as any)) {
        if (!fb || fb.name !== 'fireball' || !fb.position || fb.isValid === false) continue
        const d = fb.position.offset(0, 0.5, 0).distanceTo(eye)
        if (d > 3.4) continue
        if (gameClock.now() - (st.last.get(fb.id) || 0) < 250) continue
        if (!best || d < best.d) best = { fb, d }
      }
      if (!best) return
      st.last.set(best.fb.id, gameClock.now())
      if (st.last.size > 64) st.last.clear()
      const g = bot.nearestEntity(e => e && e.name === 'ghast' && e.position && e.position.distanceTo(bot.entity.position) < 96)
      const aimAt = g
        ? g.position.offset(0, 2, 0).plus(g.velocity && g.velocity.scaled ? g.velocity.scaled(10) : new Vec3(0, 0, 0))
        : best.fb.position.plus(best.fb.position.minus(eye))
      bot.lookAt(aimAt, true).catch(() => {})
      st.pend = { id: best.fb.id, ghast: !!g }
    } catch {}
  }
  bot.on('physicsTick', onTick)
  return st
}

// Идёт ответ стража (сторож мимо цикла дела) — подождать его конца (ходьба/план не должны тянуть тело со столба/из коробки).
function busy (bot) { return !!(bot && bot._ndGuard && bot._ndGuard.reacting) }
async function waitIdle (bot, ms = 30000) { const t = gameClock.now(); while (busy(bot) && gameClock.now() - t < ms) await sleep(200) }

module.exports = { busy, waitIdle, attach, duel, boxIn, swatInstall, install, hot, react, hideDown, meleeFoes, holeOk, sit, aggressive, HIDE_FROM }
