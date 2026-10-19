'use strict'
// Страж Ада (ne-guard.ts): кто враг — ближний бой, злые на нас, в виду; лог.
import * as gameClock from '../game-clock'


export const log = (what, o) => console.log('[guard]', new Date().toTimeString().slice(0, 8), what, JSON.stringify(o))
// Стрелки — со своими ответами; ближний удар блейза также требует стража.
const MELEE = /^(piglin|piglin_brute|hoglin|zoglin|zombified_piglin|wither_skeleton|magma_cube|zombie|husk|vindicator)$/
// Blaze melee is dangerous even under fire resistance; distant fireballs stay
// with the ranged/fire handler. Protect crafting and walking after farmRods too.
export const meleeName = n => MELEE.test(n || '') || (process.env.ND_GUARD_BLAZE !== '0' && n === 'blaze')
export const HIDE_FROM = /^(piglin_brute|hoglin|zoglin)$/

function metaOf (bot, e, key) {
  try { const keys = bot.registry.entitiesByName[e.name].metadataKeys; const i = keys.indexOf(key); return i >= 0 ? e.metadata[i] : undefined } catch { return undefined }
}
// mob_flags бит 2 — «агрессивен» (ATTACK_TARGET у пиглинов, бруты/хоглины — при цели).
export const aggressive = (bot, e) => ((Number(metaOf(bot, e, 'mob_flags')) || 0) & 4) !== 0
const isBaby = (bot, e) => !!metaOf(bot, e, 'baby')
export function sees (bot, e) {
  try { const P: typeof import('../perception') = require('../perception'); return P.raySees(bot, P.eyePos(bot), e.position.offset(0, (e.height || 1.9) * 0.6, 0)) } catch { return true }
}

export function worldIsNether (bot) { try { return (require('../worlds') as typeof import('../worlds')).worldOf(bot) === 'the_nether' } catch { return false } }

// Ближние враги в r: брут/хоглин/зоглин/иссушитель — всегда; пиглин и зомби-пиглин — только злые (не малыши).
// Только видимые лучом прицела или ударившие нас за 1.5 с (ревью Codex q7 14.10: скрытый за стеной брут менял ожидание, толпу и
// разрешение слезть со столба — рентген, AGENTS.md). ND_GUARD_SEEN=0 — прежний счёт всех сущностей рядом.
export function meleeFoes (bot, r = 6) {
  const me = bot.entity.position
  const g = bot._ndGuard
  const struck = new Set((g?.hits || []).filter(h => gameClock.now() - h.t < 1500).map(h => h.id))
  return Object.values(bot.entities || {}).filter((e : any) => {
    if (!e || !e.position || e === bot.entity || e.isValid === false) return false
    const n = e.name || ''
    if (!meleeName(n)) return false
    if (e.position.distanceTo(me) > r) return false
    if (process.env.ND_GUARD_SEEN !== '0' && !struck.has(e.id)) {
      let seen = true
      try { const aim = (require('../pick') as typeof import('../pick')).aim; if (typeof aim === 'function') seen = !!aim(bot, e, { range: r + 2 })?.point } catch {}
      if (!seen) return false
    }
    if (n === 'piglin') return aggressive(bot, e) && !isBaby(bot, e) && angryAtUs(bot)
    if (n === 'zombified_piglin') return aggressive(bot, e) && !isBaby(bot, e)
    return true
  }).sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))
}

// Пиглины злы на нас: 32 с после ломки/открытия охраняемого или удара пиглина; без золотой брони — всегда.
function angryAtUs (bot) {
  const g = bot._ndGuard
  if (g && gameClock.now() - (g.angerAt || 0) < 32000) return true
  try { return ![5, 6, 7, 8].some(s => bot.inventory.slots[s] && /^golden_/.test(bot.inventory.slots[s].name)) } catch { return false }
}

// Ходячие, от которых дуэль не спасает: брут/хоглин/зоглин (топор выбивает щит, 40–50 хп), трое и больше ближних (бьют с боков
// мимо щита), или хп < 9 (lowHp: для тактики — нет, у тела вплотную нора не успевает). Им — нора, столб, иначе коробка. Двое —
// дуэль со щитом и отход: норой двое мечников убивали в 6 из 8, дуэлью с отходом — в 0 из 8.
// Сцена try-lab-ne-piglin 14.10: брут в 7 бл. — бегом 7 смертей из 8, норой 1–2.
// walkers — считать толпу без ифритов и кубов магмы (они летают или прыгают к норе и столбу): так решает тактика; ответ самого стража
// считает всех ближних, как прежде.
export function bigMelee (bot, foes = meleeFoes(bot, 8), e = null, { lowHp = true, walkers = false }: any = {}) {
  const crowd = walkers ? foes.filter((f: any) => !/^(blaze|magma_cube)$/.test(f.name || '')) : foes
  const wsk = foes.filter((f : any) => f.name === 'wither_skeleton').length
  return HIDE_FROM.test((e && e.name) || '') || foes.some((f : any) => HIDE_FROM.test(f.name || '')) || crowd.length >= 3 || wsk >= 2 || lowHp && (bot.health ?? 20) < 9
}
// Ближайший видимый стрелок в 24 бл.: пиглин с арбалетом, ифрит, гаст, скелет (иссушитель с мечом — не стрелок).
export function shooterNear (bot) {
  const me = bot.entity.position
  let best = null; let bd = 25
  for (const e of Object.values(bot.entities || {}) as any[]) {
    if (!e || !e.position || e === bot.entity || e.isValid === false) continue
    const shooter = /^(blaze|ghast|skeleton)$/.test(e.name || '') || (/^piglin$/.test(e.name || '') && e.equipment?.[0]?.name === 'crossbow')
    if (!shooter) continue
    const d = e.position.distanceTo(me)
    if (d < bd && sees(bot, e)) { best = e; bd = d }
  }
  return best
}
export const rank = i => /netherite/.test(i.name) ? 5 : /diamond/.test(i.name) ? 4 : /iron/.test(i.name) ? 3 : /stone/.test(i.name) ? 2 : 1
