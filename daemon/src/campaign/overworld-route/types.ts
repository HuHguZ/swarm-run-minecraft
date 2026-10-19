'use strict'
export type CampaignRouteContext = Record<string, any>

// Общее состояние маршрута между частями: недобитый голем (бой переживает прерывание стратегии) и устье пещеры.
export interface RouteState {
  golemEncounter: { to: { x: number, z: number } } | null
  caveMouth: any
}
