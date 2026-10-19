'use strict'
// Передача: отдать вещь игроку — выбор (кому, что), броски до collect, ответ.
import * as gameClock from '../game-clock'
import { sleep, xyz } from '../movement'
import { collectNearbyDrops } from '../actions'
import { itemNamed, countOf, countItems } from '../items'
import { r1, REACH, walkSeconds, at, pickItem, wornMatch, similarLine, normalizeAsk, bagLine, precious, THROW, TRIES, THROW_PITCH, PICKUP, WATCH_MS, POLL_MS, FIND_DROP } from './vocabulary'
import { listenCollect, stand, standOff, dropIds, waitForOwnDrop, stepBack, lyingAround, dropCensus } from './world'

// ---------------------------------------------------------------- give

export async function give (session, ctl, { player, item: ask, count = 1, force = false, timeoutSeconds = 60 }: any = {}) {
  const bot = session.bot
  const from = xyz(bot.entity.position)
  const budget = Math.max(15, Math.min(180, Math.round(Number(timeoutSeconds) || 60)))
  const deadline = gameClock.now() + budget * 1000
  const left = () => Math.max(0, deadline - gameClock.now())

  const pick = await giveChoose(session, bot, { player, ask, count, force, from })
  if (pick.result) return pick.result
  const delivered = await giveDeliver(session, bot, ctl, { key: pick.key, item: pick.item, want: pick.want, left })
  return giveReport(session, bot, { key: pick.key, item: pick.item, from, ...delivered })
}

// Кому и что: игрок на сервере и в досягаемости, вещь в рюкзаке (или снятая броня по force), не из неприкосновенного.
// Отказ — готовый ответ { result }; иначе { key, item, want }.
async function giveChoose (session, bot, { player, ask, count, force, from }): Promise<{ result?: any; key?: string; item?: any; want?: number }> {
  const mcData = session.mcData

  const asked = String(player || '').trim()
  if (!asked) throw new Error('кому отдавать? give нужен player — ник игрока')

  // A nick typed from memory in the wrong case must not come back as «такого
  // игрока нет» about somebody standing two blocks away — same rule escort.js:181
  // states for the same reason.
  const key = bot.players[asked]
    ? asked
    : Object.keys(bot.players).find(n => n.toLowerCase() === asked.toLowerCase())
  const online = Object.keys(bot.players).filter(n => n !== bot.username)

  if (!key) {
    const stopped = `${asked} не на сервере`
    return { result: {
      to: asked, gave: null, took: false, from, at: from, onlineNow: online, stopped,
      note: (online.length ? `сейчас онлайн: ${online.join(', ')}` : 'на сервере вообще никого нет') +
        '. Проверь ник или дождись player_joined, потом mc_give снова.'
    } }
  }

  const ent0 = bot.players[key].entity
  if (!ent0 || !ent0.position) {
    const stopped = `${key} на сервере, но не прогружен — он дальше прорисовки`
    return { result: {
      to: key, gave: null, took: false, from, at: from, onlineNow: online, stopped,
      note: 'отдавать некому: до него дальше, чем видит тело. Спроси координаты (mc_say) и mc_goto, потом mc_give снова.'
    } }
  }

  const gap0 = r1(ent0.position.distanceTo(bot.entity.position))
  if (gap0 > REACH) {
    // The control case: a stack thrown at somebody forty blocks away lands in
    // the grass and nobody ever learns where. Say the road instead.
    const secs = walkSeconds(gap0)
    return { result: {
      to: key,
      gave: null,
      took: false,
      from,
      at: from,
      player: { name: key, at: xyz(ent0.position), gap: gap0 },
      road: { walk: Math.round(gap0), walkSeconds: secs, etaSeconds: secs },
      stopped: `${key} в ${gap0} бл. — из рук в руки так не отдать (держу до ${REACH})`,
      note:
        `бросать отсюда нельзя: стак упадёт под ноги мне, а не ему, и потеряется. Идти ${Math.round(gap0)} бл., ` +
        `это ~${secs}с: mc_goto ${xyz(ent0.position).x} ${xyz(ent0.position).z}, потом mc_give снова. ` +
        `Или позови его к себе (mc_say) — я стою на ${at(from)}.`
    } }
  }

  // ---- what leaves the bag
  let found = pickItem(bot, mcData, ask)
  if (found.error) throw new Error(found.error)

  if (!found.item) {
    const worn = wornMatch(bot, ask)
    if (worn && !force) {
      return { result: {
        to: key, gave: null, took: false, from, at: from,
        stopped: `${worn.item} — это броня на мне`,
        note:
          `она в слотах брони (5-8), а бросок берёт только рюкзак (слоты 9-44), так что снять придётся сначала. ` +
          `Снимать не буду: без неё любой удар дороже. Правда нужна — mc_give с force=true, тогда сниму и отдам.`
      } }
    }
    if (worn && force) {
      // Safe here and only here: the autopilot's armour routine stands down
      // while an intent is running (autopilot.js counts session.current as
      // busy), so nothing puts the piece straight back on between these lines.
      try { await bot.unequip(worn.dest) } catch (err) {
        return { result: {
          to: key, gave: null, took: false, from, at: from,
          stopped: `не смог снять ${worn.item}`,
          note: `${String(err.message || err)}. Попробуй ещё раз или сними другим способом.`
        } }
      }
      found = { item: itemNamed(bot, worn.item) }
    }
  }

  if (!found.item) {
    const similar = similarLine(bot, normalizeAsk(ask))
    return { result: {
      to: key, gave: null, took: false, from, at: from,
      have: countItems(bot),
      stopped: `${found.why || 'нет такого'} — отдавать нечего`,
      note: `${similar ? similar + '. ' : ''}В рюкзаке: ${bagLine(bot)}. Скажи человеку, чем можешь заменить (mc_say).`
    } }
  }

  const item = found.item
  const owned = countOf(bot, item.name)
  const want = Math.max(1, Math.min(64, Math.round(Number(count) || 1), owned))

  const stop = precious(session, item, want)
  if (stop && !force) {
    return { result: {
      to: key, gave: null, took: false, from, at: from,
      keep: stop.what,
      have: { [item.name]: owned },
      stopped: `не отдам: ${stop.what}`,
      note: stop.note
    } }
  }
  return { key, item, want }
}

// Бросок за броском: встать на дальность, повернуться, бросить, ждать collect, искать свой стак и, промахнувшись,
// подобрать его и подойти ближе. Итог — попытки, взял ли, почему кончилось, сколько прошёл.
async function giveDeliver (session, bot, ctl, { key, item, want, left }) {
  // ---- deliver
  const heard = listenCollect(bot, key)
  ctl.onAbort.push(() => { heard.off(); stand(bot) })

  // Сколько этой вещи было ДО всяких бросков. Единственный способ отличить
  // «вещь где-то в мире» от «вещь у меня»: тело подбирает свой бросок обратно,
  // и тогда говорить «вещь из рюкзака ушла» — прямая ложь про свой же рюкзак.
  const startedWith = countOf(bot, item.name)
  const attempts = []
  let took = null
  let lost = null
  let walked = 0
  // Стартуем с факта, если он есть: последняя ИЗМЕРЕННАЯ дальность живёт на
  // сессии и переживает вызов, так что второй mc_give за смену начинает уже не
  // с константы. Константа осталась только для самого первого броска процесса —
  // до того, как мир хоть раз ответил.
  let throwDist = Number.isFinite(session.throwCarry) ? session.throwCarry : THROW

  try {
    for (let n = 1; n <= TRIES && !took && !ctl.aborted && left() > 3000; n++) {
      const ent = (bot.players[key] && bot.players[key].entity) || null
      if (!ent || !ent.position) { lost = `${key} пропал из виду`; break }

      const walk = await standOff(bot, ctl, ent, throwDist, Math.min(left(), 25000))
      walked += walk.walked
      if (!walk.ok) {
        attempts.push({
          try: n,
          stopped: `не встал на бросок: ${walk.error || 'нет дороги'}`,
          gap: walk.gap,
          wanted: r1(throwDist)
        })
        break
      }

      // Turn to him — the yaw is both manners and the only horizontal aim there
      // is. Then flatten the pitch: looking a person in the eye from three
      // blocks away is nearly level, but from one block it is a stare at the
      // floor, and the throw would follow it into the ground.
      try {
        await bot.lookAt(ent.position.offset(0, (ent.height || 1.8) * 0.9, 0), true)
        await bot.look(bot.entity.yaw, THROW_PITCH, true)
      } catch {}

      const stood = bot.entity.position.clone()
      // Наклон в момент броска — тот самый параметр, из-за которого дальность
      // гуляла впятеро. В отчёт он идёт рядом с дальностью, чтобы связь было
      // видно без отдельного расследования.
      const pitchDeg = Math.round(bot.entity.pitch * 180 / Math.PI)
      const before = countOf(bot, item.name)
      // Everything already lying around, so that what appears next is ours.
      const knownDrops = dropIds(bot)
      // The witness has to belong to THIS toss: heard.got keeps every collect
      // this player made since the intent started, and a stack he picked up on
      // the previous attempt must not sign for the current one.
      const tossedAt = gameClock.now()
      let error = null
      try { await bot.toss(item.type, null, Math.min(want, before)) } catch (err) { error = String(err.message || err) }
      // The bag, not the promise: bot.toss resolves on its own click bookkeeping,
      // and what actually left the body is a subtraction anybody can check.
      const sent = before - countOf(bot, item.name)
      if (sent <= 0) {
        attempts.push({ try: n, sent: 0, stopped: error || 'вещь осталась в рюкзаке' })
        break
      }

      const mine = await waitForOwnDrop(bot, ctl, knownDrops, stood)

      // Отходим только если бросок лёг нам под ноги. При направленном броске
      // стак улетает В СТОРОНУ человека, то есть от нас, и лишняя ходьба стоит
      // трёх-пяти секунд на попытку и удлиняет следующий заход.
      const tooClose = !mine || mine.dist <= PICKUP + 0.5
      const back = tooClose ? await stepBack(bot, ctl, ent, Math.min(left(), 8000)) : xyz(bot.entity.position)

      const watchUntil = gameClock.now() + Math.min(WATCH_MS, left())
      let taken = null
      while (gameClock.now() < watchUntil && !ctl.aborted && !taken) {
        taken = heard.got.find(g => g.at >= tossedAt && ((mine && g.id === mine.id) || g.item === item.name)) || null
        if (!taken) await sleep(POLL_MS)
      }

      if (taken) {
        // Удачный бросок — такой же замер, как промах, и терять его глупо.
        if (mine && mine.settled && mine.dist >= 1) session.throwCarry = Math.max(1.5, Math.min(3.5, mine.dist))
        took = { item: item.name, count: sent, confirmedBy: 'collect' }
        attempts.push({
          try: n,
          sent,
          stoodOff: r1(walk.gap),
          pitch: pitchDeg,
          flight: mine ? r1(mine.dist) : null,
          // Где стак лёг относительно ЧЕЛОВЕКА — то самое число, которое
          // отличает «долетело» от «повезло». Считаем и на успехе тоже: удачный
          // бросок так же полезен для понимания, как промах.
          fromPlayer: mine ? r1(Math.hypot(mine.at.x + 0.5 - ent.position.x, mine.at.z + 0.5 - ent.position.z)) : null,
          settled: mine ? !!mine.settled : undefined,
          took: true
        })
        break
      }

      // Nobody took it: ask the world where it is now.
      const still = mine ? lyingAround(bot, { radius: FIND_DROP }).find(d => d.id === mine.id) : null
      const toHim = still ? r1(Math.hypot(still.at.x + 0.5 - ent.position.x, still.at.z + 0.5 - ent.position.z)) : null
      const rec: any = {
        try: n,
        sent,
        stoodOff: r1(walk.gap),
        pitch: pitchDeg,
        flight: mine ? r1(mine.dist) : null,
        // Долетел и лёг — или мы посмотрели, пока он ещё летел. Без этого
        // flight читается как факт там, где он ещё не факт.
        settled: mine ? !!mine.settled : undefined,
        guessed: mine && mine.guessed ? true : undefined,
        lies: still ? still.at : null,
        fromPlayer: toHim,
        stoodAt: xyz(stood),
        backedTo: back,
        census: mine ? undefined : dropCensus(bot, stood)
      }
      attempts.push(rec)

      // Мир только что сказал, на сколько несёт бросок ЗДЕСЬ — и это единственное
      // число, которому тут можно верить: замеры дали 3.1 и 4.6 в одной и той же
      // арене. Но только по ОСТАНОВИВШЕМУСЯ стаку: замер в полёте показывает
      // ноль (сцена поймала такой на 19-й миллисекунде), и калибровка по нему
      // подвела бы тело вплотную — то есть ровно к той ошибке, из-за которой
      // передача не работала вовсе.
      if (mine && mine.settled && mine.dist >= 1) {
        // Верхняя граница ниже прежней: живые замеры дали 0.4-2.8, а стенд-офф
        // 4 и 5 промахнулись оба раза. Если бросок и правда случайный, то это
        // калибровка по шуму, и уезжать по ней далеко от рабочей дистанции —
        // худшее, что можно сделать.
        throwDist = Math.max(1.5, Math.min(3.5, mine.dist))
        session.throwCarry = throwDist
      }
      const triesLeft = n < TRIES && left() > 12000

      if (!still) {
        // The one case that looks like «пропало» and is not: the body walked
        // over its own gift while stepping away and the server handed it back.
        if (countOf(bot, item.name) >= before) {
          rec.stopped = 'подобрал собственный бросок обратно, пока отходил'
          if (triesLeft) continue
          lost = 'бросок каждый раз возвращался ко мне — с этого места не отдать'
          break
        }
        lost = 'стак пропал из виду — либо он всё-таки подобрал, либо его унесло'
        break
      }
      if (toHim !== null && toHim <= PICKUP) {
        // Under his feet and still on the ground: taking it back from there
        // would be picking his pocket, so the body says so and stops.
        lost = `стак лежит у ${key} под ногами (${toHim} бл.), но он его не поднял`
        break
      }
      if (!triesLeft) break

      // Missed him: pick our own miss back up and try from closer. This is the
      // only place the body walks over drops on purpose, and it takes whatever
      // else is lying there — walking over a stack is how picking up works.
      const grabbedBefore = countOf(bot, item.name)
      await collectNearbyDrops(bot, ctl, { radius: 8, timeoutMs: Math.min(10000, left()) })
      if (countOf(bot, item.name) <= grabbedBefore) {
        lost = 'не смог подобрать свой же бросок обратно'
        break
      }
    }
  } finally {
    heard.off()
    stand(bot)
  }
  return { startedWith, attempts, took, lost, walked }
}

// Ответ передачи: кто взял (сервер, collect), где лежит недолетевший стак, что вернулось в рюкзак; запись в журнал.
function giveReport (session, bot, { key, item, from, startedWith, attempts, took, lost, walked }) {
  const here = xyz(bot.entity.position)
  const ent = (bot.players[key] && bot.players[key].entity) || null
  const gap = ent && ent.position ? r1(ent.position.distanceTo(bot.entity.position)) : null
  const last = attempts[attempts.length - 1] || null

  const out: any = {
    to: key,
    gave: took ? { item: item.name, count: took.count } : null,
    took: !!took,
    tries: attempts.length,
    attempts,
    walked,
    from,
    at: here,
    player: { name: key, at: ent && ent.position ? xyz(ent.position) : null, gap },
    have: { [item.name]: countOf(bot, item.name) }
  }

  if (took) {
    out.note =
      `${key} забрал ${item.name}×${took.count} — это сказал сервер (пакет collect), а не я. ` +
      `Стою на ${at(here)}, в ${gap} бл. от него. Надо ещё — mc_give снова.`
  } else if (countOf(bot, item.name) >= startedWith) {
    // Вещь вернулась к нам целиком — ни одного стака в мире не осталось.
    out.stopped = lost || (last && last.stopped) || 'отдать с этого места не вышло'
    out.note =
      `${item.name} осталась у меня: каждый бросок я же и подобрал обратно, пока отходил. ` +
      `Стою в ${gap === null ? '?' : gap} бл. от ${key}. Попробуй ещё раз, когда он подойдёт ближе, ` +
      `или отойди сам и позови mc_give снова — с этой точки не получается.`
  } else {
    const lies = last && last.lies ? last.lies : null
    out.stopped = lost || (last && last.stopped) ||
      (lies ? `не долетело: стак лежит в ${last.fromPlayer} бл. от ${key}, а не у него` : 'отдать не вышло')
    out.drop = lies ? { at: lies, fromPlayer: last.fromPlayer, item: item.name, count: last.sent } : undefined
    out.note =
      (lies
        ? `${item.name}×${last.sent} лежит на ${at(lies)} — это ${last.fromPlayer} бл. от ${key} и ${last.flight} бл. от места броска. ` +
          `Скажи ему подойти и подобрать (mc_say), или забери обратно сам: mc_take item=${item.name}. `
        : `вещь из рюкзака ушла, а своего броска в мире не нашёл. ` +
          (last && last.census
            ? `Предметов на земле рядом: ${last.census.count}` +
              (last.census.nearest ? `, ближайший ${last.census.nearest.item || 'без имени'} на ${at(last.census.nearest.at)} (${last.census.nearest.dist} бл.)` : '') +
              '. Проверь mc_take — возможно, это он. '
            : '') ) +
      `Вещи на земле лежат 5 минут, потом их не будет.`
  }

  try {
    session.journal.append(
      'передача',
      `${key}: ${took ? `отдал ${item.name}×${took.count}` : `не отдал ${item.name} (${out.stopped})`}`,
      bot.entity.position
    )
  } catch {}

  return out
}
