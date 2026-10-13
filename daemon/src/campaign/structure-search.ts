export interface SearchPosition { x: number; y?: number; z: number }
export interface SearchStructure { kind: string; done?: boolean; at?: SearchPosition }
export interface SearchDiscovery { found?: string; at?: SearchPosition }
export interface StructureSearchPort {
  now(): number
  position(): SearchPosition | undefined
  scan(): Promise<void>
  list(): Promise<SearchStructure[]>
  explore(direction: string, seconds: number): Promise<SearchDiscovery | void>
  loot?(point: SearchPosition, seconds: number): Promise<boolean>
  move(point: SearchPosition, seconds: number): Promise<void>
  interrupted(): boolean
  fact(name: string, value: boolean | SearchPosition): void
  log(message: string): void
}
const directions = [
  { name: 'north', x: 0, z: -1 }, { name: 'east', x: 1, z: 0 },
  { name: 'south', x: 0, z: 1 }, { name: 'west', x: -1, z: 0 }
]
const resourceKinds = [['village', 'village'], ['shipwreck', 'shipwreck'], ['treasure', 'buried_treasure']] as const

export async function scoutStructures(port: StructureSearchPort, spentMs: number, budgetMs = 180000): Promise<{ spentMs: number; found: boolean; blocked: boolean }> {
  const started = port.now()
  const remaining = () => budgetMs - spentMs - (port.now() - started)
  let stalled = 0
  let found = false
  const attempted = new Set<string>()
  for (let segment = 0; segment < 12 && remaining() > 0 && !port.interrupted(); segment++) {
    await port.scan()
    const entries = await port.list()
    for (const [name, kind] of resourceKinds) {
      const usable = entries.find(entry => entry.kind === kind && !entry.done && entry.at)
      if (usable?.at) { port.fact(name, true); port.fact(`${name}_position`, usable.at); found = true }
      else if (entries.some(entry => entry.kind === kind && entry.done)) port.fact(`${name}_exhausted`, true)
    }
    if (found || remaining() <= 0 || port.interrupted()) break
    const direction = directions[segment % directions.length]!
    const before = port.now()
    const position = port.position()
    const origin = position && { ...position }
    const progressed = () => {
      const current = port.position()
      return origin && current
        ? current.x !== origin.x || current.z !== origin.z || origin.y !== undefined && current.y !== undefined && current.y !== origin.y
        : port.now() - before >= 1000
    }
    const discovery = await port.explore(direction.name, Math.min(30, remaining() / 1000))
    if (discovery && /^(chest|trapped_chest|barrel)$/.test(discovery.found || '') && discovery.at && port.loot && remaining() > 0 && !port.interrupted()) {
      const at = discovery.at
      const key = `${at.x},${at.y},${at.z}`
      if ([at.x, at.y, at.z].every(Number.isFinite) && !attempted.has(key)) {
        attempted.add(key)
        if (await port.loot(at, Math.min(90, remaining() / 1000))) { found = true; break }
      }
    }
    if (remaining() > 0 && !port.interrupted() && !progressed() && origin) {
      await port.move({ x: origin.x + direction.x * 60, z: origin.z + direction.z * 60 }, Math.min(30, remaining() / 1000))
    }
    if (!progressed()) stalled++
    else stalled = 0
    if (stalled >= 3) break
  }
  const total = spentMs + Math.max(0, port.now() - started)
  const blocked = !found && total < budgetMs && !port.interrupted()
  if (blocked) port.fact('structure_search_blocked', true)
  port.log(`разведка построек: ${Math.round(total / 1000)}/${Math.round(budgetMs / 1000)} с; ${found ? 'нашёл ресурсную постройку' : blocked ? 'путь поиска заблокирован' : 'бюджет поиска исчерпан'}`)
  return { spentMs: total, found, blocked }
}
