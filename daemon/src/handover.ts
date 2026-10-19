'use strict'
// Передача вещей человеку и подбор у него (mc_give, mc_take): из рук в руки бросок с дальности, свидетель — пакет collect
// сервера. Части — в handover/: vocabulary (дальности, имена вещей, что не отдаётся), world (предметы на земле, стойка),
// give (кому и что, броски, ответ), take.
export { pickItem, precious, spareOfKind, normalizeAsk, THROW, PICKUP, REACH, TRIES } from './handover/vocabulary'
export { lyingAround } from './handover/world'
export { give } from './handover/give'
export { take } from './handover/take'
