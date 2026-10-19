const { hitBy, r1, doing, angryEndermen, fastTower, nearEdge, inClouds }: typeof import('./fall-guard') = require('./fall-guard')
const { gameClock, FILLER_RE, items, findItem, EYE, ENDERMAN_EYE, dragonOf, phaseOf, hpOf, PHASE_RU, cloudsOf, fbSpawn, fbLineHit, fbTicksTo, metaOf, KIT, BEDS_KIT, Vec3, isSolid, lookSafe, sleep, CENTER, stepTo, yieldTick, CLOUD_SLAB, isAirish, build, fillerItem, FIREBALL_SNAP, supportCell, clearControls, PHASE, cloudBorn, overlap, inflate }: typeof import('./dig-down-to') = require('./dig-down-to')
const { countOf, evade, blastReaches, virtualBot, exposure, tsClickPoint, dragonSeen, bedDamage, predParts }: typeof import('./evade-raw') = require('./evade-raw')
const { DAMAGE_TYPES, r3, readVarIntAt, tsPlan, stationWorld, blastDestroyed }: typeof import('./ts-plan') = require('./ts-plan')
const { fightEnderman, hazardNow, walkTo }: typeof import('./pillar-run') = require('./pillar-run')
const { stepOnto }: typeof import('./station-plan') = require('./station-plan')
function hitTracker (bot) {
  const f = (pk) => {
    // Только прямой удар (кто бил, тот и ударил): облако огня или фаербола несёт
    if (bot.entity && pk && pk.entityId === bot.entity.id && pk.sourceCauseId > 0 && (!pk.sourceDirectId || pk.sourceDirectId === pk.sourceCauseId)) hitBy.set(pk.sourceCauseId - 1, gameClock.now())
  }
  bot._client.on('damage_event', f)
  return () => bot._client.removeListener('damage_event', f)
}

const TRACE_DIR = process.env.ND_DRAGON_TRACE || null

function makeTrace (bot, ctl, stats) {
  if (!TRACE_DIR) return { ev () {}, close () {}, file: null }
  const fs: typeof import('fs') = require('fs')
  const path: typeof import('path') = require('path')
  try { fs.mkdirSync(TRACE_DIR, { recursive: true }) } catch {}
  const file = path.join(TRACE_DIR, `dragon-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`)
  const t0 = gameClock.now()
  let buf = []
  const put = o => { buf.push(JSON.stringify({ t: gameClock.now() - t0, ...o })) }
  const flush = () => { if (!buf.length) return; const s = buf.join('\n') + '\n'; buf = []; fs.appendFile(file, s, () => {}) }
  const nameOf = id => { const e = bot.entities[id]; return e ? (e.name || e.username || e.type) : (id >= 0 ? `#${id}` : null) }
  const seenClouds = new Set()
  const loggedFb = new Set()
  let lastPhase = null
  // Эндермены: кто и когда разозлился (метаданные creepy) и что было перед
  const angry = new Map()
  const enderHurt = new Map()
  const stareTicks = new Map()
  const onTickStare = () => {
    const me = bot.entity && bot.entity.position
    if (!me) return
    const eye = me.offset(0, EYE, 0)
    const yaw = bot.entity.yaw; const pitch = bot.entity.pitch
    const lx = -Math.sin(yaw) * Math.cos(pitch); const ly = Math.sin(pitch); const lz = -Math.cos(yaw) * Math.cos(pitch)
    for (const en of ((Object.values(bot.entities) as any[]) as any)) {
      if (!en || en.name !== 'enderman' || !en.position) continue
      const tx = en.position.x - eye.x; const ty = en.position.y + ENDERMAN_EYE - eye.y; const tz = en.position.z - eye.z
      const len = Math.hypot(tx, ty, tz)
      if (len > 64 || len < 0.3) { stareTicks.delete(en.id); continue }
      const inCone = (lx * tx + ly * ty + lz * tz) / len > 1 - 0.025 / len
      const n = inCone ? (stareTicks.get(en.id) || 0) + 1 : 0
      stareTicks.set(en.id, n)
      if (n === 3) put({ k: 'stare', id: en.id, dist: r1(len), doing: ctl.doing || null })
    }
  }
  const sample = () => {
    const e = bot.entity
    if (!e || !e.position) return
    const me = e.position
    const d = dragonOf(bot)
    const o: any = { k: 's', p: [r1(me.x), r1(me.y), r1(me.z)], hp: r1(bot.health ?? 0), f: bot.food, g: e.onGround ? 1 : 0, doing: ctl.doing || null }
    if (d) {
      const ph = phaseOf(bot, d)
      o.d = { ph, hp: r1(hpOf(bot, d) ?? -1), p: [r1(d.position.x), r1(d.position.y), r1(d.position.z)], yaw: +d.yaw.toFixed(2) }
      if (ph !== lastPhase) { put({ k: 'phase', ph, name: PHASE_RU[ph] ?? ph, hp: o.d.hp, at: o.d.p }); lastPhase = ph }
    }
    const cl = []
    for (const c of cloudsOf(bot)) {
      if (!seenClouds.has(c.e.id)) {
        seenClouds.add(c.e.id)
        put({ k: 'cloud', id: c.e.id, at: [r1(c.pos.x), r1(c.pos.y), r1(c.pos.z)], r: r1(c.r), me: [r1(me.x), r1(me.y), r1(me.z)], dist: r1(Math.hypot(c.pos.x - me.x, c.pos.z - me.z)), dragonPh: d ? phaseOf(bot, d) : null })
      }
      const h = Math.hypot(c.pos.x - me.x, c.pos.z - me.z)
      if (h < 14) cl.push([c.e.id, r1(h), r1(me.y - c.pos.y), r1(c.r)])
    }
    if (cl.length) o.cl = cl
    for (const [id, info] of fbSpawn) {
      if (loggedFb.has(id)) continue
      loggedFb.add(id)
      const hit = info.dir ? fbLineHit(bot, info.p0, info.dir) : null
      // Проверка декодера: фаербол летит в середину тела цели (мы — единственный
      // игрок): угол между его направлением и направлением на нас.
      const to = me.offset(0, 0.9, 0).minus(info.p0)
      const aimErr = info.dir ? Math.round(Math.acos(Math.max(-1, Math.min(1, (to.x * info.dir.x + to.y * info.dir.y + to.z * info.dir.z) / (to.norm() || 1)))) * 573) / 10 : null
      put({ k: 'fireball', id, aimErr, p0: [r1(info.p0.x), r1(info.p0.y), r1(info.p0.z)], dir: info.dir ? [+info.dir.x.toFixed(3), +info.dir.y.toFixed(3), +info.dir.z.toFixed(3)] : null, ground: hit ? [r1(hit.at.x), r1(hit.at.y), r1(hit.at.z)] : null, eta: hit ? fbTicksTo(hit.dist) : null, me: [r1(me.x), r1(me.y), r1(me.z)] })
    }
    const fb = (Object.values(bot.entities) as any[]).filter((x : any) => x && x.name === 'dragon_fireball' && x.position && x.position.distanceTo(me) < 40).length
    if (fb) o.fb = fb
    for (const en of ((Object.values(bot.entities) as any[]) as any)) {
      if (!en || en.name !== 'enderman' || !en.position) continue
      const c = metaOf(bot, en, 'creepy') === true
      if (c && !angry.get(en.id)) {
        const h = enderHurt.get(en.id)
        put({ k: 'angry', id: en.id, at: [r1(en.position.x), r1(en.position.y), r1(en.position.z)], dist: r1(en.position.distanceTo(me)), stared: stareTicks.get(en.id) || 0, hurt: h && gameClock.now() - h.t < 3000 ? h : null, doing: ctl.doing || null })
      }
      angry.set(en.id, c)
    }
    put(o)
  }
  const onDmg = pk => {
    if (!bot.entity || !pk) return
    const victim = bot.entities[pk.entityId]
    if (victim && victim.name === 'enderman' && pk.entityId !== bot.entity.id) {
      enderHurt.set(pk.entityId, { t: gameClock.now(), type: DAMAGE_TYPES[pk.sourceTypeId] || pk.sourceTypeId, cause: nameOf(pk.sourceCauseId - 1), byMe: pk.sourceCauseId - 1 === bot.entity.id })
      return
    }
    if (pk.entityId !== bot.entity.id) return
    put({ k: 'hurt', type: DAMAGE_TYPES[pk.sourceTypeId] || pk.sourceTypeId, cause: nameOf(pk.sourceCauseId - 1), direct: nameOf(pk.sourceDirectId - 1), hpBefore: r1(bot.health ?? 0), doing: ctl.doing || null })
  }
  const onHealth = () => put({ k: 'hp', hp: r1(bot.health ?? 0), f: bot.food })
  const onDeath = () => { put({ k: 'death', doing: ctl.doing || null }); flush() }
  const onGone = en => { if (en && en.name === 'end_crystal') put({ k: 'crystalGone', id: en.id, at: [r1(en.position.x), r1(en.position.y), r1(en.position.z)] }) }
  // Каждый пакет движения дракона (сервер шлёт раз в 3 тика) — для прогноза головы.
  const onMoved = en => { if (en && en.name === 'ender_dragon') put({ k: 'dm', p: [r3(en.position.x), r3(en.position.y), r3(en.position.z)], yaw: +en.yaw.toFixed(3), ph: phaseOf(bot, en) }) }
  const onVel = pk => { const en = bot.entities[pk.entityId]; if (en && en.name === 'ender_dragon') put({ k: 'dv', v: pk.velocity ? [pk.velocity.x, pk.velocity.y, pk.velocity.z] : [pk.velocityX, pk.velocityY, pk.velocityZ] }) }
  bot.on('entityMoved', onMoved)
  bot._client.on('entity_velocity', onVel)
  bot._client.on('damage_event', onDmg)
  bot.on('physicsTick', onTickStare)
  bot.on('health', onHealth)
  bot.on('death', onDeath)
  bot.on('entityGone', onGone)
  const iv = gameClock.setInterval(sample, 250)
  const fl = gameClock.setInterval(flush, 1000)
  put({ k: 'start', kit: kitOf(bot), p: bot.entity ? [r1(bot.entity.position.x), r1(bot.entity.position.y), r1(bot.entity.position.z)] : null })
  return {
    file,
    ev (k, o: any = {}) { put({ k, ...o }) },
    close (extra: any = {}) {
      gameClock.clearInterval(iv); gameClock.clearInterval(fl)
      bot._client.removeListener('damage_event', onDmg)
      bot.removeListener('entityMoved', onMoved)
      bot._client.removeListener('entity_velocity', onVel)
      bot.removeListener('physicsTick', onTickStare)
      bot.removeListener('health', onHealth)
      bot.removeListener('death', onDeath)
      bot.removeListener('entityGone', onGone)
      put({ k: 'end', ...extra })
      flush()
    }
  }
}

function kitOf (bot) {
  return {
    bow: countOf(bot, /^bow$/),
    arrows: countOf(bot, /arrow$/),
    blocks: countOf(bot, FILLER_RE),
    weapon: items.bestWeapon(bot) ? items.bestWeapon(bot).name : null,
    pickaxe: findItem(bot, /_pickaxe$/) ? findItem(bot, /_pickaxe$/).name : null,
    food: countOf(bot, /^(cooked_|bread|baked_potato|golden_carrot|golden_apple|enchanted_golden_apple|apple|carrot|pumpkin_pie|steak|mushroom_stew|rabbit_stew|beetroot_soup)/),
    gapples: countOf(bot, /golden_apple$/),
    water: countOf(bot, /^water_bucket$/),
    torches: countOf(bot, /^torch$/),
    beds: countOf(bot, /_bed$/)
  }
}

const clearedCrystals = new WeakMap()

function clearCrystalKnowledge (bot) { clearedCrystals.delete(bot) }

function noteCrystalClear (bot, report) {
  if (report && report.left > 0) clearCrystalKnowledge(bot)
  if (!report || report.left !== 0 || !(report.seen > 0) || !bot.entity || !/end/.test(bot.game.dimension)) return
  const d = dragonOf(bot)
  clearedCrystals.set(bot, { me: bot.entity.id, dragon: d ? d.id : null, dimension: bot.game.dimension })
}

function crystalKitState (bot, at, onIsland) {
  const rec = clearedCrystals.get(bot)
  if (rec) {
    const d = dragonOf(bot)
    if (!bot.entity || bot.entity.id !== rec.me || bot.game.dimension !== rec.dimension ||
        (d && rec.dragon != null && d.id !== rec.dragon) || (at && at.crystals > 0)) clearCrystalKnowledge(bot)
    else {
      if (d && rec.dragon == null) rec.dragon = d.id
      return { crystals: 0, caged: 0, island: true }
    }
  }
  return at || (onIsland ? { crystals: 10, caged: 2, island: true } : null)
}

function missing (kit, mode, at = null) {
  const need = []
  const full = mode === 'full' || mode === 'crystals'
  const arrows = at ? Math.min(KIT.arrows, 3 * at.crystals + 4) : KIT.arrows
  // У центра без клеток блоки нужны только станции кроватей; без кроватей —
  const blocks = at ? Math.min(KIT.blocks, (kit.pickaxe ? 0 : 24 * at.caged) + (kit.beds && !kit.pickaxe ? 8 : 0)) : (kit.pickaxe ? 44 : KIT.blocks)
  if (full && !kit.bow && (!at || at.crystals > 0)) need.push({ what: 'bow', count: 1, have: 0 })
  if (full && kit.arrows < arrows && (!at || at.crystals > 0)) need.push({ what: 'arrow', count: arrows, have: kit.arrows })
  if (full && kit.blocks < blocks) need.push({ what: 'cobblestone', count: blocks, have: kit.blocks })
  if (mode === 'dragon' && kit.blocks < 16) need.push({ what: 'cobblestone', count: 16, have: kit.blocks })
  if ((full || mode === 'dragon') && !kit.weapon) need.push({ what: 'diamond_sword', count: 1, have: 0 })
  if (full && !kit.pickaxe) need.push({ what: 'iron_pickaxe', count: 1, have: 0 })
  // Еда — только на вход: уже на острове (бой идёт) отказ за еду оставлял тело
  if ((full || mode === 'dragon') && kit.food < KIT.food && !at) need.push({ what: 'cooked_beef', count: KIT.food, have: kit.food })
  // Только кровати: кровати, блоки (мост с платформы; у центра — заслоны и
  // досыпка пола), еда на вход. Лук и стрелы не нужны.
  if (mode === 'beds') {
    if (!kit.beds && !kit.weapon && !(kit.bow && kit.arrows > 0)) need.push({ what: 'red_bed', count: BEDS_KIT, have: 0 })
    const bl = at ? (kit.beds ? 12 : 0) : (kit.pickaxe ? 44 : 64)
    if (kit.blocks < bl) need.push({ what: 'cobblestone', count: bl, have: kit.blocks })
    // Еда — цена, не допуск (гибкость, s5c-g1-1 06.10: в Энде с 3 стейками из 6 навык отказывал «ни шагу», 5 мин паузы,
    // а еды в Энде не взять). Отказ — только совсем без еды; бой на 3–5 мин стоит 2–3 единиц.
    if (kit.food < 1 && !at) need.push({ what: 'cooked_beef', count: 1, have: kit.food })
  }
  return need
}

async function equipName (bot, re) {
  const it = findItem(bot, re)
  if (!it) return null
  if (!bot.heldItem || bot.heldItem.type !== it.type) await bot.equip(it, 'hand').catch(() => {})
  return it
}

async function bridgeToIsland (session, ctl, rep) {
  const bot = session.bot
  doing(ctl, 'bridge')
  const out: any = { placed: 0, steps: 0 }
  const p0 = bot.entity.position
  const toC = { x: CENTER.x - p0.x, z: CENTER.z - p0.z }
  const d = Math.abs(toC.x) >= Math.abs(toC.z) ? { x: Math.sign(toC.x), z: 0 } : { x: 0, z: Math.sign(toC.z) }
  out.dir = d
  const stats = ctl.stats || { dodges: {} }
  // Мост — сразу на высоте верха острова (2026-09-30): край по линии моста —
  const under0 = bot.blockAt(p0.floored().offset(0, -1, 0))
  if (under0 && under0.name === 'obsidian') {
    // Злой эндермен у платформы — сперва отбиться, и столб — из середины
    for (let k = 0; k < 3 && !ctl.aborted; k++) {
      const pest = angryEndermen(bot, 6).sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
      if (!pest) break
      out.endermen = (out.endermen || 0) + 1
      await fightEnderman(session, ctl, stats, pest, null)
    }
    const inner = platformInner(bot)
    if (inner && Math.hypot(inner.x - bot.entity.position.x, inner.z - bot.entity.position.z) > 0.3) await stepTo(bot, ctl, inner, { ms: 2500, sprint: false, stopAt: 0.2 })
  }
  const p1 = bot.entity.position
  const under1 = bot.blockAt(p1.floored().offset(0, -1, 0))
  // rise: false — мост на уровне платформы, как раньше (опыт: при медленном подходе дракон
  // чаще «слепой» — первая проверка видимости застаёт нас за обелиском на склоне).
  if (!ctl.noRise && under1 && under1.name === 'obsidian' && platformInner(bot, 0)) {
    const edge = islandEdgeTop(bot, p1, d)
    const rise = edge ? edge.top - Math.floor(p1.y + 0.01) : 0
    out.edge = edge
    if (rise >= 1 && rise <= 10 && countOf(bot, FILLER_RE) >= rise + edge.k + 6) {
      doing(ctl, 'bridge:rise')
      const t = await fastTower(bot, ctl, edge.top, { maxMs: 12000, abortIf: () => angryEndermen(bot, 3).length ? 'эндермен рядом' : null })
      out.rise = { want: rise, ok: t.ok, placed: t.placed, why: t.why || null }
      if (ctl.trace) ctl.trace.ev('bridgeRise', out.rise)
      doing(ctl, 'bridge')
    }
  }
  for (let i = 0; i < 120 && !ctl.aborted; i++) {
    await yieldTick()
    // На мосту в блок шириной уходить вбок некуда (evade ищет клетку не у
    const me0 = bot.entity.position
    const blocking = cloudsOf(bot).find(c => {
      // Облако задевает только тех, чья коробка пересекает его полблока: кто
      // идёт на блок выше его y — мимо (мост над облаком, см. ниже).
      if (!(c.pos.y + CLOUD_SLAB > me0.y && c.pos.y < me0.y + 1.8)) return false
      for (let k = 0; k <= 6; k++) {
        const x = me0.x + d.x * k; const z = me0.z + d.z * k
        if (Math.hypot(x - c.pos.x, z - c.pos.z) < c.r + 1.6) return true
      }
      return false
    })
    // Мост дальше — на блок выше: над облаком (его коробка — полблока от его
    if (blocking && bot.entity.onGround && countOf(bot, FILLER_RE) > 0 && isAirish(bot.blockAt(me0.floored().offset(0, 2, 0)))) {
      out.overCloud = (out.overCloud || 0) + 1
      bot.setControlState('sneak', true)
      const t = await build.towerUp(bot, ctl, 1, { item: fillerItem(bot) })
      if (t.placed) continue
    }
    if (blocking && (out.waitMs || 0) < 45000) {
      const tw = gameClock.now()
      i--
      const need = blocking.r + 3
      let back = null
      for (let k = 0; k <= 16; k++) {
        const q = me0.floored().offset(-d.x * k, -1, -d.z * k)
        const b = bot.blockAt(q)
        if (!b || !isSolid(b)) break
        back = q
        if (Math.hypot(q.x + 0.5 - blocking.pos.x, q.z + 0.5 - blocking.pos.z) > need) break
      }
      if (back && Math.hypot(me0.x - back.x - 0.5, me0.z - back.z - 0.5) > 0.4) {
        bot.setControlState('sneak', false)
        await stepTo(bot, ctl, new Vec3(back.x + 0.5, back.y + 1, back.z + 0.5), { ms: 3000, stopAt: 0.25, portal: true })
      }
      await sleep(500)
      out.waitMs = (out.waitMs || 0) + (gameClock.now() - tw)
      continue
    }
    const bad = hazardNow(bot)
    if (bad) {
      out.dodged = (out.dodged || 0) + 1
      const me = bot.entity.position
      if (bad.f) {
        const land = bad.f.ground || bad.f.at
        let back = null
        for (let k = 1; k <= 8; k++) {
          const q = me.floored().offset(-d.x * k, -1, -d.z * k)
          const b = bot.blockAt(q)
          if (!b || !isSolid(b)) break
          back = q
          if (land && Math.hypot(q.x + 0.5 - land.x, q.z + 0.5 - land.z) > FIREBALL_SNAP + 2) break
        }
        if (back) {
          stats.dodges.фаербол = (stats.dodges.фаербол || 0) + 1
          bot.setControlState('sneak', false)
          await stepTo(bot, ctl, new Vec3(back.x + 0.5, back.y + 1, back.z + 0.5), { ms: 2500, stopAt: 0.25, portal: true })
          await sleep(300)
          continue
        }
      }
      await sleep(100)
    }
    // Клетка — та, на которой стоим (под хитбоксом): свесившись со столба, центр
    // над воздухом, и блок «от своей клетки» встал бы по диагонали от опоры (ab-23).
    let sup = supportCell(bot)
    if (sup && (sup.x !== Math.floor(bot.entity.position.x) || sup.z !== Math.floor(bot.entity.position.z))) {
      await stepOnto(bot, ctl, sup.x, sup.z)
      sup = supportCell(bot) || sup
    }
    const p = bot.entity.position
    const cell = sup ? sup.offset(0, 1, 0) : p.floored()
    const fy = cell.y - 1
    const nx = cell.x + d.x; const nz = cell.z + d.z
    const floorN = bot.blockAt(new Vec3(nx, fy, nz))
    const feetN = bot.blockAt(new Vec3(nx, fy + 1, nz))
    const headN = bot.blockAt(new Vec3(nx, fy + 2, nz))
    if (!floorN || !feetN) { out.stopped = 'мир впереди не прогружен'; break }
    // Стена впереди — это остров (или его край): дальше pathfinder, он умеет
    // подниматься и прокапывать.
    if (isSolid(feetN)) { out.land = 'стена острова'; break }
    // Земля внизу в пределах безопасного прыжка — остров.
    let landBelow = null
    for (let k = 0; k <= 3; k++) {
      const b = bot.blockAt(new Vec3(nx, fy - k, nz))
      if (isSolid(b)) { landBelow = k; break }
    }
    if (landBelow !== null && landBelow > 0) {
      // Земля ниже на landBelow — это остров, если это эндерняк толщиной больше
      const gyN = fy - landBelow
      const top = bot.blockAt(new Vec3(nx, gyN, nz)); const under = bot.blockAt(new Vec3(nx, gyN - 1, nz))
      if (top && top.name === 'end_stone' && isSolid(under)) { out.land = `земля ниже на ${landBelow}`; break }
    }
    if (landBelow === 0) {
      // Под следующей клеткой твёрдое: если это наш же мост или платформа —
      // идём дальше; если остров (под ним не пустота на 3 блока вниз) — стоп.
      if (!isAirish(headN)) { out.stopped = 'впереди потолок'; break }
      const island = floorN.name === 'end_stone' && !nearEdge(bot, new Vec3(nx, fy, nz), 1)
      await stepOnto(bot, ctl, nx, nz)
      out.steps++
      if (island) { out.land = 'стою на острове'; break }
      continue
    }
    // Впереди пусто — ставим блок под следующую клетку, прислоняя к боку своей.
    if (isAirish(feetN) && headN && headN.name === 'end_stone' && (out.dugHead || 0) < 6) {
      clearControls(bot)
      try { await items.equipBestTool(bot, headN); await build.withTimeout(bot.dig(headN, true), 4000) } catch {}
      if (isAirish(bot.blockAt(headN.position))) { out.dugHead = (out.dugHead || 0) + 1; continue }
    }
    if (!isAirish(headN) || !isAirish(feetN)) { out.stopped = 'впереди не пройти'; break }
    bot.setControlState('sneak', true)
    const r = await build.placeBlockAt(bot, new Vec3(nx, fy, nz), { steady: true, timeoutMs: 3000 })
    if (!r.ok) {
      // Ещё раз, подойдя к самому краю (крадучись с края не падаем).
      await creepToEdge(bot, ctl, d)
      const r2 = await build.placeBlockAt(bot, new Vec3(nx, fy, nz), { steady: true, timeoutMs: 3000 })
      if (!r2.ok) { out.stopped = `мост: блок не встал — ${r2.reason}`; break }
    }
    out.placed++
    await stepOnto(bot, ctl, nx, nz)
    out.steps++
  }
  clearControls(bot)
  rep.bridge = out
  return out
}

function platformInner (bot, r = 2) {
  const p = bot.entity.position
  const fx = Math.floor(p.x); const fz = Math.floor(p.z); const y = Math.floor(p.y + 0.01) - 1
  let best = null
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      let ok = true
      for (let ax = -1; ax <= 1 && ok; ax++) for (let az = -1; az <= 1 && ok; az++) {
        const b = bot.blockAt(new Vec3(fx + dx + ax, y, fz + dz + az))
        if (!b || b.name !== 'obsidian') ok = false
      }
      if (!ok) continue
      const c = new Vec3(fx + dx + 0.5, p.y, fz + dz + 0.5)
      if (!best || c.distanceTo(p) < best.distanceTo(p)) best = c
    }
  }
  return best
}

function islandEdgeTop (bot, p0, d, range = 45) {
  const cx = Math.floor(p0.x); const cz = Math.floor(p0.z); const fy = Math.floor(p0.y + 0.01)
  for (let k = 1; k <= range; k++) {
    const x = cx + d.x * k; const z = cz + d.z * k
    for (let y = fy + 16; y >= fy - 8; y--) {
      const b = bot.blockAt(new Vec3(x, y, z))
      if (!b) return null
      if (isSolid(b)) {
        if (b.name === 'end_stone') return { k, top: y + 1 }
        break
      }
    }
  }
  return null
}

async function creepToEdge (bot, ctl, d) {
  const yaw = Math.atan2(-d.x, -d.z)
  await lookSafe(bot, yaw, -1.2)
  bot.setControlState('sneak', true)
  bot.setControlState('forward', true)
  await sleep(350)
  bot.setControlState('forward', false)
}

async function burrowTo (session, ctl, target, { near = 18, steps = 140 }: any = {}) {
  const bot = session.bot
  const out: any = { steps: 0, dug: 0, placed: 0 }
  const digAt = async (pos) => {
    const b = bot.blockAt(pos)
    if (!b || b.boundingBox === 'empty') return true
    if (/bedrock|obsidian|end_portal|iron_bars/.test(b.name)) { out.wall = `${b.name} ${pos.x},${pos.y},${pos.z}`; return false }
    try { await items.equipBestTool(bot, b); await build.withTimeout(bot.dig(b, true), 6000); out.dug++; return true } catch (e) { out.wall = `${b.name} ${pos.x},${pos.y},${pos.z}: ${e.message}`; return false }
  }
  for (let i = 0; i < steps && !ctl.aborted; i++) {
    await yieldTick()
    const p = bot.entity.position
    if (Math.hypot(target.x - p.x, target.z - p.z) < near) { out.arrived = true; break }
    if (i && i % 6 === 0) {
      const w = await walkTo(session, ctl, target, { range: near - 2, xz: true, timeoutMs: 12000 })
      if (w.ok) { out.arrived = true; out.walked = true; break }
    }
    const dx = target.x - p.x; const dz = target.z - p.z
    const d = Math.abs(dx) >= Math.abs(dz) ? { x: Math.sign(dx), z: 0 } : { x: 0, z: Math.sign(dz) }
    const f = p.floored()
    const ax = f.x + d.x; const az = f.z + d.z
    const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
    const A0 = at(ax, f.y, az); const A1 = at(ax, f.y + 1, az)
    if (!A0 || !A1) { out.why = 'впереди не прогружено'; break }
    if (isSolid(A0)) {
      // Выше: проход над ступенькой и потолок над собой для прыжка.
      if (!(await digAt(new Vec3(ax, f.y + 1, az))) || !(await digAt(new Vec3(ax, f.y + 2, az))) || !(await digAt(new Vec3(f.x, f.y + 2, f.z)))) { out.why = 'стену не прокопать'; break }
      const r = await stepTo(bot, ctl, new Vec3(ax + 0.5, f.y + 1, az + 0.5), { ms: 2500, stopAt: 0.3, sprint: false })
      if (!r.ok) { out.why = `на ступеньку не встал: ${r.why}`; break }
    } else {
      if (!isAirish(A1) && isSolid(A1) && !(await digAt(new Vec3(ax, f.y + 1, az)))) { out.why = 'проход не прокопать'; break }
      let drop = null
      for (let k = 1; k <= 4; k++) { if (isSolid(at(ax, f.y - k, az))) { drop = k - 1; break } }
      if (drop === null) {
        bot.setControlState('sneak', true)
        const r = await build.placeBlockAt(bot, new Vec3(ax, f.y - 1, az), { steady: true, timeoutMs: 3000 })
        bot.setControlState('sneak', false)
        if (!r.ok) { out.why = `под ногами пусто, блок не встал: ${r.reason}`; break }
        out.placed++
      }
      await stepOnto(bot, ctl, ax, az)
      clearControls(bot)
    }
    out.steps++
  }
  clearControls(bot)
  return out
}

function strafeThreat (bot) {
  const d = dragonOf(bot)
  if (!d) return false
  const ph = phaseOf(bot, d)
  return (ph === PHASE.STRAFE || ph === PHASE.CHARGING) && d.position.distanceTo(bot.entity.position) < 64
}

async function juke (session, ctl, stats, ms = 3000) {
  const bot = session.bot
  doing(ctl, 'juke')
  stats.dodges.заход = (stats.dodges.заход || 0) + 1
  const t0 = gameClock.now()
  let side = 1
  while (!ctl.aborted && gameClock.now() - t0 < ms) {
    await yieldTick()
    const bad = hazardNow(bot)
    if (bad) { await evade(bot, ctl, stats, bad); continue }
    const d = dragonOf(bot)
    const me = bot.entity.position
    const from = d ? d.position.minus(me) : new Vec3(1, 0, 0)
    const n = Math.hypot(from.x, from.z) || 1
    // Поперёк линии на дракона, 4 блока; если там край — в другую сторону.
    let target = me.offset(-from.z / n * 4 * side, 0, from.x / n * 4 * side)
    if (nearEdge(bot, target, 2) || inClouds(cloudsOf(bot), target, 2)) { side = -side; target = me.offset(-from.z / n * 4 * side, 0, from.x / n * 4 * side) }
    await stepTo(bot, ctl, target, { ms: 900, stopAt: 0.5 })
    side = -side
    if (!strafeThreat(bot)) break
  }
  clearControls(bot)
}

function spawnVelocityRaw (buf) {
  let off = 0
  let v
  ;[v, off] = readVarIntAt(buf, off) // id пакета
  let entityId
  ;[entityId, off] = readVarIntAt(buf, off)
  off += 16
  let type
  ;[type, off] = readVarIntAt(buf, off)
  const x = buf.readDoubleBE(off); const y = buf.readDoubleBE(off + 8); const z = buf.readDoubleBE(off + 16)
  off += 24
  const a = buf[off]
  if (a === 0) return { entityId, type, pos: { x, y, z }, vel: { x: 0, y: 0, z: 0 } }
  const packed = buf.readUInt32BE(off + 2) * 65536 + buf[off + 1] * 256 + a
  let scale = a & 3
  if ((a & 4) === 4) { const [c] = readVarIntAt(buf, off + 6); scale += c * 4 }
  const un = sh => Math.min(Math.floor(packed / 2 ** sh) % 32768, 32766) * 2 / 32766 - 1
  return { entityId, type, pos: { x, y, z }, vel: { x: un(3) * scale, y: un(18) * scale, z: un(33) * scale } }
}

function fireballTracker (bot) {
  const f = (buf) => {
    try {
      const r = spawnVelocityRaw(buf)
      const info = bot.registry.entities[r.type]
      if (!info || info.name !== 'dragon_fireball') return
      const v = r.vel
      const n = Math.hypot(v.x, v.y, v.z)
      fbSpawn.set(r.entityId, { p0: new Vec3(r.pos.x, r.pos.y, r.pos.z), dir: n > 1e-6 ? new Vec3(v.x / n, v.y / n, v.z / n) : null, t0: gameClock.now(), hit: null, hitAt: 0 })
    } catch {}
  }
  // Облака — когда родились: первый удар через 20 тиков (evade считает запас).
  const g = e => {
    if (!e || e.name !== 'area_effect_cloud') return
    cloudBorn.set(e.id, gameClock.now())
    if (cloudBorn.size > 200) for (const [id, t] of cloudBorn) if (gameClock.now() - t > 60000) cloudBorn.delete(id)
  }
  bot._client.on('raw.spawn_entity', f)
  bot.on('entitySpawn', g)
  return () => { bot._client.removeListener('raw.spawn_entity', f); bot.removeListener('entitySpawn', g) }
}

function tsAddStation (bot, base, target, { fc = null, dpos = null, world, prior = [], cap = null, minExpect = 30, sitP = null, avoidCells = [], lifts = [1, 0, 2], radius = 3.8, protect = [] }: any = {}) {
  const why = {}
  const no = k => { why[k] = (why[k] || 0) + 1 }
  tsAddStation.why = why
  const avoid = new Set(avoidCells.map(q => `${q.x},${q.z}`))
  const cands = []
  for (const lift of lifts) {
    tsPlan(bot, target, { lift, fc, dpos, fixedB: base.B, avoid, extra: world, radius })
    for (const [k, v] of (Object.entries(tsPlan.why || {}) as [string, any][])) why[k] = (why[k] || 0) + v
    cands.push(...(tsPlan.all || []))
  }
  if (!cands.length) { no('нет станции у окопа'); return null }
  let best = null
  for (const c of cands.filter(q => !q.psLift && q.depth === base.depth).sort((p, q) => q.expect - p.expect).slice(0, 12)) {
    if (sitP) {
      const bb = { min: new Vec3(Math.min(c.F.x, c.H.x), c.yb, Math.min(c.F.z, c.H.z)), max: new Vec3(Math.max(c.F.x, c.H.x) + 1, c.yb + 1, Math.max(c.F.z, c.H.z) + 1) }
      if (overlap(bb, inflate(sitP.head, 0.05)) || overlap(bb, inflate(sitP.neck, 0.05)) || overlap(bb, inflate(sitP.body, 0.05))) { no('кровать в сидячих коробках'); continue }
    }
    const cells = [{ x: c.F.x, y: c.yb, z: c.F.z }, { x: c.H.x, y: c.yb, z: c.H.z }, ...c.sCells.map(y => ({ x: c.F.x, y, z: c.F.z })), ...c.wCells.map(y => ({ x: c.W.x, y, z: c.W.z }))]
    const mine = stationWorld(c, world)
    // наш взрыв не сносит то, что взорвётся позже (protect — клетки кроватей/опор/заслонов)
    if (protect.length && blastReaches(virtualBot(bot, mine), bot, c.centre, protect)) { no('снесёт следующую'); continue }
    // по порядку взрывов: каждый не сносит наши клетки; мир после — снесённое воздух
    let post = new Map(mine); let bad = null
    for (const pr of prior) {
      const vb = virtualBot(bot, post)
      if (blastReaches(vb, bot, pr.centre, cells)) { bad = 'прежний взрыв снесёт'; break }
      const des = blastDestroyed(vb, bot, pr.centre)
      post = new Map(post)
      for (const k of des) post.set(k, 'air')
      if (pr.F) { post.set(`${pr.F.x},${pr.yb},${pr.F.z}`, 'air'); post.set(`${pr.H.x},${pr.yb},${pr.H.z}`, 'air') }
    }
    if (bad) { no(bad); continue }
    for (let k = 1; k <= base.depth; k++) post.set(`${base.B.x},${base.G - k},${base.B.z}`, 'air')
    const vPost = virtualBot(bot, post)
    if (exposure(vPost, base.trench, c.centre) > 0.02) { no('после прежних окоп открыт'); continue }
    if (!tsClickPoint(vPost, base.trench.offset(0, EYE, 0), c)) { no('после прежних бок не видно'); continue }
    const noBed = new Map(post); noBed.set(`${c.F.x},${c.yb},${c.F.z}`, 'air'); noBed.set(`${c.H.x},${c.yb},${c.H.z}`, 'air')
    const seen = dpos ? dragonSeen(virtualBot(bot, noBed), c.centre, dpos) : (c.seen || 1)
    const expect = bedDamage(c.centre.distanceTo(target), seen)
    if (cap != null && expect > cap) { no('больше потолка'); continue }
    if (expect < minExpect) { no('мала'); continue }
    const score = expect - (c.sCells.length + c.wCells.length) * 1.5
    if (!best || score > best.score) best = { ...c, expect, seen: Math.round(seen * 100) / 100, score, world: mine }
  }
  return best
}
declare namespace tsAddStation {
  let why: any
}

function tsAPlan (bot, plan, fcL, { cap = null, dpos = null }: any = {}) {
  const why = {}
  const no = k => { why[k] = (why[k] || 0) + 1 }
  tsAPlan.why = why
  const target = fcL.head
  const exL = stationWorld(plan, plan.world)
  const avoid = new Set([plan.F, plan.W, plan.V, plan.PS, plan.H].map(q => `${q.x},${q.z}`))
  // путь до самой посадки (n + 3: tsPlan проверяет до n − 3) — и сидячие коробки
  const fcA = { ...fcL, n: fcL.n + 3 }
  const sitP = predParts(fcL)
  const cands = []
  for (const lift of [1, 0, 2]) {
    tsPlan(bot, target, { lift, fc: fcA, dpos, fixedB: plan.B, avoid, extra: exL, radius: 3.8 })
    for (const [k, v] of (Object.entries(tsPlan.why || {}) as [string, any][])) why[k] = (why[k] || 0) + v
    cands.push(...(tsPlan.all || []))
  }
  if (!cands.length) { no('нет станции у того же окопа'); return null }
  const vbL = virtualBot(bot, exL)
  const destroyed = blastDestroyed(vbL, bot, plan.centre)
  let best = null
  const dbgList = []
  tsAPlan.cands = dbgList
  const no0 = no
  for (const c of cands.filter(q => !q.psLift).sort((p, q) => q.expect - p.expect).slice(0, 10)) {
    const rec: any = { H: [c.H.x, c.yb, c.H.z], e0: c.expect, d: r1(c.centre.distanceTo(target)) }
    dbgList.push(rec)
    const no = k => { rec.why = k; no0(k) }
    const bb = { min: new Vec3(Math.min(c.F.x, c.H.x), c.yb, Math.min(c.F.z, c.H.z)), max: new Vec3(Math.max(c.F.x, c.H.x) + 1, c.yb + 1, Math.max(c.F.z, c.H.z) + 1) }
    if (overlap(bb, inflate(sitP.head, 0.05)) || overlap(bb, inflate(sitP.neck, 0.05)) || overlap(bb, inflate(sitP.body, 0.05))) { no('кровать A в коробках сидящего'); continue }
    const cells = [{ x: c.F.x, y: c.yb, z: c.F.z }, { x: c.H.x, y: c.yb, z: c.H.z }, ...c.sCells.map(y => ({ x: c.F.x, y, z: c.F.z })), ...c.wCells.map(y => ({ x: c.W.x, y, z: c.W.z }))]
    const exBoth = stationWorld(c, exL)
    if (blastReaches(virtualBot(bot, exBoth), bot, plan.centre, cells)) { no('взрыв L снесёт A'); continue }
    // мир после L: снесённое — воздух (станция A — цела по проверке выше)
    const post = new Map(exBoth)
    for (const k of destroyed) post.set(k, 'air')
    post.set(`${plan.F.x},${plan.yb},${plan.F.z}`, 'air'); post.set(`${plan.H.x},${plan.yb},${plan.H.z}`, 'air')
    for (const q of cells) post.set(`${q.x},${q.y},${q.z}`, q.y === c.yb && ((q.x === c.F.x && q.z === c.F.z) || (q.x === c.H.x && q.z === c.H.z)) ? 'bed' : 'block')
    const vPost = virtualBot(bot, post)
    if (exposure(vPost, plan.trench, c.centre) > 0.02) { no('после L окоп открыт взрыву A'); continue }
    if (!tsClickPoint(vPost, plan.trench.offset(0, EYE, 0), c)) { no('после L бок A не видно'); continue }
    // L по-прежнему видно и закрыто, когда стоит A
    if (!tsClickPoint(virtualBot(bot, exBoth), plan.trench.offset(0, EYE, 0), plan)) { no('A закрыла бок L'); continue }
    const noBed = new Map(post); noBed.set(`${c.F.x},${c.yb},${c.F.z}`, 'air'); noBed.set(`${c.H.x},${c.yb},${c.H.z}`, 'air')
    const seen = dpos ? dragonSeen(virtualBot(bot, noBed), c.centre, dpos) : (c.seen || 1)
    const expect = bedDamage(c.centre.distanceTo(target), seen)
    if (cap != null && expect > cap) { no('A больше потолка'); continue }
    if (expect < 25) { no('A мала'); continue }
    const score = expect - (c.sCells.length + c.wCells.length) * 1.5
    if (!best || score > best.score) best = { ...c, expect, seen: Math.round(seen * 100) / 100, score, role: 'A' }
  }
  return best
}
declare namespace tsAPlan {
  let why: any
  let cands: any
}

const blindTried = new Set()

const tsAddStationExport = tsAddStation
const tsAPlanExport = tsAPlan
module.exports = { hitTracker, TRACE_DIR, makeTrace, kitOf, clearedCrystals, clearCrystalKnowledge, noteCrystalClear, crystalKitState, missing, equipName, bridgeToIsland, platformInner, islandEdgeTop, creepToEdge, burrowTo, strafeThreat, juke, spawnVelocityRaw, fireballTracker, tsAddStation, tsAPlan, blindTried }
export {
  hitTracker, TRACE_DIR, makeTrace, kitOf, clearedCrystals, clearCrystalKnowledge, noteCrystalClear,
  crystalKitState, missing, equipName, bridgeToIsland, platformInner, islandEdgeTop, creepToEdge, burrowTo,
  strafeThreat, juke, spawnVelocityRaw, fireballTracker, tsAddStationExport as tsAddStation,
  tsAPlanExport as tsAPlan, blindTried
}
