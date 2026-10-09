'use strict'
// Бой против толпы (дезматч, 09.10): кого бить, когда противников много. Приёмы людей в массовом PvP (FFA, «голодные
// игры»): «третий лишний» — бить того, кто занят другим; «стервятник» — добивать только что раненого на глазах; «враг
// моего врага» — не трогать того, кто бьёт мою же цель, пока она жива (стихийный союз на двоих); не лезть в кучу —
// вокруг цели много чужих, там съедят самого; кто идёт прямо на меня — ответить. Вес приёмов — нрав бота, отсюда
// разные почерки в одной толпе.
//
// Только видимое человеку: позиции и ход (глаза), «ранен только что» — вспышка удара, не хп. Точного хп чужих нет.

type V = { x: number; y: number; z: number }
export type Body = { name: string; p: V; v?: V; hurtAgo?: number }
export type Weights = { dist: number; third: number; vulture: number; crowd: number; threat: number; truce: number; stick: number }

export const PERSONAS: Record<string, Weights> = {
  // Лезет в драку: ближний, раненый, кто идёт на него.
  'задира': { dist: 0.35, third: 3, vulture: 5, crowd: 0.5, threat: 4, truce: 3, stick: 3 },
  // Ждёт, пока двое сцепятся, и бьёт занятого; союзы держит.
  'хитрец': { dist: 0.25, third: 8, vulture: 6, crowd: 1.5, threat: 2, truce: 9, stick: 2 },
  // Выживает: одиночки подальше от кучи.
  'тихоня': { dist: 0.3, third: 4, vulture: 3, crowd: 4, threat: 3, truce: 6, stick: 4 }
}

const d3 = (a: V, b: V) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const ENGAGED = 5 // бл.: двое ближе — сцепились
const CROWD = 7 // бл.: «куча» вокруг цели
// Дезматч 10.10 (750 TPS): ранены почти все и всегда — окно 3 с делало «стервятника» шумом (42 из 76 выборов).
const HURT_MS = 1000

// a сцепился с g: вплотную или летит/бежит на него (на элитрах заход с 10–17 бл. — дистанция сцепки не видит,
// дезматч 10.10: «третий лишний» 4 из 76, союзов 0).
export function aimingAt (a: Body, g: Body): boolean {
  const d = d3(a.p, g.p)
  if (d < ENGAGED) return true
  if (!a.v || d > 25) return false
  const sp = Math.hypot(a.v.x, a.v.y, a.v.z)
  if (sp < 0.2) return false
  return (a.v.x * (g.p.x - a.p.x) + a.v.y * (g.p.y - a.p.y) + a.v.z * (g.p.z - a.p.z)) / (sp * d) > 0.7
}
// На кого из bodies (кроме skip) он нацелен — ближайший из тех, на кого летит.
function engagedWith (a: Body, bodies: Body[], skip: string[]) {
  return bodies.filter(b => b.name !== a.name && !skip.includes(b.name) && aimingAt(a, b)).sort((x, y) => d3(a.p, x.p) - d3(a.p, y.p))[0] || null
}

type Scored = { target: string; score: number; why: string[] }
// Все противники с очками и причинами. others — кто ещё на поле (союзники в командном бою): «занят» — и ими тоже.
// blast — бой взрывами (кристаллы): куча вокруг цели — не риск, а добыча (один взрыв бьёт всех).
function scoreTargets (me: Body, foes: Body[], { persona = 'задира', current = null as string | null, others = [] as Body[], blast = false } = {}): Scored[] {
  const w = PERSONAS[persona] || PERSONAS['задира']
  const cur = current ? foes.find(f => f.name === current) : null
  const all = [me, ...foes, ...others]
  const out: Scored[] = []
  for (const f of foes) {
    const d = d3(me.p, f.p)
    let s = 10 - d * w.dist
    const why: string[] = []
    // Занят другим (летит не на меня, а на него): ко мне спиной.
    const n = !aimingAt(f, me) ? engagedWith(f, all, [me.name]) : null
    if (n) { s += w.third; why.push('занят ' + n.name) }
    if ((f.hurtAgo ?? Infinity) < HURT_MS) { s += w.vulture; why.push('только что ранен') }
    // Каждый чужой рядом с ним — риск стать третьим лишним самому (куча из троих — не «занят», а ловушка).
    const crowd = foes.filter(o => o !== f && d3(o.p, f.p) < CROWD).length
    if (crowd > 0 && blast) { s += crowd * 2.5; why.push('кучей: ' + (crowd + 1) + ' под взрыв') } else if (crowd > 0) { s -= crowd * w.crowd; if (crowd > 1) why.push('вокруг него ' + crowd) }
    if (f.v) {
      const tx = me.p.x - f.p.x; const tz = me.p.z - f.p.z; const h = Math.hypot(tx, tz) || 1
      const toward = (f.v.x * tx + f.v.z * tz) / h
      if (toward > 0.15 && d < 14) { s += w.threat; why.push('идёт на меня') }
    }
    // Бьёт мою цель (и не меня) — пока она жива, союзник.
    if (cur && f !== cur && aimingAt(f, cur) && !aimingAt(f, me)) { s -= w.truce; why.push('союзник против ' + cur.name) }
    if (f === cur) s += w.stick
    out.push({ target: f.name, score: s, why })
  }
  return out
}
const r1 = (x: number) => Math.round(x * 10) / 10

// me — я; foes — живые видимые противники; current — моя цель сейчас (или null). → { target, why, score } или null.
export function chooseTarget (me: Body, foes: Body[], { persona = 'задира', current = null as string | null } = {}) {
  const all = scoreTargets(me, foes, { persona, current })
  if (!all.length) return null
  const best = all.reduce((a, b) => b.score > a.score ? b : a)
  return { target: best.target, score: r1(best.score), why: best.why.join(', ') || 'ближе всех' }
}

// Окружён: двое и больше ближе 8 бл. идут на меня — повод уйти в воздух/в сторону, а не стоять в размене.
export function outnumbered (me: Body, foes: Body[]) {
  return foes.filter(f => {
    if (d3(me.p, f.p) > 8 || !f.v) return false
    const tx = me.p.x - f.p.x; const tz = me.p.z - f.p.z; const h = Math.hypot(tx, tz) || 1
    return (f.v.x * tx + f.v.z * tz) / h > 0.1
  }).length >= 2
}

// ---------------------------------------------------------------- командный бой
// Приёмы командного PvP (UHC/HCF, BedWars): фокус — бить ту же цель, что союзники (урон складывается, цель падает
// раньше); прикрытие (peel) — первым того, кто бьёт раненого союзника; перевес — где наших рядом больше; держаться
// вместе — не гнаться за врагом прочь от своих. Хп союзников известно (свои говорят в чате); хп врагов — нет.
export type Ally = Body & { hp?: number; target?: string | null }
const TEAM = { focus: 3, peel: 7, numbers: 1.5, spread: 0.35, disrupt: 4 }
// hotspots — точки чужого сбора на хилку (видно: враги сбегаются к одному): кто в 6 бл. от неё — сорвать лечение.
// Роль в команде (командный PvP): танк — держит фронт (враги у своих); лекарь — сзади, не гонится; стрелок — по
// сцепившимся со своими; фланг — по оторвавшимся от своих (тыл, лекари). relieve — врагов раненых своих, которых
// я подменяю (ротация: раненый уходит к лекарю, его врага берёт здоровый).
export function chooseTeamTarget (me: Body, allies: Ally[], enemies: Body[], { persona = 'задира', current = null as string | null, hotspots = [] as V[], blast = false, role = '' as string, relieve = [] as string[] } = {}) {
  if (!enemies.length) return null
  const base = scoreTargets(me, enemies, { persona, current, others: allies, blast })
  const team = [me, ...allies]
  const cx = team.reduce((a, b) => a + b.p.x, 0) / team.length
  const cz = team.reduce((a, b) => a + b.p.z, 0) / team.length
  let best: any = null
  for (const o of base) {
    const f = enemies.find(e => e.name === o.target)!
    let s = o.score
    const why = [...o.why]
    const focus = allies.filter(a => a.target === f.name).length
    if (focus) { s += TEAM.focus * focus; why.push('фокус ×' + (focus + 1)) }
    const hurtAlly = allies.find(a => (a.hp ?? 20) <= 10 && aimingAt(f, a))
    if (hurtAlly) { s += TEAM.peel; why.push('прикрываю ' + hurtAlly.name) }
    const ours = allies.filter(a => d3(a.p, f.p) < 8).length + (d3(me.p, f.p) < 8 ? 1 : 0)
    const theirs = enemies.filter(e => e !== f && d3(e.p, f.p) < 8).length + 1
    if (ours !== theirs) { s += (ours - theirs) * TEAM.numbers; if (ours > theirs) why.push('перевес ' + ours + ':' + theirs) }
    // 16 бл. от центра своих (12 на поле R24 штрафовал 197 из 300 выборов, показ 10.10).
    if (hotspots.some(h => d3(h, f.p) < 6)) { s += TEAM.disrupt; why.push('мешаю хилке') }
    if (relieve.includes(f.name)) { s += 6; why.push('подменяю своего') }
    const nearOurs = allies.some(a => d3(a.p, f.p) < 6)
    if (role === 'танк' && Math.hypot(f.p.x - cx, f.p.z - cz) < 10) { s += 3; why.push('держу фронт') }
    if (role === 'лекарь' && !nearOurs && d3(me.p, f.p) > 6) { s -= 5; why.push('лекарь не гонится') }
    if (role === 'стрелок' && allies.some(a => aimingAt(f, a) || aimingAt(a, f))) { s += 2.5; why.push('стрелок по сцепке') }
    if (role === 'фланг') {
      const ex = enemies.reduce((a, e) => a + e.p.x, 0) / enemies.length; const ez = enemies.reduce((a, e) => a + e.p.z, 0) / enemies.length
      const off = Math.hypot(f.p.x - ex, f.p.z - ez)
      if (off > 6) { s += Math.min(5, (off - 6) * 0.5); why.push('фланг: оторвался от своих') }
    }
    const far = Math.hypot(f.p.x - cx, f.p.z - cz) - 16
    if (far > 0) { s -= far * TEAM.spread; why.push('далеко от своих') }
    if (!best || s > best.score) best = { target: f.name, score: r1(s), why: why.join(', ') || 'ближе всех' }
  }
  return best
}
// Кого лечить: союзник ≤ 12 хп в 5 бл., без лекаря (healers — кого уже лечат). Самый раненый первым.
export function healTarget (me: Body, allies: Ally[], healers: Set<string> = new Set()) {
  return allies.filter(a => (a.hp ?? 20) > 0 && (a.hp ?? 20) <= 12 && d3(me.p, a.p) <= 5 && !healers.has(a.name))
    .sort((a, b) => (a.hp ?? 20) - (b.hp ?? 20))[0] || null
}

// Куда бросить взрывное зелье лечения, чтобы вылечить больше: всплеск 4 бл., сила 1 − d/4 (PotionEntity.applySplash,
// 1.21: квадрат расстояния < 16, множитель 1 − √d²/4). Лечение II — 8 хп; польза союзнику — не больше его недостачи;
// враг в всплеске — минус (лечу его). Точки — раненые (с собой) и середины пар; бросок с ≤ 5 бл. Пусто — польза < 4 хп.
export function healPlan (me: Ally, allies: Ally[], enemies: Body[] = [], { heal = 8, reach = 5, minValue = 4 } = {}) {
  const team = [me, ...allies].filter(a => (a.hp ?? 20) > 0)
  const hurt = team.filter(a => (a.hp ?? 20) <= 16)
  if (!hurt.length) return null
  const pts: V[] = hurt.map(a => a.p)
  for (let i = 0; i < hurt.length; i++) for (let j = i + 1; j < hurt.length; j++) if (d3(hurt[i].p, hurt[j].p) < 6) pts.push({ x: (hurt[i].p.x + hurt[j].p.x) / 2, y: Math.min(hurt[i].p.y, hurt[j].p.y), z: (hurt[i].p.z + hurt[j].p.z) / 2 })
  let best: any = null
  for (const at of pts) {
    if (d3(me.p, at) > reach) continue
    let value = 0; const who: string[] = []
    for (const a of team) {
      const d = d3(a.p, at); if (d >= 4) continue
      const got = Math.min(20 - (a.hp ?? 20), heal * (1 - d / 4))
      if (got > 0.5) { value += got; who.push(a.name) }
    }
    for (const e of enemies) { const d = d3(e.p, at); if (d < 4) value -= heal * (1 - d / 4) * 0.5 }
    if (!best || value > best.value) best = { at, value: r1(value), allies: who }
  }
  return best && best.value >= minValue ? best : null
}

// Роли команды по снаряжению: лекарь — больше зелий, стрелок — лук/арбалет (до двух), танк — лучшая броня (до двух),
// остальные — фланг. bodies: { name, inv, armor } (armor — надетое по слотам).
export function assignRoles (members: any[], tierOf: (n: string) => number) {
  const out: Record<string, string> = {}
  const left = [...members]
  const take = (pick: any, role: string) => { if (!pick) return; out[pick.name] = role; left.splice(left.indexOf(pick), 1) }
  const pots = (m: any) => (m.inv || {}).splash_potion || 0
  take(left.filter(m => pots(m) > 0).sort((a, b) => pots(b) - pots(a))[0], 'лекарь')
  for (let k = 0; k < 2; k++) take(left.find(m => Object.keys(m.inv || {}).some(n => /^(bow|crossbow)$/.test(n))), 'стрелок')
  const armorScore = (m: any) => Object.values(m.armor || {}).reduce((a: number, n: any) => a + (n ? tierOf(n) + 1 : 0), 0)
  for (let k = 0; k < 2; k++) take(left.sort((a, b) => (armorScore(b) as number) - (armorScore(a) as number))[0], 'танк')
  for (const m of left) out[m.name] = 'фланг'
  return out
}
// Командное решение «отходим/держимся» по видимым силам: свои — точное хп (свои говорят), их — 15 на каждого видимого
// (точного хп врага нет). Отход — если мы заметно слабее; гистерезис — держит вызывающий (срок, пауза).
// gear — множитель силы по видимому снаряжению (броня, оружие в руке), 1 — без него. Гонка 10.10: числом команды
// всегда равны (возрождение у своих) — отход по счёту не случался ни разу при 121:65; сила — хп × снаряжение.
export function teamForce (allies: (Ally & { gear?: number })[], enemiesSeen: (Body & { gear?: number })[]) {
  const ours = allies.reduce((a, m) => a + Math.max(0, m.hp ?? 20) * (m.gear ?? 1), 0)
  const theirs = enemiesSeen.reduce((a, e) => a + 15 * (e.gear ?? 1), 0)
  return { ours, theirs, retreat: enemiesSeen.length > 0 && ours < theirs * 0.6, push: ours >= theirs * 0.9 }
}
