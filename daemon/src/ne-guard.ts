'use strict'
// Страж Ада: угроза ближнего боя рядом (пиглины, бруты, хоглины, иссушители, ифрит вплотную) — ответ сразу: укрытие
// (столб, яма, коробка), бой из укрытия или дуэль со щитом; шар гаста — отбить ударом. Тело — daemon/src/ne-guard/.
export { meleeFoes, aggressive, HIDE_FROM, bigMelee } from './ne-guard/foes'
export { boxIn, hideDown, holeOk, pillarFits, holeFits, above } from './ne-guard/shelter'
export { duel, sit } from './ne-guard/fight'
export { busy, waitIdle, attach, install, hot, react } from './ne-guard/react'
export { swatInstall } from './ne-guard/swat'
