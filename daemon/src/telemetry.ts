'use strict'
const { REPO_ROOT }: typeof import('./paths') = require('./paths')
// Телеметрия навыков — шаг 1 направления «Стратегический граф + навыки + рефлексы + WorldState + телеметрия»
// (TODO.md, пользователь 05.10). Только запись: поведение бота не меняется. Строка JSONL на каждое выполнение:
//   level 'stage' — этап кампании (wood … dragon), level 'step' — шаг плана маршрута (будущие стратегии графа:
//   голем/жила/сундуки/лава…), level 'act' — вызов навыка демона (RPC). Из этих строк потом считаются цены
//   стратегий (V2) и вероятности исходов (V3): farm/analysis/skills-report.js.
// Файл — ND_SKILLS_LOG или рядом с журналом кампании: <журнал без .campaign.log/.log>.skills.jsonl. ND_TELEMETRY=0 — выкл.
const fs: typeof import('fs') = require('fs')
const path: typeof import('path') = require('path')
const crypto: typeof import('crypto') = require('crypto')
const gameClock: typeof import('./game-clock') = require('./game-clock')

const on = () => process.env.ND_TELEMETRY !== '0'

// Ресурсы, по которым меряется прогресс прохождения (счётчики рюкзака).
const RES = {
  logs: /_(log|stem)$/,
  planks: /_planks$/,
  cobble: /^(cobblestone|cobbled_deepslate|blackstone)$/,
  blocks: /^(cobblestone|cobbled_deepslate|blackstone|netherrack|dirt|stone|deepslate|[a-z_]+_planks)$/,
  iron: /^(raw_iron|iron_ingot)$/,
  ironNuggets: /^iron_nugget$/,
  gold: /^(raw_gold|gold_ingot)$/,
  goldBlocks: /^gold_block$/,
  diamonds: /^diamond$/,
  obsidian: /^obsidian$/,
  cryingObsidian: /^crying_obsidian$/,
  flint: /^flint$/,
  flintSteel: /^flint_and_steel$/,
  fireCharge: /^fire_charge$/,
  waterBucket: /^water_bucket$/,
  lavaBucket: /^lava_bucket$/,
  bucket: /^bucket$/,
  beds: /_bed$/,
  wool: /_wool$/,
  pearls: /^ender_pearl$/,
  rods: /^blaze_rod$/,
  powder: /^blaze_powder$/,
  eyes: /^ender_eye$/,
  string: /^string$/,
  food: /^(cooked_[a-z_]+|bread|baked_potato|golden_carrot|apple|carrot|potato|beetroot|melon_slice|sweet_berries|beef|porkchop|mutton|chicken|rabbit|cod|salmon)$/,
  gapple: /^(golden_apple|enchanted_golden_apple)$/,
  arrows: /^(arrow|spectral_arrow|tipped_arrow)$/,
  shield: /^shield$/,
  fireRes: /^(potion|splash_potion)$/
}
const PICK = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']

function resources (inv) {
  const out: any = {}
  for (const [k, re] of (Object.entries(RES) as [string, any][])) {
    let n = 0
    for (const [name, c] of (Object.entries(inv || {}) as [string, any][])) if (re.test(name)) n += Number(c) || 0
    if (n) out[k] = n
  }
  const pick = PICK.find(t => (inv || {})[`${t}_pickaxe`] > 0)
  if (pick) out.pick = pick
  const sword = PICK.find(t => (inv || {})[`${t}_sword`] > 0)
  if (sword) out.sword = sword
  return out
}

// Признаки состояния (будущий WorldState): тело, ресурсы, сутки, угрозы. Без полного рюкзака — компактно.
function snapshot (state: any = {}, sit: any = {}) {
  const p = state.pos
  const armor = state.armor ? (Object.values(state.armor) as any[]).filter(Boolean).length : undefined
  return {
    dim: state.dimension || null,
    pos: p ? { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) } : null,
    hp: state.health != null ? Math.round(state.health) : null,
    food: state.food ?? null,
    armor,
    res: resources(state.inventory),
    tod: sit.tod ?? null,
    night: sit.night ?? null,
    surface: sit.surface ?? null,
    ...(sit.work ? { work: { block: sit.work.block ?? null, sky: sit.work.sky ?? null, walls: sit.work.walls,
      roof: sit.work.roof, floor: sit.work.floor, sealed: sit.work.sealed } } : {}),
    foes: sit.foes ?? null,
    inWater: sit.inWater ?? null
  }
}

// Прирост ресурсов между двумя снимками (только изменившиеся).
function delta (a, b) {
  const out = {}
  const ra = (a && a.res) || {}
  const rb = (b && b.res) || {}
  for (const k of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
    if (k === 'pick' || k === 'sword') { if (ra[k] !== rb[k]) out[k] = rb[k] || null; continue }
    const d = (rb[k] || 0) - (ra[k] || 0)
    if (d) out[k] = d
  }
  return out
}

let VERSION = null
// Хеш исходников включает вложенные навыки и не зависит от карт esbuild.
function version () {
  if (VERSION) return VERSION
  const root = REPO_ROOT
  let git = null
  try {
    const head = fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim()
    git = head.startsWith('ref: ') ? fs.readFileSync(path.join(root, '.git', head.slice(5)), 'utf8').trim().slice(0, 7) : head.slice(0, 7)
  } catch {}
  const h = crypto.createHash('sha1')
  try { h.update(fs.readFileSync(path.join(__dirname, '..', fs.existsSync(path.join(__dirname, '..', 'campaign.ts')) ? 'campaign.ts' : 'campaign.js'))) } catch {}
  // Тело кампании — daemon/campaign/**: этапы и навыки живут там, вход campaign.ts только запускает их.
  try {
    const body = path.join(__dirname, '..', 'campaign')
    const parts = fs.readdirSync(body, { recursive: true }) as string[]
    const extension = parts.some(f => f.endsWith('.ts')) ? '.ts' : '.js'
    for (const f of parts.filter(f => f.endsWith(extension)).sort()) {
      h.update('campaign/' + f.replaceAll(path.sep, '/'))
      h.update(fs.readFileSync(path.join(body, f)))
    }
  } catch {}
  try {
    const files = fs.readdirSync(__dirname, { recursive: true }) as string[]
    const extension = files.some(f => f.endsWith('.ts')) ? '.ts' : '.js'
    for (const f of files.filter(f => f.endsWith(extension)).sort()) {
      h.update(f.replaceAll(path.sep, '/'))
      h.update(fs.readFileSync(path.join(__dirname, f)))
    }
  } catch {}
  VERSION = { git, code: h.digest('hex').slice(0, 10) }
  return VERSION
}

function file () {
  if (process.env.ND_SKILLS_LOG) return process.env.ND_SKILLS_LOG
  const log = process.env.ND_CAMPAIGN_LOG
  // Unit tests (node --test sets NODE_TEST_CONTEXT) wrote fake-bot rows with manual clocks into the daemons' shared file.
  if (!log) return process.env.NODE_TEST_CONTEXT ? path.join((require('os') as typeof import('os')).tmpdir(), 'nd-test-skills.jsonl') : path.join(REPO_ROOT, 'daemon/skills.jsonl')
  return log.replace(/(\.campaign)?\.log$/, '') + '.skills.jsonl'
}

const RUN = `${process.pid}-${Date.now().toString(36)}`
// Уровень знания карты (S10, perception/knowledge): rsg — главная метрика, ssg/scan — отдельные строки.
function knowledgeLevel () { try { return (require('./perception/knowledge') as typeof import('./perception/knowledge')).level() } catch { return null } }
let seq = 0
function record (rec) {
  if (!on()) return
  try {
    const clock = gameClock.snapshot()
    const line = { v: 1, run: RUN, seq: ++seq, at: new Date().toISOString(), seed: process.env.ND_WORLD_SEED || null, knowledge: knowledgeLevel(), ver: version(),
      clock: clock ? 'game' : 'wall', tickRate: clock?.tickRate ?? 20, ticks: typeof rec.sec === 'number' ? Math.round(rec.sec * 20) : null, ...rec }
    fs.appendFileSync(file(), JSON.stringify(line) + '\n')
  } catch {}
}

// Итог вызова навыка демона: успех/код/причина — по полям ответа RPC (session.resultCode).
function outcome (r) {
  if (!r) return { ok: false, status: 'none' }
  const d = r.detail || {}
  const death = r.by?.type === 'death' || (r.events || []).some(e => e.type === 'death')
  const code = r.code && r.code !== 'OK' ? r.code : null
  const why = r.error || d.stopped || (r.by ? `прервано: ${r.by.type}` : null) || (d.need ? `need: ${JSON.stringify(d.need)}` : null)
  return { ok: r.status === 'done' && !code && !death, status: r.status, code, death, why: why ? String(why).slice(0, 240) : null }
}

module.exports = { on, resources, snapshot, delta, version, file, record, outcome }
export { on, resources, snapshot, delta, version, file, record, outcome }
