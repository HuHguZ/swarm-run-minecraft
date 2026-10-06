export interface ResumeBody { dimension: string; health: number }

export function requireInheritedResumeBody(state: ResumeBody, recalledPortal: unknown): void {
  if (!(state.health > 0) || !['overworld', 'the_nether'].includes(state.dimension)) {
    throw new Error('resume requires a living inherited Overworld or Nether body')
  }
  if (state.dimension === 'the_nether') return
  const portal = recalledPortal && typeof recalledPortal === 'object' ? recalledPortal as Record<string, unknown> : null
  if (!portal || (portal.dimension ?? 'overworld') !== 'overworld' ||
      ![portal.x, portal.y, portal.z].every(value => typeof value === 'number' && Number.isFinite(value))) {
    throw new Error('Overworld resume requires an actual known Overworld portal in recall')
  }
}
