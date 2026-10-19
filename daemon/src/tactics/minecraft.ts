// Тактика тела в Minecraft: наблюдение угроз (observeTactics) и система выбора и исполнения тактических действий
// (TacticalSystem). Части — в tactics/minecraft/: observe (наблюдение и снимок состояния), system (TacticalSystem).
export { stateSnapshot, dropBehind, FLEE_SAFE_DISTANCE, EXHAUSTION_HOLD_MS, FIGHT_RECOVERY_HP, observeTactics } from './minecraft/observe'
export type { TacticalSnapshot, TacticalPorts } from './minecraft/observe'
export { TacticalSystem } from './minecraft/system'
