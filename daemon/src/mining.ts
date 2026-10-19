'use strict'
// The strip mine. digDown puts the bot at iron depth and leaves it standing in
// a one-block shaft, which touches almost nothing: ore sits in the *walls* of a
// corridor. This is the horizontal half of the same job — and the half where
// the classic deaths are, so every step is a safety check first and a pickaxe
// swing second.
//
// Parts (daemon/src/mining/): dig-core — directions, safety checks, digging; seal — sealing off against mobs;
// shaft — shaft down/up; ore-ledger — exposed ore and the ore memory; drift — the tunnel; mine-seen — coming back for ore.
export { shaftDown, shaftUp, dryGround } from './mining/shaft'
export { recallOre, rememberOre } from './mining/ore-ledger'
export { tunnel } from './mining/drift'
export { mineSeen } from './mining/mine-seen'
