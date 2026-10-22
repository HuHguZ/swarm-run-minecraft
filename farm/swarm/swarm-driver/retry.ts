// Рой: повтор неудавшейся попытки — по причине, а не по сроку (пользователь 15.10 и 21.10: «режимы по миру, без костылей
// по секундам»; Codex, разбор таймеров, уточнение A3: повтор привязан к причине неудачи). Неудача запоминается с подписью
// мира: где стоял бот и что было важно для попытки (sig — цель, запасы, причина). Та же попытка снова — когда бот ушёл
// с места (2 бл.) или подпись другая: цель сдвинулась, запасы пришли.
// Точки команды (засада, яма, стена под лестницу) — так же: закрыта, пока споткнувшийся на ней стоит там же; раскрытая
// засада — пока у неё враг (16 бл.).
import { distance } from './common'
import type { SwarmDriverCtx } from './common'

export function swarmRetry (sw: SwarmDriverCtx) {
  const retries = new Map<string, { at: any; sig: string }>()
  const failed = (b, key: string, sig = '') => { const p = sw.pos[b.name]?.p; retries.set(key, { at: p ? { ...p } : null, sig }) }
  const blocked = (b, key: string, sig = '') => {
    const f = retries.get(key), p = sw.pos[b.name]?.p
    return !!f && f.sig === sig && !!f.at && !!p && distance(p, f.at) < 2
  }
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
