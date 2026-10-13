import type { Doctrine, SwarmRole } from '../daemon/src/swarm'
const { swarmBlueprint } = require('../daemon/src/swarm-work')

type Point = { x: number; y: number; z: number }
export interface DoctrineActor {
  key: string; team: 'blue' | 'red'; role: SwarmRole; p: Point; hp: number; food: number
  inv: Record<string, number>; armor: Record<string, string>; held?: string
  potions?: Record<string, number>; potion?: string; ench?: { sharpness?: number; protection?: number }
  effects?: Array<{ name: string; seconds: number; amplifier: number }>
  attributes?: Record<string, number>
}
export interface DoctrineScene {
  id: Doctrine; seconds: number; executionMode: 'forced-existing-option'; naturalPreferred: true
  arena: Point & { r: number; killY: number }; center: Point; forward: Point
  actors: DoctrineActor[]; fills: Array<{ a: Point; b: Point; block: string }>
  scripts: Array<{ afterMs: number; actor: string; method: string; params: any }>
  required: string[]; blueprint?: { kind: string; origin: Point; direction: string; cells: Point[]; slits: Point[]; floor: Point[] }
  /** Естественная регенерация в сцене (по умолчанию выключена: лечение меряется только зельями). */
  naturalRegeneration?: boolean
}
export interface DoctrineFrame {
  at: number; gameTick: number
  actors: Record<string, { p: Point; velocity?: Point; onGround?: boolean; yaw?: number; pitch?: number; hp: number; food?: number; inventory?: Record<string, number>; activeItem?: string | boolean; offHand?: { item?: string; durability?: number } | null; shield?: boolean }>
}
export interface DoctrineEvidence {
  actorIds: Record<string, number>
  frames: DoctrineFrame[]
  packets: Array<{ at: number; actor: string; direction?: 'outgoing' | 'incoming'; packetName: string; packet: any; held?: string }>
  plans?: Array<{ at: number; snapshot: Record<string, { tasks: any[] }>; natural?: string }>
  cells?: Array<{ at: number; actor: string; p: Point; block: string; confirmed: boolean; source: 'block_change' | 'multi_block_change' | 'rcon' }>
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const cellKey = (p: Point) => `${p.x},${p.y},${p.z}`
const armor = () => ({ head: 'iron_helmet', torso: 'iron_chestplate', legs: 'iron_leggings', feet: 'iron_boots' })

/** Fixtures are lab-only. The runner must verify their real own status before starting the capture. */
export function doctrineScenes(origin: Point = { x: 3000.5, y: 220, z: 3000.5 }): DoctrineScene[] {
  const p = (x: number, y = 0, z = 0) => ({ x: origin.x + x, y: origin.y + y, z: origin.z + z })
  const cell = (x: number, y = 0, z = 0) => ({ x: Math.floor(origin.x) + x, y: origin.y + y, z: Math.floor(origin.z) + z })
  const actor = (team: 'blue' | 'red', index: number, at: Point, extra: Partial<DoctrineActor> = {}): DoctrineActor => ({
    key: team + index, team, role: index % 3 === 2 ? 'flank' : 'fighter', p: at, hp: 20, food: 20,
    inv: { iron_sword: 1, bread: 8 }, armor: armor(), held: 'iron_sword', ...extra
  })
  const blue = (n: number) => Array.from({ length: n }, (_, i) => actor('blue', i, p(-2, 0, (i - (n - 1) / 2) * 1.5)))
  const foe = (index = 0, at = p(11, 0, 0), extra: Partial<DoctrineActor> = {}) => actor('red', index, at, { inv: { wooden_sword: 1, bread: 8 }, armor: {}, held: 'wooden_sword', ...extra })
  const healer = (at = p(0, 0, 0)) => actor('blue', 1, at, { role: 'healer', inv: { iron_sword: 1, splash_potion: 8, bread: 8 }, potions: { splash_strong_healing: 8 }, potion: 'strong_healing' })
  const builder = (i: number, at: Point) => actor('blue', i, at, { role: 'miner-builder', inv: { iron_sword: 1, iron_pickaxe: 1, cobblestone: 128, bread: 8 } })
  // Стеклянный борт по краю площадки (r − 1): живая цель-бот, удирая, падала с края и разбивалась (лаборатория 13.10,
  // линия: цель погибла на 28 с, свой в погоне встал на самой кромке) — сцена мерила падение, а не приём.
  const floor = [
    { a: cell(-30, 0, -30), b: cell(30, 7, 30), block: 'air' },
    { a: cell(-30, -1, -30), b: cell(30, -1, 30), block: 'stone' },
    ...[[-29, -29, -29, 29], [29, -29, 29, 29], [-29, -29, 29, -29], [-29, 29, 29, 29]].map(([x1, z1, x2, z2]) => ({ a: cell(x1, 0, z1), b: cell(x2, 2, z2), block: 'glass' }))
  ]
  const make = (id: Doctrine, actors: DoctrineActor[], required: string[], seconds = 18): DoctrineScene => ({
    id, seconds, executionMode: 'forced-existing-option', naturalPreferred: true,
    arena: { ...origin, r: 30, killY: origin.y - 5 }, center: { ...origin }, forward: { x: 1, y: 0, z: 0 },
    actors, fills: floor.map(f => structuredClone(f)), scripts: [], required
  })
  const ringOwn = blue(8)
  ringOwn[0] = actor('blue', 0, p(.2, 0, 0), { hp: 12, inv: { iron_sword: 1, shield: 1, bread: 8 } })
  ringOwn[0].armor = { head: 'netherite_helmet', torso: 'netherite_chestplate', legs: 'netherite_leggings', feet: 'netherite_boots' }
  ringOwn[0].ench = { protection: 4 }
  ringOwn[1] = healer()
  for (let i = 2; i < 8; i++) {
    const angle = (i - 2) * Math.PI / 3
    ringOwn[i].p = p(Math.cos(angle) * 3, 0, Math.sin(angle) * 3)
    ringOwn[i].inv.shield = 1
  }
  const ring = make('ring', [...ringOwn, ...[p(11), p(-11), p(0, 0, 11), p(0, 0, -11)].map((at, i) => foe(i, at, { inv: { bow: 1, arrow: 64 }, held: 'bow' }))], ['three outward native shield users at one frame', 'wounded blue0 inside the shield ring', 'native healing use and blue0 health gain'])
  ring.scripts = Array.from({ length: 4 }, (_, i) => ({ afterMs: 500, actor: 'red' + i, method: 'fight', params: { target: 'blue' + (i + 2), allowPlayer: true, allowRanged: true, timeoutSeconds: 8 } }))

  const line = make('line', [...blue(3), foe(0, p(11), { armor: { head: 'netherite_helmet', torso: 'netherite_chestplate', legs: 'netherite_leggings', feet: 'netherite_boots' }, inv: { wooden_sword: 1, golden_apple: 16 }, food: 12 })], ['different native contact actors at least 22500 wall ms apart', 'two front-line actors physically advance then rotate'], 48)
  for (const b of line.actors) if (b.team === 'blue') b.armor = { head: 'netherite_helmet', torso: 'netherite_chestplate', legs: 'netherite_leggings', feet: 'netherite_boots' }
  // Смысл смены линий — отдых уставших: без естественной регенерации ушедший в тыл ранг не восстанавливался, и бессмертный
  // противник (регенерация IV, яблоки) за 48 с добивал кого-то (лаборатория 13.10) — это мерило сцену, а не смену.
  line.naturalRegeneration = true
  line.actors.find(a => a.key === 'red0')!.effects = [{ name: 'regeneration', seconds: 200, amplifier: 3 }]
  line.scripts = [18000, 35000].map(afterMs => ({ afterMs, actor: 'red0', method: 'eat', params: { timeoutSeconds: 4 } }))
  const hornsOwn = blue(8)
  hornsOwn[2].p = p(-2, 0, -8); hornsOwn[5].p = p(-2, 0, 8)
  hornsOwn[7] = actor('blue', 7, p(-5), { role: 'ranged', inv: { bow: 1, arrow: 64, bread: 8 }, held: 'bow' })
  const buffalo = make('buffalo', [...hornsOwn, ...[-6, -2, 2, 6].map((z, i) => foe(i, p(12, 0, z), { armor: armor(), inv: { iron_sword: 1, bread: 8 }, held: 'iron_sword' }))], ['both flanks physically progress on opposite sides', 'front native accepted contact', 'reserve remains behind the front at contact'])
  const fountain = make('fountain', [...blue(8), foe(0, p(16))], ['physical lateral opening before predator crosses the center', 'actual charge across the center', 'close behind the intruder into three angular sectors', 'native accepted contact after the crossing'])
  for (const a of fountain.actors.filter(a => a.team === 'blue')) {
    a.armor = { head: 'netherite_helmet', torso: 'netherite_chestplate', legs: 'netherite_leggings', feet: 'netherite_boots' }
    a.ench = { protection: 4, sharpness: 5 }
  }
  const caster = fountain.actors.find(a => a.key === 'red0')!
  caster.armor = { head: 'netherite_helmet', torso: 'netherite_chestplate', legs: 'netherite_leggings', feet: 'netherite_boots' }
  caster.ench = { protection: 4 }; caster.effects = [{ name: 'regeneration', seconds: 200, amplifier: 3 }]
  fountain.scripts = [0, 650, 1300, 1950].map(afterMs => ({ afterMs, actor: 'red0', method: 'evade', params: { dir: { x: -1, z: 0 }, ticks: 20, jump: false, arena: fountain.arena } }))
  const weakOwn = blue(6)
  weakOwn[0] = actor('blue', 0, p(0), { hp: 8 }); weakOwn[1] = healer(p(.5))
  const weak = make('weak-center', [...weakOwn, foe(0, p(10))], ['wounded blue0 remains inside the guards', 'native healing and health gain', 'a distinct guard accepts native contact'])

  const builders = blue(6)
  builders[0] = builder(0, p(4, 0, -3)); builders[3] = builder(3, p(4, 0, 3))
  const cocoon = make('cocoon', [...builders.map(b => structuredClone(b)), foe(0, p(8))], ['all 23 cocoon cells server confirmed', 'nine ceiling cells present', 'both protected viewing slits remain air', 'at least two builders contributed', 'actual living foe remains trapped inside on its protected floor'], 70)
  // Lab fixture: durable stationary target, rather than a different victim after respawn.
  for (const a of cocoon.actors) {
    a.armor = { head: 'netherite_helmet', torso: 'netherite_chestplate', legs: 'netherite_leggings', feet: 'netherite_boots' }
    a.ench = { protection: 4, ...(a.team === 'blue' ? { sharpness: 5 } : {}) }
  }
  const caged = cocoon.actors.find(a => a.key === 'red0')!
  caged.effects = [{ name: 'regeneration', seconds: 200, amplifier: 4 }]
  caged.attributes = { knockback_resistance: 1 }
  const cplan = swarmBlueprint('cocoon', cell(8), 'east')
  cocoon.blueprint = { kind: 'cocoon', origin: cell(8), direction: 'east', cells: cplan.cells.map(c => c.at), slits: cplan.protected.filter(c => c.y === origin.y + 1 && Math.abs(c.x - (Math.floor(origin.x) + 8)) === 1 && c.z === Math.floor(origin.z)), floor: cplan.protected.filter(c => c.y === origin.y - 1) }
  const waveOwn = blue(6)
  for (const b of waveOwn) {
    b.inv = { netherite_sword: 1, wind_charge: 8, bread: 8 }; b.held = 'netherite_sword'
    b.armor = { head: 'netherite_helmet', torso: 'netherite_chestplate', legs: 'netherite_leggings', feet: 'netherite_boots' }
    b.ench = { sharpness: 5, protection: 4 }
  }
  const wave = make('wave', [...waveOwn, foe(0, p(9.1, 4, 0))], ['native wind charge use', 'native velocity change of red0', 'red0 physically leaves the elevated support and lands lower'])
  wave.fills.push({ a: cell(9, 0, 0), b: cell(9, 3, 0), block: 'stone' })
  const hunt = make('hunt', [...builders.map(b => structuredClone(b)), foe(0, p(8))], ['full ten-cell cutoff wall server confirmed', 'foe actually driven toward the cutoff', 'native contact at the cutoff'], 50)
  const hplan = swarmBlueprint('cutoff', cell(11), 'east')
  hunt.blueprint = { kind: 'cutoff', origin: cell(11), direction: 'east', cells: hplan.cells.map(c => c.at), slits: [], floor: [] }
  hunt.scripts = [{ afterMs: 700, actor: 'red0', method: 'flee', params: { from: ['blue2', 'blue5'], toward: [p(24)], safeDist: 20, timeoutSeconds: 12 } }]
  hunt.fills.push({ a: cell(0, 0, -4), b: cell(26, 2, -4), block: 'stone' }, { a: cell(0, 0, 4), b: cell(26, 2, 4), block: 'stone' })
  const feintOwn = blue(6)
  feintOwn[0] = actor('blue', 0, p(0), { hp: 14, food: 12, inv: { iron_sword: 1, golden_apple: 8 } }); feintOwn[1] = healer()
  feintOwn[0].armor = { head: 'netherite_helmet', torso: 'netherite_chestplate', legs: 'netherite_leggings', feet: 'netherite_boots' }
  feintOwn[0].ench = { protection: 4 }
  feintOwn[2].p = p(-1, 0, -5); feintOwn[5].p = p(-1, 0, 5)
  const feint = make('false-weakness', [...feintOwn, ...[-4, 4].map((z, i) => foe(i, p(11, 0, z), { armor: armor(), inv: { iron_sword: 1, bread: 8 }, held: 'iron_sword' }))], ['bait physically retreats', 'native food use with real food gain', 'both opposite flanks approach and accept contact'], 28)
  feint.scripts = [{ afterMs: 2200, actor: 'red0', method: 'goto', params: { ...p(-3), range: 1, timeoutSeconds: 5 } }]
  const retreat = make('false-retreat', [...blue(6), foe(0, p(13))], ['real backward retreat of three actors', 'counter-contact after the real eight-second rally window', 'closing foe was observed'], 22)
  retreat.scripts = [{ afterMs: 0, actor: 'red0', method: 'goto', params: { ...p(-1), range: 1, timeoutSeconds: 9 } }]
  return [ring, line, buffalo, fountain, weak, cocoon, wave, hunt, feint, retreat]
}

/** Raw packets and physical receipts are mandatory; task labels and RPC requests never prove execution. */
export function evaluateDoctrine(scene: DoctrineScene, evidence: DoctrineEvidence) {
  const frames = evidence.frames.slice().sort((a, b) => a.at - b.at), packets = evidence.packets || []
  const blues = scene.actors.filter(a => a.team === 'blue').map(a => a.key), reds = scene.actors.filter(a => a.team === 'red').map(a => a.key)
  const checks: Array<{ id: string; passed: boolean; detail: string }> = []
  const check = (id: string, passed: boolean, detail: string) => checks.push({ id, passed: !!passed, detail })
  const start = frames[0]?.at ?? Infinity, end = frames.at(-1)?.at ?? -Infinity
  const latest = (key: string, at: number) => frames.filter(f => f.at <= at && f.actors[key]).at(-1)?.actors[key]
  const proj = (p: Point) => ({ forward: (p.x - scene.center.x) * scene.forward.x + (p.z - scene.center.z) * scene.forward.z, side: -(p.x - scene.center.x) * scene.forward.z + (p.z - scene.center.z) * scene.forward.x })
  const active = packets.filter(p => p.direction !== 'incoming' && /^(use_item|block_place)$/.test(p.packetName))
  const held = p => p.held || latest(p.actor, p.at)?.activeItem
  const contacts = packets.filter(p => {
    if (p.direction === 'incoming' || p.packetName !== 'use_entity' || ![p.packet?.mouse, p.packet?.action].includes(1) || !blues.includes(p.actor)) return false
    const target = reds.find(key => evidence.actorIds[key] === p.packet.target)
    if (!target) return false
    const before = latest(target, p.at - 1)?.hp
    return Number.isFinite(before) && frames.some(f => f.at >= p.at && f.at <= p.at + 2000 && f.actors[target]?.hp < before) &&
      packets.some(d => d.actor === target && d.packet?.entityId === evidence.actorIds[target] && d.direction !== 'outgoing' && /^(entity_damage|damage_event)$/.test(d.packetName) && d.at >= p.at && d.at <= p.at + 1500 &&
        damageSourceIds(d.packet).includes(evidence.actorIds[p.actor]))
  })
  const moved = (key: string, threshold = 1.5, until = Infinity) => {
    const first = frames.find(f => f.actors[key])?.actors[key]
    return !!first && frames.some(f => f.at <= until && f.actors[key] && distance(first.p, f.actors[key].p) >= threshold)
  }
  const heal = () => active.some(p => blues.includes(p.actor) && held(p) === 'splash_potion' && frames.some(f => f.at >= p.at && f.at <= p.at + 3500 && f.actors.blue0?.hp >= (latest('blue0', p.at - 1)?.hp ?? 20) + 3))
  const flankGeometry = () => ['blue2', 'blue5'].every(key => moved(key) && frames.some(f => {
    const a = f.actors[key]; return a && proj(a.p).forward >= 2 && (key === 'blue2' ? proj(a.p).side <= -2 : proj(a.p).side >= 2)
  }))
  const cells = evidence.cells || [], confirmed = cells.filter(c => c.confirmed && ['block_change', 'multi_block_change', 'rcon'].includes(c.source))
  check('capture', frames.length >= 3 && scene.actors.every(a => Number.isInteger(evidence.actorIds?.[a.key]) && frames.some(f => f.actors[a.key] && [f.actors[a.key].p?.x, f.actors[a.key].p?.y, f.actors[a.key].p?.z, f.actors[a.key].hp].every(Number.isFinite))), `${frames.length} native frames, ${Object.keys(evidence.actorIds || {}).length} actor ids`)
  check('blue-bounds', frames.length > 0 && frames.every(f => blues.every(k => { const a = f.actors[k]; return !a || a.p.y > scene.arena.killY && Math.abs(a.p.x - scene.arena.x) + .3 < scene.arena.r && Math.abs(a.p.z - scene.arena.z) + .3 < scene.arena.r })), 'actual body footprint inside the square arena')
  if (scene.id === 'ring') {
    // Щит поднят по живому флагу сервера (метаданные «использует левой рукой» и щит в ней) и поднят своим use_item раньше в
    // сцене. Окно «use_item не старше 2.5 с» требовало заново поднимать щит, который и так держат (разбор 13.10).
    const ring = frames.find(f => {
      const guards = blues.filter(k => f.actors[k]?.shield && active.some(p => p.actor === k && p.at <= f.at && (p.packet?.hand === 1 || held(p) === 'shield')))
        .filter(k => { const a = f.actors[k], delta = proj(a.p), radius = Math.hypot(delta.forward, delta.side); return radius >= 2 && Number.isFinite(a.yaw) && (-Math.sin(a.yaw) * (a.p.x - scene.center.x) - Math.cos(a.yaw) * (a.p.z - scene.center.z)) / radius >= .5 })
      const wounded = f.actors.blue0
      return guards.length >= 3 && wounded && distance(wounded.p, scene.center) < Math.min(...guards.map(k => distance(f.actors[k].p, scene.center)))
    })
    check('outward-ring', !!ring, 'three shields actually raised outward with the wounded body inside')
    check('native-heal', heal(), 'healer use packet followed by actual recipient health gain')
  } else if (scene.id === 'line') {
    const rotations = contacts.some(a => contacts.some(b => b.actor !== a.actor && b.at - a.at >= 22500))
    check('timed-contact-rotation', rotations, `${new Set(contacts.map(c => c.actor)).size} native contact actors over ${Math.round(end - start)}ms`)
    // Фронт — кто ближе к противнику, а не дальше по неподвижной оси сцены: противник ходит по полю (разбор 13.10: при
    // мере по расстоянию до него 31 из 33 пар проходили, по оси +x — ни одна).
    const physicalRotation = contacts.some(a => contacts.some(b => {
      if (a.actor === b.actor || b.at - a.at < 22500) return false
      const oldFront = latest(a.actor, a.at), newRear = latest(b.actor, a.at), oldRear = latest(a.actor, b.at), newFront = latest(b.actor, b.at)
      const foe1 = latest('red0', a.at)?.p, foe2 = latest('red0', b.at)?.p
      if (!oldFront || !newRear || !oldRear || !newFront || !foe1 || !foe2) return false
      return distance(oldRear.p, foe2) - distance(oldFront.p, foe1) >= 2 && distance(newRear.p, foe1) - distance(newFront.p, foe2) >= 2 &&
        distance(oldRear.p, foe2) - distance(newFront.p, foe2) >= 2
    }))
    check('physical-front-rotation', physicalRotation, 'former contacting front physically retreats and its replacement advances to accepted contact across the rotation window')
  } else if (scene.id === 'buffalo') {
    check('both-horns', flankGeometry(), 'both opposite flanks advance in actual frames')
    check('front-contact', contacts.some(c => ['blue0', 'blue3', 'blue4', 'blue6'].includes(c.actor)), 'front accepted server contact')
    check('rear-reserve', contacts.some(c => { const r = latest('blue7', c.at), front = latest(c.actor, c.at); return r && front && proj(r.p).forward + 3 < proj(front.p).forward }), 'rear actor remains behind the contacting front')
  } else if (scene.id === 'fountain') {
    const initial = frames.find(f => f.actors.red0)?.actors.red0
    const crossing = frames.find(f => f.actors.red0?.hp > 0 && proj(f.actors.red0.p).forward <= -1 && initial && distance(f.actors.red0.p, initial.p) >= 8)
    const opened = crossing && frames.find(f => {
      if (f.at > crossing.at) return false
      return [-1, 1].every(sign => blues.some(k => {
        const a = f.actors[k], before = frames[0]?.actors[k]
        return a && before && sign * proj(a.p).side >= 4 && sign * (proj(a.p).side - proj(before.p).side) >= 1.5
      }))
    })
    const heading = crossing && initial && { x: crossing.actors.red0.p.x - initial.p.x, z: crossing.actors.red0.p.z - initial.p.z }
    const length = heading ? Math.hypot(heading.x, heading.z) : 0
    const closing = crossing && heading && length > 0 && frames.find(f => {
      if (f.at < crossing.at || f.at > crossing.at + 6000 || f.actors.red0?.hp <= 0) return false
      const foe = f.actors.red0?.p
      if (!foe) return false
      const surround = blues.filter(k => f.actors[k]?.hp > 0 && moved(k, 1.5, f.at) && distance(f.actors[k].p, foe) <= 7)
      const sectors = new Set(surround.map(k => Math.floor(((Math.atan2(f.actors[k].p.z - foe.z, f.actors[k].p.x - foe.x) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2 / 3))))
      const behind = surround.some(k => ((f.actors[k].p.x - foe.x) * heading.x + (f.actors[k].p.z - foe.z) * heading.z) / length <= -1.5)
      return sectors.size === 3 && behind
    })
    check('lateral-opening', !!opened, 'both sides physically open the central lane before the observed crossing')
    check('predator-crossed', !!crossing, 'living intruder actually traversed the original center')
    check('closed-behind', !!closing, 'three angular sectors around the actual intruder, including a body behind its measured charge direction')
    check('contact-after-cross', !!crossing && contacts.some(p => p.at >= crossing.at), 'accepted native contact after the predator crossed, rather than a blast-alarm label')
  } else if (scene.id === 'weak-center') {
    check('weak-inside', frames.some(f => f.actors.blue0 && distance(f.actors.blue0.p, scene.center) <= 2.5 && blues.filter(k => k !== 'blue0' && k !== 'blue1' && f.actors[k] && distance(f.actors[k].p, scene.center) > distance(f.actors.blue0.p, scene.center)).length >= 3), 'wounded actor inside three guards')
    check('native-heal', heal(), 'actual healing packet and own recipient health gain')
    check('cover-contact', contacts.some(c => c.actor !== 'blue0' && c.actor !== 'blue1'), 'a separate guard accepts native contact')
  } else if (scene.id === 'cocoon' || scene.id === 'hunt') {
    let plan = scene.blueprint!
    if (scene.id === 'hunt') {
      // A fleeing foe changes the observed cutoff origin. Accept a complete
      // production-shaped wall at its actual cells, rather than a fixture coordinate.
      // The swarm re-sites the wall ahead of a foe that outran it, so every complete wall is a candidate; the drive and
      // the contact must still happen at one and the same wall (lab 14.10: contact at the second wall was not counted).
      const walls: any[] = []
      for (const c of confirmed.filter(c => c.block === 'cobblestone')) {
        const candidate = swarmBlueprint('cutoff', c.p, 'east')
        if (candidate.cells.every(p => confirmed.some(c => c.block === 'cobblestone' && cellKey(c.p) === cellKey(p.at))) && !walls.some(w => cellKey(w.origin) === cellKey(c.p))) {
          walls.push({ kind: 'cutoff', origin: c.p, direction: 'east', cells: candidate.cells.map(p => p.at), slits: [], floor: [] })
        }
      }
      const firstFoe = frames.find(f => f.actors.red0)?.actors.red0
      const driven = w => !!firstFoe && frames.some(f => f.actors.red0?.hp > 0 && distance(f.actors.red0.p, firstFoe.p) >= 2 && distance(f.actors.red0.p, w.origin) <= 3)
      const touched = w => contacts.some(c => { const a = latest(c.actor, c.at); return a && distance(a.p, w.origin) <= 5 })
      plan = walls.find(w => driven(w) && touched(w)) || walls[0] || plan
    }
    const built = plan.cells.filter(p => confirmed.some(c => cellKey(c.p) === cellKey(p) && c.block === 'cobblestone'))
    check('complete-blueprint', built.length === plan.cells.length, `${built.length}/${plan.cells.length} server-confirmed cells`)
    check('multiple-builders', new Set(confirmed.filter(c => plan.cells.some(p => cellKey(c.p) === cellKey(p)) && c.block === 'cobblestone').map(c => c.actor).filter(k => blues.includes(k))).size >= 2, 'two own builders contributed confirmed cells')
    if (scene.id === 'cocoon') {
      check('roof', plan.cells.filter(p => p.y === plan.origin.y + 2).every(p => built.some(b => cellKey(p) === cellKey(b))), 'all nine ceiling cells present')
      check('viewing-slits', plan.slits.length === 2 && plan.slits.every(p => confirmed.some(c => cellKey(c.p) === cellKey(p) && /^(air|cave_air|void_air)$/.test(c.block))), 'both protected viewing slits verified as air')
      check('protected-floor', plan.floor.length === 9 && plan.floor.every(p => confirmed.some(c => cellKey(c.p) === cellKey(p) && c.block === 'stone')), 'all nine original support cells remain intact')
      // The last second, not the last frame: hits through the slits knock the foe up, and one airborne final frame
      // failed a sealed, intact cocoon (lab 14.10, run12: 99 hits through the slits, foe inside at 20 hp all along).
      const onSupport = (trapped: any) => !!trapped && trapped.hp > 0 && trapped.onGround === true && Math.abs(trapped.p.x - plan.origin.x - .5) + .3 <= .5 && Math.abs(trapped.p.z - plan.origin.z - .5) + .3 <= .5 && Math.abs(trapped.p.y - plan.origin.y) < .1
      const last = frames.at(-1), inside = last?.actors.red0
      check('trapped-alive', !!inside && inside.hp > 0 && Math.abs(inside.p.x - plan.origin.x - .5) + .3 <= .5 && Math.abs(inside.p.z - plan.origin.z - .5) + .3 <= .5 && inside.p.y >= plan.origin.y - .1 && inside.p.y < plan.origin.y + 1 &&
        frames.some(f => f.at >= last!.at - 1000 && onSupport(f.actors.red0)), 'actual living foe is still on the intact central support inside the complete enclosure')
    } else {
      const firstFoe = frames.find(f => f.actors.red0)?.actors.red0
      check('driven-to-cutoff', !!firstFoe && frames.some(f => f.actors.red0?.hp > 0 && distance(f.actors.red0.p, firstFoe.p) >= 2 && distance(f.actors.red0.p, plan.origin) <= 3), 'the same actual foe frame shows displacement and arrival at the cutoff')
      check('cutoff-contact', contacts.some(c => { const a = latest(c.actor, c.at); return a && distance(a.p, plan.origin) <= 5 }), 'accepted contact near the physical cutoff wall')
    }
  } else if (scene.id === 'wave') {
    const shot = active.find(p => blues.includes(p.actor) && held(p) === 'wind_charge')
    check('native-wind', !!shot, 'native wind-charge item use')
    check('foe-knockback', !!shot && packets.some(p => {
      const v = p.packet?.velocity || { x: p.packet?.velocityX, y: p.packet?.velocityY, z: p.packet?.velocityZ }
      const melee = packets.some(a => a.direction !== 'incoming' && a.packetName === 'use_entity' && [a.packet?.mouse, a.packet?.action].includes(1) && a.packet?.target === evidence.actorIds.red0 && a.at >= shot.at && a.at <= p.at)
      return p.actor === 'red0' && p.direction !== 'outgoing' && p.packetName === 'entity_velocity' && p.packet?.entityId === evidence.actorIds.red0 && p.at >= shot.at && p.at <= shot.at + 2000 && [v.x, v.z].some(n => Number.isFinite(n) && Math.abs(n) > 0) && !melee
    }), 'nonzero horizontal server knockback after wind with no intervening melee to the same victim')
    const landing = shot && frames.find(f => {
      const a = f.actors.red0, initial = scene.actors.find(a => a.key === 'red0')!.p
      return f.at >= shot.at && f.at <= shot.at + 6000 && a?.hp > 0 && a.onGround === true && a.p.y > scene.arena.killY && a.p.y < initial.y - 1 && Math.hypot(a.p.x - initial.x, a.p.z - initial.z) > .9 && Math.abs(a.p.x - scene.arena.x) + .3 < scene.arena.r && Math.abs(a.p.z - scene.arena.z) + .3 < scene.arena.r
    })
    const died = shot && landing && (frames.some(f => f.at >= shot.at && f.at <= landing.at && f.actors.red0?.hp <= 0) || packets.some(p => p.actor === 'red0' && p.at >= shot.at && p.at <= landing.at && (p.packetName === 'respawn' || p.packetName === 'update_health' && p.packet?.health <= 0)))
    check('off-edge', !!landing && !died, 'bounded live landing below the ledge; death or respawn cannot satisfy the receipt')
  } else if (scene.id === 'false-weakness') {
    check('bait-retreated', frames.some(f => f.actors.blue0 && proj(f.actors.blue0.p).forward <= -4) && moved('blue0'), 'weaker bait physically withdrew')
    const ate = active.some(p => {
      if (p.actor !== 'blue0' || p.packetName !== 'use_item') return false
      const hand = p.packet?.hand
      const item = a => hand === 1 ? a?.offHand?.item : hand === 0 ? (p.held || (typeof a?.activeItem === 'string' ? a.activeItem : null)) : null
      // A just-filled offhand can appear on the first poll after use. Keep
      // the witness local in time; never substitute the generic main hand.
      const witness = frames.filter(f => Math.abs(f.at - p.at) <= 350 && typeof item(f.actors.blue0) === 'string')
        .sort((a, b) => Math.abs(a.at - p.at) - Math.abs(b.at - p.at))[0]
      const before = witness?.actors.blue0, food = item(before)
      const count = food && before?.inventory?.[food]
      if (!/^(bread|golden_apple|enchanted_golden_apple|cooked_.*)$/.test(String(food)) || !Number.isFinite(count) || count <= 0 || !Number.isFinite(before?.food)) return false
      return frames.some(f => {
        const after = f.actors.blue0
        return f.at > Math.max(p.at, witness.at) && f.at <= p.at + 5000 && after?.inventory && (after.inventory[food] ?? 0) < count && (after.food ?? 0) > before.food
      })
    })
    check('real-bait-use', ate, 'native use of the observed correct hand, inventory consumption, and actual hunger replenishment')
    check('flank-ambush', flankGeometry() && ['blue2', 'blue5'].every(k => contacts.some(c => c.actor === k)), 'both opposite flanks physically approached and accepted contact')
  } else {
    const feignedAt = evidence.plans?.find(p => Object.values(p.snapshot).some(s => s.tasks.some(t => t.data?.feigned && t.data?.doctrine === 'false-retreat')))?.at
    check('physical-retreat', blues.filter(k => moved(k, 4) && frames.some(f => f.actors[k] && proj(f.actors[k].p).forward <= -5)).length >= 3, 'three actors actually withdrew behind the original center')
    // The rally window is 8 s of game time (the driver runs on the game clock): compare server ticks, not wall time,
    // or a 40 TPS lab demands 16 game seconds (lab 14.10: a counter-hit at 15.6 game s was rejected).
    const tickAt = (at: number) => frames.filter(f => f.at <= at && Number.isFinite(f.gameTick)).at(-1)?.gameTick ?? frames.find(f => Number.isFinite(f.gameTick))?.gameTick
    const after = (at: number) => { const a = tickAt(at), b = tickAt(feignedAt!); return Number.isFinite(a) && Number.isFinite(b) ? a! - b! >= 160 : at >= feignedAt! + 8000 }
    check('eight-second-counter', Number.isFinite(feignedAt) && contacts.some(c => after(c.at)), 'accepted counter-contact after the production rally window')
    check('closing-foe', frames.some(f => (f.actors.red0?.velocity?.x || 0) * scene.forward.x + (f.actors.red0?.velocity?.z || 0) * scene.forward.z < -.1), 'actual foe velocity closing toward the team')
  }
  const natural = [...new Set((evidence.plans || []).map(p => p.natural).filter(Boolean))]
  return { passed: checks.every(c => c.passed), executionMode: scene.executionMode, checks,
    selector: { observed: natural, matches: natural.includes(scene.id), status: natural.length ? 'observed' : 'not-captured' } }
}

export function validateSceneDefinitions(scenes = doctrineScenes()) {
  if (scenes.length !== 10 || new Set(scenes.map(s => s.id)).size !== 10) throw new Error('ten distinct doctrine scenes required')
  for (const s of scenes) {
    if (s.actors.length > 12 || new Set(s.actors.map(a => a.key)).size !== s.actors.length) throw new Error(`${s.id}: actor roster invalid`)
    for (const a of s.actors) if (![a.p.x, a.p.y, a.p.z, a.hp, a.food].every(Number.isFinite) || a.hp <= 0 || a.hp > 20 || a.food < 0 || a.food > 20 || Math.abs(a.p.x - s.arena.x) + .3 >= s.arena.r || Math.abs(a.p.z - s.arena.z) + .3 >= s.arena.r || a.p.y <= s.arena.killY) throw new Error(`${s.id}: unsafe actor fixture`)
    if (s.blueprint && (new Set(s.blueprint.cells.map(cellKey)).size !== s.blueprint.cells.length || s.blueprint.cells.some(p => ![p.x, p.y, p.z].every(Number.isInteger)))) throw new Error(`${s.id}: invalid blueprint`)
  }
  return true
}

/** 1.21.11 encodes optional source entity IDs as id + 1 (zero is no source).
 * `sourceId` is reserved for the observer's already-normalized fixture field. */
export function damageSourceIds(packet: any): number[] {
  return [...new Set([packet?.sourceCauseId, packet?.sourceDirectId].filter(n => Number.isInteger(n) && n > 0).map(n => n - 1)
    .concat(Number.isInteger(packet?.sourceId) && packet.sourceId > 0 ? [packet.sourceId] : []))]
}
