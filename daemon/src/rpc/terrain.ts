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
      const V = require('vec3'); const { placeBlockAt, FACES } = require('../build')
      const { observedCollision } = require('../pvp/search') as typeof import('../pvp/search')
      const { bodyBox, bodyClear, HAZARD, shapeBoxes, supportAt } = require('../navigation/geometry') as typeof import('../navigation/geometry')
      const { withinArena } = require('../navigation/parkour/model') as typeof import('../navigation/parkour/model')
      const { faceAim, eyeOf } = require('../pick') as typeof import('../pick')
      const { watchDigReceipt } = require('../environments/dig-receipt') as typeof import('../environments/dig-receipt')
      const { liquidSeen } = require('../mining/dig-water') as typeof import('../mining/dig-water')
      const faceIds = require('prismarine-world').iterators.BlockFace
      if (!p.at || ![p.at.x, p.at.y, p.at.z].every(Number.isFinite)) throw new Error('нужна точка at')
      const T = new V(p.at.x, p.at.y, p.at.z)
      const maxSteps = Math.max(1, Math.min(80, p.maxSteps ?? 40))
      bot.pathfinder?.setGoal(null)
      // Паутина — не воздух, а стенка (14.10: «ставит стенку из паутины — боты не ломают, стоят и смотрят»; прокоп «ничего не
      // вскрыл»): без коллизии, но держит тело (×0.25) и ловит удар — её рубят (меч и ножницы — 0.4 с, рука — 20 с).
      const isAir = b => b?.boundingBox === 'empty' && !/^(water|bubble_column|cobweb)$/.test(b.name) && !HAZARD.test(b.name)
      const wet = v => {
        const view = observedCollision(bot)
        for (const face of FACES) {
          if (face.y < 0) continue // A sealed floor does not pour into the cut.
          const b = view.blockAt(v.plus(face))
          if (b && /^(water|bubble_column|lava)$/.test(b.name) && liquidSeen(bot, b)) return b.name
        }
        return null
      }
      let steps = 0; let dug = 0; let placed = 0; let stuck = 0; let flip = false; let why = null
      let missingFooting = null
      let exposedChest: { x: number; y: number; z: number } | undefined
      // Дошёл — когда цель рядом и видна (луч от глаз до её груди без блоков): у коробки кемпера в 2 бл. «дошёл» по одной
      // дистанции стену не трогал (стенд 15.10: рой стоял вокруг замурованного, «прокапываюсь — дошёл», коробка цела).
      const reached = () => {
        const eye = eyeOf(bot); const d = T.offset(0, 1, 0).minus(eye); const n = d.norm()
        if (eye.distanceTo(T) > 3.2) return false
        if (n < 0.4) return true
        try { return !bot.world.raycast(eye, d.scaled(1 / n), n - 0.3, (b) => b && b.boundingBox === 'block') } catch { return false }
      }
      const open = async (v) => {
        const b = observedCollision(bot).blockAt(v)
        if (isAir(b)) return true
        if (!b || b.name === 'bedrock' || b.diggable === false || /^(water|bubble_column|lava)$/.test(b.name)) return false
        if (p.seekChest === true && b.name === 'chest') {
          if (FACES.some(f => faceAim(bot, v, f))) exposedChest = { x: v.x, y: v.y, z: v.z }
          why = 'сундук в проходе'; return false
        }
        const w = wet(v); if (w) { why = `${w} у прохода`; return false }
        // Лучший инструмент в руку (копал тем, что держал, — мечом стену укрытия по 10 с).
        const tool = bot.pathfinder?.bestHarvestTool?.(b)
        if (tool && bot.heldItem?.type !== tool.type) await bot.equip(tool, 'hand').catch(() => {})
        const face = FACES.find(f => faceAim(bot, v, f))
        if (!face || ctl.aborted) return false
        const aim = faceAim(bot, v, face), from = bot.entity.position.clone()
        await bot.lookAt(aim, true)
        const { yaw, pitch } = bot.entity
        const footprint = bodyBox(bot, from)
        const underfoot = shapeBoxes(b).some(box => Math.abs(box.maxY - from.y) < .04 &&
          box.minX < footprint.maxX && box.maxX > footprint.minX && box.minZ < footprint.maxZ && box.maxZ > footprint.minZ)
        const pickedFace = () => {
          if (ctl.aborted || !from.equals(bot.entity.position) || bot.entity.yaw !== yaw || bot.entity.pitch !== pitch || !faceAim(bot, v, face)?.equals?.(aim) ||
              bot.blockAt(v)?.stateId !== b.stateId) return null
          if (underfoot) {
            const below = new V(from.x, v.y, from.z)
            const stand = supportAt(observedCollision(bot), below, .5)
            if (!bot.entity.onGround || !stand || !withinArena(bot, new V(from.x, stand.top, from.z), p.arena, from)) {
              why = 'не вижу опоры под собой'; return null
            }
          }
          return face.x ? (face.x > 0 ? faceIds.EAST : faceIds.WEST) :
            face.y ? (face.y > 0 ? faceIds.TOP : faceIds.BOTTOM) : (face.z > 0 ? faceIds.SOUTH : faceIds.NORTH)
        }
        if (pickedFace() === null) return false
        const receipt = watchDigReceipt(bot, v, () => ctl.aborted)
        const guardFloor = () => {
          if (bot.targetDigBlock?.position.equals(v) && pickedFace() === null) bot.stopDigging()
        }
        if (underfoot) bot.on('physicsTick', guardFloor)
        try {
          await bot.dig(b, 'ignore', { ndPickedFace: pickedFace }, ctl)
          if (await receipt.settle() !== 'confirmed') { why = 'сервер не подтвердил прокоп'; return false }
          dug++; return true
        } catch { return false } finally {
          if (underfoot) bot.removeListener('physicsTick', guardFloor)
          receipt.close()
        }
      }
      try {
        while (steps < maxSteps && !ctl.aborted) {
          const me = bot.entity.position.clone(); const c = me.floored()
          if (reached()) return { ok: true, steps, dug, placed, at: c }
          const dx = T.x - me.x; const dz = T.z - me.z; const dy = Math.floor(T.y) - c.y
          // Ось шага: большая по остатку; при почти равных — по очереди.
          const useX = Math.abs(Math.abs(dx) - Math.abs(dz)) < 1 ? (flip = !flip) : Math.abs(dx) > Math.abs(dz)
          const st = Math.hypot(dx, dz) < 0.8 ? new V(0, 0, 0) : useX ? new V(Math.sign(dx), 0, 0) : new V(0, 0, Math.sign(dz))
          const up = dy >= 1; const down = dy <= -1 && !(st.x === 0 && st.z === 0)
          const nx = c.plus(st)
          const next = nx.offset(.5, Math.sign(dy), .5)
          if (!withinArena(bot, next, p.arena, me)) { why = 'за границей арены'; break }
          let need: any[]; let feet
          if (st.x === 0 && st.z === 0) {
            // Цель прямо надо мной/подо мной: столб вверх (блок под ноги в прыжке) или копать вниз.
            if (dy >= 1) {
              if (!(await open(c.offset(0, 2, 0)))) { why = why || 'над головой не пробить'; break }
              if (ctl.aborted || !bot.entity.onGround || !supportAt(observedCollision(bot), me, .04)) break
              bot.setControlState('jump', true); await bot.waitForTicks(6); bot.setControlState('jump', false)
              if (ctl.aborted) break
              const r = await placeBlockAt(bot, c, { honest: true, exactAim: true, steady: true, timeoutMs: 1500, ctl }).catch(() => null)
              if (!r?.ok) { why = 'не поставить ступень под собой'; break }
              placed++; steps++; await bot.waitForTicks(4); continue
            }
            if (dy >= 0) break
            const standing = supportAt(observedCollision(bot), me, .04)
            if (!bot.entity.onGround || !standing || !(await open(standing.block.position))) { why = why || 'под ногами не пробить'; break }
            await bot.waitForTicks(8)
            if (bot.entity.position.y >= me.y) { why = 'не спустился'; break }
            steps++; continue
          }
          if (up) { need = [c.offset(0, 2, 0), nx.offset(0, 1, 0), nx.offset(0, 2, 0)]; feet = nx.offset(0, 1, 0) }
          else if (down) { need = [nx, nx.offset(0, 1, 0), nx.offset(0, -1, 0)]; feet = nx.offset(0, -1, 0) }
          else { need = [nx, nx.offset(0, 1, 0)]; feet = nx }
          let ok = true
          for (const v of need) if (!(await open(v))) { ok = false; break }
          if (!ok) { if (why || ++stuck >= 3) { why = why || 'не пробить'; break } flip = !flip; continue }
          // Пол под новой клеткой: пусто — свой блок (не в пропасть).
          const floor = feet.offset(0, -1, 0), goal = feet.offset(0.5, 0, 0.5)
          const water = wet(feet) || wet(feet.offset(0, 1, 0)); if (water) { why = `${water} у прохода`; break }
          if (!ctl.aborted && isAir(observedCollision(bot).blockAt(floor))) {
            const r = await placeBlockAt(bot, floor, { honest: true, exactAim: true, steady: true, timeoutMs: 1500, ctl }).catch(() => null)
            if (r?.ok) placed++
            else {
              if (!ctl.aborted) missingFooting = { x: floor.x, y: floor.y, z: floor.z }
              why = r?.reason || 'под ногами пусто, блоков нет'; break
            }
          }
          const landing = supportAt(observedCollision(bot), goal, .5)
          if (!landing) { why = 'не вижу опоры'; break }
          goal.y = landing.top
          // Шаг в клетку: лицом к ней, вперёд (вверх — с прыжком), до 20 тиков.
          for (let t = 0; t < 20 && !ctl.aborted; t++) {
            const pos = bot.entity.position
            if (pos.floored().x === feet.x && pos.floored().z === feet.z && Math.abs(pos.y - goal.y) < 0.6) break
            await bot.lookAt(goal.offset(0, 1.6, 0), true)
            const view = observedCollision(bot), from = bot.entity.position
            // Below a lower slab, even the tallest 1.21.11 collision shape cannot reach the body.
            // Use its conservative envelope there; the packet behind the slab remains unobserved.
            const corridor = { ...view, blockAt: at => at.y + 1.5 <= Math.min(from.y, goal.y)
              ? { name: 'unknown', position: at, shapes: [[0, 0, 0, 1, 1.5, 1]] as const } : view.blockAt(at) }
            if (ctl.aborted || !withinArena(bot, goal, p.arena, from) || !supportAt(view, goal, .04) || !bodyClear(corridor, goal, { from })) {
              why = 'не вижу безопасного прохода и опоры'; break
            }
            bot.setControlState('forward', true); bot.setControlState('jump', up && bot.entity.onGround)
            await bot.waitForTicks(1)
          }
          bot.clearControlStates()
          if (why || ctl.aborted) break
          const moved = !bot.entity.position.floored().equals(c)
          stuck = moved ? 0 : stuck + 1
          if (stuck >= 3) { why = 'не шагнуть'; break }
          if (moved) steps++
        }
      } finally { bot.clearControlStates() }
      const at = bot.entity.position.floored()
      return { ok: reached(), steps, dug, placed, why, ...(missingFooting && { missingFooting }), ...(exposedChest && { exposedChest }), at: { x: at.x, y: at.y, z: at.z } }
    }, { timeoutMs: Math.max(10, Math.min(120, p.timeoutSeconds ?? 60)) * 1000, interruptOn: p.seekChest === true ? ['damage', 'death', 'kicked', 'disconnected'] : ['death', 'kicked', 'disconnected'], params: p }),
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
