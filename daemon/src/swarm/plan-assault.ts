// Рой (swarm.ts): штурм в плане боя (planPvp) — подтверждение готовыми, исход эпизода, повтор после провала — и итог:
// «проигрываем», отметка безнадёжных, командный счёт для журнала.
import * as damage from '../pvp/damage-model'
import type { SwarmMember, SharedEnemy } from './types'
import type { PvpPlan } from './plan-frame'
import type { AssaultBalance } from './board'
import { distance, ratio, count } from './common'
import { visibleForce, ownDefense, assessTeamFight } from './fight'

function memberEquipment(m: SwarmMember): NonNullable<SharedEnemy['equipment']> {
  const weapon = [m.weapon, ...Object.keys(m.inventory || {}).filter(n => count(m.inventory, n) > 0 && damage.isMeleeWeapon(n))].filter(Boolean)
    .sort((a, b) => damage.attackDamage(b) - damage.attackDamage(a))[0]
  return { weapon, armor: (Array.isArray(m.armor) ? m.armor : Object.values(m.armor || {})).filter(Boolean) as string[] }
}

export function pvpAssault(S: PvpPlan): void {
  const { board, team, state, enemies, aggressive, center, hopeless, weak, outclassed } = S
  // Штурм («красная кнопка», пользователь 14.10: «несколько ботов подтверждают — и все идут мочиться до конца; понимают, что
  // проигрывают, — меняется тактика»). Подтверждают готовые: с оружием и бронёй, хп ≥ 60 %, до цели ≤ 40 бл.; набралось
  // max(4, четверть живых) — штурм до результата; потери без снижения оценки хп — отбой (15.10).
  // Повтор — только с лучшей готовностью против того же проваленного состава, другая цель доступна сразу (15.10).
  const tNow = board.now()
  const assaultFoe = enemies.length ? [...enemies].sort((a, b) => distance(a.position, center) - distance(b.position, center))[0] : null
  const votersFor = (foe: SharedEnemy) => team.filter(m => !weak(m) && !outclassed(m, foe) && ratio(m) >= .6 && distance(m.position, foe.position) <= 40)
  const balanceFor = (foe: SharedEnemy, ready: SwarmMember[]): AssaultBalance => {
    const value = { ready: ready.length, attack: 0, armor: 0, tough: 0, prot: 0, hp: foe.hpEstimate ?? state.failed.get(foe.id)?.hp ?? 20, force: visibleForce(foe), enchanted: !!foe.equipment?.enchanted }
    for (const m of ready) {
      const weapon = memberEquipment(m).weapon, defense = ownDefense(m)
      value.attack += damage.meleeRaw({ weapon, sharpness: m.ench?.sharpness || 0, crit: damage.isMeleeWeapon(weapon) }) * 20 / Math.max(damage.IFRAME_TICKS, damage.ticksToCharge(weapon))
      value.armor += defense.armor; value.tough += defense.tough; value.prot += defense.prot
    }
    return value
  }
  // Повтор и после того, как отошедшие подлечились: все выжившие из проваленного штурма снова с хп ≥ 90 % (пользователь 14.10:
  // «рои добивают друг друга до конца, отходят только ненадолго подлечиться»; стенд 15.10: только «сильнее, чем было» — штурм
  // провален за 16 с, дальше до конца прогона 102 «проигрываем — прячусь»).
  const healed = (old: AssaultBalance) => !!old.voters?.length && old.voters.map(id => team.find(m => m.id === id)).every(m => !m || ratio(m) >= .9)
  const improved = (b: AssaultBalance, old: AssaultBalance) => b.ready > old.ready || b.hp < old.hp || b.force < old.force || old.enchanted && !b.enchanted ||
    b.ready >= old.ready && (b.attack > old.attack || b.armor > old.armor || b.tough > old.tough || b.prot > old.prot) || healed(old)
  let assault = aggressive ? board.assault : null
  if (!aggressive) { board.assault = null; delete state.assault }
  let ended = false
  if (assault && state.assault) {
    const episode = state.assault, foe = enemies.find(e => e.id === assault!.target)
    for (const id of episode.roster) if (!board.alive(id)) episode.lost.add(id)
    const lost = episode.lost.size
    if (foe?.hpEstimate !== undefined) {
      if (foe.hpEstimate < episode.hp) episode.lostAtHit = lost
      episode.hp = foe.hpEstimate
    }
    // Пропажа sightings не доказывает исход; дальнюю цель подтверждает свежий обзор (15.10).
    const outOfReach = foe && tNow - foe.seenAt <= 500 && assault.voters.every(id => !board.alive(id) || distance(team.find(m => m.id === id)!.position, foe.position) > 40)
    // Проигрываем — потери с последнего подтверждённого урона по цели: не меньше трёх и 40 % голосовавших (первая же потеря
    // обрывала штурм за 16 с — стенд 15.10).
    const losing = lost - episode.lostAtHit >= Math.max(3, Math.ceil(assault.voters.length * .4))
    if (losing || outOfReach) {
      board.assaultEnded = { at: tNow, why: losing ? 'проигрываем' : 'вне досягаемости', lost, target: assault.target, seconds: Math.round((tNow - assault.since) / 1000) }
      state.failed.set(assault.target, { ...episode.balance, hp: foe?.hpEstimate ?? episode.hp, voters: assault.voters })
      board.assault = assault = null
      delete state.assault; ended = true
    }
  }
  if (aggressive && !assault) for (const foe of [...enemies].sort((a, b) => distance(a.position, center) - distance(b.position, center))) {
    const ready = votersFor(foe), balance = balanceFor(foe, ready), failed = state.failed.get(foe.id)
    if (ended && board.assaultEnded?.target === foe.id || ready.length < Math.max(4, Math.ceil(team.length / 4)) || failed && !improved(balance, failed)) continue
    board.assault = assault = { since: tNow, target: foe.id, voters: ready.map(m => m.id), startAlive: team.length }
    state.assault = { balance, roster: new Set(team.map(m => m.id)), lost: new Set(), lostAtHit: 0, hp: foe.hpEstimate ?? 20 }
    state.failed.delete(foe.id)
    break
  }
  const regroup = aggressive && !assault && !!assaultFoe && state.failed.has(assaultFoe.id)
  // Проигрываем (пользователь 14.10: «когда понимают, что проигрывают, тупо по карте бегают, хотя могли бы прятаться — капец
  // как легко играть»): штурм провален (перегруппировка) или живых не больше трёх на каждого видимого врага (никого не видно
  // — на одного). Кто не в схватке (враг дальше 6 бл.) и не добивает, — в укрытие (насест на элитрах или место колизея), там
  // на шифте; подошёл ближе — бой, ослаб — ва-банк.
  // Проигрываем — только при видимом враге (Codex 15.10: последние 1–3 без врага прятались, а не лутали).
  const losing = aggressive && !assault && (regroup || enemies.length > 0 && team.length <= 3 * enemies.length)
  // S05: возвращаем 30 с подготовки для проверки регресса на крыше (15.10).
  if (hopeless.size) board.recordFact(team[0].id, board.now(), { id: 'outmatched', kind: 'mark', position: { ...center } }, 30000)
  // Для журнала — счёт всей команды и держит ли бой большинство.
  const score = enemies.length ? assessTeamFight(team, enemies) : null
  board.teamFight = score && { ...score, engage: hopeless.size * 2 < team.length }
  Object.assign(S, { assault, regroup, losing })
}
