import { WebSocket, WebSocketServer, type RawData } from 'ws'
import type { AddressInfo } from 'node:net'
import type { Environment, ExecutionResult, SkillCommand } from '../core/environment'
import type { WorldState } from '../core/world-state'
import type { SimEnvironment } from './sim'

type RpcId = string | number
interface Reply { id: RpcId | null; ok: boolean; result?: unknown; error?: string }
interface Task { token: number; controller: AbortController; result?: ExecutionResult }
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object')
  return value as Record<string, unknown>
}
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

export class SimRpcServer {
  private readonly socket: WebSocketServer
  private readonly tasks = new Map<number, Task>()
  private sequence = 0
  constructor(readonly environment: SimEnvironment, options: { port: number; host?: string }) {
    this.socket = new WebSocketServer({ port: options.port, host: options.host ?? '127.0.0.1' })
    this.socket.on('connection', peer => peer.on('message', raw => { void this.receive(peer, raw) }))
  }
  ready(): Promise<void> {
    if (this.socket.address()) return Promise.resolve()
    return new Promise((resolve, reject) => { this.socket.once('listening', resolve); this.socket.once('error', reject) })
  }
  url(): string { return `ws://127.0.0.1:${(this.socket.address() as AddressInfo).port}` }
  private async receive(peer: WebSocket, raw: RawData): Promise<void> {
    let id: RpcId | null = null
    try {
      const request = object(JSON.parse(raw.toString()))
      if (typeof request.id !== 'number' && typeof request.id !== 'string') throw new Error('Missing RPC id')
      id = request.id
      if (typeof request.method !== 'string') throw new Error('Missing RPC method')
      const result = await this.dispatch(request.method, object(request.params ?? {}))
      if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ id, ok: true, result } satisfies Reply))
    } catch (error) {
      if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ id, ok: false, error: errorText(error) } satisfies Reply))
    }
  }
  async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'observe' || method === 'state') return { status: 'done', state: await this.environment.observe(), events: [], simulated: true }
    if (method === 'clock.now') return { now: this.environment.now() }
    if (method === 'clock.sleep') {
      const milliseconds = params.milliseconds
      if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds < 0) throw new Error('Invalid milliseconds')
      await this.environment.sleep(milliseconds)
      return { now: this.environment.now() }
    }
    if (method === 'stop') {
      const reason = typeof params.reason === 'string' ? params.reason : 'operator stop'
      for (const task of this.tasks.values()) {
        if (task.result) continue
        task.controller.abort(reason)
        task.result = { outcome: 'INTERRUPTED', reason, events: [] }
      }
      await this.environment.cancel(reason)
      return { status: 'done', state: await this.environment.observe(), events: [] }
    }
    if (method === 'status') {
      if (params.token === undefined) return { status: 'done', state: await this.environment.observe(), events: [], simulated: true }
      if (typeof params.token !== 'number') throw new Error('Invalid token')
      const task = this.tasks.get(params.token)
      if (!task) throw new Error(`Unknown pending task: ${params.token}`)
      if (!task.result) return { status: 'pending', token: task.token }
      const status = task.result.outcome === 'SUCCESS' ? 'done' : task.result.outcome === 'INTERRUPTED' ? 'interrupted' : 'failed'
      return { status, token: task.token, detail: task.result, events: task.result.events, state: await this.environment.observe() }
    }
    if (method !== 'execute' && method !== 'run' && method !== 'strategy.execute') throw new Error(`Unsupported simulated RPC: ${method}`)
    if ([...this.tasks.values()].some(task => !task.result)) throw new Error('A simulated skill is already running')
    const command = object(params.command ?? params)
    const strategy = typeof command.strategy === 'string' ? command.strategy : undefined
    const definition = strategy ? this.environment.registry.get(strategy) : undefined
    const skill = typeof command.skill === 'string' ? command.skill : definition?.skill
    if (!skill) throw new Error('Missing skill or registered strategy')
    if (strategy && (!definition || definition.skill !== skill)) throw new Error('Unknown strategy or mismatched skill')
    const skillCommand: SkillCommand = { skill, strategy, params: command.params === undefined ? undefined : object(command.params) }
    const task: Task = { token: ++this.sequence, controller: new AbortController() }
    this.tasks.set(task.token, task)
    for (const [token, prior] of this.tasks) if (this.tasks.size > 128 && prior.result) this.tasks.delete(token)
    setImmediate(() => {
      if (task.result) return
      void this.environment.execute(skillCommand, task.controller.signal).then(result => { task.result ??= result }, error => {
        task.result ??= { outcome: 'FAILURE', reason: errorText(error), events: [] }
      })
    })
    return { status: 'pending', token: task.token }
  }
  async close(): Promise<void> {
    await this.dispatch('stop', { reason: 'simulated daemon closed' })
    for (const peer of this.socket.clients) peer.terminate()
    await new Promise<void>((resolve, reject) => this.socket.close(error => error ? reject(error) : resolve()))
  }
}

export class SimRpcEnvironment implements Environment {
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  private sequence = 0
  private elapsedMs = 0
  private constructor(private readonly socket: WebSocket) {
    socket.on('message', raw => {
      try {
        const reply = object(JSON.parse(raw.toString()))
        if (typeof reply.id !== 'number') return
        const request = this.pending.get(reply.id)
        if (!request) return
        this.pending.delete(reply.id)
        if (reply.ok === true) request.resolve(reply.result)
        else request.reject(new Error(typeof reply.error === 'string' ? reply.error : 'Simulated RPC failed'))
      } catch (error) { this.rejectPending(errorText(error)) }
    })
    socket.on('close', () => this.rejectPending('Simulated RPC connection closed'))
    socket.on('error', error => this.rejectPending(error.message))
  }
  static async connect(url: string): Promise<SimRpcEnvironment> {
    const socket = new WebSocket(url)
    const environment = new SimRpcEnvironment(socket)
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    return environment
  }
  private rejectPending(message: string): void {
    for (const request of this.pending.values()) request.reject(new Error(message))
    this.pending.clear()
  }
  call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Simulated RPC connection is not open'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }), error => {
        if (error) { this.pending.delete(id); reject(error) }
      })
    })
  }
  async observe(): Promise<WorldState> {
    const response = object(await this.call('observe'))
    const state = object(response.state)
    if (typeof state.elapsedMs !== 'number' || typeof state.alive !== 'boolean' || !state.facts || !state.resources) throw new Error('Malformed simulated WorldState')
    this.elapsedMs = state.elapsedMs
    return state as unknown as WorldState
  }
  async execute(command: SkillCommand, signal: AbortSignal): Promise<ExecutionResult> {
    if (signal.aborted) return { outcome: 'INTERRUPTED', reason: String(signal.reason), events: [] }
    const cancel = () => { void this.cancel(String(signal.reason)).catch(() => undefined) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const pending = object(await this.call('execute', { command }))
      if (typeof pending.token !== 'number') throw new Error('Malformed simulated pending result')
      while (true) {
        const response = object(await this.call('status', { token: pending.token }))
        if (response.status === 'pending') { await new Promise<void>(resolve => setImmediate(resolve)); continue }
        const result = object(response.detail)
        if (!['SUCCESS', 'FAILURE', 'INTERRUPTED', 'TIMEOUT', 'PARTIAL'].includes(String(result.outcome)) || !Array.isArray(result.events)) throw new Error('Malformed simulated execution result')
        const state = object(response.state)
        if (typeof state.elapsedMs === 'number') this.elapsedMs = state.elapsedMs
        return result as unknown as ExecutionResult
      }
    } finally { signal.removeEventListener('abort', cancel) }
  }
  async cancel(reason: string): Promise<void> { await this.call('stop', { reason }) }
  now(): number { return this.elapsedMs }
  async sleep(milliseconds: number): Promise<void> {
    const response = object(await this.call('clock.sleep', { milliseconds }))
    if (typeof response.now !== 'number') throw new Error('Malformed simulated clock')
    this.elapsedMs = response.now
  }
  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return
    await new Promise<void>(resolve => { this.socket.once('close', resolve); this.socket.close() })
  }
}
