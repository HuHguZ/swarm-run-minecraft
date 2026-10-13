interface Position { x: number; y: number; z: number }

export function entryDied(state: { dimension?: string; health?: number }, receipt: { code?: string; by?: { type?: string } } | null, deaths: number): boolean {
  return state.health !== undefined && state.health <= 0 || receipt?.code === 'DIED' || receipt?.by?.type === 'death' || deaths > 0
}

interface PreparationPort {
  call(method: string, params?: Record<string, unknown>): Promise<unknown>
  creative(): Promise<void>
  returnToOverworld(position: Position): Promise<void>
  state(): Promise<{ dimension?: string; pos?: Position }>
  now(): number
  sleep(): Promise<void>
}

async function waitForStand(port: PreparationPort, target: Position, requireLit: boolean): Promise<void> {
  const deadline = port.now() + 15000
  let last: Record<string, unknown> = {}
  do {
    const state = await port.state()
    const arrived = state.dimension === 'overworld' && !!state.pos &&
      Math.hypot(state.pos.x - target.x, state.pos.z - target.z) <= 1 && Math.abs(state.pos.y - target.y) <= 1
    let floor: unknown = null
    let portalBlocks = 0
    if (arrived) {
      const observed = record(record(await port.call('observe', { radius: 4, fair: false })).detail)
      floor = record(observed.terrain).standingOn
      portalBlocks = (Array.isArray(observed.blocks) ? observed.blocks : [])
        .filter(block => record(block).name === 'nether_portal').reduce((sum, block) => sum + Number(record(block).count || 0), 0)
    }
    last = { ...state, floor, portalBlocks, target }
    const solid = typeof floor === 'string' && !/^(air|cave_air|void_air|lava|water|bubble_column|.*fire|.*portal|end_gateway|magma_block|.*campfire)$/.test(floor)
    if (arrived && solid && (!requireLit || portalBlocks > 0)) return
    if (port.now() >= deadline) break
    await port.sleep()
  } while (port.now() <= deadline)
  throw new Error(`подготовка входа: ${requireLit ? 'горящий портал и твёрдый безопасный пол' : 'твёрдый безопасный пол'} не подтверждён после возврата: ${JSON.stringify(last)}`)
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
function position(value: unknown): Position | null {
  const point = record(value)
  return ['x', 'y', 'z'].every(key => typeof point[key] === 'number' && Number.isFinite(point[key]))
    ? { x: Number(point.x), y: Number(point.y), z: Number(point.z) } : null
}
function stand(value: unknown): Position {
  const portal = record(value)
  const point = position(portal)
  const inner = position(portal.inner)
  if (!point || !inner || portal.dimension !== 'overworld' || !portal.lit || !['x', 'z'].includes(String(portal.axis))) {
    throw new Error('подготовка входа: подтверждённого портала верхнего мира с безопасным местом нет')
  }
  const x = Math.floor(point.x), y = Math.floor(point.y), z = Math.floor(point.z)
  const touchesPlane = portal.axis === 'x' ? z === inner.z && x >= inner.x && x < inner.x + 2 : x === inner.x && z >= inner.z && z < inner.z + 2
  if (touchesPlane && y < inner.y + 3 && y + 1 >= inner.y) throw new Error('подготовка входа: записанное место касается клеток портала')
  return { x: x + .5, y: point.y, z: z + .5 }
}

export async function prepareOverworldEntry(port: PreparationPort): Promise<Position> {
  await port.call('stop')
  await port.creative()
  const recalled = record(record(await port.call('recall', { lines: 1 })).detail)
  const remembered = record(record(recalled.state).places)['портал']
  const rememberedStand = stand(remembered)
  await port.returnToOverworld(rememberedStand)
  await waitForStand(port, rememberedStand, true)
  // Adopting a lit portal rechecks the native loaded stand geometry without building a second frame.
  const receipt = record(await port.call('portal', { mode: 'build', scan: 16, timeoutSeconds: 60 }))
  const adopted = record(receipt.detail)
  if (adopted.lit !== true) throw new Error('подготовка входа: горящий портал не подтверждён: ' + JSON.stringify(receipt))
  const safe = stand(adopted.place)
  await port.call('stop')
  await port.returnToOverworld(safe)
  await waitForStand(port, safe, false)
  return safe
}

export async function cleanupPreparationThreats(target: Position, command: (text: string) => Promise<string>): Promise<Record<string, string>> {
  const receipts: Record<string, string> = {}
  for (const kind of ['zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'spider', 'cave_spider', 'creeper', 'enderman', 'witch', 'phantom', 'slime']) {
    const text = `execute in minecraft:overworld positioned ${target.x} ${target.y} ${target.z} run kill @e[type=minecraft:${kind},distance=..16]`
    const receipt = await command(text)
    if (!/Killed |No entity was found/.test(receipt)) throw new Error('подготовка: локальная очистка OW угроз не подтверждена: ' + kind + ': ' + receipt)
    receipts[kind] = receipt.trim()
  }
  return receipts
}

export interface SurvivalSample {
  dimension: string
  health: number
  food: number
  serverTicks: number | null
  safe: boolean
}
interface SurvivalPort {
  sample(): Promise<SurvivalSample>
  heal(): Promise<void>
  clearEffects(): Promise<void>
  sleep(): Promise<void>
  now(): number
}

export async function confirmSurvivalReadiness(port: SurvivalPort): Promise<SurvivalSample> {
  const deadline = port.now() + 10000
  let last = await port.sample()
  const healthy = () => last.dimension === 'overworld' && last.health === 20 && last.food === 20 && last.safe
  const waitTicks = async (from: number | null, requireHealthy = false) => {
    let stable = !requireHealthy || healthy()
    do {
      if (port.now() >= deadline) throw new Error('подготовка: серверные тики/здоровье не подтверждены ' + JSON.stringify(last))
      await port.sleep()
      last = await port.sample()
      if (requireHealthy && !healthy()) stable = false
    } while (from === null || last.serverTicks === null || last.serverTicks - from < 20)
    return stable
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    await port.heal()
    last = await port.sample()
    await waitTicks(last.serverTicks)
    await port.clearEffects()
    last = await port.sample()
    if (await waitTicks(last.serverTicks, true)) return last
  }
  throw new Error('подготовка: полное здоровье в безопасном месте не подтверждено ' + JSON.stringify(last))
}
