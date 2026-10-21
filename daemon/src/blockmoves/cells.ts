'use strict'
// Мост и спуск блоками (blockmoves.ts) — клетки и путь: что можно заменить блоком, чем мостить, ключ клетки, правка узлов
// пути после postProcessPath и счёт одинаковых перестроек. Общее для ходов A* (blockmoves.ts) и исполнителя
// (blockmoves/exec*.ts).

const REPLACE = /^(air|cave_air|void_air|water|short_grass|tall_grass|fern|large_fern|dead_bush|snow)$/
const FILLER = process.env.ND_BLZ_BRICK_FILL === '1' ? /^(cobblestone|cobbled_deepslate|dirt|netherrack|stone|deepslate|andesite|diorite|granite|tuff|blackstone|basalt|nether_bricks|[a-z_]+_planks)$/
  : /^(cobblestone|cobbled_deepslate|dirt|netherrack|stone|deepslate|andesite|diorite|granite|tuff|blackstone|basalt|[a-z_]+_planks)$/
const EYE = 1.62
const key = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`

function replaceable (b) {
  return !!(b && REPLACE.test(b.name) && (b.name !== 'snow' || Number(b.getProperties?.().layers) === 1))
}

// Предел перестроек с одного места (S8b; S8c 07.10, замечание проверки в): подпись — причина и клетка (узел, клетка моста/ступени
// или опора; у причин без узла раньше была одна подпись на все клетки), счёт снимают сдвиг тела на 2+ бл. (продвинулись),
// новая цель и достигнутая цель (onGoal/onReached в install).
function replanSig (why, info?: any) {
  const c = info && (info.node || info.cell || info.ref)
  return `${why}|${Array.isArray(c) ? c.join(',') : ''}`
}
function replanCount (st, sig, pos) {
  const moved = !!(st.replanPos && pos && Math.hypot(pos.x - st.replanPos.x, pos.y - st.replanPos.y, pos.z - st.replanPos.z) >= 2)
  st.replanSame = sig === st.replanSig && !moved ? (st.replanSame || 0) + 1 : 1
  st.replanSig = sig
  if (st.replanSame === 1 && pos) st.replanPos = { x: pos.x, y: pos.y, z: pos.z }
  return st.replanSame
}
const goalKey = g => g ? JSON.stringify([g.constructor && g.constructor.name, g.x, g.y, g.z, g.rangeSq, g.goals && g.goals.length]) : ''

// postProcessPath pathfinder'а ставит узлу без опоры y − 1 (узел-мост висит над воздухом), и узел никогда не
// «достигается» (|dy| < 1). Вернуть высоту и центр клетки — на path_update, до того как исполнитель возьмёт путь.
function fixPath (path) {
  if (!Array.isArray(path)) return 0
  let n = 0
  for (const p of path) {
    const tag = p && (p.ndBridge || p.ndDescend)
    if (!tag) continue
    p.x = Math.floor(p.x) + 0.5
    p.y = tag.y
    p.z = Math.floor(p.z) + 0.5
    n++
  }
  return n
}

export { REPLACE, FILLER, EYE, key, replaceable, replanSig, replanCount, goalKey, fixPath }
