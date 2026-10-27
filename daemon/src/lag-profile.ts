// Диагностика остановок цикла событий (16.10, Claude-сим): ферма lockstep падает «connected client stalled», когда демон молчит
// по реальному времени дольше порога — в обычной игре это тело, застывшее на секунды.
// ND_LAG_PROFILE=1: профайлер V8 окнами по 5 с в главном потоке; окно, где цикл стоял > 1.5 с, — в farm/lag/<игрок>-<время>.cpuprofile.
// ND_LAG_PROFILE_MS — свой порог (27.10: ловить блокировки боя 200–500 мс, держащие выпуск ветра); тогда выборка чаще (2 мс)
// и не больше ND_LAG_PROFILE_MAX (по умолчанию 6) файлов на процесс.
// Бесконечный синхронный цикл так не пишется: Profiler из рабочего потока (connectToMainThread) в Node 24 не обслуживается, пока главный
// поток занят (проверено 16.10).
import * as fs from 'fs'
import path = require('path')
import { REPO_ROOT } from './paths'
const dirOf = () => path.join(REPO_ROOT, 'farm', 'lag')
function save (profile: any, ms: number, tag = '') {
  try {
    fs.mkdirSync(dirOf(), { recursive: true })
    const file = path.join(dirOf(), `${process.env.MC_USERNAME || 'bot'}-${Date.now()}${tag}.cpuprofile`)
    fs.writeFileSync(file, JSON.stringify(profile))
    return file
  } catch { return null }
}
function startMainThread () {
  const inspector: typeof import('node:inspector') = require('node:inspector')
  const s = new inspector.Session()
  s.connect()
  const post = (m: string, p: any = {}) => new Promise<any>((res, rej) => s.post(m, p, (e, r) => e ? rej(e) : res(r)))
  const limit = Number(process.env.ND_LAG_PROFILE_MS) || 1500, fine = limit < 1500
  let left = Number(process.env.ND_LAG_PROFILE_MAX) || (fine ? 6 : Infinity)
  let last = Date.now(), maxLag = 0
  setInterval(() => { const now = Date.now(); maxLag = Math.max(maxLag, now - last - 250); last = now }, 250).unref()
  ;(async () => {
    await post('Profiler.enable')
    await post('Profiler.setSamplingInterval', { interval: fine ? 2000 : 10000 })
    while (left > 0) {
      await post('Profiler.start')
      maxLag = 0
      await new Promise(r => setTimeout(r, 5000))
      const { profile } = await post('Profiler.stop')
      if (maxLag > limit) { left--; console.log('[lag]', JSON.stringify({ ms: maxLag, file: save(profile, maxLag) })) }
    }
  })().catch(e => console.log('[lag] профайлер:', String(e)))
}
function startLagProfile () {
  startMainThread()
}
export { startLagProfile }
