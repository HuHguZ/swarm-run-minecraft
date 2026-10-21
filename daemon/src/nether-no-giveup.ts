'use strict'
// Proposed destination: daemon/src/nether-no-giveup.ts. No nested runIntent.
const { Vec3 }: typeof import('vec3') = require('vec3')
const clock: typeof import('./game-clock') = require('./game-clock')
const sight: typeof import('./sight') = require('./sight')
const pick: typeof import('./pick') = require('./pick')
const tools: typeof import('./tools') = require('./tools')
const build: typeof import('./build') = require('./build')
type Cell = { x: number; y: number; z: number }
type Candidate = { key: string; kind: string; seconds: number; risk: number; cost: number; failures: number; evidence: string; target?: Cell; [key: string]: any }
interface BodyMemory { dimension: string; own: Map<string, string>; floors: Map<string,string>; trail: Cell[]; failures: Map<string, number>; views: number; attached: boolean }
const memories = new WeakMap<object, BodyMemory>()
const on = () => process.env.ND_NE_NO_GIVEUP === '1'
const dimension = bot => String(bot.game?.dimension || '')
const inNether = bot => /(?:^|:)the_nether$|^nether$/.test(dimension(bot))
const cell = p => ({ x: Math.floor(p.x), y: Math.floor(p.y + 1e-6), z: Math.floor(p.z) })
const key = p => `${p.x},${p.y},${p.z}`
const vec = p => new Vec3(p.x, p.y, p.z)
const at = (p, x = 0, y = 0, z = 0) => ({ x: p.x + x, y: p.y + y, z: p.z + z })
const around = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const hazard = /^(lava|water|bubble_column|fire|soul_fire|cobweb|powder_snow|magma_block|campfire|soul_campfire)$/
const full = b => !!b && b.boundingBox === 'block' && !hazard.test(b.name) && b.shapes?.some(s => s.length === 6 && s.every((v, i) => v === (i < 3 ? 0 : 1)))
const empty = b => !!b && b.boundingBox === 'empty' && !hazard.test(b.name) && !/portal|gateway/.test(b.name)
function memory(bot): BodyMemory {
  let m = memories.get(bot)
  if (!m) { m = { dimension: dimension(bot), own: new Map(), floors:new Map(), trail: [], failures: new Map(), views: 0, attached: false }; memories.set(bot, m) }
  if (m.dimension !== dimension(bot)) { m.dimension = dimension(bot); m.own.clear(); m.floors.clear(); m.trail = []; m.failures.clear(); m.views = 0 }
  return m
}
/** Call only after the server confirmed the actual placed support block. */
export function recordOwnSupport(bot, p: Cell): void {
  if (!on() || !bot?.entity || !inNether(bot)) return
  const f = cell(p), b = bot.blockAt(vec(f), false)
  if (!full(b)) return
  const own = memory(bot).own
  own.set(key(f), b.name)
  if (own.size > 4096) own.delete(own.keys().next().value)
}
/** Starts with the first sensed body, never infers an unvisited route from chunks. */
export function trackNetherBody(bot): void {
  if (!on() || !bot?.entity) return
  const m = memory(bot)
  const sample = () => {
    if (!on() || !bot.entity) return
    const s = memory(bot)
    if (!inNether(bot) || !bot.entity.onGround || (bot.health ?? 20) <= 0) return
    const f = cell(bot.entity.position), k = key(f)
    if (s.trail.length && key(s.trail[s.trail.length - 1]) === k) return
    const floor=at(f,0,-1), support=bot.blockAt(vec(floor),false)
    // This is physical contact under our own grounded body, not a scan below a future dig.
    if(Math.abs(bot.entity.position.y-f.y)<1e-6 && full(support)) {s.floors.set(key(floor),support.name);if(s.floors.size>4096)s.floors.delete(s.floors.keys().next().value)}
    const previous = s.trail.findIndex(p => key(p) === k)
    // Returning to an earlier cell removes the loop rather than appending a new way back to the detour.
    if (previous >= 0) s.trail.length = previous + 1
    else { s.trail.push(f); if (s.trail.length > 4096) s.trail.shift() }
  }
  if (!m.attached) {
    m.attached = true
    bot.on('physicsTick', sample)
    bot.on('death', () => { const s = memories.get(bot); if (s) { s.own.clear(); s.floors.clear(); s.trail = []; s.failures.clear(); s.views = 0 } })
  }
  sample()
}

/** Только чтение: след тела в Аду (клетки ног на твёрдом полу, петли сняты), от раннего к позднему (blz: ND_BLZ_RETRACE). */
export function netherTrail(bot): Cell[] { const m = memories.get(bot); return m && inNether(bot) ? m.trail.slice() : [] }

/** One concrete recovery attempt. Unknown geometry and failed actions never prove impossibility. */
export async function recoverNether(session, ctl, p: any = {}) {
  const bot = session.bot
  const out: any = { ok: false, progressed: false, impossible: false, interrupted: !!ctl.aborted, candidates: [] }
  if (!on() || !bot?.entity || ctl.aborted || !inNether(bot) || (bot.health ?? 0) <= 0) return { ...out, why: 'восстановление выключено, тело прервано, погибло или находится вне Ада' }
  const m = memory(bot), me = cell(bot.entity.position)
  const read = p => bot.blockAt(vec(p), false)
  const seen = p => { try { return sight.seesBlock(bot, read(p)) || !empty(read(p)) && pick.blockSeen(bot,vec(p),{range:64}) } catch { return false } }
  const reachable = p => { try { return pick.blockSeen(bot, vec(p), { range: 4.5, seeThrough:null }) } catch { return false } }
  const own = p => full(read(p)) && m.own.get(key(p)) === read(p).name
  const free = p => empty(read(p)) && seen(p)
  const stand = p => full(read(at(p, 0, -1))) && seen(at(p, 0, -1)) && free(p) && free(at(p, 0, 1))
  const items = () => bot.inventory.items()
  const count = re => items().filter(i => re.test(i.name)).reduce((n, i) => n + i.count, 0)
  const inv0 = items().map(i => `${i.name}:${i.count}:${i.durabilityUsed || 0}`).sort().join('|')
  const timeout = Math.max(1, Math.min(600, Number(p.timeoutSeconds) || 90))
  const deadline = clock.now() + timeout * 1000
  const candidates: Candidate[] = []
  // Seconds and risk below are decision estimates, not native Minecraft constants or claims of measured death probability.
  let threats: any[] = []
  try { threats = (require('./perception/eyes') as typeof import('./perception/eyes')).entities(bot, { radius: 32, rememberMs: 0, hearMs: 0 }).filter(e => e.seen && e.pos && /^(ghast|blaze|wither_skeleton|skeleton|magma_cube|hoglin|zoglin|piglin_brute|piglin|zombified_piglin)$/.test(e.name)) } catch {}
  const add = (kind, target, seconds, risk, evidence, extra: any = {}) => {
    if (!Number.isFinite(seconds) || seconds < 0) return
    const bodyAt = kind === 'tower' ? at(me, 0, 1) : kind === 'dig' || kind === 'wood' || kind === 'craft' ? me : target || me
    const visibleThreatRisk = threats.reduce((total, e) => {
      const d = Math.hypot(e.pos.x - bodyAt.x - .5, e.pos.y - bodyAt.y, e.pos.z - bodyAt.z - .5)
      // Conservative decision estimate: neutral piglins are deliberately priced as potentially hostile.
      return total + Math.min(.8, seconds / (Math.max(1, d - 1) * 25))
    }, 0)
    risk = Math.min(.99, risk + visibleThreatRisk * 20 / Math.max(1, bot.health))
    const k = `${kind}:${target ? key(target) : ''}:${extra.block || ''}`
    if(candidates.some(c=>c.key===k))return
    candidates.push({ key: k, kind, target, seconds, risk, cost: 0, failures: 0, evidence, ...extra })
  }
  const lowHpRisk = (base: number) => Math.min(.95, base * (20 / Math.max(1, bot.health)))

  // A strict 1x1x2 enclosure, with every face witnessed now. Missing one face means unknown.
  const shell = [at(me, 0, -1), at(me, 0, 2), ...around.flatMap(([x, z]) => [at(me, x, 0, z), at(me, x, 1, z)])]
  const sealed = free(me) && free(at(me, 0, 1)) && shell.every(q => full(read(q)) && read(q).name === 'bedrock' && seen(q))
  // Barrier texture is invisible in survival; a collision ray is not proof that a human saw it.
  if (sealed && !count(/^(ender_pearl|chorus_fruit)$/) && !bot.vehicle) return { ...out, impossible: true, proof: 'sealed-unbreakable', why: 'все 10 граней клетки 1×2 видны и состоят из bedrock; предметов телепортации и транспорта нет', at: me }

  // Down exactly one known support. The lower solid floor is known from our own confirmed placement, not x-ray.
  const support = at(me, 0, -1), nextFloor = at(me, 0, -2)
  const safeBelow = () => own(nextFloor) || full(read(nextFloor)) && (m.floors.get(key(nextFloor))===read(nextFloor).name || seen(nextFloor))
  if (own(support) && safeBelow() && reachable(support)) {
    add('own-down', support, tools.bestFor(bot, read(support)).ms / 1000 + .8, lowHpRisk(.0005), 'верхний блок свой, нижний подтверждён установкой, прежней стойкой тела или виден; падение ровно 1 блок', { block: read(support).name })
  }

  const steps: Cell[] = []
  for (const [x, z] of around) for (const y of [-1, 0, 1]) {
    const to = at(me, x, y, z)
    if (stand(to) && (y !== 1 || free(at(me, 0, 2)))) steps.push(to)
  }
  // Trail is a sequence of grounded, physically visited body cells. Revalidate the immediate next step.
  const back = m.trail.slice(0, Math.max(0, m.trail.findIndex(q => key(q) === key(me))))
  const trailTo = [...back].reverse().find(q => steps.some(s => key(q) === key(s)))
  if (trailTo) add('trail', trailTo, 1, lowHpRisk(.0005), 'след тела ведёт к ранее пройденной клетке; пол и обе клетки тела снова видны')
  for (const to of steps) {
    const visited = m.trail.some(q => key(q) === key(to))
    add('walk', to, visited ? 40 : 30, lowHpRisk(.001), 'видимый полный пол и две свободные клетки; бюджет нового обзора 30 с', { up: to.y > me.y })
  }

  // Tower only toward an actually seen exit ledge, one block per invocation. No arbitrary pillar into the sky.
  const filler = build.pickFiller(bot, { steady: true })
  if (filler && full(read(support)) && free(at(me, 0, 2))) {
    const walls = around.filter(([x, z]) => [0, 1].some(y => full(read(at(me, x, y, z))) && seen(at(me, x, y, z))))
    if (!steps.length && walls.length >= 2) add('tower', at(me, 0, 1), 1.3, lowHpRisk(.003), 'яма: видны минимум две стены, пол твёрдый, над головой воздух; один блок для нового обзора', { item: filler.name })
    for (const [x, z] of around) for (let rise = 2; rise <= Math.min(6, filler.count + 1); rise++) {
      const ledge = at(me, x, rise, z)
      if (!stand(ledge)) continue
      let shaft = true
      for (let y = 2; y <= rise + 1; y++) if (!free(at(me, 0, y))) shaft = false
      if (shaft) add('tower', ledge, rise * 1.3 + 1, lowHpRisk(.001), 'видимый уступ, открытая шахта и переносимые блоки; выполняется один подъём', { item: filler.name })
    }
  }

  // Controlled clutch: build a visible supported stair before moving, never jump toward an unconfirmed block.
  if (filler) for (const [x, z] of around) for (const dy of [-1, 0]) {
    const to = at(me, x, dy, z), floor = at(to, 0, -1)
    if (!free(to) || !free(at(to, 0, 1)) || !empty(read(floor)) || !seen(floor)) continue
    const faces = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]
    const anchored = faces.some(([dx,dy,dz]) => {
      const ref = at(floor, dx, dy, dz)
      if (!full(read(ref)) || !seen(ref)) return false
      try { return !!pick.faceAim(bot, vec(ref), new Vec3(-dx,-dy,-dz), { range: 4.5 }) } catch { return false }
    })
    if (anchored) add('clutch-step', to, 2.5, lowHpRisk(.002), 'видимая опорная грань и свободная клетка; сперва honest placement и solid receipt, потом шаг', { floor, item: filler.name })
  }

  const usablePicks=items().filter(i=>/_pickaxe$/.test(i.name) && (!i.maxDurability || i.maxDurability>(i.durabilityUsed||0)))
  const pickMissing = !usablePicks.length, needsTools=!usablePicks.some(i=>/^(stone|iron|diamond|netherite)_pickaxe$/.test(i.name))
  const stone = ['cobblestone','cobbled_deepslate','blackstone'].some(n=>count(new RegExp('^'+n+'$'))>=3)
  const tableIds = [session.mcData?.blocksByName?.crafting_table?.id].filter(n => n != null)
  const visibleTable = tableIds.length ? (bot.findBlocks({ matching: tableIds, maxDistance: 4, count: 20 }) || []).find(q => seen(q) && reachable(q)) : null
  const table = count(/^crafting_table$/) > 0 || visibleTable
  const wood = count(/_planks$/) + 4 * count(/_(log|stem|wood|hyphae)$/)
  const baseWoodNeed=(table?0:4)+(count(/^stick$/)>=2?0:2)
  const woodNeed = baseWoodNeed + (pickMissing&&!stone?3:0)
  if (needsTools && stone && wood >= baseWoodNeed) add('craft', null, 5 + (table ? 0 : 3), lowHpRisk(.001), 'однородный камень ×3; палки или достаточно переносимого дерева на палки и верстак', { item:'stone_pickaxe',woodNeed:baseWoodNeed })
  if (pickMissing && !stone && wood>=woodNeed) add('craft',null,6+(table?0:3),lowHpRisk(.001),'камня пока нет: деревянная кирка добывает видимый чернокамень; минимальный рецепт',{item:'wooden_pickaxe',woodNeed})
  const stemIds = ['warped_stem', 'crimson_stem'].map(n => session.mcData?.blocksByName?.[n]?.id).filter(n => n != null)
  const stems = needsTools && wood < woodNeed && stemIds.length ? (bot.findBlocks({ matching: stemIds, maxDistance: 32, count: 120 }) || []).map(cell).filter(seen) : []
  for (const q of stems) {
    const b = read(q), seconds = tools.bestFor(bot,b).ms / 1000 + .8
    if (reachable(q)) add('wood', q, seconds, lowHpRisk(.001), 'стебель виден и доступен прицелу в 4.5 блока', { block:b.name })
    else {
      const current = Math.hypot(q.x-me.x,q.y-me.y,q.z-me.z)
      const step = steps.slice().sort((a,b) => vec(a).distanceTo(vec(q)) - vec(b).distanceTo(vec(q))).find(s => vec(s).distanceTo(vec(q)) < current)
      if (step) add('wood-walk', step, current * .5 + seconds, lowHpRisk(.002), 'стебель виден; выполняется ближайший проверенный шаг к нему, дальнейший путь пока неизвестен', { goal:q })
    }
  }
  if(needsTools && !pickMissing && !stone) {
    const ids=['blackstone','cobblestone','cobbled_deepslate'].map(n=>session.mcData?.blocksByName?.[n]?.id).filter(n=>n!=null)
    for(const q of ids.length?bot.findBlocks({matching:ids,maxDistance:4.5,count:40})||[]:[]) {
      if(!seen(q)||!reachable(q)||key(q)===key(support))continue
      const b=read(q), plan=tools.bestFor(bot,b)
      if('harvest' in plan && plan.harvest)add('stone',cell(q),plan.ms/1000+1,lowHpRisk(.001),'видимый камень; имеющаяся кирка действительно даёт drop',{block:b.name})
    }
  }

  // Collect only a block under the client's crosshair; breaking for an exit does not require harvest eligibility.
  for (const [x, z] of around) for (const y of [0, 1]) {
    const q = at(me, x, y, z), b = read(q)
    if (!b || empty(b) || !reachable(q) || !seen(q)) continue
    const ms = tools.bestFor(bot, b).ms
    if (!Number.isFinite(ms)) continue
    if (needsTools && /^(warped_stem|crimson_stem)$/.test(b.name) && wood < woodNeed) add('wood', q, ms / 1000 + .8, lowHpRisk(.001), 'видимый стебель в досягаемости; после копки проверяется прирост инвентаря', { block: b.name })
    else add('dig', q, ms / 1000 + 1, lowHpRisk(.003), 'видимое препятствие; время из tools.bestFor/digTime, инструмент для выпадения предмета не требуется', { block: b.name })
  }
  // Natural/placed roof may be the only way out of a pit. It must be seen and reachable too.
  const ceiling = at(me, 0, 2), cb = read(ceiling)
  if (cb && !empty(cb) && reachable(ceiling) && seen(ceiling)) add('dig', ceiling, tools.bestFor(bot, cb).ms / 1000 + 1, lowHpRisk(.003), 'видимый потолок над телом', { block: cb.name })

  // A live portal, witnessed at the remembered arrival point, is a concrete return action.
  const portalId = session.mcData?.blocksByName?.nether_portal?.id
  const portals = portalId == null ? [] : bot.findBlocks({ matching: [portalId], maxDistance: 5, count: 20 }) || []
  const livePortal = portals.find(q => seen(q) && (!p.portal || Math.hypot(q.x - p.portal.x, q.y - p.portal.y, q.z - p.portal.z) <= 8))
  if (livePortal) add('portal', cell(livePortal), 6, lowHpRisk(.001), 'живой портал виден вблизи; вход штатным nether.enter')
  add('explore', null, 45, lowHpRisk(.01), 'конкретная штатная разведка нового вида: видимые стебли, радиус 32, шаг 16, бюджет 45 с')

  const signature = `${dimension(bot)}|${key(me)}|${inv0}|${Math.floor(bot.health)}|${candidates.map(c => c.key).sort().join(';')}`
  // Failed choices are repriced in unchanged evidence. The next alternative is no longer starved by a cheap failure.
  for (const c of candidates) {
    c.failures = m.failures.get(signature + '|' + c.key) || 0
    c.retrySeconds = Math.min(3600, 15 * (2 ** Math.min(9, c.failures) - 1))
    c.cost = c.seconds + c.risk * 3600 + c.retrySeconds
  }
  if (candidates.length === 1 || candidates.filter(c => c.kind !== 'explore').every(c => c.failures > 0)) {
    const failures = m.failures.get(signature + '|observe') || 0
    add('observe', null, 1 + failures * 15, 0, 'конкретный осмотр следующего сектора и один физический тик для новых чанков', { sector: m.views % 4 })
    candidates[candidates.length - 1].cost = 1 + failures * 15
  }
  candidates.sort((a, b) => a.cost - b.cost || a.key.localeCompare(b.key))
  const chosen = candidates[0]
  Object.assign(out, { candidates, chosen, at: me, threats: threats.map(e=>({id:e.id,name:e.name,pos:e.pos})), estimates: 'seconds and risk are estimates; retrySeconds prices repeated failure' })
  if (p.planOnly) return { ...out, why: 'план без действий' }
  if (ctl.aborted) return { ...out, interrupted: true }
  const beforeWood = wood, beforeDim = dimension(bot)
  const usefulBefore = Object.fromEntries(items().map(i=>i.name).filter(n=>/_(log|stem|wood|hyphae|planks|pickaxe)$|^(stick|crafting_table|cobblestone|cobbled_deepslate|blackstone)$/.test(n)).map(n=>[n,count(new RegExp('^'+n+'$'))]))
  const stop = () => { try { Promise.resolve(bot.stopDigging()).catch(() => {}) } catch {}; try { bot.clearControlStates() } catch {} }
  ctl.onAbort.push(stop)
  let changed = false
  try {
    bot.pathfinder?.setGoal(null)
    if (chosen.kind === 'own-down' || chosen.kind === 'dig' || chosen.kind === 'wood' || chosen.kind==='stone') {
      const q = chosen.target
      if (!reachable(q) || (chosen.kind === 'own-down' && !(own(support) && safeBelow()))) throw new Error('геометрия или видимость изменилась')
      const b = read(q), ms = tools.bestFor(bot, b).ms
      if (ms + 1500 > deadline - clock.now()) { out.requiredSeconds = Math.ceil(ms / 1000 + 2); throw new Error('копке требуется больший непрерывный бюджет') }
      await tools.equipFastest(bot, b)
      if (ctl.aborted) return { ...out, interrupted: true }
      await bot.lookAt(vec(q).offset(.5, .5, .5), true)
      if (ctl.aborted || !reachable(q) || read(q)?.name !== b.name || (chosen.kind === 'own-down' && !(own(support) && safeBelow()))) throw new Error('копка прервана или геометрия изменилась до удара')
      const receipt=bot.version==='1.21.11' && bot._client ? (require('./environments/dig-receipt') as typeof import('./environments/dig-receipt')).watchDigReceipt(bot,vec(q),()=>ctl.aborted) : null
      try {
        await build.withTimeout(bot.dig(b, true), ms + 1500)
        if(receipt && await receipt.settle()!=='confirmed')throw new Error('сервер не подтвердил разрушение recovery-блока')
      } finally {receipt?.close()}
      changed = !!read(q) && read(q).name !== b.name
      if (chosen.kind === 'own-down') {
        m.own.delete(key(q))
        for (let i = 0; i < 20 && !ctl.aborted && !(bot.entity.onGround && cell(bot.entity.position).y === me.y - 1); i++) await bot.waitForTicks(1)
        changed = bot.entity.onGround && cell(bot.entity.position).y === me.y - 1
      } else if ((chosen.kind === 'wood' || chosen.kind==='stone') && changed) {
        await (require('./actions') as typeof import('./actions')).collectNearbyDrops(bot,ctl,{radius:5,timeoutMs:2500,appearMs:500,from:vec(q)})
        for (let i = 0; i < 12 && !ctl.aborted; i++) { await bot.waitForTicks(1); if (count(/_planks$/) + 4 * count(/_(log|stem|wood|hyphae)$/) > beforeWood) break }
      }
    } else if (chosen.kind === 'walk' || chosen.kind === 'trail' || chosen.kind === 'wood-walk' || chosen.kind === 'clutch-step') {
      const to = chosen.target
      if (chosen.kind === 'clutch-step') {
        if (!free(to) || !free(at(to,0,1)) || !empty(read(chosen.floor))) throw new Error('клетка ступени изменилась')
        const r = await build.placeBlockAt(bot,vec(chosen.floor),{item:chosen.item,honest:true,steady:true,timeoutMs:1500,ctl})
        if (!r.ok || !full(read(chosen.floor))) throw new Error('сервер не подтвердил пол ступени')
        recordOwnSupport(bot,chosen.floor)
        changed = true
      }
      if (stand(to)) await (require('./sealed') as typeof import('./sealed')).stepMove(bot, ctl, { kind: to.y > me.y ? 'up' : to.y < me.y ? 'down' : 'flat', to }, () => stand(to))
      changed ||= key(cell(bot.entity.position)) !== key(me) && bot.entity.onGround
    } else if (chosen.kind === 'tower') {
      if (free(at(me, 0, 2))) await build.towerUp(bot, ctl, 1, { item: chosen.item, sneak: true, fast: true })
      changed = cell(bot.entity.position).y > me.y && bot.entity.onGround
      if (changed) recordOwnSupport(bot, me)
    } else if (chosen.kind === 'craft') {
      let station = visibleTable ? read(visibleTable) : null
      const craft = async (item, n, needsTable=false) => {
        if (ctl.aborted || clock.now() >= deadline) throw new Error('крафт прерван')
        if(needsTable && !station) {
          if(!count(/^crafting_table$/)) await craft('crafting_table',1)
          for(const [x,z] of around) {
            const q=at(me,x,0,z)
            if(!free(q) || !full(read(at(q,0,-1))) || !seen(at(q,0,-1))) continue
            const r=await build.placeBlockAt(bot,vec(q),{item:'crafting_table',honest:true,timeoutMs:1500,ctl})
            if(r.ok && read(q)?.name==='crafting_table' && seen(q) && reachable(q)){station=read(q);break}
          }
          if(!station) throw new Error('не нашёл честного доступного места для переносимого верстака')
        }
        const id=session.mcData.itemsByName[item]?.id
        const recipe=id==null?null:bot.recipesFor(id,null,1,needsTable?station:null)[0]
        if(!recipe) throw new Error('нет выполнимого рецепта '+item)
        const before=count(new RegExp('^'+item+'$'))
        await (require('./craft-confirmed') as typeof import('./craft-confirmed')).craftConfirmed(bot,recipe,Math.ceil(n/recipe.result.count),needsTable?station:null,()=>ctl.aborted || clock.now()>=deadline)
        if(count(new RegExp('^'+item+'$'))<=before) throw new Error('крафт не подтверждён инвентарём: '+item)
      }
      // Minimum usable recipe: one stem is enough when the table is already carried.
      while (!ctl.aborted && count(/_planks$/) < chosen.woodNeed && clock.now() < deadline) {
        const raw = items().find(i => /_(log|stem|wood|hyphae)$/.test(i.name))
        if (!raw) break
        const prev = count(/_planks$/)
        await craft(raw.name.replace(/^stripped_/, '').replace(/_(log|stem|wood|hyphae)$/, '_planks'), 4)
        if (count(/_planks$/) <= prev) break
      }
      if (!table) await craft('crafting_table', 1)
      if (count(/^stick$/) < 2) await craft('stick', 4)
      await craft(chosen.item, 1, true)
      changed = items().some(i => i.name === chosen.item)
    } else if (chosen.kind === 'portal') {
      await (require('./nether') as typeof import('./nether')).enter(session, ctl, { mode: 'enter', noGiveupReturn:true, timeoutSeconds: timeout })
      changed = dimension(bot) !== beforeDim
    } else if (chosen.kind === 'explore') {
      const before = bot.entity.position.clone()
      await (require('./actions') as typeof import('./actions')).explore(session,ctl,{block:'crimson_stem,warped_stem',fair:true,dry:true,newView:true,radius:32,stepDistance:16,timeoutSeconds:Math.min(45,timeout)})
      const usefulGain=items().some(i=>/_(log|stem|wood|hyphae|planks|pickaxe)$|^(stick|crafting_table|cobblestone|cobbled_deepslate|blackstone)$/.test(i.name) && count(new RegExp('^'+i.name+'$'))>(usefulBefore[i.name]||0))
      changed = session.bot === bot && (bot.health??0)>0 && (bot.entity.onGround && key(cell(bot.entity.position))!==key(cell(before)) || usefulGain)
    } else {
      m.views++
      await bot.look(bot.entity.yaw + Math.PI / 2, chosen.sector % 2 ? -.45 : .45, true)
      if (!ctl.aborted) await bot.waitForTicks(1)
      out.next = 'снова считать локальную геометрию; при той же неизвестности продолжить штатный explore к новой видимой позиции'
    }
  } catch (e) { out.why = String(e?.message || e) }
  finally {
    stop()
    try { bot.pathfinder?.setGoal(null) } catch {}
    const i = ctl.onAbort.indexOf(stop); if (i >= 0) ctl.onAbort.splice(i, 1)
  }
  const failKey = signature + '|' + (chosen.kind === 'observe' ? 'observe' : chosen.key)
  if (!changed && !ctl.aborted) m.failures.set(failKey, (m.failures.get(failKey) || 0) + 1)
  if (m.failures.size > 256) m.failures.delete(m.failures.keys().next().value)
  return { ...out, ok: changed, progressed: changed, interrupted: !!ctl.aborted, at: cell(bot.entity.position), why: out.why || (changed ? 'подтверждено изменение тела, блока или инструмента' : 'эта попытка не дала подтверждённого прогресса; физическая невозможность не доказана') }
}
