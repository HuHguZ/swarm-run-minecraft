'use strict'
// Контекст RPC-методов демона: объектный граф из src/index.ts (сессия, конфиг, шина, зрение, директор, игровые часы)
// и общее изменяемое состояние (state.dangerWatch: пишет watch_dangers, читают status и рассылка опасностей).
type RpcState = { dangerWatch: { foes: string[] } | null }
type RpcContext = { session?: any, cfg?: any, bus?: any, vision?: any, director?: any, gameClock?: any, state?: RpcState }
type Method = (p?: any) => any

export type { RpcState, RpcContext, Method }
