'use strict'
// RPC демона — средний слой: обстановка, бегство от огня, директор.
// Фабрика методов над контекстом демона (rpc/context.ts); обработчики перенесены из src/index.ts.
import type { RpcContext } from './context'

function directorMethods ({ session, director }: RpcContext) {
  return {
    // Обстановка глазами директора (director.situation) — для мозга-автомата
    // campaign.js: под крышей ли (порода над головой, а не y<50 — в горах это
    // поверхность), ночь и сумерки, враги с вердиктом assess, кровать, кирка.
    // Только чтение: тело не двигается, текущее намерение не рвётся.
    situation: async () => session.immediate(async () => {
      const bot = session.require()
      const s = require('../director').situation(director)
      const f = s.fight
      // Удары кирок: шапка состояния даёт штуки, а две стёртые кирки — это не
      // запас (кампания 2026-09-26: «кирок 2», а ударов 42 на обе, и штрек встал).
      const items = require('../items')
      const picks = items.toolStatus(bot, 'pickaxe')
      // Открытое небо — ещё не поверхность: на дне своего колодца небо над
      // головой видно до самого верха (director.situation смотрит только вверх), и
      // кампания на y=-10 считала себя «наверху» — toSurface не лез, а портал
      // строился бы на дне шахты. Стены — соседние столбы через клетку (±2) с
      // породой на 3..8 выше ног хотя бы с трёх сторон (листва и брёвна не в счёт
      // — лес не колодец).
      const feet = bot.entity.position.floored()
      let walls = 0
      for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
        for (let dy = 3; dy <= 8; dy++) {
          const b = bot.blockAt(feet.offset(dx, dy, dz))
          if (b && b.boundingBox === 'block' && !/leaves|log|wood/.test(b.name)) { walls++; break }
        }
      }
      const pit = s.surface && walls >= 3
      // Голова в блоке (гравий сверху): откапывает автопилот (freeIfBuried), и
      // любое копающее намерение поверх него рвёт его взмах («Digging aborted»,
      // mineflayer держит одну задачу копания). Кампания 2026-09-26 на урон
      // удушья звала shelter/dig_down одно за другим и задохнулась («suffocated
      // in a wall»). Мозгу — знать и ждать.
      let buried = false
      try { buried = !!(session.autopilot && session.autopilot.buriedBy(bot)) } catch {}
      return {
        ...s,
        surface: s.surface && !pit,
        pit,
        buried,
        fight: undefined,
        fightText: f ? f.text : null,
        first: f && f.order && f.order[0] ? f.order[0] : null,
        pickLeft: items.toolBudget(bot, 'pickaxe'),
        picks: picks.tools || [],
        // Время суток в тиках (поток route, 03.10): кровать к ночи — заранее, по часам, а не по «сумеркам».
        tod: bot.time && typeof bot.time.timeOfDay === 'number' ? bot.time.timeOfDay : null
      }
    }),
    // Вон из лавы и огня (director.escapeFire): вода из ведра под ноги или прыжок
    // к ближайшему твёрдому полу без лавы. Мозгу-автомату: на урон от огня не
    // «зарываться» — нора в лаве это смерть («tried to swim in lava», 2026-09-26).
    escape_fire: async () => session.runIntent('escape_fire', async () => {
      session.require()
      const r = await director.escapeFire()
      return (r && r.detail) || r
    }, { timeoutMs: 8000, interruptOn: ['death', 'kicked', 'disconnected'] }),
    director: async (p: any = {}) => session.immediate(async () => {
      const mode = p.mode || 'status'
      if (mode === 'start') return director.start({ goal: p.goal, rules: p.rules })
      if (mode === 'stop') return director.stop()
      if (mode === 'rules') { Object.assign(director.rules, p.rules || {}); return director.status() }
      return director.status()
    })
  }
}

export { directorMethods }
