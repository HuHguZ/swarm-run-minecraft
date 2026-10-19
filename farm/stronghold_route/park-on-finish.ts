'use strict'
import { connect, sleep } from '../../daemon/scenes/lib/scene-kit'
const pid = Number(process.argv[2])
if (!Number.isInteger(pid) || pid <= 0) throw new Error('Нужен PID сцены выделенного слота 5')
async function main () {
  const until = Date.now() + 45 * 60000
  while (Date.now() < until) {
    try { process.kill(pid, 0) } catch {
      const c = connect('ws://127.0.0.1:8805')
      await c.ready
      console.log(JSON.stringify(await c.call('disconnect', { reason: 'ферма: наблюдатель сцены отсоединяет остановленное тело' })))
      c.close()
      return
    }
    await sleep(1000)
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e.stack); process.exit(1) })
