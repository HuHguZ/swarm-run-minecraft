// Чемпион (ARMS_CHAMP=1): один красный бот против роя синих — как сильный человек. Набор и баффы — человека соло
// (humans.ts kitStrong). Видит синего — бой дуэльным движком демона: все синие рядом — его цели, движок сам лечится,
// жемчужит, бьёт булавой и щитом. Не видит — идёт туда, где видел последнего, иначе к их спавну: охотится, не ждёт.
import type { ArenaContext } from './context'

const dist = (a, c) => Math.hypot(a.x - c.x, a.y - c.y, a.z - c.z)

export async function champTurn (ctx: ArenaContext, b) {
  const { pos, X, Y, Z, R, L, arms } = ctx
  const me = pos[b.name]?.p
  if (!me) return
  const arena = { x: X + 0.5, y: Y, z: Z + 0.5, r: R, killY: arms ? Y + L.y0 - 3 : undefined }
  const foes = ctx.swarmDriver.enemies(b).filter(e => ctx.alive(e.id)).sort((a, c) => dist(a.position, me) - dist(c.position, me))
  const seen = foes.filter(e => Date.now() - e.seenAt < 2000)
  if (seen.length) {
    const reply = await b.c.call('fight', { target: seen[0].id, targets: seen.map(e => e.id), allowPlayer: true, allowRanged: true, timeoutSeconds: 10, retreatAtHealth: 6, arena }).catch(e => ({ why: e.message }))
    const r = reply?.detail || reply || {}
    ctx.log(`👑 ${b.name} → ${seen[0].id} (видит ${seen.length}): попаданий ${r.landed ?? '?'}/${r.swings ?? '?'}, хп ${r.hp ?? '?'}${r.kills?.length ? `, убил ${r.kills.length}` : r.killed ? ', убил' : ''}${r.stopped || r.why || reply?.error ? ' — ' + String(r.stopped || r.why || reply.error).slice(0, 70) : ''}${r.calc?.picks ? ` | граф ${Object.entries(r.calc.picks).map(([k, n]) => `${k}:${n}`).join(',')}` : ''}${r.tricks ? ` | ${Object.keys(r.tricks).slice(0, 6).join(', ')}` : ''}`)
    return
  }
  const to = foes[0]?.position || ctx.armsHome({ team: 'blue' }, 0)
  await b.c.call('goto', { x: to.x, y: to.y, z: to.z, range: 2, timeoutSeconds: 8, arena, _hunt: true })
}
