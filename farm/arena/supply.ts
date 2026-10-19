'use strict'
import { DIST_ROOT } from '../../daemon/src/paths'
// Снабжение команды: чего не хватает бойцу и что отдать своим, гонка «лут → каптёр» (передачи, алхимик, апгрейд брони,
// лаборатория), роли по снаряжению и командный сторож.
import { ROOT } from './context'
import { WEAPON, FOOD, ARMOR_SLOT, ALCHEMY, tierOf, KITS } from './gear'
import type { ArenaContext } from './context'
import path = require('path')
const crowd = require(path.join(DIST_ROOT, 'daemon', 'src', 'pvp', 'crowd'))

export function installSupply (ctx: ArenaContext) {
  const { i, kit, COLOS_MAP, AL, L, X, Y, Z, bots, pos, busy, labNeed, brewed, alchemist, log, sleep } = ctx
  // Чего не хватает бойцу (по его рюкзаку): яблоко при ≤ 14 хп, зелья лекарю, блоки на стенки, оружие.
  // Что из ресурсов в этом бою вообще бывает (набор): зелья и блоки просят, только если их выдают.
  ctx.kitHas = (re: RegExp) => (KITS[kit] || []).some(it => re.test(it))
  ctx.needOf = (m: any) => {
    const inv = m?.inv || {}
    const lab = (m?.labNeed || []).find(x => !inv[x])
    if (lab) return { item: lab }
    const names = Object.keys(inv)
    if (!names.some(n => WEAPON.test(n))) return { item: 'оружие' }
    if (!names.some(n => FOOD.test(n)) && (m.hp ?? 20) <= 14) return { item: 'еда' }
    // Пустой слот брони (не надето и нет в рюкзаке) — попросить у своих.
    const worn = m?.armor || {}
    for (const [slot, re] of Object.entries(ARMOR_SLOT)) if (!worn[slot] && !names.some(n => (re as RegExp).test(n))) return { item: 'броня:' + slot }
    if (ctx.kitHas(/splash_potion/) && !inv.splash_potion) return { item: 'splash_potion' }
    if (ctx.kitHas(/cobblestone/) && (inv.cobblestone || 0) < 8) return { item: 'cobblestone' }
    return null
  }
  // Что отдать из своего запаса (себе — неприкосновенное: лучшее оружие, 1 еда, 1 зелье, 16 блоков, надетая броня).
  ctx.spare = (inv: any, need: any, worn: any = {}) => {
    const names = Object.keys(inv)
    if (need.item === 'оружие') {
      const w = names.filter(n => WEAPON.test(n)).sort((a, b) => tierOf(b) - tierOf(a))
      return w.length >= 2 ? { item: w[w.length - 1], count: 1 } : null
    }
    if (ALCHEMY.test(need.item)) return (inv[need.item] || 0) > 0 ? { item: need.item, count: inv[need.item] } : null
    if (need.item === 'еда') {
      const f = names.filter(n => FOOD.test(n)).sort((a, b) => (inv[b] || 0) - (inv[a] || 0))
      const total = f.reduce((a, n) => a + inv[n], 0)
      return total >= 2 ? { item: f[0], count: Math.max(1, Math.min(4, Math.floor(total / 2))) } : null
    }
    if (need.item.startsWith('броня:')) {
      const slot = need.item.slice(6)
      // Лишняя — в рюкзаке, а свой слот уже надет.
      const it = names.filter(n => ARMOR_SLOT[slot].test(n)).sort((a, b) => tierOf(b) - tierOf(a))[0]
      return it && worn[slot] ? { item: it, count: 1 } : null
    }
    const keep = { golden_apple: 1, splash_potion: 1, cobblestone: 16 }[need.item] ?? 1
    const have = inv[need.item] || 0
    const n = need.item === 'cobblestone' ? Math.min(24, have - keep) : Math.min(1, have - keep)
    return n > 0 ? { item: need.item, count: n } : null
  }
  // ---------------------------------------------------------------- гонка: лут и каптёр
  // Лут до завершения обхода: зоны — комнаты (кроме тайных) и четверти поля — делятся в команде (своя заявка на зону:
  // двое не бегут в одну). Сундук — только увиденный (blocks_around seen), забирается целиком; один сундук — одному.
  // Каптёр: команда сходится на своём старте, лишнее — тем, у кого пусто (оружие, слот брони, еда), всё надеть.
  ctx.armsPrep = async function armsPrep () {
    const areas = L.areas || [...L.rooms.filter(r => !L.secret.includes(r.id)).map(r => ({ id: r.id, x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 })),
      ...[[-1, -1], [-1, 1], [1, -1], [1, 1]].map(([sx, sz]) => ({ id: `поле${sx}${sz}`, x: 6 * sx, z: 6 * sz })),
      // Крыши коридора и комнат (y=5) — по лестницам, как в arms-run.knownAreas.
      { id: 'крышаW', x: -21, y: 5, z: 0 }, { id: 'крышаE', x: 21, y: 5, z: 0 }]
    const claimed: Record<string, Set<string>> = { red: new Set(), blue: new Set() }
    const taken = new Set<string>()
    const got: Record<string, number> = {}
    await sleep(800)
    const round = ctx.round
    const looting = () => !ctx.stop && ctx.round === round
    log(`гонка: лут до обхода ${areas.length} зон — делятся в команде`)
    await Promise.all(bots.map(async (b) => {
      while (looting()) {
        const me = pos[b.name]; if (!me?.p) break
        const mine = claimed[b.team]
        const area = areas.filter(a => !mine.has(a.id)).sort((a, c) => Math.hypot(X + a.x - me.p.x, Z + a.z - me.p.z) - Math.hypot(X + c.x - me.p.x, Z + c.z - me.p.z))[0]
        if (!area) break
        mine.add(area.id)
        await b.c.call('goto', { x: X + area.x, y: Y + ((area as any).y || 0), z: Z + area.z, range: 3, timeoutSeconds: 15 }).catch(() => {})
        if (!looting()) return
        // Тайники: облицовка (доски в стене, каменистая земля в полу — признак, виден глазами) — сломать, за ней сундук.
        for (const cover of [AL.FACADE, AL.UNDER]) {
          const cv = await b.c.call('blocks_around', { find: cover, seen: true, radius: 10, count: 4 }).catch(() => null)
          for (const q of ((cv && cv.detail && cv.detail.found) || [])) {
            const ck = 'cv' + q.x + ',' + q.y + ',' + q.z
            if (taken.has(ck) || Math.max(Math.abs(q.x - X), Math.abs(q.z - Z)) > L.half) continue
            taken.add(ck)
            const r = await b.c.call('mine', { block: cover, at: { x: q.x, y: q.y, z: q.z }, collect: false, timeoutSeconds: 20 }).catch(e => ({ error: e.message }))
            log(`⛏ ${b.name} тайник ${q.x},${q.y},${q.z}: ${r && r.status}`)
          }
        }
        const res = await b.c.call('blocks_around', { find: 'chest', seen: true, radius: 14, count: 16 }).catch(() => null)
        for (const c of ((res && res.detail && res.detail.found) || [])) {
          if (!looting()) break
          const key = `${c.x},${c.y},${c.z}`
          if (taken.has(key) || Math.max(Math.abs(c.x - X), Math.abs(c.z - Z)) > L.half) continue
          taken.add(key)
          const r = await b.c.call('chest_take', { item: 'all', x: c.x, y: c.y, z: c.z }).catch(e => ({ error: e.message }))
          const moved = Object.values((r && r.detail && (r.detail.took || r.detail.moved)) || {}).reduce((a: number, n: any) => a + (Number(n) || 0), 0)
          got[b.name] = (got[b.name] || 0) + (moved as number)
          log(`🧰 ${b.name} сундук ${key} (${area.id}): ${moved ? '+' + moved : (r && (r.error || r.detail?.stopped)) || 'пусто'}`)
        }
      }
      await b.c.call('armor').catch(() => {})
    }))
    if (!looting()) return
    log(`гонка: лут окончен — сундуков открыто ${taken.size}/${L.chests.length}; ${bots.map(b => `${b.name.replace('NeuroFarm' + i, '#') || '#'}:${got[b.name] || 0}`).join(' ')}`)
    // Каптёр: сход на своём старте (≤ 10 игровых с), затем передачи «лишнее → пустому» внутри команды.
    await Promise.all(bots.map((b, k) => { const h = ctx.armsHome(b, k); return b.c.call('goto', { x: h.x, y: h.y, z: h.z, range: 2, timeoutSeconds: COLOS_MAP ? 40 : 10 }).catch(() => {}) }))
    await sleep(1500)
    // Передача — только тем, кто сошёлся (≤ 10 бл.): дальних каптёр не гоняет (колизей 10.10: «далеко 74 бл.», бой стоял минуты).
    const near = (a, c) => pos[a.name]?.p && pos[c.name]?.p && Math.hypot(pos[a.name].p.x - pos[c.name].p.x, pos[a.name].p.y - pos[c.name].p.y, pos[a.name].p.z - pos[c.name].p.z) <= 10
    let moves = 0
    for (const team of ['red', 'blue']) {
      const tm = bots.filter(b => b.team === team)
      for (const r of tm) {
        for (let n = 0; n < 4; n++) {
          const need = ctx.needOf(pos[r.name]); if (!need) break
          const donor = tm.filter(d => d !== r && pos[d.name] && near(d, r)).map(d => ({ d, give: ctx.spare(pos[d.name].inv, need, pos[d.name].armor) })).find(x => x.give)
          if (!donor) break
          await donor.d.c.call('goto', { x: pos[r.name].p.x, y: pos[r.name].p.y, z: pos[r.name].p.z, range: 2, timeoutSeconds: 4 }).catch(() => {})
          const t = await donor.d.c.call('assist', { mode: 'toss', ally: r.name, item: donor.give.item, count: donor.give.count }).catch(e => ({ detail: { why: e.message } }))
          const pu = await r.c.call('assist', { mode: 'pickup', item: donor.give.item }).catch(e => ({ detail: { why: e.message } }))
          await sleep(900)
          moves++
          log(`🎒 каптёр ${donor.d.name} → ${r.name}: ${donor.give.item}×${donor.give.count} (нужно ${need.item}) — ${t?.detail?.why || t?.status}; ${pu?.detail?.why || pu?.status}`)
          if (!(t?.detail?.ok)) break
        }
      }
    }
    // Алхимия: алхимик команды — у кого больше ингредиентов; свои свозят ему всё для варки (каптёр).
    for (const team of ['red', 'blue']) {
      const tm = bots.filter(b => b.team === team && pos[b.name])
      const alch = (n) => Object.entries(pos[n]?.inv || {}).filter(([k]) => ALCHEMY.test(k)).reduce((a, [, c]) => a + (c as number), 0)
      const chef = [...tm].sort((a, c) => alch(c.name) - alch(a.name))[0]
      if (!chef || !tm.some(b => alch(b.name) > 0)) continue
      alchemist[team] = chef.name
      for (const d of tm) {
        if (d === chef || !near(d, chef)) continue
        for (const [k, c] of Object.entries(pos[d.name].inv || {})) {
          if (!ALCHEMY.test(k)) continue
          await d.c.call('goto', { x: pos[chef.name].p.x, y: pos[chef.name].p.y, z: pos[chef.name].p.z, range: 2, timeoutSeconds: 4 }).catch(() => {})
          const t = await d.c.call('assist', { mode: 'toss', ally: chef.name, item: k, count: c }).catch(e => ({ detail: { why: e.message } }))
          const pu = await chef.c.call('assist', { mode: 'pickup', item: k }).catch(e => ({ detail: { why: e.message } }))
          moves++
          log(`⚗ ${d.name} → алхимику ${chef.name}: ${k}×${c} — ${t?.detail?.why || t?.status}; ${pu?.detail?.why || pu?.status}`)
        }
      }
    }
    // Апгрейд: надетое хуже лишнего у своего (железный шлем при запасном алмазном) — отдать лучшее.
    await Promise.all(bots.map(b => b.c.call('armor').catch(() => {})))
    await sleep(800)
    for (const team of ['red', 'blue']) {
      const tm = bots.filter(b => b.team === team && pos[b.name])
      for (const r of tm) for (const [slot, re] of Object.entries(ARMOR_SLOT)) {
        const worn = (pos[r.name].armor || {})[slot]
        const cur = worn ? tierOf(worn) : -1
        const offer = tm.filter(d => d !== r && near(d, r) && (pos[d.name].armor || {})[slot]).map(d => ({ d, it: Object.keys(pos[d.name].inv || {}).filter(n => (re as RegExp).test(n)).sort((a, c) => tierOf(c) - tierOf(a))[0] }))
          .filter(o => o.it && tierOf(o.it) > cur).sort((a, c) => tierOf(c.it) - tierOf(a.it))[0]
        if (!offer) continue
        await offer.d.c.call('goto', { x: pos[r.name].p.x, y: pos[r.name].p.y, z: pos[r.name].p.z, range: 2, timeoutSeconds: 4 }).catch(() => {})
        const t = await offer.d.c.call('assist', { mode: 'toss', ally: r.name, item: offer.it, count: 1 }).catch(e => ({ detail: { why: e.message } }))
        const pu = await r.c.call('assist', { mode: 'pickup', item: offer.it }).catch(e => ({ detail: { why: e.message } }))
        await sleep(900)
        moves++
        log(`🎒⬆ каптёр ${offer.d.name} → ${r.name}: ${offer.it} вместо ${worn || 'пусто'} — ${t?.detail?.why || t?.status}; ${pu?.detail?.why || pu?.status}`)
      }
    }
    await Promise.all(bots.map(b => b.c.call('armor').catch(() => {})))
    await sleep(800)
    const gear = (n) => { const m = pos[n] || {}; const w = Object.keys(m.inv || {}).filter(x => WEAPON.test(x)).sort((a, c) => tierOf(c) - tierOf(a))[0]; const a = Object.values(m.armor || {}).filter(Boolean).length; return `${w || 'без оружия'}+${a}бр` }
    log(`гонка: каптёр — передач ${moves}; к бою: ${bots.map(b => `${b.name.replace('NeuroFarm' + i, '#') || '#'} ${gear(b.name)}`).join(', ')}`)
    // Лаборатория (комната N2: стойка, верстак, вода): алхимик варит взрывное лечение II (есть ферм. глаз — и вред),
    // кузнец (слитки/алмазы + палки, без хорошего оружия) крафтит меч. Пока в лаборатории — не дерётся (busy).
    const labAt = { x: X + L.lab.brewing.x, y: Y + L.lab.brewing.y, z: Z + L.lab.brewing.z + 1 }
    const craftAt = { x: X + L.lab.crafting.x, y: Y + L.lab.crafting.y, z: Z + L.lab.crafting.z + 1 }
    for (const team of ['red', 'blue']) {
      const chef = bots.find(b => b.name === alchemist[team])
      if (chef) ctx.brewTask(chef, team)
      for (const b of bots.filter(o => o.team === team && o !== chef)) {
        const inv = pos[b.name]?.inv || {}
        const best = Object.keys(inv).filter(n => WEAPON.test(n)).reduce((a, n) => Math.max(a, tierOf(n)), -1)
        const item = (inv.diamond || 0) >= 2 && (inv.stick || 0) >= 1 && best < tierOf('diamond_sword') ? 'diamond_sword'
          : (inv.iron_ingot || 0) >= 2 && (inv.stick || 0) >= 1 && best < tierOf('iron_sword') ? 'iron_sword' : null
        if (item) ctx.labTask(b, async () => {
          await b.c.call('goto', { ...craftAt, range: 2, timeoutSeconds: 20 }).catch(() => {})
          const r = await b.c.call('craft', { item, count: 1 }).catch(e => ({ error: e.message }))
          log(`🔨 ${b.name} крафтит ${item}: ${r && r.status}${r && r.detail && r.detail.stopped ? ' — ' + r.detail.stopped : ''}`)
        })
      }
    }
  }
  // Алхимик в лаборатории: взрывное лечение II, потом взрывной вред. Не хватает — просит своих (labNeed → needOf),
  // повтор — когда набор полный (сторож tactT).
  ctx.brewTask = function brewTask (chef, team) {
    const labAt = { x: X + L.lab.brewing.x, y: Y + L.lab.brewing.y, z: Z + L.lab.brewing.z + 1 }
    const labChest = { x: labAt.x - 1, y: labAt.y, z: labAt.z - 1 }
    ctx.labTask(chef, async () => {
      await chef.c.call('goto', { ...labAt, range: 2, timeoutSeconds: 20 }).catch(() => {})
      for (const [potion, why] of [['strong_healing', 'лечение'], ['harming', 'вред']]) {
        if (brewed[team + potion]) continue
        let r = await chef.c.call('brew', { potion, splash: true, count: 3 }).catch(e => ({ error: e.message }))
        let d = r && r.detail
        if (d && !d.made && Array.isArray(d.missing) && d.missing.length) {
          const t = await chef.c.call('chest_take', { item: d.missing.map(m => m.what).join(','), count: d.missing.reduce((a, m) => a + m.count - m.have, 0), ...labChest }).catch(e => ({ error: e.message }))
          log(`⚗ ${chef.name} берёт в лаборатории: ${JSON.stringify(t?.detail?.took || t?.error || t?.status)}`)
          r = await chef.c.call('brew', { potion, splash: true, count: 3 }).catch(e => ({ error: e.message })); d = r && r.detail
        }
        log(`⚗ ${chef.name} варит взрывное ${why}: ${d ? (d.made ? 'сварил ' + d.made : d.stopped || 'нет') : r.error || r.status}`)
        if (d && d.made) { brewed[team + potion] = true; labNeed[chef.name] = []; continue }
        if (potion === 'strong_healing' && d && Array.isArray(d.missing)) labNeed[chef.name] = d.missing.map(m => m.what).filter(w => ALCHEMY.test(w))
        break
      }
    })
  }
  ctx.labTask = function labTask (b, fn) {
    // Не посреди боя (вызов лаборатории отменял fight; Codex 15.10).
    if (busy.has(b.name) || b.last?.m === 'fight' || ctx.enemiesOf(b, pos[b.name]?.p).some(e => e.d <= 3.5)) return
    busy.add(b.name)
    fn().catch(() => {}).finally(() => { busy.delete(b.name); b.c.call('armor').catch(() => {}) })
  }
}

export async function startTactics (ctx: ArenaContext) {
  const { i, teams, arms, bots, pos, busy, labNeed, brewed, alchemist, log, sleep } = ctx
  // Роли пересчитываются при смене состава или снаряжения; период опроса не задаёт срок роли.
  const roles: Record<string, string> = {}
  let assigned = ''
  const assign = () => {
    if (!teams) return
    const members = bots.filter(b => pos[b.name] && (!ctx.alive || ctx.alive(b.name))).map(b => ({ name: b.name, team: b.team, inv: pos[b.name].inv || {}, armor: pos[b.name].armor || {} })).sort((a, b) => a.name.localeCompare(b.name))
    const key = JSON.stringify(members.map(b => [b.name, b.team, Object.entries(b.inv).filter(([, n]) => Number(n) > 0).sort(([a], [b]) => a.localeCompare(b)), Object.entries(b.armor).sort(([a], [b]) => a.localeCompare(b))]))
    if (key === assigned) return
    assigned = key
    for (const n of Object.keys(roles)) delete roles[n]
    for (const t of ['red', 'blue']) Object.assign(roles, crowd.assignRoles(members.filter(b => b.team === t), tierOf))
    log('роли: ' + ['red', 'blue'].map(t => (t === 'red' ? '🟥 ' : '🟦 ') + bots.filter(b => b.team === t).map(b => `${b.name.replace('NeuroFarm' + i, '#') || '#'}=${roles[b.name] || '?'}`).join(' ')).join('  '))
  }
  await sleep(600)
  assign()
  const rolesT = setInterval(assign, 250)
  const tactT = setInterval(() => {
    if (!teams) return
    if (arms && !ctx.between && Date.now() - ctx.roundT0 > Number(process.env.ROUND_S || 420) * 1000) ctx.endRound(true).catch(() => {})
    if (arms && !ctx.between) for (const t of ['red', 'blue']) {
      const chef = bots.find(b => b.name === alchemist[t])
      if (chef && !busy.has(chef.name) && !brewed[t + 'strong_healing'] && (labNeed[chef.name] || []).length && labNeed[chef.name].every(x => (pos[chef.name]?.inv || {})[x])) { log(`⚗ ${chef.name}: набор собран — снова в лабораторию`); ctx.brewTask(chef, t) }
    }
  }, 2000)
  return { rolesT, tactT }
}
