'use strict'
// Человек в бою (showman.ts): включатели слоя, досягаемости, фазы боя, мелкие случайные помощники, действия стойки.

const ON = process.env.ND_HUMAN !== '0'
const CHAT = process.env.ND_HUMAN_CHAT !== '0'
// Качество боя (pvp.js FIX, 2026-09-26): нрав — на каждый бой случаем, а не
// по нику (NeuroDown всегда «задира», NeuroDown2 всегда «хитрец» — второй
// проигрывал 3:7, пятился и прятался); фазы короче; стойка — короткое окно;
// нажим из pvp.js (c.press) снимает стойку, засаду, финты и паузы.
// ND_FIGHTFIX=0 — как раньше.
const FIXP = process.env.ND_FIGHTFIX !== '0'
const HIT_REACH = 2.9
const THEIR_REACH = 3.4
const EYE = 1.62

const PHASES = ['напор', 'оборона', 'хитрость', 'шоу']
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const between = (a, b) => a + Math.random() * (b - a)
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
function weighted (w) {
  const total: any = (Object.values(w) as any[]).reduce((a: any, b) => a + b, 0)
  let x = Math.random() * total
  for (const [k, v] of ((Object.entries(w) as [string, any][]) as any)) { x -= v; if (x <= 0) return k }
  return Object.keys(w)[0]
}

// Действия стойки: сколько длится и на что больше похоже — на показуху
// (show) или на разговор телом (social: против людей их больше).
const ACTS = {
  круг: { ms: [900, 2200], w: 1.1, show: 0.2, social: 0 },
  присед: { ms: [500, 1000], w: 0.25, show: 0.5, social: 1.2 },
  кивок: { ms: [600, 950], w: 0.15, show: 0.3, social: 1.0 },
  головой: { ms: [450, 800], w: 0.12, show: 0.45, social: 0.5 },
  взмах: { ms: [500, 1100], w: 0.3, show: 0.9, social: 0.2 },
  прыжки: { ms: [550, 1100], w: 0.2, show: 0.7, social: 0.3 },
  подзыв: { ms: [900, 1500], w: 0.3, show: 0.5, social: 0.8 },
  пауза: { ms: [150, 450], w: 0.35, show: 0, social: 0 }
}
const ACT_LABEL = {
  круг: 'жест: кружит на средней дистанции',
  присед: 'жест: присед-присед',
  кивок: 'жест: кивок',
  головой: 'жест: мотает головой',
  взмах: 'жест: взмах мечом в воздух',
  прыжки: 'жест: прыжки на месте',
  подзыв: 'жест: подзывает (шаг вперёд-назад)',
  пауза: null
}

export { ON, CHAT, FIXP, HIT_REACH, THEIR_REACH, EYE, PHASES, clamp, between, pick, weighted, ACTS, ACT_LABEL }
