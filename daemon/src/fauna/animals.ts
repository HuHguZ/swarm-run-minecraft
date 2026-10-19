'use strict'
// Звери: приручить, посадить и поднять, развести.
import * as gameClock from '../game-clock'
import * as ride from '../ride'
import { TAME, countOf, isTamed, nearestOf, isBaby, statusWatch, approach, holdOne, sleep, isSitting, holdNothing, BREED } from './basics'

// ---------------------------------------------------------------- приручить

export async function tame (session, ctl, { kind = 'wolf', tries = 15, radius = 32 }: any = {}) {
  const bot = session.bot
  const spec = TAME[kind]
  if (!spec) return { tamed: false, stopped: `не умею приручать ${kind}: умею ${Object.keys(TAME).join(', ')}` }
  const riding = spec.items.length === 0
  if (!riding) {
    const have = spec.items.reduce((n, it) => n + countOf(bot, it), 0)
    if (!have) return { tamed: false, need: { what: spec.items.join('|'), count: 3, have: 0 }, stopped: `нечем приручать ${kind}: нужно ${spec.items.join(' или ')} (шанс ${spec.per} за штуку)` }
  }
  // У лошадиных «приручён» — флаг 0x02 (AbstractHorse.isTamed → getFlag(2)), не 0x04.
  const wild = e => riding ? !ride.isTamedHorse(e) : !isTamed(e)
  const list = nearestOf(bot, kind, e => wild(e) && !isBaby(e), radius)
  if (!list.length) return { tamed: false, stopped: `не вижу неприручённого ${kind} в ${radius} блоках` }
  const target: any = list[0]
  if (riding) {
    // Верхом — сидеть до броска лошади, а не слезать по часам (ride.tameHorse:
    // бросок раз в ~2.5 с в среднем, посадка без броска пропадает даром).
    const rep: any = {}
    const tamed = await ride.tameHorse(session, ctl, target, rep, { tries })
    if (bot.vehicle) await ride.dismount(bot)
    return {
      tamed, kind, used: rep.tame.tries, fails: rep.tame.bucked, id: target.id, at: target.position.floored(), chance: spec.per,
      stopped: tamed ? undefined : rep.stopped
    }
  }
  const watch = statusWatch(bot, target.id)
  let used = 0
  try {
    for (let i = 0; i < tries && !ctl.aborted; i++) {
      if (!target.isValid) return { tamed: false, used, stopped: `${kind} пропал` }
      if (!(await approach(bot, ctl, target, 2.2))) return { tamed: false, used, stopped: `не подошёл к ${kind}` }
      const item = await holdOne(bot, spec.items)
      if (!item) return { tamed: false, used, stopped: `кончилось: ${spec.items.join('/')}`, need: { what: spec.items[0], count: 3, have: 0 } }
      try { await bot.lookAt(target.position.offset(0, (target.height || 0.8) * 0.6, 0), true) } catch {}
      const before = watch.seen.length
      try { bot.activateEntity(target) } catch {}
      used++
      const t0 = gameClock.now()
      while (gameClock.now() - t0 < 1200 && watch.seen.length === before) await sleep(80)
      if (watch.seen.slice(before).includes(7)) break
    }
  } finally {
    watch.stop()
  }
  const tamed = watch.seen.includes(7)
  if (tamed) {
    session.bus.emit('tamed', { kind, id: target.id, text: `приручил ${kind} (попыток ${used})` })
  }
  return {
    tamed,
    kind,
    used,
    fails: watch.seen.filter(s => s === 6).length,
    id: target.id,
    at: target.position.floored(),
    chance: spec.per,
    stopped: tamed ? undefined : `не приручился за ${used} попыток (шанс ${spec.per}) — ещё корма или другого`
  }
}

// ------------------------------------------------------------ сидеть / стоять

// Приручённый волк/кошка: правый клик пустой рукой переключает «сидеть».
export async function pet (session, ctl, { kind = null, sit = true, radius = 16 }: any = {}) {
  const bot = session.bot
  const kinds = kind ? [kind] : ['wolf', 'cat', 'parrot']
  const mine = kinds.flatMap(k => nearestOf(bot, k, e => isTamed(e), radius))
  if (!mine.length) return { changed: 0, stopped: `рядом нет приручённых ${kinds.join('/')}` }
  let changed = 0
  for (const e of (mine as any)) {
    if (isSitting(e) === !!sit) continue
    if (!(await approach(bot, ctl, e, 2.5))) continue
    // Щелчок переключает приказ «сидеть», а флаг позы (0x01) приходит тиком
    // позже — и только что приручённый уже сидит по приказу (Wolf.tryToTame:
    // setOrderedToSit(true)), хотя флаг ещё 0. Поэтому — щёлкнуть и проверить;
    // вышло наоборот — щёлкнуть ещё раз.
    for (let k = 0; k < 2 && isSitting(e) !== !!sit; k++) {
      await holdNothing(bot)
      try { await bot.lookAt(e.position.offset(0, 0.5, 0), true) } catch {}
      try { bot.activateEntity(e) } catch {}
      const t0 = gameClock.now()
      while (gameClock.now() - t0 < 900 && isSitting(e) !== !!sit) await sleep(100, ctl)
    }
    if (isSitting(e) === !!sit) changed++
  }
  const inState = mine.filter(e => isSitting(e) === !!sit).length
  return { changed, inState, total: mine.length, now: sit ? 'сидят' : 'идут за мной' }
}

// ----------------------------------------------------------------- развести

export async function breed (session, ctl, { kind = 'cow', pairs = 1, radius = 24 }: any = {}) {
  const bot = session.bot
  const food = BREED[kind]
  if (!food) return { bred: 0, stopped: `не знаю, чем кормить ${kind}: знаю ${Object.keys(BREED).join(', ')}` }
  const have = food.reduce((n, it) => n + countOf(bot, it), 0)
  if (have < 2) return { bred: 0, need: { what: food.join('|'), count: 2 * pairs, have }, stopped: `на пару ${kind} нужно 2 ${food.join(' или ')}` }
  let bred = 0
  const fed = new Set()
  for (let p = 0; p < pairs && !ctl.aborted; p++) {
    const adults = nearestOf(bot, kind, e => !isBaby(e) && !fed.has(e.id) && (kind !== 'wolf' && kind !== 'cat' ? true : isTamed(e)), radius).slice(0, 2)
    if (adults.length < 2) return { bred, stopped: `не вижу двух взрослых ${kind}${kind === 'wolf' || kind === 'cat' ? ' (приручённых)' : ''} рядом` }
    const kidsBefore = (Object.values(bot.entities) as any[]).filter((e : any) => e.name === kind && isBaby(e)).length
    const watches = adults.map((a : any) => statusWatch(bot, a.id))
    try {
      for (const a of (adults as any)) {
        if (!(await approach(bot, ctl, a, 2.2))) continue
        if (!(await holdOne(bot, food))) break
        try { await bot.lookAt(a.position.offset(0, (a.height || 1) * 0.6, 0), true) } catch {}
        try { bot.activateEntity(a) } catch {}
        fed.add(a.id)
        await sleep(400, ctl)
      }
      // Сердечки (18) у обоих — ждать детёныша, до 8 с.
      const t0 = gameClock.now()
      while (gameClock.now() - t0 < 8000 && !ctl.aborted) {
        const kids = (Object.values(bot.entities) as any[]).filter((e : any) => e.name === kind && isBaby(e)).length
        if (kids > kidsBefore) { bred++; break }
        await sleep(250)
      }
    } finally {
      for (const w of watches) w.stop()
    }
  }
  return { bred, kind, note: bred ? `родилось ${bred}; следующая любовь у этих — через 5 минут` : 'детёныш не появился — любовь не включилась (не та еда или недавно рожали)' }
}
