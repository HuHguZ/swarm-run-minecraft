'use strict'
const fs = require('fs')
const path = require('path')

// Настроение бота и отношение к каждому человеку — из того, что было за
// сессию: подарил вещь, вступились друг за друга, поздоровался — теплее;
// ударил, обозвал, зовёт в пятый раз за три минуты — холоднее. Живой игрок
// на «иди сюда» от друга бежит, от того, кто только что его бил, — не очень,
// а занятый или раненый — и от друга не всегда. Этим и решается, прибежит ли
// тело на зов (summon в gestures.js), присядет ли в ответ, вступится ли.
//
// Числа — эвристика, а не механика игры: 0..100, нейтрально 60 (настроение)
// и 50 (отношение), со временем возвращаются к нейтральному. Живёт в
// memory/mood.json — переживает перезапуск демона, но остывает.

const BASE_MOOD = 60
const BASE_AFF = 50
// За сколько минут отклонение остывает в e раз.
const MOOD_TAU_MIN = 30
const AFF_TAU_MIN = 180
const SAVE_MS = 10000

// Слова в чате — грубо, но честно: без разбора смысла, только самые ясные.
const WARM = /(спасибо|спс|пасиб|красав|молодец|люблю|лучший|дружище|бро\b|брат|класс|круто|топ\b|гг\b|ахах|хах|респект|умница|good|thanks|thx|ty\b|nice|love)/i
const RUDE = /(дурак|тупой|тупица|идиот|лох|бесишь|отстань|заткнись|урод|нуб|сдохни|вали отсюда|пошёл вон|пошел вон|stupid|idiot|noob|shut up)/i

function clamp (v, lo = 0, hi = 100) { return Math.max(lo, Math.min(hi, v)) }

function word (v) {
  if (v >= 80) return 'отличное'
  if (v >= 62) return 'хорошее'
  if (v >= 45) return 'так себе'
  if (v >= 25) return 'плохое'
  return 'злой'
}

function relation (a) {
  if (a >= 85) return 'лучший друг'
  if (a >= 65) return 'друг'
  if (a >= 42) return 'знакомый'
  if (a >= 25) return 'недолюбливаю'
  return 'враг'
}

class Mood {
  constructor (session, memoryDir) {
    this.session = session
    this.file = memoryDir ? path.join(memoryDir, 'mood.json') : null
    this.state = { mood: BASE_MOOD, at: Date.now(), players: {} }
    this.load()
    this.saveTimer = null
  }

  load () {
    if (!this.file) return
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (s && typeof s.mood === 'number') this.state = { mood: s.mood, at: s.at || Date.now(), players: s.players || {} }
    } catch {}
  }

  save () {
    if (!this.file || this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      try { fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2)) } catch {}
    }, SAVE_MS)
  }

  // Остывание к нейтральному, по прошедшему времени.
  decay () {
    const now = Date.now()
    const dtMin = (now - (this.state.at || now)) / 60000
    if (dtMin <= 0) return
    this.state.mood = BASE_MOOD + (this.state.mood - BASE_MOOD) * Math.exp(-dtMin / MOOD_TAU_MIN)
    for (const p of Object.values(this.state.players)) {
      p.affinity = BASE_AFF + (p.affinity - BASE_AFF) * Math.exp(-dtMin / AFF_TAU_MIN)
    }
    this.state.at = now
  }

  person (name) {
    let p = this.state.players[name]
    if (!p) {
      p = { affinity: BASE_AFF, gifts: 0, hits: 0, calls: [], why: [] }
      this.state.players[name] = p
    }
    return p
  }

  // Событие сессии: kind — для памяти «почему», aff и mood — сдвиги.
  bump (name, kind, aff = 0, mood = 0) {
    this.decay()
    if (name) {
      const p = this.person(name)
      p.affinity = clamp(p.affinity + aff)
      if (kind === 'подарок') p.gifts++
      if (kind === 'ударил') p.hits++
      p.why = [...(p.why || []), { kind, aff, at: Date.now() }].slice(-8)
    }
    this.state.mood = clamp(this.state.mood + mood)
    this.save()
  }

  chat (name, text) {
    if (RUDE.test(text)) this.bump(name, 'нагрубил', -5, -3)
    else if (WARM.test(text)) this.bump(name, 'доброе слово', 2, 1)
  }

  affinity (name) {
    this.decay()
    return this.state.players[name] ? this.state.players[name].affinity : BASE_AFF
  }

  // Прибежать ли на зов. ctx: dist, urgent, byGesture.
  decideCome (name, { dist = 10, urgent = false, byGesture = false } = {}) {
    this.decay()
    const bot = this.session.bot
    const p = this.person(name)
    const now = Date.now()
    p.calls = (p.calls || []).filter(t => now - t < 180000)
    p.calls.push(now)
    const aff = p.affinity
    const mood = this.state.mood
    let chance = 0.72 + (aff - BASE_AFF) * 0.009 + (mood - BASE_MOOD) * 0.005
    const why = []
    if (aff >= 65) why.push(`к ${name} хорошо отношусь`)
    else if (aff < 35) why.push(`${name} мне не друг (${relation(aff)})`)
    if (mood >= 70) why.push('настроение отличное')
    else if (mood < 40) why.push('настроение плохое')
    // Второй зов подряд — «ну ладно, иду» (настаивает); с четвёртого —
    // надоел.
    if (p.calls.length === 2 || p.calls.length === 3) { chance += 0.1; why.push('зовёт не первый раз — настаивает') }
    const spam = p.calls.length - 3
    if (spam > 0) { chance -= 0.2 * spam; why.push(`зовёт уже ${p.calls.length}-й раз за 3 минуты — надоел`) }
    const hp = bot ? bot.health ?? 20 : 20
    const food = bot ? bot.food ?? 20 : 20
    if (hp < 8) { chance -= 0.3; why.push(`сам ранен (${Math.round(hp)} хп)`) }
    if (food < 6) { chance -= 0.2; why.push('голодный') }
    if (dist > 48) { chance -= 0.3; why.push(`далеко — ${Math.round(dist)} блоков`) }
    if (byGesture) chance -= 0.05
    if (urgent) { chance += 0.35; why.push('зовёт срочно') }
    chance = clamp(chance, 0.03, 0.97)
    const come = dist <= 96 && Math.random() < chance
    // Нехотя — с задержкой; охотно — сразу и бегом.
    const delayMs = Math.round(250 + Math.random() * 400 + (1 - chance) * 1800)
    const sprint = urgent || (aff >= 70 && mood >= 60)
    this.save()
    const reason = why.join(', ') || (come ? 'почему бы и нет' : 'не захотелось с первого раза — позовёт ещё, подумаю')
    return { come, chance: Math.round(chance * 100) / 100, delayMs, sprint, why: reason }
  }

  // Для мозга: одной строкой и числами.
  report (names = null) {
    this.decay()
    const toward = Object.entries(this.state.players)
      .filter(([n]) => !names || names.includes(n))
      .map(([n, p]) => ({ name: n, affinity: Math.round(p.affinity), relation: relation(p.affinity), gifts: p.gifts || 0, hits: p.hits || 0 }))
    const text = `настроение ${word(this.state.mood)} (${Math.round(this.state.mood)})` +
      (toward.length ? '; ' + toward.map(t => `${t.name} — ${t.relation} (${t.affinity})`).join(', ') : '')
    return { mood: Math.round(this.state.mood), word: word(this.state.mood), toward, text }
  }
}

module.exports = { Mood, word, relation, WARM, RUDE }
