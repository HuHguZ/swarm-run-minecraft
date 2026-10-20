'use strict'
// Исполнитель моста и спуска блоками (blockmoves install): подписки на события бота и останов. Состояние и действия —
// blockmoves/exec-state.ts, тик — blockmoves/exec-step.ts.
import { Vec3 } from 'vec3'
import { fixPath, goalKey } from './cells'
import { openExec, receipt, cancelScheduled, finish } from './exec-state'
import { step } from './exec-step'

// ---------------------------------------------------------------- исполнитель
function install (session, deps: any = {}) {
  const bot = session.bot
  if (!bot || bot._ndBridgeExec) return bot && bot._ndBridgeExec
  const x = openExec(session, deps, bot)
  const { st } = x

  const single = (pk) => { try { receipt(x, new Vec3(pk.location.x, pk.location.y, pk.location.z), pk.type) } catch {} }
  const multi = (pk) => {
    try {
      if (!pk.chunkCoordinates) return
      for (const r of pk.records) receipt(x, new Vec3(pk.chunkCoordinates.x * 16 + ((r >> 8) & 15), pk.chunkCoordinates.y * 16 + (r & 15), pk.chunkCoordinates.z * 16 + ((r >> 4) & 15)), r >> 12)
    } catch {}
  }
  st.queue = []
  st.desc = null
  st.step = () => step(x)
  const onPath = (r) => { fixPath(r && r.path) }
  // Сброс пути посреди моста: клавиши «назад»/вбок pathfinder не отпускает (clearStates=false) — отпустить сразу,
  // не ждать тика; клетку под нависшим телом поставит следующий тик (ветка !going).
  const onReset = () => {
    if (!st.seg && !st.queue.length) return
    cancelScheduled(x)
    try { for (const k of ['back', 'left', 'right', 'forward']) bot.setControlState(k, false); bot.jumpQueued = false } catch {}
  }
  // Телепорт, возрождение — ступень и очередь моста больше не про это место: забыть и отпустить свои клавиши.
  const onTeleport = () => {
    if (!st.desc && !st.queue.length && !st.seg) return
    cancelScheduled(x)
    st.desc = null; st.queue = []
    finish(x, false)
    try { for (const k of ['forward', 'back', 'left', 'right', 'sneak']) bot.setControlState(k, false); bot.jumpQueued = false } catch {}
  }
  // Счёт одинаковых перестроек снимают новая цель (другая, не та же после рефлекса) и достигнутая цель.
  const onGoal = (g) => { const k = goalKey(g); if (k !== st.replanGoal) { st.replanGoal = k; st.replanSame = 0; st.replanSig = null } }
  const onReached = () => { st.replanSame = 0; st.replanSig = null }
  st.stop = () => {
    st.stopped = true
    cancelScheduled(x)
    finish(x)
    bot.removeListener('goal_updated', onGoal)
    bot.removeListener('goal_reached', onReached)
    bot.removeListener('physicsTick', st.step)
    bot.removeListener('path_update', onPath)
    bot.removeListener('path_reset', onReset)
    bot.removeListener('forcedMove', onTeleport)
    bot.removeListener('spawn', onTeleport)
    bot.removeListener('end', st.stop)
    try { bot._client.removeListener('block_change', single); bot._client.removeListener('multi_block_change', multi) } catch {}
    if (bot._ndBridgeExec === st) delete bot._ndBridgeExec
  }
  // path_update — раньше исполнителя (prepend): узлы надо поправить до первого тика по новому пути.
  bot.prependListener('path_update', onPath)
  bot.on('goal_updated', onGoal)
  bot.on('goal_reached', onReached)
  bot.on('physicsTick', st.step)
  bot.on('path_reset', onReset)
  bot.on('forcedMove', onTeleport)
  bot.on('spawn', onTeleport)
  try { bot._client.on('block_change', single); bot._client.on('multi_block_change', multi) } catch {}
  bot.once('end', st.stop)
  bot._ndBridgeExec = st
  return st
}

export { install }
