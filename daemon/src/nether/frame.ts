'use strict'
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { xyz } from '../movement'
import { placeBlockAt, pickFiller } from '../build'
import { itemNamed } from '../items'
import * as worlds from '../worlds'
import {
  INNER_W, INNER_H, FRAME_MIN, FRAME_BLOCK, PORTAL_EMPTY, IGNITERS, AXES, UP, at, frameCells, cornerCells,
  propFor, isSolid, isFluid, reader, neighbours, PLACE_RADIUS, REACH, eyes, centre
} from './shape'
import {
  standSpots, standable, planPortal, findFrames, PORTAL, rememberPortal, obsidianShortfall, propShortfall,
  igniterShortfall
} from './plan'
import { sleep, walkNear, inReach, clearCells } from './dig'
import { walkToward } from './walk'

// Один блок рамы, а потом вопрос МИРУ, а не возвращаемому значению.
//
// «ответа от сервера нет» — это build.withTimeout, то есть НАШ поводок, а не
// ответ сервера: mineflayer шлёт пакет и ждёт blockUpdate до 5000 мс
// (mineflayer/lib/plugins/place_block.js:13) и только после этого говорит своё
// «No block has been placed». Поводок короче пяти секунд обрывает собственную
// библиотеку и печатает своё молчание как чужой отказ — в первом прогоне так и
// пропал верхний блок рамы (1799,74,-1). Отсюда две вещи: поводок с запасом над
// этими пятью секундами и ещё одно чтение мира после него, потому что блок мог
// встать, пока мы уже не слушали.
// Сколько ждать подтверждения одной постановки. Вынесено отдельно и наружу,
// чтобы это число можно было сверить с библиотекой, а не с памятью: заглушка
// вычитывает `timeout: 5000` прямо из place_block.js и требует, чтобы наш
// поводок был длиннее. Треть остатка — потому что placeBlockAt тратит поводок
// на КАЖДУЮ пригодную грань, а бюджет должен пережить клетку, а не попытку.
const MINEFLAYER_PLACE_WAIT_MS = 5000
function placeLeash (leftMs) {
  return Math.max(MINEFLAYER_PLACE_WAIT_MS + 1500, Math.min(6500, Math.floor(leftMs / 3)))
}

async function putFrameBlock (bot, at, item, leftMs) {
  const leash = placeLeash(leftMs)
  const r = await placeBlockAt(bot, at, { item: item || undefined, timeoutMs: leash })
  if (r.ok) return { ok: true, already: !!r.already }
  await sleep(250) // пакет мог быть ещё в воздухе, когда поводок кончился
  const now = bot.blockAt(at)
  if (now && now.boundingBox === 'block' && (!item || now.name === item)) return { ok: true, late: true }
  return { ok: false, why: r.reason }
}

async function buildFrame (session, ctl, plan, deadline) {
  const bot = session.bot
  const propped = []
  const failed = new Map()
  const k = c => `${c.x},${c.y},${c.z}`
  let placed = 0
  let late = 0
  let attempts = 0

  // Опора спрашивается по живому миру, а не по плану: расчистка могла убрать
  // тот самый блок, на который план рассчитывал. Клетки дырки опорой не
  // считаются никогда — они обязаны остаться пустыми.
  const supported = c => neighbours(c).some(n => {
    const b = bot.blockAt(n)
    return isSolid(b) && !isFluid(b) && !plan.inner.some(i => i.equals(n))
  })

  // Подпорка в свой угол — и только когда клетке правда не на что опереться.
  const propUp = async (c) => {
    if (supported(c)) return
    const prop = propFor(plan.origin, plan.axis, c)
    const pb = prop && bot.blockAt(prop)
    if (!prop || !pb || pb.boundingBox !== 'empty') return
    const filler = pickFiller(bot)
    const pr = await putFrameBlock(bot, prop, filler ? filler.name : null, deadline - gameClock.now())
    if (pr.ok && !pr.already) propped.push(xyz(prop))
  }

  // Повтор делается НА МЕСТЕ, а не следующим кругом. Разница не в упрямстве, а
  // в том, на что опирается соседняя клетка: цепочка опор идёт снизу вверх, и
  // пока клетка пуста, следующая за ней вынуждена звать свой угол. Измерено в
  // игре: верхний левый блок сорвался один раз, верхний правый из-за этого
  // потребовал вторую подпорку, и рама собралась в два прохода (passes: 2,
  // props: оба верхних угла). Вторая попытка тут же стоит одного поводка,
  // проход — поводка на каждую оставшуюся клетку.
  const ATTEMPTS = 2
  const putOne = async (c) => {
    const existing = bot.blockAt(c)
    if (existing && existing.name === FRAME_BLOCK) { failed.delete(k(c)); return true }
    if (!(await inReach(session, ctl, c))) { failed.set(k(c), 'не дотянуться'); return false }
    let why = null
    for (let n = 0; n < ATTEMPTS && !ctl.aborted && gameClock.now() < deadline; n++) {
      if (n) { attempts++; await sleep(300, ctl) }
      await propUp(c)
      const r = await putFrameBlock(bot, c, FRAME_BLOCK, deadline - gameClock.now())
      if (r.ok) {
        if (!r.already) placed++
        if (r.late) late++
        failed.delete(k(c))
        return true
      }
      why = r.why
    }
    failed.set(k(c), why)
    return false
  }

  // Два круга, и второй — честная норма, а не запас на глупость. Порядок опор
  // детерминированный (каждая клетка опирается на поставленное раньше или на
  // свой угол), но УСПЕХ постановки нам не принадлежит: сервер вправе отказать.
  // Один отказ подряд съедает повтор на месте выше, и тогда круг один. Два
  // отказа подряд — это уже не дрожание, и тогда второй круг доносит клетку
  // после того, как соседи встали. Проверено по заглушке: один отказ -> passes 1,
  // два подряд -> passes 2 и рама всё равно целая.
  let passes = 0
  for (let pass = 0; pass < 2 && !ctl.aborted; pass++) {
    passes++
    let missing = 0
    for (const c of plan.frame) {
      if (ctl.aborted || gameClock.now() > deadline) break
      const b = bot.blockAt(c)
      if (b && b.name === FRAME_BLOCK) continue
      if (!(await putOne(c))) missing++
    }
    if (!missing) break
    await sleep(400, ctl)
  }

  const standing = plan.frame.filter(c => {
    const b = bot.blockAt(c)
    return b && b.name === FRAME_BLOCK
  }).length

  return {
    placed,
    late: late || undefined,
    retries: attempts || undefined,
    // Кругов, а не попыток. Второе чтение мира внутри putFrameBlock стоит
    // 250 мс и экономит целый круг: без него опоздавший блок замечает только
    // следующий проход, а проход — это поводок на каждую оставшуюся клетку,
    // то есть секунды из бюджета, за которые портал должен успеть загореться.
    passes,
    standing,
    propped,
    failed: failed.size ? [...failed].map(([at, why]) => `${at}: ${why}`) : undefined
  }
}

// Right-click the top of a bottom frame block with flint and steel: the fire
// lands in the interior cell above it, and BaseFireBlock.onPlace runs
// PortalShape and fills the hole. bot.activateBlock would do, but _genericPlace
// is what build.js already uses for exactly this reason — mineflayer's
// placeBlock waits for a block update the 1.21.11 server does not always send
// for the cell you aimed at, and here the cell turns into nether_portal rather
// than into fire, which is a different update again. So: fire the packet, then
// read the world.
async function ignite (session, ctl, plan) {
  const bot = session.bot
  const item = IGNITERS.map(n => itemNamed(bot, n)).find(Boolean)
  if (!item) return { lit: false, reason: 'зажигать нечем' }
  try { await bot.equip(item, 'hand') } catch (e) { return { lit: false, reason: e.message } }

  const u = AXES[plan.axis]
  // Two aims, both landing fire in the bottom-left interior cell: the top face
  // of the frame block under it, and the inward face of the column beside it.
  const aims = [
    { ref: at(plan.origin, u, 0, -1), face: UP },
    { ref: at(plan.origin, u, 1, -1), face: UP },
    { ref: at(plan.origin, u, -1, 0), face: new Vec3(u.x, 0, u.z) }
  ]

  const tried = []
  for (let round = 0; round < 2 && !ctl.aborted; round++) {
    for (const aim of aims) {
      if (ctl.aborted) break
      const ref = bot.blockAt(aim.ref)
      if (!ref || ref.name !== FRAME_BLOCK) continue
      const target = aim.ref.plus(aim.face)
      if (eyes(bot).distanceTo(centre(aim.ref)) > REACH) {
        tried.push(`${aim.ref.x},${aim.ref.y},${aim.ref.z}: далеко`)
        continue
      }
      try {
        await bot._genericPlace(ref, aim.face, { forceLook: true, swingArm: 'right' })
      } catch (e) {
        tried.push(e.message.slice(0, 60))
        continue
      }
      // Poll rather than wait on an event: fire and nether_portal are two
      // different block updates in the same cell within a tick or two.
      const deadline = gameClock.now() + 2000
      while (gameClock.now() < deadline) {
        const b = bot.blockAt(target)
        if (b && b.name === 'nether_portal') return { lit: true, aim: xyz(aim.ref) }
        await sleep(100, ctl)
      }
      const now = bot.blockAt(target)
      tried.push(`${aim.ref.x},${aim.ref.y},${aim.ref.z}: получилось ${now ? now.name : '?'}`)
    }
    await sleep(400, ctl)
  }
  return { lit: false, reason: `огонь не поджёг портал (${tried.slice(0, 3).join('; ')})` }
}

function countLit (bot, plan) {
  return plan.inner.filter(c => {
    const b = bot.blockAt(c)
    return b && b.name === 'nether_portal'
  }).length
}

// What waits on the other side, and why this intent stops at the doorway. Not
// a mood — three concrete things break the moment the dimension changes:
//   * places. session.js:779 writes {x,y,z,note} and nothing else; journal.js
//     documents a `dimension` field that no writer fills and no reader checks.
//     Every remembered coordinate silently becomes a lie about another world,
//     and the Nether compresses x/z by 8, so "база на 300,64,-120" points at
//     37,?,-15 over there.
//   * the way back. Deaths are stored the same way, so `recover` would walk
//     overworld coordinates in the Nether; and a bed there explodes, so the
//     spawn point cannot be moved closer.
//   * the body. pathfinder's Movements are built once per inventory signature
//     from the world it was standing in (session.updateMovements), and the
//     ground over there is netherrack over lava with no water to break a fall.
// So: frame, fire, coordinates. Going through is its own intent with its own
// memory, and it should start from a portal whose coordinates are already
// written down — which is what this one leaves behind.
const WHY_NOT_THROUGH =
  'Стройка в портал не заходит: за ним другое измерение. Переход — отдельный вызов mc_portal mode=enter: ' +
  'он дойдёт до этой рамы, шагнёт внутрь, дождётся смены мира, выйдет из портала прибытия и запишет пару ' +
  'порталов, каждый со своим миром. В Аду x/z сжаты в 8 раз, кровать взрывается, точку возрождения туда не ' +
  'перенести — огниво брать с собой обязательно.'

async function portal (session, ctl, p: any = {}) {
  if (p.mode === 'link') return link(session, ctl, p)
  const bot = session.bot
  const mcData = session.mcData
  const read = reader(bot)
  const me = bot.entity.position.floored()
  const scan = Math.max(4, Math.min(32, p.scan ?? 16))
  // Бюджет на всю работу, а не на попытку. Из него putFrameBlock берёт себе
  // поводок на клетку, и из-за него десять безнадёжных клеток по шесть граней
  // не могут съесть весь интент. Пять секунд с конца — на поджиг и на ответ.
  const deadline = gameClock.now() + Math.max(20, Math.min(600, p.timeoutSeconds ?? 150)) * 1000 - 5000

  // --- 1. is there already one? Never build a second, never break the first.
  // Asked two ways on purpose. bot.findBlock spots the portal blocks even when
  // the obsidian around them is out of scan range; findFrames spots a frame
  // whose portal blocks somehow are not in the search result. Either one alone
  // would let the bot adopt a burning portal as its own — which is what the
  // sabotage run did when the first check was removed.
  const obsidianNear = bot.findBlocks({
    matching: [mcData.blocksByName[FRAME_BLOCK].id], maxDistance: scan, count: 64
  })
  const frames = findFrames(read, obsidianNear)
  const burning = frames.find(f => f.lit) || null
  const portalIds = [mcData.blocksByName.nether_portal.id]
  const lit = bot.findBlock({ matching: portalIds, maxDistance: scan }) ||
    (burning ? bot.blockAt(burning.origin) : null)
  if (lit) {
    const found = burning
    const stand = found
      ? (standSpots(found.origin, found.axis, [...found.inner, ...frameCells(found.origin, found.axis)])
          .map(s => standable(read, s.pos, { allowDig: false })).find(Boolean) || {}).pos
      : null
    const where = stand || lit.position
    const rec = rememberPortal(session, {
      ...xyz(where),
      dimension: bot.game ? bot.game.dimension : null,
      axis: found ? found.axis : '?',
      inner: found ? xyz(found.origin) : xyz(lit.position),
      lit: true,
      mine: false
    })
    return {
      mode: 'already',
      built: false,
      lit: true,
      already: { ...xyz(lit.position), portalBlocks: found ? found.portalBlocks : null },
      place: rec,
      note: `Портал уже горит на ${lit.position.x},${lit.position.y},${lit.position.z} — второй не строю и этот не ломаю. ` +
        `Записал в память как «${PORTAL}». ` + WHY_NOT_THROUGH
    }
  }

  // --- 2. a finished but unlit frame is worth a match, not ten more obsidian.
  // Also what makes the intent safe to call twice: an interrupted run leaves a
  // frame behind, and the second call finishes it instead of starting another.
  const ready = frames.find(f => !f.lit) || null

  let plan = null
  if (ready) {
    const envelope = [...ready.inner, ...frameCells(ready.origin, ready.axis), ...cornerCells(ready.origin, ready.axis)]
    const spot = standSpots(ready.origin, ready.axis, envelope)
      .map(s => {
        const ok = standable(read, s.pos, { allowDig: false })
        return ok && { ...ok, rank: s.rank }
      }).filter(Boolean)
      .sort((a, b) => a.rank - b.rank || a.pos.distanceTo(me) - b.pos.distanceTo(me))[0]
    if (spot) {
      plan = {
        axis: ready.axis,
        origin: ready.origin,
        inner: ready.inner,
        frame: frameCells(ready.origin, ready.axis),
        corners: cornerCells(ready.origin, ready.axis),
        props: [],
        dig: spot.dig,
        stand: spot.pos,
        needObsidian: 0,
        adopted: true
      }
    }
  }

  // --- 3. otherwise pick a site.
  if (!plan) {
    const site = planPortal(read, me, { axis: p.axis || null, radius: Math.max(2, Math.min(8, p.radius ?? PLACE_RADIUS)) })
    if (!site.ok) {
      return {
        mode: 'build',
        built: false,
        lit: false,
        stopped: `Места под раму нет: ${site.reasons.join(', ')}. ` +
          `Нужен свободный прямоугольник ${INNER_W + 2}x${INNER_H + 2} в одной плоскости плюс клетка встать рядом. ` +
          'Отойди на открытое место, или прокопай камеру (mc_tunnel), или убери лаву булыжником — и позови снова.',
        note: WHY_NOT_THROUGH
      }
    }
    plan = site.plan
  }

  // --- 4. refuse before touching the world, and name everything that is short.
  const shortObsidian = plan.needObsidian ? obsidianShortfall(bot, plan.needObsidian) : null
  const shortProps = propShortfall(bot, plan.props)
  const shortIgniter = p.frameOnly ? null : igniterShortfall(bot)
  if (shortObsidian || shortProps || shortIgniter) {
    const first = shortObsidian || shortProps || shortIgniter
    return {
      mode: 'build',
      built: false,
      lit: false,
      site: { ...xyz(plan.origin), axis: plan.axis, frame: FRAME_MIN, needObsidian: plan.needObsidian },
      need: first.need,
      stopped: [shortObsidian && shortObsidian.stopped, shortProps && shortProps.stopped,
        shortIgniter && shortIgniter.stopped].filter(Boolean).join(' '),
      note: shortObsidian && !shortIgniter && plan.needObsidian
        ? 'Место под раму нашёл и держу — обсидиан принеси, и позови снова. ' + WHY_NOT_THROUGH
        : WHY_NOT_THROUGH
    }
  }

  // --- 5. stand clear, clear the hole, build, light.
  const walk = await walkNear(session, ctl, plan.stand, 1)
  // И новая, и уже собранная рама: все шесть клеток отверстия, сверху вниз.
  // V2-30: принятая готовая рама чистила лишь место для ног, незерак внутри оставался.
  const digCells = [...new Map([...plan.dig, ...plan.inner].map(c => [c.toString(), c])).values()].sort((a, b) => b.y - a.y)
  const cleared = await clearCells(session, ctl, digCells)
  if (cleared.stopped) {
    return {
      mode: 'build',
      built: false,
      lit: false,
      site: { ...xyz(plan.origin), axis: plan.axis },
      dug: cleared.dug,
      stopped: `Не расчистил место под раму: ${cleared.stopped}`,
      note: 'Рама ещё не тронута, обсидиан цел. ' + WHY_NOT_THROUGH
    }
  }

  const built: any = plan.adopted
    ? { placed: 0, standing: FRAME_MIN, propped: [], passes: 0 }
    : await buildFrame(session, ctl, plan, deadline)
  if (built.standing < FRAME_MIN) {
    // Статус интента остаётся done, и это не оговорка: runIntent говорит done
    // про «интент завершился», а не про «сделал что просили» — ровно так же
    // штатно останавливаются на полпути dig_down, tunnel и surface, и это
    // написано в шапке инструментов. Но «done» рядом с «портала нет» читается
    // как успех, поэтому первое слово отказа — приговор, а не описание: строку
    // stopped format.js печатает как «⚠ встал: ...» раньше всего остального.
    // Память при этом НЕ трогаем: недостроенная рама под именем «портал» —
    // это обещание дороги в Ад, которой нет.
    return {
      mode: 'build',
      built: false,
      lit: false,
      portalBlocks: 0,
      site: { ...xyz(plan.origin), axis: plan.axis },
      frame: {
        standing: built.standing,
        of: FRAME_MIN,
        placed: built.placed,
        late: built.late,
        retries: built.retries,
        passes: built.passes,
        failed: built.failed
      },
      stopped: `ПОРТАЛА НЕТ: рама неполная, ${built.standing} блоков из ${FRAME_MIN}. ` +
        (built.failed ? `Не встали: ${built.failed.slice(0, 3).join('; ')}. ` : '') +
        'Позови ещё раз — повтор выбирает эту же площадку и доставляет только недостающие блоки, ' +
        'а не начинает вторую раму рядом.',
      note: 'В память ничего не записал: незажжённый портал под этим именем — обещание дороги, которой нет. ' +
        WHY_NOT_THROUGH
    }
  }

  // The body must not be in the hole when it catches: four seconds inside a lit
  // portal is a dimension change nobody asked for.
  const feet = bot.entity.position.floored()
  if (plan.inner.some(c => c.equals(feet) || c.equals(feet.offset(0, -1, 0)) || c.equals(feet.offset(0, 1, 0)))) {
    await walkNear(session, ctl, plan.stand, 0)
  }

  const blocked = plan.inner.find(c => { const b = bot.blockAt(c); return !b || !PORTAL_EMPTY.test(b.name) })
  if (blocked) return { mode: 'build', built: true, lit: false, stopped: `отверстие рамы не расчищено: ${blocked.x},${blocked.y},${blocked.z}` }
  const fire = await ignite(session, ctl, plan)
  await sleep(300, ctl)
  const portalBlocks = countLit(bot, plan)
  const inside = plan.inner.some(c => c.equals(bot.entity.position.floored()))

  const rec = rememberPortal(session, {
    ...xyz(plan.stand),
    dimension: bot.game ? bot.game.dimension : null,
    axis: plan.axis,
    inner: xyz(plan.origin),
    lit: portalBlocks > 0,
    mine: true
  })

  const detail: any = {
    mode: 'build',
    built: true,
    lit: portalBlocks > 0,
    adopted: !!plan.adopted,
    axis: plan.axis,
    inner: xyz(plan.origin),
    stand: xyz(plan.stand),
    frame: {
      obsidian: FRAME_MIN,
      placed: built.placed,
      late: built.late,
      retries: built.retries,
      passes: built.passes,
      corners: 'пустые — игра их не проверяет',
      props: built.propped && built.propped.length ? built.propped : undefined
    },
    portalBlocks,
    dug: cleared.dug,
    walked: walk.walked || undefined,
    place: rec,
    inside: inside || undefined
  }

  if (portalBlocks === INNER_W * INNER_H) {
    detail.note =
      `Портал горит: ${portalBlocks} клеток, рама ${FRAME_MIN} обсидиана (углы пустые). ` +
      `Вход с ${rec.x},${rec.y},${rec.z}, записал в память как «${PORTAL}». ` + WHY_NOT_THROUGH
  } else if (portalBlocks > 0) {
    detail.stopped = `ПОРТАЛ НЕПОЛНЫЙ: клеток ${portalBlocks} из ${INNER_W * INNER_H} — посмотри, что лежит внутри рамы.`
    detail.note = WHY_NOT_THROUGH
  } else {
    detail.stopped = `ПОРТАЛА НЕТ: рама стоит (${FRAME_MIN} обсидиана), а огонь не взялся: ${fire.reason}. ` +
      'Проверь, что внутри рамы только воздух, и позови снова — обсидиан переставлять не надо.'
    detail.note = WHY_NOT_THROUGH
  }
  return detail
}
declare namespace portal {
  let axis: any
  let bottom: any
  let keys: any
}

// Связанный портал: рама там, где сервер свяжет её с порталом другого мира.
// Факты (paper-1.21.11, SPEEDRUN.md): coordinate_scale Ада 8 — точка в Аду =
// верх/8; PortalForcer ищет готовый портал в 16 блоках от точки в Аду и в 128
// наверху, иначе строит свой в 16. Цель — x,z в координатах ДРУГОГО мира; без
// них — записанный портал того мира (дом). Дойти до точки здесь (отрезками и
// штреком), сложить раму обычной стройкой и зажечь. Слепой переход спидраннеров:
// в Аду x,z = место назначения наверху (крепость, база) — выйдешь в ~16 от него.
async function link (session, ctl, p: any = {}) {
  const bot = session.bot
  const t0 = gameClock.now()
  const deadline = t0 + Math.max(30, Math.min(600, p.timeoutSeconds ?? 300)) * 1000 - 5000
  const here = worlds.worldOf(bot)
  const other = here === 'the_nether' ? 'overworld' : 'the_nether'
  const places = (session.journal.state && session.journal.state.places) || {}
  const rec = places[worlds.portalKey(other)]
  const src = Number.isFinite(p.x) && Number.isFinite(p.z)
    ? { x: p.x, z: p.z, from: 'задано' }
    : rec && worlds.worldOfRecord(rec) === other ? { x: rec.x, z: rec.z, from: `«${worlds.portalKey(other)}»` } : null
  const base = { mode: 'link', world: here }
  if (!src) {
    return { ...base, built: false, stopped: `С чем связывать — не знаю: портала ${worlds.inWorld(other)} в памяти нет. Дай x,z в координатах ${worlds.ofWorld(other)}.` }
  }
  const k = worlds.scaleOf(other) / worlds.scaleOf(here)
  const target = { x: Math.floor(src.x * k), z: Math.floor(src.z * k) }
  // Отказ до дороги: без обсидиана и огнива идти незачем.
  const obs = obsidianShortfall(bot, FRAME_MIN)
  const ign = IGNITERS.some(n => itemNamed(bot, n)) ? null : igniterShortfall(bot)
  if (obs || ign) {
    return { ...base, built: false, target, source: src, need: (obs || ign).need, stopped: `ПОРТАЛА НЕТ: ${(obs || ign).stopped}` }
  }
  const me = bot.entity.position
  let walked = null
  if (Math.hypot(me.x - target.x, me.z - target.z) > 4) {
    walked = await walkToward(session, ctl, new Vec3(target.x, me.y, target.z), deadline, { range: 2, xz: true })
    if (ctl.aborted) return { ...base, built: false, target, stopped: 'прервано по дороге' }
  }
  const off = Math.round(Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z))
  // Сервер ищет готовый портал в 16 блоках (в Аду) — дальше строить незачем.
  const tolerance = here === 'the_nether' ? 12 : 64
  if (off > tolerance) {
    return {
      ...base, built: false, target, source: src, walked, awayBlocks: off,
      stopped: `до точки ${target.x},${target.z} не дошёл (осталось ${off} бл.${walked && walked.error ? `: ${walked.error}` : ''}) — позови снова, продолжу`
    }
  }
  const r = await portal(session, ctl, { ...p, mode: 'build', timeoutSeconds: Math.max(20, Math.round((deadline - gameClock.now()) / 1000)) })
  return {
    ...r,
    ...base,
    target,
    source: src,
    offBlocks: off,
    walked: walked || undefined,
    note: `${r.note || ''} Связь: ${worlds.inWorld(here)} точка ${target.x},${target.z} = ${src.from} ${src.x},${src.z} × ${k}; ` +
      `сервер свяжет, если в ${here === 'the_nether' ? 16 : 128} блоках от неё нет другого портала ближе. Переход — mc_portal mode=enter.`
  }
}

const portalExport = portal

export { MINEFLAYER_PLACE_WAIT_MS, placeLeash, WHY_NOT_THROUGH, portal, portalExport }
