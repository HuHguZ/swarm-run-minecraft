// Рой (swarm.ts): счёт боя по видимому — личный (assessSwarmFight) и командный (assessTeamFight), группы своих и их
// приговор (groupOf, groupVerdict), политика бегства (mustFlee).
import * as damage from '../pvp/damage-model'
import type { SwarmPosition, SwarmMember, SharedEnemy } from './types'
import { distance, count, sharpWeapon } from './common'
import { retreatWhy } from './retreat'

// Та же шкала снаряжения, что power в ферме; неизвестное здоровье — консервативные 20, не HP из сущности.
export function visibleForce(enemy: SharedEnemy): number {
  const tier = (name: string) => /netherite/.test(name) ? 4 : /diamond/.test(name) ? 3 : /iron/.test(name) ? 2 : /stone|chainmail|copper/.test(name) ? 1 : 0
  const weapon = enemy.equipment?.weapon
  const armed = weapon && /_sword|_axe|_spear|mace|trident|bow|crossbow/.test(weapon) ? tier(weapon) + 2 : 0
  const armor = (enemy.equipment?.armor || []).reduce((sum, name) => sum + tier(name) + 2, 0) + (enemy.equipment?.unknownArmorSlots || 0) * 6
  return 20 * (1 + armed / 4) * (1 + armor / 18)
}
export interface SwarmFightRisk {
  unsafe: boolean
  target?: string
  killSeconds: number
  survivalSeconds: number
  damage: number
  ready: number
  contactSlots: number
  enemySharpness: [number, number]
  enemyProtection: [number, number]
  // Первый залп убивает раньше, чем убьём мы: бежать при любом размене сторон.
  lethal?: boolean
  // Их первый залп вплотную убивает (без гонки «кто раньше добежит»): им держится начатый отход от залпа (retreat.ts).
  burst?: boolean
  // Та же схватка без подхода (от первых ударов): решение «один против сильного» не должно зависеть от расстояния —
  // издалека «выжить» длиннее на время его подхода, и бот шёл на врага, от которого у 16 бл. снова бежал (стенд 15×15).
  duelKillSeconds?: number
  duelSurvivalSeconds?: number
  reason: string
}
export function ownDefense(m: SwarmMember) {
  const defense = damage.defenseOf((Array.isArray(m.armor) ? m.armor : Object.values(m.armor || {})).filter(Boolean).map(name => ({ name })))
  defense.prot = Math.max(0, m.ench?.protection || 0)
  return defense
}
function enemyDefense(e: SharedEnemy) {
  // Блеск виден, тип и уровень чар нет: верх — vanilla Protection IV, низ ноль (блеск может быть от иных чар).
  const armor = (e.equipment?.armor || []).map(name => ({ name, ench: { protection: e.equipment?.enchanted ? 4 : 0 } }))
  const unknown = Math.max(0, Math.min(4 - armor.length, e.equipment?.unknownArmorSlots || 0))
  const slots = ['chestplate', 'leggings', 'helmet', 'boots'].filter(slot => !armor.some(it => it.name.endsWith('_' + slot)))
  for (const slot of slots.slice(0, unknown)) armor.push({ name: 'netherite_' + slot, ench: { protection: 4 } })
  return damage.defenseOf(armor)
}
function combatProfile(m: SwarmMember, foe: SharedEnemy) {
  const defense = enemyDefense(foe)
  const weapons = [...new Set([m.weapon, ...Object.keys(m.inventory || {}).filter(n => count(m.inventory, n) > 0 && damage.isMeleeWeapon(n)), null])]
  let best: any = null
  for (const weapon of weapons) {
    if (weapon && !damage.isMeleeWeapon(weapon)) continue
    // Крит — то же правило, что у врага (enemyAttack): оружие ближнего боя с полным зарядом — крит, кулак — нет. Доля
    // критов у ботов ниже (бой лаборатории 14.10: 1 из 9), но решение сравнивает стороны: одно правило сдвигает время
    // убийства и выживания одинаково, а «свои всегда критуют» давало перекос в свою пользу.
    const raw = damage.meleeRaw({ weapon, sharpness: m.ench?.sharpness || 0, crit: damage.isMeleeWeapon(weapon) })
    const interval = Math.max(damage.IFRAME_TICKS, damage.ticksToCharge(weapon))
    const hit = damage.afterDefense(raw, 'melee', defense)
    const candidate = { member: m, defense: ownDefense(m), raw, kind: 'melee', interval, hit, ranged: false }
    if (!best || hit / interval > best.hit / best.interval) best = candidate
  }
  if (m.inventory?.arrow && (m.inventory.bow || m.inventory.crossbow)) {
    const bow = !!m.inventory.bow
    const speed = damage.arrowSpeedAt(bow ? 3 : damage.CROSSBOW_ARROW_SPEED, distance(m.position, foe.position))
    const outcomes = damage.arrowOutcomes({ speed, power: m.ench?.power || 0, crit: true })
    const raw = outcomes.reduce((s: number, o: { raw: number; p: number }) => s + o.raw * o.p, 0)
    const interval = bow ? damage.BOW_FULL_TICKS : damage.crossbowChargeTicks()
    const hit = damage.afterDefense(raw, 'projectile', defense)
    if (distance(m.position, foe.position) <= 32 && (!best || hit / interval > best.hit / best.interval)) best = { member: m, defense: ownDefense(m), raw, kind: 'projectile', interval, hit, ranged: true }
  }
  return best
}
function enemyAttack(e: SharedEnemy, m: SwarmMember) {
  const weapon = e.equipment?.weapon
  const glint = !!e.equipment?.enchanted
  let raw: number; let kind = 'melee'; let interval: number
  // Взрыв — только кристалл и якорь: их ставят и рвут за пару тиков. Динамит в руке — не взрыв (поставить, поджечь, 4 с
  // фитиля): «выжить 0.0 с» от любого с динамитом в руке гнало от него всю команду (стенд 15×15, 21.10). Горящий динамит
  // в мире — дело уворота тела (tactics/blast.ts) и факта tnt драйвера.
  if (/^(end_crystal|respawn_anchor)$/.test(weapon || '')) {
    kind = 'explosion'
    raw = damage.explosionRaw({ power: weapon === 'respawn_anchor' ? damage.ANCHOR_POWER : damage.CRYSTAL_POWER, dist: distance(e.position, m.position), seen: 1 })
    interval = damage.IFRAME_TICKS
  } else if (/^(bow|crossbow)$/.test(weapon || '')) {
    kind = 'projectile'
    const outcomes = damage.arrowOutcomes({ speed: damage.arrowSpeedAt(weapon === 'bow' ? 3 : damage.CROSSBOW_ARROW_SPEED, distance(e.position, m.position)), power: glint && weapon === 'bow' ? 5 : 0, crit: true })
    // Средняя стрела, как у своих (combatProfile): худшая из критов Силы V (23) у голого на 20 хп — «залп» от любого лука.
    raw = outcomes.reduce((s: number, o: { raw: number; p: number }) => s + o.raw * o.p, 0)
    interval = weapon === 'bow' ? damage.BOW_FULL_TICKS : damage.crossbowChargeTicks(glint ? 3 : 0)
  } else {
    // Удар булавы с падения — только когда он падает почти над головой (≤ 3 бл. по горизонтали): прыжок на уступе в 6 бл.
    // давал «залп» на высоту уступа.
    const smash = weapon === 'mace' && (e.velocity?.y || 0) < 0 && Math.hypot(e.position.x - m.position.x, e.position.z - m.position.z) <= 3
    raw = damage.meleeRaw({ weapon, sharpness: glint && sharpWeapon(weapon) ? 5 : 0, crit: damage.isMeleeWeapon(weapon) || (e.velocity?.y || 0) < 0, fall: smash ? Math.max(0, e.position.y - m.position.y) : 0, density: glint ? 5 : 0 })
    interval = Math.max(damage.IFRAME_TICKS, damage.ticksToCharge(weapon))
  }
  const radial = e.velocity ? Math.max(0, (e.velocity.x * (m.position.x - e.position.x) + e.velocity.z * (m.position.z - e.position.z)) / Math.max(0.1, Math.hypot(m.position.x - e.position.x, m.position.z - e.position.z)) * 20) : 0
  const arrival = kind === 'projectile' ? distance(e.position, m.position) / ((weapon === 'crossbow' ? damage.CROSSBOW_ARROW_SPEED : 3) * 20) : kind === 'explosion' ? 0 : Math.max(0, distance(e.position, m.position) - 3) / Math.max(5.6, radial)
  return { raw, kind, interval, arrival: Math.ceil(arrival * 20), breach: glint && weapon === 'mace' ? 4 : 0 }
}
// Сколько проживу под этими ударами (без своих ответов), с общим окном неуязвимости: двое синхронных лучников не дают
// двух полных стрел в одно окно. Бой кончился раньше нашей смерти — выживание всё равно меряется, а не берётся формулой
// «хп / сумма урона в секунду» (она складывала синхронные удары, 21.10). null — живу дольше 30 с.
function survivalUnder(incoming: Array<{ raw: number; kind: string; interval: number; arrival: number; breach: number }>, health: number, defense: any): number | null {
  let hp = health, last: any = null
  const next = incoming.map(a => a.arrival)
  for (let tick = 0; tick <= 600; tick++) {
    if (last) last = { ...last, ago: last.ago + 1 }
    for (const [i, a] of incoming.entries()) {
      if (tick < next[i]) continue
      next[i] += a.interval
      const hit = damage.throughIframes(a.raw, last)
      last = hit.last
      hp -= damage.afterDefense(hit.raw, a.kind, defense, { breach: a.breach })
      if (hp <= 0) return tick / 20
    }
  }
  return null
}
// Pure event simulation: full-charge hits, armor/enchantment reduction and the shared 10-tick player hit window.
export function assessSwarmFight(member: SwarmMember, enemies: SharedEnemy[], members: SwarmMember[]): SwarmFightRisk {
  const foe = [...enemies].sort((a, b) => distance(a.position, member.position) - distance(b.position, member.position))[0]
  if (!foe) return { unsafe: false, killSeconds: 0, survivalSeconds: Infinity, damage: 0, ready: 0, contactSlots: 0, enemySharpness: [0, 0], enemyProtection: [0, 0], reason: 'нет видимой угрозы' }
  const incoming = enemies.map(e => ({ enemy: e, ...enemyAttack(e, member) }))
  const defense = ownDefense(member)
  const incomingHits = incoming.map(e => damage.afterDefense(e.raw, e.kind, defense, { breach: e.breach }))
  const incomingDps = Math.min(incoming.reduce((s, e, i) => s + incomingHits[i] * 20 / e.interval, 0), Math.max(...incomingHits) * 20 / damage.IFRAME_TICKS)
  const firstTick = Math.min(...incoming.map(e => e.arrival)), firstArrival = firstTick / 20
  // Смертельный первый удар — только ближний и взрыв: от стрелы бег по открытому не спасает (лучник стреляет в спину),
  // от неё — укрытие и щит (тревога cover, уворот тела).
  let initialHit = 0, closeHit = 0, openingLast: any = null, openingTick = firstTick
  // Simultaneous attackers share the victim's hurt window; later stronger hits only add the raw difference.
  for (const attack of [...incoming].sort((a, b) => a.arrival - b.arrival)) {
    if (attack.arrival >= firstTick + damage.IFRAME_TICKS) break
    if (openingLast) openingLast = { ...openingLast, ago: openingLast.ago + attack.arrival - openingTick }
    const hit = damage.throughIframes(attack.raw, openingLast)
    openingLast = hit.last; openingTick = attack.arrival
    const dealt = damage.afterDefense(hit.raw, attack.kind, defense, { breach: attack.breach })
    initialHit += dealt
    if (attack.kind !== 'projectile') closeHit += dealt
  }
  const exposure = firstArrival + member.health / Math.max(0.1, incomingDps)
  const profiles = members.filter(m => m.team === member.team && m.health > 0).map(m => {
    const profile = combatProfile(m, foe)
    return { ...profile, arrival: Math.ceil(profile.ranged ? distance(m.position, foe.position) / 3 : Math.max(0, distance(m.position, foe.position) - 3) / 5.6 * 20) }
  // Помощник — кто успеет добежать, как и враг: цель на общей доске знает весь рой. Требование «видит сам» оставляло
  // в счёте 2 своих против всех 3–5 врагов арены, и бежали обе команды (арена 14.10: 0 убийств; у Codex — 40 ботов, 6 мин).
  }).filter(a => a.member.id === member.id || a.arrival / 20 <= exposure)
  const mine = profiles.find(a => a.member.id === member.id) || { ...combatProfile(member, foe), arrival: 0 }
  const helpers = profiles.filter(a => a.member.id !== member.id).sort((a, b) => b.hit / b.interval - a.hit / a.interval || a.arrival - b.arrival)
  const melee = [mine, ...helpers.filter(a => !a.ranged)].filter(a => !a.ranged).slice(0, 2)
  const attackers = [...melee, ...[mine, ...helpers].filter(a => a.ranged).slice(0, 2)]
  const actors = attackers.map((a, i) => ({ ...a, hp: a.member.health, next: a.arrival + i * damage.IFRAME_TICKS, last: null as any }))
  const foeDefense = enemyDefense(foe)
  let enemyHp = foe.hpEstimate ?? 20; let foeLast: any = null; let survival = Infinity; let kill = Infinity
  const nextIncoming = incoming.map(a => a.arrival)
  const ticks = 600
  for (let tick = 0; tick <= ticks && enemyHp > 0 && actors.some(a => a.hp > 0); tick++) {
    if (foeLast) foeLast = { ...foeLast, ago: foeLast.ago + 1 }
    for (const a of actors) if (a.last) a.last = { ...a.last, ago: a.last.ago + 1 }
    for (const [i, attack] of incoming.entries()) {
      if (tick < nextIncoming[i]) continue
      nextIncoming[i] += attack.interval
      const focus = actors.find(a => a.member.id === member.id && a.hp > 0) || actors.find(a => a.hp > 0)
      if (!focus) break
      const victims = attack.kind === 'explosion' ? actors.filter(a => a.hp > 0) : [focus]
      for (const victim of victims) {
        const raw = attack.kind === 'explosion' ? enemyAttack(attack.enemy, victim.member).raw : attack.raw
        const hit = damage.throughIframes(raw, victim.last)
        victim.last = hit.last
        victim.hp -= damage.afterDefense(hit.raw, attack.kind, victim.defense, { breach: attack.breach })
        if (victim.member.id === member.id && victim.hp <= 0 && survival === Infinity) survival = tick / 20
      }
    }
    for (const a of actors) {
      if (a.hp <= 0 || tick < a.next) continue
      a.next += a.interval
      const hit = damage.throughIframes(a.raw, foeLast)
      foeLast = hit.last
      enemyHp -= damage.afterDefense(hit.raw, a.kind, foeDefense)
      if (enemyHp <= 0) { kill = tick / 20; break }
    }
  }
  const period = Math.max(...incoming.map(e => e.interval)) / 20
  const nominalDps = Math.max(0.01, ...actors.map(a => a.hit * 20 / a.interval))
  const baseKill = Number.isFinite(kill) ? kill : Math.min(...actors.map(a => a.arrival)) / 20 + (foe.hpEstimate ?? 20) / nominalDps
  const survivalSeconds = Number.isFinite(survival) ? survival : survivalUnder(incoming, member.health, defense) ?? Math.max(30, firstArrival + member.health / Math.max(0.01, incomingDps))
  const localEnemies = incoming.filter(e => e.arrival / 20 <= Math.min(baseKill, survivalSeconds)).length
  const killSeconds = baseKill * Math.max(1, localEnemies / Math.max(1, profiles.length))
  const myActor = actors.find(a => a.member.id === member.id)
  const loss = myActor ? Math.max(0, member.health - Math.max(0, myActor.hp)) : initialHit
  // Зеркально убийству: нас больше — враг бьёт нас по очереди, раненый уходит в середину, его место занимает свежий
  // (арена 14.10: шестеро бежали от одного — «убить 12.6 с, выжить 10.2 с, готово 6, врагов 1»). В счёт — только те,
  // чей удар ранит цель (от полусердца после брони): голые против незерита — не смена, а потери.
  const able = profiles.filter(a => a.hit >= 1).length
  const teamSurvival = survivalSeconds * Math.max(1, able / Math.max(1, localEnemies))
  const lethal = closeHit >= member.health && firstArrival <= killSeconds
  const unsafe = killSeconds > teamSurvival + period || lethal
  const slots = foe.equipment?.armor?.length || 0
  const protectionUpper = (foe.equipment?.enchanted ? slots * 4 : 0) + Math.min(4 - slots, foe.equipment?.unknownArmorSlots || 0) * 4
  const duelKillSeconds = Math.max(0.05, killSeconds - Math.min(...actors.map(a => a.arrival)) / 20)
  const duelSurvivalSeconds = Math.max(0.05, survivalSeconds - firstArrival)
  return { unsafe, lethal, burst: closeHit >= member.health, target: foe.id, killSeconds, survivalSeconds, duelKillSeconds, duelSurvivalSeconds, damage: loss, ready: profiles.length, contactSlots: melee.length, enemySharpness: foe.equipment?.enchanted && sharpWeapon(foe.equipment.weapon) ? [0, 5] : [0, 0], enemyProtection: [0, protectionUpper], reason: `убить≈${killSeconds.toFixed(1)}с, выжить≈${survivalSeconds.toFixed(1)}с, контакт ${melee.length}, готово ${profiles.length}, врагов ${localEnemies}, хп ${Math.round(member.health)}` }
}
export interface SwarmTeamFight { engage: boolean; ourLoss: number; theirLoss: number; wipedUs: boolean; wipedThem: boolean; seconds: number; ours: number; theirs: number }
// Командный счёт боя (14.10): стороны целиком, а не «выживу ли я, если бьют все». Личная оценка (assessSwarmFight) при
// равных силах — монетка: в ничьей бежали обе команды арены (0 убийств; у Codex — 40 ботов, 6 мин). Здесь каждый бьёт
// ближнего живого противника, не больше двух на одного (так рой и делит цели), удар проходит через окно неуязвимости
// цели, удары тика — одновременно (без форы своим), у врага 20 хп (его хп не видно), подход — по расстоянию. Итог за 30
// игровых с — потери сторон в долях бота (погибший — 1, раненый — доля потерянного).
export function assessTeamFight(team: SwarmMember[], enemies: SharedEnemy[]): Omit<SwarmTeamFight, 'engage'> {
  type Strike = { raw: number; kind: string; interval: number; ranged: boolean; breach: number }
  type Unit = { side: 0 | 1; position: SwarmPosition; hp: number; start: number; defense: any; last: any; target: number; next: number; strike: Strike | null; seen: SharedEnemy }
  // Обе стороны — по одному правилу видимого (enemyDefense/enemyAttack): материал брони, оружие в руке, блеск → чары по
  // максимуму. Свои точные чары против «блеск = максимум» у врага давали обеим командам «проигрываем» (арена 14.10:
  // синие 4.0 : 3.1, красные 3.8 : 2.5 в одном и том же бою). Хп: свои — известные, чужие — верх оценки по нашим
  // попаданиям (e.hpEstimate), без оценки — 20: раненые свои против «свежих» чужих снова давали обеим сторонам «проигрываем».
  const seenOf = (m: SwarmMember): SharedEnemy => ({ id: m.id, position: m.position, velocity: { x: 0, y: 0, z: 0 }, sources: [], seenAt: 0,
    threat: /^(bow|crossbow)$/.test(m.weapon || '') ? 'bow' : 'melee',
    equipment: { weapon: m.weapon ?? null, armor: (Array.isArray(m.armor) ? m.armor : Object.values(m.armor || {})).filter(Boolean) as string[], ...(Object.values(m.ench || {}).some(v => Number(v) > 0) ? { enchanted: true } : {}) } } as any)
  const units: Unit[] = [
    ...team.filter(m => m.health > 0).map(m => { const seen = seenOf(m); return { side: 0 as const, position: m.position, hp: m.health, start: m.health, defense: enemyDefense(seen), last: null, target: -1, next: 0, strike: null, seen } }),
    ...enemies.map(e => ({ side: 1 as const, position: e.position, hp: e.hpEstimate ?? 20, start: e.hpEstimate ?? 20, defense: enemyDefense(e), last: null, target: -1, next: 0, strike: null, seen: e }))
  ]
  const strike = (u: Unit, v: Unit): Strike => {
    const a = enemyAttack(u.seen, { position: v.position } as SwarmMember)
    return { raw: a.raw, kind: a.kind, interval: a.interval, ranged: a.kind !== 'melee', breach: a.breach }
  }
  const load = (i: number) => units.filter(w => w.hp > 0 && w.target === i).length
  const aim = (u: Unit, tick: number) => {
    const foes = units.map((v, i) => i).filter(i => units[i].side !== u.side && units[i].hp > 0)
    if (!foes.length) return false
    const i = foes.sort((a, b) => Number(load(a) >= 2) - Number(load(b) >= 2) || distance(u.position, units[a].position) - distance(u.position, units[b].position))[0]
    const d = distance(u.position, units[i].position)
    u.target = i; u.strike = strike(u, units[i])
    u.next = Math.max(u.next, tick + Math.ceil(u.strike.ranged ? d / 3 : Math.max(0, d - 3) / 5.6 * 20))
    return true
  }
  const alive = (side: 0 | 1) => units.some(u => u.side === side && u.hp > 0)
  let tick = 0
  for (; tick <= 600 && alive(0) && alive(1); tick++) {
    for (const u of units) if (u.last) u.last = { ...u.last, ago: u.last.ago + 1 }
    const hits: Array<[Unit, Unit]> = []
    for (const u of units) {
      if (u.hp <= 0 || (u.target < 0 || units[u.target].hp <= 0) && !aim(u, tick) || tick < u.next) continue
      u.next += u.strike!.interval
      hits.push([u, units[u.target]])
    }
    for (const [u, v] of hits) {
      const victims = u.strike!.kind === 'explosion' ? units.filter(w => w.side !== u.side && w.hp > 0 && distance(w.position, v.position) <= 5) : [v]
      for (const w of victims) {
        const hit = damage.throughIframes(u.strike!.kind === 'explosion' ? enemyAttack(u.seen, { position: w.position } as SwarmMember).raw : u.strike!.raw, w.last)
        w.last = hit.last
        w.hp -= damage.afterDefense(hit.raw, u.strike!.kind, w.defense, { breach: u.strike!.breach })
      }
    }
  }
  const loss = (side: 0 | 1) => units.filter(u => u.side === side).reduce((sum, u) => sum + (u.hp <= 0 ? 1 : (u.start - u.hp) / 20), 0)
  return { ourLoss: loss(0), theirLoss: loss(1), wipedUs: !alive(0), wipedThem: !alive(1), seconds: tick / 20, ours: units.filter(u => u.side === 0).length, theirs: enemies.length }
}
// Группа своих вокруг m: связные в link бл. (свой рядом со своим рядом с m). В командной свалке — 16 (TEAM_LINK): с 10 кучки
// по 2–6 сливались и распадались каждые полсекунды, приговор «безнадёжно ↔ держим» мигал вместе с ними (стенд 15×15, 21.10:
// бег ↔ бой 218 раз за раунд). Натиск против людей — прежние 10/12.
export const TEAM_LINK = 16
// Приговор группе (groupVerdict) — вместе со своими, что подойдут за пару секунд (24 бл.): пара в 17–24 бл. от толпы своих
// судилась отдельно, «нас меньше» — шаг к толпе, слилась — бой, и так по кругу (стенд 15×15, 21.10: 12 миганий за 100 с).
// Конец отхода — слияние в TEAM_LINK: начало дальше конца, гистерезис по месту.
export const REINFORCE_LINK = 24
export function groupOf(team: SwarmMember[], m: SwarmMember, link = 10): SwarmMember[] {
  const group = [m]
  for (let grew = true; grew;) { grew = false; for (const a of team) if (!group.includes(a) && group.some(g => distance(g.position, a.position) <= link)) { group.push(a); grew = true } }
  return group
}
// Приговор группы против врагов в 12 бл. от неё (assessTeamFight): futile — пустой размен, больше трёх своих за одного
// врага (десять голых против незерита — тест Codex) или нас выносят, а мы не снимаем с них и четверти (голый одиночка
// против брони); outnumbered — нас выносят, а у них остаётся не меньше тел, чем было нас (один против трёх, трое против
// шести: это не бой роя, а отход к своим). Одна мера для планировщика и для мгновенной паники драйвера.
// radius — Infinity для отхода, начатого от этих врагов (retreat.ts): его повод не зависит от расстояния.
export function groupVerdict(group: SwarmMember[], enemies: SharedEnemy[], radius = 12): { futile: boolean; outnumbered: boolean } {
  const foes = enemies.filter(e => group.some(a => distance(a.position, e.position) <= radius))
  if (!foes.length) return { futile: false, outnumbered: false }
  const score = assessTeamFight(group, foes)
  const futile = score.ourLoss > 3 * Math.max(score.theirLoss, .5) || score.wipedUs && score.theirLoss < score.theirs / 4
  return { futile, outnumbered: !futile && score.wipedUs && score.theirs - score.theirLoss >= Math.max(1, score.ours) }
}
// Политика боя (пользователь 14.10: «рои вырезают друг друга, бой должен кончаться; отступать — тактически и быстро на
// хилку»). Бежит только тот, кого первый залп убьёт; тяжело раненый (меньше 35 % хп — сбегать полечиться и назад); чья
// группа в пустом размене (бежать и из рукопашной: там «любой ценой» значит только потери); чья группа проиграла поле
// (отход к своим, но не из рукопашной — contact, враг ближе 4 бл.: начатая схватка — «любой ценой», её смена на бег
// рвала удары, арена 14.10); одиночка, к которому никто не успеет (ready ≤ 1), если убить врага втрое дольше, чем он
// проживёт. В общем бою личная оценка «бьют все меня» — не повод: на арене так бежали при полном хп 447 раз из 910.
// Натиск (aggressive, соло-арена «люди против роя», пользователь 14.10: «не атакуют, бегают тупо по арене»): против людей
// в незерите любой размен «пустой» и любой удар «залп» — рой бежал 438 раз на 55 боёв. Там бегут только на хилку (< 35 %)
// и только не из схватки: contact здесь — враг в 8 бл. (человек со Скоростью II быстрее спринта бота — бегство из
// рукопашной подставляло спину: «убегать не умеют», 9 из 10 смертей — на бегу или за едой у него под носом).
// Правило — retreat.ts (21.10): в схватке не бегут, кроме раненого, у которого рядом свои.
export function mustFlee(m: SwarmMember, risk: Pick<SwarmFightRisk, 'unsafe' | 'lethal' | 'killSeconds' | 'survivalSeconds' | 'ready'>, contact: boolean, verdict: { futile: boolean; outnumbered: boolean }, aggressive = false, allies = false): boolean {
  return !!retreatWhy(m, risk, { contact, allies, ...verdict, aggressive })
}
