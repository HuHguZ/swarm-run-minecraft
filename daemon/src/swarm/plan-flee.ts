// Рой (swarm.ts): план боя (planPvp) — ва-банк и бегство (погоня, паника, перегруппировка), затем раненые и лекари.
import * as damage from '../pvp/damage-model'
import type { SwarmMember } from './types'
import type { PvpPlan } from './plan-frame'
import { markFled } from './board'
import { distance, ratio, count } from './common'
import { assessSwarmFight, mustFlee } from './fight'

export function pvpFlee(S: PvpPlan): void {
  const { board, team, enemies, aggressive, assault, forward, groups, futile, outnumbered, hopeless, put, weak, outclassed, perchFor, rallyFor } = S
  // Ва-банк (пользователь 14.10: «когда мало хп, я начинаю убегать, а они не гонятся добивать — если чувствуют слабость,
  // должны ва-банк идти и добивать»): цель с оценкой хп ≤ 10 (по нашим попаданиям и видимому лечению, не метаданные),
  // виденная за 3 с, — добивание: все, у кого есть оружие, в 32 бл. — прямо на неё; бегства и лечения у них нет, кроме
  // смертельного залпа.
  const prey = aggressive ? enemies.filter(e => (e.hpEstimate ?? 20) <= 10 && board.now() - e.seenAt < 3000).sort((a, b) => (a.hpEstimate ?? 20) - (b.hpEstimate ?? 20))[0] : undefined
  const hunting = (m: SwarmMember) => !!prey && distance(m.position, prey.position) <= 32 && Object.keys(m.inventory || {}).some(n => count(m.inventory, n) > 0 && (damage.isMeleeWeapon(n) || /^(bow|crossbow|trident)$/.test(n)))
  for (const [i, m] of team.entries()) {
    const risk = assessSwarmFight(m, enemies, team)
    if (hunting(m) && !risk.lethal) continue
    // Погоня за слабым или переигранным (стенд rush 15.10: «прячусь» вело в тупик-камеру, он догонял — бой 1–2 удара и смерть):
    // к своим (и слабым — толпа бьёт его со спины) или в отрыв по открытому (smartFlee тела сам обходит тупики); последний
    // бой — только физически зажатым (исполнитель: cornered); оторвался дальше 22 — лут (Codex 15.10).
    const near = aggressive ? [...enemies].sort((a, b) => distance(a.position, m.position) - distance(b.position, m.position))[0] : undefined
    if (near && !weak(m) && outclassed(m, near)) board.recordFact(m.id, board.now(), { id: 'outmatched:' + m.id, kind: 'mark', position: { ...m.position } }, 30000)
    const gap = near ? distance(m.position, near.position) : Infinity
    const v = near?.velocity
    const coming = !!near && board.now() - near.seenAt < 1000 && ((m.position.x - near.position.x) * (v?.x || 0) + (m.position.z - near.position.z) * (v?.z || 0)) / (gap || 1) > .1
    const pursuing = coming || board.tasks().some(t => t.assignedTo === m.id && t.data?.kite && t.data.target === near?.id)
    // Начатая рукопашная не рвётся погоней (в контакте он всегда «идёт на меня»; стенд rush 15.10: fight → flee 66 раз, каждый —
    // stop боя): дерущийся уходит, только когда он дальше 6 бл.
    const prevKind = board.tasks().find(t => t.id === `pvp:${m.id}`)?.kind
    // Лутающий уходит от погони с той же границы 16, что и ветка слабых (Codex 15.10: правило погони с 22 обходило
    // гистерезис 16/22 — «лут ↔ бегство» на 17–22 бл.).
    if (near && gap <= (prevKind === 'loot' ? 16 : 22) && pursuing && !(prevKind === 'fight' && gap <= 6) && (weak(m) || outclassed(m, near))) {
      const perch = perchFor(m), group = !perch && rallyFor(m, near)
      markFled(board, m.id)
      put(m, 'flee', { target: near.id, enemyPosition: near.position, panic: true, ...(perch ? { perch: true } : { kite: true, regroup: !!group }), reason: `ухожу от погони (враг в ${Math.round(gap)} бл.)` }, perch || group || m.position)
      continue
    }
    // S04: возвращаем 3 с паники для проверки регресса на крыше (15.10).
    if (!assault && mustFlee(m, risk, enemies.some(e => distance(e.position, m.position) <= (aggressive ? 8 : 4)), { futile: futile.has(m.id), outnumbered: outnumbered.has(m.id) }, aggressive)) board.recordFact(m.id, board.now(), { id: 'panic:' + m.id, kind: 'mark', position: { ...m.position } }, 3000)
    else if (assault || !board.facts().some(f => f.id === 'panic:' + m.id)) continue
    const threat = enemies.find(e => e.id === risk.target) || [...enemies].sort((a, b) => distance(a.position, m.position) - distance(b.position, m.position))[0]
    if (!threat) continue
    let dx = m.position.x - threat.position.x; let dz = m.position.z - threat.position.z
    if (Math.hypot(dx, dz) < 0.1) { dx = -forward.x; dz = -forward.z }
    const length = Math.hypot(dx, dz) || 1
    const turn = (i - (team.length - 1) / 2) / Math.max(1, team.length) * Math.PI * 0.75
    const x = (dx * Math.cos(turn) - dz * Math.sin(turn)) / length
    const z = (dx * Math.sin(turn) + dz * Math.cos(turn)) / length
    // Перегруппировка: целый, но в безнадёжной местной схватке — бежать к своим, к середине самой большой группы, что не
    // в безнадёжной схватке, а не куда глаза глядят: так группа растёт и бой продолжается (арена 14.10: отход «прочь от
    // угрозы» рассыпал строй, и вместо сбора было 300 бегств при полном хп). Раненый и смертельный залп — прочь, как прежде.
    const home = !risk.lethal && ratio(m) >= .35 ? groups.filter(g => !g.includes(m) && !g.some(a => hopeless.has(a.id))).sort((p, q) => q.length - p.length)[0] : undefined
    const away = { x: m.position.x + x * 12, y: m.position.y, z: m.position.z + z * 12 }
    // Причина бегства — в журнал драйвера (какое условие mustFlee сработало; «держу» — липкая паника без свежего повода).
    const contact = enemies.some(e => distance(e.position, m.position) <= 4)
    const cause = risk.lethal ? 'залп' : !risk.unsafe ? 'держу' : ratio(m) < .35 ? 'рана' : futile.has(m.id) ? 'пустой размен' : !contact && outnumbered.has(m.id) ? 'нас меньше' : risk.ready <= 1 && risk.killSeconds > 3 * Math.max(1, risk.survivalSeconds) ? 'один' : 'держу'
    const perch = perchFor(m)
    put(m, 'flee', { target: threat.id, enemyPosition: threat.position, panic: true, risk, reason: cause + ', ' + risk.reason, ...(perch ? { perch: true } : home ? { regroup: true } : {}) },
      perch ?? (home ? { x: home.reduce((sum, a) => sum + a.position.x, 0) / home.length, y: m.position.y, z: home.reduce((sum, a) => sum + a.position.z, 0) / home.length } : away))
  }
  Object.assign(S, { prey, hunting })
}

export function pvpRecover(S: PvpPlan): void {
  const { team, plan, enemies, aggressive, assault, doctrine, center, forward, hunting, put } = S
  const hurt = team.filter(m => {
    if (plan.has(m.id)) return false
    // Натиск: у врага под носом не есть и не отходить — добьёт в спину; лечиться — оторвавшись (дальше 8 бл.).
    if (aggressive && (assault || hunting(m) || enemies.some(e => distance(e.position, m.position) <= 8))) return false
    // Врагов не видно — отход только от настоящей раны (< 70 %): царапина от падения не срывает лут (ревью 13.10).
    if (!enemies.length) return ratio(m) < .7
    const nearby = enemies.filter(e => distance(m.position, e.position) < 12).length
    // Кольцо и «стадо» для того и строятся, чтобы раненый ушёл в середину, — там прежний счёт (с 62–70 %).
    if (doctrine === 'ring' || doctrine === 'weak-center') return (1 - ratio(m)) * (8 + nearby * 2) - ratio(m) * 2 > ratio(m) * 4
    // В остальном бою — на хилку с половины хп (больше врагов рядом — чуть раньше, до 60 %), и сразу назад: с 62–70 % бой
    // распадался на отходы (пользователь 14.10: «отступать тактически на хилку быстро»).
    return ratio(m) < .45 + .05 * Math.min(3, nearby)
  }).sort((a, b) => ratio(a) - ratio(b))
  for (const [i, m] of hurt.entries()) {
    const side = (i - (hurt.length - 1) / 2) * 1.5
    // В кольце раненый — в самой середине, за щитами; иначе — за спинами своих.
    const back = doctrine === 'ring' ? 0 : 2
    put(m, 'recover', { ally: m.id }, { x: center.x - forward.x * back - forward.z * side, y: m.position.y, z: center.z - forward.z * back + forward.x * side })
  }
  const healing = new Set<string>()
  for (const healer of team.filter(m => m.role === 'healer' && m.canHeal && !plan.has(m.id))) {
    const ally = team.filter(m => m.id !== healer.id && ratio(m) < 1 && !healing.has(m.id)).sort((a, b) => (1 - ratio(b)) * 20 - distance(healer.position, b.position) - ((1 - ratio(a)) * 20 - distance(healer.position, a.position)))[0]
    if (ally && (1 - ratio(ally)) * 20 > distance(healer.position, ally.position) * 0.3) { healing.add(ally.id); put(healer, 'heal', { ally: ally.id }, ally.position) }
  }
  S.hurt = hurt
}
