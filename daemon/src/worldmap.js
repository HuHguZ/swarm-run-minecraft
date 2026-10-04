'use strict'
const fs = require('fs')
const path = require('path')

// Карта мира в голове: где был (по чанкам, по измерениям) и на какой высоте
// искать какую руду. Два вопроса, которые раньше решались случайностью:
// «куда идти искать, где ещё не был» — поиск в ширину по сетке чанков от
// текущего к ближайшему непосещённому; «на какой глубине копать за X» —
// распределение руды из данных генерации мира, а не по памяти.

// ---------------------------------------------------------------- руда
//
// data/minecraft/worldgen/placed_feature/ore_*.json из paper-1.21.11.jar
// (height_range; trapezoid без plateau — пик посередине, uniform — ровно).
// Верхний мир: низ -64, верх 320; бедрок -64..-60.
const ORES = {
  diamond: {
    blocks: ['diamond_ore', 'deepslate_diamond_ore'],
    y: -58,
    why: 'ore_diamond / _large / _buried: трапеция -144..16 (пик -64, обрезан низом мира) + ore_diamond_medium равномерно -64..-4 — гуще всего у бедрока; -58 — выше бедрока (-64..-60)',
    dim: 'overworld'
  },
  iron: {
    blocks: ['iron_ore', 'deepslate_iron_ore'],
    y: 16,
    why: 'ore_iron_middle: трапеция -24..56, пик 16; ore_iron_small: равномерно -64..72; ore_iron_upper: трапеция 80..384, пик 232 (только в горах)',
    alt: 232,
    dim: 'overworld'
  },
  gold: { blocks: ['gold_ore', 'deepslate_gold_ore'], y: -16, why: 'ore_gold: трапеция -64..32, пик -16; ore_gold_lower: равномерно -64..-48', dim: 'overworld' },
  redstone: { blocks: ['redstone_ore', 'deepslate_redstone_ore'], y: -58, why: 'ore_redstone_lower: трапеция -96..-32 (пик -64); ore_redstone: равномерно -64..-49', dim: 'overworld' },
  lapis: { blocks: ['lapis_ore', 'deepslate_lapis_ore'], y: 0, why: 'ore_lapis: трапеция -32..32, пик 0; ore_lapis_buried: равномерно -64..0', dim: 'overworld' },
  coal: { blocks: ['coal_ore', 'deepslate_coal_ore'], y: 96, why: 'ore_coal_lower: трапеция 0..192, пик 96; ore_coal_upper: равномерно 136..320', dim: 'overworld' },
  copper: { blocks: ['copper_ore', 'deepslate_copper_ore'], y: 48, why: 'ore_copper: трапеция -16..112, пик 48', dim: 'overworld' },
  emerald: { blocks: ['emerald_ore', 'deepslate_emerald_ore'], y: 232, why: 'ore_emerald: трапеция -16..480, пик 232 — только в горных биомах', dim: 'overworld' },
  ancient_debris: { blocks: ['ancient_debris'], y: 15, why: 'ore_ancient_debris_large: трапеция 8..24, пик 16; ore_debris_small: равномерно 8..120', dim: 'the_nether' },
  quartz: { blocks: ['nether_quartz_ore'], y: 64, why: 'ore_quartz_nether: равномерно 10..118', dim: 'the_nether' },
  nether_gold: { blocks: ['nether_gold_ore'], y: 64, why: 'ore_gold_nether: равномерно 10..118', dim: 'the_nether' }
}

function oreFor (name) {
  if (ORES[name]) return { name, ...ORES[name] }
  for (const [k, v] of Object.entries(ORES)) if (v.blocks.includes(name)) return { name: k, ...v }
  return null
}

// ---------------------------------------------------------------- карта

const CHUNK = 16

class WorldMap {
  constructor (memoryDir) {
    this.file = memoryDir ? path.join(memoryDir, 'worldmap.json') : null
    this.seen = {} // dimension -> { 'cx,cz': t }
    this.hints = {} // dimension -> { 'cx,cz': { trees, water, lava, stone, animals } }
    this.last = {} // dimension -> { 'cx,cz': когда был там последний раз } — в памяти, не на диске
    this.saveAt = 0
    try { const s = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.seen = s.seen || {}; this.hints = s.hints || {} } catch {}
  }

  key (x, z) { return `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}` }

  visit (dim, pos) {
    const m = this.seen[dim] || (this.seen[dim] = {})
    const k = this.key(pos.x, pos.z)
    if (!m[k]) m[k] = Date.now()
    ;(this.last[dim] || (this.last[dim] = {}))[k] = Date.now()
    if (Date.now() - this.saveAt > 30000) this.save()
  }

  hint (dim, pos, what) {
    const m = this.hints[dim] || (this.hints[dim] = {})
    const k = this.key(pos.x, pos.z)
    m[k] = { ...(m[k] || {}), [what]: Date.now() }
  }

  save () {
    this.saveAt = Date.now()
    if (!this.file) return
    try { fs.writeFileSync(this.file, JSON.stringify({ seen: this.seen, hints: this.hints })) } catch {}
  }

  // Поиск в ширину по сетке чанков от текущего: ближайший непосещённый
  // (или с подсказкой want, если такой есть в пределах той же глубины
  // поиска). avoid(cx, cz) — запретные клетки (правила мозга). Возвращает
  // центр чанка { x, z, cx, cz, steps, why } или null.
  frontier (dim, pos, { want = null, maxSteps = 24, avoid = null, heading = null } = {}) {
    const seen = this.seen[dim] || {}
    const hints = this.hints[dim] || {}
    const last = this.last[dim] || {}
    // Подсказка живая, только если она новее последнего визита в тот чанк:
    // пришёл, а там пусто — значит, ушли (директор 2026-09-25: roam_animals
    // гонял между двумя соседними чанками по старой подсказке). Разведка
    // обновляет подсказки раз в 10 с, отсюда допуск 15 с. Животные бродят —
    // их подсказка живёт 5 минут.
    const fresh = (k) => {
      const h = hints[k] && hints[k][want]
      if (!h) return false
      if (want === 'animals' && Date.now() - h > 300000) return false
      return !last[k] || h >= last[k] - 15000
    }
    const sx = Math.floor(pos.x / CHUNK)
    const sz = Math.floor(pos.z / CHUNK)
    const q = [[sx, sz, 0]]
    const was = new Set([`${sx},${sz}`])
    // Курс (heading {x,z}) — из почти равных по дальности неразведанных брать
    // тот, что по ходу: «ближайший» без курса метался 19,2 ↔ 19,-2.
    let firstFree = null
    const free = []
    const pick = () => {
      if (!free.length) return null
      if (!heading) return free[0]
      const h = Math.hypot(heading.x, heading.z) || 1
      const score = (c) => ((c.cx - sx) * heading.x + (c.cz - sz) * heading.z) / (h * (Math.hypot(c.cx - sx, c.cz - sz) || 1))
      return free.slice().sort((a, b) => score(b) - score(a))[0]
    }
    while (q.length) {
      const [cx, cz, d] = q.shift()
      const k = `${cx},${cz}`
      if (firstFree && d > firstFree.steps + 1) {
        if (!want) return pick()
      }
      if (d > 0 && !(avoid && avoid(cx, cz))) {
        if (want && fresh(k)) {
          return { x: cx * CHUNK + 8, z: cz * CHUNK + 8, cx, cz, steps: d, why: `там видел ${want}` }
        }
        if (!seen[k] && (!firstFree || d <= firstFree.steps + 1)) {
          const c = { x: cx * CHUNK + 8, z: cz * CHUNK + 8, cx, cz, steps: d, why: 'ближайший неразведанный чанк' }
          if (!firstFree) firstFree = c
          free.push(c)
        }
      }
      if (d >= maxSteps) continue
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nk = `${cx + dx},${cz + dz}`
        if (was.has(nk)) continue
        was.add(nk)
        q.push([cx + dx, cz + dz, d + 1])
      }
    }
    return pick() || firstFree
  }

  stats (dim) {
    return { chunks: Object.keys(this.seen[dim] || {}).length, hinted: Object.keys(this.hints[dim] || {}).length }
  }
}

module.exports = { WorldMap, ORES, oreFor, CHUNK }
