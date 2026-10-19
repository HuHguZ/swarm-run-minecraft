'use strict'
// Арена: два NeuroDown дерутся друг с другом через свои демоны, чтобы PvP
// оттачивался на равном противнике, а человек смотрел со стороны.
//
// Запуск (два демона на тестовом Paper, 25565):
//   ND_WS_PORT=8767 MC_USERNAME=NeuroDown  -> первый (оп, раздаёт предметы)
//   ND_WS_PORT=8768 MC_USERNAME=NeuroDown2 -> второй
//   node arena.js [раундов на набор] [фильтр набора]
// Чары на все предметы наборов, равной силы, пары раундов с обменом —
// ARENA_ENCH*, ARENA_PAIR (у kitSides; 2026-09-26). Чётное число раундов —
// пары целые.
//
// Смотреть: клиент 1.21.11, сервер 127.0.0.1:25565, арена на 200 100 200 —
// стеклянная коробка без крыши. ARENA_STYLE=colosseum — Колизей вокруг поля
// (colosseum.js, build-colosseum.js; см. STYLE в arena/build.ts).
//
// Код — в arena/: config (сторож «только ферма» — первый импорт, раньше всего остального; параметры запуска, «хватит»
// в чате, журнал, бойцы, место арены), rpc (демоны бойцов и команды в чат), build (поле, Колизей, потолок, уборка),
// kits (наборы), fighters (выдача, чары, лечение, люди на сервере), judge (смерти, где боец, пределы раунда, итог,
// счёт), round (раунд). Здесь — замок, подключение бойцов и главный цикл.
import { ROUNDS, ONLY, A_PORT, log, HUMANS, HUMAN, WATCH, NA, NB, X, Y, Z, GENTLE, stopRequested } from './arena/config'
import { REPO_ROOT } from '../src/paths'
import * as guard from '../scenes/lib/arms-guard'
import { A, B, cmd, connect } from './arena/rpc'
import { COLOS, CZ, CEIL_H, CEIL, TOP, BLAST, CZM, CLEAN_R, buildArena, setCeil, setBlast, setCZM, setCZFP } from './arena/build'
import { MODE, KITS } from './arena/kits'
import { ENCH_ARG, ENCH, ENCH_BUDGET, ENCH_TOL, PAIR, setEnch } from './arena/fighters'
import { FIGHT_RATE, score } from './arena/judge'
import { round } from './arena/round'
import * as fs from 'fs'
import path = require('path')

// Одна арена за раз: вторая копия (незаметно оставшаяся от прерванного
// запуска) посреди боя начинала свой раунд и перевыдавала всем вещи.
// Прежняя копия жива — отказ (раньше её убивали: при A=8765 это гасило живую арену).
const LOCK = path.join(REPO_ROOT, 'daemon', `arena-${A_PORT}.lock`)
{
  let old = 0
  try { old = Number(fs.readFileSync(LOCK, 'utf8')) } catch {}
  let alive = false
  if (old && old !== process.pid) { try { process.kill(old, 0); alive = true } catch {} }
  if (alive) throw new Error(`арена на ${A_PORT} уже идёт (pid ${old}, ${LOCK}) — остановите её или удалите замок`)
}
fs.writeFileSync(LOCK, String(process.pid))
process.on('exit', () => { try { if (fs.readFileSync(LOCK, 'utf8') === String(process.pid)) fs.unlinkSync(LOCK) } catch {} })

// Бойцы — после сторожа и замка: A — первый, B — второй (или заглушка, когда второй — человек, ARENA_HUMAN).
connect()

;(async () => {
  try {
    await A.ready; await B.ready
    await A.call('connect'); await B.call('connect')
    for (const c of HUMAN ? [A] : [A, B]) guard.farmServer(((await c.call('status')).detail || {}).server)
    // На арене никто не обижается сам: дерутся только по команде раунда.
    await A.call('temper', { enabled: false }); await B.call('temper', { enabled: false })
    // Чары — только демонам, которые с ними справляются: без gamedata.fixEnchants
    // бот с зачарованной киркой или мечом в руке не копает вовсе (try-ench.js
    // 2026-09-26: «enchantments.concat is not a function» — ни обсидиан, ни
    // паутина). Такой демон и параметр status { enchants } молча пропускает —
    // по нему и видно. ARENA_ENCH=force — не спрашивать.
    if (ENCH && ENCH_ARG !== 'force') {
      for (const [c, who] of (HUMAN ? [[A, NA]] : [[A, NA], [B, NB]]) as [typeof A, string][] ) {
        const st = await c.call('status', { enchants: true }).catch(() => null)
        if (st && st.detail && Array.isArray(st.detail.enchants)) continue
        setEnch(false)
        log(`чары выключены: демон ${who} не показывает чары предметов (src без gamedata.fixEnchants — с зачарованным инструментом не копает); ARENA_ENCH=force — выдавать всё равно`)
        break
      }
    }
    if (ENCH) log(`чары: бюджет ${ENCH_BUDGET.join('–')} на пару, допуск ±${ENCH_TOL}, ${PAIR === '0' ? 'без пар' : PAIR === 'sides' ? 'пары с обменом (и сторон)' : 'пары с обменом'}${process.env.ARENA_ENCH_SEED ? ', seed ' + process.env.ARENA_ENCH_SEED : ''}`)
    if (!GENTLE) {
      await cmd('/difficulty normal')
      await cmd('/time set day')
      await cmd('/gamerule do_daylight_cycle false')
      await cmd('/gamerule spawn_mobs false')
      await cmd('/gamerule do_immediate_respawn true')
    }
    // Чат не засорять ответами на /give, /tp, /fill: пользователь просил только
    // объявление перед боем. Правило возвращается в конце.
    await cmd('/gamerule send_command_feedback false')
    await cmd('/gamerule log_admin_commands false')
    // Потолок — если в выбранных наборах есть заряды ветра или булава (см. CEIL_H).
    const chosen = KITS.filter(k => (!ONLY || ONLY.split(',').some(f => k.name.includes(f))) && !(MODE === 'kits' && k.craft) && !(MODE === 'craft' && !k.craft))
    // В Колизее — всегда: взрывы и элитры не должны выносить бойцов и лучи на трибуны.
    setCeil(process.env.ARENA_CEIL ? process.env.ARENA_CEIL === '1' : COLOS || chosen.some(k => [...(k.a || []), ...(k.b || [])].some(i => /^(minecraft:)?(wind_charge|mace|elytra)\b/.test(i))))
    if (CEIL) log(`потолок: ${COLOS ? 'барьер' : 'стекло'} до ${TOP()}, барьер на ${Y + CEIL_H}`)
    // Взрывчатка в наборах — барьерная оболочка за стеклом (blastShell) и уборка
    // вагонеток и кристаллов между раундами.
    setBlast(chosen.some(k => [...(k.a || []), ...(k.b || [])].some(i => /^(minecraft:)?(tnt_minecart|end_crystal|tnt|respawn_anchor)\b/.test(i))))
    if (BLAST) log(`взрывчатка в наборах: ${COLOS ? 'стены Колизея — барьер' : 'за стеклом оболочка из барьера'}`)
    if (COLOS) { setCZM(CZ.model({ R: CLEAN_R, ceilH: CEIL_H })); setCZFP(CZ.footprint(CZM, { X, Y, Z })) }
    await buildArena()
    for (const h of HUMANS) await cmd(`/gamemode survival ${h}`)
    if (WATCH) {
      await cmd(`/gamemode spectator ${WATCH}`)
      // В Колизее — в императорскую ложу (пульвинар), лицом к полю.
      if (COLOS) { const w = CZ.watchSpot(CZM, { X, Y, Z }); await cmd(`/tp ${WATCH} ${w.x} ${w.y} ${w.z} ${w.yaw} ${w.pitch}`) } else await cmd(`/tp ${WATCH} ${X} ${Y + 6} ${Z}`)
    }
    if (!GENTLE) {
      await cmd(`/spawnpoint ${NA} ${X - 6} ${Y} ${Z}`)
      await cmd(`/spawnpoint ${NB} ${X + 6} ${Y} ${Z}`)
    }
    log(`арена готова: ${X} ${Y} ${Z}`)
    const playKits = KITS.filter(kit => !(ONLY && !ONLY.split(',').some(f => kit.name.includes(f))) && !(MODE === 'kits' && kit.craft) && !(MODE === 'craft' && !kit.craft))
    // Без конца и наборов несколько («арсенал,небо и порох») — по очереди,
    // раунд за раундом: иначе первый шёл бы вечно, а до второго не доходило.
    if (ROUNDS === 0 && playKits.length > 1) {
      for (let i = 1; !stopRequested(); i++) await round(playKits[(i - 1) % playKits.length], i)
      log('СТОП: в чате «хватит»')
    } else {
      for (const kit of playKits) {
        for (let i = 1; (ROUNDS === 0 || i <= ROUNDS) && !stopRequested(); i++) await round(kit, i)
        if (stopRequested()) { log('СТОП: в чате «хватит»'); break }
      }
    }
    log(`ФИНАЛ: ${NA} ${score[NA]} : ${score[NB]} ${NB}, ничьих ${score.draw}`)
  } catch (e) {
    log('FAILED:', e.stack || e.message)
    process.exitCode = 1
  } finally {
    // Характер основному бойцу — обратно: в обычной игре он должен отвечать.
    if (FIGHT_RATE) await cmd(`/tick rate ${FIGHT_RATE}`).catch(() => {})
    await cmd('/gamerule send_command_feedback true').catch(() => {})
    await cmd('/gamerule log_admin_commands true').catch(() => {})
    // Зрителя — обратно в выживание, на пол арены (в воздухе он бы упал).
    // В Колизее — на пол пульвинара: в поле его заперли бы барьеры.
    if (WATCH) {
      if (COLOS && CZM) { const w = CZ.watchSpot(CZM, { X, Y, Z }); await cmd(`/tp ${WATCH} ${w.x} ${w.y} ${w.z} ${w.yaw} 0`).catch(() => {}) } else await cmd(`/tp ${WATCH} ${X} ${Y} ${Z}`).catch(() => {})
      await cmd(`/gamemode survival ${WATCH}`).catch(() => {})
    }
    // Ответка — в полную силу, как до арены (просьба 2026-09-25).
    await A.call('temper', { enabled: true, firstHitChance: 1, fightSeconds: 300, calmSeconds: 30, retreatAtHealth: 3 }).catch(() => {})
    A.ws.close(); B.ws.close()
  }
})()
