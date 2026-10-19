'use strict'
// Арена (часть arena.ts): судейство раунда — смерть и обрыв связи по ответу боя, смерти по логу сервера слота, где боец
// (на поле, выпал, за стеной), пределы раунда (застой, время, возвращение), темп сервера, строка итога и счёт.
import * as fs from 'fs'
import { NA, NB, X, Y, Z } from './config'
import { COLOS, CLEAN_R, CEIL, CEIL_H } from './build'

// Смерть бойца. Флаг died pvp выставить не успевает: сессия рвёт интент по
// событию death раньше, и бой приходит «прерван» (2026-09-25 бота убили,
// он возродился у спавна, а арена гоняла его в бой дальше). Вторая примета —
// он внизу или далеко в стороне от коробки: возродился или выпал за стену.
const diedIn = r => !!(r && ((r.detail && r.detail.died) || (r.status === 'interrupted' && r.by && r.by.type === 'death')))
const lostLink = r => !!(r && r.status === 'interrupted' && r.by && /kicked|disconnected/.test(r.by.type))
// Смерть за раунд — по журналу демона (lastDeathAt): на 750 TPS бот с
// do_immediate_respawn возрождается раньше, чем арена спросит хп, и на точке
// возрождения у арены выглядел живым — смерть шла в «ничью» (s7 06.10).
const deathBase = new Map()
// Смерти раунда — по логу сервера слота (ND_SERVER_LOG), строго от байта начала раунда до его конца (S7d 08.10:
// xsum сопоставлял смерти окном 15 с реального времени и на 750 TPS путал раунды). Причина: foe — сообщение
// называет соперника; self — своё имя (свой кристалл/стрела); crash — элитры о стену («kinetic energy») или падение
// без соперника в сообщении; blast — взрыв ни на кого (якорь: «Intentional Game Design»); other.
const SERVER_LOG = process.env.ND_SERVER_LOG || null
const logSize = () => { try { return SERVER_LOG ? fs.statSync(SERVER_LOG).size : null } catch { return null } }
const DEATH_RE = /^(was |died|blew|hit the ground|fell |experienced|went |burned|tried to swim|drowned|walked into|withered|froze|starved|suffocated|discovered|didn't)/
// Имя — целым словом: «NeuroFarm30» входит в «NeuroFarm30b» (первая версия считала самоподрыв 30b ударом 30).
const named = (msg, n) => (' ' + msg + ' ').includes(' ' + n + ' ')
function deathKind (msg, who, foes) {
  if (/kinetic energy/.test(msg)) return 'crash'
  const by = foes.find(f => named(msg, f))
  if (/Intentional Game Design/.test(msg)) return 'blast'
  if (by && !/while trying to escape|whilst trying to escape/.test(msg)) return 'foe'
  if (named(msg, who)) return 'self'
  if (/fell|hit the ground|doomed to fall/.test(msg)) return by ? 'fall-escape' : 'crash'
  if (by) return 'foe'
  return 'other'
}
function roundDeaths (from, names) {
  if (from == null || !SERVER_LOG) return null
  try {
    const size = fs.statSync(SERVER_LOG).size
    const start = size < from ? 0 : from // лог перевернулся — с начала нового
    const fd = fs.openSync(SERVER_LOG, 'r')
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)
    const out = []
    for (const line of buf.toString('utf8').split(/\r?\n/)) {
      const m = /^\[(\d\d:\d\d:\d\d)\] \[Server thread\/INFO\]: (\S+) (.+)$/.exec(line)
      if (!m || !names.includes(m[2]) || !DEATH_RE.test(m[3])) continue
      out.push({ t: m[1], who: m[2], msg: m[3], kind: deathKind(m[3], m[2], names.filter(n => n !== m[2])) })
    }
    return out
  } catch { return null }
}
async function where (c, out: any = {} as Record<string, any>) {
  const st = await c.call('status', { physics: true }).catch(() => null)
  if (!st || !st.state || st.state.connected === false) return null
  out.hp = st.state.health
  if (deathBase.has(c) && (st.state.lastDeathAt || null) !== deathBase.get(c)) return 'dead'
  if (!(st.state.health > 0)) return 'dead'
  // The floored header hides the exterior strip (626.6 becomes 626 at R24).
  const p = st.detail?.physics?.pos || st.state.pos
  // Колизей: за барьером поля (хорус переносит сквозь стену) или на потолке —
  // обратно не попасть, это не «выпал и лезет назад»: gone, вылет через GONE_MS.
  if (COLOS && p && p.y >= Y - 2 && (Math.abs(p.x - (X + 0.5)) > CLEAN_R + 1.5 || Math.abs(p.z - (Z + 0.5)) > CLEAN_R + 1.5 || (CEIL && p.y > Y + CEIL_H + 0.5))) return 'gone'
  return p && (p.y < Y - 8 || Math.abs(p.x - X) > CLEAN_R + 16 || Math.abs(p.z - Z) > CLEAN_R + 16) ? 'out' : 'in'
}

// Застой: боты встали друг против друга и минутами не бьют (прогон темпа
// 2026-09-26: 4.8 блока, разная высота, больше 10 минут без удара). Без
// таймера такой раунд не кончится — ARENA_STALL_S секунд без урона у обоих
// = ничья. Против людей не действует: человек сам решает, когда прятаться.
const STALL_MS = Number(process.env.ARENA_STALL_S ?? 120) * 1000
// Предел раунда: обычный бой кончается за 1-5 минут, а застрявший (оба внизу
// под ареной, урон от огня сбивает счётчик застоя) шёл 14 минут. ARENA_MAX_S
// секунд — и ничья; 0 — без предела.
const MAX_MS = Number(process.env.ARENA_MAX_S ?? 420) * 1000

// Выпавший живым — ещё не проигравший: пользователь хочет, чтобы бот
// строился обратно наверх и продолжал бой (2026-09-25: «смотрит наверх на
// противника и не понимает, что между ними огромная высота»). На возвращение —
// ARENA_RETURN_S секунд, потом это вылет с ринга и поражение.
const RETURN_MS = Number(process.env.ARENA_RETURN_S || 45) * 1000
// За стеной Колизея (where → gone) вернуться нельзя — ждать RETURN_S незачем.
const GONE_MS = Number(process.env.ARENA_GONE_S || 10) * 1000
// Темп сервера: подготовка раунда и бой (ферма, s7 06.10). Пусто — не трогать.
const PREP_RATE = Number(process.env.ARENA_PREP_RATE || 0) || null
const FIGHT_RATE = Number(process.env.ARENA_FIGHT_RATE || 0) || null

function short (r) {
  if (!r) return 'нет ответа'
  const d = r.detail || {} as Record<string, any>
  const bits = [r.status]
  if (d.killed) bits.push(`УБИЛ ${d.killed}`)
  if (d.died) bits.push(d.ringout ? 'вылетел с ринга' : 'погиб')
  if (d.retreated) bits.push(`отступил (${d.mode || ''})`)
  if (d.timeout) bits.push('время вышло')
  if (d.lost) bits.push(d.lost)
  if (r.error) bits.push(r.error)
  bits.push(`хп ${d.hp || '?'}`, `удары ${d.swings ?? '?'}/${d.landed ?? '?'}`, `криты ${d.crits ?? 0}`, `спринт ${d.sprintHits ?? 0}`)
  if (d.arrows) bits.push(`стрел ${d.arrows}, попали ${d.arrowHits ?? '?'}`)
  if (d.blocks) bits.push(`блоков поставил ${d.blocks}`)
  if (d.dodges) bits.push(`уклонов ${d.dodges}`)
  if (d.axeOnShield) bits.push(`топор по щиту ${d.axeOnShield}`)
  // Булава и заряды ветра (mace.js): взлёты и высота, удары с падения и урон,
  // толчки и сбросы, угрозы булавой и ответ на них.
  const m = d.mace
  if (m) bits.push('булава: ' + [m.launches && `взлётов ${m.launched || 0}/${m.launches}, вершина ~${m.peak ?? '?'} бл.`, (m.smashes || m.fallSmash) && `ударов с падения ${m.smashHits || 0} из ${(m.smashes || 0) + (m.fallSmash || 0)}${m.dealt ? ` (снял ${m.dealt.join(', ')})` : ''}`, m.selfDmg && `себе −${m.selfDmg}`, m.pushes && `заряд в него ${m.pushes} (${Object.entries<any>(m.pushWhy || {} as Record<string, any>).map(([k, v]: any) => `${k}×${v}`).join(', ')}), попал ${m.pushHits || 0}, сбросил ${m.knockoffs || 0}`, m.threats && `булава сверху ×${m.threats}: щит ${m.shieldUps || 0}, уклон ${m.dodges || 0}, в ответ ${m.counterHits || 0}, получил ${m.threatHp || 0}`, m.mlg && `заряд под ноги ${m.mlg}`, m.retries && `второй заряд стоя ${m.retries}`, (m.burnDodge || m.burnNoWay) && `посадка в огонь: увёл ${m.burnDodge || 0}, не смог ${m.burnNoWay || 0}`].filter(Boolean).join('; '))
  // Элитры (elytra.js) и «динамит» (boom.js), 2026-09-26: взлёты, уходы с
  // лечением, пике; мины, взрывы, урон ему и себе, выбитые блоки (дыры).
  const el = d.elytra
  if (el) bits.push('элитры: ' + [el.takeoffs && `взлётов ${el.takeoffs}, ракет ${el.rockets || 0}`, el.escapes && `уходов ${el.escapes} (${el.escapeS} с, хп +${el.escapeHp || 0}, в воздухе −${el.hurtAir || 0})`, el.dives && `пике ${el.diveHits || 0}/${el.dives}${el.diveDealt ? ` (снял ${el.diveDealt.join(', ')})` : ''}${el.diveSelf ? `, себе −${el.diveSelf}` : ''}`, el.landDmg && `посадки −${el.landDmg}`, el.foe && `он летал ${el.foe.airS || 0} с, стрел по нему ${el.foe.shots || 0}/${el.foe.hits || 0}, щит к пике ${el.foe.shieldUps || 0}, уклон ${el.foe.dodges || 0}`].filter(Boolean).join('; '))
  const bo = d.boom
  if (bo) bits.push('взрывчатка: ' + [bo.placed && `поставил ${Object.entries<any>(bo.placed).map(([k, v]: any) => `${k}×${v}`).join(', ')}`, bo.shots && `взорвал ${bo.shots}`, bo.dealt && `ему ${bo.dealt.join(', ')}`, bo.self && `себе −${bo.self}`, bo.kills && `убил ${bo.kills}`, bo.defuse && `разобрал его ${bo.defuse}`, bo.counter && `его взрывчатку — в него ${bo.counter}`, bo.dodges && `уходил ${bo.dodges}`, bo.broken && `выбито блоков ${bo.broken} (светокамня ${bo.holes || 0})`].filter(Boolean).join('; '))
  // Кристаллы (crystal.js, 2026-09-30): поставил, подрыв рукой/стрелой, заранее;
  // взрывы свои/его, урон ему и себе, «попы»; обсидиан вокруг ног, сбил его,
  // уходы; сквозь стену (должно быть 0).
  const cr = d.crystal
  if (cr) bits.push('кристаллы: ' + [`поставил ${cr.placed || 0}, рукой ${cr.hits || 0}, стрелой ${cr.shots || 0}${cr.pre ? `, заранее ${cr.pre}` : ''}`, `взрывов ${cr.booms || 0} (моих ${cr.mine || 0}, его ${cr.his || 0})`, cr.dealt && `ему ${cr.dealt.join(', ')}`, cr.self && `себе −${cr.self}`, (cr.popsDealt || cr.hisPops) && `его тотемы ${cr.hisPops || 0} (от моих ${cr.popsDealt || 0})`, (cr.popsTaken || cr.myPops) && `мои тотемы ${cr.myPops || 0} (от его ${cr.popsTaken || 0})`, cr.selfPops && `САМОПОДРЫВ ${cr.selfPops}`, cr.surround && `обсидиан у ног ${cr.surround} (${cr.surroundBlocks} бл.)`, (cr.defuse || cr.free) && `сбил его ${cr.defuse || 0}, в своё окно ${cr.free || 0}`, cr.dodges && `уходил ${cr.dodges}`, cr.mends && `чинил броню опытом ${cr.mends} (бутылок ${cr.bottles || 0}, прочности +${cr.repaired || 0})`, (cr.anchors || cr.anchorSeen) && `якорей поставил ${cr.anchors || 0}, подорвал ${cr.anchorBooms || 0}, взрывов якорей ${cr.anchorSeen || 0}`, (cr.wallPlace || cr.wallHit) && `СКВОЗЬ СТЕНУ: ставил ${cr.wallPlace || 0}, бил ${cr.wallHit || 0}`].filter(Boolean).join('; '))
  // Ближний бой по звукам сервера (melee.js, 2026-09-26): спринт-удары и криты
  // (правда сервера), выбор, серии, W/S-tap, отброс с jump-reset и без, свапы,
  // щитом погашено; тотем; замедление с предметом в руке.
  const ml = d.melee
  if (ml) bits.push('ближний (звуки сервера): ' + [`махов ${ml.swings}, спринт-ударов ${ml.sprintHits} (пыток ${ml.sprintTries}), критов ${ml.crits}`, ml.choice && `выбор ${Object.entries<any>(ml.choice).map(([k, v]: any) => `${k}×${v}`).join(' ')}`, ml.critConv && `крит из выбора ${ml.critConv.hits}/${ml.critConv.tries}${ml.critConv.miss ? ' (мимо: ' + Object.entries<any>(ml.critConv.miss).map(([k, v]: any) => `${k}×${v}`).join(', ') + ')' : ''}`, ml.combo &&`серии max ${ml.combo.max}, ср ${ml.combo.avg}`, (ml.wtaps || ml.staps || ml.rearms) && `W-tap ${ml.wtaps || 0}, S-tap ${ml.staps || 0}, перевзвод ${ml.rearms || 0}`, ml.slow06 && `×0.6 себе ${ml.slow06}`, ml.sprintCrit && `спринт-крит ${ml.sprintCrit}`, ml.knocks && `отброс: получил ${ml.knocks}, jump-reset ${ml.jumpResets || 0}, ответный ${ml.counterHits || 0}, путь ${ml.kbPlain ?? '-'} / с прыжком ${ml.kbReset ?? '-'}`, ml.swaps && `свап на топор ${ml.swaps}, щит выбит ${ml.shieldBreaks || 0}`, ml.shieldBlocks && `щитом погасил ${ml.shieldBlocks}`, ml.his && `у него спринт ${ml.his.sprintHits}, криты ${ml.his.crits}`].filter(Boolean).join('; '))
  // Щит (combat.makeShield): погашенные — по звуку item.shield.block с поправкой
  // номера (melee.soundName, 2026-09-26); сверять с «щитом погасил» выше.
  const sh = d.shield || r.shield
  if (sh && (sh.raises || sh.blocked)) bits.push(`щит: поднимал ${sh.raises || 0}, погашено по звуку ${sh.blocked || 0}`)
  if (d.totem) bits.push(`тотем: сработал ${d.totem.pops}, снова в руке ${d.totem.reequips}, надевал ${Object.entries<any>(d.totem.why || {} as Record<string, any>).map(([k, v]: any) => `${k}×${v}`).join(', ')}`)
  if (d.itemUse && (d.itemUse.slowTicks || d.itemUse.sprintStops || d.itemUse.wallStops)) bits.push(`с предметом медленно ${d.itemUse.slowTicks} тиков, спринт не дан ${d.itemUse.sprintBlocked}; спринт без «вперёд»: не начат ${d.itemUse.sprintNoFwd || 0}, погашен ${d.itemUse.sprintStops || 0}, начат с «вперёд» ${d.itemUse.sprintStarts || 0}; в стену (не вскользь): спринт погашен/не начат ${d.itemUse.wallStops || 0}, тиков у стены ${d.itemUse.wallTicks || 0}`)
  if (d.tricks) bits.push('приёмы ' + Object.entries<any>(d.tricks).map(([k, v]: any) => `${k}×${v}`).join(', '))
  if (d.healed) bits.push('лечился ' + d.healed.join(', '))
  if (d.style) bits.push(`характер: агрессия ${d.style['агрессия']}, реакция ${d.style['реакцияМс']} мс, в коробку на ${d.style['коробкаНа']} хп`)
  // Темп (pvp.js/tempo.js): начало боя, еда под давлением, наказания занятого, вскрытия коробки.
  const tp = d.tempo
  if (tp) bits.push(`темп${tp.on ? '' : ' (выкл)'}: начало ${tp.open || '-'}, ел ${tp.ate} (под давлением ${tp.pressured}, бросил ${tp.aborted}${tp.desperate ? ', прижат ' + tp.desperate : ''}${tp.refused ? ', не стал ' + tp.refused : ''}), он ел ${tp.foeAte}, попал по занятому ${tp.busyHits}${tp.punish ? ', наказания ' + Object.entries<any>(tp.punish).map(([k, v]: any) => `${k}×${v}`).join(' ') : ''}${tp.breaches ? `, коробку вскрыли ${tp.breaches}, вырвался ${tp.escapes || 0}` : ''}`)
  if (d.left) bits.push('осталось ' + Object.entries<any>(d.left).map(([k, v]: any) => `${k}×${v}`).join(', '))
  // Качество боя (pvp.js, 2026-09-26): окна без размена ≥10 с, оба ели/пили
  // разом, стройка под его рукой и брошенная, наказания едока, нажим, фазы
  // человека. JSON — для сводки (agg.js), одной строкой.
  if (d.quality) { const q: Record<string, any> = { ...d.quality }; if (q.eatPunish) q.eatPunish = { tries: q.eatPunish.tries, swaps: q.eatPunish.swaps }; bits.push('качество: ' + JSON.stringify(q)) }
  return bits.join(' | ')
}

const score = { [NA]: 0, [NB]: 0, draw: 0 }

export { diedIn, lostLink, deathBase, logSize, roundDeaths, where, STALL_MS, MAX_MS, RETURN_MS, GONE_MS, PREP_RATE, FIGHT_RATE, short, score }
