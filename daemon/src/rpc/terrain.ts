'use strict'
// RPC демона — рельеф: лестницы, TNT, копка к точке, подкоп, выстрел из-за угла, нора, блок за спиной.
// Фабрика методов над контекстом демона (rpc/context.ts); обработчики перенесены из src/index.ts.
import type { RpcContext } from './context'

function terrainMethods ({ session, gameClock }: RpcContext) {
  return {
    // Приставная лестница на стену снизу доверху (src/ladder.ts): общий подъём для команды.
    ladder_up: async (p: any = {}) => session.runIntent('ladder_up', ctl => require('../ladder').ladderUp(session, ctl, p), { timeoutMs: ((p.timeoutSeconds ?? 40) + 10) * 1000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    // Динамит у точки at (src/tnt.ts): поставить по видимой грани и поджечь; отбежать — дело вызывающего.
    tnt_at: async (p: any = {}) => session.runIntent('tnt_at', ctl => require('../tnt').tntAt(session, ctl, p), { timeoutMs: 12000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    // Встать в центр клетки (x, z) шагом на шифте (fortify.centerInCell): стойка копателя у ямы — точнее пути (±0.1).
    center_in: async (p: any = {}) => session.runIntent('center_in', async ctl => { const V = require('vec3'); const ok = await require('../fortify').centerInCell(session.require(), Math.min(3000, p.ms ?? 1500), new V(Math.floor(p.x), Math.floor(p.y ?? 0), Math.floor(p.z)), ctl); const q = session.require().entity.position; return { ok, at: { x: q.x, y: q.y, z: q.z } } }, { timeoutMs: 5000, interruptOn: ['death', 'kicked', 'disconnected'] }),
    dig_to: async (p: any = {}) => session.runIntent('dig_to', async (ctl) => {
      const bot = session.require()
      const V = require('vec3'); const { placeBlockAt } = require('../build')
      if (!p.at) throw new Error('нужна точка at')
      const T = new V(p.at.x, p.at.y, p.at.z)
      const maxSteps = Math.max(1, Math.min(80, p.maxSteps ?? 40))
      bot.pathfinder?.setGoal(null)
      // Паутина — не воздух, а стенка (14.10: «ставит стенку из паутины — боты не ломают, стоят и смотрят»; прокоп «ничего не
      // вскрыл»): без коллизии, но держит тело (×0.25) и ловит удар — её рубят (меч и ножницы — 0.4 с, рука — 20 с).
      const isAir = (v) => { const b = bot.blockAt(v); return !!b && b.boundingBox === 'empty' && !/^(water|lava|cobweb)$/.test(b.name) }
      const wet = (v) => { for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]) { const b = bot.blockAt(v.offset(d[0], d[1], d[2])); if (b && /^(water|lava)$/.test(b.name)) return b.name } return null }
      let steps = 0; let dug = 0; let placed = 0; let stuck = 0; let flip = false; let why = null
      // Дошёл — когда цель рядом и видна (луч от глаз до её груди без блоков): у коробки кемпера в 2 бл. «дошёл» по одной
      // дистанции стену не трогал (стенд 15.10: рой стоял вокруг замурованного, «прокапываюсь — дошёл», коробка цела).
      const reached = () => {
        const eye = bot.entity.position.offset(0, 1.62, 0); const d = T.offset(0, 1, 0).minus(eye); const n = d.norm()
        if (eye.distanceTo(T) > 3.2) return false
        if (n < 0.4) return true
        try { return !bot.world.raycast(eye, d.scaled(1 / n), n - 0.3, (b) => b && b.boundingBox === 'block') } catch { return true }
      }
      const open = async (v) => {
        if (isAir(v)) return true
        const b = bot.blockAt(v)
        if (!b || b.name === 'bedrock' || b.diggable === false) return false
        const w = wet(v); if (w) { why = `${w} за стенкой`; return false }
        // Лучший инструмент в руку (копал тем, что держал, — мечом стену укрытия по 10 с).
        const tool = bot.pathfinder?.bestHarvestTool?.(b)
        if (tool && bot.heldItem?.type !== tool.type) await bot.equip(tool, 'hand').catch(() => {})
        try { await bot.lookAt(v.offset(0.5, 0.5, 0.5), true); await bot.dig(b, true); dug++ } catch { return false }
        return isAir(v)
      }
      while (steps < maxSteps && !ctl.aborted) {
        const me = bot.entity.position; const c = me.floored()
        if (reached()) return { ok: true, steps, dug, placed, at: c }
        const dx = T.x - me.x; const dz = T.z - me.z; const dy = Math.floor(T.y) - c.y
        // Ось шага: большая по остатку; при почти равных — по очереди.
        const useX = Math.abs(Math.abs(dx) - Math.abs(dz)) < 1 ? (flip = !flip) : Math.abs(dx) > Math.abs(dz)
        const st = Math.hypot(dx, dz) < 0.8 ? new V(0, 0, 0) : useX ? new V(Math.sign(dx), 0, 0) : new V(0, 0, Math.sign(dz))
        const up = dy >= 1; const down = dy <= -1 && !(st.x === 0 && st.z === 0)
        const nx = c.plus(st)
        let need: any[]; let feet
        if (st.x === 0 && st.z === 0) {
          // Цель прямо надо мной/подо мной: столб вверх (блок под ноги в прыжке) или копать вниз.
          if (dy >= 1) {
            if (!(await open(c.offset(0, 2, 0)))) { why = why || 'над головой не пробить'; break }
            bot.setControlState('jump', true); await bot.waitForTicks(6); bot.setControlState('jump', false)
            const r = await placeBlockAt(bot, c, { honest: true, timeoutMs: 1500, ctl }).catch(() => null)
            if (r?.ok) placed++; steps++; await bot.waitForTicks(4); continue
          }
          if (!(await open(c.offset(0, -1, 0)))) { why = why || 'под ногами не пробить'; break }
          await bot.waitForTicks(8); steps++; continue
        }
        if (up) { need = [c.offset(0, 2, 0), nx.offset(0, 1, 0), nx.offset(0, 2, 0)]; feet = nx.offset(0, 1, 0) }
        else if (down) { need = [nx, nx.offset(0, 1, 0), nx.offset(0, -1, 0)]; feet = nx.offset(0, -1, 0) }
        else { need = [nx, nx.offset(0, 1, 0)]; feet = nx }
        let ok = true
        for (const v of need) if (!(await open(v))) { ok = false; break }
        if (!ok) { if (++stuck >= 3) { why = why || 'не пробить'; break } flip = !flip; continue }
        // Пол под новой клеткой: пусто — свой блок (не в пропасть).
        const floor = feet.offset(0, -1, 0)
        if (isAir(floor)) {
          const r = await placeBlockAt(bot, floor, { honest: true, timeoutMs: 1500, ctl }).catch(() => null)
          if (r?.ok) placed++; else { why = 'под ногами пусто, блоков нет'; break }
        }
        // Шаг в клетку: лицом к ней, вперёд (вверх — с прыжком), до 20 тиков.
        const goal = feet.offset(0.5, 0, 0.5)
        for (let t = 0; t < 20 && !ctl.aborted; t++) {
          const pos = bot.entity.position
          if (pos.floored().x === feet.x && pos.floored().z === feet.z && Math.abs(pos.y - feet.y) < 0.6) break
          await bot.lookAt(goal.offset(0, 1.6, 0), true)
          bot.setControlState('forward', true); bot.setControlState('jump', up && bot.entity.onGround)
          await bot.waitForTicks(1)
        }
        bot.clearControlStates()
        const moved = !bot.entity.position.floored().equals(c)
        stuck = moved ? 0 : stuck + 1
        if (stuck >= 3) { why = 'не шагнуть'; break }
        steps++
      }
      bot.clearControlStates()
      const at = bot.entity.position.floored()
      return { ok: reached(), steps, dug, placed, why, at: { x: at.x, y: at.y, z: at.z } }
    }, { timeoutMs: Math.max(10, Math.min(120, p.timeoutSeconds ?? 60)) * 1000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    // Выбить опору из-под него (13.10, арена: «стою прямо над ними — не ломают блоки, чтобы меня скинуть»): блоки под его
    // рамкой (ноги −0.5, по углам рамки ±0.3), видимые мне и в досягаемости 4.5 от глаз (pick.blockSeen — честно, не сквозь
    // стену), копаются лучшим инструментом (tools.install: bot.dig). Итог: { ok, dug, why }.
    undercut: async (p: any = {}) => session.runIntent('undercut', async (ctl) => {
      const bot = session.require()
      const V = require('vec3'); const pk = require('../pick')
      const foe = bot.players[String(p.target || '')]?.entity
      if (!foe) return { ok: false, why: 'не вижу его' }
      let dug = 0
      for (let pass = 0; pass < 3 && !ctl.aborted; pass++) {
        const f = foe.position
        const cells = new Map()
        for (const [ox, oz] of [[0, 0], [0.3, 0.3], [-0.3, 0.3], [0.3, -0.3], [-0.3, -0.3]]) { const c = new V(f.x + ox, f.y - 0.5, f.z + oz).floored(); cells.set(c.toString(), c) }
        const solid = [...cells.values()].filter(c => { const b = bot.blockAt(c); return b && b.boundingBox === 'block' && b.name !== 'bedrock' && b.diggable !== false })
        if (!solid.length) return { ok: dug > 0, dug, why: dug ? 'опоры нет' : 'под ним пусто' }
        const seen = solid.filter(c => pk.blockSeen(bot, c, { range: 4.5 }))
        if (!seen.length) return { ok: dug > 0, dug, why: 'опору не видно или не достать' }
        for (const c of seen) {
          if (ctl.aborted) break
          const b = bot.blockAt(c); if (!b || b.boundingBox !== 'block') continue
          try { await bot.lookAt(c.offset(0.5, 0.5, 0.5), true); await bot.dig(b, true); dug++ } catch {}
        }
      }
      return { ok: dug > 0, dug }
    }, { timeoutMs: 12000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    // Выстрел из-за стенки в прыжке (13.10, арена: «ставит блоки, прыгает и выстреливает из лука — очень крутой приём»):
    // стенка в 2 бл. в клетке к нему (честно, build.placeBlockAt; блоков нет — без неё), лук натянут за ней до полной силы
    // (bow.shoot holdWhile), прыжок, на вершине (глаза над стенкой, vy ≤ 0.08) — спуск с упреждением и поправкой на своё
    // движение (bow.shoot compensate); закрыто в миг спуска — не стреляет. Повтор shots раз, пока он в 6–40 бл.
    peek_shot: async (p: any = {}) => session.runIntent('peek_shot', async (ctl) => {
      const bot = session.require()
      const V = require('vec3'); const bow = require('../bow'); const { placeBlockAt, pickFiller } = require('../build')
      const foe = bot.players[String(p.target || '')]?.entity
      if (!foe) return { ok: false, why: 'не вижу его' }
      if (!bot.inventory.items().some(i => i.name === 'bow') || !bot.inventory.items().some(i => /arrow$/.test(i.name))) return { ok: false, why: 'нет лука или стрел' }
      bot.pathfinder?.setGoal(null)
      const me = bot.entity.position; const ff = me.floored()
      const dx = foe.position.x - me.x; const dz = foe.position.z - me.z
      const step = Math.abs(dx) >= Math.abs(dz) ? new V(Math.sign(dx), 0, 0) : new V(0, 0, Math.sign(dz))
      let wall = 0
      if (pickFiller(bot)) for (const h of [0, 1]) {
        if (ctl.aborted) break
        const c = ff.plus(step).offset(0, h, 0); const b = bot.blockAt(c)
        if (b && b.boundingBox === 'block') { wall++; continue }
        const r = await placeBlockAt(bot, c, { honest: true, timeoutMs: 1000, ctl }).catch(() => null)
        if (r?.ok) wall++
      }
      const shots = Math.max(1, Math.min(6, p.shots ?? 3))
      let fired = 0; let hits = 0; let why = null
      for (let k = 0; k < shots && !ctl.aborted; k++) {
        const d = bot.entity.position.distanceTo(foe.position)
        if (d < 6 || d > 40 || !bot.players[String(p.target)]?.entity) { why = d < 6 ? 'он близко' : 'ушёл'; break }
        let jumpAt = -1
        const r = await bow.shoot(bot, foe, {
          peek: true, follow: false, holdMaxMs: 1500,
          // Тетива натянута — прыжок; держать до вершины (глаза над стенкой) или 14 тиков.
          holdWhile: () => {
            const t = gameClock.now()
            if (jumpAt < 0) { jumpAt = t; bot.setControlState('jump', true); return true }
            if (t - jumpAt > 100) bot.setControlState('jump', false)
            if (t - jumpAt > 700) return false
            return bot.entity.onGround || bot.entity.velocity.y > 0.08
          },
          onHit: () => { hits++ }
        }).catch(e => ({ shot: false, why: e.message }))
        bot.setControlState('jump', false)
        if (r?.shot) fired++; else if (!why) why = r?.why || null
        for (let t = 0; t < 20 && !bot.entity.onGround && !ctl.aborted; t++) await bot.waitForTicks(1)
      }
      return { ok: fired > 0, fired, hits, wall, why }
    }, { timeoutMs: 20000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
    // Уйти в стену (арена 10.10: «буриться киркой в стены, закапываться в Колизей и прятаться»): прорыть ход 2 в высоту
    // на depth клеток в сторону от away (стена рядом — по оси, что дальше всего от врага), зайти, заложить вход за собой
    // и сесть на шифт. Копает лучшим инструментом (tools.equipFastest), ставит честно (build.placeBlockAt, honest).
    burrow: async (p) => session.runIntent('burrow', async (ctl) => {
      const bot = session.require()
      const tools = require('../tools'); const { placeBlockAt, pickFiller } = require('../build')
      const Vec3 = require('vec3')
      const depth = Math.max(2, Math.min(8, p?.depth ?? 4))
      const feet = bot.entity.position.floored()
      const away = p?.away ? new Vec3(bot.entity.position.x - p.away.x, 0, bot.entity.position.z - p.away.z) : new Vec3(1, 0, 0)
      const solid = (v) => { const b = bot.blockAt(v); return b && b.boundingBox === 'block' && tools.breakable(b) }
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => new Vec3(x, 0, z))
        .filter(d => solid(feet.plus(d)) || solid(feet.plus(d).offset(0, 1, 0)))
        .sort((a, b) => (b.x * away.x + b.z * away.z) - (a.x * away.x + a.z * away.z))
      if (!dirs.length) {
        // Стены нет — закопаться вниз на 2 и закрыть голову блоком (под ямой — опора, рядом — ни лавы, ни воды).
        const wet = (v) => /lava|water/.test(bot.blockAt(v)?.name || '')
        const d1 = feet.offset(0, -1, 0); const d2 = feet.offset(0, -2, 0)
        if (!solid(d1) || !solid(d2) || !solid(feet.offset(0, -3, 0)) || [d1, d2].some(v => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([x, z]) => wet(v.offset(x, 0, z))))) return { ok: false, why: 'рядом нет стены, вниз копать нельзя' }
        let dug = 0
        for (const v of [d1, d2]) {
          const b = bot.blockAt(v)
          await tools.equipFastest(bot, b).catch(() => {})
          try { await bot.dig(b, true); dug++ } catch (e) { return { ok: dug > 0, why: 'копка вниз: ' + e.message, dug } }
          for (let t = 0; t < 15 && bot.entity.position.y > v.y + 0.1; t++) await bot.waitForTicks(1)
        }
        let sealed = 0
        if (pickFiller(bot)) { const r = await placeBlockAt(bot, feet, { honest: true, timeoutMs: 1500, ctl }).catch(() => null); if (r && r.ok) sealed++ }
        bot.setControlState('sneak', true)
        return { ok: true, dug, sealed, down: true, at: { x: d2.x, y: d2.y, z: d2.z } }
      }
      const d = dirs[0]
      let dug = 0; let cell = feet
      for (let k = 1; k <= depth && !ctl.aborted; k++) {
        const next = feet.plus(d.scaled(k))
        for (const v of [next, next.offset(0, 1, 0)]) {
          const b = bot.blockAt(v)
          if (b && b.boundingBox === 'block') {
            if (!tools.breakable(b)) return { ok: dug > 0, why: `не копается ${b.name}`, dug }
            await tools.equipFastest(bot, b).catch(() => {})
            try { await bot.dig(b, true); dug++ } catch (e) { return { ok: dug > 0, why: 'копка: ' + e.message, dug } }
          }
        }
        if (!solid(next.offset(0, -1, 0))) break
        await bot.lookAt(next.offset(0.5, 1.6, 0.5), true).catch(() => {})
        bot.setControlState('forward', true)
        for (let t = 0; t < 20 && !bot.entity.position.floored().equals(next); t++) await bot.waitForTicks(1)
        bot.setControlState('forward', false)
        cell = bot.entity.position.floored()
      }
      // Вход за собой — заложить (ноги и голова), чтобы не было видно и не достали.
      let sealed = 0
      if (!cell.equals(feet) && pickFiller(bot)) {
        const back = cell.minus(d)
        for (const v of [back, back.offset(0, 1, 0)]) {
          const r = await placeBlockAt(bot, v, { honest: true, timeoutMs: 1500, ctl }).catch(() => null)
          if (r && r.ok) sealed++
        }
      }
      bot.setControlState('sneak', true)
      return { ok: dug > 0, dug, sealed, at: { x: cell.x, y: cell.y, z: cell.z } }
    }, { timeoutMs: 20000, interruptOn: ['death', 'kicked', 'disconnected'], params: p || {} }),
    // Закрыть проход за собой (10.10: «стенку застраивать в узких местах, воду, лаву, паутину — система блокирования прохода
    // врагу»): клетка между мной и тем, кто гонится (по ходу к нему), — паутина (держит), иначе 2 блока стены; в проходе
    // (по бокам клетки опора) — ставить; на открытом — лава под ноги на его пути (ведро) или вода (сбивает бег).
    block_behind: async (p) => session.immediate(async () => {
      const bot = session.require()
      const Vec3 = require('vec3'); const { placeBlockAt, pickFiller } = require('../build')
      const foe = (p?.from && bot.players?.[p.from]?.entity) || (p?.fromId != null ? bot.entities[p.fromId] : null)
      if (!foe) return { ok: false, why: 'не вижу его' }
      const me = bot.entity.position
      const dx = foe.position.x - me.x; const dz = foe.position.z - me.z
      const ax = Math.abs(dx) >= Math.abs(dz)
      const step = ax ? new Vec3(Math.sign(dx), 0, 0) : new Vec3(0, 0, Math.sign(dz))
      const cell = me.floored().plus(step)
      const free = (v) => { const b = bot.blockAt(v); return b && b.boundingBox === 'empty' && !/water|lava/.test(b.name) }
      const solid = (v) => { const b = bot.blockAt(v); return b && b.boundingBox === 'block' }
      if (!free(cell) || foe.position.floored().equals(cell)) return { ok: false, why: 'клетка занята' }
      const side = ax ? new Vec3(0, 0, 1) : new Vec3(1, 0, 0)
      const corridor = solid(cell.plus(side)) && solid(cell.minus(side))
      const has = (n) => bot.inventory.items().find(i => i.name === n)
      const put = async (v, item) => { const r = await placeBlockAt(bot, v, { item, honest: true, timeoutMs: 1200 }).catch(() => null); return !!(r && r.ok) }
      // Паутина — не сплошной блок: placeBlockAt ждёт твёрдую клетку, поэтому проверка — по имени блока.
      if (has('cobweb')) { await put(cell, 'cobweb'); if (bot.blockAt(cell)?.name === 'cobweb') return { ok: true, how: 'паутина', corridor } }
      if (corridor && pickFiller(bot)) {
        const a = await put(cell, null); const b = await put(cell.offset(0, 1, 0), null)
        if (a || b) return { ok: true, how: `стена ${(a ? 1 : 0) + (b ? 1 : 0)}`, corridor }
      }
      for (const [item, how] of [['lava_bucket', 'лава'], ['water_bucket', 'вода']]) {
        const it = has(item); if (!it || !solid(cell.offset(0, -1, 0))) continue
        try {
          await bot.equip(it, 'hand')
          await bot.lookAt(cell.offset(0.5, 0.05, 0.5), true)
          bot.activateItem()
          return { ok: true, how, corridor }
        } catch {}
      }
      return { ok: false, why: 'нечем', corridor }
    })
  }
}

export { terrainMethods }
