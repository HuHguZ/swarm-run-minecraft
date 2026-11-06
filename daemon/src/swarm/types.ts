// Рой (swarm.ts): типы доски — свои, враги, общее зрение, факты, задачи с арендой, чертежи.
export type SwarmPosition = { x: number; y: number; z: number }
export type DigStand = SwarmPosition & { requiresClear?: SwarmPosition[]; support?: SwarmPosition }
export type DigSite = SwarmPosition & { feetY?: number; stands?: DigStand[]; blocks?: string[]; handMs?: number; tier?: number; drop?: number; dug?: number; undermine?: boolean }
export type SwarmRole = 'fighter' | 'healer' | 'ranged' | 'flank' | 'miner-builder'
export type SwarmKind = 'fight' | 'goto' | 'heal' | 'build' | 'mine' | 'scout' | 'recover' | 'transfer' | 'flee' | 'loot'
export type Doctrine = 'ring' | 'line' | 'buffalo' | 'fountain' | 'weak-center' | 'cocoon' | 'wave' | 'hunt' | 'false-weakness' | 'false-retreat'
export type ThreatKind = 'melee' | 'bow' | 'aerial' | 'blast'
export interface SwarmMember {
  id: string
  team: string
  position: SwarmPosition
  health: number
  maxHealth?: number
  /** Свой голод (0–20): естественная регенерация — только с 18 (FoodData, 1.21.11). */
  food?: number
  strength: number
  role: SwarmRole
  canHeal?: boolean
  inventory?: Record<string, number>
  /** Own receipt state; receivedAt belongs to the driver's wall clock, not the bot's game clock. */
  antidote?: { state: import('../pvp/antidotes').AntidoteState; choice?: import('../pvp/antidotes').AntidoteChoice | null; need?: import('../pvp/antidotes').AntidoteChoice | null; using?: boolean; receivedAt: number }
  /** Own usable ammunition; beneficial tipped arrows remain separate inventory items. */
  attackArrows?: number
  /** Зелья по виду (splash_strong_harming…): в inventory они одним именем splash_potion. */
  potions?: Record<string, number>
  reserve?: Record<string, number>
  needs?: Record<string, number>
  armor?: string[] | Record<string, string>
  /** Предмет в левой руке (щит, тотем): в рюкзаке его нет. */
  offHand?: string
  weapon?: string
  ench?: { sharpness?: number; protection?: number; power?: number; knockback?: number }
}
// Подтверждённые этим телом попадания за 8 с; лечение — своя модель, ago — возраст в игровых мс.
export type HitProof = { healed: number; healing?: { event: number; ago: number; absorption: number }; hits: { ago: number; damage: number; lowDamage: number; minDamage?: number; healed: number }[] }
export interface EnemyObservation {
  id: string
  visible: boolean
  // Ник сквозь стену: место без прямой видимости (swarm-senses).
  nametag?: boolean
  position: SwarmPosition
  velocity?: SwarmPosition
  // Physical forecast for this observation only; the long-lived board never retains it.
  peakY?: number | null
  equipment?: { weapon?: string; armor?: string[]; enchanted?: boolean; unknownArmorSlots?: number }
  threat?: ThreatKind
  // Верх оценки его хп (с поглощением) по нашим подтверждённым попаданиям и видимому лечению — не метаданные (AGENTS.md):
  // своё имя, а не hp/health, — сырое хп доска не читает никогда (тесты честности).
  hpEstimate?: number
  hitProof?: HitProof
}
export interface SharedEnemy extends Omit<EnemyObservation, 'visible' | 'peakY'> {
  seenAt: number
  source: string
  sources: string[]
  pressure?: { hits: number; damage: number; damageLow: number; healing: number }
}
export interface SwarmFact {
  id: string
  kind: 'mark' | 'support' | 'threat'
  position: SwarmPosition
  threat?: ThreatKind
  source: string
  seenAt: number
  expiresAt: number
}
export interface SwarmTask {
  id: string
  kind: SwarmKind
  team?: string
  priority?: number
  position?: SwarmPosition
  assignedTo?: string
  participants?: string[]
  dependsOn?: string[]
  expiresAt?: number
  data?: Record<string, any>
  status?: 'pending' | 'claimed' | 'done'
  claim?: { owner: string; token: number; claimedAt: number; expiresAt: number }
  /** Когда подтверждена (ack). */
  doneAt?: number
}
export type ClaimedTask = SwarmTask & { claim: NonNullable<SwarmTask['claim']> }
export interface SwarmReceipt { token: number; confirmed: boolean; position?: SwarmPosition; block?: string }
export interface BlueprintCell { id: string; position: SwarmPosition; block: string; dependsOn?: string[]; support?: string | SwarmPosition; /** Порядок кладки: выше — раньше (умолчание 60). */ priority?: number }
export interface Blueprint { id: string; cells: BlueprintCell[] }
