'use strict'
// RPC демона — правда сцены и отладка (не зрение): ask, slice, блоки вокруг, время копки, физика, профиль.
// Фабрика методов над контекстом демона (rpc/context.ts); обработчики перенесены из src/index.ts.
import type { RpcContext } from './context'

function worldTruthMethods ({ session, gameClock }: RpcContext) {
  return {
    // Сценам: команда оператора и то, что сервер ответил в чат этому игроку.
    // Ответ /locate в latest.log не попадает (sendSuccess без логирования), а
    // сцене нужна правда о мире, а не отчёт демона.
    ask: async (p) => session.immediate(async () => {
      const bot = session.require()
      const lines = []
      const on = m => lines.push(String(m))
      const re = p && p.match ? new RegExp(p.match) : null
      bot.on('messagestr', on)
      try {
        bot.chat(String((p && p.command) || '').slice(0, 250))
        const t0 = gameClock.wall.now()
        while (gameClock.wall.now() - t0 < Math.min(20000, (p && p.ms) || 3000)) {
          if (re && lines.some(l => re.test(l))) break
          await gameClock.wall.sleep(100)
        }
      } finally { bot.removeListener('messagestr', on) }
      return { lines }
    }),
    // Сценам и отладке: срез мира вокруг тела по слоям, без зрения (fairPlay не
    // участвует) — «что на самом деле лежит вокруг», когда отчёт и мир спорят.
    // Сценам и отладке: срез коробки x0..x1, y0..y1, z0..z1 символами (правда
    // мира, как blocks_around; не зрение). '.' воздух, 'L' лава, 'W' вода,
    // 'G' золото, 'C' сундук, 'B' чернокамень/кирпич, 'b' базальт, 'n' незерак,
    // 's' неполные, 'o' прочее, '?' не прогружено. Не больше 40000 клеток.
    slice: async (p) => session.immediate(async () => {
      const bot = session.require()
      const { Vec3 } = require('vec3')
      const [x0, x1] = [Math.min(p.x0, p.x1), Math.max(p.x0, p.x1)]
      const [y0, y1] = [Math.min(p.y0, p.y1), Math.max(p.y0, p.y1)]
      const [z0, z1] = [Math.min(p.z0, p.z1), Math.max(p.z0, p.z1)]
      if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 40000) throw new Error('срез больше 40000 клеток')
      // mark: {имя блока: символ} — свои метки поверх стандартных (поток overworld: «O» обсидиан, «c» булыжник).
      const mark = (p && p.mark && typeof p.mark === 'object') ? p.mark : null
      const sym = b => {
        if (!b) return '?'
        const n = b.name
        if (mark && typeof mark[n] === 'string') return mark[n].slice(0, 1)
        if (n === 'air' || n === 'cave_air' || n === 'void_air') return '.'
        if (n === 'lava') return 'L'
        if (n === 'water') return 'W'
        if (n === 'gold_block') return 'G'
        if (/chest|barrel/.test(n)) return 'C'
        if (b.boundingBox === 'empty') return ','
        if (/stairs|slab|wall$|chain|lantern|fence|bars/.test(n)) return 's'
        if (/basalt/.test(n)) return 'b'
        if (/blackstone/.test(n)) return 'B'
        if (/netherrack|nylium/.test(n)) return 'n'
        return 'o'
      }
      const layers = {}
      for (let y = y1; y >= y0; y--) {
        const rows = []
        for (let z = z0; z <= z1; z++) {
          let row = ''
          for (let x = x0; x <= x1; x++) row += sym(bot.blockAt(new Vec3(x, y, z)))
          rows.push(row)
        }
        layers[y] = rows
      }
      // mobs — ещё и все сущности, что видит клиент (имя, клетка): кто где стоит в свежем мире.
      if (p.mobs) {
        const mobs = (Object.values(bot.entities) as any[]).filter((e : any) => e !== bot.entity && e.position && e.name && e.type !== 'object')
          .map((e : any) => [e.name, Math.floor(e.position.x), Math.floor(e.position.y), Math.floor(e.position.z)])
        return { x0, z0, layers, mobs }
      }
      return { x0, z0, layers }
    }),
    blocks_around: async (p) => session.immediate(async () => {
      const bot = session.require()
      const c = bot.entity.position.floored()
      // find — где такие блоки в радиусе (правда мира для сцены, не зрение).
      if (p && p.find) {
        const b = session.mcData.blocksByName[p.find]
        if (!b) throw new Error(`нет блока ${p.find}`)
        let found = bot.findBlocks({ matching: [b.id], maxDistance: Math.min(256, p.radius || 64), count: p.count || 64 })
        // seen — только видимые глазами: луч до грани первым входит в сам блок (pick.blockSeen; «гонка вооружений» не знает
        // сундуков за облицовкой — s7b 06.10, прежний raySees с допуском 1.2 бл. пропускал их сквозь стену).
        if (p.seen) { const pk = require('../pick'); found = found.filter(v => pk.blockSeen(bot, v, { range: Math.min(256, p.radius || 64) })) }
        return { at: { x: c.x, y: c.y, z: c.z }, found: found.map(v => ({ x: v.x, y: v.y, z: v.z })) }
      }
      const r = Math.max(1, Math.min(6, (p && p.radius) || 3))
      const layers = {}
      for (let dy = r; dy >= -r; dy--) {
        const rows = []
        for (let dz = -r; dz <= r; dz++) {
          const row = []
          for (let dx = -r; dx <= r; dx++) {
            const b = bot.blockAt(c.offset(dx, dy, dz))
            row.push(!b ? '?' : b.name === 'air' || b.name === 'cave_air' ? '.' : b.name.replace(/^(infested_|mossy_|cracked_|chiseled_)/, '').slice(0, 10))
          }
          rows.push(row.join(' '))
        }
        layers[`y${c.y + dy}`] = rows
      }
      return { at: { x: c.x, y: c.y, z: c.z }, xFrom: c.x - r, zFrom: c.z - r, layers }
    }),
    // Отладка копки (арена с чарами, 2026-09-26): сколько тело само думает
    // ломать блок x,y,z — tools.digMs каждым инструментом рюкзака, bestFor и
    // bot.digTime тем, что в руке (mineflayer ждёт ровно его), — и, с dig: true,
    // сколько вышло на деле. bot.dig кончается по своему же предсказанию
    // (digging.js сам ставит «воздух»), поэтому правда сервера — через паузу:
    // не принятую ломку сервер возвращает блоком обратно. ms: N — «докопал»
    // ровно через N мс тем, что в руке, без своей оценки: сервер не должен
    // принять раньше срока. hold: имя — сперва взять это в руку.
    dig_time: async (p: any = {}) => session.immediate(async () => {
      const bot = session.require()
      const { Vec3 } = require('vec3')
      const tools = require('../tools')
      const ms = v => (Number.isFinite(v) ? Math.round(v) : String(v))
      const pos = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
      const block = bot.blockAt(pos)
      if (!block) throw new Error('блок не прогружен')
      if (p.hold) {
        const it = bot.inventory.items().find(i => i.name === p.hold)
        if (!it) throw new Error(`нет ${p.hold}`)
        await bot.equip(it, 'hand')
      }
      const by = bot.inventory.items().filter(i => /_(pickaxe|axe|shovel|hoe|sword)$|^shears$/.test(i.name)).map(i => {
        let enchants
        try { enchants = i.enchants } catch (e) { enchants = `ошибка: ${e.message}` }
        return { item: i.name, enchants, ms: ms(tools.digMs(bot, block, i)) }
      })
      const best = tools.bestFor(bot, block)
      let heldMs
      try { heldMs = ms(bot.digTime(block)) } catch (e) { heldMs = `ошибка: ${e.message}` }
      const out: any = { block: block.name, held: bot.heldItem ? bot.heldItem.name : null, heldMs, best: { item: best.item ? best.item.name : 'рука', ms: ms(best.ms) }, by }
      if (p.ms) {
        await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true)
        bot._client.write('block_dig', { status: 0, location: pos, face: 1, sequence: 0 })
        bot.swingArm()
        await new Promise<any>(r => gameClock.setTimeout(r, p.ms))
        bot._client.write('block_dig', { status: 2, location: pos, face: 1, sequence: 0 })
        out.digMs = p.ms
      } else if (p.dig) {
        const t0 = gameClock.now()
        try { await bot.dig(block, true) } catch (e) { out.digError = e.message }
        out.digMs = gameClock.now() - t0
        out.heldAfter = bot.heldItem ? bot.heldItem.name : null
      }
      if (p.dig || p.ms) {
        await new Promise<any>(r => gameClock.setTimeout(r, p.settleMs || 800))
        const now = bot.blockAt(pos)
        out.after = now ? now.name : null
      }
      return out
    }),
    // Отладка: живо ли тело — сколько физических тиков за 2 с и почему нет.
    phys: async () => {
      const bot = session.bot
      if (!bot) return { status: 'failed', error: 'нет бота' }
      const t0 = session.ticks || 0
      await new Promise<any>(r => gameClock.setTimeout(r, 2000))
      const ev = (n) => bot.listenerCount(n)
      return {
        status: 'done',
        detail: {
          tps: ((session.ticks || 0) - t0) / 2,
          physicsEnabled: bot.physicsEnabled,
          isAlive: bot.isAlive,
          vehicle: bot.vehicle ? (bot.vehicle.name || bot.vehicle.id) : null,
          pos: bot.entity && bot.entity.position,
          blockAtFeet: (() => { try { const b = bot.blockAt(bot.entity.position); return b ? b.name : null } catch (e) { return 'err ' + e.message } })(),
          effects: bot.entity && bot.entity.effects,
          listeners: { physicsTick: ev('physicsTick'), move: ev('move'), entityMoved: ev('entityMoved'), forcedMove: ev('forcedMove'), packet: bot._client.listenerCount('packet'), position: bot._client.listenerCount('position') }
        }
      }
    },
    // Отладка: профиль процессора на N секунд — самые тяжёлые функции по
    // собственному времени. Тело «встаёт» на 3 tps — смотреть сюда.
    profile: async (p) => {
      const inspector = require('inspector')
      const s = new inspector.Session()
      s.connect()
      const post = (m, a?: any) => new Promise<any>((resolve, reject) => s.post(m, a || {}, (e, r) => e ? reject(e) : resolve(r)))
      await post('Profiler.enable')
      await post('Profiler.start')
      await new Promise<any>(r => gameClock.setTimeout(r, Math.min(60, (p && p.seconds) || 10) * 1000))
      const { profile }: any = await post('Profiler.stop')
      s.disconnect()
      const self = new Map()
      const dt = profile.timeDeltas || []
      const byId = new Map(profile.nodes.map(n => [n.id, n]))
      ;(profile.samples || []).forEach((id, i) => self.set(id, (self.get(id) || 0) + (dt[i] || 0)))
      const agg = new Map()
      for (const [id, us] of self) {
        const cf = (byId.get(id) as any).callFrame
        const k = `${cf.functionName || '(anon)'} ${String(cf.url).split(/[\\/]/).slice(-2).join('/')}:${cf.lineNumber + 1}`
        agg.set(k, (agg.get(k) || 0) + us)
      }
      const total = [...agg.values()].reduce((a, b) => a + b, 0) || 1
      return { status: 'done', detail: { top: [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, us]) => `${(100 * us / total).toFixed(1)}% ${k}`) } }
    }
  }
}

export { worldTruthMethods }
