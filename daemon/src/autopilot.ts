'use strict'
// Автопилот тела: рефлексы по таймеру (вода, огонь, удушье, крипер, авария и бегство на малом хп, еда, броня, инструменты,
// лут на виду). Части — в autopilot/: needs (константы урона и аварий, нужда в бегстве от крипера и в аварийном уходе),
// autopilot (класс Autopilot), suffocation (удушье и завал — подмешано в прототип).
export { IN_WALL_DAMAGE, SELF_GUARDED, EMERGENCY, emergencyNeed, MOB_DAMAGE, CREEPER, creeperNeed } from './autopilot/needs'
export { Autopilot } from './autopilot/autopilot'
