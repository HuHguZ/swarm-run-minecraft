'use strict'
// Серия начала кампании для потока survival (research/dev-B-refuge.md): то же, что try-lab-fresh.js (новый мир →
// campaign.js полным порядком этапов), но по правилу пользователя 02.10 — keep_inventory=false во всех трёх мирах
// (смерть = потеря вещей и провал прогона). KEEP_INV=true — как было (для сравнения).
//   node dist/farm/farm.js run try-lab-surv-camp.js --slots 16-20 --tag survB-campN UNTIL=nether MINUTES=40
// Все параметры try-lab-fresh.js (UNTIL, MINUTES, DEATHS_MAX, CAMPAIGN, KIT, STAGES) работают так же.
import kitMod = require('../lib/scene-kit')
const KEEP = String(process.env.KEEP_INV || 'false')
const createKit = kitMod.createKit
// try-lab-fresh берёт createKit из scene-kit при загрузке — подмена до require меняет только keep_inventory.
kitMod.createKit = (...args) => {
  const kit = createKit(...args)
  const gamerule = kit.gamerule
  kit.gamerule = (id, value) => gamerule(id, id === 'keep_inventory' ? KEEP : value)
  return kit
}
import './try-lab-fresh'
