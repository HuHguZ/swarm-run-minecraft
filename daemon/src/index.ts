'use strict'
require('./speedrun-defaults') // умолчания флагов спидрана — раньше любых чтений env
require('./require-cache')
const gameClock = require('./game-clock')
// 03.10: require('./src/index') ради проверки загрузки поднимал демон на 8765 (порт арены) → 25565 — дважды за день.
// Демон запускается только как точка входа (node src/index.js); проверка загрузки — node --check.
if (require.main !== module) throw new Error('index.js — точка входа демона, не модуль; проверка загрузки — node --check src/index.js')
const { WebSocketServer } = require('ws')
if (process.env.ND_LAG_PROFILE === '1') require('./lag-profile').startLagProfile()
const cfg = require('./config')
const { EventBus } = require('./events')
const { Journal } = require('./journal')
const { Session } = require('./session')
const { Autopilot } = require('./autopilot')
const { Vision } = require('./vision')

const bus = new EventBus()
const journal = new Journal(cfg.memoryDir)
const session = new Session(cfg, bus, journal)
const autopilot = new Autopilot(session, cfg)
// Жесты людей живут на автопилоте (gestures.js), а mc_players читает их через сессию.
session.autopilot = autopilot
// Средний слой: обстановка раз в секунду, шаги к цели, вытеснение (director.js).
const { Director } = require('./director')
const director = new Director(session)
session.director = director
const vision = new Vision(session, cfg)
autopilot.start()
// Ленивые модули боя — заранее, по одному за проход цикла (warm-modules.ts: первая загрузка в бою стоила до 1 с остановки).
gameClock.wall.setTimeout(() => require('./warm-modules').warmModules(), 5000).unref()
const { createMethods } = require('./rpc/methods')
const { attachClients } = require('./rpc/server')

// RPC-методы — по темам в rpc/*.ts (наблюдение, опасности, полёт, рельеф, рой, интенты, правда сцены, директор).
// Слежка за угрозами для арены (12.10, уворот от булавы и зелий): опрос драйвера раз в 250 мс опаздывал на падение
// и бросок; включённая — шлёт { type: 'danger' } подключённому мозгу сразу, как тело увидело угрозу (раз в 50 мс).
// Наблюдение опасностей для драйвера арены (watch_dangers): враги-люди — их прицел, падение с булавой.
const state: { dangerWatch: { foes: string[] } | null } = { dangerWatch: null }
const methods = createMethods({ session, cfg, bus, vision, director, gameClock, state })
const wss = new WebSocketServer({ host: cfg.wsHost, port: cfg.wsPort })
attachClients(wss, { session, gameClock, methods, log, state })

function log (...args: any[]) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args)
}

log(`NeuroDown daemon on ws://${cfg.wsHost}:${cfg.wsPort} -> ${cfg.host}:${cfg.port} as ${cfg.username} (fairPlay=${cfg.fairPlay})`)
// Флаги демона (S1d 07.10: ND_GOLD_ROUTE/ND_ANGER_SAFE стояли в CENV сцены и до демона не доходили) — видны в daemon-*.out.log.
log(`flags: ${Object.keys(process.env).filter(k => /^ND_/.test(k) && !/KEY|TOKEN|SECRET|PASS/.test(k)).sort().map(k => `${k}=${process.env[k]}`).join(' ') || '—'}`)

process.on('SIGINT', async () => {
  autopilot.stop()
  await vision.close()
  session.disconnect('daemon stop')
  process.exit(0)
})
process.on('unhandledRejection', (e: any) => log('unhandledRejection:', String((e && e.message) || e)))
