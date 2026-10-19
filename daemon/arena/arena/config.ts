'use strict'
// Арена (часть arena.ts): сторож «только ферма» до любого подключения — это первый импорт входа, и отказ приходит
// раньше, чем грузятся остальные части; параметры запуска, «хватит» в чате, журнал, бойцы и место арены.
import { REPO_ROOT } from '../../src/paths'
import * as gameClock from '../../src/game-clock'
import * as guard from '../../scenes/lib/arms-guard'
import * as fs from 'fs'
import path = require('path')

// Только ферма (arms-guard, 2026-10-06): адреса — явно, живая арена (8765/8768,
// arena-live.js) и server/ 25565 — отказ до подключения.
const A_URL = process.env.ARENA_A
const B_URL = process.env.ARENA_B
guard.farmOnly({ ws: process.env.ARENA_HUMAN ? [A_URL] : [A_URL, B_URL] })
const ROUNDS = Number(process.argv[2] || 1) // 0 — без конца, пока в чат не напишут «хватит»
// Без таймера: раунд до смерти бота или всех людей.
const NOTIMER = !!process.env.ARENA_NOTIMER
// «хватит» — только из журнала своего сервера фермы; клиент пользователя не читаем.
const MC_LOG = process.env.ND_SERVER_LOG || null
const startedAt = gameClock.wall.now()
function stopRequested () {
  if (!MC_LOG) return false
  try {
    const st = fs.statSync(MC_LOG)
    const fd = fs.openSync(MC_LOG, 'r')
    const len = Math.min(st.size, 20000)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, st.size - len)
    fs.closeSync(fd)
    const now = new Date()
    return buf.toString('utf8').split('\n').some(l => {
      const m = l.match(/^\[(\d\d):(\d\d):(\d\d)\] \[Server thread\/INFO\]: (?:\[Not Secure\] )?<[^>]+> .*хватит/i)
      if (!m) return false
      const t = new Date(now); t.setHours(+m[1], +m[2], +m[3], 0)
      return t.getTime() > startedAt
    })
  } catch { return false }
}
const ONLY = process.argv[3] || null
// Лог и замок — по порту первого бойца: тестовая арена агентов на своём
// сервере не должна гасить живую арену в мире пользователя (8765).
const A_PORT = (A_URL.match(/:(\d+)\/?$/) || [])[1] || 'x'
const LOG = path.join(REPO_ROOT, 'daemon', `arena-${A_PORT}.log`)

const sleep = ms => gameClock.sleep(ms)
const log = (...a) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`
  console.log(line)
  fs.appendFileSync(LOG, line + '\n')
}

// ARENA_HUMAN=Ник — второй боец живой человек: ему только выдаём и телепортируем,
// а победу считаем по бою NeuroDown. ARENA_WATCH=Ник — зритель в режиме наблюдателя.
// Можно несколько через запятую — тогда люди командой против NeuroDown.
const HUMANS = (process.env.ARENA_HUMAN || '').split(',').map(x => x.trim()).filter(Boolean)
const HUMAN = HUMANS[0] || null
const WATCH = process.env.ARENA_WATCH || null
// Имена бойцов — ARENA_NAME_A/B (ферма: NeuroFarm29 и NeuroFarm29b, 2026-09-30);
// по умолчанию — как на живой арене.
const NA = process.env.ARENA_NAME_A || 'NeuroDown'
const NB = HUMANS.length > 1 ? HUMANS.join('+') : HUMAN || process.env.ARENA_NAME_B || 'NeuroDown2'

// Где ставить арену: ARENA_POS="x y z" (y — уровень пола, на котором стоят).
// В чужом мире (ARENA_GENTLE=1) правила игры, время и точки возрождения не трогаем.
const POS = (process.env.ARENA_POS || '200 100 200').split(/\s+/).map(Number)
const X = POS[0]; const Y = POS[1]; const Z = POS[2]
const GENTLE = !!process.env.ARENA_GENTLE
// Бойцов — в измерение арены (ARENA_DIM, по умолчанию верхний мир): /tp не
// меняет измерение, и бот, оставшийся в аду с прошлых опытов, строил арену в
// аду у лавы (ферма, слот 29, 2026-09-30).
const TP = `/execute in minecraft:${process.env.ARENA_DIM || 'overworld'} run tp`
// Пол: обсидиан, чтобы в драке не проламывали дыры (киркой 9 с на блок).
const FLOOR = 'minecraft:' + (process.env.ARENA_FLOOR || 'smooth_stone')

export { A_URL, B_URL, ROUNDS, NOTIMER, stopRequested, ONLY, A_PORT, sleep, log, HUMANS, HUMAN, WATCH, NA, NB, X, Y, Z, GENTLE, TP, FLOOR }
