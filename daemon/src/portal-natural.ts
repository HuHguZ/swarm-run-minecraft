'use strict'


// Природная лава для портала без алмазной кирки (агент G, 02.10.2026; research/07-portal-techniques.md).
// Найти ГЛАЗАМИ ближайшую годную лаву, выбрать технику, дойти, отлить раму (cast.js — не правлю, только зову) и
// зажечь (nether.portal). Новое поведение — RPC portal_natural (index.js); активный ход — под ND_PORTAL_NATURAL=1.
//
// Почему так, коротко (подробно и с числами — 07-portal-techniques.md):
// * «Магмовый овраг» спидраннеров 1.16 — это дно подводного оврага на y=10 (магма/обсидиан от карвера, лава под ним
//   при y ≤ 9), дверь — карман воздуха и стенка от воды, лава из-под магмы ставится в воду и сразу obsidian. В
//   1.21.11 подводного карвера нет: canyon/cave заливают лавой только ниже lava_level = above_bottom 8 (y −56).
//   Скан 12+ сидов (farm/portal-scan): у дна океанских впадин лавы 0 столбов из тысяч, магма — фича underwater_magma
//   в затопленных пещерах, без лавы под собой. Овражная техника неприменима.
// * Дверь: FlowingFluid.canHoldAnyFluid (Paper 1.21.11) не пускает воду в DoorBlock, SIGNS, LADDER, NETHER_PORTAL…
//   Лава ведром в воду — сразу obsidian (BucketItem.emptyContents: вода canBeReplaced → источник лавы → LiquidBlock
//   onPlace → shouldSpreadLiquid). Но рама в воде зажигается только с сухим интерьером 2×3 (PortalShape.isEmpty: воздух
//   или огонь): нужно запечатать 12 граней интерьера и вычерпать 6 источников — дороже, чем сэкономленные 10 вёдер воды
//   cast.js, а черпать лаву всё равно ходить 10 раз. Отдельным приёмом не делаю (см. 07, раздел «дверь»).
// * Значит, вся разница — НАЙТИ годную лаву быстро и честно. Порядок (скан): руины портала с лавой и поверхностное
//   озеро видны с поверхности издалека (светятся, на них небо) — первыми; вид с ближней высоты; пещерная лава видна
//   только из пещеры; дальше разведка лучами; низ (−55, гарантирован) — запасной путь потока overworld (ND_OW_DEEP).
//
// Честность: лава засчитана, только если луч от глаз упёрся в источник (sight.visibleOf). Источники одного тела
// (озера) считаются по связности от видимого и только с открытым верхом — их видно сверху тем же взглядом.
export { survey, terrainView, searchOrder, lavaBody, skyAbove, rpNear, estimate, NEED } from './portal-natural/look'
export {
  lookoutSpot, edgeSpot, shoreSources, refreshCastLava, softCells, legTarget, wetShare, hintFor, poolInfo, skyOfScan
} from './portal-natural/walk'
export { run, rpc } from './portal-natural/run'
