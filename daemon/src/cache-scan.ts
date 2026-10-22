'use strict'
// Глаза роя для поиска тайников (21.10; модель — swarm/cache-model): что видит игрок, крутя головой на месте.
//   · лучи из глаз по сфере (rayDirs): первая непрозрачная клетка и грань, в которую вошёл луч (как perception/eyes:
//     непрозрачно — коробка 'block' кроме стекла/решёток/паутины, и лава); незагруженный столбец — конец луча;
//   · сундуки, видимые сейчас (pick.blockSeen — луч до грани первым входит в сундук, как blocks_around seen);
//   · «пирог» F3 (perception/senses.pie), но с наклоном: счёт сундуков в окне взгляда рысканье × тангаж шагом step — как
//     человек, водя камерой по кругу и вверх-вниз, смотрит, когда в «пироге» появляется доля blockentities. Клетки наружу
//     не выходят: только счёт в окне. Отсечение заслонённых секций клиента не моделируется — как в perception/senses.
import * as eyes from './perception/eyes'
import { castRays, pieCounts } from './swarm/cache-model'

export function cacheScan (bot: any, { rays = 700, range = 56, spin = Math.random(), pie = true, pieStep = 5, pieRange = 64, chestRange = 40 }: any = {}) {
  if (!bot?.entity || !bot.registry) return null
  const n = Math.max(32, Math.min(2000, Math.floor(rays)))
  const read = eyes.reader(bot)
  const shapes = bot._ndEyes?.shapes || eyes.shapeCache(bot.registry)
  const p = bot.entity.position
  const o = { x: p.x, y: p.y + (require('./pick') as typeof import('./pick')).eyeHeight(bot), z: p.z }
  const hits = castRays(o, (x, y, z) => { const s = read.at(x, y, z); return s < 0 ? -1 : shapes.opaque(s) ? 1 : 0 }, n, spin, range)
  const out: any = { eye: o, n, spin, range, hits }
  try {
    const V = require('vec3'); const pk = require('./pick')
    const id = bot.registry.blocksByName.chest?.id
    if (id !== undefined) out.chests = bot.findBlocks({ matching: [id], maxDistance: chestRange, count: 96 }).filter(v => pk.blockSeen(bot, new V(v.x, v.y, v.z), { range: chestRange })).map(v => [v.x, v.y, v.z])
  } catch {}
  if (pie) {
    // Сундуки «пирога» — блок-сущности в прорисовке (кеш секций глаз); наружу — только счёт по окнам.
    const e = bot._ndEyes || new eyes.Eyes(bot)
    e.syncDim()
    const cells: { x: number; y: number; z: number }[] = []
    for (const s of e.sectionsNear(read, o, pieRange)) {
      const ent = e.section(read, s.cx, s.cz, s.sy)
      if (ent) for (const c of ent.cells) if (c.pie && c.name === 'chest') cells.push(c)
    }
    out.pie = { step: pieStep, range: pieRange, bins: pieCounts(o, cells, pieStep, pieRange) }
  }
  return out
}
