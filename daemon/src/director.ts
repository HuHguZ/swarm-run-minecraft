'use strict'
// Средний слой: обстановка раз в секунду, цели и шаги к ним, вытеснение (Director), выход из огня и лавы. Части — в
// director/: situation (обстановка), goals (цели и их шаги), fire (escapeFire), director (класс Director).
export { situation, byDirector } from './director/situation'
export { GOALS } from './director/goals'
export { escapeFire } from './director/fire'
export { Director } from './director/director'
