'use strict'
// Живая арена (часть arena-live.ts): строка итога бойца за раунд для журнала арены.

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

export { short }
