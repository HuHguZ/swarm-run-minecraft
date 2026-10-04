// Every tool result carries a compact state header. That was a deliberate
// design call: the brain should never need a second round trip just to ask
// "where am I", and after a context compaction the header alone is enough to
// re-orient.

function fmtPos (p) {
  return p ? `${p.x},${p.y},${p.z}` : '?'
}

function fmtInventory (inv) {
  const entries = Object.entries(inv || {})
  if (!entries.length) return 'пусто'
  return entries.map(([name, n]) => `${name}×${n}`).join(', ')
}

export function header (state) {
  if (!state || !state.connected) return 'NeuroDown: не в игре'
  const bits = [
    `NeuroDown hp${state.health} еда${state.food}`,
    `(${fmtPos(state.pos)}) ${state.biome || '?'} ${state.dimension || ''}`.trim(),
    state.time,
    state.isRaining ? 'дождь' : null,
    state.held ? `в руке: ${state.held}` : null,
    `инвентарь: ${fmtInventory(state.inventory)}`,
    // The whole tab list, with no distance in it at all (perception.js:
    // Object.keys(bot.players)). «Рядом» is mc_players' word, not this one's.
    state.playersOnline && state.playersOnline.length ? `на сервере: ${state.playersOnline.join(', ')}` : 'других игроков нет',
    state.goal ? `цель: ${state.goal}` : null,
    state.busy ? `занят: ${state.busy}` : null,
    state.playPolicy ? `режим: ${state.playPolicy.mode}` : null
  ].filter(Boolean)
  return bits.join(' · ')
}

// Russian counts one, few and many differently, and "осталось 5 удар" reads as
// a bug in the daemon rather than a number worth acting on.
function plural (n, one, few, many) {
  const a = Math.abs(n) % 100
  const b = a % 10
  if (a > 10 && a < 20) return many
  if (b === 1) return one
  if (b > 1 && b < 5) return few
  return many
}

const swings = n => `${n} ${plural(n, 'удар', 'удара', 'ударов')}`

const TOOL_RU = {
  pickaxe: 'кирка', sword: 'меч', shovel: 'лопата', axe: 'топор', hoe: 'мотыга'
}

// Which intent was running when the autopilot butted in. Without it "выгребаюсь
// из gravel" and "мою лестницу засыпало на середине" read the same.
const during = e => (e.during ? ` (шло ${e.during})` : '')

export function fmtEvent (e) {
  switch (e.type) {
    case 'chat': return `${e.whisper ? 'шёпот' : 'чат'} от ${e.from}: «${e.text}»`
    case 'damage': return `получил урон ${e.lost}, осталось ${e.health} hp`
    case 'low_health': return `МАЛО ЗДОРОВЬЯ: ${e.health} hp`
    case 'death': return `УМЕР на ${fmtPos(e.pos)}`
    case 'player_joined': return `${e.username} зашёл на сервер`
    case 'player_left': return `${e.username} вышел`
    case 'player_near': return e.text || `${e.name} подошёл${typeof e.dist === 'number' ? ` на ${e.dist} бл.` : ''}`
    case 'player_gone': return `${e.name} отошёл${typeof e.dist === 'number' ? ` на ${e.dist} бл.` : ''}`
    case 'gesture': return e.text || `${e.name}: ${e.kind}`
    case 'friend_hurt': return e.text || `${e.by} бьёт ${e.name}`
    case 'summon': return e.text
    case 'director': return e.text
    case 'bag_full': return e.text
    case 'tossed': return `выкинул ${e.tossed.join(', ')}, чтобы поднять ${e.forItem}`
    case 'defended': return e.text
    case 'picked_up': return e.text
    case 'ate': return e.text || `поел ${e.item} (еда ${e.food})`
    case 'fleeing': return `УБЕГАЮ от ${e.from} на ${e.health} hp`
    // Аварийный отход автопилота (autopilot.emergency → survival.refuge).
    case 'emergency':
      return `АВАРИЯ: ${e.hp} hp при пороге ${e.threshold}, ${e.why}${during(e)} — ухожу в укрытие сам; ` +
        'пока «занят: refuge» — не мешай (mc_wait), потом повтори прерванное'
    case 'refuge': {
      const how = { box: 'коробка', hole: 'нора', pocket: 'карман', flee: 'бегство' }[e.how] || 'укрыться не вышло'
      return `отход (${how}) кончился: ${e.code || '?'}, хп ${e.hp0} → ${e.hp}${e.healed ? ', вылечился' : ''}, ${e.seconds} с` +
        (e.by ? ` (прервал ${e.by})` : '') + (e.note && !e.healed ? ` — ${e.note}` : '')
    }
    case 'provoked':
      return e.answer
        ? `${e.name} ударил (${e.hits}-й раз) — отвечаю`
        : `${e.name} ударил — стерпел (шанс ответа был ${Math.round(e.chance * 100)}%), второй удар не прощу`
    case 'retaliating': return `ДЕРУСЬ с ${e.name} — сам, без тебя`
    case 'loot_seen': return `вижу ${e.kind} на ${fmtPos(e.at)} (${e.why}) — не трогаю без тебя (mc_loot force:true)`
    case 'looting': return `иду лутать ${e.guess || e.kind} на ${fmtPos(e.at)}`
    case 'looted': {
      const took = e.took && Object.keys(e.took).length ? Object.entries(e.took).map(([k, v]) => `${k}×${v}`).join(', ') : 'пусто'
      return `залутал ${e.guess || 'сундук'}: ${took}${e.stopped ? ` (${e.stopped})` : ''}${e.error ? ` — ${e.error}` : ''}`
    }
    case 'shelter_patched':
      return `нору вскрывают${e.by ? ` (рядом ${e.by})` : ''} — ${e.roof ? 'потолок' : 'стенку'} заложил обратно, всего ${e.patched}`
    case 'shelter_open': return `НОРА ОТКРЫТА на ${fmtPos(e.at)}: заложить не смог (${e.why || 'нечем'})`
    case 'retaliated': {
      const t = e.tricks ? `, приёмы: ${Object.entries(e.tricks).map(([k, v]) => `${k}×${v}`).join(', ')}` : ''
      return `бой с ${e.name}: ${e.outcome}${e.hp ? `, хп ${e.hp}` : ''}, ударов ${e.swings ?? 0} (дошло ${e.landed ?? 0}, критов ${e.crits ?? 0})${t}${e.error ? ` — ${e.error}` : ''}`
    }
    case 'armor': return `надел ${e.equipped.join(', ')} (броня ${e.defense})`

    // Burial is four events, not one, because the brain has four different
    // answers to them. They used to arrive as raw JSON under the `default`
    // branch, which is where a fact goes to be ignored.
    case 'buried': return `ЗАДЫХАЮСЬ в ${e.block} на ${e.health} hp — откапываюсь${during(e)}`
    case 'digging_out': return `выгребаюсь из ${e.block}: вынул ${e.dug}, ${e.health} hp${during(e)} — сам справлюсь`
    case 'still_buried':
      return `ЗАПЕРТ: ${e.block} над головой не поддался (${e.why}), ${e.health} hp${during(e)} — сам не выйду`
    case 'freed':
      return e.byItself
        ? `завал кончился сам, ${e.health} hp${during(e)}`
        : `откопался, вынул ${e.dug}, ${e.health} hp${during(e)}`

    // The autopilot forges its own replacement tools out of what it dug. Both
    // halves matter: what it made, and what it refused to make and why.
    case 'tool':
      return `сам сделал ${e.made}: у ${TOOL_RU[e.kind] || e.kind} было ${e.was}, стало ${swings(e.left)}`
    case 'no_tool':
      return `НЕЧЕМ РАБОТАТЬ (${TOOL_RU[e.kind] || e.kind}): осталось ${swings(e.left)} — ${e.why}` +
        (e.retryInSeconds ? `; попытка ${e.attempt}, повторю через ${e.retryInSeconds}с` : '')

    case 'left_water': return 'выбрался из воды'
    case 'stuck_in_water': return 'ЗАСТРЯЛ В ВОДЕ и не выбрался сам'
    case 'dusk': return 'смеркается'
    case 'dawn': return 'рассвело'
    case 'kicked': return `кикнут: ${e.reason}`
    case 'disconnected': return `отключён: ${e.reason}`
    case 'error_event': return `ошибка: ${e.error}`
    case 'drank': return e.text || `выпил ${e.potion}`
    default: return `${e.type} ${JSON.stringify(e)}`
  }
}

// A player writing to us is the only thing in the whole event stream that is
// *waiting for an answer*, and until now it arrived as one more `· чат от ...`
// line at the very bottom, between «поел bread» and «рассвело». Measured: the
// daemon hands the same message over through two different fields depending on
// nothing the brain controls — `by` when an intent was running, `events` when
// it was not (session.js:299 vs :318) — and which answer it sticks to is a race
// between whoever calls next, because every answer drains the bus. So it is
// lifted here, out of both fields, to the second line of the answer.
//
// Keyed on the event type, not on the tool: mc_status, mc_say and mc_observe
// empty the bus exactly as mc_wait does, and a person left standing must not
// depend on which of them happened to answer first.
const MAX_SHOWN_CHATS = 8

export function chatLines (chats) {
  const out = []
  for (const e of chats.slice(0, MAX_SHOWN_CHATS)) {
    // The whisper flag is not decoration: answering in public chat something
    // that was said privately is a different act, the whole server reads it.
    out.push(e.whisper
      ? `‼ ШЁПОТ, лично тебе — ${e.from}: «${e.text}» (отвечать тоже лично: mc_say to="${e.from}")`
      : `‼ ИГРОК ПИШЕТ — ${e.from}: «${e.text}»`)
  }
  const rest = chats.length - MAX_SHOWN_CHATS
  if (rest > 0) {
    out.push(`‼ и ещё ${rest} ${plural(rest, 'сообщение', 'сообщения', 'сообщений')} от игроков`)
  }
  return out
}

// The daemon answers with a `detail` object, and render() used to print it as
// one flat JSON line. Readable, but the fields that decide the next move —
// why the work stopped early, a mob two blocks away, a pickaxe about to
// shatter — sat in the same blob as `torches: 3`, and the envelope above them
// still said `done`, because the intent did finish: it just finished early.
//
// One turn of the brain costs 10-30 seconds, so anything that can change the
// next decision gets its own line above the JSON. The JSON stays underneath
// as the machine copy — nothing is dropped, only promoted.
//
// Keyed on field names rather than tool names on purpose: the MCP side holds
// no state and knows nothing about intents, so a `stopped` grown by some
// future daemon module surfaces without a change here.
function highlights (d) {
  const out = []
  const say = s => { if (s) out.push(s) }

  // mc_stop answers with a boolean of the same name, hence the type check.
  const stopped = typeof d.stopped === 'string' ? d.stopped : null
  const note = typeof d.note === 'string' ? d.note : null
  // surface and recover compose a note that already quotes the stop reason word
  // for word; printing both would be the same sentence twice.
  if (stopped && note && note.includes(stopped)) say(`⚠ ${note}`)
  else if (stopped && note && stopped.includes(note)) say(`⚠ встал: ${stopped}`)
  else {
    if (stopped) say(`⚠ встал: ${stopped}`)
    if (note) say(`▸ ${note}`)
  }

  // Tool budget. The run that stranded the bot at y=-58 carried this number in
  // every answer it gave and nobody read it — `pickaxeLeft` had no reader at
  // all. The sum alone is still misleading (five swings of iron plus a fresh
  // stone pick is 136), so the breakdown is what gets printed.
  if (Array.isArray(d.pickaxes) && d.pickaxes.length) {
    const total = d.pickaxes.reduce((n, t) => n + (t.left || 0), 0)
    const low = total < 40 || d.pickaxes.some(t => t.left <= 10)
    say(`${low ? '⚠' : '▸'} кирки: ${d.pickaxes.map(t => `${t.name} ${t.left}`).join(' + ')} = ${swings(total)}`)
  } else if (typeof d.pickaxeLeft === 'number') {
    say(`${d.pickaxeLeft < 40 ? '⚠' : '▸'} кирка: ${swings(d.pickaxeLeft)}`)
  }
  if (d.pickaxe && typeof d.pickaxe.left === 'number') {
    const p = d.pickaxe
    const bits = [`осталось ${swings(p.left)}`]
    if (typeof p.leg === 'number') bits.push(`на пролёт ~${p.leg}`)
    if (typeof p.toTop === 'number') bits.push(`до верха ~${p.toTop}`)
    // The two numbers that differ are the whole point: this leg is paid for and
    // the climb out is not, so more pickaxe has to be arranged before the top.
    say(`${typeof p.toTop === 'number' && p.left < p.toTop ? '⚠' : '▸'} кирка: ${bits.join(', ')}`)
  }

  // tunnel already spells the mob out inside `stopped`; anything else that
  // grows a threat field does not, and a repeat is worse than a miss here.
  // Only tunnel ever tries to build a wall, and only tunnel sets `sealed`.
  // escort grows a threat of the same name — {mob, where, dist, at} — and never
  // places a block, so «закрыться НЕ вышло» there is a claim about work that did
  // not happen, and «место открытое» is a measurement escort never took.
  // Absent `sealed` means: a mob, and nothing about walls.
  const t = d.threat
  if (t && t.mob && !(stopped && stopped.includes(t.mob))) {
    const where = [t.where, typeof t.dist === 'number' ? `в ${t.dist} бл.` : null].filter(Boolean).join(' ')
    if (t.sealed === undefined) say(`⚠ ${t.mob} ${where}`)
    else if (t.sealed) {
      say(`⚠ ${t.mob} ${where} — заложился${t.wall ? ` на ${fmtPos(t.wall)}` : ''}${t.placed ? `, ${t.placed} бл.` : ''}, проход закрыт`)
    } else {
      say(`⚠ ${t.mob} ${where} — закрыться НЕ вышло; ` +
        (t.drift ? 'штрек 1×2, подойти он может только в лоб' : 'место открытое, обойти ему есть где'))
    }
  }

  // The machine-readable half of a stop: what to bring so the next call gets
  // further. Printed even when the sentence above says it in prose — this is
  // the line the brain can act on without parsing anything.
  if (d.need && d.need.what) {
    const n = d.need
    say(`▸ нужно: ${n.what}${n.count ? ` ×${n.count}` : ''}, в рюкзаке ${n.have ?? 0}` +
      (typeof n.swingsLeft === 'number' ? ` (кирки на ${swings(n.swingsLeft)})` : ''))
  }

  // «Успею или нет» is a comparison of two numbers the prose only implies.
  // The refusal note already quotes the same arithmetic; the line below is for
  // every other answer, where road is present and nothing says it out loud.
  const r = d.road
  if (r && typeof r.etaSeconds === 'number' && !(note && note.includes(`${r.etaSeconds}с`))) {
    const late = typeof r.leftSeconds === 'number' && r.etaSeconds > r.leftSeconds
    say(`${late ? '⚠' : '▸'} дорога: идти ${r.walk} бл. ~${r.walkSeconds}с` +
      (r.down ? `, вниз ${r.down} ур. ~${r.digSeconds}с` : '') +
      `, итого ~${r.etaSeconds}с` +
      (typeof r.leftSeconds === 'number' ? `; лут лежит ещё ${Math.max(0, r.leftSeconds)}с` : ''))
  }
  // recover measures this from the BODY (nearestHostile(bot, 8)) and reads it
  // even on a call that never reached the pile, so «у кучи» would be a claim
  // about a square the bot is not standing in.
  if (d.guard && d.guard.who) say(`⚠ рядом ${d.guard.who} в ${d.guard.dist} бл. — не трогал, решай сам`)

  // The whole reason a drift is dug. Two distances on purpose: fromHere is what
  // turning round costs now, fromMouth what coming back later down a corridor
  // that is already lit costs then.
  if (Array.isArray(d.ores)) {
    if (!d.ores.length) say('▸ руды в стенах не видно')
    else {
      // `nearest` is {x,y,z}: interpolated raw it renders as [object Object] —
      // and that is exactly the coordinate mc_mine_seen has to be called with.
      const shown = d.ores.slice(0, 4)
        .map(o => `${o.name}×${o.count} (${fmtPos(o.nearest)}: ${o.fromHere} отсюда, ${o.fromMouth} от устья)`)
      const rest = d.ores.length - shown.length
      say(`▸ руда в стенах: ${shown.join('; ')}${rest > 0 ? `; и ещё ${rest} видов` : ''}`)
    }
  }

  // Small facts that only matter when they are not zero, folded into one line
  // so a clean drift costs nothing to report.
  const facts = []
  if (d.remaining > 0) facts.push(`не пройдено ещё ${d.remaining} бл.`)
  if (d.aside > 0) facts.push(`отходил от опасного места ${d.aside} ${plural(d.aside, 'раз', 'раза', 'раз')}`)
  if (d.offAxis > 0) facts.push(`${d.offAxis} ${plural(d.offAxis, 'раз', 'раза', 'раз')} сносило с оси`)
  if (d.leftBehind > 0) facts.push(`брошено ${d.leftBehind} ${plural(d.leftBehind, 'куча', 'кучи', 'куч')} дропа`)
  if (d.lastTorch) facts.push(`последний факел ${fmtPos(d.lastTorch)}`)
  if (facts.length) say(`▸ ${facts.join('; ')}`)

  // Container answers. A full chest is a normal answer and not an error, but it
  // is also a decision — «нужен второй сундук» — and until now it lived only in
  // the JSON. `left` means the same thing in both directions: не переложено.
  if (d.left && typeof d.left === 'object' && !Array.isArray(d.left) && Object.keys(d.left).length) {
    // `left` is name -> REASON SENTENCE, not name -> count: depositPass and
    // withdrawPass write «сундук полон, 5 осталось при мне», «перенёс 3 из 10»,
    // «нет в инвентаре». The count is inside the sentence, and «×» in front of
    // it reads as arithmetic that is not there. `free` counts free slots in the
    // CHEST and says nothing about a take stopped by a full backpack.
    const what = Object.entries(d.left)
      .map(([k, v]) => (typeof v === 'number' ? `${k}×${v}` : `${k}: ${v}`))
      .join('; ')
    say(`⚠ не всё переложено — ${what}`)
  }

  // Езда (daemon/src/ride.js): какая лошадь, как шло приручение, сколько
  // проехал и сколько осталось — последнее и решает, звать ли тот же вызов.
  const h = d.horse
  if (h && h.kind && typeof h.tamed === 'boolean') {
    say(`▸ ${h.kind}: ${h.tamed ? 'приручена' : 'дикая'}, ${h.saddled ? 'под седлом' : 'без седла'}` +
      (h.blocksPerSecond ? `, ~${h.blocksPerSecond} бл/с` : '') +
      (h.jumpHeight ? `, прыжок ${h.jumpHeight} бл.` : ''))
  }
  if (d.tame && typeof d.tame.tries === 'number') {
    say(`▸ приручение: посадок ${d.tame.tries}, сбросила ${d.tame.bucked || 0}${d.tame.tamed ? ' — стерпела' : ''}`)
  }
  const rd = d.rode
  if (rd && typeof rd.seconds === 'number') {
    const left = typeof rd.left === 'number' && rd.left > 0 && !d.arrived
    say(`${left ? '⚠' : '▸'} в пути ${rd.seconds}с${rd.avgSpeed ? ` (~${rd.avgSpeed} бл/с)` : ''}` +
      (left ? `, до цели ещё ${rd.left} бл.` : '') + (rd.at ? `, встал ${fmtPos(rd.at)}` : ''))
  }

  if (Array.isArray(d.problems) && d.problems.length) {
    say(`▸ помехи: ${d.problems.slice(0, 2).join('; ')}` +
      (d.problems.length > 2 ? ` (и ещё ${d.problems.length - 2})` : ''))
  }

  // Готовые строки от модуля (enchant, brew, kit): уже с ⚠/▸, «что и зачем».
  // Дубль stopped/note не печатаем — они выше.
  if (ownLines(d)) {
    for (const l of d.lines.slice(0, 14)) if (l !== `⚠ встал: ${stopped}` && !out.includes(l)) say(l)
  }

  return out
}

// detail.lines — человеческие строки модуля; в JSON их второй раз не несём.
function ownLines (d) {
  return Array.isArray(d.lines) && d.lines.length > 0 && d.lines.every(l => typeof l === 'string' && /^[▸⚠]/.test(l))
}

// The preflight, and its marks follow the rule above:
//   ⚠ — set off without something only the brain can supply (torches, food, a
//       shield, a weapon) or could not put on what was in the bag. The intent
//       ran anyway; this is what changes the next decision.
//   ▸ — what was put on at the door, with its price in seconds, and the swaps
//       the server did not take. Facts, nothing to decide.
// `need` is printed the way detail.need is — what, how many, how many in the
// bag — and then the sentence, which carries the why and the next move.
export function gearLines (g) {
  const out = []
  for (const n of Array.isArray(g.need) ? g.need : []) {
    if (!n || !n.what) continue
    const numbers = typeof n.count === 'number'
      ? ` — нужно ${n.count}${n.unit ? ` ${n.unit}` : ''}, в рюкзаке ${n.have ?? 0}`
      : ''
    out.push(`⚠ снаряжение: ${n.what}${numbers}${n.why ? `; ${n.why}` : ''}`)
  }
  const did = Array.isArray(g.did) ? g.did : []
  const skipped = Array.isArray(g.skipped) ? g.skipped : []
  if (did.length || skipped.length) {
    const cost = typeof g.ms === 'number' && did.length ? ` (${Math.round(g.ms / 100) / 10}с)` : ''
    const bits = []
    if (did.length) bits.push(did.join('; '))
    if (skipped.length) bits.push(`не вышло: ${skipped.join('; ')}`)
    out.push(`▸ перед выходом${cost}: ${bits.join('; ')}`)
  }
  // A check that broke is said out loud: silence here would read as «всё на месте».
  if (g.error) out.push(`▸ снаряжение не проверил: ${g.error}`)
  return out
}

export function render (toolName, result) {
  // Both fields, deduplicated by seq: runIntent already strips `by` out of
  // `events` (session.js:300), but immediate() has no `by` at all, so the same
  // message legitimately arrives through either one — and printing a person
  // twice reads as two people.
  const events = Array.isArray(result.events) ? result.events : []
  const byChat = result.by && result.by.type === 'chat' ? [result.by] : []
  const seen = new Set()
  const chats = [...byChat, ...events.filter(e => e.type === 'chat')].filter(e => {
    if (e.seq === undefined) return true
    if (seen.has(e.seq)) return false
    seen.add(e.seq)
    return true
  })
  // Жесты людей (присел перед тобой, смотрит в упор, кинул вещь) — тот же
  // разговор, что чат, только телом, и человек так же ждёт ответа: наверх, к ‼.
  const byGesture = result.by && result.by.type === 'gesture' ? [result.by] : []
  const byFriend = result.by && result.by.type === 'friend_hurt' ? [result.by] : []
  const gests = [...byGesture, ...byFriend, ...events.filter(e => e.type === 'gesture' || e.type === 'friend_hurt')].filter(e => {
    if (e.seq === undefined) return true
    if (seen.has(e.seq)) return false
    seen.add(e.seq)
    return true
  })
  const other = events.filter(e => e.type !== 'chat' && e.type !== 'gesture' && e.type !== 'friend_hurt')

  const lines = [header(result.state)]
  for (const line of chatLines(chats)) lines.push(line)
  for (const e of gests.slice(0, 6)) {
    lines.push(e.type === 'friend_hurt'
      ? `‼ ДРУГА БЬЮТ — ${e.text}`
      : `‼ ЖЕСТ — ${e.text || `${e.name}: ${e.kind}`}`)
  }

  const status = result.status
  if (status) {
    let line = `${toolName}: ${status}`
    // The interrupt reason is still named, but not quoted a second time: the ‼
    // line above already carries the words, and a repeat is the noise that made
    // the original line easy to slide past.
    if (status === 'interrupted' && result.by) {
      line += result.by.type === 'chat'
        ? ' — прервано сообщением игрока (выше)'
        : result.by.type === 'gesture' || result.by.type === 'friend_hurt'
          ? ' — прервано: игрок рядом (выше)'
        : ` — прервано: ${fmtEvent(result.by)}`
    }
    if (status === 'failed') line += ` — ${result.error}`
    // «Не уложился» и «ничего не сделал» — разные вещи, и различать их надо в
    // той же строке, где стоит статус: интент, оборванный по времени, теперь
    // отдаёт то, что успел, и молчание об этом стоило бы мозгу второго похода
    // туда, где бот уже побывал.
    if (status === 'timeout') {
      line += ` — не уложился в ${result.afterSeconds}с`
      if (result.partial) line += ', но отчёт ниже — за то, что успел'
    }
    // «Оборвалось на пороге» and «оборвалось посреди работы» used to read as the
    // same bare interrupt. runIntent now says outright when the worker was never
    // entered (session.js notStarted), and that flag is what is printed — not
    // `error`: the grace also hands over whatever a worker threw on its way
    // out, and for a goto hit by a mob that is mineflayer-pathfinder's own
    // «The goal was changed before it could be completed!», which names a goal
    // nobody changed and was never shown to the brain before. Only without a
    // report: with one, the report is the better answer.
    if ((status === 'timeout' || status === 'interrupted') && result.notStarted && !result.partial) {
      line += ' — к работе не приступал: успел только проверить снаряжение'
    }
    lines.push(line)
  }

  // Before the action's own lines, because it happened before them: what the
  // body put on at the door and what it set off without (session.js runIntent,
  // daemon/src/preflight.js). A field of its own on the envelope, not a key in
  // detail — the action's `need` is a different sentence about a different
  // shortage and the two must never overwrite each other.
  const kit = result.gear
  if (kit && typeof kit === 'object') {
    for (const line of gearLines(kit)) lines.push(line)
  }

  const detail = result.detail
  if (detail && typeof detail === 'object' && Object.keys(detail).length) {
    // Human first, machine second.
    for (const line of highlights(detail)) lines.push(line)
    if (ownLines(detail)) {
      const { lines: _said, ...rest } = detail
      lines.push(JSON.stringify(rest))
    } else lines.push(JSON.stringify(detail))
  }
  // The machine copy of the lines above, kept apart from detail's for the same
  // reason the field is apart: one JSON per owner. Without `why`: those
  // sentences are already printed word for word in the ⚠ lines, run to a few
  // hundred characters each, and a drift called in a loop would pay for every
  // one of them twice per call. The numbers stay.
  if (kit && typeof kit === 'object') {
    const copy = { ...kit }
    // Same filter gearLines applies above: an entry that is not an object is
    // skipped, not destructured — a null in the list threw out of render() and
    // took the whole answer with it.
    if (Array.isArray(kit.need)) copy.need = kit.need.filter(n => n && typeof n === 'object').map(({ why, ...rest }) => rest)
    lines.push(JSON.stringify({ gear: copy }))
  }

  if (other.length) {
    lines.push('события:')
    for (const e of other) lines.push(`· ${fmtEvent(e)}`)
  }

  return lines.join('\n')
}
