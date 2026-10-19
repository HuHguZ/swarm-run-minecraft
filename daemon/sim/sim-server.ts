import { speedrunRegistry } from '../src/core/speedrun'
import { SimEnvironment } from '../src/environments/sim'
import { SimRpcServer } from '../src/environments/sim-rpc'
import { loadCosts } from '../src/environments/cost-data'

export async function serveSimulation(port = 9876, seed = 1, sampled = false): Promise<SimRpcServer> {
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !Number.isFinite(seed)) throw new Error('Invalid simulation port or seed')
  const costs = loadCosts()
  const server = new SimRpcServer(new SimEnvironment(speedrunRegistry({ costs }), { seed, costs, deterministic: !sampled }), { port })
  await server.ready()
  return server
}
if (require.main === module) {
  const args = process.argv.slice(2)
  const port = Number(process.env.ND_SIM_PORT ?? args.find(argument => argument !== '--sampled') ?? 9876)
  const seed = Number(process.env.ND_SIM_SEED ?? 1)
  serveSimulation(port, seed, args.includes('--sampled')).then(server => {
    console.log(`SimEnvironment RPC: ${server.url()} (abstract strategy effects)`)
    const stop = () => { void server.close().then(() => { process.exitCode = 0 }) }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  }).catch(error => { console.error(error); process.exitCode = 1 })
}
