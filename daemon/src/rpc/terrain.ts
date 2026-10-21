'use strict'
// RPC демона — рельеф: лестницы, TNT, центр клетки, копка к точке, подкоп (выстрел из-за угла, нора, блок за спиной — terrain-cover.ts).
// Фабрика методов над контекстом демона (rpc/context.ts); обработчики перенесены из src/index.ts.
import type { RpcContext } from './context'

function terrainMethods ({ session }: RpcContext) {
  return {
    ne_recover: async (p: any = {}) => {
      if (process.env.ND_NE_NO_GIVEUP !== '1') return { disabled: true }
      return session.runIntent('ne_recover', ctl => {
        session.require()
        return (require('../nether-no-giveup') as typeof import('../nether-no-giveup')).recoverNether(session, ctl, p)
      }, { timeoutMs: (Math.max(1, Math.min(600, p.timeoutSeconds ?? 90)) + 5) * 1000,
        interruptOn: ['chat', 'damage', 'death', 'kicked', 'disconnected'], params: p })
    },
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
  }
}

export { terrainMethods }
