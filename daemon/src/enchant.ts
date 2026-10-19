'use strict'
// Зачарование: стол, книжные полки, лазурит, уровни опыта — и главное, ЧТО
// зачаровывать и ЗАЧЕМ. Все числа — из самой игры (paper-1.21.11, байткод и
// data/minecraft/enchantment/*.json), см. SPEEDRUN.md «Зачарование».
//
//   EnchantingTableBlock.BOOKSHELF_OFFSETS — клетки x,z в [-2..2], y 0..1, где
//     |x|==2 или |z|==2 (кольцо в двух слоях, 32 клетки). Полка засчитывается,
//     только если клетка МЕЖДУ ней и столом (x/2, y, z/2, деление к нулю) —
//     #replaceable (воздух, трава, снег). Считается максимум 15.
//   EnchantmentHelper.getEnchantmentCost: c = rnd(8)+1 + полки/2 + rnd(полки+1);
//     строка 1 = max(c/3,1), строка 2 = c*2/3+1, строка 3 = max(c, полки*2).
//     15 полок → третья строка до 30.
//   EnchantmentMenu.clickMenuButton: строка i стоит i+1 лазурита и i+1 уровень,
//     а доступна при уровне ≥ цены строки. Любое зачарование меняет «семя» —
//     предложения перетасовываются (дешёвый переброс книгой).
//   AnvilMenu: 40 и дороже — «слишком дорого»; книга стоит anvil_cost/2 за
//     уровень; каждая работа удваивает штраф предмета (cost*2+1).
//
// Подсказка стола показывает ОДНО из зачарований строки; на дорогой строке их
// часто два-три. Выбор здесь — по подсказке, с поправкой на цену строки.
//
// Части — в enchant/: facts (числа игры, что и зачем, чтение предметов, полки), window (окна стола и наковальни, выбор
// предложений), table (стол и полки на месте), enchanting (одно зачарование), anvil (книги на наковальне), run (план и вход).
export { shelfPower, shelfCells, costRange, enchantsOf, kindOf, worthFor, conflicts, pointsBetween, xpForNext, ENCH, WANT } from './enchant/facts'
export { rankOffers, chooseTargets } from './enchant/window'
export { anvilEstimate } from './enchant/anvil'
export { run, plan, XP_WAYS } from './enchant/run'
