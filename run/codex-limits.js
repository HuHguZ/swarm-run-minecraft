'use strict'
// Лимиты Codex, чтобы работать без него, пока он на лимите, и вернуться к нему после сброса
// (просьба пользователя 29.09). Лимита два: окно 5 ч (primary) и неделя (secondary). Снимок берётся
// из журналов Codex: ~/.codex/sessions/ГГГГ/ММ/ДД/rollout-*.jsonl, событие token_count → rate_limits
// { used_percent, window_minutes, resets_at (unix, с) }. Если ответ пришёл с ошибкой лимита, а снимка
// на 100% нет, до повторной проверки ставится запас на 30 мин (run/.codex-limit.json).
//   node run/codex-limits.js               строка: сколько израсходовано и когда сброс
//   node run/codex-limits.js --check       код 3 и «на лимите до …», если звать сейчас бесполезно
//   node run/codex-limits.js --after <f>   разобрать вывод вызова: лимит — запомнить сброс, код 3
const fs = require('fs')
const os = require('os')
const path = require('path')

const STATE = path.join(__dirname, '.codex-limit.json')
const LIMIT_RE = /usage limit|rate limit|too many requests|\b429\b|limit reached|quota|try again (in|at)/i

function newestRollouts (want = 6) {
  const root = path.join(os.homedir(), '.codex', 'sessions')
  const desc = d => { try { return fs.readdirSync(d).sort().reverse() } catch { return [] } }
  const out = []
  for (const y of desc(root)) {
    for (const m of desc(path.join(root, y))) {
      for (const d of desc(path.join(root, y, m))) {
        const dir = path.join(root, y, m, d)
        const files = desc(dir).filter(f => /^rollout-.*\.jsonl$/.test(f))
          .map(f => path.join(dir, f)).map(f => [f, fs.statSync(f).mtimeMs]).sort((a, b) => b[1] - a[1])
        for (const [f] of files) { out.push(f); if (out.length >= want) return out }
      }
    }
  }
  return out
}

// Самый свежий снимок rate_limits из последних журналов (лимиты общие на аккаунт).
function snapshot () {
  let best = null
  for (const f of newestRollouts()) {
    let text = ''
    try { text = fs.readFileSync(f, 'utf8') } catch { continue }
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue
      try {
        const ev = JSON.parse(lines[i])
        const rl = ev.payload && ev.payload.rate_limits
        if (rl && rl.primary) {
          const at = Date.parse(ev.timestamp) || 0
          if (!best || at > best.at) best = { at, primary: rl.primary, secondary: rl.secondary || null }
        }
      } catch {}
      break
    }
  }
  return best
}

const hhmm = sec => {
  const d = new Date(sec * 1000)
  const two = n => String(n).padStart(2, '0')
  const day = d.toDateString() === new Date().toDateString() ? '' : `${two(d.getDate())}.${two(d.getMonth() + 1)} `
  return `${day}${two(d.getHours())}:${two(d.getMinutes())}`
}
const now = () => Date.now() / 1000

// До какого момента звать бесполезно (unix, с) или 0.
function blockedUntil (snap) {
  let until = 0
  try { const st = JSON.parse(fs.readFileSync(STATE, 'utf8')); if (st.until > now()) until = st.until } catch {}
  if (snap) {
    for (const w of [snap.primary, snap.secondary]) {
      if (w && w.used_percent >= 100 && w.resets_at > now()) until = Math.max(until, w.resets_at)
    }
  }
  return until
}

function summary (snap) {
  if (!snap) return 'Codex: снимка лимитов ещё нет'
  const w = (x, name) => x ? `${name} ${Math.round(x.used_percent)}% (сброс ${hhmm(x.resets_at)})` : ''
  return `Codex: ${[w(snap.primary, '5 ч'), w(snap.secondary, 'неделя')].filter(Boolean).join(' · ')}`
}

function blockedMsg (until) {
  return `Codex на лимите до ${hhmm(until)} — продолжай сам; после ${hhmm(until)} снова зови его (run/codex.sh пропустит).`
}

const [mode, file] = process.argv.slice(2)
const snap = snapshot()
if (mode === '--check') {
  const until = blockedUntil(snap)
  if (until) { console.log(blockedMsg(until)); process.exit(3) }
} else if (mode === '--after') {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch {}
  // Ошибку лимита ищем только в последних строках: в самом ответе слова «rate limit» бывают по делу.
  const tail = text.split('\n').slice(-15).join('\n')
  if (LIMIT_RE.test(tail)) {
    let until = blockedUntil(snap)
    // Сам Codex пишет срок: «…try again at Sep 30th, 2026 4:04 AM.» (29.09: снимок rate_limits
    // при этом ещё показывал меньше 100%, и без этого разбора стоял запас в 30 мин вместо 04:04).
    const m = tail.match(/try again at ([A-Z][a-z]{2,8} \d{1,2})(?:st|nd|rd|th)?,? (\d{4}) (\d{1,2}:\d{2} ?[AP]M)/)
    const at = m ? Date.parse(`${m[1]}, ${m[2]} ${m[3]}`) / 1000 : NaN
    if (at > now()) until = Math.max(until, Math.round(at))
    const rel = !m && tail.match(/try again in (?:(\d+) hours?)?\s*(?:(\d+) min)/i)
    if (rel) until = Math.max(until, Math.round(now() + (Number(rel[1] || 0) * 60 + Number(rel[2] || 0)) * 60))
    if (!until) until = Math.round(now() + 30 * 60)
    try { fs.writeFileSync(STATE, JSON.stringify({ until, seen: new Date().toISOString() })) } catch {}
    console.log(blockedMsg(until))
    process.exit(3)
  }
  console.log(summary(snap))
} else {
  const until = blockedUntil(snap)
  console.log(until ? blockedMsg(until) : summary(snap))
}
