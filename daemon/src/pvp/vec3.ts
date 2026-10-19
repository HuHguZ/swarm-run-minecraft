// Фабрика vec3 (parseFloat, null → 0,0,0), как прежний require('vec3') в pvp.ts; тип — класс Vec3.
import vec3 from 'vec3'

export const Vec3 = vec3 as unknown as typeof import('vec3').Vec3
