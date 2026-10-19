'use strict'
import * as gameClock from '../game-clock'
import { sleep, xyz } from '../movement'
import { countOf, bestWeapon } from '../items'
import { towerUp } from '../build'
import * as worlds from '../worlds'
import { SWING_MS, clamp, log, meta, ents, pickUp, digCell } from './common'
import { eyesSeen, safeAim, reachTo, searchWalk, openFight } from './aim'
import { pillarUp, trappedEm, emergencyPillar, pillarDown } from './shelter'

async function huntPillar (session, ctl, p: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const t0 = gameClock.now()
  const deadline = t0 + clamp(p.timeoutSeconds ?? 240, 30, 600) * 1000 - 4000
  const radius = clamp(p.radius ?? 40, 8, 64)
  const pearls0 = countOf(bot, 'ender_pearl')
  const want = pearls0 + Math.max(1, p.count ?? 4)
  const hp0 = Math.round(bot.health ?? 20)
  const retreatAt = clamp(p.retreatAtHealth ?? 8, 3, 16)
  const kills = []
  const dead = new Set()
  const hurtAt = new Map()
  const onHurt = e => { if (e && e.name === 'enderman') hurtAt.set(e.id, gameClock.now()) }
  const onDead = (e, how) => {
    if (!e || e.name !== 'enderman' || dead.has(e.id) || !e.position) return
    if (e.position.distanceTo(bot.entity.position) > 12) return
    if (how === 'gone' && !(gameClock.now() - (hurtAt.get(e.id) || 0) < 3000)) return
    dead.add(e.id)
    kills.push({ at: xyz(e.position), t: Math.round((gameClock.now() - t0) / 1000) })
  }
  const onGone = e => onDead(e, 'gone')
  bot.on('entityHurt', onHurt)
  bot.on('entityDead', onDead)
  bot.on('entityGone', onGone)
  const rounds = []
  const skip = new Set()
  let stopped = null
  let pillar = null
  let fails = 0
  let searches = 0
  const weapon = bestWeapon(bot)
  const onTop = () => pillar && bot.entity.position.floored().y >= pillar.base.y + (pillar.h || 3)
  const angryClose = r => ents(bot).some((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false && !dead.has(e.id) && meta(bot, e, 'creepy') && e.position.distanceTo(bot.entity.position) < r)
  // Уже стою на своём столбе (прошлый вызов оборвали): столб — это он.
  {
    const f = bot.entity.position.floored()
    const solid = q => { const b = bot.blockAt(q); return !!b && b.boundingBox === 'block' }
    const bare = q => [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => !solid(q.offset(dx, 0, dz)))
    if (solid(f.offset(0, -1, 0)) && solid(f.offset(0, -2, 0)) && solid(f.offset(0, -3, 0)) && bare(f.offset(0, -1, 0)) && bare(f.offset(0, -2, 0))) {
      pillar = { base: f.offset(0, -3, 0), top: f, reused: true }
    }
  }
  try {
    while (!ctl.aborted) {
      if (countOf(bot, 'ender_pearl') >= want) break
      if (gameClock.now() > deadline) { stopped = 'время вышло'; break }
      // На столбе хп мало — есть и ждать наверху (с земли злой не достаёт).
      if (onTop() && (bot.health ?? 20) < 14) {
        if ((bot.food ?? 20) < 20) { try { await (require('../actions') as typeof import('../actions')).eat(session, {}) } catch {} }
        try { await bot.look(bot.entity.yaw, -1.5, true) } catch {}
        await sleep(1000)
        continue
      }
      if (!onTop() && (bot.health ?? 20) <= retreatAt && !angryClose(16)) { stopped = `хп ${Math.round(bot.health)} — дальше не охочусь`; break }
      if ((bot.food ?? 20) <= 16) { try { await (require('../actions') as typeof import('../actions')).eat(session, {}) } catch {} }
      // 1. На столб. Злой рядом — столб прямо здесь (прогон 27: злой, которого
      // разозлил взгляд на ходу, убил тело за 19 с, пока оно шло к месту).
      if (!onTop()) {
        let up: any = angryClose(12) ? await emergencyPillar(bot, ctl) : await pillarUp(bot, ctl, { skip, stopIf: () => angryClose(10) })
        // Ад — пещеры с низким сводом: места под столб нет — пройти дальше.
        for (let k = 0; k < 8 && !up.ok && !ctl.aborted && gameClock.now() + 30000 < deadline; k++) {
          if (angryClose(12)) {
            up = await emergencyPillar(bot, ctl)
            if (up.ok) break
            // Столб не встал (свод низко) — бой на земле: в тело, щит.
            const em0 = ents(bot).filter((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false && !dead.has(e.id) && meta(bot, e, 'creepy'))
              .sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
            if (em0) {
              const f: any = await openFight(session, ctl, em0, { retreatAt: 5, dead, maxMs: 30000 }).catch(e => ({ error: e.message }))
              log('бой на земле', { ...f, why: up.why })
              if (f.killed) await pickUp(bot, ctl, 5, 3000)
            }
            continue
          }
          // В яме (ногами никуда: стены выше шага) — выбраться столбом.
          try {
            const around = (require('../walkable') as typeof import('../walkable')).walkable(bot, bot.entity.position, { radius: 6, maxNodes: 40 }).length
            if (around <= 3) { const t = await towerUp(bot, ctl, 3); log('из ямы', { nodes: around, placed: t.placed, why: t.reason }) }
          } catch {}
          const w = await searchWalk(bot, ctl, 22, () => angryClose(10))
          log('поиск места под столб', { to: w, why: up.why })
          up = angryClose(12) ? await emergencyPillar(bot, ctl) : await pillarUp(bot, ctl, { skip, stopIf: () => angryClose(10) })
        }
        if (!up.ok) { stopped = `столб не вышел: ${up.why || 'встал'}`; break }
        pillar = up
        log('столб', { base: xyz(up.base), placed: up.placed, emergency: up.emergency })
      }
      // 2. Кого злить: глаза видно строго, 6..24 блока.
      const me = bot.entity.position
      const cands = ents(bot).filter((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false &&
        !dead.has(e.id) && !skip.has(e.id) && e.position.distanceTo(me) <= radius)
      const angry = cands.filter(e => meta(bot, e, 'creepy'))
      let em: any = angry.sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))[0] || null
      const round: any = { from: null }
      if (!em) {
        const walksHere = e => !pillar || !pillar.reach || [0, -1, 1].some(dy => { const f = e.position.floored().offset(0, dy, 0); return pillar.reach.has(`${f.x},${f.y},${f.z}`) })
        em = cands.filter((e : any) => { const d = e.position.distanceTo(me); return d >= 6 && d <= 24 && eyesSeen(bot, e) && walksHere(e) && !trappedEm(bot, e) })
          .sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))[0] || null
        if (!em) {
          // Никого на виду: подождать (они ходят и телепортируются), потом
          // сменить место — вниз, пройтись, новый столб.
          if (searches++ < 8 || gameClock.now() + 20000 < deadline) {
            try { await bot.look(bot.entity.yaw + 1.2, -0.6, true) } catch {}
            await sleep(2500)
            // Столб стоит ~10 с — менять место не чаще раза в 20 с.
            if (searches % 8 === 0) {
              const all = cands.length
              const inRange = cands.filter((e : any) => { const d = e.position.distanceTo(me); return d >= 6 && d <= 24 })
              const eyes = inRange.filter(e => eyesSeen(bot, e))
              log('никого', { all, inRange: inRange.length, eyes: eyes.length, walk: eyes.filter(walksHere).length, reach: pillar && pillar.reach ? pillar.reach.size : null, base: pillar ? xyz(pillar.base) : null, seen: eyes.slice(0, 5).map((e : any) => { const f = e.position.floored(); const b = bot.blockAt(f.offset(0, -1, 0)); return [f.x, f.y, f.z, b ? b.name : null] }) })
              await pillarDown(bot, ctl, mcData, pillar.base)
              await pickUp(bot, ctl, 5, 3000)
              const w = await searchWalk(bot, ctl, 16)
              log('поиск', { to: w })
              pillar = null
            }
            continue
          }
          stopped = `эндерменов в ${radius} блоках не вижу` + (worlds.worldOf(bot) === 'the_nether' ? ' (в Аду их больше всего в искажённом лесу — warped_forest)' : ' (в верхнем мире они ходят ночью)')
          break
        }
        round.from = Math.round(em.position.distanceTo(me))
        const tA = gameClock.now()
        let looks = 0
        while (!ctl.aborted && gameClock.now() - tA < 6000 && !meta(bot, em, 'creepy') && em.isValid !== false) {
          if (eyesSeen(bot, em)) { await bot.lookAt(em.position.offset(0, 2.55, 0), true); looks++ }
          await sleep(100)
        }
        round.looks = looks
        if (!meta(bot, em, 'creepy')) { skip.add(em.id); round.skipped = 'не разозлился'; rounds.push(round); log('раунд', round); if (++fails >= 6) { stopped = 'шестерых подряд не разозлил'; break } continue }
      } else {
        round.from = Math.round(em.position.distanceTo(me))
        round.already = true
      }
      // Сразу глаза вниз (отвесно) — не смотреть в глаза подходящему.
      try { await bot.look(bot.entity.yaw, -1.5, true) } catch {}
      if (weapon) { try { await bot.equip(weapon, 'hand') } catch {} }
      // 3. Ждать у подножия и бить сверху.
      const tB = gameClock.now()
      let swings = 0
      let last = 0
      const hpTop = bot.health ?? 20
      let dbgAt = 0
      while (!ctl.aborted && gameClock.now() - tB < 35000 && em.isValid !== false && !dead.has(em.id)) {
        if ((bot.health ?? 20) <= retreatAt) break
        const r = reachTo(bot, em)
        if (gameClock.now() - dbgAt > 3000) { dbgAt = gameClock.now(); log('ждёт', { t: Math.round((gameClock.now() - tB) / 1000), r: Math.round(r * 10) / 10, creepy: !!meta(bot, em, 'creepy'), pos: xyz(em.position) }) }
        // Встал ниже и не подходит (лаборатория, прогон 11: злой 12 с стоял
        // в 5.1 блока на 3 ниже подножия): спуститься по столбу, пока его
        // макушка ниже наших ног, — с края обрыва меч достаёт, он нас нет.
        if (r > 3.0 && gameClock.now() - tB > 4000 && pillar && bot.entity.position.floored().y > pillar.base.y) {
          const feetY = bot.entity.position.floored().y
          if (feetY - 1 > em.position.y + 2.95) {
            const e2 = await digCell(bot, mcData, bot.entity.position.floored().offset(0, -1, 0))
            if (!e2) { round.stepDown = (round.stepDown || 0) + 1; await sleep(400); continue }
          }
        }
        const aim = r <= 3.2 ? safeAim(bot, em) : null
        if (aim) {
          try { await bot.lookAt(aim.pt, true) } catch {}
          if (gameClock.now() - last >= SWING_MS) { try { bot.attack(em); swings++; last = gameClock.now(); round.aim = aim.deg } catch {} }
        } else {
          try { await bot.look(bot.entity.yaw, -1.5, true) } catch {}
          if (r <= 3.0) round.noAim = (round.noAim || 0) + 1
        }
        await sleep(60)
      }
      round.swings = swings
      round.killed = dead.has(em.id)
      round.hurtOnTop = Math.round(hpTop - (bot.health ?? 20))
      round.seconds = Math.round((gameClock.now() - tB) / 1000)
      rounds.push(round)
      log('раунд', round)
      if (round.killed) {
        fails = 0
        // Жемчуг у подножия: вниз, подобрать, столб заново — если других
        // злых рядом нет (иначе бить с вершины дальше, подобрать потом).
        await sleep(800)
        const angryNear = ents(bot).some((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false && !dead.has(e.id) && meta(bot, e, 'creepy') && e.position.distanceTo(bot.entity.position) < 16)
        if (angryNear) round.stayed = true
        else {
          await pillarDown(bot, ctl, mcData, pillar.base)
          await pickUp(bot, ctl, 5, 4000)
          pillar = null
        }
      } else {
        skip.add(em.id)
        if (++fails >= 6) { stopped = 'злые не подходят к столбу'; break }
      }
    }
  } finally {
    bot.removeListener('entityHurt', onHurt)
    bot.removeListener('entityDead', onDead)
    bot.removeListener('entityGone', onGone)
  }
  // Со столба — вниз (не оставлять тело на трёх блоках).
  if (pillar && onTop()) await pillarDown(bot, ctl, mcData, pillar.base).catch(() => null)
  await pickUp(bot, ctl, 5, 3000).catch(() => null)
  const pearls = countOf(bot, 'ender_pearl')
  const detail: any = {
    mode: 'hunt',
    style: 'столб',
    pearls: { before: pearls0, now: pearls, gained: pearls - pearls0, want },
    kills: kills.length,
    rounds: rounds.slice(-8),
    hpLost: Math.max(0, hp0 - Math.round(bot.health ?? 0)),
    at: xyz(bot.entity.position),
    seconds: Math.round((gameClock.now() - t0) / 1000)
  }
  if (pearls < want) {
    detail.need = { what: 'ender_pearl', count: want - pearls, have: pearls }
    detail.stopped = `${stopped || 'встал'} — жемчуга ${pearls} из ${want} (убил ${kills.length}; игра даёт 0..1 с эндермена, в среднем 0.5)`
  }
  detail.note = `Жемчуг +${detail.pearls.gained} (теперь ${pearls}), эндерменов убито ${kills.length}. Приём: столб в 3 блока на ровном месте — эндермен с земли не достаёт, меч сверху бьёт его в голову.`
  return detail
}

export { huntPillar }
