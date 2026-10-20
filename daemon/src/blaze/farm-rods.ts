'use strict'
// Стержни ифрита — farmRods: оркестр навыка. Состояние — farm-rods/state.ts (объект fr), стадии по порядку —
// farm-rods/stages.ts (где спавнер, путь, подготовка, бой, уход), старый цикл боя — farm-rods/legacy.ts,
// учёт урона — farm-rods/ledger.ts.
import * as gameClock from '../game-clock'
import { countOf } from '../items'
import * as worlds from '../worlds'
import { SPAWNER_PLACE, droppedRods } from './targets'
import { type RodsFarm, openRods, closeRods } from './farm-rods/state'
import { rodsLocate, rodsApproach, rodsPrepare, rodsEngage, rodsLeave } from './farm-rods/stages'
import { rodsLegacy } from './farm-rods/legacy'

async function farmRods (session, ctl, p: any = {}) {
  const fr = openRods(session, ctl, p)
  try {
    await rodsLocate(fr)
    await rodsApproach(fr)
    await rodsPrepare(fr)
    await rodsEngage(fr)
    await rodsLegacy(fr)
    await rodsLeave(fr)
  } finally {
    closeRods(fr)
  }
  return rodsReport(fr)
}

// Итог навыка (прежний хвост farmRods).
function rodsReport (fr: RodsFarm) {
  const { bot, session } = fr
const rods = countOf(bot, 'blaze_rod')
const gained = rods - fr.rods0
const left = droppedRods(bot, 12)
const detail: any = {
  rods: { before: fr.rods0, now: rods, gained, want: fr.want },
  dugIn: fr.dugIn && fr.dugIn.ok ? fr.dugIn : undefined,
  kills: fr.kills.length,
  killsAt: fr.kills.slice(0, 12),
  perKill: fr.kills.length ? Math.round(gained / fr.kills.length * 100) / 100 : null,
  fights: fr.fights.slice(-8),
  snowballs: fr.thrown ? { thrown: fr.thrown, left: countOf(bot, 'snowball') } : undefined,
  hpLost: Math.max(0, fr.hp0 - Math.round(bot.health ?? 0)),
  camp: fr.camp || undefined,
  clearing: fr.held?.clearing,
  safety: fr.held?.safety,
  escape: fr.held?.escape,
  damage: fr.ledger.report(),
  ate: fr.ate.length ? fr.ate : undefined,
  rests: fr.rests.length ? fr.rests : (fr.held && fr.held.rests.length ? fr.held.rests : undefined),
  doctrine: fr.held ? { melee: fr.held.melee, arrows: fr.held.arrows, arrowsLeft: fr.held.arrowsLeft, shieldSec: Math.round(fr.held.shieldMs / 1000), bunker: fr.held.bunker || undefined, sorties: fr.held.sorties || undefined, foes: fr.held.foes.length ? fr.held.foes : undefined, shield: fr.held.shield ? { blocked: fr.held.shield.blocked, raises: fr.held.shield.raises, hpUp: fr.held.shield.hpUnderShield, hpOpen: fr.held.shield.hpOpen } : undefined, shieldWear: fr.held.shieldWear || undefined, balls: fr.held.radar ? fr.held.radar.balls : undefined } : undefined,
  covers: fr.covers.length ? fr.covers : undefined,
  fled: fr.fled ? { mode: fr.fled.mode, ran: fr.fled.ran, from: fr.fled.from } : undefined,
  potion: fr.potion || undefined,
  spawner: undefined,
  walked: fr.walked || undefined,
  toured: fr.toured ? { hops: fr.toured.hops.length, spawners: fr.toured.spawners, seen: fr.toured.seen, at: fr.toured.at } : undefined,
  groundLeft: left || undefined,
  eyesPossible: countOf(bot, 'ender_eye') + countOf(bot, 'blaze_powder') + 2 * rods,
  seconds: Math.round((gameClock.now() - fr.t0) / 1000)
}
const places = (session.journal.state && session.journal.state.places) || {}
if (places[SPAWNER_PLACE] && worlds.worldOfRecord(places[SPAWNER_PLACE]) === fr.here) {
  const s = places[SPAWNER_PLACE]
  detail.spawner = { x: s.x, y: s.y, z: s.z }
}
if (rods < fr.want) {
  detail.need = fr.held && fr.held.needArrows ? { what: 'arrow', count: 32, have: 0, for: 'blaze_rod' } : { what: 'blaze_rod', count: fr.want - rods, have: rods }
  detail.stopped = `${fr.stopped || 'встал'} — стержней ${rods} из ${fr.want} (убил ${fr.kills.length}, выпало ${gained}` +
    `${left ? `, ещё ${left} лежат рядом` : ''})`
}
detail.note = `Стержней +${gained} (теперь ${rods}), убито блейзов ${fr.kills.length}` +
  (fr.kills.length ? ` — по ${detail.perKill} на блейза (игра даёт 0 или 1, в среднем 0.5)` : '') +
  `. Хватит на ${detail.eyesPossible} око(в) при жемчуге. ` +
  (rods >= fr.want ? 'Порошок: mc_craft item=blaze_powder (1 стержень = 2 порошка).' : 'Позови ещё раз у спавнера — он работает, пока я в 16 блоках.')
return detail
}

export { farmRods }
