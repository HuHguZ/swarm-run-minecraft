'use strict'
// Маршрут спидраннера по знанию карты (поток route): по сиду и рюкзаку — план шагов с бюджетом времени (дерево, камень,
// заходы за железом и огнём по цене, вода, литьё, вход в Ад); ход по нему — в кампании (ND_ROUTE=1). Части — в route/: data
// (данные по сиду и вслепую, аванпост), candidates (стада, кровати, железо, лава, рощи), plan (план и его строка), risk
// (учёт шага, цена копки и воды, озёра лавы). Кэш seedtool: node dist/daemon/src/route.js cache | plan <сид> | stats.
export { seenInfo, GOLEM_DEATH_P, MINE_DEATH_P, DEATH_S, mapLevel, structOnly, structureSearchLeft, outpostStepCost, outpostNear, outpostWaypoint, routeInfo, seedInfo, poolRow, oresOf, LOOT, WORK, SPEED } from './route/data'
export { foodHerds, woodCandidates, sheepHerds, bedCands, BUCKETS, pickLava, lavaCands, castOdds, ironNeed, orderPoints } from './route/candidates'
export { plan, describe, routeName } from './route/plan'
export { interruptCap, routeActRisk, waterDigPrice, digBlocksOf, scoutLegPrice, lavaLakes, digRefuse, digRiskTicks, healTicks, bookStep } from './route/risk'
import * as fs from 'fs'
import { POOL, readCache, SEEDTOOL, CACHE, routeInfo } from './route/data'
import { plan, describe } from './route/plan'

// Кэш seedtool по пулу: node dist/daemon/src/route.js cache  (300 сидов — ~10 с).
if (require.main === module) {
  const cmd = process.argv[2]
  if (cmd === 'cache') {
    const seeds = (JSON.parse(fs.readFileSync(POOL, 'utf8')).seeds || []).map(s => String(s.seed))
    const c = readCache()
    const left = seeds.filter(s => !c[s])
    for (let i = 0; i < left.length; i += 50) {
      const chunk = left.slice(i, i + 50)
      const out = (require('child_process') as typeof import('child_process')).execFileSync(SEEDTOOL, ['info', ...chunk], { encoding: 'utf8', timeout: 120000, windowsHide: true })
      for (const line of out.trim().split('\n')) { try { const j = JSON.parse(line); c[String(j.seed)] = j } catch {} }
    }
    fs.writeFileSync(CACHE, JSON.stringify(c))
    console.log(`кэш: ${Object.keys(c).length} сидов → ${CACHE}`)
  } else if (cmd === 'plan') {
    const info = routeInfo(process.argv[process.argv.length - 1])
    if (!info) { console.log('сида нет'); process.exit(1) }
    console.log(describe(plan(info)))
  } else if (cmd === 'stats') {
    const seeds = (JSON.parse(fs.readFileSync(POOL, 'utf8')).seeds || []).filter(s => typeof s.lava === 'number').map(s => String(s.seed))
    const by = {}
    const budgets = []
    for (const s of seeds) { const p = plan(routeInfo(s)); by[p.route] = (by[p.route] || 0) + 1; budgets.push(p.budget) }
    budgets.sort((a, b) => a - b)
    console.log(JSON.stringify({ n: seeds.length, medianBudgetMin: Math.round(budgets[budgets.length >> 1] / 6) / 10, p90Min: Math.round(budgets[Math.floor(budgets.length * 0.9)] / 6) / 10, routes: (Object.entries(by) as [string, any][]).sort((a: any, b: any) => b[1] - a[1]) }, null, 1))
  } else console.log('node dist/daemon/src/route.js cache | plan <сид> | stats')
}
