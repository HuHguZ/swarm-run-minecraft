'use strict'
// Общий выход из застреваний (поток unstuck): детектор на весь goto, диагноз (стена, яма, вода, лава, листва), лестница
// ступеней выхода от дешёвой к дорогой с памятью отказов. Части — в unstuck/: diagnose (клетки и диагноз, лестницы),
// tools (видимая копка, вплавь, пролом), rungs (ступени), watch (детектор и наблюдатель перехода).
export { on, DEFAULT_ON, diagnose, ladder, LADDERS, REFUSED, overlapsBody, towardOf, axisTo, SOFT } from './unstuck/diagnose'
export { fluidRoute, safeToBreak, visiblePoint } from './unstuck/tools'
export { RUNGS } from './unstuck/rungs'
export { landBySwim, createDetector, watch, freeHere, noteRefusal } from './unstuck/watch'
