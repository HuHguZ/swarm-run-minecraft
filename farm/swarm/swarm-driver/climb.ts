// Рой: натиск — схватить лучшее у врага, подъём к врагу (лестницы, столбы, пролом), пролом.
import { ownedCount } from '../../../daemon/src/swarm'
import { BLOCK, distance } from './common'
import type { SwarmDriverCtx } from './common'

export function swarmClimb (sw: SwarmDriverCtx) {
  const { now, pos, log, arena, surfaceY, sandSpot, cooldown, ladderRoutes, detail, lootSafe, lootStep, bounded, lootArena, blast, go } = sw
  // Вещи под ногами (пользователь 15.10: «бил деревянным мечом, а рядом трезубец лежал — отбежать, взять и мочить; постоянно
  // поглядывать на предметы на земле»): раз в 1.5 с — что лежит в 7 бл. (items_near: только что видно); лучше своего оружия
  // или брони в том же слоте, тотем, золотое яблоко, элитры — подбежать и взять (броню — надеть). В ближнем бою (враг в 3 бл.)
  // — только если вещь в 1.5 бл.
  const MAT = { wooden: 1, golden: 1.5, stone: 2, copper: 2.5, iron: 3, diamond: 4, netherite: 5 }
  const ARM = { leather: 1, golden: 1.5, chainmail: 2, copper: 2.5, iron: 3, diamond: 4, netherite: 5 }
  const weaponValue = n => n === 'mace' ? 5.5 : n === 'trident' ? 4.5 : /^(\w+)_(sword|axe|spear)$/.test(n) ? (MAT[n.split('_')[0]] || 0) : 0
  const armorOf = n => { const m = /^(\w+)_(helmet|chestplate|leggings|boots)$/.exec(n); return m ? { slot: { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' }[m[2]], v: ARM[m[1]] || 0 } : null }
  async function grab(b, enemies) {
    if (b.climbing || (cooldown.get(`grab:${b.name}`) || 0) > now()) return false
    cooldown.set(`grab:${b.name}`, now() + 1500)
    const m = pos[b.name], inv = m?.inv || {}
    if (!m?.p) return false
    const near = Math.min(Infinity, ...enemies.filter(e => now() - e.seenAt < 1500).map(e => distance(e.position, m.p)))
    const r = detail(await b.c.call('items_near', { radius: 7 }).catch(() => ({})))
    const best = Math.max(0, ...Object.keys(inv).map(weaponValue))
    const wear = slot => { const n = m.armor?.[slot]; const a = n && armorOf(n); return a ? a.v : 0 }
    const want = (r.items || []).find(it => {
      if (near < 5 && it.d > 1.5) return false
      if (b.swarmTask?.kind === 'loot' && it.at && !lootSafe(b, it.at, true)) return false
      if ((cooldown.get(`grab:${b.name}:${it.id ?? it.name + Math.round(it.at?.x) + Math.round(it.at?.z)}`) || 0) > now()) return false
      const a = armorOf(it.name)
      return weaponValue(it.name) > best + 0.4 || (a && a.v > wear(a.slot)) || /^(totem_of_undying|golden_apple|enchanted_golden_apple|elytra)$/.test(it.name) && !inv[it.name]
    })
    if (!want) return false
    // Пока бежит за вещью — b.climbing: прочие дела драйвера не рвут короткий забег («булава в 1.2 бл. — goal was changed»).
    const before = ownedCount({ inventory: inv, armor: m.armor }, want.name)
    let g: any = {}, s: any = null
    b.climbing = true
    lootStep(b, want.at, 'grab')
    try {
      const approach = await b.c.call('goto', { ...bounded(want.at), range: 0.4, timeoutSeconds: 3, arena: lootArena(b), _hunt: true, _climb: true }).catch(e => ({ why: e.message }))
      g = detail(approach)
      if (approach?.status === 'done' && g.arrived) {
        const pickup = detail(await b.c.call('assist', { mode: 'pickup', item: want.name, maxD: 2, arena: lootArena(b), _climb: true }).catch(e => ({ why: e.message })))
        if (!pickup.ok) g.why = pickup.why || 'не подобрал'
      }
      s = await b.c.call('status').catch(() => null)
    } finally { b.climbing = false }
    const got = !!s?.state && ownedCount(s.state, want.name) > before
    if (s?.state?.inventory) { pos[b.name].inv = s.state.inventory; pos[b.name].armor = s.state.armor || pos[b.name].armor }
    if (!got) cooldown.set(`grab:${b.name}:${want.id ?? want.name + Math.round(want.at?.x) + Math.round(want.at?.z)}`, now() + 30000)
    cooldown.set(`grab:${b.name}`, now() + 1500)
    log(`🫳 ${b.name}: беру ${want.name} в ${want.d} бл.${near < 20 ? ` (враг в ${Math.round(near)} бл.)` : ''} — ${got ? 'взял' : String(g.why || g.error || (g.arrived ? 'дошёл, не поднялось' : 'не дошёл')).slice(0, 40)}`)
    if (got && armorOf(want.name)) await b.c.call('armor', {}).catch(() => {})
    return got
  }
  async function climbTo(b, foe, at) {
    const m = pos[b.name], inv = m.inv || {}, dy = foe.position.y - m.p.y
    const blocks = Object.entries(inv).filter(([n]) => BLOCK.test(n)).reduce((s, [, c]: any) => s + c, 0)
    const pick = Object.keys(inv).some(n => /_pickaxe$/.test(n))
    // Он на столбе или уступе прямо над нами (по горизонтали ≤ 4, выше на 3–14): динамит под его опору — взрыв ломает
    // столб/песчаник, он падает к нам.
    if (dy <= 4 && Math.hypot(foe.position.x - m.p.x, foe.position.z - m.p.z) <= 4 && await blast(b, foe.position, `под ${foe.id}`)) return true
    if ((inv.elytra || m.armor?.torso === 'elytra') && (inv.firework_rocket || 0) >= 3 && (cooldown.get(`fly:${b.name}`) || 0) <= now()) {
      cooldown.set(`fly:${b.name}`, now() + 12000)
      const r = detail(await b.c.call('fly_to', { at, timeoutSeconds: 15, arena }).catch(e => ({ why: e.message })))
      log(`🪽 ${b.name}: лечу к ${foe.id} (+${Math.round(dy)}) — ${r.ok ? 'долетел' : String(r.why || 'нет').slice(0, 60)}`)
      if (r.ok) return true
    }
    // Жемчуг поднимается на 15–18 бл. (бросок 1.5 бл/т, гравитация 0.03): выше +16 — сперва лезть, бросать с яруса.
    if ((inv.ender_pearl || 0) > 0 && dy <= 16 && distance(m.p, foe.position) < 40 && (cooldown.get(`pearl:${b.name}`) || 0) <= now()) {
      cooldown.set(`pearl:${b.name}`, now() + 8000)
      const r = detail(await b.c.call('pearl_to', { to: at, edgeOk: true, yTop: 45 }).catch(e => ({ why: e.message })))
      log(`🟣 ${b.name}: жемчуг к ${foe.id} (+${Math.round(dy)}) — ${r.ok ? 'долетел' : (typeof r.why === 'object' ? JSON.stringify(r.why) : String(r.stop || r.why || 'нет')).slice(0, 80)}`)
      if (r.ok) return true
    }
    // Готовая лестница своих, верх которой у цели (в 8 бл.), — по ней: строитель путей лезет по ступеням сам, блоки не нужны.
    const lad = ladderRoutes.filter(l => l.top.y > m.p.y + .6 && l.top.y <= foe.position.y + 1 && l.base.y >= m.p.y - 1 && Math.hypot(l.top.x - foe.position.x, l.top.z - foe.position.z) < 12 && !(l.bad?.[b.name] > now()))
      .sort((a, c) => distance(m.p, a.base) - distance(m.p, c.base))[0]
    if (lad) {
      b.climbing = true
      const r = detail(await b.c.call('goto', { ...bounded(lad.top), range: 1, timeoutSeconds: 25, arena, _hunt: true, _climb: true }).catch(e => ({ why: e.message })).finally(() => { b.climbing = false }))
      if (!(r.arrived?.y >= lad.top.y - .5)) (lad.bad ||= {})[b.name] = now() + 20000
      log(`🪜 ${b.name}: по лестнице своих к ${foe.id} — ${r.arrived ? 'наверху' : String(r.why || r.error || 'нет').slice(0, 60)}`)
      return true
    }
    // Маршрут не нашёлся (отказ за доли секунды) — 5 с не повторять (иначе сотни попыток в минуту): с киркой — прокоп
    // ступенями к цели, без — добыча блоков ниже.
    const climbOk = (cooldown.get(`climb:${b.name}`) || 0) <= now()
    // Короткий столбик к нему (он рядом, выше на 2–3: край крыши) — блоков на высоту + 1; к далёкой цели — с запасом.
    const needBlocks = Math.hypot(foe.position.x - m.p.x, foe.position.z - m.p.z) < 4 && dy <= 4 ? Math.ceil(dy) + 1 : Math.min(dy + 4, 20)
    if ((blocks >= needBlocks || pick) && climbOk) {
      // Сектор у цели наверху бывает в воздухе (над рядами) — после отказа прямо к цели. Пока лезет — b.climbing: обмены, лут,
      // «прикрываю» и уворот от прицела его не дёргают (watch.ts, dangers.ts).
      const t0 = now(), goal = b.climbMiss ? foe.position : at, from = { ...m.p }
      // Отрезками по 8 бл. к цели (стенд 14.10: одним походом на +30 — «пути нет»; пешком с песка выше первого пояса не дойти):
      // короткий поиск со стройкой и прокопом дешёвый — стенку пояса перескочит столбиком, где пусто — столб.
      const span = distance(m.p, goal), k = Math.min(1, 8 / Math.max(span, 1))
      const wp = { x: m.p.x + (goal.x - m.p.x) * k, y: m.p.y + (goal.y - m.p.y) * k, z: m.p.z + (goal.z - m.p.z) * k }
      // Точка отрезка — на поверхность (ступень, проход), а не внутрь засыпки рядов на прямой.
      if (k < 1 && surfaceY) { const sy = surfaceY(wp.x, wp.z, goal.y); if (sy != null) wp.y = sy }
      // Последний отрезок — к нему самому (его пол точно есть), ровно на его высоту: сектор рядом бывает в стене коридора или
      // в воздухе у края крыши, и «дошёл» засчитывался внизу. Промежуточные — по поверхности модели (ступени, проходы) без
      // exactY: точка в воздухе на прямой заставляла строить столбы в коридоре с потолком (галерея: контакт 92 → 157 с).
      const last = k >= 1, dest = last ? foe.position : wp
      b.climbing = true
      const r = detail(await b.c.call('goto', { ...bounded(dest), range: 1.5, timeoutSeconds: 15, arena, climb: true, exactY: last, _hunt: true, _climb: true }).catch(e => ({ why: e.message })).finally(() => { b.climbing = false }))
      const failed = !r.arrived && (now() - t0 < 1500 || /no path|пути нет/i.test(String(r.why || r.error || r.stopped || '')))
      // Поднялся на 3+ почти на месте — построил столб: место под лестницу своим (ladder_up).
      const end = r.arrived || pos[b.name]?.p
      if (end && end.y - from.y >= 3 && Math.hypot(end.x - from.x, end.z - from.z) <= 1.5) {
        // (столбы лезущих больше не места лестниц — места из модели)
      }
      b.climbMiss = failed && !b.climbMiss
      // Точка вне арены — повтор той же точки бессмыслен: пауза сразу (31aj, выступ 15.10: 33 отказа «outside arena bounds» за 83 с).
      const boundary = /arena bounds/.test(String(r.why || r.error || ''))
      if (failed && (!b.climbMiss || boundary)) cooldown.set(`climb:${b.name}`, now() + 5000)
      if (boundary) log(`🧗 ${b.name}: точка подъёма вне арены — ${[dest.x, dest.y, dest.z].map(v => Math.round(v)).join(',')} (цель ${[foe.position.x, foe.position.y, foe.position.z].map(v => Math.round(v)).join(',')})`)
      // Пришёл, а выше не стал (на 1+ бл.) — 4 с без подъёма: бить/копать/ждать своих, а не тот же поход по кругу.
      const gain = (end?.y ?? from.y) - from.y
      if (!failed && gain < 1 && foe.position.y - (end?.y ?? from.y) > 3) cooldown.set(`climb:${b.name}`, now() + 4000)
      // В журнал — отказ и приход наверх (отрезки по 8 бл. — сотни строк за прогон).
      if (failed || k >= 1) log(`🧗 ${b.name}: лезу к ${foe.id} (+${Math.round(dy)}, блоков ${blocks}${pick ? ', кирка' : ''}) — ${r.arrived ? `дошёл, ${Math.round(r.arrived.y - foe.position.y)} по высоте от него` : String(r.why || r.stopped || r.error || (failed ? 'пути нет' : 'не дошёл')).slice(0, 60)}`)
      return true
    }
    if (pick && !climbOk && await breach(b, at)) return true
    if (blocks >= needBlocks) return false
    if ((cooldown.get(`dig:${b.name}`) || 0) > now()) return false
    cooldown.set(`dig:${b.name}`, now() + 3000)
    const r = detail(await b.c.call('mine', { block: 'sand,red_sand,dirt,grass_block,coarse_dirt', count: Math.min(32, Math.ceil(dy) + 6), radius: 32, timeoutSeconds: 20 }).catch(e => ({ why: e.message })))
    log(`🏖 ${b.name}: блоков на подъём нет — копаю руками (${foe.id} на +${Math.round(dy)}): ${r.dug ?? 0} шт.${r.why ? ` (${String(r.why).slice(0, 60)})` : ''}`)
    if (!r.dug) { cooldown.set(`dig:${b.name}`, now() + 12000); if (sandSpot && distance(m.p, sandSpot) > 12) { await go(b, sandSpot, 6, 8); return true } }
    return (r.dug || 0) > 0
  }
  async function breach(b, at) {
    if ((cooldown.get(`breach:${b.name}`) || 0) > now()) return false
    const me = pos[b.name]?.p, inv = pos[b.name]?.inv || {}
    if (me && !Object.keys(inv).some(n => /_pickaxe$/.test(n))) {
      const d = distance(me, at) || 1
      if (await blast(b, { x: me.x + (at.x - me.x) / d * 2, y: me.y, z: me.z + (at.z - me.z) / d * 2 }, 'в стену к цели')) return true
    }
    cooldown.set(`breach:${b.name}`, now() + 2000)
    const r = detail(await b.c.call('dig_to', { at: { x: at.x, y: at.y, z: at.z }, maxSteps: 6, timeoutSeconds: 8 }).catch(e => ({ why: e.message })))
    if (!r.dug) { cooldown.set(`breach:${b.name}`, now() + 8000); return false }
    log(`⛏ ${b.name}: прокапываюсь к цели — ${r.dug} бл.${r.ok ? ', дошёл' : r.why ? ` (${r.why})` : ''}`)
    return true
  }
  return { MAT, ARM, weaponValue, armorOf, grab, climbTo, breach }
}
