'use strict'

// Vanilla TickCommand accepts 1..10000 ticks/s. This controls the server's
// target; overloaded worlds can run slower, so budgets use the game clock.
function tickRate (args: any = {} as Record<string, any>, env = process.env, defaultRate = 20) {
  let fromScene
  for (const kv of args.env || []) if (kv.startsWith('TICK_RATE=')) fromScene = kv.slice(10)
  const value = args['tick-rate'] ?? fromScene ?? env.TICK_RATE ?? defaultRate
  const rate = typeof value === 'boolean' ? NaN : Number(value)
  if (!Number.isFinite(rate) || rate < 1 || rate > 10000) throw new Error('--tick-rate / TICK_RATE: нужно число от 1 до 10000 тиков/с')
  return rate
}

function tickAction (tokens) {
  const [action = 'query', value, ...rest] = tokens
  if (action === 'rate') {
    if (value === undefined || rest.length) throw new Error('tick rate: нужно одно значение --tick-rate (1..10000)')
    const rate = tickRate({ 'tick-rate': value }, {} as Record<string, any>)
    return { command: `tick rate ${rate}`, rate }
  }
  if (action === 'step') {
    if (rest.length) throw new Error('tick step: число тиков или stop')
    if (value === 'stop') return { command: 'tick step stop' }
    const ticks = value === undefined ? 1 : Number(value)
    if (!Number.isSafeInteger(ticks) || ticks < 1 || ticks > 2147483647) throw new Error('tick step: целое число тиков от 1 до 2147483647')
    return { command: `tick step ${ticks}` }
  }
  if (!['query', 'freeze', 'unfreeze'].includes(action) || value !== undefined) throw new Error('tick: query | rate <1..10000> | freeze | unfreeze | step [число|stop]; sprint не синхронизирует скорость клиента')
  return { command: `tick ${action}` }
}

function checkedReply (command, reply) {
  const text = String(reply || '')
  if (!text || /unknown|incorrect|incomplete|error|expected|invalid|not found|unable to step|no tick (step|sprint) in progress/i.test(text)) throw new Error(`${command}: ${text || 'пустой ответ RCON'}`)
  return text
}

async function configureTick (send, rate) {
  checkedReply('tick unfreeze', await send('tick unfreeze'))
  checkedReply(`tick rate ${rate}`, await send(`tick rate ${rate}`))
  const query = checkedReply('tick query', await send('tick query'))
  // English text comes from this checkout's 1.21.11 server jar:
  // commands.tick.query.rate.running. Vanilla prints one decimal place.
  const reported = /Target tick rate:\s*(\d+(?:[.,]\d+)?)/i.exec(query)
  if (!reported || Math.abs(Number(reported[1].replace(',', '.')) - rate) > 0.051 || /ignored|sprinting|game is frozen/i.test(query)) {
    throw new Error(`tick query: запрос ${rate} тиков/с не подтверждён — ${query}`)
  }
  return query
}

function runEnv (parent, extra, rate) {
  return { ...parent, ...extra, TICK_RATE: String(rate), ND_TICK_RATE: String(rate), ND_CLOCK: 'game' }
}

// Paper counts packets in real time, including recipe overrides. Accelerated
// farm clients intentionally send more packets. Only replace this YAML block.
function disablePacketLimiter (yaml) {
  const newline = yaml.includes('\r\n') ? '\r\n' : '\n'
  const block = ['packet-limiter:', '  all-packets:', '    action: KICK', '    interval: 0.0',
    '    max-packet-rate: 0.0', '  overrides: {}', ''].join(newline)
  const start = /^packet-limiter:[^\r\n]*(?:\r?\n|$)/m.exec(yaml)
  if (!start) return yaml + (yaml && !yaml.endsWith('\n') ? newline : '') + block
  const bodyStart = start.index + start[0].length
  const next = /^\S/m.exec(yaml.slice(bodyStart))
  const end = next ? bodyStart + next.index : yaml.length
  const section = yaml.slice(bodyStart, end)
  const all = /^  all-packets:\r?\n((?:    [^\r\n]*(?:\r?\n|$))*)/m.exec(section)
  const zero = key => {
    const value = all && new RegExp(`^    ${key}:\\s*([^#\\r\\n]+)`, 'm').exec(all[1])
    return !!value && Number(value[1].trim()) === 0
  }
  // Paper may save comments, kick-message and a different field order on
  // reload. Those do not require another reload when the limits are already off.
  if (zero('interval') && zero('max-packet-rate') && /^  overrides:[ \t]*\{\}[ \t]*(?:#[^\r\n]*)?\r?$/m.test(section)) return disableSpamLimiter(yaml)
  return disableSpamLimiter(yaml.slice(0, start.index) + block + yaml.slice(end))
}

// Paper spam-limiter (ServerGamePacketListenerImpl.checkLimit, javap 1.21.11): use_item/use_item_on past the 9th within
// incoming-packet-threshold WALL ms are dropped without block_changed_ack. 300 ms is 6 ticks at 20 TPS but 225 at 750:
// bridges, beds, bows and pearls lose packets ("ответа от сервера нет"). Paper writes the key on first start; `run` re-ensures.
function disableSpamLimiter (yaml) {
  return yaml.replace(/^(spam-limiter:[^\r\n]*\r?\n(?:  [^\r\n]*\r?\n)*?  incoming-packet-threshold:)[ \t]*(?!disabled\b)[^\r\n#]*/m, '$1 disabled')
}

module.exports = { tickRate, tickAction, checkedReply, configureTick, runEnv, disablePacketLimiter }
