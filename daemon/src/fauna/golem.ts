'use strict'
// Голем на железо: бой со столба, спуск, поиск и ловушка.
import * as gameClock from '../game-clock'
import { goals } from 'mineflayer-pathfinder'
import { placeBlockAt } from '../build'
import { countOf, visible, approach, sleep } from './basics'
import { GOLEM_PILLAR, golemSpotNear, golemTopNear, golemReach, golemSpot } from './golem-spot'

export async function golemKill (session, ctl, { radius = 48, timeoutSeconds = 85 }: any = {}) {
  const bot = session.bot
  const t0 = gameClock.now()
  const deadline = t0 + Math.max(20, Math.min(110, timeoutSeconds)) * 1000
  const late = () => gameClock.now() > deadline || ctl.aborted
  const ironBefore = countOf(bot, 'iron_ingot')
  const out: any = { killed: false, hits: 0, pillar: 0, iron: 0, steps: [] }
  const mark = (s) => out.steps.push(`${Math.round((gameClock.now() - t0) / 100) / 10}с ${s}`)
  const golems = () => (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'iron_golem' && e.position && e.isValid !== false &&
    e.position.distanceTo(bot.entity.position) <= radius).sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
  let g: any = golems().find(e => visible(bot, e)) || golems()[0]
  if (!g) return { ...out, stopped: `голема не вижу в ${radius} бл.` }
  const { towerUp, pickFiller }: typeof import('../build') = require('../build')
  // Блоки любых годных видов вместе (столб ставится по блоку, каждый раз берёт, что есть): rt-R2 слот 12 — «нужно 5»
  // при 3 булыжниках, земле и песчанике.
  const FILL = ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'blackstone', 'basalt']
  const filler = () => FILL.reduce((n, x) => n + countOf(bot, x), 0)
  void pickFiller
  const weapon = () => bot.inventory.items().filter(i => /_(axe|sword)$/.test(i.name))
    .sort((a, b) => (/_axe$/.test(b.name) ? 1 : 0) - (/_axe$/.test(a.name) ? 1 : 0) || tier(b.name) - tier(a.name))[0] || null
  const id = g.id
  // Следующий RPC может не успеть нанести ни одного нового удара, но голем
  // помнит предыдущие. Ключ — объект сущности: новый моб с тем же id не наследует злость.
  const angerOn = process.env.ND_GOLEM_ANGER !== '0'
  const angry = () => out.hits > 0 || (angerOn && !!session._golemAngry?.has(bot.entities[id] || g))
  let gone = false
  const onGone = e => { if (e && e.id === id) gone = true }
  bot.on('entityGone', onGone)
  ctl.onAbort.push(() => { try { bot.pathfinder.setGoal(null) } catch {} })
  // Безопасно, пока ноги выше коробки атаки голема (его ноги + 2.7) с запасом: голем шагнёт на бугор — коробка выше.
  const hd = e => Math.hypot(e.position.x - bot.entity.position.x, e.position.z - bot.entity.position.z)
  // Mob1.21.11 expands its attack box horizontally, so diagonal contact must
  // use both axes, not a circular distance (S23: 1.825 on each axis still hits).
  const safe = () => {
    const e = bot.entities[id]
    if (!e) return true
    const reach = Math.sqrt(Math.fround(2.04)) - Math.fround(.6)
    const half = Math.fround(e.width || 1.4) / 2 + reach + Math.fround(bot.entity.width || .6) / 2
    const p = bot.entity.position
    return Math.abs(e.position.x - p.x) >= half || Math.abs(e.position.z - p.z) >= half || p.y >= e.position.y + (e.height || 2.7) + .3
  }
  let base = null // клетка ног у основания своего столба
  // Уже стою на своём столбе (прошлый заход оборвался со злым големом внизу) — не слезать к нему: основание — первая
  // клетка под ногами, у которой по бокам есть пол (земля), а не воздух столба.
  {
    const f = bot.entity.position.floored()
    let h = 0
    for (; h < 8; h++) {
      const under = bot.blockAt(f.offset(0, -1 - h, 0))
      if (!under || under.boundingBox !== 'block') break
      const sideAir = [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => { const b = bot.blockAt(f.offset(dx, -1 - h, dz)); return !b || b.boundingBox !== 'block' })
      if (!sideAir) break
    }
    if (h >= 2) { base = f.offset(0, -h, 0); mark(`уже на столбе ${h}`) }
  }
  const hp0 = bot.health
  try {
    // An existing supported perch needs no new building material to keep fighting.
    if (!base && filler() < GOLEM_PILLAR) return { ...out, stopped: `на столб нужно ${GOLEM_PILLAR} блока` }
    for (let attempt = 0; attempt < 6 && !gone && !late(); attempt++) {
      // 1. Подойти на 2.2–3 бл. к голему (вплотную сервер не ставит блок под ноги — коробка голема в клетке).
      if (!base) {
        g = bot.entities[id]
        if (!g) { gone = true; break }
        if (!(await approach(bot, ctl, g, 3, Math.min(20000, deadline - gameClock.now())))) { mark('не подошёл'); continue }
        bot.pathfinder.setGoal(null)
        await sleep(150, ctl)
        // Ровное место в 1.8–2.8 бл. от голема: вокруг (3 бл.) голему не на что встать выше пола столба, над головой
        // пусто на 5 (lab ow-golem3: в деревне у стен домов столб рос до 6 и голем уходил из досягаемости).
        g = bot.entities[id] || g
        const spot = golemSpotNear(bot, g)
        if (!spot) {
          out.noSpot = true
          mark('у голема нет безопасного места для столба')
          break
        }
        const f0 = bot.entity.position.floored()
        if (!f0.equals(spot)) {
          try { bot.pathfinder.setGoal(new goals.GoalBlock(spot.x, spot.y, spot.z)) } catch {}
          const tw = gameClock.now()
          while (gameClock.now() - tw < 8000 && !ctl.aborted && !bot.entity.position.floored().equals(spot)) await sleep(150, ctl)
          bot.pathfinder.setGoal(null)
        }
        if (!bot.entity.position.floored().equals(spot)) { mark(`не встал на ${spot.x},${spot.y},${spot.z}`); continue }
        base = bot.entity.position.floored()
      }
      // 2. Столб: ноги выше самого высокого места, куда голем может встать в 3 бл. от столба (+2.75), и не ниже 3 над
      // своим полом; не выше 6 (lab ow-golem2: голем шагнул на бугор у столба 3 — 20 → 7 хп одним ударом).
      let needY = Math.max(base.y + GOLEM_PILLAR, golemTopNear(bot, base, bot.entities[id] || g) + 3.0)
      for (let k = 0; k < 7 && !late(); k++) {
        const h = bot.entity.position.floored().y - base.y
        if (h >= GOLEM_PILLAR && bot.entity.position.y >= needY - 0.01 && safe()) break
        if (h >= 6) break
        const t = await towerUp(bot, ctl, 1, { sneak: true })
        out.pillar += t.placed || 0
        if (!t.placed) { mark(`столб встал на ${h} (${(t.why || []).join('; ') || t.reason || '?'})`); break }
      }
      const h = bot.entity.position.floored().y - base.y
      if (h < GOLEM_PILLAR || !safe() || bot.entity.position.y < needY - 0.01) {
        mark(`высоты нет (${h})`)
        if (angerOn && angry()) { mark('злой голем — со столба не слезаю'); break }
        if (h > 0) await descendPillar(bot, ctl, base.y)
        base = null
        continue
      }
      mark(`столб ${h}`)
      // 3. Бить, только пока безопасно; голем после удара сам подойдёт к столбу. Ранен — ещё блок вверх.
      const w = weapon()
      if (w) { try { await bot.equip(w, 'hand') } catch {} }
      const cd = w && /_axe$/.test(w.name) ? 1250 : 650
      let lastHit = 0
      let farSince = gameClock.now()
      let lastHp = bot.health
      let threatCell = (bot.entities[id] || g).position.floored().toString()
      while (!gone && !late()) {
        g = bot.entities[id]
        if (!g || g.isValid === false) { gone = true; break }
        const cell = g.position.floored().toString()
        if (cell !== threatCell) { needY = Math.max(base.y + GOLEM_PILLAR, golemTopNear(bot, base, g) + 3.0); threatCell = cell }
        if (bot.entity.position.y < base.y + GOLEM_PILLAR - 0.5) { mark('сошёл со столба'); break }
        if (bot.health < lastHp - 0.5 || !safe() || bot.entity.position.y < needY - .01) {
          mark(`опасно (хп ${Math.round(bot.health)}) — блок вверх`)
          const t = await towerUp(bot, ctl, 1, { sneak: true })
          out.pillar += t.placed || 0
          lastHp = bot.health
          // Столб взял блок в руку — оружие назад (rt-R4 слот 30: 94 удара булыжником, голем жив, потом убил бота).
          const w2 = weapon()
          if (w2) { try { await bot.equip(w2, 'hand') } catch {} }
          if (!t.placed && !safe()) { mark('выше не вышло — слезаю'); break }
          continue
        }
        lastHp = bot.health
        const d = golemReach(bot, g)
        // Прицел — по рамке голема, куда луч свободен (pick.aim): со столба над вплотную прижатым големом луч к центру
        // уходил в свой же блок столба, сторож прицела удар не пускал (rt-R3 слот 30: 43 взмаха — голем жив).
        const a = d <= 2.95 ? (require('../pick') as typeof import('../pick')).aim(bot, g) : null
        if (a && a.point) {
          farSince = gameClock.now()
          if (w && (!bot.heldItem || bot.heldItem.name !== w.name)) { try { await bot.equip(w, 'hand') } catch {} }
          if (gameClock.now() - lastHit >= cd) {
            try { await bot.lookAt(a.point, true) } catch {}
            const blocked0 = bot._ndBlockedHits || 0
            try { bot.attack(g); lastHit = gameClock.now() } catch {}
            if ((bot._ndBlockedHits || 0) === blocked0) {
              out.hits++
              if (angerOn) { session._golemAngry ||= new WeakSet(); session._golemAngry.add(g) }
            }
            else out.blocked = (out.blocked || 0) + 1
          }
        } else if (gameClock.now() - farSince > 6000 && !out.hits) {
          mark(`голем ушёл (${d.toFixed(1)} бл.) до удара`)
          break
        } else if (gameClock.now() - farSince > 15000 && !out.hits) { mark('голем не подходит'); break }
        // Голем уже зол (был удар) — со столба не уходить, ждать, пока подойдёт (он идёт к нам сам).
        else if (gameClock.now() - farSince > 30000) { mark('злой голем не подходит 30 с'); break }
        await sleep(60, ctl)
      }
      if (gone || late()) break
      // Слезать к живому голему рядом нельзя — он внизу и зол (lab ow-golem1: хп 20 → 4).
      const gNow = bot.entities[id]
      if (gNow && hd(gNow) < 6 && angry()) { mark('голем у столба — остаюсь наверху'); break }
      if (bot.entity.position.floored().y > base.y) await descendPillar(bot, ctl, base.y)
      base = null
    }
  } finally {
    bot.removeListener('entityGone', onGone)
  }
  out.killed = gone
  mark(gone ? 'голем убит' : 'голем жив')
  if (gone) await sleep(600, ctl)
  const gEnd = bot.entities[id]
  if (base && bot.entity.position.floored().y > base.y && (gone || !gEnd || hd(gEnd) >= 6 || !angry())) await descendPillar(bot, ctl, base.y)
  if (gone && session._golemAngry) session._golemAngry.delete(g)
  if (gone) {
    const until = gameClock.now() + 6000
    while (gameClock.now() < until && !ctl.aborted) {
      const drop: any = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'item' && e.position && e.position.distanceTo(bot.entity.position) <= 8)
        .sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
      if (!drop) break
      try { bot.pathfinder.setGoal(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.5)) } catch {}
      await sleep(400, ctl)
    }
    try { bot.pathfinder.setGoal(null) } catch {}
    await sleep(300, ctl)
  }
  out.iron = countOf(bot, 'iron_ingot') - ironBefore
  out.hpLost = Math.max(0, Math.round((hp0 ?? 20) - (bot.health ?? 20)))
  out.seconds = Math.round((gameClock.now() - t0) / 1000)
  if (!gone) out.stopped = `голем не убит за ${out.seconds} с (ударов ${out.hits})`
  return out
}
function tier (n) { return /^netherite/.test(n) ? 5 : /^diamond/.test(n) ? 4 : /^iron/.test(n) ? 3 : /^stone/.test(n) ? 2 : 1 }
async function descendPillar (bot, ctl, groundY) {
  const { equipBestTool }: typeof import('../items') = require('../items')
  for (let k = 0; k < GOLEM_PILLAR + 3 && !ctl.aborted; k++) {
    const feet = bot.entity.position.floored()
    if (feet.y <= groundY) return true
    const under = bot.blockAt(feet.offset(0, -1, 0))
    if (!under || under.boundingBox !== 'block') { await sleep(250, ctl); continue }
    try { await equipBestTool(bot, under); await bot.dig(under, true) } catch { return false }
    await sleep(350, ctl)
  }
  return bot.entity.position.floored().y <= groundY
}

export async function golem (session, ctl, { kind = 'iron', mode = 'build', ...rest }: any = {}) {
  if (mode === 'kill') return golemKill(session, ctl, rest)
  const bot = session.bot
  const body = kind === 'iron' ? 'iron_block' : 'snow_block'
  const bodyN = kind === 'iron' ? 4 : 2
  const head = ['carved_pumpkin', 'jack_o_lantern'].find(n => countOf(bot, n) > 0) ||
    (countOf(bot, 'pumpkin') && countOf(bot, 'shears') ? 'pumpkin' : null)
  const need = []
  if (countOf(bot, body) < bodyN) need.push({ what: body, count: bodyN, have: countOf(bot, body) })
  if (!head) need.push({ what: 'carved_pumpkin', count: 1, have: 0, note: 'или pumpkin + shears — вырежу на месте' })
  if (need.length) return { built: false, need: need[0], needAll: need, stopped: `на ${kind === 'iron' ? 'железного' : 'снежного'} голема не хватает: ${need.map(n => `${n.what}×${n.count - n.have}`).join(', ')}` }
  const spot = golemSpot(bot, kind)
  if (!spot) return { built: false, stopped: 'негде поставить: нужна ровная площадка 3 в ширину и 3 свободных в высоту рядом' }
  const { base, side } = spot
  const cells = kind === 'iron'
    ? [base, base.offset(0, 1, 0), base.offset(side.x, 1, side.z), base.offset(-side.x, 1, -side.z)]
    : [base, base.offset(0, 1, 0)]
  for (const c of cells) {
    if (ctl.aborted) return { built: false, stopped: 'прервано' }
    try { await placeBlockAt(bot, c, { item: body, timeoutMs: 5000 }) } catch (e) { return { built: false, stopped: `не встал блок ${body} на ${c}: ${e.message}` } }
  }
  const top = base.offset(0, 2, 0)
  let spawned = null
  const onSpawn = (e) => { if (e && e.name === (kind === 'iron' ? 'iron_golem' : 'snow_golem') && e.position.distanceTo(base) < 3) spawned = e }
  bot.on('entitySpawn', onSpawn)
  try {
    // Тыква смотрит лицом к нам: ставим, глядя на неё.
    try { await placeBlockAt(bot, top, { item: head, timeoutMs: 5000 }) } catch (e) { return { built: false, stopped: `голову не поставил: ${e.message}` } }
    if (head === 'pumpkin') {
      const shears = bot.inventory.items().find(i => i.name === 'shears')
      try { await bot.equip(shears, 'hand') } catch {}
      const b = bot.blockAt(top)
      try { await bot.lookAt(top.offset(0.5, 0.5, 0.5), true) } catch {}
      try { await bot.activateBlock(b) } catch {}
    }
    const t0 = gameClock.now()
    while (!spawned && gameClock.now() - t0 < 2500) await sleep(100)
  } finally {
    bot.removeListener('entitySpawn', onSpawn)
  }
  if (spawned) session.bus.emit('golem', { kind, text: `построил ${kind === 'iron' ? 'железного' : 'снежного'} голема` })
  return {
    built: !!spawned,
    kind,
    at: { x: base.x, y: base.y, z: base.z },
    stopped: spawned ? undefined : 'блоки стоят, а голем не появился — узор не совпал (руки должны быть поперёк, над руками пусто)'
  }
}
