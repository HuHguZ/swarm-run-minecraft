// Очередь ударов по одной цели (рой, 21.10; механика 1.21.11 — LivingEntity.hurtServer, сверка DeepSeek t2 по jar):
// после удара цель неуязвима 10 тиков (invulnerableTime > 10): удар не сильнее последнего (lastHurt) не проходит вовсе —
// ни урона, ни отброса, а заряд бившего сброшен (Player.attack → resetAttackStrengthTicker). Все нападающие видят один
// и тот же entityHurt, ждут конца окна и бьют в один тик — проходит один удар из трёх. Здесь — у каждого своё место в
// очереди (task.data.strikeOrder от планировщика роя, fight RPC: `strikeOrder`), по кругу от последнего ударившего:
// следующий за ним бьёт сразу по концу окна, ещё следующий — на SLOT_MS позже, ударивший — последним. Меч (12.5 тиков)
// к концу следующего окна (10 тиков) не готов — окно берёт следующий по кругу. Модель (тест): трое с мечами за 20 с —
// 40 попаданий из 40 возможных и 3 пустых взмаха; без очереди — 31 и 62; «место по списку» без круга — 31 и 32.
import { TICK_MS } from './rules'

export const WINDOW_MS = 10 * TICK_MS // invulnerableTime 20 → удар снова полный, когда > 10 прошло
export const SLOT_MS = 2 * TICK_MS

// order — массив имён (очередь для этой цели) или { [цель]: имена }; present — кто из очереди сейчас у цели (видимые
// в 6 бл. от неё); lastBy — кто ударил последним (имя; не из очереди или неизвестно — счёт с начала списка).
// Возвращает моё место по кругу (0 — бью первым) или 0, если очереди нет.
export function strikeSlot (order: any, me: string, target: string, present: Set<string>, lastBy: string | null = null) {
  const list: string[] = Array.isArray(order) ? order : order && typeof order === 'object' && Array.isArray(order[target]) ? order[target] : null
  if (!list || !list.includes(me)) return 0
  const here = list.filter(n => n === me || n === lastBy || present.has(n))
  const i = here.indexOf(me); const j = lastBy ? here.indexOf(lastBy) : -1
  return j < 0 ? i : (i - j - 1 + here.length) % here.length
}

// Сколько ещё ждать с ударом: окно после последнего удара по цели плюс моё место по кругу.
export function strikeWait (now: number, hurtAt: number, slot: number) {
  return Math.max(0, hurtAt + WINDOW_MS + slot * SLOT_MS - now)
}

// Вред (зелье) — в окно неуязвимости не бросать: в окне проходит только сверх последнего удара (lastHurt), и 12 сырых вреда II
// после удара мечом или стрелы в 9–15 — почти ноль (DeepSeek t7, сверка hurtServer). Облако должно лечь (через flightTicks)
// после конца окна от последнего попадания по нему. Сколько ещё ждать с броском; 0 — бросать.
export function harmWait (now: number, hurtAt: number | null | undefined, flightTicks: number) {
  return hurtAt ? Math.max(0, Math.ceil(hurtAt + WINDOW_MS - (now + flightTicks * TICK_MS))) : 0
}
