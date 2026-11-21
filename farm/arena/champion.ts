// Чемпион (ARMS_CHAMP=1): один красный бот против роя синих — как сильный человек. Набор и баффы — человека соло
// (humans.ts kitStrong). Видит синего — бой дуэльным движком демона: все синие рядом — его цели, движок сам лечится,
// жемчужит, бьёт булавой и щитом. Проверив последнюю известную позицию, обходит ещё не осмотренные секторы.
import { arenaBounds, type ArenaContext } from './context'

const dist = (a, c) => Math.hypot(a.x - c.x, a.y - c.y, a.z - c.z)

export async function champTurn (ctx: ArenaContext, b) {
  const frame = ctx.pos[b.name], me = frame?.p
  if (!me || ctx.between || b.swarmReserved || frame.rescuing || frame.combo) return
  const arena = arenaBounds(ctx), now = Date.now()
  const foes = ctx.swarmDriver.enemies(b).filter(e => ctx.hostile(b, e.id) && !ctx.out.has(e.id) && !ctx.deadNow.has(e.id) && !ctx.humanOut.has(e.id))
  const seen = foes.filter(e => e.source === b.name && !e.nametag && !e.glowing && e.seenAt === frame.sightAt && now - e.seenAt >= 0 && now - e.seenAt < 2000)
    .sort((a, c) => dist(a.position, me) - dist(c.position, me))
  if (seen.length) {
    delete b.champTrail
    const reply = await b.c.call('fight', { target: seen[0].id, targets: seen.map(e => e.id), allowPlayer: true, allowRanged: true, timeoutSeconds: 10, retreatAtHealth: 6, arena }).catch(e => ({ why: e.message }))
    const r = reply?.detail || reply || {}
    ctx.log(`👑 ${b.name} → ${seen[0].id} (видит ${seen.length}): попаданий ${r.landed ?? '?'}/${r.swings ?? '?'}, хп ${r.hp ?? '?'}${r.kills?.length ? `, убил ${r.kills.length}` : r.killed ? ', убил' : ''}${r.stopped || r.why || reply?.error ? ' — ' + String(r.stopped || r.why || reply.error).slice(0, 70) : ''}${r.calc?.picks ? ` | граф ${Object.entries(r.calc.picks).map(([k, n]) => `${k}:${n}`).join(',')}` : ''}${r.tricks ? ` | ${Object.keys(r.tricks).slice(0, 6).join(', ')}` : ''}`)
    return
  }
  const clue = foes.sort((a, c) => c.seenAt - a.seenAt || dist(a.position, me) - dist(c.position, me))[0]
  const prior = b.champTrail, round = ctx.round
  const checked = clue && prior?.round === round && prior.id === clue.id && dist(prior.to, clue.position) < 2 && (!prior.from || dist(prior.from, me) < 2)
  if (clue && !checked) {
    const to = clue.position, trail = { round, id: clue.id, to: { ...to } }
    const reached = p => p && Math.abs(p.y - to.y) < 2 && dist(p, to) < 3
    if (!reached(me)) {
      const reply = await b.c.call('goto', { ...to, range: Math.abs(to.y - me.y) >= 2 ? 1 : 2, timeoutSeconds: 8, arena, _hunt: true })
      if (ctx.between || ctx.round !== round || b.swarmReserved || reply?.notStarted || reply?.status === 'interrupted') return
      const end = reply?.state?.pos || reply?.detail?.arrived || reply?.detail?.at
      const noPath = reply?.status === 'failed' && /^(NO_PATH|AVOID_NO_PATH|ARENA_BOUNDARY)$/.test(reply.code)
      const stalled = (reply?.status === 'timeout' || reply?.detail?.stopped) && end && dist(me, end) < 1
      if (reply?.status === 'done' && reached(end)) b.champTrail = trail
      else if (noPath || stalled) b.champTrail = { ...trail, from: { ...me } }
      return
    }
    b.champTrail = trail
  }
  await ctx.swarmDriver.scout(b)
}
