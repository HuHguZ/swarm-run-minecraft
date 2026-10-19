'use strict'
// Ход по сетке Ада (nether-route.ts): цена ударов кирки, квитанции цены, сетка копии мира, мелочи.
import * as NG from '../nether-grid'
import { ReceiptCostWindow } from '../environments/receipt-cost'
import * as gameClock from '../game-clock'
import * as fs from 'fs'
import * as path from 'path'

export const { C, DIG } = NG
const receiptCosts = new WeakMap<object, import('../environments/receipt-cost').ReceiptCostWindow>()
export interface RouteSupplyNeed {
  pickSwings: number
  requiredSwings: number
  woodEquivalent: number
  requiredWood: 8
  table: boolean
}
export interface NetherRouteResult {
  ok: boolean
  why?: string
  steps: number
  dug: number
  plans: number
  goal: { x: number; y: number; z: number; r: number; dy: number }
  own?: Set<string>
  at?: { x: number; y: number; z: number }
  seconds?: number
  placed?: number
  supplyNeeded?: RouteSupplyNeed
}
/** Ресурс кирок: удары кирок в рюкзаке + каменные кирки, которые можно сделать из дерева и камня (по 131). */
export function swingsLeft (bot) {
  const items = bot.inventory ? bot.inventory.items() : []
  const n = re => items.reduce((k, i) => k + (re.test(i.name) ? i.count : 0), 0)
  let swings = 0
  for (const i of items) {
    if (!/_pickaxe$/.test(i.name)) continue
    const max = i.maxDurability || bot.registry?.itemsByName?.[i.name]?.maxDurability || 0
    swings += Math.max(0, max - (i.durabilityUsed || 0))
  }
  const wood = n(/_planks$/) + 4 * n(/_(log|stem)$/) + n(/^stick$/) / 2
  return swings + Math.min(Math.floor(wood), Math.floor(n(/^(cobblestone|blackstone|cobbled_deepslate)$/) / 3)) * 131
}
/** Цена удара кирки в плане хода (с за копку): S1d 07.10 — штрек копал 1300–3800 блоков за прогон (≈2 на шаг), доски кончались к
 *  40–47-й мин → «для ифритов не хватает кирки — домой» (s1d-AB-3 A: 38 мин наверху). Запаса много — ~0; к 500 ударам ~0.4, к 300 —
 *  ~0.7 (дороже открытого шага 0.8): ход идёт открытым там, где это дёшево, а не штреком. ND_SWING_PRICE=0 — выкл. */
export function swingPrice (bot) {
  if (process.env.ND_SWING_PRICE === '0') return 0
  return Math.max(0, 250 / Math.max(swingsLeft(bot), 100) - 0.1)
}
export function receiptCostFor (session) {
  const bot = session.bot
  let costs = receiptCosts.get(bot)
  if (!costs) { costs = new ReceiptCostWindow(); receiptCosts.set(bot, costs) }
  const tickRate = bot.ndClock?.snapshot?.().tickRate ?? gameClock.snapshot?.().tickRate ?? 20
  return { costs, swing: swingPrice(bot), context: `${bot.game?.dimension || 'unknown'}|${bot.version || 'unknown'}|${tickRate}` }
}
export const budgetOn = () => process.env.ND_NE_PLAN !== '0'

export const sleep = ms => new Promise<any>(resolve => gameClock.setTimeout(resolve, ms))
export const log = (what, o) => console.log('[route]', new Date().toTimeString().slice(0, 8), what, JSON.stringify(o))
export const xyz = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })

let cached = null
export function gridOf (session) {
  const dir = session && session.cfg && session.cfg.memoryDir
  if (!dir) return null
  // S1f (аудит S10): сетка Ада — скан копии мира, читать только на уровне знания scan (rsg/ssg — вслепую, без сетки).
  if (!(require('../perception/knowledge') as typeof import('../perception/knowledge')).allows('grid', 'nether-route')) return null
  let st
  try { st = fs.statSync(path.join(dir, 'nether-grid.json')) } catch { return null }
  if (cached && cached.dir === dir && cached.mtime === st.mtimeMs) return cached.grid
  const g = NG.load(dir)
  cached = { dir, mtime: st.mtimeMs, grid: g }
  return g
}
// По умолчанию вкл. с 03.10 08:10 (замер D5: 1/8 в Энде, смертей 3/8 против 0/17 и 15/17 без хода по сетке; ход
// работает только при сетке копии мира в памяти — без неё ничего не меняется). Откат — ND_NE_ROUTE=0.
export const enabled = () => process.env.ND_NE_ROUTE !== '0'

// --- исполнение -----------------------------------------------------------------------------------------------
export function feetCell (bot) { const p = bot.entity.position; const f = p.floored(); return (bot.entity.onGround && p.y - f.y >= 0.8) ? f.offset(0, 1, 0) : f }
