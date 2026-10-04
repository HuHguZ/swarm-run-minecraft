'use strict'
// Разбор застреваний по журналам фермы (поток unstuck, research/dev-H-unstuck.md).
//   node farm/stuck/scan.js [--since 2026-09-28] [--out farm/stuck/episodes.jsonl] [--samples 3]
// Источник — журналы кампаний farm/results/*/slot-*.campaign.log (настоящее поведение: кампания, этапы, ловушки).
// Строка действия: «[чч:мм:сс + Nм] этап  действие {параметры} → статус hpX едаY (x,y,z) текст».
// Время строки — конец действия; начало — время предыдущей строки того же журнала.
// Эпизод — подряд идущие отказы движения в одном журнале у одной точки (≤ 4 бл. от первой, разрыв ≤ 120 с).
// Потеряно — от начала первого отказа до конца последнего (минимум — длительность первого).
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', 'results')
const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const SINCE = opt('--since', null)
const OUT = opt('--out', path.join(__dirname, 'episodes.jsonl'))
const SAMPLES = Number(opt('--samples', 3))

// ---------------------------------------------------------------- отказ движения → класс
// Порядок важен: первое совпадение. Опасности (вода/лава впереди, моб, хп) — не застревание: тело встало нарочно.
const CLASSES = [
  { id: 'pit-roof', name: 'яма/шахта: не вылезти (над головой лава/вода/нечем копать/строить)',
    re: /из ямы вылез на \d+ — (сверху (lava|water)|(lava|water) за потолком|\S+ голыми руками|нечем строить|столб не встал|выше не поднимаюсь)/ },
  { id: 'buried', name: 'завалило / урон в стене (in_wall): тело в блоке', re: /завалило|урон «in_wall»|события: buried/ },
  { id: 'long-walk', name: 'дальний поход не дошёл (бастион/крепость/портал по памяти)', re: /до бастиона не дошёл|до крепости не добрался|безопасный путь к порталу не пройден/ },
  { id: 'stuck-guard', name: 'тело не сдвигается 8 с при живой цели (stuckGuard)', re: /застрял на \S+ у \S+|не сдвинулся/ },
  { id: 'no-step', name: 'не шагнул (свой шаг штрека/запечатки/бастиона)', re: /не шагнул/ },
  { id: 'tunnel-nopath', name: 'штрек по Аду: «пути нет» / ближе не подойти', re: /штрек встал: (пути нет|к цели штреком ближе не подойти)|штрек по Аду не (довёл|начался)/ },
  { id: 'shaft', name: 'колодец/лесенка не идёт (копаю — не опускаюсь, ступенька)', re: /колодец не идёт|не смог шагнуть на ступеньку|не опускаюсь/ },
  { id: 'place-fail', name: 'блок под ноги не ставится (place_error по кругу)', re: /блок под ноги не ставится/ },
  { id: 'water-exit', name: 'вода: на берег не вышел', re: /на сухой берег не вышел|не нашёл доступного пути из воды|я в воде — тут не окопаешься/ },
  { id: 'surface-wall', name: 'подъём наверх упёрся (вода/потолок)', re: /всё равно упираюсь|не поднялся ни н|туда не копаю, и в сторону не отойти/ },
  { id: 'goto-empty', name: 'goto: путь кончился, цель не достигнута (пустой/частичный путь)', re: /не достиг цели|путь длиной 0|ни шага/ },
  { id: 'goto-nopath', name: 'goto: No path (A* не нашёл пути)', re: /No path to the goal|пути к нему нет|пути нет/ },
  { id: 'goto-timeout', name: 'goto: A* не уложился (Took to long)', re: /Took to long/ },
  { id: 'level', name: 'цель на другой высоте — «не на его уровне»', re: /не на его уровне/ },
  { id: 'goto-other', name: 'goto/подход: не дошёл (прочее)', re: /не дошёл|не добрался|не подошёл|не пройден/ },
  { id: 'ride', name: 'верхом застрял', re: /застрял верхом/ }
]
// Строки, которые содержат слова отказа, но отказом движения не являются.
const NOT_STUCK = /не вижу|не смог добыть \S+: не вижу|бот не в игре|прервано \((chat|gesture)\)|ПЕРЕХОДА НЕТ|горящего портала/

function classify (text) {
  if (!text || NOT_STUCK.test(text) && !/не дошёл|застрял|не шагнул|No path|пути нет/.test(text)) return null
  for (const c of CLASSES) if (c.re.test(text)) return c.id
  return null
}

// ---------------------------------------------------------------- обстановка
const NETHER_BLOCKS = /netherrack|blackstone|basalt|soul_(sand|soil)|warped|crimson|magma|nether_|quartz_ore|nether_gold|glowstone|shroomlight/
const STAGE_DIM = { nether: 'nether', bastion: 'nether', fortress: 'nether', blaze: 'nether', dragon: 'end' }
function tags (text, pos, dim, action) {
  const t = []
  const s = String(text)
  if (/water|вод[аеуыо]|kelp|seagrass|lily_pad|bubble/.test(s)) t.push('вода')
  if (/lava|лав/.test(s)) t.push('лава')
  if (/ladder|лестниц|vine|лиан/.test(s)) t.push('лестница/лиана')
  if (/leaves|листв|azalea/.test(s)) t.push('листва')
  if (/soul_sand|soul_soil|песок душ/.test(s)) t.push('песок душ')
  if (/mud|mangrove|ил\b|болот/.test(s)) t.push('ил/мангры')
  if (/штрек|tunnel|колодец|burrow/.test(s) || /tunnel|burrow/.test(action || '')) t.push('штрек')
  if (/ям[аыу]|шахт|колод/.test(s)) t.push('яма')
  if (/powder_snow|snow/.test(s)) t.push('снег')
  if (/stairs|ступен/.test(s)) t.push('ступени')
  if (/warped_wart|nether_wart_block|fungus|roots/.test(s)) t.push('искажённый/багровый лес')
  if (pos) {
    if (dim === 'overworld') t.push(pos.y < 50 ? 'под землёй' : 'поверхность')
    else if (dim === 'nether') t.push(pos.y < 31 ? 'Ад низ (лавовое море)' : pos.y > 100 ? 'Ад верх' : 'Ад середина')
  }
  return t
}

// ---------------------------------------------------------------- журнал кампании
const LINE = /^\[(\d\d):(\d\d):(\d\d) \+\s*(\d+)м\] (\S+)\s+(.*)$/
function parseLog (file) {
  const txt = fs.readFileSync(file, 'utf8')
  const rows = []
  let dayOfs = 0
  let prevT = null
  let date = null
  for (const raw of txt.split(/\r?\n/)) {
    const h = raw.match(/^==== (\d{4}-\d\d-\d\d) (\d\d):(\d\d):(\d\d) запуск/)
    if (h) { date = h[1]; dayOfs = 0; prevT = null; rows.push({ kind: 'start', date }); continue }
    const m = raw.match(LINE)
    if (!m) continue
    let t = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + dayOfs
    if (prevT != null && t < prevT - 43200) { dayOfs += 86400; t += 86400 }
    prevT = t
    const stage = m[5]
    const body = m[6]
    const r = { kind: 'line', t, min: +m[4], stage, body, date }
    const arrow = body.indexOf(' → ')
    if (arrow > 0) {
      const left = body.slice(0, arrow)
      const right = body.slice(arrow + 3)
      const a = left.match(/^(\S+)\s*(\{.*\})?/)
      r.action = a ? a[1] : left
      r.params = a && a[2] ? a[2] : null
      const st = right.match(/^(\w+)/)
      r.status = st ? st[1] : null
      const hp = right.match(/hp(\d+(?:\.\d+)?) еда(\d+|\?)/)
      if (hp) r.hp = Number(hp[1])
      const p = right.match(/\((-?\d+),(-?\d+),(-?\d+)\)/)
      if (p) r.pos = { x: +p[1], y: +p[2], z: +p[3] }
      r.text = p ? right.slice(right.indexOf(p[0]) + p[0].length).trim() : right
    } else r.text = body
    rows.push(r)
  }
  return rows
}

const dist = (a, b) => (a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : Infinity)

function scanLog (file, meta) {
  const rows = parseLog(file)
  const eps = []
  let dim = meta.startDim || 'overworld'
  let lastPos = null
  let prevT = null
  let ep = null
  const close = (endIdx) => {
    if (!ep) return
    // Исход: что было после эпизода.
    let outcome = 'конец журнала'
    let after = null
    for (let j = endIdx + 1; j < rows.length; j++) {
      const r = rows[j]
      if (r.kind === 'start') { outcome = 'перезапуск кампании'; break }
      const tx = r.text || ''
      if (/умер|DIED|этап упал: умер/.test(tx) || /умер/.test(r.body || '')) { outcome = 'смерть'; after = r.t - ep.t1; break }
      if (/сторож|WATCHDOG/.test(r.body || '')) { outcome = 'WATCHDOG'; after = r.t - ep.t1; break }
      if (r.pos && dist(r.pos, ep.at) > 6) { outcome = 'ушёл (другим планом/сам)'; after = r.t - ep.t1; break }
      if (/итог этапа: НЕ ГОТОВ|этап отложен|пауза \d+ мин|этап .*: .*пауза/.test(r.body || '')) { outcome = 'этап остановлен/отложен'; after = r.t - ep.t1; break }
      if (r.t - ep.t1 > 1800) break
    }
    ep.outcome = outcome
    ep.afterSec = after
    ep.lostSec = Math.max(ep.firstDur, ep.t1 - ep.t0)
    delete ep.firstDur
    eps.push(ep)
    ep = null
  }
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (r.kind === 'start') { close(i - 1); prevT = null; dim = meta.startDim || 'overworld'; continue }
    const tx = (r.text || '') + ' ' + (r.action === undefined ? r.body : '')
    // Измерение
    if (/Я в Аду|в Аду на /.test(tx)) dim = 'nether'
    else if (/в верхнем мире|в Верхнем мире|вышел домой|дома, в верхнем/.test(tx)) dim = 'overworld'
    else if (/умер|DIED/.test(tx)) { /* возрождение — в верхнем мире после этой строки */ }
    if (STAGE_DIM[r.stage]) dim = STAGE_DIM[r.stage]
    else if (NETHER_BLOCKS.test(tx) && r.pos && r.pos.y < 128 && r.pos.y > 0) dim = 'nether'
    const dur = prevT != null ? r.t - prevT : 0
    prevT = r.t
    if (r.pos) lastPos = r.pos
    const cls = classify(r.text || r.body)
    if (cls) {
      const at = r.pos || lastPos
      if (ep && (dist(at, ep.at) <= 4 || !at) && r.t - ep.t1 <= 120) {
        ep.n++
        ep.t1 = r.t
        ep.classes[cls] = (ep.classes[cls] || 0) + 1
        if (r.hp != null) ep.hpMin = Math.min(ep.hpMin ?? 99, r.hp)
        if (!ep.actions.includes(r.action || r.stage)) ep.actions.push(r.action || r.stage)
        if (ep.texts.length < 3 && !ep.texts.includes(short(r.text || r.body))) ep.texts.push(short(r.text || r.body))
      } else {
        close(i - 1)
        ep = {
          src: meta.src, scene: meta.scene, tag: meta.tag, slot: meta.slot, date: r.date, clock: hhmm(r.t), min: r.min,
          stage: r.stage, dim, at, t0: r.t - dur, t1: r.t, firstDur: dur, n: 1, classes: { [cls]: 1 }, cls,
          actions: [r.action || r.stage], params: r.params ? r.params.slice(0, 160) : null, hpMin: r.hp,
          texts: [short(r.text || r.body)], tags: tags(tx, at, dim, r.action), env: meta.env
        }
      }
    } else if (ep && r.pos && dist(r.pos, ep.at) > 6) {
      close(i - 1)
    } else if (ep && /умер|DIED/.test(tx)) {
      ep.t1 = Math.max(ep.t1, r.t)
      close(i - 1)
    }
    if (/умер|DIED/.test(tx) && !STAGE_DIM[r.stage]) dim = 'overworld'
  }
  close(rows.length - 1)
  return { eps, rows: rows.length, span: (() => { const ts = rows.filter(r => r.t != null).map(r => r.t); return ts.length ? ts[ts.length - 1] - ts[0] : 0 })() }
}
const short = s => String(s || '').replace(/\s+/g, ' ').slice(0, 220)
const hhmm = t => { const s = ((t % 86400) + 86400) % 86400; return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}` }

// ---------------------------------------------------------------- обход
function main () {
  const dirs = fs.readdirSync(ROOT)
  const all = []
  let logs = 0
  let runSec = 0
  const perScene = {}
  for (const d of dirs) {
    const dir = path.join(ROOT, d)
    let files
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.campaign.log')) } catch { continue }
    if (!files.length) continue
    let batch = {}
    try { batch = JSON.parse(fs.readFileSync(path.join(dir, 'batch.json'), 'utf8')) } catch {}
    if (SINCE && batch.at && batch.at.slice(0, 10) < SINCE) continue
    const env = batch.env ? Object.entries(batch.env).filter(([k]) => /^ND_|STAGES|KIT|UNTIL|CENV/.test(k)).map(([k, v]) => `${k}=${v}`).join(' ').slice(0, 200) : ''
    const startDim = batch.env && /nether/.test(String(batch.env.STAGES || '')) && /post|nether/.test(String(batch.env.KIT || '')) ? 'nether' : 'overworld'
    for (const f of files) {
      const slot = Number((f.match(/slot-(\d+)/) || [])[1])
      const r = scanLog(path.join(dir, f), { src: `${d}/${f}`, scene: batch.scene || '?', tag: d, slot, env, startDim })
      logs++
      runSec += r.span
      const sc = batch.scene || '?'
      perScene[sc] = perScene[sc] || { logs: 0, sec: 0, eps: 0, lost: 0 }
      perScene[sc].logs++; perScene[sc].sec += r.span; perScene[sc].eps += r.eps.length; perScene[sc].lost += r.eps.reduce((s, e) => s + e.lostSec, 0)
      all.push(...r.eps)
    }
  }
  fs.writeFileSync(OUT, all.map(e => JSON.stringify(e)).join('\n') + '\n')
  // Сводка по классам
  const by = {}
  for (const e of all) {
    const b = by[e.cls] = by[e.cls] || { n: 0, lost: [], out: {}, dims: {}, tags: {}, acts: {}, deaths: 0, retries: 0 }
    b.n++; b.lost.push(e.lostSec); b.retries += e.n
    b.out[e.outcome] = (b.out[e.outcome] || 0) + 1
    b.dims[e.dim] = (b.dims[e.dim] || 0) + 1
    for (const t of e.tags) b.tags[t] = (b.tags[t] || 0) + 1
    for (const a of e.actions) b.acts[a] = (b.acts[a] || 0) + 1
  }
  const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0 }
  const top = (o, k = 4) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, k).map(([x, n]) => `${x} ${n}`).join(', ')
  console.log(`журналов кампаний: ${logs}, часов прогона: ${(runSec / 3600).toFixed(1)}, эпизодов: ${all.length}, потеряно: ${(all.reduce((s, e) => s + e.lostSec, 0) / 3600).toFixed(2)} ч`)
  const rowsOut = Object.entries(by).sort((a, b) => b[1].lost.reduce((s, x) => s + x, 0) - a[1].lost.reduce((s, x) => s + x, 0))
  for (const [cls, b] of rowsOut) {
    const sum = b.lost.reduce((s, x) => s + x, 0)
    const c = CLASSES.find(x => x.id === cls)
    console.log(`\n## ${cls} — ${c ? c.name : ''}\n  эпизодов ${b.n}, отказов ${b.retries}, потеряно ${(sum / 60).toFixed(1)} мин (медиана ${med(b.lost)} с, p90 ${med(b.lost.filter(x => x >= med(b.lost)))} с)` +
      `\n  измерение: ${top(b.dims)}\n  обстановка: ${top(b.tags, 8)}\n  действия: ${top(b.acts, 6)}\n  исход: ${top(b.out, 6)}`)
    const samp = all.filter(e => e.cls === cls).sort((a, b) => b.lostSec - a.lostSec).slice(0, SAMPLES)
    for (const e of samp) console.log(`   · ${e.src} ${e.clock} ${e.stage} ${e.dim} ${e.at ? `${e.at.x},${e.at.y},${e.at.z}` : '?'} ×${e.n} ${e.lostSec}s → ${e.outcome} | ${e.texts[0]}`)
  }
  console.log('\n## по сценам')
  for (const [sc, s] of Object.entries(perScene).sort((a, b) => b[1].lost - a[1].lost)) console.log(`  ${sc}: журналов ${s.logs}, ч ${(s.sec / 3600).toFixed(1)}, эпизодов ${s.eps}, потеряно ${(s.lost / 60).toFixed(1)} мин (${(100 * s.lost / Math.max(1, s.sec)).toFixed(1)} %)`)
}

if (require.main === module) main()
module.exports = { classify, parseLog, scanLog, CLASSES }
