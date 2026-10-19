export interface Hill { x: number; z: number; height: number; radius: number }
export interface LavaPit { x: number; z: number; radius: number; depth: number; lavaDepth: number }
export interface TerrainProbe { x: number; y: number; z: number; block: string }
export interface ArenaTerrain {
  version: number
  hills: Hill[]
  pits: LavaPit[]
  cliffs: { x: number; z0: number; z1: number }[]
  safeStarts: { x: number; z: number }[]
  safeCross: { halfWidth: number; spawnHalfLength: number; spawnHalfWidth: number }
  maxHeight: number
  heights: number[][]
}

export function terrainProfile(radius: number): ArenaTerrain {
  const hills: Hill[] = [
    { x: 14, z: 10, height: 9, radius: 11 }, { x: -14, z: -10, height: 9, radius: 11 },
    { x: 14, z: 5, height: 5, radius: 8 }, { x: -14, z: -5, height: 5, radius: 8 },
    { x: -9, z: 16, height: 4, radius: 7 }, { x: 9, z: -16, height: 4, radius: 7 }
  ]
  const pits: LavaPit[] = [{ x: 0, z: 17, radius: 3, depth: 6, lavaDepth: 3 }, { x: 0, z: -17, radius: 3, depth: 6, lavaDepth: 3 }]
  const cliffs = [{ x: 18, z0: 6, z1: 13 }, { x: -18, z0: -13, z1: -6 }]
  const profile: ArenaTerrain = { version: 1, hills, pits, cliffs, safeStarts: [{ x: -4, z: 0 }, { x: 4, z: 0 }],
    safeCross: { halfWidth: 2, spawnHalfLength: 6, spawnHalfWidth: 5 }, maxHeight: 9, heights: [] }
  for (let z = -radius; z <= radius; z++) {
    const row: number[] = []
    for (let x = -radius; x <= radius; x++) row.push(terrainHeightAt(profile, x, z))
    profile.heights.push(row)
  }
  return profile
}

export function pitAt(profile: ArenaTerrain, x: number, z: number): LavaPit | undefined {
  return profile.pits.find(pit => Math.hypot(x - pit.x, z - pit.z) <= pit.radius)
}

export function terrainHeightAt(profile: ArenaTerrain, x: number, z: number): number {
  if (Math.abs(z) <= profile.safeCross.halfWidth || Math.abs(x) <= profile.safeCross.spawnHalfLength && Math.abs(z) <= profile.safeCross.spawnHalfWidth) return 0
  let height = Math.max(0, ...profile.hills.map(hill => Math.floor(hill.height * Math.max(0, 1 - Math.hypot(x - hill.x, z - hill.z) / hill.radius))))
  if (profile.cliffs.some(cliff => z >= cliff.z0 && z <= cliff.z1 && (cliff.x > 0 ? x >= cliff.x : x <= cliff.x))) height = Math.min(height, 1)
  if (profile.pits.some(pit => Math.hypot(x - pit.x, z - pit.z) <= pit.radius + 1)) return 0
  return height
}

export function terrainPlan(X: number, Y: number, Z: number, radius: number) {
  const terrain = terrainProfile(radius)
  const commands: string[] = [`/fill ${X - terrain.safeCross.spawnHalfLength} ${Y - 1} ${Z - terrain.safeCross.spawnHalfWidth} ${X + terrain.safeCross.spawnHalfLength} ${Y - 1} ${Z + terrain.safeCross.spawnHalfWidth} minecraft:obsidian`]
  const samples: TerrainProbe[] = []
  const fill = (x: number, y0: number, y1: number, z: number, block: string) => {
    commands.push(`/fill ${X + x} ${y0} ${Z + z} ${X + x} ${y1} ${Z + z} minecraft:${block}`)
  }
  for (let z = -radius; z <= radius; z++) for (let x = -radius; x <= radius; x++) {
    const height = terrain.heights[z + radius][x + radius]
    const pit = pitAt(terrain, x, z)
    if (pit) {
      const bottom = Y - 1 - pit.depth
      fill(x, bottom, Y - 1, z, 'air')
      fill(x, bottom, bottom, z, 'obsidian')
      fill(x, bottom + 1, bottom + pit.lavaDepth, z, 'lava')
    } else if (terrain.pits.some(pit => Math.hypot(x - pit.x, z - pit.z) <= pit.radius + 1)) {
      fill(x, Y - 7, Y - 1, z, 'polished_basalt')
    } else if (height > 0) {
      fill(x, Y, Y + height - 1, z, 'stone')
      fill(x, Y + height - 1, Y + height - 1, z, height >= 6 ? 'moss_block' : 'grass_block')
    }
  }
  const probe = (x: number, y: number, z: number, block: string) => samples.push({ x: X + x, y, z: Z + z, block })
  for (const hill of [terrain.hills[0], terrain.hills[1], terrain.hills[4], terrain.hills[5]]) {
    const h = terrainHeightAt(terrain, hill.x, hill.z)
    probe(hill.x, Y + h - 1, hill.z, h >= 6 ? 'moss_block' : 'grass_block')
    probe(hill.x, Y + h, hill.z, 'air')
  }
  for (const pit of terrain.pits) {
    probe(pit.x, Y - 1 - pit.depth, pit.z, 'obsidian')
    probe(pit.x, Y - 1 - pit.depth + pit.lavaDepth, pit.z, 'lava')
    probe(pit.x, Y - 1, pit.z, 'air')
    probe(pit.x + pit.radius + 1, Y - 1, pit.z, 'polished_basalt')
  }
  for (const spawn of terrain.safeStarts) {
    probe(spawn.x, Y - 1, spawn.z, 'obsidian')
    probe(spawn.x, Y, spawn.z, 'air')
  }
  probe(17, Y + terrainHeightAt(terrain, 17, 10) - 1, 10, 'moss_block')
  probe(18, Y + 1, 10, 'air')
  return { terrain, commands, samples }
}
