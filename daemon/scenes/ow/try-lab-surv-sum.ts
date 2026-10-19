'use strict'
import { REPO_ROOT } from '../../src/paths'
// Сводка серий потока survival (research/dev-B-refuge.md) — по итогам farm/results/<tag>/slot-N.jsonl и журналам кампании.
//   node try-lab-surv-sum.js camp <tag> [<tag>...]   начало кампании (try-lab-surv-camp / try-lab-fresh): смерти в час,
//                                                   DEATH_LOOP, первая смерть, простой (wait + пересидка в отходе > 30 с)
//   node try-lab-surv-sum.js trap <tag> [<tag>...]   ловушки (try-lab-surv-trap): выжил/n по классам, смерти, возврат
//                                                   к делу (после «стихло» и после последней защиты), простой, minHp
import * as fs from 'fs'
import path = require('path')
const ROOT = path.join(REPO_ROOT, 'farm/results')
const med = a => { const b = a.filter(x => typeof x === 'number').sort((x, y) => x - y); return b.length ? b[Math.floor((b.length - 1) / 2)] : null }

function records (tag) {
  const dir = path.join(ROOT, tag)
  const out = []
  for (const f of fs.readdirSync(dir).filter(f => /^slot-\d+\.jsonl$/.test(f))) {
    for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean)) { try { out.push(JSON.parse(l)) } catch {} }
  }
  const text = r => { try { return fs.readFileSync(path.join(dir, r.campaignLog), 'utf8') } catch { return '' } }
  return out.map(r => ({ r, text: text(r) }))
}

// Простой: wait кампании и пересидка в отходе — всё, что дольше 30 с на отход (стройка — секунды; дольше — сидит).
function idleSeconds (text) {
  let s = 0
  for (const l of String(text || '').split('\n')) {
    const w = / wait \{"seconds":(\d+)\}/.exec(l)
    if (w) { s += Number(w[1]); continue }
    const r = / refuge \{.*?(\d+(?:\.\d+)?) с(?=[\s;|]|$)/.exec(l) || /отход кончился: .*?, (\d+(?:\.\d+)?) с;/.exec(l)
    if (r) s += Math.max(0, Number(r[1]) - 30)
  }
  return Math.round(s)
}

// Отход/пересидка, не кончившиеся к концу раунда (в журнале ещё нет строки refuge): «прячусь…» последней строкой —
// до конца раунда это тоже простой (за вычетом 30 с стройки).
function openTail (text, roundS) {
  const lines = String(text || '').split('\n').filter(l => /^\[\d\d:\d\d:\d\d/.test(l))
  const m0 = /^==== \S+ (\d\d):(\d\d):(\d\d)/.exec(String(text || ''))
  const last = lines[lines.length - 1]
  if (!m0 || !last || !/прячусь|отлёживаюсь|сижу|идёт аварийный отход/.test(last) || !roundS) return 0
  const m = /^\[(\d\d):(\d\d):(\d\d)/.exec(last)
  let at = (+m[1] - +m0[1]) * 3600 + (+m[2] - +m0[2]) * 60 + (+m[3] - +m0[3]); if (at < 0) at += 86400
  return Math.max(0, Math.round(roundS - at - 30))
}

// Возврат к делу без «стихло» (ночью под землёй мобы наверху ближе 8 бл. всегда): от начала раунда до первого рабочего
// шага (done), кончившегося после последней защиты в первые 3 мин (нора/отход/бегство/бой не за едой).
function backAfterDefense (text) {
  const WORK = /^(mine|mine_seen|dig_down|tunnel|explore|goto|craft|smelt|collect|place|build|chest_put|chest_take)$/
  const lines = String(text || '').split('\n')
  const m0 = /^==== \S+ (\d\d):(\d\d):(\d\d)/.exec(lines[0] || '')
  if (!m0) return null
  const t = l => { const m = /^\[(\d\d):(\d\d):(\d\d)/.exec(l); if (!m) return null; let s = (+m[1] - +m0[1]) * 3600 + (+m[2] - +m0[2]) * 60 + (+m[3] - +m0[3]); if (s < 0) s += 86400; return s }
  let lastDef = null
  const work = []
  for (const l of lines) {
    const s = t(l); if (s === null) continue
    const m = /^\[[^\]]+\] \S+\s+([a-z_]+) (\{.*?\}) → (\w+)/.exec(l)
    const def = (m && /^(shelter|refuge|flee)$/.test(m[1])) || (m && m[1] === 'fight' && !/"purpose":"food"/.test(m[2])) || /отход кончился/.test(l)
    if (def && s <= 180) lastDef = s
    if (m && WORK.test(m[1]) && m[3] === 'done') work.push(s)
  }
  return work.find(s => lastDef === null || s > lastDef) ?? null
}

function camp (tags) {
  const first = []; let H = 0; let D = 0; let N = 0; let loop = 0; let idle = 0
  const causes: Record<string, any> = {} as Record<string, any>
  for (const tag of tags) {
    for (const { r, text } of records(tag)) {
      const deaths = r.deaths || []
      const fd = text.split('\n').find(l => /прервано: death|кончился: .*DIED|код DIED/.test(l))
      const fdm = fd ? (/\+\s*(\d+)м\]/.exec(fd) || [])[1] : null
      if (fdm != null) first.push(+fdm)
      for (const d of deaths) { const k = d.replace(/^NeuroFarm\d+ /, '').replace(/ using .*/, ''); causes[k] = (causes[k] || 0) + 1 }
      const i = idleSeconds(text)
      H += r.minutes / 60; D += deaths.length; N++; idle += i
      if (/^DEATH_LOOP/.test(r.class || '')) loop++
      const miles = Object.entries<any>(r.miles || {} as Record<string, any>).map(([k, v]: any) => `${k}${typeof v === 'object' ? v.minute ?? '' : v}`).join(' ')
      console.log(`${tag} ${String(r.seed).padStart(20)} ${String(r.class).padEnd(22)} ${r.minutes}м смертей ${deaths.length} простой ${i} с | ${miles} | ${deaths.join('; ').slice(0, 160)}`)
    }
  }
  console.log(`ИТОГО: прогонов ${N}, часов ${H.toFixed(2)}, смертей ${D} → ${(D / Math.max(H, 1e-9)).toFixed(2)}/ч, DEATH_LOOP ${loop}/${N}, простой ${Math.round(idle / Math.max(N, 1))} с/прогон`)
  console.log('причины:', JSON.stringify(causes))
  console.log('первая смерть, мин:', first.join(' ') || '—', '| прогонов без смерти:', N - first.length, 'из', N)
}

function trap (tags) {
  const by: Record<string, any> = {} as Record<string, any>
  for (const tag of tags) {
    for (const { r, text } of records(tag)) {
      const v = by[r.variant] = by[r.variant] || { n: 0, ok: 0, err: 0, deaths: 0, back: [], back2: [], idle: [], minHp: [], msgs: [] }
      if (!r.fixtureReady) { v.err++; continue }
      v.n++
      // Смерть, которую сцена не увидела (журнал сервера начался заново в полночь), — по журналу кампании.
      const missed = r.survived && /этап упал: умер|прервано: death|кончился: [^\n]*DIED/.test(text)
      if (missed) { r.survived = false; r.deaths = 1; r.deathMsgs = ['(смерть по журналу кампании: сцена не увидела)'] }
      if (r.survived) v.ok++
      v.deaths += r.deaths || 0
      if (r.backS != null) v.back.push(r.backS)
      const b2 = backAfterDefense(text)
      if (b2 != null && r.survived) v.back2.push(b2)
      v.idle.push(text ? idleSeconds(text) + openTail(text, r.seconds) : (r.idleS ?? null))
      v.minHp.push(r.minHp)
      for (const m of r.deathMsgs || []) v.msgs.push(`${tag}/s${r.slot}r${r.round}: ${m.replace(/^NeuroFarm\d+ /, '')}`)
    }
  }
  let N = 0; let OK = 0
  for (const [k, v] of Object.entries<any>(by)) {
    N += v.n; OK += v.ok
    console.log(`${k.padEnd(8)} выжил ${v.ok}/${v.n}${v.err ? ` (+${v.err} ошибок сцены)` : ''}, смертей ${v.deaths}; возврат к делу: после защиты ${med(v.back2)} с (${v.back2.length}), после «стихло» ${med(v.back)} с (${v.back.length}); простой ${med(v.idle)} с; minHp ${med(v.minHp)} (медианы)`)
    for (const m of v.msgs) console.log('    ' + m)
  }
  console.log(`всего ${OK}/${N}`)
}

const [mode, ...tags] = process.argv.slice(2)
if (mode === 'camp' && tags.length) camp(tags)
else if (mode === 'trap' && tags.length) trap(tags)
else { console.error('node try-lab-surv-sum.js camp|trap <tag> [<tag>...]'); process.exit(1) }
