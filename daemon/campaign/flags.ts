'use strict'
// Настройки запуска кампании: адрес демона, журнал, выбранные этапы и флаги окружения, которые читаются при загрузке.
// Первый импорт входа: умолчание ND_NE_RECOVER ставится раньше, чем его прочтёт кто-то ещё.
import * as path from 'path'
import { REPO_ROOT } from '../src/paths'
const WS = process.env.ND_WS || 'ws://127.0.0.1:8769'
const LOG = process.env.ND_CAMPAIGN_LOG || path.join(REPO_ROOT, 'daemon/campaign.log')
const only = process.argv[2] ? process.argv[2].split(',') : null
// J2 uses B7's shared recovery; an explicitly selected B7 control still wins.
if ((!only || only.includes('nether')) && process.env.ND_FORTRESS_CONTINUE !== '0' && process.env.ND_FORTRESS_FRONTIER !== '0' && process.env.ND_NE_RECOVER === undefined) process.env.ND_NE_RECOVER = '1'
const PAUSE_MIN = [5, 10, 20, 40]
const WATCHDOG_MIN = Math.max(1, Number(process.env.ND_WATCHDOG_MIN) || 45)
const E2E = process.env.ND_E2E === '1'
const SEAM_FLAGS = ['ND_E2E', 'ND_END_SEAM', 'ND_ENDKIT', 'ND_END_PREP_PRICE', 'ND_WORLD_SEED', 'ND_EYES_NEED',
  'ND_ROUTE', 'ND_ROUTE_FOOD2', 'ND_OW_DEEP', 'ND_OW_HEAR', 'ND_PORTAL_NATURAL',
  'ND_BASTION_FIRST', 'ND_NE_ROUTE', 'ND_NE_STAY', 'ND_SH_NETHER', 'ND_SH_STAY', 'ND_SH_BLIND', 'ND_OBS_EXIT',
  'ND_SEALED_BREACH', 'ND_SPAWNER_TUNNEL', 'ND_FORTRESS_FRONTIER', 'ND_FORTRESS_CONTINUE', 'ND_GOLD_FAST_SAFE', 'ND_GUARD', 'ND_BLAZE_FP', 'ND_ENDERMEN',
  'ND_NE_RECOVER', 'ND_EM_PRICE_RECEIPTS', 'ND_EMERGENCY', 'ND_UNSTUCK', 'ND_BRIDGE', 'ND_SPRINT', 'ND_PEARL_GOTO',
  'ND_RUNNER', 'ND_RUN_SWORD', 'ND_RUN_SWORD_PED', 'ND_CRYSTALS', 'ND_CRYS_KEEP', 'ND_DIGUP', 'ND_DIGUP_FIRST']

const NIGHT_DOWN = process.env.ND_NIGHT_DOWN !== '0'
function NIGHT_DOWN2 () { const v = process.env.ND_NIGHT_DOWN; return v === undefined || v === '' || v === '2' }

const OW_DEEP = process.env.ND_OW_DEEP === '1'
const OW_SHAFT = process.env.ND_OW_SHAFT !== '0'
const OW_HEAR = process.env.ND_OW_HEAR !== '0'
const DEEP_Y = -54

const ROUTE = process.env.ND_ROUTE === '1'
const EYES_NEED = Math.max(1, Math.min(12, Number(process.env.ND_EYES_NEED) || 12))

const BEDS_END = 5 // 03.10: с кристаллами 4 кровати — 18/21 и 18/21 (ca3, проверка xda1), берём 4 + 1 запас
const END_PREP_PRICE = process.env.ND_END_PREP_PRICE === '1'

export { WS, LOG, only, PAUSE_MIN, WATCHDOG_MIN, E2E, SEAM_FLAGS, NIGHT_DOWN, NIGHT_DOWN2, OW_DEEP, OW_SHAFT, OW_HEAR,
  DEEP_Y, ROUTE, EYES_NEED, BEDS_END, END_PREP_PRICE }
