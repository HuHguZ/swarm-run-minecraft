'use strict'
const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')

// Ночь и кровать — как у живого игрока: кровать носим с собой, в сумерки
// ставим, ложимся ровно тогда, когда сервер позволит (раньше, чем вылезут
// мобы), утром забираем обратно. А если мобы рядом — уходим под землю, где
// их не считают.
//
// Правила сна — из ServerPlayer.startSleepInBed (paper-1.21.11.jar), по порядку:
//  · BedRule измерения: в верхнем мире can_sleep = when_dark, в Аду и Энде
//    explodes → EXPLOSION (кровать взрывается).
//  · ночь: isDarkOutside — 12542..23459 тиков дня в ясную погоду, или гроза.
//  · кровать рядом: |dx| ≤ 3, |dy| ≤ 2, |dz| ≤ 3 от центра низа
//    (isReachableBedBlock) → иначе TOO_FAR_AWAY.
//  · над кроватью свободно (bedBlocked) → иначе OBSTRUCTED.
//  · не в творческом: любой Monster, чья рамка задевает коробку ±8 по x/z и
//    ±5 по y от центра низа ИЗГОЛОВЬЯ, если monster.isPreventingPlayerRest()
//    → NOT_SAFE «рядом монстры». Переопределено только у зомби-пиглина (мешает,
//    только когда злится). Коробка берётся сквозь блоки: стены и крыша не
//    помогают, помогает расстояние — и глубина: моб на поверхности, чьи ноги на
//    5+ блоков выше кровати, в коробку уже не попадает (AABB.intersects строгое).

// Кто мешает спать: все наследники Monster из jar (javap по
// net/minecraft/world/entity/**). Слизень, магмовый куб, фантом, гаст, шалкер,
// хоглин — не Monster и сну не мешают.
const RESTLESS = new Set([
  'blaze', 'bogged', 'breeze', 'cave_spider', 'creaking', 'creeper', 'drowned', 'elder_guardian',
  'enderman', 'endermite', 'evoker', 'giant', 'guardian', 'husk', 'illusioner', 'parched', 'piglin',
  'piglin_brute', 'pillager', 'ravager', 'silverfish', 'skeleton', 'spider', 'stray', 'vex',
  'vindicator', 'warden', 'witch', 'wither', 'wither_skeleton', 'zoglin', 'zombie', 'zombie_villager'
])

const NIGHT_FROM = 12542
const NIGHT_TO = 23459
// Сумерки: с этого часа кровать уже пора ставить, а ложиться — с NIGHT_FROM.
// 700 тиков — 35 секунд: успеть дойти, поставить и не терять день.
const DUSK_FROM = 11840
// Кровать на 6 ниже ног на поверхности: у моба наверху ноги на 6 выше, а в
// коробку попадают только те, у кого ниже +5. Лишний блок — на неровность
// рельефа вокруг.
const BUNKER_DEPTH = 6
const CARDINALS = [[0, -1], [0, 1], [-1, 0], [1, 0]]

function sleep (ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
const tod = (bot) => bot.time && typeof bot.time.timeOfDay === 'number' ? bot.time.timeOfDay : 6000
// Гроза — по уровню грозы (perception.thundering, 2026-09-26): флаг
// bot.isRaining на Paper вывернут и под дождём не встаёт.
const storm = (bot) => require('./perception').thundering(bot)
const sleepTime = (bot) => storm(bot) || (tod(bot) >= NIGHT_FROM && tod(bot) <= NIGHT_TO)
const isBed = (b) => !!b && /_bed$/.test(b.name)
const key = (p) => `${p.x},${p.y},${p.z}`
const xyz = (p) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })

// Кто из мобов в коробке сна вокруг изголовья head (Vec3 блока).
function bedThreats (bot, head) {
  const cx = head.x + 0.5
  const cy = head.y
  const cz = head.z + 0.5
  const out = []
  for (const e of Object.values(bot.entities)) {
    if (!e || e === bot.entity || !RESTLESS.has(e.name)) continue
    const w = (e.width || 0.6) / 2
    const h = e.height || 1.8
    const p = e.position
    const inside = p.x - w < cx + 8 && p.x + w > cx - 8 &&
      p.y < cy + 5 && p.y + h > cy - 5 &&
      p.z - w < cz + 8 && p.z + w > cz - 8
    if (!inside) continue
    out.push({ id: e.id, name: e.name, dist: Math.round(Math.hypot(p.x - cx, p.z - cz)), dy: Math.round(p.y - cy) })
  }
  return out.sort((a, b) => a.dist - b.dist)
}

function threatText (list) {
  return list.slice(0, 4).map(t => `${t.name} ${t.dist}м${t.dy ? (t.dy > 0 ? ` +${t.dy}` : ` ${t.dy}`) : ''}`).join(', ')
}

// Кровать поблизости — сначала своя (поставленная нами), потом любая свободная.
function spawnBedKey (session) {
  const sb = session.journal && session.journal.state && session.journal.state.spawnBed
  // Чужая кровать (спали в кровати игрока) — точка, но не наша: не уносить.
  return sb && sb.own !== false ? key(sb) : null
}

function nearbyBed (session, bot, radius = 8) {
  const mine = new Set(session.myBeds || [])
  const sk = spawnBedKey(session)
  if (sk) mine.add(sk)
  const found = bot.findBlocks({ matching: b => isBed(b), maxDistance: radius, count: 8 }) || []
  let best = null
  for (const p of found) {
    const b = bot.blockAt(p)
    if (!b) continue
    const own = mine.has(key(p))
    const d = p.distanceTo(bot.entity.position)
    if (!best || (own && !best.own) || (own === best.own && d < best.d)) best = { block: b, own, d }
  }
  return best
}

function bedItem (bot) {
  return bot.inventory.items().find(i => /_bed$/.test(i.name)) || null
}

// ---------------------------------------------------------------- бункер
//
// Шахта вниз на BUNKER_DEPTH, засыпанная за собой: с третьего блока каждый
// шаг вниз закладывает клетку над головой тем, что только что выкопали, —
// поверхность остаётся ровной, и моб наверху не падает к нам в трубу. Внизу
// ниша 2×2 в сторону — под кровать (ей нужны две клетки в ряд, над ними
// свободно, под ними твёрдо).
async function bunker (session, ctl, { depth = BUNKER_DEPTH, deadline }) {
  const bot = session.bot
  const mcData = session.mcData
  const survival = require('./survival')
  const { placeBlockAt } = require('./build')
  const { equipBestTool, missingHarvestTool } = require('./items')
  const { inWater } = require('./movement')
  if (inWater(bot)) return { ok: false, why: 'я в воде — тут не закопаешься' }

  const startY = Math.floor(bot.entity.position.y)
  const dug = () => startY - Math.floor(bot.entity.position.y)
  let stopped = null
  let lid = 0
  let swings = 0
  while (dug() < depth && swings < depth * 3 && !ctl.aborted && Date.now() < deadline) {
    const r = await survival.sinkOne(bot, mcData)
    swings++
    if (r.stopped) { stopped = r.stopped; break }
    if (dug() >= 3) {
      const put = await placeBlockAt(bot, bot.entity.position.floored().offset(0, 2, 0))
      if (put.ok) lid++
    }
  }
  if (dug() >= 3 && !lid) {
    const put = await placeBlockAt(bot, bot.entity.position.floored().offset(0, 2, 0))
    if (put.ok) lid++
  }
  if (dug() < 3) return { ok: false, depth: dug(), why: `вниз только на ${dug()}${stopped ? ' — ' + stopped : ''}` }

  // Ниша под кровать.
  const feet = bot.entity.position.floored()
  const at = (p) => bot.blockAt(p)
  const wet = (p) => { const b = at(p); return !b || /water|lava/.test(b.name) }
  const solid = (p) => { const b = at(p); return !!b && b.boundingBox === 'block' && !/sand|gravel|powder/.test(b.name) }
  const near6 = (p) => [p, p.offset(1, 0, 0), p.offset(-1, 0, 0), p.offset(0, 1, 0), p.offset(0, -1, 0), p.offset(0, 0, 1), p.offset(0, 0, -1)]
  let pocket = null
  for (const [dx, dz] of CARDINALS) {
    const a = feet.offset(dx, 0, dz)
    const b = feet.offset(dx * 2, 0, dz * 2)
    const cells = [a, a.offset(0, 1, 0), b, b.offset(0, 1, 0)]
    if (!solid(a.offset(0, -1, 0)) || !solid(b.offset(0, -1, 0))) continue
    if (cells.some(c => near6(c).some(wet))) continue
    // Песок и гравий над нишей осыплются в неё — такая сторона не годится.
    if ([a.offset(0, 2, 0), b.offset(0, 2, 0)].some(c => { const k = at(c); return k && /sand|gravel|powder/.test(k.name) })) continue
    if (cells.some(c => { const k = at(c); return !k || k.name === 'bedrock' || (k.boundingBox === 'block' && missingHarvestTool(bot, k, mcData)) })) continue
    pocket = { a, b, dir: [dx, dz] }
    break
  }
  if (!pocket) return { ok: false, depth: dug(), sealed: lid > 0, why: 'в стороны ниша не копается (вода, лава, песок или нечем)' }
  for (const c of [pocket.a, pocket.a.offset(0, 1, 0), pocket.b, pocket.b.offset(0, 1, 0)]) {
    if (ctl.aborted) break
    const k = at(c)
    if (!k || k.boundingBox === 'empty') continue
    try { await equipBestTool(bot, k); await bot.dig(k) } catch (e) { return { ok: false, depth: dug(), why: `ниша: ${e.message}` } }
  }
  return { ok: true, depth: dug(), sealed: lid > 0, startY, pocket, stopped: stopped || undefined }
}

// Утром — наверх. Столбом по своей трубе выходило через раз (тело сползало в
// нишу из-под кровати), а survival.surface — проверенный выход лестницей из
// любой глубины (try-surface).
async function climbOut (session, ctl, startY) {
  const bot = session.bot
  if (Math.floor(bot.entity.position.y) >= startY) return { ok: true, y: Math.floor(bot.entity.position.y) }
  let r = null
  try { r = await require('./survival').surface(session, ctl, { timeoutSeconds: 90 }) } catch (e) { return { ok: false, why: e.message } }
  return { ok: !!(r && r.out), y: Math.floor(bot.entity.position.y), why: r && !r.out ? (r.note || r.stopped) : undefined }
}

// Забрать кровать: ломается с руки за миг, падает одним предметом.
async function takeBed (session, ctl, bedBlock) {
  const bot = session.bot
  const actions = require('./actions')
  const before = bot.inventory.items().filter(i => /_bed$/.test(i.name)).reduce((n, i) => n + i.count, 0)
  const b = bot.blockAt(bedBlock.position)
  if (!isBed(b)) return { took: false, why: 'кровати на месте нет' }
  try {
    const axe = bot.inventory.items().find(i => /_axe$/.test(i.name))
    if (axe) await bot.equip(axe, 'hand')
    await bot.dig(b)
  } catch (e) { return { took: false, why: e.message } }
  if (session.myBeds) session.myBeds.delete(key(b.position))
  forgetSpawnBed(session, b.position)
  // Кровать падает только из изголовья (loot_table blocks/*_bed: part=head) —
  // дроп там, куда смотрит кровать, а не под ногами.
  const bedCount = () => bot.inventory.items().filter(i => /_bed$/.test(i.name)).reduce((n, i) => n + i.count, 0)
  for (let i = 0; i < 3 && bedCount() <= before && !ctl.aborted; i++) {
    try { await actions.collectNearbyDrops(bot, ctl, { radius: 6, timeoutMs: 5000 }) } catch {}
    if (bedCount() <= before) await sleep(500)
  }
  const after = bedCount()
  if (after > before) return { took: true }
  const items = Object.values(bot.entities).filter(e => e && e.name === 'item' && e.position.distanceTo(bot.entity.position) < 8)
    .map(e => { let n = '?'; try { n = e.getDroppedItem().name } catch {} return `${n}@${e.position.distanceTo(bot.entity.position).toFixed(1)}` })
  return { took: false, why: `сломал, а подобрать не вышло (рядом: ${items.join(', ') || 'ничего'})` }
}

// ---------------------------------------------------------------- ночь целиком
//
// p.untilMorning (true), p.waitSeconds — сколько ждать пропуска ночи в
// кровати (60), p.take — забрать кровать утром ('auto': свою да, чужую нет),
// p.bunker — уходить под землю от мобов (true), p.exit — утром вылезти из
// бункера (true), p.invite — позвать других игроков лечь (true).
async function night (session, ctl, p = {}) {
  const bot = session.bot
  const actions = require('./actions')
  const { untilMorning = true, waitSeconds = 60, take = 'auto', bunker: allowBunker = true, exit = true, invite = true } = p
  if (!session.myBeds) session.myBeds = new Set()
  const log = []
  const out = { sleeping: false, log }
  const note = (t) => log.push(t)

  const dim = bot.game && bot.game.dimension
  if (dim && dim !== 'overworld') {
    throw new Error(`${dim === 'the_nether' ? 'в Аду' : 'здесь'} кровать взрывается (BedRule explodes) — не ставлю. Переждать — mc_shelter`)
  }
  const deadline = Date.now() + Math.max(60, Math.min(600, p.timeoutSeconds ?? 300)) * 1000

  if (!bot.isSleeping) {
    const t0 = tod(bot)
    if (!sleepTime(bot) && !(t0 >= DUSK_FROM && t0 < NIGHT_FROM)) {
      throw new Error(`спать можно только ночью (с ${NIGHT_FROM}) или в грозу — сейчас ${t0}`)
    }

    // Кровать: рядом или в рюкзаке.
    let near = nearbyBed(session, bot)
    let item = bedItem(bot)
    if (!near && !item) throw new Error('кровати нет ни рядом, ни в рюкзаке — нужна: 3 шерсти + 3 доски (mc_craft bed)')

    const feet = bot.entity.position.floored()
    let threats = bedThreats(bot, near ? near.block.position : feet)
    let bunk = null
    // Мобы рядом, а кровать можно унести — вниз, под них.
    if ((threats.length || p._bunker) && allowBunker) {
      if (near && near.own && !item) {
        const got = await takeBed(session, ctl, near.block)
        if (got.took) { item = bedItem(bot); near = null; note('забрал кровать — тут не уснуть') }
      }
      if (item && !near) {
        note(`рядом ${threatText(threats)} — сплю под землёй`)
        bunk = await bunker(session, ctl, { deadline })
        if (!bunk.ok) note(`бункер: ${bunk.why}`)
        else note(`бункер на ${bunk.depth} вниз${bunk.sealed ? ', засыпан' : ', крышки нет'}`)
      }
    }

    // Поставить кровать.
    if (!near || (bunk && bunk.ok)) {
      if (!item) throw new Error('кровать осталась наверху — нечего ставить')
      const put = await actions.placeBed(session, ctl, item.name)
      const placed = bot.blockAt(new Vec3(put.at.x, put.at.y, put.at.z))
      if (!isBed(placed)) throw new Error(`поставил кровать на ${put.at.x},${put.at.y},${put.at.z}, но в мире её не вижу`)
      const halves = actions.bedHalves(bot, placed)
      for (const h of [halves.head, halves.foot]) if (h) session.myBeds.add(key(h.position))
      near = { block: halves.head || placed, own: true }
      note(`поставил кровать ${put.at.x},${put.at.y},${put.at.z}`)
    }

    const halves = actions.bedHalves(bot, near.block)
    const head = halves.head || near.block
    out.at = xyz(head.position)
    out.bunker = bunk && bunk.ok ? { depth: bunk.depth, sealed: bunk.sealed, surfaceY: bunk.startY } : undefined

    // Сумерки: кровать стоит, ложимся с первым тиком ночи — раньше мобов.
    if (!sleepTime(bot)) {
      note(`сумерки (${tod(bot)}) — жду ${NIGHT_FROM}`)
      while (!sleepTime(bot) && !ctl.aborted && Date.now() < deadline) await sleep(400)
    }

    // Мобы в коробке у изголовья: подождать (в бункере они не дойдут), а на
    // поверхности, если бункера ещё не было, — забрать кровать и вниз.
    let waited = 0
    for (;;) {
      if (ctl.aborted || Date.now() >= deadline || !sleepTime(bot)) break
      threats = bedThreats(bot, head.position)
      if (!threats.length) break
      if (!bunk && allowBunker && near.own) {
        const got = await takeBed(session, ctl, near.block)
        if (got.took) {
          note(`мобы подошли (${threatText(threats)}) — ухожу под землю`)
          return await night(session, ctl, { ...p, _bunker: true, timeoutSeconds: Math.max(60, (deadline - Date.now()) / 1000) })
        }
      }
      if (!waited) note(`не уснуть — рядом ${threatText(threats)}; жду, пока уйдут`)
      waited++
      if (!bunk && waited > 8) {
        out.problem = 'monsters'
        out.monsters = threats
        out.note = `рядом монстры (${threatText(threats)}) — сервер не даст лечь; разогнать (mc_fight) или уйти под землю`
        return out
      }
      await sleep(3000)
    }
    if (!sleepTime(bot)) { out.note = 'пока ждал — рассвело'; out.morning = true; return out }
    if (ctl.aborted) return out

    // Лечь.
    // Подходить, только если сервер не дотянется (isReachableBedBlock: 3/2/3
    // от центра низа любой половины). Иначе GoalNear у кровати в нише бункера
    // прокапывал ход ПОД неё — и сервер молча отказывал.
    const hp = head.position
    const reach = (b) => { const q = bot.entity.position; return !!b && Math.abs(q.x - b.position.x - 0.5) <= 3 && Math.abs(q.y - b.position.y) <= 2 && Math.abs(q.z - b.position.z - 0.5) <= 3 }
    if (!reach(head) && !reach(halves.foot)) {
      try { await bot.pathfinder.goto(new goals.GoalNear(hp.x, hp.y, hp.z, 2)) } catch {}
    }
    // Отказ сервер пишет в строку над хотбаром (displayClientMessage overlay),
    // а mineflayer знает только «bot is not sleeping» — слушаем сами.
    let heard = null
    const onBar = (m) => { try { heard = heard || m.toString() } catch {} }
    const onMsg = (m) => { try { const t = m.toString(); if (/rest|sleep|bed|monster|спать|кроват/i.test(t)) heard = heard || t } catch {} }
    bot.on('actionBar', onBar)
    bot.on('message', onMsg)
    try {
      await bot.sleep(head)
    } catch (e) {
      await sleep(300)
      const text = `${e.message}${heard ? ' / ' + heard : ''}`
      const monsters = /monster/i.test(text)
      const why = monsters ? `рядом монстры (${threatText(bedThreats(bot, hp)) || 'не вижу их — в пещере рядом'})` : text
      out.problem = monsters ? 'monsters' : 'refused'
      out.note = `не лёг: ${why}`
      out.pos = xyz(bot.entity.position)
      return out
    } finally {
      bot.removeListener('actionBar', onBar)
      bot.removeListener('message', onMsg)
    }
    out.sleeping = true
    note('лёг')
    const others = Object.keys(bot.players).filter(n => n !== bot.username)
    if (invite && others.length && session.nightInvited !== (bot.time && bot.time.day)) {
      session.nightInvited = bot.time && bot.time.day
      try { bot.chat('Я лёг спать — ложитесь тоже, проскочим ночь') } catch {}
    }
  }

  if (!untilMorning) return out

  // Ждём пропуска ночи. Сервер будит всех сам, как только нужная доля
  // игроков (playersSleepingPercentage) в кроватях ~100 тиков.
  const until = Math.min(deadline, Date.now() + Math.max(5, Math.min(300, waitSeconds)) * 1000)
  while (Date.now() < until && !ctl.aborted && bot.isSleeping && sleepTime(bot)) await sleep(500)
  // Сервер будит сразу, а время шлёт своим чередом (раз в 20 тиков) — «встал,
  // а на часах ночь» ещё не значит, что ночь не проскочила.
  await sleep(600)
  for (let i = 0; i < 12 && !bot.isSleeping && sleepTime(bot); i++) await sleep(250)
  out.morning = !sleepTime(bot)
  out.timeOfDay = tod(bot)
  if (!out.morning) {
    // Ночь не проскочила: кто-то не спит. Лежать до утра — терять ночь целиком.
    if (bot.isSleeping) { try { await bot.wake() } catch {} }
    out.note = 'ночь не проскочила — не спят другие игроки; встал'
    out.othersAwake = true
    return out
  }
  session.lastRest = Date.now()
  note('утро')

  // Утро: своя кровать — с собой, чужая — на месте. Сон ставит точку
  // возрождения в эту кровать (startSleepInBed → setRespawnPosition), так что
  // забрать её — остаться без точки: возродишься на спавне мира. Кровать-точку
  // (spawnBed, поставлена нарочно) не трогаем.
  const bedHere = nearbyBed(session, bot, 4)
  const mine = bedHere && bedHere.own
  const sk = spawnBedKey(session)
  const parts = bedHere ? [bedHere.block, ...Object.values(actions.bedHalves(bot, bedHere.block)).filter(b => b && b.position)] : []
  const isSpawnBed = !!(sk && parts.some(b => key(b.position) === sk))
  const wantTake = !isSpawnBed && (take === true || (take === 'auto' && mine))
  if (bedHere && wantTake) {
    const got = await takeBed(session, ctl, bedHere.block)
    out.tookBed = got.took
    note(got.took ? 'кровать забрал' : `кровать не забрал: ${got.why}`)
    if (got.took && session.journal.state.spawnBed) {
      // Точка уже переехала сюда сном — старая кровать-точка больше не точка.
      session.journal.patch(st => { st.spawnBed = null })
      note('точка возрождения сбита: спал в другой кровати и забрал её')
    }
  } else if (bedHere) {
    rememberSpawnBed(session, bedHere.block.position, isSpawnBed ? undefined : 'сон', !!mine)
    out.spawnSet = true
    note('кровать оставил — здесь точка возрождения')
  }
  if (out.bunker && exit && !ctl.aborted) {
    const up = await climbOut(session, ctl, out.bunker.surfaceY)
    out.climbed = up.ok
    note(up.ok ? 'вылез наверх' : `наверх не вылез: ${up.why}`)
  }
  return out
}

// ---------------------------------------------------------------- точка возрождения
//
// В верхнем мире у кровати can_set_spawn = ALWAYS (BedRule.CAN_SLEEP_WHEN_DARK):
// клик по кровати даже днём ставит точку возрождения («Respawn point set»,
// block.minecraft.set_spawn), и только потом сервер отвечает «спать только
// ночью». При возрождении кровать должна стоять и рядом должно быть где встать
// (BedBlock.findStandUpPosition), иначе NO_RESPAWN_BLOCK_AVAILABLE — на спавн
// мира. В Аду и Энде правило EXPLODES: точки нет, кровать взрывается.
//
// Зачем боту: перед рискованным — Ад, спуск за алмазами, Энд — точку ставят
// рядом, и смерть стоит пары минут, а не пути через полмира.

function rememberSpawnBed (session, pos, why, own = true) {
  const rec = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), dimension: 'overworld', at: new Date().toISOString(), own }
  session.journal.patch(st => {
    const old = st.spawnBed
    st.spawnBed = { ...rec, why: why || (old && key(old) === key(rec) ? old.why : undefined) }
    st.places = st.places || {}
    st.places['точка возрождения'] = { x: rec.x, y: rec.y, z: rec.z, note: `кровать${why ? ' — ' + why : ''}` }
  })
}

function forgetSpawnBed (session, pos) {
  const sb = session.journal && session.journal.state && session.journal.state.spawnBed
  if (!sb) return
  // Кровать — две клетки: сломали любую — точки нет.
  if (pos && (Math.abs(sb.x - pos.x) + Math.abs(sb.z - pos.z) > 1 || sb.y !== Math.floor(pos.y))) return
  session.journal.patch(st => { st.spawnBed = null; if (st.places) delete st.places['точка возрождения'] })
}

// Сервер сказал «точки нет» (кровать сломали или заставили) — забыть.
function install (session) {
  const bot = session.bot
  if (!bot || bot._ndBedtime) return
  bot._ndBedtime = true
  bot.on('spawnReset', () => {
    const had = session.journal.state.spawnBed
    forgetSpawnBed(session, null)
    if (had) session.journal.append('кровать', `точка возрождения пропала: кровать на ${had.x},${had.y},${had.z} сломана или заставлена`)
  })
}

async function setSpawn (session, ctl, p = {}) {
  const bot = session.bot
  const actions = require('./actions')
  if (!session.myBeds) session.myBeds = new Set()
  const dim = bot.game && bot.game.dimension
  if (dim && dim !== 'overworld') throw new Error('точку возрождения кровать ставит только в верхнем мире — здесь она взрывается (в Аду точку ставит якорь возрождения)')
  let near = nearbyBed(session, bot, 6)
  let placedNote = null
  if (!near || !near.own) {
    const item = bedItem(bot)
    if (!item) {
      if (near) throw new Error('своей кровати нет, а чужую под точку не беру — поставь свою (3 шерсти + 3 доски)')
      throw new Error('кровати нет — нечего ставить')
    }
    const put = await actions.placeBed(session, ctl, item.name)
    const placed = bot.blockAt(new Vec3(put.at.x, put.at.y, put.at.z))
    if (!isBed(placed)) throw new Error(`поставил кровать на ${put.at.x},${put.at.y},${put.at.z}, но в мире её не вижу`)
    for (const h of Object.values(actions.bedHalves(bot, placed))) if (h && h.position) session.myBeds.add(key(h.position))
    near = { block: placed, own: true }
    placedNote = `поставил кровать ${put.at.x},${put.at.y},${put.at.z}`
  }
  const halves = actions.bedHalves(bot, near.block)
  const head = halves.head || near.block

  let heard = null
  const hear = (m) => { try { const t = m.toString(); if (/respawn point set|set_spawn|точка возрождения/i.test(t)) heard = t } catch {} }
  bot.on('message', hear)
  bot.on('actionBar', hear)
  try {
    try { await bot.lookAt(head.position.offset(0.5, 0.3, 0.5), true) } catch {}
    await bot.activateBlock(head)
    for (let i = 0; i < 12 && !heard; i++) await sleep(150)
  } finally {
    bot.removeListener('message', hear)
    bot.removeListener('actionBar', hear)
  }
  // Ночью клик — это ещё и сон: точка та же, а лежать не просили.
  if (bot.isSleeping) { try { await bot.wake() } catch {} }
  if (!heard) {
    return { set: false, at: xyz(head.position), note: `${placedNote ? placedNote + '; ' : ''}сервер не подтвердил точку (монстры рядом? кровать далеко?)` }
  }
  rememberSpawnBed(session, head.position, p.why)
  return { set: true, at: xyz(head.position), placed: !!placedNote, note: `${placedNote ? placedNote + '; ' : ''}точка возрождения здесь${p.why ? ' — ' + p.why : ''}. Кровать оставляю: сломать её — потерять точку` }
}

// Забрать кровать-точку (или свою рядом), когда место больше не нужно.
async function takeSpawnBed (session, ctl) {
  const bot = session.bot
  const near = nearbyBed(session, bot, 8)
  if (!near || !near.own) throw new Error('своей кровати рядом нет')
  const got = await takeBed(session, ctl, near.block)
  return { took: got.took, note: got.took ? 'кровать забрал; точки возрождения больше нет — возрождение на спавне мира' : got.why }
}

module.exports = { night, setSpawn, takeSpawnBed, install, bedThreats, bunker, takeBed, RESTLESS, NIGHT_FROM, NIGHT_TO, DUSK_FROM, sleepTime }

