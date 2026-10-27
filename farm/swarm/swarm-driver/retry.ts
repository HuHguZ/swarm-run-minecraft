// Рой: повтор неудавшейся попытки — по причине, а не по сроку (пользователь 15.10 и 21.10: «режимы по миру, без костылей
// по секундам»; Codex, разбор таймеров, уточнение A3: повтор привязан к причине неудачи). Неудача запоминается с подписью
// мира: где стоял бот и что было важно для попытки (sig — цель, запасы, причина). Та же попытка снова — когда бот ушёл
// с места (2 бл.) или подпись другая: цель сдвинулась, запасы пришли. Другие подписи не стирают прежний отказ.
// Точки команды (засада, яма, стена под лестницу) — так же: закрыта, пока споткнувшийся на ней стоит там же; раскрытая
// засада — пока у неё враг (16 бл.).
import { distance } from './common'
import type { SwarmDriverCtx } from './common'

export function swarmRetry (sw: SwarmDriverCtx) {
  const retries = new Map<string, Map<string, { at: any }>>()
  const nearby = (b, key: string) => {
    const history = retries.get(key), p = sw.pos[b.name]?.p
    if (history && p) {
      for (const [sig, f] of history) if (!f.at || !p || !(distance(p, f.at) < 2)) history.delete(sig)
      if (!history.size) retries.delete(key)
    }
    return history
  }
  const failed = (b, key: string, sig = '') => {
    const p = sw.pos[b.name]?.p, history = nearby(b, key) || new Map<string, { at: any }>()
    history.set(sig, { at: p ? { ...p } : null }); retries.set(key, history)
  }
  const blocked = (b, key: string, sig = '') => !!sw.pos[b.name]?.p && !!nearby(b, key)?.has(sig)
  const cleared = (key: string) => { retries.delete(key) }
  const sites = new Map<string, { bot: string; at: any; watch?: any }>()
  // watch — место, у которого враг держит точку закрытой (раскрытая засада).
  const siteFailed = (b, key: string, watch: any = null) => { const p = sw.pos[b.name]?.p; sites.set(key, { bot: b.name, at: p ? { ...p } : null, watch }) }
  const siteOpen = (key: string, enemies: { position: any }[] = []) => {
    const f = sites.get(key); if (!f) return true
    const p = sw.pos[f.bot]?.p
    const stuck = !!f.at && !!p && sw.alive(f.bot) && distance(p, f.at) < 2
    const watched = !!f.watch && enemies.some(e => distance(e.position, f.watch) < 16)
    if (!stuck && !watched) { sites.delete(key); return true }
    return false
  }
  return { retries, failed, blocked, cleared, sites, siteFailed, siteOpen }
}
