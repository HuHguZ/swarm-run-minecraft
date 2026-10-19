'use strict'
// Человек в бою (showman.ts): нрав бота на бой (задира, боксёр, хитрец, тихоня) и кто перед нами — человек или свой бот.
import { FIXP, PHASES, clamp } from './consts'

// Нрав — постоянный для бота (по нику), чтобы два одинаковых бота с одним
// китом дрались по-разному; в каждом бою — ещё свой разброс поверх.
// show — любит покрасоваться, cunning — финты и засады, patience — сколько
// кружит до сшибки, chat — разговорчивость, rhythm — длина фаз.
const ARCH = {
  задира: { show: 0.85, cunning: 0.3, patience: 0.35, chat: 0.8, rhythm: 0.85, bias: { напор: 1.7, оборона: 0.5, хитрость: 0.6, шоу: 1.5 } },
  боксёр: { show: 0.55, cunning: 0.6, patience: 0.7, chat: 0.4, rhythm: 1.0, bias: { напор: 1.1, оборона: 1.2, хитрость: 1.2, шоу: 0.8 } },
  хитрец: { show: 0.45, cunning: 0.95, patience: 0.6, chat: 0.5, rhythm: 0.9, bias: { напор: 0.7, оборона: 1.0, хитрость: 1.9, шоу: 0.6 } },
  тихоня: { show: 0.25, cunning: 0.55, patience: 0.9, chat: 0.2, rhythm: 1.2, bias: { напор: 0.7, оборона: 1.7, хитрость: 1.1, шоу: 0.35 } }
}
const ARCH_ORDER = ['задира', 'боксёр', 'хитрец', 'тихоня']

function hashName (s) {
  let h = 2166136261
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) }
  return h >>> 0
}
function seeded (seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function personaOf (name) {
  const forced = process.env.ND_HUMAN_PERSONA
  const h = hashName(name)
  const arch = ARCH[forced] ? forced : FIXP ? ARCH_ORDER[Math.floor(Math.random() * ARCH_ORDER.length)] : ARCH_ORDER[h % ARCH_ORDER.length]
  const base = ARCH[arch]
  // Постоянный разброс по нику держал одного бота всегда слабее — теперь случай.
  const r = FIXP ? Math.random : seeded(h)
  // Постоянный разброс бота (от ника) и разброс боя (случай).
  const j = (v, a) => clamp(v + (r() - 0.5) * a + (Math.random() - 0.5) * a * 0.6, 0.05, 1)
  const bias = {}
  for (const p of PHASES) bias[p] = Math.max(0.15, base.bias[p] * (0.8 + r() * 0.4) * (0.85 + Math.random() * 0.3))
  return { name: arch, show: j(base.show, 0.3), cunning: j(base.cunning, 0.3), patience: j(base.patience, 0.3), chat: j(base.chat, 0.3), rhythm: base.rhythm * (0.85 + r() * 0.3), bias }
}

// Свои боты — жестов им меньше (просьба: «против людей больше, против ботов меньше»).
function isBotName (n) {
  if (!n) return false
  const extra = (process.env.ND_BOTS || '').split(',').map(x => x.trim()).filter(Boolean)
  return /^neurodown/i.test(n) || extra.includes(n)
}

export { hashName, seeded, personaOf, isBotName }
