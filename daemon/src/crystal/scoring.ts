'use strict'
// Кристаллы (crystal.ts): оценки — эффективное хп, набор, износ брони, что ему пройдёт, стоит ли бить.

// ---------------------------------------------------------------- состояние тела

function effHp (bot, e) {
  if (e === bot.entity) return (bot.health ?? 20) + ((require('../totem') as typeof import('../totem')).absorption(bot) || 0)
  let h = null
  try {
    const keys = bot.registry.entitiesByName[e.name || 'player'].metadataKeys
    const i = keys ? keys.indexOf('health') : -1
    const v = e.metadata && e.metadata[i >= 0 ? i : 9]
    if (typeof v === 'number') h = v
  } catch {}
  let abs = 0
  try { abs = (require('../read') as typeof import('../read')).absorptionOf(bot, e) || 0 } catch {}
  return (h ?? 20) + abs
}
function countOf (bot, name) { return bot.inventory.items().reduce((n, i) => n + (i.name === name ? i.count : 0), 0) }
function kitOf (bot) {
  return {
    crystals: countOf(bot, 'end_crystal'),
    obsidian: countOf(bot, 'obsidian'),
    bow: !!bot.inventory.items().find(i => i.name === 'bow'),
    arrows: !!bot.inventory.items().find(i => /arrow$/.test(i.name)),
    totems: countOf(bot, 'totem_of_undying') + (bot.inventory.slots[45] && bot.inventory.slots[45].name === 'totem_of_undying' ? 1 : 0),
    anchors: countOf(bot, 'respawn_anchor'),
    glowstone: countOf(bot, 'glowstone')
  }
}
// Износ надетой брони с «Починкой»: доля потраченной прочности у самой
// изношенной вещи и сколько прочности не хватает всем вместе (slots 5..8).
function armorWear (bot) {
  const read: typeof import('../read') = require('../read')
  let worst = 0; let missing = 0; let mending = 0
  const items = {}
  for (const sl of [5, 6, 7, 8]) {
    const it = bot.inventory.slots[sl]
    if (!it || !it.maxDurability) continue
    if (read.enchLevel(bot, it, 'mending') <= 0) continue
    mending++
    const used = it.durabilityUsed || 0
    items[sl] = { name: it.name, used }
    missing += used
    worst = Math.max(worst, used / it.maxDurability)
  }
  return { worst, missing, mending, items }
}

// Урон, который ему реально пройдёт с учётом его окна неуязвимости: в окне
// проходит только превышение сырого над последним ударом (очень грубо —
// пропорцией от урона после брони).
// def — его защита: броня применяется к разнице сырого (LivingEntity.hurtServer
// → actuallyHurt(amount − lastHurt)), не пропорцией (ревью Codex: 3.2 против 1.6).
function landed (t, win, def = null) {
  if (!win) return t.him
  if (t.himRaw <= win.raw + 0.5) return 0
  const delta = t.himRaw - win.raw
  if (!def) return t.him * delta / t.himRaw
  const assess: typeof import('../assess') = require('../assess')
  return assess.afterArmor(delta, def.armor, def.tough) * (1 - (def.epf || 0) / 25) * Math.max(0, 1 - 0.2 * (def.resist || 0))
}

// Что стоит сделать с кристаллом сейчас. me — моё состояние; opts.minNet —
// сколько «ему минус мне» считать выгодой.
// Свой тотем своим же кристаллом не хлопать никогда (запас 3 хп); ему —
// заметно; размен в нашу пользу хотя бы в 1.3 раза и не больше ~45% своего.
// Добить (или сбить его тотем) — можно и при равном размене, если себе не
// смертельно. Симметричная броня с «Взрывоустойчивостью» на открытом поле
// даёт ~12.6 ему у ног и ~7.5 себе с 3.5 блоков — это ещё размен; себе
// больше, чем ему, — никогда.
// press — долго без размена (нажим pvp.js): размен 1:1 тоже годится, лишь бы
// себе не смертельно, — иначе два бота в окружениях стоят до «застоя».
// hisTotem — тотем у него в руке: «добить» — лишь сбить тотем, и за это
// большой ценой себе (до смертельного) не платить — только обычным пределом.
function worthHit (t, { myEff, hisEff, hisLand, press = false, hisTotem = false }: any) {
  const worst = Math.max(t.me, t.meMax ?? t.me)
  // ND_CRYSTAL_RECKLESS=1 (арена 10.10: «пусть все взрывают друг друга»): рвать, если ему ≥ 2.5, а сам переживу с запасом 2.
  if (process.env.ND_CRYSTAL_RECKLESS === '1') return hisLand >= 2.5 && worst < myEff - 2
  if (worst >= myEff - 3) return false
  if (hisLand < 2.5) return false
  const kill = hisLand >= hisEff - 0.5
  if (kill && hisLand >= t.me && (hisTotem ? t.me <= Math.max(2.5, myEff * 0.45) : worst < myEff - 4)) return true
  if (press) return hisLand >= t.me && t.me <= Math.max(2.5, myEff * 0.6) && t.me < myEff - 4
  return hisLand >= t.me * 1.3 + 0.5 && t.me <= Math.max(2.5, myEff * 0.45)
}

export { effHp, countOf, kitOf, armorWear, landed, worthHit }
