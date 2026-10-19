'use strict'
// Кампания — автомат этапов спидрана: node dist/daemon/campaign.js [этап,…]. WebSocket-клиент демона (ND_WS).
// Код — в daemon/campaign/: flags (настройки), rpc (сокет и call), state (общее состояние и сеттеры), log, queries, observe,
// stages/table (STAGES, READY/DEFER/DONE), навыки (act, danger, guards, travel, kit, …), stages/* (defStage по порядку
// stages/all) и loop (главный цикл). Здесь — только запуск.
import { WS, LOG } from './campaign/flags'
import { connect, ws } from './campaign/rpc'
import './campaign/stages/all'
import { assertStageOrder } from './campaign/stages/table'
import { runCampaign } from './campaign/loop'
const fs: typeof import('fs') = require('fs')

if (require.main === module) { try { fs.appendFileSync(LOG, `==== ${new Date().toISOString().slice(0, 10)} ${new Date().toTimeString().slice(0, 8)} запуск кампании, pid ${process.pid}, этапы: ${process.argv[2] || 'все'} ====
`) } catch {} }
assertStageOrder()
connect(WS)
ws.on('open', runCampaign)
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })
