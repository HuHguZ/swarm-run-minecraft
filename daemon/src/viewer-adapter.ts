const { getVersion } = require('prismarine-viewer/viewer/lib/version')
const Block = require('prismarine-block')
const Chunk = require('prismarine-chunk')
const Vec3 = require('vec3')

export function viewerMapping(version: string) {
  const target = getVersion(version)
  if (!target) throw new Error(`Viewer has no atlas for ${version}`)
  const sourceBlock = Block(version)
  const targetBlock = Block(target)
  const registry = require('minecraft-data')(target)
  const cache = new Map<number, number>()
  const stateId = (id: number): number => {
    if (version === target) return id
    if (cache.has(id)) return cache.get(id)!
    const source = sourceBlock.fromStateId(id)
    const name = source.name === 'iron_chain' ? 'chain' : source.name
    const definition = registry.blocksByName[name]
    // New blocks without an atlas retain solid geometry; supported blocks retain their names and states.
    const mapped = definition ? targetBlock.fromProperties(name, source.getProperties(), 1).stateId : registry.blocksByName.stone.defaultState
    cache.set(id, mapped)
    return mapped
  }
  const column = (original: any) => {
    if (version === target) return original
    const copy = Chunk(version).fromJson(original.toJson())
    for (let i = 0; i < copy.sections.length; i++) {
      const section = copy.sections[i]
      if (Array.isArray(section.data.palette)) {
        section.data.palette = section.data.palette.map(stateId)
        section.palette = section.data.palette
      } else if (typeof section.data.value === 'number') section.data.value = stateId(section.data.value)
      else for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
        const p = new Vec3(x, copy.minY + i * 16 + y, z)
        copy.setBlockStateId(p, stateId(original.getBlockStateId(p)))
      }
    }
    return copy
  }
  return { version: target, stateId, column }
}

export function viewerBot(bot: any) {
  const mapping = viewerMapping(bot.version)
  if (mapping.version === bot.version) return bot
  const callbacks = new Map<Function, Function>()
  const world = new Proxy(bot.world, { get: (target, key) => key === 'getColumnAt'
    ? async (position: any) => { const column = await target.getColumnAt(position); return column ? mapping.column(column) : null }
    : typeof target[key] === 'function' ? target[key].bind(target) : target[key] })
  return new Proxy(bot, { get: (target, key) => {
    if (key === 'version') return mapping.version
    if (key === 'world') return world
    if (key === 'on') return (event: string, callback: Function) => {
      const listener = event === 'blockUpdate' ? (before: any, after: any) => callback(before, { ...after, stateId: mapping.stateId(after.stateId) }) : callback
      callbacks.set(callback, listener); target.on(event, listener)
    }
    if (key === 'removeListener') return (event: string, callback: Function) => {
      target.removeListener(event, callbacks.get(callback) ?? callback); callbacks.delete(callback)
    }
    return typeof target[key] === 'function' ? target[key].bind(target) : target[key]
  } })
}
