'use strict'
// Кровать: поставить, лечь, встать; причины отказа сна.
// ---------------------------------------------------------------- sleep
const gameClock: typeof import('../game-clock') = require('../game-clock')
const { goals }: typeof import('mineflayer-pathfinder') = require('mineflayer-pathfinder')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const { sleep, xyz }: typeof import('../movement') = require('../movement')
const { itemNamed, itemMatching }: typeof import('../items') = require('../items')
const { withTimeout }: typeof import('../build') = require('../build')
const isBed = b => !!b && /_bed$/.test(b.name)

// facing on a bed points from the foot toward the head.
const BED_FACING = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] }
const CARDINALS = [[0, -1], [0, 1], [-1, 0], [1, 0]]

function bedProps (block) {
  try { return block.getProperties() || {} } catch { return {} }
}

// Which half is which. Checked against all 16 bed states on 1.21.11:
// mineflayer's own state decoding is correct, so the metadata is trustworthy —
// but the world is trusted over it anyway, because the failure being fixed here
// is exactly the case where the two disagree.
function bedHalves (bot, block) {
  const props = bedProps(block)
  const out = { props, head: null, foot: null }
  if (props.part === 'head') out.head = block
  else if (props.part === 'foot') out.foot = block

  const dir = BED_FACING[props.facing]
  if (dir) {
    const away = props.part === 'head' ? [-dir[0], -dir[1]] : dir
    const other = bot.blockAt(block.position.offset(away[0], 0, away[1]))
    if (isBed(other)) {
      if (props.part === 'head') out.foot = other
      else out.head = other
    }
  }

  if (!out.head || !out.foot) {
    for (const [dx, dz] of CARDINALS) {
      const nb = bot.blockAt(block.position.offset(dx, 0, dz))
      if (!isBed(nb)) continue
      const part = bedProps(nb).part
      if (part === 'head' && !out.head) out.head = nb
      if (part === 'foot' && !out.foot) out.foot = nb
    }
  }
  return out
}

// "there's only half bed" on its own tells the brain nothing it can act on.
// Dump what the two squares actually are so the next attempt is informed.
function describeBed (bot, block) {
  const around = CARDINALS.map(([dx, dz]) => {
    const nb = bot.blockAt(block.position.offset(dx, 0, dz))
    return `${dx},${dz}:${nb ? nb.name : 'null'}`
  })
  const p = xyz(block.position)
  return `${block.name}@${p.x},${p.y},${p.z} ${JSON.stringify(bedProps(block))} вокруг[${around.join(' ')}]`
}

const BED_ERRORS = [
  [/only half bed/, 'вторая половина кровати не видна — кровать легла криво или чанк не догрузился'],
  [/not night/, 'ещё не ночь и грозы нет'],
  [/bed is occupied/, 'кровать занята'],
  [/bed is too far/, 'до кровати далеко'],
  [/cant click the bed/, 'до кровати не дотянуться, что-то мешает'],
  [/monsters nearby/, 'рядом мобы — сначала разогнать'],
  [/not sleeping/, 'сервер не подтвердил сон'],
  [/already sleeping/, 'уже сплю'],
  [/not a bed block/, 'это не кровать']
]

function translateBedError (message) {
  for (const [re, text] of (BED_ERRORS as any)) if (re.test(message)) return text
  return message
}

// The server refuses outright before we ever click, and its reasons are things
// the brain can actually fix. Naming which one beats a generic failure.
function whyNotSleep (bot) {
  if (bot.isSleeping) return 'уже сплю'
  // Вне верхнего мира кровать взрывается при попытке лечь (damage_type
  // bad_respawn_point) — самая дешёвая гарантированная смерть в Аду. Отказ до
  // постановки: часы тут ничего не решают.
  const dim = bot.game && bot.game.dimension
  if (dim && dim !== 'overworld') {
    return `${dim === 'the_nether' ? 'в Аду' : 'здесь'} кровать взрывается — не ставлю и не ложусь. Переждать можно в mc_shelter, ` +
      'точка возрождения переносится только в верхнем мире'
  }
  const t = bot.time ? bot.time.timeOfDay : 0
  // Гроза — по уровню грозы (perception.thundering, 2026-09-26): флаг
  // bot.isRaining на Paper вывернут и под дождём не встаёт.
  const storm = (require('../perception') as typeof import('../perception')).thundering(bot)
  if (!storm && !(t >= 12541 && t <= 23458)) return `спать можно только ночью или в грозу (сейчас ${t} тиков)`
  return null
}

// Vanilla drops the foot where you click and stretches the head away from you,
// so a bed needs two free squares in a row with solid ground under both — and
// the bot has to stand in line with them, because the server reads the head
// direction off our yaw. place() only ever guarantees one square, which is how
// beds ended up facing into a wall.
async function placeBed (session, ctl, name) {
  const bot = session.bot
  const item = itemNamed(bot, name)
  if (!item) throw new Error(`нет ${name} в инвентаре`)

  const feet = bot.entity.position.floored()
  const head = feet.offset(0, 1, 0)
  const free = p => { const b = bot.blockAt(p); return !!b && b.boundingBox === 'empty' && !/water|lava/.test(b.name) }
  const solid = p => { const b = bot.blockAt(p); return !!b && b.boundingBox === 'block' }
  const mine = p => p.equals(feet) || p.equals(head)

  const spots = []
  for (const [dx, dz] of CARDINALS) {
    for (let d = 1; d <= 3; d++) {
      for (const dy of [0, -1, 1]) {
        const foot = feet.offset(dx * d, dy, dz * d)
        const bedHead = foot.offset(dx, 0, dz)
        if (mine(foot) || mine(bedHead)) continue
        if (!free(foot) || !free(bedHead)) continue
        if (!solid(foot.offset(0, -1, 0)) || !solid(bedHead.offset(0, -1, 0))) continue
        if (!free(foot.offset(0, 1, 0)) || !free(bedHead.offset(0, 1, 0))) continue
        spots.push({ ground: bot.blockAt(foot.offset(0, -1, 0)), foot, bedHead, dist: d })
      }
    }
  }
  if (!spots.length) throw new Error('негде поставить кровать — нужны две свободные клетки в ряд на твёрдой земле')
  spots.sort((a, b) => a.dist - b.dist)

  await bot.equip(item, 'hand')
  let last = null
  for (const spot of spots.slice(0, 8)) {
    if (ctl.aborted) break
    try {
      await withTimeout(bot.placeBlock(spot.ground, new Vec3(0, 1, 0)), 6000)
      await sleep(300) // the second half arrives in its own block update
      if (isBed(bot.blockAt(spot.foot))) return { at: xyz(spot.foot), aimedHead: xyz(spot.bedHead) }
    } catch (e) {
      last = e
      // The server may have applied it anyway; we only stopped waiting.
      if (isBed(bot.blockAt(spot.foot))) {
        return { at: xyz(spot.foot), aimedHead: xyz(spot.bedHead), note: 'подтверждения не дождался' }
      }
    }
  }
  throw new Error(`не смог поставить кровать${last ? ': ' + last.message : ''}`)
}

// Sleeping is the actual answer to "survive the night" — it skips the night and
// resets the spawn point, which matters a lot for a bot that keeps dying.
//
// The old failure was self-inflicted. findBlock returns whichever half is
// nearest, and mineflayer only goes hunting for the missing half when you hand
// it the FOOT — that search is the single place "there's only half bed" is
// thrown. Hand it the HEAD and the branch cannot run at all.
async function sleepInBed (session, ctl, { untilMorning = true, waitSeconds = 40 }: any = {}) {
  const bot = session.bot
  const blocked = whyNotSleep(bot)
  if (blocked) throw new Error(blocked)

  let bed = bot.findBlock({ matching: isBed, maxDistance: 8 })
  let placedNote = null

  if (!bed) {
    const item = itemMatching(bot, /_bed$/)
    if (!item) throw new Error('кровати нет ни рядом, ни в инвентаре')
    const put = await placeBed(session, ctl, item.name)
    placedNote = put.note
    bed = bot.findBlock({ matching: isBed, maxDistance: 8 })
    if (!bed) throw new Error(`поставил кровать на ${put.at.x},${put.at.y},${put.at.z}, но в мире её не вижу`)
  }

  const halves = bedHalves(bot, bed)
  const target = halves.head || halves.foot || bed

  // mineflayer measures the click box from the head, not from whichever half we
  // happened to spot first, so close the distance to the half being clicked.
  const p = target.position
  if (p.distanceTo(bot.entity.position) > 2.2) {
    try { await bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 1)) } catch {}
  }

  try {
    await bot.sleep(target)
  } catch (err) {
    throw new Error(`не лёг спать: ${translateBedError(err.message)} · ${describeBed(bot, bed)}`)
  }

  const out: any = {
    sleeping: true,
    at: xyz(p),
    half: bedProps(target).part || '?',
    bothHalves: !!(halves.head && halves.foot),
    note: placedNote || undefined
  }
  if (!untilMorning) return out

  // Lying down is not the point — skipping the night is. The server only fires
  // the skip about 100 ticks after everyone is in bed, so a call that returns
  // the instant the bot is horizontal has done nothing useful yet.
  const deadline = gameClock.now() + Math.max(5, Math.min(120, waitSeconds)) * 1000
  while (gameClock.now() < deadline && !ctl.aborted && bot.isSleeping) {
    const t = bot.time ? bot.time.timeOfDay : 0
    if (t < 12541 || t > 23458) break
    await sleep(500)
  }
  // The server wakes us the moment it skips the night, and the time packet
  // lands a beat later — read it too early and the result claims morning while
  // still showing a night clock.
  await sleep(600)
  out.morning = !bot.isSleeping || (bot.time && bot.time.timeOfDay < 12541)
  out.timeOfDay = bot.time ? bot.time.timeOfDay : null
  if (!out.morning) out.note = 'ночь не проскочила — видимо, кто-то ещё не спит'
  return out
}

async function wakeUp (session) {
  const bot = session.bot
  if (!bot.isSleeping) return { note: 'и так не сплю' }
  await bot.wake()
  return { woke: true }
}

export { bedHalves, describeBed, placeBed, sleepInBed, wakeUp }
