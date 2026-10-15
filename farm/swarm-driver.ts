import { SwarmBoard, planPvp, planTransfers, addBlueprint, nextBuild, assessSwarmFight, mustFlee, groupOf, groupVerdict, ownedCount, canDigTrap } from '../daemon/src/swarm'
const { swarmBlueprint } = require('../daemon/src/swarm-work')
const WEAPON = /(_sword|_axe|_spear)$|^(mace|trident|bow|crossbow)$/
const BLOCK = /^(cobblestone|stone|dirt|smooth_sandstone|cut_sandstone|sandstone|sand|red_sand|netherrack|.*_planks)$/
const blockCount = (inv = {}) => Object.entries(inv).filter(([n]) => BLOCK.test(n)).reduce((s, [, c]: any) => s + c, 0)
const FOOD = /^(bread|cooked_.*|golden_apple|enchanted_golden_apple)$/
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const cellKey = p => `${p.x},${p.y},${p.z}`

// This adapter sees own bodies and allied reports; enemy daemon snapshots never enter the board.
// now — часы решений: в ffa это подменённый Date.now (игровое время при ускорении), в лаборатории — свои игровые часы.
export function createSwarmDriver({ bots, pos, alive, arena, home, hostile, log, arms = false, aggressive = false, hideouts = [], chestTops = [], perches = [], drops = () => [], announce = null, sandSpot = null, edgeOf = null, digSites = null, surfaceY = null, ladderSites = [], now = () => Date.now() }: any) {
  const boards = new Map<string, SwarmBoard>()
  // Ямы-ловушки раунда (dig): вскрытые клетки пола; край у врага — и обрыв модели, и своя дыра в 3.5 бл. от него.
  const holes: any[] = []
  // Подъём для команды (пользователь 14.10: «лестницу, по которой другие боты смогут залезать, ценнее одноразового столба»):
  // столбы, что построили лезущие (отрезок: вверх на 3+ почти на месте), — места под приставную лестницу (ladder_up);
  // готовые лестницы — общий путь наверх (строитель путей лезет по ним сам, и без своих блоков).
  // Стены под лестницы — из модели (watch.ts ladderSites), не из «столбов» лезущих (те не подтверждались: «стена кончилась»).
  const walls = new Map<string, any>(ladderSites.map(s => [s.key, { ...s }])), ladderRoutes: any[] = [], boxed = new Set<string>(), boxTries = new Map<string, number>()
  // Яма на его полу или ниже (не выше: пол 128 при ногах 126.5 засчитывался — Codex 15.10), в 3.5 бл.
  const edgeNear = p => {
    const gap = h => Math.hypot(h.x + .5 - p.x, h.z + .5 - p.z)
    const h = holes.filter(h => (h.feetY ?? h.y + 1) <= p.y + .1 && p.y - (h.feetY ?? h.y + 1) < 1.6 && gap(h) > .1 && gap(h) <= 3.5).sort((a, c) => gap(a) - gap(c))[0]
    if (!h) return edgeOf ? edgeOf(p) : null
    const d = gap(h)
    return { x: (h.x + .5 - p.x) / d, z: (h.z + .5 - p.z) / d }
  }
  const blueprints = new Map<string, any>()
  const transfers = new Map<string, any>()
  const planned = new Map<string, Map<string, any>>()
  const plannedAt = new Map<string, number>()
  const visited = new Map<string, Map<string, number>>()
  const cooldown = new Map<string, number>()
  const telemetry = { observed: 0, built: 0, dug: 0, transfers: 0, searches: 0 }
  let generation = 0
  let positionQueries = 0
  const teamOf = b => b.team || b.name
  const boardOf = b => {
    const team = teamOf(b)
    if (!boards.has(team)) boards.set(team, new SwarmBoard(team, () => now(), 8000))
    return boards.get(team)!
  }
  // Союзник в бою (свой fight, бой из уворота, враг вплотную) — не брать на обмен и ветер: assist/stop рвали его бой (Codex 15.10).
  const fighting = o => o.last?.m === 'fight' || o.swarmExecuting && /^(fight|flee)$/.test(o.swarmTask?.kind || '') ||
    !!pos[o.name]?.p && boardOf(o).enemies().some(e => now() - e.seenAt < 1000 && distance(e.position, pos[o.name].p) <= 3.5)
  const membersOf = b => {
    const roster = bots.filter(o => teamOf(o) === teamOf(b))
    const stock = roster.filter(a => alive(a.name)).flatMap(a => Object.keys(pos[a.name]?.inv || {}))
    // Номер в составе команды, а не среди живых: смерть одного не перетасовывает роли всех (ревью 13.10).
    return roster.filter(o => alive(o.name) && pos[o.name]?.p).map(o => member(o, roster.indexOf(o), stock, b))
  }
  const member = (o, k, stock, b) => {
    const m = pos[o.name], inv = m.inv || {}, names = Object.keys(inv)
    const heal = Object.entries(m.potions || {}).some(([n, c]: any) => /^splash_.*(healing|regeneration)$/.test(n) && c > 0)
    const role = heal && k % 3 === 1 ? 'healer' : names.some(n => /_pickaxe$/.test(n)) && k % 3 === 0 ? 'miner-builder' : inv.bow && inv.arrow && k % 2 ? 'ranged' : k % 3 === 2 ? 'flank' : 'fighter'
    const reserve: Record<string, number> = {}, needs: Record<string, number> = {}
    for (const n of names) reserve[n] = BLOCK.test(n) ? 16 : FOOD.test(n) ? 4 : WEAPON.test(n) || /_pickaxe$/.test(n) ? 1 : /potion|pearl|totem|wind_charge/.test(n) ? 1 : 0
    const melee = names.filter(n => /(_sword|_axe)$/.test(n))
    if (melee.length > 1) for (const n of melee.slice(1)) reserve[n] = 0
    if (!names.some(n => WEAPON.test(n))) { const weapon = stock.find(n => WEAPON.test(n)); if (weapon) needs[weapon] = 1 }
    for (const [slot, suffix] of Object.entries({ head: '_helmet', torso: '_chestplate', legs: '_leggings', feet: '_boots' })) {
      const spare = stock.find(n => n.endsWith(suffix))
      if (!m.armor?.[slot] && spare) needs[spare] = 1
      if (m.armor?.[slot]) for (const n of names.filter(n => n.endsWith(suffix))) reserve[n] = 0
    }
    if (inv.bow || inv.crossbow) needs.arrow = 16
    if (role === 'miner-builder') needs[[...blueprints].find(([key]) => key.startsWith(teamOf(b) + ':'))?.[1]?.material || 'cobblestone'] = 16
    if (m.hp < 16 && !names.some(n => FOOD.test(n))) needs.cooked_beef = 4
    // Подъём (пользователь 14.10: «залез наверх — бегают внизу, не строятся, не ищут кирку; блоков нет — делать всё, чтобы
    // добыть»): враг выше на 4+, а у меня оружие, но ни кирки, ни блоков на столб (высота + 4) — нужда в блоках (песок поля);
    // принесут передачи от добытчиков (планировщик, gather). Добытчик своё не держит — отдаёт всё.
    const up = aggressive ? Math.max(0, ...boardOf(o).enemies().filter(e => now() - e.seenAt < 15000).map(e => e.position.y - m.p.y)) : 0
    const blocks = names.filter(n => BLOCK.test(n)).reduce((s, n) => s + (inv[n] || 0), 0)
    if (up > 4 && names.some(n => WEAPON.test(n)) && !names.some(n => /_pickaxe$/.test(n)) && blocks < up + 4) needs.sand = Math.min(64, Math.ceil(up) + 6 - blocks + (inv.sand || 0))
    if ((o.gatherUntil || 0) > now()) for (const n of names) if (BLOCK.test(n)) reserve[n] = 0
    const worn = Object.values(m.armor || {}).filter(Boolean).length
    const strength = m.hp * (1 + (names.some(n => WEAPON.test(n)) ? 1 : 0)) * (1 + worn * .25)
    const weapon = names.find(n => /(_sword|_axe|_spear)$|^(mace|trident)$/.test(n))
    const ench = { sharpness: Math.max(0, ...(m.enchants || []).filter(it => it.name === weapon).map(it => it.ench?.sharpness || 0)), protection: (m.enchants || []).filter(it => it.slot >= 5 && it.slot <= 8).reduce((sum, it) => sum + (it.ench?.protection || 0), 0) }
    // Левая рука (щит, тотем) в рюкзак не входит: без неё надетый щит для доски «пропадал», и кольцо не строилось.
    const offHand = typeof m.offHand === 'string' ? m.offHand : m.offHand?.item || undefined
    if (offHand === 'shield') reserve.shield = 1
    // Заряды ветра — к булаве (пользователь 14.10: «грозу ветра сливают, просто стреляют в игрока ей, хотя надо с булавой
    // комбинировать»): у кого булава, тот свои держит и просит ещё — подброс и удар сверху; у прочих один — на выход из ямы.
    if (inv.mace) { reserve.wind_charge = inv.wind_charge || 0; needs.wind_charge = 8 }
    return { id: o.name, team: teamOf(o), position: m.p, health: m.hp, strength, role, canHeal: heal, inventory: inv, reserve, needs, armor: m.armor || {}, offHand, weapon, ench }
  }
  // seenAt — когда спросили (наблюдение не старше запроса статуса), без него — сейчас.
  const observe = (b, sightings, seenAt?: number) => {
    const board = boardOf(b), at = Number.isFinite(seenAt) ? Math.min(seenAt!, now()) : now()
    board.setMembers(membersOf(b))
    for (const e of sightings || []) if (hostile(b, e.id) && board.observe(b.name, at, e)) telemetry.observed++
    preempt(b)
  }
  const refresh = (b) => {
    const board = boardOf(b), team = teamOf(b), members = membersOf(b)
    for (const [key, blueprint] of blueprints) if (key.startsWith(team + ':') && blueprint.expiresAt && blueprint.expiresAt <= now()) {
      for (const t of board.tasks().filter(t => t.data?.blueprint === key.slice(team.length + 1))) board.cancel(t.id)
      blueprints.delete(key)
    }
    board.setMembers(members)
    if (now() - (plannedAt.get(team) || 0) >= 500 || !planned.has(team)) {
      const was = board.doctrineState()?.doctrine, held = board.teamFight?.engage, a0 = board.assault?.since, e0 = board.assaultEnded?.at
      // Дефицит блоков на подъём: нужды лезущих минус то, что у своих сверх запаса, — сколько добытчиков снять (gather).
      const need = members.reduce((s, a) => s + Object.entries(a.needs || {}).filter(([n]) => n === 'sand').reduce((t, [n, c]: any) => t + Math.max(0, c - (a.inventory?.[n] || 0)), 0), 0)
      const spare = members.reduce((s, a) => s + Object.entries(a.inventory || {}).filter(([n]) => n === 'sand' && !a.needs?.[n]).reduce((t, [n, c]: any) => t + Math.max(0, c - (a.reserve?.[n] ?? 16)), 0), 0)
      const gather = aggressive && sandSpot && need > spare ? { item: 'sand', deficit: need - spare, spot: sandSpot } : undefined
      planned.set(team, planPvp(board, members, { quorum: Math.min(2, Math.max(1, members.length)), doctrine: process.env.SWARM_DOCTRINE as any || undefined, aggressive, hideouts, perches, gather, edgeOf: edgeNear,
        // Лестницы — выключены, пока столбы берутся из перемещения, а не подтверждённой кладки (арена 36: «стена кончилась»,
        // крафт рвут рефлексы — трое ботов вне боя впустую). ARENA_LADDERS=1 — включить.
        ladderSites: process.env.ARENA_LADDERS === '0' ? [] : [...walls.values()].filter(t => !t.done && (t.retryAt || 0) <= now()),
        digSites: digSites ? p => digSites(p).filter(s => (cooldown.get('hole:' + cellKey(s)) || 0) <= now() && !holes.some(h => Math.abs(h.y - s.y) < 2 && Math.hypot(h.x - s.x, h.z - s.z) < 3)) : undefined, campSpots: aggressive ? hideouts.filter(s => (cooldown.get('camp:' + cellKey(s)) || 0) <= now()) : undefined }))
      const chosen = board.doctrineState()?.doctrine, fight = board.teamFight
      if (chosen && chosen !== was) { log(`🧭 ${team}: приём ${was || '—'} → ${chosen}`); say2(`🧭 приём: ${DOCTRINE_RU[chosen] || chosen}`, 'aqua', true) }
      // Штурм и отбой — в журнал и в чат (пользователь 14.10: «как рой показывает интеллект — не вижу»).
      const short = n => String(n).replace(/^NeuroFarm/, '')
      // Сперва итог старого штурма, потом старт нового: в одном плане старый истекает и сразу голосуют за новый — в чате
      // «окончен» шло следом за «ШТУРМ!» и читалось как конец только что начатого (разбор соседней сессии, 14.10).
      if (board.assaultEnded && board.assaultEnded.at !== e0) {
        const e = board.assaultEnded
        const text = e.why === 'проигрываем' ? `⚠ штурм на ${e.target} провален за ${e.seconds} с (потеряли ${e.lost}) — меняем тактику: отход в колизей, лут и лечение, новый штурм — когда станем сильнее` : `штурм на ${e.target} окончен: ${e.why === 'время вышло' ? `${e.seconds} с вышли` : e.why}, потеряли ${e.lost}`
        log(`☢ ${team}: ${text}`); say2(text, e.why === 'проигрываем' ? 'yellow' : 'gray')
      }
      if (board.assault && board.assault.since !== a0) {
        const a = board.assault
        log(`☢ ${team}: ШТУРМ на ${a.target} — подтвердили ${a.voters.length}: ${a.voters.map(short).join(', ')}`)
        say2(`☢ ШТУРМ на ${a.target}! подтвердили ${a.voters.length}: ${a.voters.slice(0, 6).map(short).join(', ')}${a.voters.length > 6 ? '…' : ''} — все до конца`, 'red')
      }
      if (fight && fight.engage !== held) log(`⚖ ${team}: бой ${fight.engage ? 'держим' : 'не держим'} — ${fight.ours} на ${fight.theirs}, потери ≈ ${fight.ourLoss.toFixed(1)} : ${fight.theirLoss.toFixed(1)}${fight.wipedUs && !fight.wipedThem ? ', нас выносят' : ''}`)
      transfers.set(team, planTransfers(board, members, (donor, recipient, item) => (cooldown.get(`transfer:${donor.id}:${recipient.id}:${item}`) || 0) <= now()))
      plannedAt.set(team, now())
    }
    return { board, members, member: members.find(m => m.id === b.name), task: planned.get(team)?.get(b.name) }
  }
  // Голос роя в чате игры (натиск): приёмы — не чаще раза в 5 с, штурм — всегда.
  const DOCTRINE_RU: Record<string, string> = { hunt: 'загон — строители режут путь, бойцы давят', wave: 'волна — ветром сбивают с высоты', buffalo: 'бизон — центр давит, фланги заходят сбоку', fountain: 'фонтан — рассыпаться от взрывов и сомкнуться' }
  let saidAt = 0
  const say2 = (text: string, color: string, throttled = false) => { if (!announce || throttled && now() - saidAt < 5000) return; saidAt = now(); Promise.resolve(announce(text, color)).catch(() => {}) }
  const say = (b, task) => {
    const identity = `${task.kind}:${task.data?.target || task.data?.ally || task.data?.blueprint || ''}:${task.data?.doctrine || ''}:${task.data?.camp || task.data?.dig || task.data?.gather || task.data?.ladder || ''}`
    if (b.swarmSaid === identity) return
    b.swarmSaid = identity
    if (task.data?.doctrine) b.swarmDoctrine = task.data.doctrine
    log(`🐜 ${b.name} [${task.data?.role || ''}/${task.data?.doctrine || ''}]: ${task.kind}${task.data?.target ? ' → ' + task.data.target : ''}${task.data?.ally ? ' для ' + task.data.ally : ''}${(task.data?.panic || task.data?.camp || task.data?.dig || task.data?.gather || task.data?.ladder || task.kind === 'loot') && task.data.reason ? ` (${task.data.reason})` : ''}`)
  }
  // Демон пускает цель похода, только если и сама точка, и центр её клетки с полушириной тела (0.3) лежат в r − 1:
  // прижим к r − 1 давал «outside arena bounds» и повтор каждые 200 мс у края (разбор 13.10) — прижимаем к r − 2.
  const bounded = at => ({ ...at, x: Math.max(arena.x - arena.r + 2, Math.min(arena.x + arena.r - 2, at.x)), z: Math.max(arena.z - arena.r + 2, Math.min(arena.z + arena.r - 2, at.z)) })
  // Лут слабого, а цель ближе к врагу, чем он сам, на 2+ бл. — в журнал с местом вызова (стенд rush 15.10: в 12 из 13 смен
  // «лут → бегство» дистанцию сократил сам лутающий).
  const lootStep = (b, at, tag?) => {
    const me = pos[b.name]?.p
    if (b.swarmTask?.kind !== 'loot' || !me || !at) return
    const foe = boardOf(b).enemies().filter(e => now() - e.seenAt < 3000).sort((a, c) => distance(a.position, me) - distance(c.position, me))[0]
    if (foe && distance(foe.position, at) < distance(foe.position, me) - 2) log(`🧭 ${b.name}: лут к врагу (${tag || String(new Error().stack?.split('\n')[3] || '').trim().replace(/^at (\S+).*?:(\d+):\d+\)?$/, '$1:$2')}): ${Math.round(distance(foe.position, me))} → ${Math.round(distance(foe.position, at))} бл.`)
  }
  // Цель ниже на 4+ (слез с крыши после сундуков наверху) — путь с копкой и блоками (climb): строго по поверхности с крыши вниз
  // не уйти, и бот стоял наверху — «стоит 8 с — goto — сброс» по кругу (галерея 15.10, 31ab).
  const weakLoot = b => !!b.swarmTask?.data?.weak || !Object.keys(pos[b.name]?.inv || {}).some(n => WEAPON.test(n))
  const lootArena = b => {
    const me = pos[b.name]?.p
    if (!me || !weakLoot(b)) return arena
    // Same remembered threats and 22-block clearance as weak chest selection; no hidden positions.
    const { r, foes } = lootThreat(b)
    const avoid = foes.map(e => ({ ...e.position, r: Math.min(r, distance(me, e.position)) }))
    return avoid.length ? { ...arena, avoid } : arena
  }
  // Слабый в задаче лута — любой поход (отход «прочь», поиск, обмен) с той же зоной обхода: отход из комнаты с сундуком
  // через дверь мимо врага давал «лут → бегство» (стенд rush 15.10, 3 из 3 оставшихся).
  const go = (b, at, range = 2, seconds = 4, pathArena = b.swarmTask?.kind === 'loot' ? lootArena(b) : arena) => {
    lootStep(b, at)
    const down =(pos[b.name]?.p?.y ?? at.y) - at.y > 4
    return b.c.call('goto', { ...bounded(at), range, timeoutSeconds: down ? Math.max(seconds, 10) : seconds, arena: pathArena, ...(down ? { climb: true } : {}), _hunt: true })
  }
  const buildGo = (b, at, range = .25) => b.c.call('goto', { ...at, range, timeoutSeconds: 4, surface: 'strict', arena, _hunt: true })
  const detail = r => r?.detail || r || {}
  const execute = async (b, method, params: any = {}) => {
    let r = await b.c.call(method, params)
    while (r?.status === 'pending' && r.token !== undefined && alive(b.name)) { await new Promise(resolve => setTimeout(resolve, 50)); r = await b.c.call('status', { token: r.token }) }
    return detail(r)
  }
  // Кемпер в коробке (тело: swarm_hold { camp: true }): враг виден — бой; ранен без врага (зелье сквозь стену) — выйти прочь от
  // стрелка и лечиться, засаду 15 с не занимать; дыру без врага тело латает само (Codex 15.10; пользователь: «что будет, если
  // зельями закидать его укрытие — как он спасаться будет»).
  const forgetCamp = b => { const key = `${b.name}:${b.boxedCamp}`; boxed.delete(key); boxTries.delete(key); b.boxedCamp = null; b.boxOutTries = 0 }
  async function reactCamp (b, r) {
    if (!b.boxedCamp) return false
    if (r.patched) log(`🧱 ${b.name}: залатал коробку (${r.patched} бл.)`)
    if (r.camp === 'fight') { log(`🧱 ${b.name}: коробку вскрыли — бью ${r.target}`); await b.c.call('fight', { target: r.target, allowPlayer: true, allowRanged: true, timeoutSeconds: 3, arena }); return true }
    if (r.camp === 'gone') { forgetCamp(b); return false }
    if (r.camp !== 'hurt') return false
    b.campReacting = true
    try {
      const camp = b.boxedCamp, round = generation
      const out = await execute(b, 'box_out', { away: r.away, timeoutSeconds: 24, _climb: true, arena })
      if (round !== generation || !alive(b.name)) return true
      log(`🧱 ${b.name}: урон в коробке ${camp}${r.away ? ' (летело с ' + [r.away.x, r.away.z].map(v => Math.round(v)).join(',') + ')' : ''} — ${out.left ? 'вышел' : out.why || 'не вышел'}`)
      if (!out.left) return true
      forgetCamp(b)
      cooldown.set(`camp:${camp}`, now() + 15000)
      plannedAt.delete(teamOf(b))
      delete b.campReacting
      const heal = await execute(b, 'assist', { mode: 'heal', at: out.at })
      if (round !== generation || !alive(b.name)) return true
      if (!heal.ok) {
        const s = await b.c.call('status', {})
        const inv = s?.state?.inventory || pos[b.name]?.inv
        const apple = ['enchanted_golden_apple', 'golden_apple'].find(n => (inv?.[n] || 0) > 0)
        const food = detail(await b.c.call('eat', apple ? { item: apple } : {}))
        log(`🩹 ${b.name}: ${food.ate || food.note || 'поесть не удалось'}`)
      } else log(`🩹 ${b.name}: лечение под ноги`)
      return true
    } finally { delete b.campReacting }
  }
  const release = (b, died = false) => { const board = boardOf(b); if (died && b.swarmDoctrine) board.noteTacticOutcome(b.name, b.swarmDoctrine, false); board.releaseOwner(b.name) }
  // Поставленное своими за раунд не копается никогда: чертёж истекает, а кокон, стенка и укрытие стоят (лаборатория 13.10:
  // строитель, потеряв цель из виду, разобрал свой же кокон как «ближайший камень»).
  const placed = new Map<string, any[]>()
  const ownProtection = board => [...board.tasks().filter(t => t.kind === 'build').map(t => t.position), ...[...blueprints.entries()].filter(([key]) => key.startsWith(board.team + ':')).flatMap(([, plan]) => plan.protected), ...(placed.get(board.team) || [])]
  const renew = (board, b, claim) => board.renew(claim.id, b.name, claim.claim.token, 25000)
  async function buildStep(b, context, request: any = {}) {
    // Пауза после отказа клетки — для всех путей стройки (31ao, выступ 15.10: «не к чему прислонить» 13 раз за 25 с по задаче build).
    if ((cooldown.get(`work:${b.name}`) || 0) > now()) return false
    const { board, member } = context, m = pos[b.name]
    let item = Object.keys(m.inv || {}).find(n => BLOCK.test(n) && m.inv[n] > 0)
    if (!item) return false
    const start = request.origin || home(b), kind = request.kind || 'shelter'
    const at = { x: Math.floor(start.x), y: Math.floor(request.origin?.y ?? m.p.y), z: Math.floor(start.z) }
    const id = request.id || (kind === 'shelter' ? 'shelter' : `${kind}:${cellKey(at)}`), project = board.team + ':' + id
    if (!blueprints.has(project)) {
      // Кокон и отсечка — на одну цель: новое место (цель ушла) отменяет старую стройку того же вида, иначе её клетки
      // держат доску до истечения и новый чертёж отклоняется как пересекающийся.
      if (kind === 'cocoon' || kind === 'cutoff') for (const [key, old] of [...blueprints]) if (key.startsWith(board.team + ':') && old.kind === kind) {
        for (const t of board.tasks().filter(t => t.kind === 'build' && t.data?.blueprint === key.slice(board.team.length + 1))) board.cancel(t.id)
        blueprints.delete(key)
      }
      const blueprint = request.cells ? { kind, origin: at, cells: request.cells, protected: request.protected || [] } : swarmBlueprint(kind, at, request.direction || 'north')
      if (arena && blueprint.cells.some(c => Math.abs(c.at.x + .5 - arena.x) + .3 >= arena.r || Math.abs(c.at.z + .5 - arena.z) + .3 >= arena.r || c.at.y <= (arena.killY ?? -64))) return false
      const total = new Map<string, number>()
      for (const own of context.members) for (const [name, count] of Object.entries(own.inventory) as [string, number][]) if (BLOCK.test(name)) total.set(name, (total.get(name) || 0) + count)
      item = [...total].sort((a, c) => c[1] - a[1])[0]?.[0] || item
      blueprint.material = item
      if (kind === 'cocoon' || kind === 'cutoff') blueprint.expiresAt = now() + 30000
      blueprints.set(project, blueprint)
      const cells = blueprint.cells.map(c => ({ id: cellKey(c.at), position: c.at, block: item }))
      const floorY = Math.min(...cells.map(c => c.position.y))
      const supported = new Set(cells.filter(c => c.position.y === floorY).map(c => c.id))
      while (supported.size < cells.length) {
        const c = cells.find(c => !supported.has(c.id) && cells.some(o => supported.has(o.id) && distance(o.position, c.position) === 1))
        if (!c) throw new Error('Blueprint has an unsupported component')
        const support = cells.find(o => supported.has(o.id) && distance(o.position, c.position) === 1)
        c.dependsOn = [support.id]; supported.add(c.id)
      }
      // Closing the roof early removes the jumping viewpoints needed for the far walls.
      const walls = cells.filter(c => c.position.y < at.y + 2).map(c => c.id)
      for (const c of cells.filter(c => c.position.y === at.y + 2)) c.dependsOn = [...new Set([...(c.dependsOn || []), ...walls])]
      // Кокон: ряд крыши над щелью — первым после стен. Щель и пустая клетка над ней — проём в два блока: на стенку под
      // щелью запрыгивают и выходят (лаборатория 13.10: цель ушла так, пока крыша над щелью ждала очереди 5 с).
      if (kind === 'cocoon') for (const slit of (blueprint.protected || []).filter(p => p.y === at.y + 1 && (Math.abs(p.x - at.x) === 1) !== (Math.abs(p.z - at.z) === 1)))
        for (const c of cells) if (c.position.y === at.y + 2 && (slit.x !== at.x ? c.position.x === slit.x : c.position.z === slit.z)) (c as any).priority = 75
      if (board.tasks().some(t => t.kind === 'build' && cells.some(c => cellKey(c.position) === cellKey(t.position)))) { blueprints.delete(project); return false }
      addBlueprint(board, { id, cells })
      log(`🏗 ${board.team}: общий план ${kind}, ${cells.length} клеток`)
    }
    // Стройка приёма жива, пока её ведут: срок продлевается каждым шагом, иначе через 30 с подтверждённые клетки
    // отменялись и крыша снова ждала стены (ревью 13.10).
    const own = blueprints.get(project)
    if (own?.expiresAt) own.expiresAt = Math.max(own.expiresAt, now() + 30000)
    let cell = nextBuild(board, member, 25000, request.kind ? id : undefined)
    if (!cell) return false
    const blueprint = blueprints.get(board.team + ':' + cell.data.blueprint)
    if (!blueprint) { board.release(cell.id, b.name, cell.claim.token); return false }
    try {
      if (blueprint.kind === 'outpost' && cell.position.y === blueprint.origin.y - 1) {
        const existing = detail(await b.c.call('swarm_pose', { at: cell.position, inspectOnly: true })).existing
        if (existing?.solid && existing.name !== cell.data.block && board.release(cell.id, b.name, cell.claim.token)) {
          board.upsert({ ...cell, data: { ...cell.data, block: existing.name } })
          cell = board.claim(cell.id, b.name, 25000)
          if (!cell) return false
        }
      }
      say(b, { ...cell, data: { ...cell.data, role: member.role } })
      if (distance(m.p, cell.position) > 4) { if (!renew(board, b, cell)) return false; await buildGo(b, cell.position, 3) }
      const actualItem = cell.data.block
      const params = { kind: 'place', at: cell.position, item: actualItem, allies: context.members.map(a => a.id), protected: blueprint.protected.filter(p => cellKey(p) !== cellKey(cell.position)), contained: request.contained || [], timeoutSeconds: 3 }
      if (!renew(board, b, cell)) return false
      let r = detail(await b.c.call('swarm_work', params))
      if (!r.done && (!r.aborted || r.why === 'direct_threat')) {
        let poses = detail(await b.c.call('swarm_pose', { at: cell.position })).poses || []
        if (!poses.length && !r.aborted) {
          const origin = blueprint.origin
          if (!renew(board, b, cell)) return false
          await buildGo(b, { x: origin.x + .5, y: origin.y, z: origin.z - 3 + .5 })
          poses = detail(await b.c.call('swarm_pose', { at: cell.position })).poses || []
        }
        const tried = new Set<string>()
        for (let attempt = 0; attempt < 4; attempt++) {
          const enemies = board.enemies()
          const clearance = p => Math.min(...enemies.map(e => distance(p, e.position)))
          // A threat abort permits a different, safer approach; the worker still decides whether work is safe.
          const at = poses.filter(p => !tried.has(cellKey(p)) && (!r.aborted || enemies.length && distance(p, m.p) > .4 && clearance(p) > clearance(m.p)))
            .sort((a, c) => (enemies.length ? clearance(c) - clearance(a) : 0) || distance(a, m.p) - distance(c, m.p))[0]
          if (!at) break
          tried.add(cellKey(at))
          if (!renew(board, b, cell)) return false
          const moved = await buildGo(b, at)
          poses = detail(await b.c.call('swarm_pose', { at: cell.position })).poses || []
          if (moved?.status === 'failed') continue
          const arrived = detail(moved).arrived
          if (arrived && [arrived.x, arrived.y, arrived.z].every(Number.isFinite)) m.p = { ...arrived }
          if (!renew(board, b, cell)) return false
          r = detail(await b.c.call('swarm_work', params))
          if (r.done || r.aborted && r.why !== 'direct_threat') break
        }
      }
      // Крыша кокона над целью и над щелью кладётся только сверху: грани соседних клеток крыши смотрят внутрь, с земли и в
      // прыжке их не видно («не к чему прислонить» — лаборатория 14.10, 21/23). Столб в 3 блока у угла кокона (по
      // диагонали: места у щелей держит оцепление) и кладка с его верха.
      if (!r.done && !r.aborted && blueprint.kind === 'cocoon' && cell.position.y === blueprint.origin.y + 2 && (cooldown.get(`roof:${b.name}`) || 0) <= now()) {
        cooldown.set(`roof:${b.name}`, now() + 15000)
        const o = blueprint.origin
        const corners = [[2, 2], [2, -2], [-2, 2], [-2, -2]].map(([dx, dz]) => ({ x: o.x + dx + .5, y: o.y, z: o.z + dz + .5 }))
          .sort((a, c) => distance(a, cell.position) - distance(c, cell.position))
        for (const base of corners) {
          if (!renew(board, b, cell)) return false
          const moved = await buildGo(b, base)
          if (moved?.status === 'failed') continue
          const up = detail(await b.c.call('swarm_pillar', { height: 3, item: actualItem, reserve: 0, arena, allies: context.members.map(a => a.id), timeoutSeconds: 12 }))
          if (!up.ok) { log(`🧱 ${b.name}: столб у кокона — ${up.why || 'не вышел'}`); continue }
          if (!renew(board, b, cell)) return false
          r = detail(await b.c.call('swarm_work', params))
          break
        }
      }
      if (r.done && r.at && cellKey(r.at) === cellKey(cell.position) && r.after === actualItem && board.ack(cell.id, b.name, { token: cell.claim.token, confirmed: true, position: r.at, block: r.after })) {
        telemetry.built++
        const own = placed.get(board.team) || []; own.push({ ...r.at }); placed.set(board.team, own)
        // Своя клетка — всей команде: бой её не прорубает (swarm_keep; «пробил его стенку» вскрывал кокон, 14.10).
        for (const o of bots) if (o !== b && teamOf(o) === board.team) Promise.resolve(o.c?.call('swarm_keep', { cells: [r.at] })).catch(() => {})
        log(`🧱 ${b.name}: ${cell.id} подтверждено`)
      } else {
        // A timed out worker must never reset a newer owner's claim.
        if (board.release(cell.id, b.name, cell.claim.token)) board.upsert({ ...cell, priority: (cell.priority || 60) - 1 })
        // Нет блока плана в рюкзаке («нет oak_planks» каждые 2 с, арена 40) — 15 с не браться: принесут передачи или возьмёт другой.
        // Клетка вне прорисовки (unloaded_cell — далеко) — тоже 15 с: каждые 2 с тот же отказ (крыша s28: 13 раз за 20 с).
        cooldown.set(`work:${b.name}`, now() + (/в инвентаре|unloaded_cell|occupied_cell|не к чему прислонить|нет видимой опоры/.test(r.why || '') ? 15000 : 2000)); log(`🧱 ${b.name}: ${r.why || 'клетка не подтверждена'}`)
      }
      return true
    } finally { if (cell) board.release(cell.id, b.name, cell.claim.token) }
  }
  async function mineStep(b, context, foe) {
    if ((cooldown.get(`mine:${b.name}`) || 0) > now()) return false
    cooldown.set(`mine:${b.name}`, now() + 3000)
    const m = pos[b.name], protectedCells = ownProtection(context.board)
    if (foe) await b.c.call('look_at', { ...foe.position, y: foe.position.y + 1 })
    for (const name of ['smooth_sandstone', 'cobblestone', 'stone', 'oak_planks']) {
      const seen = detail(await b.c.call('blocks_around', { find: name, seen: true, radius: 5, count: 12 })).found || []
      const candidate = seen.filter(q => q.y >= Math.floor(m.p.y) && !protectedCells.some(p => cellKey(p) === cellKey(q))).sort((a, c) => distance(a, m.p) - distance(c, m.p))[0]
      if (!candidate) continue
      const id = 'mine:' + cellKey(candidate)
      // Клетка снова занята блоком (её видно глазами) — старая выполненная задача не должна запрещать копку (ревью 13.10).
      if (context.board.tasks().some(t => t.id === id && t.status === 'done')) context.board.cancel(id)
      context.board.upsert({ id, kind: 'mine', position: { x: candidate.x, y: candidate.y, z: candidate.z } })
      const claim = context.board.claim(id, b.name, 10000)
      if (!claim) continue
      try {
        const r = detail(await b.c.call('swarm_work', { kind: 'dig', at: candidate, protected: protectedCells, allies: context.members.map(a => a.id), timeoutSeconds: 4 }))
        if (r.done && context.board.ack(id, b.name, { token: claim.claim.token, confirmed: true })) { telemetry.dug++; log(`⛏ ${b.name}: ${name} ${cellKey(candidate)} подтверждено`); await b.c.call('assist', { mode: 'pickup', maxD: 4, arena }).catch(() => {}) }
        return true
      } finally { context.board.release(id, b.name, claim.claim.token) }
    }
    return false
  }
  // Прокоп к цели (натиск, пользователь 14.10: «человек в укрытии — кирками раскопать и забивать, и все пройдут к нему»):
  // туннель прямо на неё (dig_to: лучший инструмент, ступени, свои блоки под ноги, стоп у лавы/воды).
  // Подъём к цели выше 3+ бл. (крыша, столб, ярус; пользователь 14.10: «залез наверх — тупят внизу, не строятся, не ищут
  // кирку; на элитрах не долетают»). По порядку: элитры (3+ ракеты) — на свой сектор у цели; жемчуг (в 40 бл.); блоки на
  // высоту или кирка — маршрут к месту: goto сам ставит столбы из блоков (ND_SCAFFOLD_ANY) и копает сквозь стену (замер
  // 14.10: с песка на крышу +28 за одну попытку, 11 блоков); нечем — копать песок/землю руками (16 бл. ≈ 15 с), пока не
  // принесли (нужды → передачи).
  // Динамит (пользователь 14.10: «динамитом взрывать — достать игрока или разнести колизей к чертям; договариваться в
  // команде»): tnt_at ставит и поджигает у точки; свои в 5 бл. от неё — не ставить; поджёг — в чат «все назад», на доске
  // факт tnt (4.5 с — фитиль 4 с): свои рядом отходят (turn), сам — на 7 бл. прочь.
  async function blast(b, at, why) {
    const inv = pos[b.name]?.inv || {}
    if (!inv.tnt || !(inv.flint_and_steel || inv.fire_charge) || (cooldown.get(`tnt:${b.name}`) || 0) > now()) return false
    if (bots.some(o => o !== b && teamOf(o) === teamOf(b) && alive(o.name) && pos[o.name]?.p && distance(pos[o.name].p, at) < 5)) return false
    // Один динамит у цели за раз (горящий в 6 бл. от точки — ждать).
    if (boardOf(b).facts().some(f => f.id.startsWith('tnt:') && f.position && distance(f.position, at) < 6)) return false
    cooldown.set(`tnt:${b.name}`, now() + 6000)
    const r = detail(await b.c.call('tnt_at', { at }).catch(e => ({ why: e.message })))
    log(`💣 ${b.name}: динамит ${why} — ${r.lit ? 'горит' : String(r.why || 'нет').slice(0, 60)}`)
    if (!r.lit || !r.placed) return false
    boardOf(b).recordFact(b.name, now(), { id: `tnt:${cellKey(r.placed)}`, kind: 'mark', position: r.placed }, 4500)
    say2(`💣 ${b.name.replace(/^NeuroFarm/, '')}: динамит ${why} — все назад!`, 'red')
    const me = pos[b.name].p, d = Math.hypot(me.x - r.placed.x, me.z - r.placed.z) || 1
    await go(b, { x: me.x + (me.x - r.placed.x) / d * 7, y: me.y, z: me.z + (me.z - r.placed.z) / d * 7 }, 1.5, 3)
    return true
  }
  // Вещи под ногами (пользователь 15.10: «бил деревянным мечом, а рядом трезубец лежал — отбежать, взять и мочить; постоянно
  // поглядывать на предметы на земле»): раз в 1.5 с — что лежит в 7 бл. (items_near: только что видно); лучше своего оружия
  // или брони в том же слоте, тотем, золотое яблоко, элитры — подбежать и взять (броню — надеть). В ближнем бою (враг в 3 бл.)
  // — только если вещь в 1.5 бл.
  const MAT = { wooden: 1, golden: 1.5, stone: 2, copper: 2.5, iron: 3, diamond: 4, netherite: 5 }
  const ARM = { leather: 1, golden: 1.5, chainmail: 2, copper: 2.5, iron: 3, diamond: 4, netherite: 5 }
  const weaponValue = n => n === 'mace' ? 5.5 : n === 'trident' ? 4.5 : /^(\w+)_(sword|axe|spear)$/.test(n) ? (MAT[n.split('_')[0]] || 0) : 0
  const armorOf = n => { const m = /^(\w+)_(helmet|chestplate|leggings|boots)$/.exec(n); return m ? { slot: { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' }[m[2]], v: ARM[m[1]] || 0 } : null }
  async function grab(b, enemies) {
    if (b.climbing || (cooldown.get(`grab:${b.name}`) || 0) > now()) return false
    cooldown.set(`grab:${b.name}`, now() + 1500)
    const m = pos[b.name], inv = m?.inv || {}
    if (!m?.p) return false
    const near = Math.min(Infinity, ...enemies.filter(e => now() - e.seenAt < 1500).map(e => distance(e.position, m.p)))
    const r = detail(await b.c.call('items_near', { radius: 7 }).catch(() => ({})))
    const best = Math.max(0, ...Object.keys(inv).map(weaponValue))
    const wear = slot => { const n = m.armor?.[slot]; const a = n && armorOf(n); return a ? a.v : 0 }
    const want = (r.items || []).find(it => {
      if (near < 5 && it.d > 1.5) return false
      if (b.swarmTask?.kind === 'loot' && it.at && !lootSafe(b, it.at, true)) return false
      if ((cooldown.get(`grab:${b.name}:${it.id ?? it.name + Math.round(it.at?.x) + Math.round(it.at?.z)}`) || 0) > now()) return false
      const a = armorOf(it.name)
      return weaponValue(it.name) > best + 0.4 || (a && a.v > wear(a.slot)) || /^(totem_of_undying|golden_apple|enchanted_golden_apple|elytra)$/.test(it.name) && !inv[it.name]
    })
    if (!want) return false
    // Пока бежит за вещью — b.climbing: прочие дела драйвера не рвут короткий забег («булава в 1.2 бл. — goal was changed»).
    const before = ownedCount({ inventory: inv, armor: m.armor }, want.name)
    let g: any = {}, s: any = null
    b.climbing = true
    lootStep(b, want.at, 'grab')
    try {
      const approach = await b.c.call('goto', { ...bounded(want.at), range: 0.4, timeoutSeconds: 3, arena: lootArena(b), _hunt: true, _climb: true }).catch(e => ({ why: e.message }))
      g = detail(approach)
      if (approach?.status === 'done' && g.arrived) {
        const pickup = detail(await b.c.call('assist', { mode: 'pickup', item: want.name, maxD: 2, arena: lootArena(b), _climb: true }).catch(e => ({ why: e.message })))
        if (!pickup.ok) g.why = pickup.why || 'не подобрал'
      }
      s = await b.c.call('status').catch(() => null)
    } finally { b.climbing = false }
    const got = !!s?.state && ownedCount(s.state, want.name) > before
    if (s?.state?.inventory) { pos[b.name].inv = s.state.inventory; pos[b.name].armor = s.state.armor || pos[b.name].armor }
    if (!got) cooldown.set(`grab:${b.name}:${want.id ?? want.name + Math.round(want.at?.x) + Math.round(want.at?.z)}`, now() + 30000)
    cooldown.set(`grab:${b.name}`, now() + 1500)
    log(`🫳 ${b.name}: беру ${want.name} в ${want.d} бл.${near < 20 ? ` (враг в ${Math.round(near)} бл.)` : ''} — ${got ? 'взял' : String(g.why || g.error || (g.arrived ? 'дошёл, не поднялось' : 'не дошёл')).slice(0, 40)}`)
    if (got && armorOf(want.name)) await b.c.call('armor', {}).catch(() => {})
    return got
  }
  async function climbTo(b, foe, at) {
    const m = pos[b.name], inv = m.inv || {}, dy = foe.position.y - m.p.y
    const blocks = Object.entries(inv).filter(([n]) => BLOCK.test(n)).reduce((s, [, c]: any) => s + c, 0)
    const pick = Object.keys(inv).some(n => /_pickaxe$/.test(n))
    // Он на столбе или уступе прямо над нами (по горизонтали ≤ 4, выше на 3–14): динамит под его опору — взрыв ломает
    // столб/песчаник, он падает к нам.
    if (dy <= 4 && Math.hypot(foe.position.x - m.p.x, foe.position.z - m.p.z) <= 4 && await blast(b, foe.position, `под ${foe.id}`)) return true
    if ((inv.elytra || m.armor?.torso === 'elytra') && (inv.firework_rocket || 0) >= 3 && (cooldown.get(`fly:${b.name}`) || 0) <= now()) {
      cooldown.set(`fly:${b.name}`, now() + 12000)
      const r = detail(await b.c.call('fly_to', { at, timeoutSeconds: 15, arena }).catch(e => ({ why: e.message })))
      log(`🪽 ${b.name}: лечу к ${foe.id} (+${Math.round(dy)}) — ${r.ok ? 'долетел' : String(r.why || 'нет').slice(0, 60)}`)
      if (r.ok) return true
    }
    // Жемчуг поднимается на 15–18 бл. (бросок 1.5 бл/т, гравитация 0.03): выше +16 — сперва лезть, бросать с яруса.
    if ((inv.ender_pearl || 0) > 0 && dy <= 16 && distance(m.p, foe.position) < 40 && (cooldown.get(`pearl:${b.name}`) || 0) <= now()) {
      cooldown.set(`pearl:${b.name}`, now() + 8000)
      const r = detail(await b.c.call('pearl_to', { to: at, edgeOk: true, yTop: 45 }).catch(e => ({ why: e.message })))
      log(`🟣 ${b.name}: жемчуг к ${foe.id} (+${Math.round(dy)}) — ${r.ok ? 'долетел' : (typeof r.why === 'object' ? JSON.stringify(r.why) : String(r.stop || r.why || 'нет')).slice(0, 80)}`)
      if (r.ok) return true
    }
    // Готовая лестница своих, верх которой у цели (в 8 бл.), — по ней: строитель путей лезет по ступеням сам, блоки не нужны.
    const lad = ladderRoutes.filter(l => l.top.y > m.p.y + .6 && l.top.y <= foe.position.y + 1 && l.base.y >= m.p.y - 1 && Math.hypot(l.top.x - foe.position.x, l.top.z - foe.position.z) < 12 && !(l.bad?.[b.name] > now()))
      .sort((a, c) => distance(m.p, a.base) - distance(m.p, c.base))[0]
    if (lad) {
      b.climbing = true
      const r = detail(await b.c.call('goto', { ...bounded(lad.top), range: 1, timeoutSeconds: 25, arena, _hunt: true, _climb: true }).catch(e => ({ why: e.message })).finally(() => { b.climbing = false }))
      if (!(r.arrived?.y >= lad.top.y - .5)) (lad.bad ||= {})[b.name] = now() + 20000
      log(`🪜 ${b.name}: по лестнице своих к ${foe.id} — ${r.arrived ? 'наверху' : String(r.why || r.error || 'нет').slice(0, 60)}`)
      return true
    }
    // Маршрут не нашёлся (отказ за доли секунды) — 5 с не повторять (иначе сотни попыток в минуту): с киркой — прокоп
    // ступенями к цели, без — добыча блоков ниже.
    const climbOk = (cooldown.get(`climb:${b.name}`) || 0) <= now()
    // Короткий столбик к нему (он рядом, выше на 2–3: край крыши) — блоков на высоту + 1; к далёкой цели — с запасом.
    const needBlocks = Math.hypot(foe.position.x - m.p.x, foe.position.z - m.p.z) < 4 && dy <= 4 ? Math.ceil(dy) + 1 : Math.min(dy + 4, 20)
    if ((blocks >= needBlocks || pick) && climbOk) {
      // Сектор у цели наверху бывает в воздухе (над рядами) — после отказа прямо к цели. Пока лезет — b.climbing: обмены, лут,
      // «прикрываю» и уворот от прицела его не дёргают (watch.ts, dangers.ts).
      const t0 = now(), goal = b.climbMiss ? foe.position : at, from = { ...m.p }
      // Отрезками по 8 бл. к цели (стенд 14.10: одним походом на +30 — «пути нет»; пешком с песка выше первого пояса не дойти):
      // короткий поиск со стройкой и прокопом дешёвый — стенку пояса перескочит столбиком, где пусто — столб.
      const span = distance(m.p, goal), k = Math.min(1, 8 / Math.max(span, 1))
      const wp = { x: m.p.x + (goal.x - m.p.x) * k, y: m.p.y + (goal.y - m.p.y) * k, z: m.p.z + (goal.z - m.p.z) * k }
      // Точка отрезка — на поверхность (ступень, проход), а не внутрь засыпки рядов на прямой.
      if (k < 1 && surfaceY) { const sy = surfaceY(wp.x, wp.z, goal.y); if (sy != null) wp.y = sy }
      // Последний отрезок — к нему самому (его пол точно есть), ровно на его высоту: сектор рядом бывает в стене коридора или
      // в воздухе у края крыши, и «дошёл» засчитывался внизу. Промежуточные — по поверхности модели (ступени, проходы) без
      // exactY: точка в воздухе на прямой заставляла строить столбы в коридоре с потолком (галерея: контакт 92 → 157 с).
      const last = k >= 1, dest = last ? foe.position : wp
      b.climbing = true
      const r = detail(await b.c.call('goto', { ...bounded(dest), range: 1.5, timeoutSeconds: 15, arena, climb: true, exactY: last, _hunt: true, _climb: true }).catch(e => ({ why: e.message })).finally(() => { b.climbing = false }))
      const failed = !r.arrived && (now() - t0 < 1500 || /no path|пути нет/i.test(String(r.why || r.error || r.stopped || '')))
      // Поднялся на 3+ почти на месте — построил столб: место под лестницу своим (ladder_up).
      const end = r.arrived || pos[b.name]?.p
      if (end && end.y - from.y >= 3 && Math.hypot(end.x - from.x, end.z - from.z) <= 1.5) {
        // (столбы лезущих больше не места лестниц — места из модели)
      }
      b.climbMiss = failed && !b.climbMiss
      // Точка вне арены — повтор той же точки бессмыслен: пауза сразу (31aj, выступ 15.10: 33 отказа «outside arena bounds» за 83 с).
      const boundary = /arena bounds/.test(String(r.why || r.error || ''))
      if (failed && (!b.climbMiss || boundary)) cooldown.set(`climb:${b.name}`, now() + 5000)
      if (boundary) log(`🧗 ${b.name}: точка подъёма вне арены — ${[dest.x, dest.y, dest.z].map(v => Math.round(v)).join(',')} (цель ${[foe.position.x, foe.position.y, foe.position.z].map(v => Math.round(v)).join(',')})`)
      // Пришёл, а выше не стал (на 1+ бл.) — 4 с без подъёма: бить/копать/ждать своих, а не тот же поход по кругу.
      const gain = (end?.y ?? from.y) - from.y
      if (!failed && gain < 1 && foe.position.y - (end?.y ?? from.y) > 3) cooldown.set(`climb:${b.name}`, now() + 4000)
      // В журнал — отказ и приход наверх (отрезки по 8 бл. — сотни строк за прогон).
      if (failed || k >= 1) log(`🧗 ${b.name}: лезу к ${foe.id} (+${Math.round(dy)}, блоков ${blocks}${pick ? ', кирка' : ''}) — ${r.arrived ? `дошёл, ${Math.round(r.arrived.y - foe.position.y)} по высоте от него` : String(r.why || r.stopped || r.error || (failed ? 'пути нет' : 'не дошёл')).slice(0, 60)}`)
      return true
    }
    if (pick && !climbOk && await breach(b, at)) return true
    if (blocks >= needBlocks) return false
    if ((cooldown.get(`dig:${b.name}`) || 0) > now()) return false
    cooldown.set(`dig:${b.name}`, now() + 3000)
    const r = detail(await b.c.call('mine', { block: 'sand,red_sand,dirt,grass_block,coarse_dirt', count: Math.min(32, Math.ceil(dy) + 6), radius: 32, timeoutSeconds: 20 }).catch(e => ({ why: e.message })))
    log(`🏖 ${b.name}: блоков на подъём нет — копаю руками (${foe.id} на +${Math.round(dy)}): ${r.dug ?? 0} шт.${r.why ? ` (${String(r.why).slice(0, 60)})` : ''}`)
    if (!r.dug) { cooldown.set(`dig:${b.name}`, now() + 12000); if (sandSpot && distance(m.p, sandSpot) > 12) { await go(b, sandSpot, 6, 8); return true } }
    return (r.dug || 0) > 0
  }
  async function breach(b, at) {
    if ((cooldown.get(`breach:${b.name}`) || 0) > now()) return false
    const me = pos[b.name]?.p, inv = pos[b.name]?.inv || {}
    if (me && !Object.keys(inv).some(n => /_pickaxe$/.test(n))) {
      const d = distance(me, at) || 1
      if (await blast(b, { x: me.x + (at.x - me.x) / d * 2, y: me.y, z: me.z + (at.z - me.z) / d * 2 }, 'в стену к цели')) return true
    }
    cooldown.set(`breach:${b.name}`, now() + 2000)
    const r = detail(await b.c.call('dig_to', { at: { x: at.x, y: at.y, z: at.z }, maxSteps: 6, timeoutSeconds: 8 }).catch(e => ({ why: e.message })))
    if (!r.dug) { cooldown.set(`breach:${b.name}`, now() + 8000); return false }
    log(`⛏ ${b.name}: прокапываюсь к цели — ${r.dug} бл.${r.ok ? ', дошёл' : r.why ? ` (${r.why})` : ''}`)
    return true
  }
  // Обход мест с сундуками (натиск): лут-задача, а сундуков не видно — к ближнему месту колизея с сундуками (камеры,
  // галереи, лаборатория, оружейная, комнаты), где свои не были 45 с и до врага не меньше 16 бл.; случайное прочёсывание
  // уводило голых прямо к человеку (14.10: «бегут к игроку без вещей»).
  const toured = new Map<string, Map<number, { by: string; at: number; done?: boolean }>>()
  // За ним идёт человек (враг в 14 бл., виден за 2 с) — не к сундукам и не в комнаты (пользователь 14.10: «лазают в пустые
  // сундуки в комнате, когда мы туда забежали бота убивать; не должны в замкнутые пространства бежать, когда игрок рядом»).
  const chased = (board, p) => !!p && board.enemies().some(e => now() - e.seenAt < 2000 && distance(e.position, p) < 14)
  // До врага — 22+ (слабый, убежав, берётся за лут с 22 бл.: лут ближе снова гнал к врагу — «лут ↔ бегство» каждые 3–7 с).
  // Место занимается при выходе (кто идёт — его, 45 с): рой разбегается по разным местам, а не все к ближнему (15.10,
  // пользователь: «на спавне кружатся — должны сразу разбегаться по карте»). Не дошёл и не сдвинулся — место ему плохое на
  // минуту (верхние ярусы пешком недостижимы: бот каждые 4 с шёл к тому же). Высота дороже расстояния.
  const tourBad = new Map<string, number>()
  // Цель лута и прямой путь к ней — не ближе к свежему врагу, чем радиус угрозы (голому и слабому 22, остальным 14), а если
  // бот уже ближе — не ближе, чем он сейчас (стенд rush 15.10: красный стоит, синий ходит маятником 25 → 14 → 25 бл. каждые
  // 5 с — цель за 22 бл. от него, а путь к ней мимо него; Codex 15.10: сундук, куча, подбор и обход выбирали цель каждый
  // по-своему, обход — только по ближнему врагу). Все свежие враги доски, а не один.
  const lootThreat = b => {
    const naked = !Object.keys(pos[b.name]?.inv || {}).some(n => WEAPON.test(n)) || !!b.swarmTask?.data?.weak
    return { r: naked ? 22 : 14, foes: boardOf(b).enemies().filter(e => now() - e.seenAt < (naked ? 10000 : 3000)) }
  }
  // Нет пути к цели в обход врага — не пробовать, пока обстановка та же: бот и каждый из свежих врагов на месте (в 2 бл.)
  // и врагов столько же. Не срок (пользователь 15.10: «отбежал на такую-то дистанцию — тогда меняй режим, а не по времени»).
  const blockedRoutes = new Map<string, any>()
  const sceneOf = b => ({ me: { ...pos[b.name].p }, foes: new Map(lootThreat(b).foes.map(e => [e.id, { ...e.position }])) })
  const sameScene = (b, s) => {
    const foes = lootThreat(b).foes
    return !!s && !!pos[b.name]?.p && distance(pos[b.name].p, s.me) < 2 && foes.length === s.foes.size && foes.every(e => s.foes.has(e.id) && distance(e.position, s.foes.get(e.id)) < 2)
  }
  const lootSafe = (b, at, allowDetour = false) => {
    const me = pos[b.name]?.p
    if (!me || !at) return false
    const { r, foes } = lootThreat(b)
    const dx = at.x - me.x, dz = at.z - me.z, len = dx * dx + dz * dz || 1
    return foes.every(e => {
      const t = Math.max(0, Math.min(1, ((e.position.x - me.x) * dx + (e.position.z - me.z) * dz) / len))
      const pass = Math.hypot(me.x + dx * t - e.position.x, me.z + dz * t - e.position.z)
      // Weak loot uses a bounded A* detour; transfers and ready looters keep their straight-route guard.
      return distance(at, e.position) >= r && (allowDetour && weakLoot(b) || pass >= Math.min(r, Math.hypot(me.x - e.position.x, me.z - e.position.z)) - .5)
    })
  }
  async function tour(b, board) {
    const marks = toured.get(teamOf(b)) || new Map<number, { by: string; at: number; done?: boolean }>(); toured.set(teamOf(b), marks)
    const me = pos[b.name]?.p; if (!me || !hideouts.length || chased(board, me)) return false
    const foes = board.enemies().filter(e => now() - e.seenAt < 10000)
    // Сундуки крыши и венца (climbFrom — докуда пешком) — тому, у кого блоков на столб оттуда; подъём не штрафуется ×4.
    const blocks = blockCount(pos[b.name]?.inv || {})
    // Уже наверху — блоки не нужны (Codex 15.10: на крыше без запаса цель исключалась).
    const need = h => h.climbFrom === undefined || me.y >= h.y - 1 ? 0 : Math.max(0, h.y - Math.max(me.y, h.climbFrom)) + 3
    // Голый или слабый при свежем враге ближе 22 — не наверх (подъём долгий, стоп не прервёт его до 6 бл.; Codex 15.10).
    const naked = !Object.keys(pos[b.name]?.inv || {}).some(n => WEAPON.test(n)) || !!b.swarmTask?.data?.weak
    const exposed = naked && foes.some(e => now() - e.seenAt < 3000 && distance(e.position, me) < 22)
    // Цена — путь, делённый на ярус (лучший лут наверху; Codex 15.10: верхний был 21-м в очереди).
    const cost = h => (distance(h, me) + (h.climbFrom === undefined ? 4 * Math.max(0, h.y - me.y - 1) : Math.max(0, h.y - me.y))) / (1 + (h.tier || 0))
    const options = [...hideouts, ...chestTops].map((h, k) => ({ h, k, mark: marks.get(k) }))
      .filter(({ h, k, mark }) => blocks >= need(h) && !(h.climbFrom !== undefined && (exposed || (cooldown.get(`tourUp:${b.name}`) || 0) > now())) && (!mark || mark.by === b.name && !mark.done || now() - mark.at > 45000) && !((tourBad.get(`${b.name}:${k}`) || 0) > now()) && foes.every(e => distance(e.position, h) >= 22) && lootSafe(b, h, true))
      // Своя незавершённая цель — только при равной цене: после бегства старая (в 40 бл. за врагом) вела назад (Codex 15.10).
      .sort((a, c) => cost(a.h) - cost(c.h) || Number(c.mark?.by === b.name && !c.mark?.done) - Number(a.mark?.by === b.name && !a.mark?.done))
    const pick = options[0]; if (!pick) return false
    // Дошёл — и на высоте места (сундук венца с крыши в 3 бл. ниже засчитывался «дошёл», а не виден; Codex 15.10).
    if (distance(pick.h, me) < 4 && me.y >= pick.h.y - 1) { marks.set(pick.k, { by: b.name, at: now(), done: true }); return false }
    if (pick.mark?.by !== b.name || pick.mark?.done) marks.set(pick.k, { by: b.name, at: now() })
    const from = { ...me }
    let approach
    if (pick.h.climbFrom !== undefined && pick.h.y - me.y > 1) {
      b.climbing = true
      const r = detail(await b.c.call('goto', { ...bounded(pick.h), range: 1, timeoutSeconds: 20, arena: lootArena(b), climb: true, exactY: true, _hunt: true, _climb: true }).catch(e => ({ why: e.message })).finally(() => { b.climbing = false }))
      log(`🧰 ${b.name}: к сундукам наверху (+${Math.round(pick.h.y - me.y)}, блоков ${blocks}) — ${r.arrived ? 'дошёл' : String(r.why || r.stopped || 'не дошёл').slice(0, 60)}`)
      // Не поднялся — минуту ни к каким верхним (31aj: перебирал 12 сундуков крыши по очереди, 10 отказов за 51 с).
      approach = r
      const up = (pos[b.name]?.p?.y ?? me.y) - me.y
      if (!r.arrived && up < 2) cooldown.set(`tourUp:${b.name}`, now() + 60000)
    } else approach = detail(await go(b, pick.h, 2, 6, lootArena(b)).catch(e => ({ why: e.message })))
    const end = pos[b.name]?.p
    if (end && distance(end, pick.h) < 4 && end.y >= pick.h.y - 1) marks.set(pick.k, { by: b.name, at: now(), done: true })
    // Не приблизился (стоял или ушёл вбок) — место ему плохое на минуту (Codex 15.10: «вбок на 3 бл.» держало приоритет навсегда).
    else if (!approach.arrived || !end || distance(end, pick.h) >= distance(from, pick.h) - 1) { tourBad.set(`${b.name}:${pick.k}`, now() + 60000); marks.delete(pick.k) }
    return true
  }
  // Сундук, взятый дочиста или найденный пустым, пуст, пока арена его не пополнила (refill — уведомление из arena/loot.ts),
  // а не «через минуту снова» (пользователь 14.10: «лазают в пустые сундуки»; 15.10: режим — по событию мира, не по часам).
  // Остаток, который не влез в рюкзак, этому боту не повторять, пока рюкзак не изменился.
  const emptyChests = new Set<string>(), fullFor = new Map<string, string>()
  const packOf = b => JSON.stringify(pos[b.name]?.inv || {})
  const refill = at => { emptyChests.delete('chest:' + cellKey(at)) }
  // Сундук под рукой (5 бл., тот же ярус): известный — верхние места колизея и виденные лутом; не пустой по нашему знанию и
  // не отказавший этому боту на том же месте. Его берут раньше любого приказа (пользователь 16.10: «залез наверх, а
  // незеритовые вещи не взял» — бой пришёл в ту же секунду, бот слез и дрался в слабом).
  const knownChests = new Map<string, any>()
  const chestAtHand = b => {
    const me = pos[b.name]?.p
    if (!me) return false
    const tops = chestTops.map(c => { const at = { x: Math.floor(c.x), y: Math.floor(c.y), z: Math.floor(c.z) }; return ['chest:' + cellKey(at), at] })
    return [...knownChests.entries(), ...tops].some(([id, at]) => Math.abs(at.y - me.y) < 3 && Math.hypot(at.x + .5 - me.x, at.z + .5 - me.z) < 5 &&
      !emptyChests.has(id) && fullFor.get(`${b.name}:${id}`) !== packOf(b) && !sameScene(b, blockedRoutes.get(`lootPath:${b.name}:${id}`)))
  }
  async function loot(b, board, atHand = false) {
    // Под рукой — без паузы опроса: пауза 4 с от прошлого похода отпускала бота к приказу мимо сундука.
    if (!arms || !atHand && (cooldown.get(`loot:${b.name}`) || 0) > now() || chased(board, pos[b.name]?.p)) return false
    cooldown.set(`loot:${b.name}`, now() + 4000)
    const chests = detail(await b.c.call('blocks_around', { find: 'chest', seen: true, radius: 16, count: 8 })).found || []
    for (const at of chests) knownChests.set('chest:' + cellKey(at), at)
    // Угроза дороже лута (пользователь 14.10: «подбегают лутаться, даже если я рядом; у кого ничего нет — тем более»): голому
    // — сундук не ближе 20 бл. к врагу (видели за 10 с), остальным — 14 (за 3 с).
    // Слабый (лут из бегства) — как голый: сундук у врага ближе 22 бл. снова гнал к нему («лут ↔ бегство», поле s12).
    const naked = !Object.keys(pos[b.name]?.inv || {}).some(n => WEAPON.test(n)) || !!b.swarmTask?.data?.weak
    const risky = at => Math.abs(at.x + .5 - arena.x) + .3 >= arena.r || Math.abs(at.z + .5 - arena.z) + .3 >= arena.r || at.y <= (arena.killY ?? -64) || board.enemies().some(e => now() - e.seenAt < (naked ? 10000 : 3000) && distance(e.position, at) < (naked ? 22 : 14))
    for (const at of chests) {
      if (risky(at) || !lootSafe(b, { x: at.x + .5, y: at.y, z: at.z + .5 }, true)) continue
      const id = 'chest:' + cellKey(at), routeKey = `lootPath:${b.name}:${id}`
      if (emptyChests.has(id) || fullFor.get(`${b.name}:${id}`) === packOf(b) || sameScene(b, blockedRoutes.get(routeKey))) continue
      board.upsert({ id, kind: 'scout', position: { x: at.x, y: at.y, z: at.z }, data: { loot: true } })
      const claim = board.claim(id, b.name, 15000)
      if (!claim) continue
      try {
        if (distance(pos[b.name].p, at) > 3) {
          if (!renew(board, b, claim)) return false
          const approach = await go(b, at, 2, 4, lootArena(b)).catch(() => null)
          if (approach?.status !== 'done' || !detail(approach).arrived) { blockedRoutes.set(routeKey, sceneOf(b)); continue }
        }
        if (!renew(board, b, claim)) return false
        const r = await b.c.call('chest_take', { item: 'all', x: at.x, y: at.y, z: at.z, timeoutSeconds: 8, visibleOnly: true, stay: true })
        const d = detail(r), moved = Object.values(d.took || d.moved || {}).reduce((s: number, n: any) => s + (Number(n) || 0), 0)
        if (Number(moved) > 0 || d.at && d.contents) board.ack(id, b.name, { token: claim.claim.token, confirmed: true })
        if (d.contents && !Object.keys(d.contents).length) emptyChests.add(id)
        else if (!Number(moved) && d.contents) fullFor.set(`${b.name}:${id}`, packOf(b))
        // Не открылся (не виден, не дотянулся) — этому боту отказ, пока он и враги на том же месте.
        else if (!d.contents) blockedRoutes.set(routeKey, sceneOf(b))
        if (Number(moved) > 0) { await b.c.call('armor'); log(`🧰 ${b.name}: ${id} +${moved}`) }
        return Number(moved) > 0
      } finally { board.release(id, b.name, claim.claim.token) }
    }
    // Вещи погибших (пользователь 14.10: «остаются бомжи без предметов в конце игры, хотя их много валяется — им надо
    // лутаться; в итоге мы на спавне их легко убили»): куча — где умер боец (последняя позиция, drops), живёт 5 мин
    // (предмет исчезает), к ней идёт один; подбор с земли по вещи, пока видно, потом надеть лучшее.
    const me = pos[b.name]?.p
    // Погибший в падении за край (последняя позиция в 3 бл. над смертельной высотой) вещей не оставил: они ушли вниз с ним.
    const pile = me && drops().filter(d => d.p && now() - d.at < 280000 && (d.retryAt ?? 0) <= now() && distance(d.p, me) < 48 && d.p.y > (arena.killY ?? -64) + 3 && !risky({ x: Math.floor(d.p.x), y: Math.floor(d.p.y), z: Math.floor(d.p.z) }) && lootSafe(b, d.p, true))
      .sort((p, q) => distance(p.p, me) - distance(q.p, me))[0]
    if (!pile) return false
    pile.retryAt = Infinity // одна попытка может длиться дольше 30 с
    try {
      if (distance(me, pile.p) > 2) {
        const approach = await go(b, pile.p, 1, 8, lootArena(b)).catch(() => null)
        if (approach?.status !== 'done' || !detail(approach).arrived) return false
      }
      let got = 0
      for (let k = 0; k < 8 && alive(b.name) && !chased(board, pos[b.name]?.p); k++) { const r = detail(await b.c.call('assist', { mode: 'pickup', maxD: 6, arena: lootArena(b) }).catch(() => ({}))); if (!r.ok) break; got++ }
      if (got) await b.c.call('armor').catch(() => {})
      log(`🪦 ${b.name}: вещи погибшего у ${cellKey({ x: Math.floor(pile.p.x), y: Math.floor(pile.p.y), z: Math.floor(pile.p.z) })} — ${got ? `подобрал ${got}` : 'пусто'}`)
      return got > 0
    } finally { pile.retryAt = now() + 30000 }
  }
  async function transfer(b, context) {
    const task = (transfers.get(teamOf(b)) || []).find(t => t.assignedTo === b.name && t.status !== 'done')
    if (!task || (cooldown.get(task.id) || 0) > now()) return false
    const recipient = bots.find(o => o.name === task.data.recipient)
    // Получатель в бою или бегстве — не выдёргивать его подбором (ревью 13.10): обмен подождёт.
    if (!recipient || fighting(recipient)) return false
    if (recipient.swarmReserved) return false
    if (b.swarmTask?.kind === 'loot' && b.swarmTask.data?.weak && pos[recipient.name]?.p && !lootSafe(b, pos[recipient.name].p)) return false
    const claim = context.board.claim(task.id, b.name, 15000)
    if (!claim) return false
    let ok = false
    // Получатель стоит, пока донор подходит и бросает (как напарник парного ветра): он уходил по своему делу, и бросок
    // был «далеко» или мимо — передач подтверждено 3 из 121 (соло-арена 14.10).
    try {
      if (distance(pos[b.name].p, pos[recipient.name].p) > 2.5) await go(b, pos[recipient.name].p, 1.5)
      // Бросок — только с 3 бл. (tossTo): дальше получателя не останавливать (Codex 15.10: 36 отказов «далеко 5.0»).
      if (distance(pos[b.name].p, pos[recipient.name].p) > 3) return false
      if (fighting(recipient)) return false
      recipient.swarmReserved = true
      await recipient.c.call('stop').catch(() => {})
      for (const until = now() + 3000; recipient.swarmExecuting && now() < until;) await new Promise(resolve => setTimeout(resolve, 50))
      if (recipient.swarmExecuting) return false
      const fresh = await Promise.all([b.c.call('status'), recipient.c.call('status')])
      const before = ownedCount(fresh[1]?.state || {}, task.data.item)
      const have = fresh[0]?.state?.inventory?.[task.data.item] || 0
      if (have - task.data.reserve < task.data.count) return false
      if (distance(pos[b.name].p, pos[recipient.name].p) > 3) return false
      if (!renew(context.board, b, claim)) return false
      const r = detail(await b.c.call('assist', { mode: 'toss', ally: recipient.name, item: task.data.item, count: task.data.count, arena }))
      const pu = r.ok && !fighting(recipient) ? detail(await recipient.c.call('assist', { mode: 'pickup', item: task.data.item, arena }).catch(e => ({ why: e.message }))) : null
      const result = await recipient.c.call('status')
      const received = ownedCount(result?.state || {}, task.data.item) - before >= task.data.count
      if (result?.state?.inventory && pos[recipient.name]) pos[recipient.name].inv = result.state.inventory
      if (result?.state?.armor && pos[recipient.name]) pos[recipient.name].armor = result.state.armor
      const donor = await b.c.call('status')
      if (donor?.state?.inventory && pos[b.name]) pos[b.name].inv = donor.state.inventory
      if (donor?.state?.armor && pos[b.name]) pos[b.name].armor = donor.state.armor
      if (received && context.board.ack(task.id, b.name, { token: claim.claim.token, confirmed: true })) telemetry.transfers++
      log(`📦 ${b.name} → ${recipient.name}: ${task.data.item}×${task.data.count}, ${received ? 'получено' : 'не подтверждено'}${received ? '' : ` (${r.ok ? `бросил, не подобрал: ${pu?.why || '?'}` : r.why || r.error || '?'})`}`)
      ok = received
      return true
    } finally {
      // Не вышло (не дошёл, далеко, не подобрал) — эта пара 30 с отдыхает (Codex 15.10: 40 отказов «далеко 5.0» за 3 мин).
      cooldown.set(task.id, now() + (ok ? 4000 : 30000))
      delete recipient.swarmReserved; context.board.release(task.id, b.name, claim.claim.token)
    }
  }
  async function search(b, context) {
    const team = teamOf(b), marks = visited.get(team) || new Map()
    visited.set(team, marks)
    const m = pos[b.name], index = context.members.findIndex(o => o.id === b.name)
    const candidates = []
    for (let k = 0; k < 8; k++) {
      const a = (k + index) * Math.PI / 4, r = 8
      const at = { x: Math.max(arena.x - arena.r + 3, Math.min(arena.x + arena.r - 3, m.p.x + Math.cos(a) * r)), y: m.p.y, z: Math.max(arena.z - arena.r + 3, Math.min(arena.z + arena.r - 3, m.p.z + Math.sin(a) * r)) }
      const key = `${Math.round(at.x / 4)},${Math.round(at.z / 4)}`
      if (distance(at, m.p) < 3) continue
      candidates.push({ at, key, seen: marks.get(key) || 0 })
    }
    const chosen = candidates.sort((a, c) => a.seen - c.seen)[0]
    if (!chosen) return
    marks.set(chosen.key, now())
    if (marks.size > 256) marks.delete(marks.keys().next().value)
    telemetry.searches++
    await go(b, chosen.at, 2)
  }
  async function pairedWind(b, context, at) {
    const { board } = context, m = pos[b.name]
    const thrower = bots.filter(o => o.name !== b.name && teamOf(o) === teamOf(b) && alive(o.name) && !o.swarmReserved && (pos[o.name]?.inv?.wind_charge || 0) > 0 && distance(pos[o.name].p, m.p) < 5 && !panic(o) &&
      !fighting(o)).sort((a, c) => distance(pos[a.name].p, m.p) - distance(pos[c.name].p, m.p))[0]
    if (!thrower) return false
    const id = `wind-pair:${b.name}`
    board.upsert({ id, kind: 'goto', assignedTo: b.name, participants: [b.name, thrower.name], position: at, expiresAt: now() + 20000 })
    const claim = board.claim(id, b.name, 20000)
    if (!claim) return false
    thrower.swarmReserved = true
    try {
      await thrower.c.call('stop')
      const until = now() + 5000
      while (thrower.swarmExecuting && now() < until) await new Promise(resolve => setTimeout(resolve, 50))
      if (thrower.swarmExecuting || !renew(board, b, claim)) return false
      const own = await thrower.c.call('status', { physics: true }), physics = own?.detail?.physics
      if (!physics?.onGround) return false
      const report = { id: thrower.name, position: physics.pos, velocity: physics.velocity, onGround: physics.onGround, attributes: physics.attributes }
      const dry = await execute(b, 'wind_receive', { thrower: report, to: at, arena, dryRun: true })
      if (!dry.plan || fighting(thrower) || !renew(board, b, claim)) return false
      const ready = await execute(thrower, 'wind_boost', { ally: b.name, plan: dry.plan, arena, dryRun: true })
      if (!ready.ok || fighting(thrower) || !Number.isFinite(dry.gameTick) || !Number.isFinite(ready.gameTick)) return false
      const startTick = Math.max(dry.gameTick, ready.gameTick) + 40
      const [receive, boost] = await Promise.all([
        execute(b, 'wind_receive', { thrower: report, to: at, plan: dry.plan, arena, startTick }),
        execute(thrower, 'wind_boost', { ally: b.name, plan: dry.plan, arena, startTick })
      ])
      const ok = !!receive.ok && !!boost.ok
      board.ack(id, b.name, { token: claim.claim.token, confirmed: ok })
      if (ok) log(`🌬 ${thrower.name} подбросил ${b.name} на ${cellKey(at)}`)
      return ok ? receive : false
    } finally { delete thrower.swarmReserved; board.release(id, b.name, claim.claim.token); board.cancel(id) }
  }
  async function positionStep(b, context, purpose) {
    if (positionQueries >= 2 || (cooldown.get(`position:${b.name}`) || 0) > now()) return false
    cooldown.set(`position:${b.name}`, now() + 20000)
    positionQueries++; b.swarmBusyUntil = now() + 20000
    const round = generation
    try {
      const m = pos[b.name], board = context.board
      const query = await execute(b, 'swarm_position', { purpose, arena, enemies: board.enemies().map(e => ({ id: e.id })), radius: 12, limit: 6, reserve: context.member.reserve, budgetMs: 1500 })
      if (round !== generation || !alive(b.name)) return false
      const candidates = query.observed ? query.candidates || [] : []
      for (const choice of candidates.filter(c => c.score > 0 && distance(c.at, m.p) > 2 && !(b.badSpots || []).some(p => p.until > now() && distance(p, c.at) < 1))) {
        const method = [...choice.methods].sort((a, c) => a.cost - c.cost)[0]
        if (!method) continue
        let ok = false, actual
        if (method.kind === 'build' && method.plan?.kind === 'pillar') {
          const id = `pillar:${b.name}`, base = { x: Math.floor(m.p.x), y: Math.floor(m.p.y), z: Math.floor(m.p.z) }
          board.upsert({ id, kind: 'build', assignedTo: b.name, position: base, data: { block: method.params.item }, expiresAt: now() + 15000 })
          const claim = board.claim(id, b.name, 15000)
          if (!claim) continue
          try {
            const r = await execute(b, 'swarm_pillar', { ...method.params, arena, allies: context.members.map(a => a.id), timeoutSeconds: 12 })
            ok = r.ok === true && r.at && distance(r.at, choice.at) < .6
            actual = r.at
            board.ack(id, b.name, { token: claim.claim.token, confirmed: ok, position: base, block: method.params.item })
          } finally { board.release(id, b.name, claim.claim.token); board.cancel(id) }
        } else if (method.kind === 'build') {
          const approach = await buildGo(b, method.plan.approach)
          if (approach?.status === 'failed') continue
          const cell = method.plan.cells[0]
          await buildStep(b, context, { kind: 'platform', id: `platform:${cellKey(cell.at)}`, origin: cell.at, cells: method.plan.cells, protected: [method.plan.reference] })
          if (!board.tasks().some(t => t.kind === 'build' && cellKey(t.position) === cellKey(cell.at) && t.status === 'done')) return true
          const moved = await buildGo(b, choice.at)
          actual = detail(moved).arrived
          ok = !!actual && distance(actual, choice.at) < .6
        } else {
          if (method.kind !== 'walk') { const pair = await pairedWind(b, context, choice.at); ok = !!pair; actual = pair && pair.at }
          if (!ok && choice.at.y < m.p.y && m.p.y - choice.at.y <= 4 && Math.hypot(choice.at.x - m.p.x, choice.at.z - m.p.z) <= 3) {
            const ledge = await execute(b, 'ledge_to', { at: choice.at, arena, maxFallDamage: 0, timeoutSeconds: 5 })
            ok = !!ledge.ok
            actual = ledge.at
          }
          if (!ok) {
            const r = await execute(b, method.skill, { ...method.params, arena, ...(method.kind === 'walk' ? { range: .25, surface: 'strict', timeoutSeconds: 6, _hunt: true } : {}) })
            ok = r.ok === true || r.reached === true || !!r.arrived && distance(r.arrived, choice.at) < .6
            actual = r.at || r.arrived
          }
        }
        if (round !== generation || !alive(b.name)) return false
        if (ok && (!actual || ![actual.x, actual.y, actual.z].every(Number.isFinite))) {
          const s = await b.c.call('status', { physics: true }); actual = s?.state?.pos || s?.detail?.physics?.pos
          ok = !!actual && distance(actual, choice.at) < .6
        }
        if (!ok) { (b.badSpots ||= []).push({ ...choice.at, until: now() + 15000 }); b.badSpots = b.badSpots.filter(p => p.until > now()).slice(-32); continue }
        b.swarmPosition = { ...choice, purpose, placedAt: now() }
        m.p = { ...actual }
        b.swarmHoldUntil = now() + 5000
        board.recordFact(b.name, now(), { id: `rally:${b.name}`, kind: 'mark', position: choice.at }, 30000)
        log(`🏔 ${b.name}: ${purpose} → ${cellKey(choice.at)} (${method.kind})`)
        return true
      }
      return false
    } finally { positionQueries--; delete b.swarmBusyUntil }
  }
  const rangedAdvantage = b => {
    const here = b.swarmPosition, m = pos[b.name], enemies = boardOf(b).enemies()
    return !!here && here.purpose === 'ranged' && m?.inv?.bow && m.inv.arrow && distance(m.p, here.at) < 1 && enemies.length && enemies.every(e => now() - e.seenAt < 1000 && e.position.y + 6 < m.p.y && !['bow', 'aerial', 'blast'].includes(e.threat) && !/bow|trident|end_crystal|respawn_anchor/.test(e.equipment?.weapon || ''))
  }
  // Фаза приёма: смена её посреди долгого дела (бой — до 12 игровых с) обрывает дело — иначе старый фронт линии
  // дерётся после смены, фонтан не смыкается, засада не бьёт. Смена цели в том же бою фазой не считается.
  // Только фазы приёмов: обычное перераспределение (бой ↔ резерв) не обрывает начатое, иначе бой дёргается.
  // Раненый, которому велено отходить (recover), — тоже фаза: бой до 12 с добивал его (лаборатория 13.10, линия: 1 хп → смерть).
  // Отход раненого и бегство от неравного боя — одна фаза «уход»: переключения между ними рвали сам отход (лаборатория 13.10).
  const phase = t => t ? [t.kind === 'recover' || t.data?.panic ? 'retreat' : '', t.data?.hold, t.data?.fountain, t.data?.ambush && t.kind, t.data?.line !== undefined ? 'line' : '', t.data?.rotation].join('|') : ''
  function preempt(b) {
    const running = b.swarmTask
    if (b.campReacting || !b.swarmExecuting || !running || now() - (b.swarmTaskAt || 0) < 1000 || !alive(b.name)) return false
    const { task } = refresh(b)
    if (!task || phase(task) === phase(running)) return false
    b.swarmTask = task; b.swarmTaskAt = now()
    log(`↪ ${b.name}: смена фазы ${running.kind}${running.data?.fountain ? '/' + running.data.fountain : ''} → ${task.kind}${task.data?.fountain ? '/' + task.data.fountain : ''}${task.data?.hold ? '/' + task.data.hold : ''} — обрываю дело`)
    b.c.call('stop').catch(() => {})
    return true
  }
  async function turn(b) {
    const context = refresh(b), { board, member, task } = context, round = generation
    if (!member || !task) return
    if (board.tasks().some(t => t.status === 'claimed' && t.claim.owner !== b.name && t.participants?.includes(b.name))) return
    if (phase(task) !== phase(b.swarmTask)) b.swarmTaskAt = now()
    b.swarmTask = task
    say(b, task)
    const m = pos[b.name], enemies = board.enemies()
    // Кемпер в коробке: урон и вскрытие — до смены дела (ранение не теряется при переходе в recover).
    if (b.boxedCamp) {
      const r = await execute(b, 'swarm_hold', { camp: true, checkOnly: true, enemies: enemies.map(e => e.id), allies: context.members.map(a => a.id), arena })
      // Поздний ответ после сброса раунда не оживляет старую засаду (Codex 15.10).
      if (round !== generation || !alive(b.name)) return
      if (await reactCamp(b, r)) return
    }
    // Кемпер в своей коробке получил другое дело — сперва выйти (пролом в сторону дела), иначе лез по кругу из запертой клетки.
    if (b.boxedCamp && task.data?.camp !== b.boxedCamp) {
      const was = b.boxedCamp
      b.campReacting = true
      let r: any
      try { r = await execute(b, 'box_out', { toward: task.position || null, timeoutSeconds: 24, _climb: true, arena }) } finally { delete b.campReacting }
      if (round !== generation || !alive(b.name)) return
      // Тело помнит коробку, пока не вышел: забыть только по выходу (иначе драйвер и тело расходились — Codex 15.10).
      // Пять неудач подряд — забыть (иначе вечный «выхожу — не вышел»; тело само отпустит коробку со смертью или новым раундом).
      if (r.left || r.why === 'не заперт' || (b.boxOutTries = (b.boxOutTries || 0) + 1) >= 5) forgetCamp(b)
      log(`🧱 ${b.name}: кемпер выходит из коробки ${was} (${task.kind}${task.data?.camp ? ' ' + task.data.camp : ''}) — ${r.left ? 'вышел' : String(r.why || 'не вышел').slice(0, 60)}`)
      return
    }
    // Свой горящий динамит рядом (факт tnt, 4.5 с): отойти на 7+ бл., всё остальное подождёт.
    const boom = board.facts().find(f => f.id.startsWith('tnt:') && f.position && distance(f.position, m.p) < 6)
    if (boom) { const d = Math.hypot(m.p.x - boom.position.x, m.p.z - boom.position.z) || 1; await go(b, { x: m.p.x + (m.p.x - boom.position.x) / d * 7, y: m.p.y, z: m.p.z + (m.p.z - boom.position.z) / d * 7 }, 1.5, 3); return }
    if (!/^(flee|recover)$/.test(task.kind) && chestAtHand(b) && await loot(b, board, true)) return
    if (aggressive && task.kind !== 'flee' && !task.data?.dig && !task.data?.ladder && await grab(b, enemies)) return
    if (task.kind === 'flee') {
      // Насест на элитрах (perch, пользователь 14.10: «могут наверх улетать и там сидеть, кемперить или с лука палить»):
      // далеко — долететь (fly_to: над гребнем, посадка с открытым небом; не вышло — бежать, как обычно); на месте — лук
      // из-за своей стенки в прыжке (peek_shot, с места не сходит), без лука — есть и сидеть на шифте.
      if (task.data?.perch) {
        if (distance(m.p, task.position) > 3) {
          if ((cooldown.get(`fly:${b.name}`) || 0) <= now()) {
            cooldown.set(`fly:${b.name}`, now() + 8000)
            const r = detail(await b.c.call('fly_to', { at: task.position, timeoutSeconds: 15, arena }))
            log(`🪽 ${b.name}: на насест ${cellKey({ x: Math.floor(task.position.x), y: Math.floor(task.position.y), z: Math.floor(task.position.z) })} — ${r.ok ? 'долетел' : r.why || '?'}`)
            if (r.ok) return
          }
        } else {
          const foe = enemies.find(e => e.id === task.data.target)
          if (foe && now() - foe.seenAt < 1000 && m.inv?.bow && m.inv?.arrow) { await b.c.call('peek_shot', { target: foe.id, shots: 3 }); return }
          await b.c.call('eat', { timeoutSeconds: 2 }).catch(() => {})
          await b.c.call('swarm_hold', { sneak: true, enemies: enemies.map(e => e.id), allies: context.members.map(a => a.id), timeoutSeconds: 2, arena })
          return
        }
      }
      // Укрытие без своих (пользователь 14.10: «если своих нет — прятаться в колизее, в блоках или на высоте, и шифт
      // зажимать, чтобы мы не видели его»): дошёл — сидеть на шифте, ник за блоками не виден.
      if ((task.data?.hide || task.data?.regroup) && !enemies.length && distance(m.p, task.position) >= 3) { await go(b, task.position, 2); return }
      if (task.data?.hide && distance(m.p, task.position) < 3) { await b.c.call('swarm_hold', { sneak: true, enemies: enemies.map(e => e.id), allies: context.members.map(a => a.id), timeoutSeconds: 3, arena }); return }
      if (rangedAdvantage(b)) { await b.c.call('fight', { target: task.data.target, targets: enemies.map(e => e.id), allowPlayer: true, allowRanged: true, timeoutSeconds: 3, retreatAtHealth: 8, arena }); return }
      // Погоня (kite): отрыв по открытому без точки (smartFlee сам обходит тупики), до 22 бл.; к своим — к ним.
      const outcome = detail(await b.c.call('flee', { from: enemies.map(e => e.id), toward: task.data?.kite && !task.data?.regroup ? [] : [task.position], timeoutSeconds: 3, safeDist: task.data?.kite ? 22 : 14, reason: task.data?.reason, arena }))
      if (round !== generation || !alive(b.name)) return
      if (outcome.cornered && task.data?.target) {
        log(`⚔ ${b.name}: физически зажат, отвечаю ${task.data.target}`)
        await b.c.call('fight', { target: task.data.target, allowPlayer: true, allowRanged: true, lastStand: true, timeoutSeconds: 3, retreatAtHealth: 0, arena })
      } else if (outcome.mode === 'оторвался') {
        if (outcome.at) m.p = outcome.at
        // Оторвался от погони — дальше решает планировщик (лут за 22 бл.), а не поход к группе или лут исполнителя.
        if (task.data?.kite) return
        if (task.data?.hide || task.data?.regroup) { await go(b, task.position, 2); return }
        b.swarmPreparingUntil = now() + 7000
        if (!await loot(b, board) && !await positionStep(b, context, m.inv?.bow ? 'ranged' : 'escape')) await search(b, context)
      }
      return
    }
    const nearest = [...enemies].sort((a, c) => distance(a.position, m.p) - distance(c.position, m.p))[0]
    const gap = nearest ? distance(nearest.position, m.p) : Infinity
    const toward = nearest && gap ? ((nearest.velocity?.x || 0) * (m.p.x - nearest.position.x) + (nearest.velocity?.z || 0) * (m.p.z - nearest.position.z)) / gap * 20 : 0
    const contact = nearest && now() - nearest.seenAt < 1000 && (gap <= 3.5 || toward > 0 && (gap - 3) / toward < .8)
    // Вода (пользователь 14.10: «из-за воды тупят — против течения стоят»; «круто, если воду будут убирать блоками или
    // вёдрами, если мешает»): в воде и не в схватке — убрать источник рядом ведром или блоком, нечего — выплыть.
    if (m.water && !contact && (cooldown.get(`water:${b.name}`) || 0) <= now()) {
      cooldown.set(`water:${b.name}`, now() + 4000)
      const r = detail(await b.c.call('clear_water', {}).catch(e => ({ why: e.message })))
      if (r.how || r.why) log(`💧 ${b.name}: ${r.how || r.why}`)
      if (r.ok) return
    }
    if (task.kind === 'recover') {
      if (contact) {
        const out = detail(await b.c.call('flee', { from: enemies.map(e => e.id), timeoutSeconds: 3, safeDist: 14, arena }))
        if (out.mode !== 'оторвался') return
      }
      // В кольце и «стаде» место раненого — середина строя: поиск укрытия подальше уводил его из-за щитов (ревью 13.10).
      else if (['ring', 'weak-center'].includes(task.data?.doctrine)) { if (distance(m.p, task.position) > 1) await go(b, task.position, .6) }
      else if (!await positionStep(b, context, 'recover') && distance(m.p, task.position) > 3) await go(b, task.position)
      await b.c.call('eat', { timeoutSeconds: 4 }).catch(() => {})
      return
    }
    if (task.kind === 'heal') {
      if (distance(m.p, task.position) > 4.5) await go(b, task.position, 3)
      await b.c.call('assist', { mode: 'heal', ally: task.data.ally })
      return
    }
    // Стойка на месте: кольцо щитов (щит поднят, лицом наружу), засада флангов или оцепление кокона (присед, взгляд на цель).
    if (task.kind === 'goto' && ['shield', 'ambush', 'cordon'].includes(task.data?.hold)) {
      const range = task.data.range ?? .8
      // Не дошёл до засады и не приблизился — она ему 15 с недоступна (Codex 15.10: сторож сбрасывал поход, а ход вёл туда же).
      if (distance(m.p, task.position) > range + .4) {
        const before = distance(m.p, task.position)
        const walked = detail(await go(b, task.position, range).catch(e => ({ why: e.message })))
        if (task.data.camp && !walked.arrived && distance(pos[b.name]?.p || m.p, task.position) > before - 1) cooldown.set('camp:' + task.data.camp, now() + 15000)
        return
      }
      // Кемпер на месте — замуроваться (стены и крыша); раскопают — увидит врага в упор, и контакт поднимет бой.
      if (task.data.camp && !boxed.has(`${b.name}:${task.data.camp}`) && (cooldown.get(`box:${b.name}`) || 0) <= now() && blockCount(m.inv) >= 10) {
        const r = detail(await b.c.call('box_in', {}).catch(e => ({ why: e.message })))
        if (round !== generation || !alive(b.name)) return
        const tries = (boxTries.get(`${b.name}:${task.data.camp}`) || 0) + 1; boxTries.set(`${b.name}:${task.data.camp}`, tries)
        if (r.sealed || tries >= 2) boxed.add(`${b.name}:${task.data.camp}`); else cooldown.set(`box:${b.name}`, now() + 10000)
        if (r.sealed) b.boxedCamp = task.data.camp
        log(`🧱 ${b.name}: кемпер замуровался у ${task.data.camp} — ${r.sealed ? `готово (${r.placed} бл., ${r.material || '?'})` : String(r.why || `стен ${r.walls ?? '?'}`).slice(0, 60)}`)
        return
      }
      const held = await execute(b, 'swarm_hold', { camp: !!b.boxedCamp, ...(task.data.hold === 'shield' ? { shield: true, face: task.data.face, timeoutSeconds: 4 } : { sneak: true, timeoutSeconds: 2 }),
        enemies: enemies.map(e => e.id), allies: context.members.map(a => a.id), arena })
      if (round !== generation || !alive(b.name)) return
      await reactCamp(b, held)
      return
    }
    // Манёвр приёма (линия, фонтан, засада, кольцо, приманка, оцепление, стройка) важнее ролевых привычек: обмен, сундуки,
    // поиск позиции, маяки и укрытия его не перебивают (разбор 13.10: строитель кокона уходил класть маяк, часовой без лука
    // по 10 с искал позицию для стрельбы).
    const maneuver = !!(task.data?.fountain || task.data?.ambush || task.data?.hold || task.data?.line !== undefined || task.data?.bait || task.data?.cordon || task.data?.buildKind || task.data?.dig || task.data?.ladder)
    if (!maneuver && !contact && await transfer(b, context)) return
    if (task.data?.buildKind) {
      const enemy = enemies.find(e => e.id === task.data.target), o = task.data.origin
      // Кокон — пока цель в своей клетке; отсечка — пока цель ещё перед стеной (она стоит на её пути, а не вокруг неё).
      const ready = enemy && now() - enemy.seenAt <= 1000 && (task.data.buildKind === 'cutoff'
        ? distance(enemy.position, o) <= 10
        : Math.floor(enemy.position.x) === o.x && Math.floor(enemy.position.z) === o.z && Math.abs(enemy.position.y - o.y) < 1)
      // Строитель работает в шаге от цели, «контакт» его не останавливает: угрозу у клетки проверяет сама кладка (прицел
      // врага, урон) — иначе в 3.5 бл. от цели стройка не шла вовсе, а строитель уходил бродить.
      // Цель в клетке кокона заперта: её тычок сквозь щель — цена, а не повод бросать кладку (swarm_work contained).
      const contained = task.data.buildKind === 'cocoon' && ready ? [task.data.target] : []
      if (ready && await buildStep(b, context, { kind: task.data.buildKind, origin: o, direction: task.data.direction, contained })) return
      // Класть пока нечего (клетки у другого, крыша ждёт стен) — стоять у стройки, а не бродить. Но не в коробке кокона:
      // строитель, доложивший свои клетки, стоял в щели и закрывал телом последнюю клетку крыши (лаборатория 14.10, 22/23).
      const site = { x: o.x + .5, y: o.y, z: o.z + .5 }
      const inBox = task.data.buildKind === 'cocoon' && m.p.y < o.y + 3 && [['x', o.x], ['z', o.z]].every(([k, c]: any) => m.p[k] + .3 > c - 1 && m.p[k] - .3 < c + 2)
      const away = Math.hypot(m.p.x - site.x, m.p.z - site.z)
      if (inBox) await go(b, away > .1 ? { x: site.x + (m.p.x - site.x) / away * 3.2, y: o.y, z: site.z + (m.p.z - site.z) / away * 3.2 } : { x: site.x + 3.2, y: o.y, z: site.z }, .8)
      else if (distance(m.p, site) > 5) await go(b, site, 3)
      else await b.c.call('swarm_hold', { sneak: true, timeoutSeconds: 1, enemies: enemies.map(e => e.id), allies: context.members.map(a => a.id), arena })
      return
    }
    // Добытчик (gather, планировщик): к месту добычи и копать руками (песок поля 16 бл. ≈ 15 с); добытое разнесут передачи.
    if (task.data?.gather && !contact) {
      b.gatherUntil = now() + 20000
      if (distance(m.p, task.position) > 24) { await go(b, task.position, 8, 8); return }
      const r = detail(await b.c.call('mine', { block: task.data.gather, count: task.data.count || 32, radius: 24, timeoutSeconds: 20 }).catch(e => ({ why: e.message })))
      log(`🏖 ${b.name}: добываю ${task.data.gather} команде на подъём — ${r.dug ?? 0} шт.${r.why ? ` (${String(r.why).slice(0, 60)})` : ''}`)
      return
    }
    // Яма-ловушка (dig, планировщик; Codex 15.10): верх пола — с места, где стоит (планировщик берёт копателя, у кого яма в
    // досягаемости, — поход к стойке рвали тактика, тревога и тайм-аут: 0 ям за 7 прогонов). Нижний слой двойного пола виден
    // сквозь дыру только из соседней клетки (луч с высоты глаз 1.62 входит в дыру шириной 1 круче 45°) — за ним (и за невидимым
    // верхом: перила, плиты) шаг на стойку.
    // Готовую дыру — в holes: сектор удара (edgeNear) ставит бьющих так, чтобы отбросило в неё.
    if (task.data?.dig && !contact) {
      const s = task.position, key = cellKey(s)
      if (holes.some(h => cellKey(h) === key)) return
      const p = (await b.c.call('status').catch(() => null))?.state?.pos || m.p
      if (round !== generation || !alive(b.name)) return
      m.p = p
      if (!canDigTrap(p, s)) { planned.delete(teamOf(b)); return }
      let dug = 0, why = '', stepped = false
      const started = now()
      b.climbing = true
      try {
        for (let k = 0; k < (task.data.blocks || [0, 1]).length; k++) {
          const left = 12 - (now() - started) / 1000
          if (left < .1) { why = 'work_exceeds_budget'; break }
          const reply: any = await b.c.call('swarm_work', { kind: 'dig', at: { x: s.x, y: s.y - k, z: s.z },
            protected: ownProtection(board), allies: context.members.map(a => a.id),
            timeoutSeconds: Math.max(.1, Math.min(12, left)), _climb: true, _hunt: true
          }).catch(e => ({ status: 'failed', error: e.message }))
          if (round !== generation || !alive(b.name)) return
          if (reply.status === 'interrupted') {
            b.swarmFightReply = reply
            cooldown.set(`fight:${b.name}`, now() + 500)
            return
          }
          const r = detail(reply)
          if (r.ok) { dug++; continue }
          const stand = !stepped && /occluded|reach/.test(r.why || '') && [...(task.data.stands || [])].sort((a, c) => distance(a, p) - distance(c, p))[0]
          if (!stand) { why = r.why || reply.error || reply.status || 'no_receipt'; break }
          stepped = true
          const at = (await b.c.call('status').catch(() => null))?.state?.pos || p
          if (Math.hypot(at.x - stand.x, at.z - stand.z) > 1.6) await b.c.call('goto', { ...stand, range: 1, timeoutSeconds: 4, arena, climb: true, _hunt: true, _climb: true }).catch(() => null)
          if (round !== generation || !alive(b.name)) return
          const moved: any = await b.c.call('center_in', { ...stand, ms: 2000, _climb: true, _hunt: true }).catch(e => ({ status: 'failed', error: e.message }))
          if (round !== generation || !alive(b.name)) return
          if (moved?.status === 'interrupted') { b.swarmFightReply = moved; cooldown.set(`fight:${b.name}`, now() + 500); return }
          k--
        }
      } finally { b.climbing = false }
      const need = (task.data.blocks || [0, 1]).length
      if (dug >= need) {
        holes.push({ x: s.x, y: s.y, z: s.z, feetY: (s as any).feetY ?? s.y + 1, at: now() })
        say2(`🕳 ${b.name.replace(/^NeuroFarm/, '')}: яма-ловушка у ${String(task.data.target).replace(/^NeuroFarm/, '')} — толкайте туда!`, 'gold', true)
      } else cooldown.set('hole:' + key, now() + 4000)
      planned.delete(teamOf(b))
      log(`🕳 ${b.name}: яма у ${task.data.target} (${s.x} ${s.y} ${s.z}) — вскрыл ${dug}${why ? ` (${String(why).slice(0, 70)})` : ''}`)
      return
    }
    // Лестница у стены пояса (ladder, планировщик; место — модель): встать за колонной лестницы (W + 2·грань), скрафтить, сколько
    // нужно, подняться, ставя ступени (ladder_up); вся колонна стоит — общий путь наверх (ladderRoutes), лезущие идут по нему.
    if (task.data?.ladder && !contact) {
      const t = walls.get(task.data.ladder)
      if (!t || t.done || (t.retryAt || 0) > now()) return
      const { x: fx, z: fz } = t.face
      const stand = { x: t.x + .5 + fx * 2, y: t.y, z: t.z + .5 + fz * 2 }
      const need = t.top - t.y + 1
      b.climbing = true
      try {
        let state = (await b.c.call('status', {}).catch(() => null))?.state
        if (!state?.pos) return
        if (distance(state.pos, stand) > .6) {
          const g = detail(await b.c.call('goto', { ...stand, range: 1, timeoutSeconds: 10, arena, climb: true, _hunt: true, _climb: true }).catch(e => ({ why: e.message })))
          if (g.arrived && Math.abs(g.arrived.y - stand.y) < .6) await b.c.call('center_in', { ...stand, ms: 1500, _climb: true }).catch(() => null)
          else { t.retryAt = now() + 8000; log(`🪜 ${b.name}: к стене ${t.key} не подойти — ${String(g.why || g.error || 'нет').slice(0, 60)}`) }
          return
        }
        if ((state.inventory?.ladder || 0) < need) {
          const r = detail(await b.c.call('craft', { item: 'ladder', count: need - (state.inventory?.ladder || 0), _climb: true }).catch(e => ({ why: e.message })))
          state = (await b.c.call('status', {}).catch(() => null))?.state
          if ((state?.inventory?.ladder || 0) < need) { t.retryAt = now() + 8000; cooldown.set(`ladder:${b.name}`, now() + 30000); log(`🪜 ${b.name}: лестниц для ${t.key} не хватило (${state?.inventory?.ladder || 0}/${need}) — ${String(r.why || r.error || r.note || '').slice(0, 50)}`); return }
        }
        const r = detail(await b.c.call('ladder_up', { wall: { x: t.x, y: t.y, z: t.z }, face: t.face, top: t.top, timeoutSeconds: 40, _climb: true }).catch(e => ({ why: e.message })))
        log(`🪜 ${b.name}: лестница у ${t.key} (${need} бл.) — ${r.complete ? `готова, ступеней ${r.placed}` : String(r.why || 'нет').slice(0, 70)}`)
        if (r.complete) {
          t.done = true
          if (!ladderRoutes.some(l => l.key === t.key)) ladderRoutes.push({ key: t.key, base: { x: t.x + .5 + fx, y: t.y, z: t.z + .5 + fz }, top: { x: t.x + .5, y: t.top + 1, z: t.z + .5 } })
          say2(`🪜 ${b.name.replace(/^NeuroFarm/, '')}: лестница наверх готова — лезьте`, 'green', true)
        } else t.retryAt = now() + 8000
      } finally { b.climbing = false }
      return
    }
    const armed = Object.keys(m.inv || {}).some(n => WEAPON.test(n))
    // Натиск: у кого из своих нечем драться — сильный по пути забирает увиденные сундуки (враг дальше 16 бл.), лишнее
    // раздадут передачи (пользователь 14.10: «сильные могут сразу много лута брать и передавать своим»).
    const carrier = aggressive && armed && gap > 16 && context.members.some(a => a.id !== b.name && !Object.keys(a.inventory || {}).some(n => WEAPON.test(n)))
    if (!maneuver && !contact && (task.kind === 'loot' || !armed || carrier) && await loot(b, board)) return
    const bow = !!(m.inv?.bow || m.inv?.crossbow) && !!m.inv?.arrow
    // Натиск: строителю не до вышек и маяков — бой (14.10: «бегают вокруг меня»).
    if (!maneuver && !contact && (member.role === 'ranged' && bow || member.role === 'miner-builder' && !aggressive || task.data?.sentry && bow) && await positionStep(b, context, member.role === 'miner-builder' ? 'build' : 'ranged')) return
    if (!maneuver && !contact && (task.data?.sentry || b.swarmPosition?.purpose === 'recover') && b.swarmHoldUntil > now()) { await b.c.call('swarm_hold', { sneak: b.swarmPosition?.cover > .5, enemies: enemies.map(e => e.id), allies: context.members.map(a => a.id), timeoutSeconds: 3 }); return }
    if (!maneuver && member.role === 'miner-builder' && !aggressive && !contact && (cooldown.get(`work:${b.name}`) || 0) <= now()) {
      if (nearest && nearest.position.y > m.p.y + 2 && await mineStep(b, context, nearest)) return
      if (b.swarmPosition?.purpose === 'build' && b.swarmPosition.highGround >= 3 && distance(m.p, b.swarmPosition.at) < 2 && await buildStep(b, context, { kind: 'outpost', origin: b.swarmPosition.at })) return
      // Маяк «враг был здесь» — один на клетку, а не на дробную позицию (иначе новый маяк почти каждый ход).
      const trail = nearest && 'trail:' + cellKey({ x: Math.floor(nearest.position.x), y: Math.floor(nearest.position.y), z: Math.floor(nearest.position.z) })
      if (nearest && !board.facts().some(f => f.id === trail) && (m.inv.cobblestone || 0) > 18) {
        const origin = { x: Math.floor(m.p.x) + 1, y: Math.floor(m.p.y), z: Math.floor(m.p.z) }
        if (await buildStep(b, context, { kind: 'beacon', origin })) { board.recordFact(b.name, now(), { id: trail, kind: 'mark', position: nearest.position }, 30000); return }
      }
      if (!task.data.cover && await buildStep(b, context)) return
      if (!nearest && await mineStep(b, context, nearest)) return
    }
    const foe = enemies.find(e => e.id === task.data?.target)
    // Копатель в контакте (план держит своего до 3 бл., контакт — 3.5) — бой, а не шаг в клетку ямы (Codex 15.10).
    if ((task.kind === 'goto' || task.data?.search) && !(task.data?.dig && contact)) {
      // Охота: дошёл до места, где врага видели последним, — прочёсывать арену, а не стоять.
      // Дошёл туда, где врага видели последним, а его не видно — замуровался рядом: копать туда, а не бродить (натиск).
      if (task.data?.search && distance(m.p, task.data.enemyPosition) < 4) { if (task.data.hunt && aggressive && await breach(b, task.data.enemyPosition)) return; await search(b, context); return }
      // Сбор на своём секторе (окружение): место — от живой позиции цели (план держит старое место, пока данные те же).
      const sf = task.data?.slot !== undefined && foe
      const walked = detail(await go(b, task.data?.search ? task.data.enemyPosition : sf ? { x: sf.position.x + Math.cos(task.data.slot * Math.PI / 4) * 10, y: sf.position.y, z: sf.position.z + Math.sin(task.data.slot * Math.PI / 4) * 10 } : task.position, task.data?.range ?? 2).catch(e => ({ why: e.message })))
      // Охота: к месту врага не дойти (замуровался за стеной дальше 4 бл.) — прокоп к нему (Codex 15.10: три отказа пути, ноль прокопов).
      if (task.data?.hunt && aggressive && !walked?.arrived && distance(pos[b.name]?.p || m.p, task.data.enemyPosition) < 12 && await breach(b, task.data.enemyPosition)) return
      if (task.data?.bait && !contact) await b.c.call('eat', { timeoutSeconds: 2 }).catch(() => {})
      return
    }
    if (foe && (task.kind === 'fight' || task.data?.dig && contact)) {
      if (b.cur !== foe.id) b.noReach = 0
      b.cur = foe.id
      if (task.data.push && now() - foe.seenAt < 500) {
        const push = detail(await b.c.call('wind_push', { target: foe.id, arena }))
        if (push.fired) return
      }
      const stale = now() - foe.seenAt > 1000, far = distance(m.p, foe.position) > 18 && !rangedAdvantage(b)
      // Окружение: своё место — сектор в 2.5 бл. от живой позиции цели (план — data.slot), а не прямо на неё одной толпой.
      const potionFirst = Object.entries(m.potions || {}).some(([k, n]: any) => n > 0 && /^splash_(?:(?:long|strong)_)?(?:harming|poison|slowness|weakness)$/.test(k))
      const ringR = potionFirst ? 5.75 : 2.5
      const slotAt = task.data.slot !== undefined ? { x: foe.position.x + Math.cos(task.data.slot * Math.PI / 4) * ringR, y: foe.position.y, z: foe.position.z + Math.sin(task.data.slot * Math.PI / 4) * ringR } : foe.position
      // Цель выше 3+ бл. — подъём (видно её или нет: снизу крышу не видно, лезть к последнему месту).
      // Рядом, но ниже на 1.8+ (столб у края крыши: удар не достаёт — стенд 15.10, «пауза»: синий в 3 бл. на 2.5 ниже) — тоже
      // подъём: короткий столбик к нему.
      const below = foe.position.y - m.p.y, nearH = Math.hypot(foe.position.x - m.p.x, foe.position.z - m.p.z) < 4
      if (aggressive && below > 3 && !contact && await climbTo(b, foe, slotAt)) return
      // Рядом, ниже на 1.8+: шаг на его уровень (клетка рядом с ним, допуск 1 бл.); «дошёл», а всё ещё ниже (допуск 2.5 засчитывал
      // стоящего на 2 ниже — десятки попыток в секунду, удара нет) — 1.5 с без попыток, бить тем, что достаёт.
      if (aggressive && below > 1.8 && nearH && (cooldown.get(`step:${b.name}`) || 0) <= now()) {
        // В 3 бл. от него — столбик на месте до его уровня (удар достаёт 3); дальше — клетка в 1.2 бл. от него. exactY: ровно его
        // высота, а не пол под ней (иначе «дошёл» внизу).
        // Не вышло к нему — следующая попытка столбиком на месте (и наоборот): край крыши над стеной галереи — к клетке у него
        // путь ищется долго, а столб в 3.3 бл. достаёт (стенд s5: пауза 13 с на −2.5).
        b.stepTry = (b.stepTry || 0) + 1
        const d = Math.hypot(m.p.x - foe.position.x, m.p.z - foe.position.z) || 1, k = d <= 3 || b.stepTry % 2 === 0 ? d : 1.2
        const at = { x: foe.position.x + (m.p.x - foe.position.x) / d * k, y: foe.position.y, z: foe.position.z + (m.p.z - foe.position.z) / d * k }
        b.climbing = true
        const r = detail(await b.c.call('goto', { ...bounded(at), range: 1, timeoutSeconds: 4, arena, climb: true, exactY: true, _hunt: true, _climb: true }).catch(e => ({ why: e.message })).finally(() => { b.climbing = false }))
        if (!r.arrived || foe.position.y - (pos[b.name]?.p?.y ?? m.p.y) > 1.5) cooldown.set(`step:${b.name}`, now() + 1500)
        else return
      }
      // Натиск: он ближе 10 бл. и не над нами (не в прыжке с булавой), а его не видно (замуровался) или два боя без удара —
      // (и вплотную: «бой 0/0 в 2.8 бл.» за стенкой — прокоп; виден — dig_to сразу «дошёл», ничего не ломает; Codex 15.10)
      // не дойти: прокоп к нему (14.10: «из укрытия не достают, а кирками раскопать — и все пройдут»).
      const reachGap = distance(m.p, foe.position), grounded = foe.position.y - m.p.y < 2.5
      if (aggressive && reachGap < 10 && grounded && (stale || (b.noReach || 0) >= 2) && await breach(b, foe.position)) { b.noReach = 0; return }
      if (stale || !task.data.committed || far) {
        await go(b, stale ? foe.position : task.data.committed && far ? slotAt : task.position, 3)
        return
      }
      // Смыкание фонтана — сперва своё место по кругу (иначе все догоняют его со спины одной кучей), потом удар.
      if (task.data.fountain === 'close' && distance(m.p, task.position) > 1.5 && !contact) { await go(b, task.position, .8); return }
      const place = task.data.slot !== undefined ? slotAt : task.position
      if (distance(m.p, place) > 6 && !contact && !rangedAdvantage(b)) { await go(b, place); return }
      if (foe.position.y - m.p.y > 4 && (m.inv.elytra || m.armor?.torso === 'elytra') && m.inv.firework_rocket >= 3 && (cooldown.get(`fly:${b.name}`) || 0) <= now()) {
        cooldown.set(`fly:${b.name}`, now() + 15000)
        await b.c.call('fly_to', { at: foe.position, timeoutSeconds: 15, arena }); return
      }
      // Динамит к его ногам (пользователь 15.10: «под игрока прям ставить»): в 2.5–4.5 бл., он на нашем уровне ±1, своих у него
      // нет; поставил — отбежать (blast).
      if (aggressive && reachGap >= 2.5 && reachGap <= 4.5 && Math.abs(foe.position.y - m.p.y) <= 1.2 && now() - foe.seenAt < 500 && await blast(b, foe.position, `к ногам ${foe.id}`)) return
      // Он выше на 1.8+ рядом (край крыши): бой коротко — 3 с, дальше снова шаг/столбик к нему (бой сам на 2–2.5 не строится).
      const reply = await b.c.call('fight', { target: foe.id, targets: enemies.map(e => e.id), relocateTo: home(b), allowPlayer: true, allowRanged: true, potionFirst, timeoutSeconds: task.data.fountain === 'close' ? 4 : aggressive && below > 1.8 && nearH ? 3 : 12, retreatAtHealth: aggressive ? 0 : 3, roundScope: `${teamOf(b)}:${generation}`, arena })
      if (round !== generation || !alive(b.name)) return
      const result = detail(reply)
      // Бой перебит (тактика, отмена) — не повторять сразу тот же бой: до освобождения тактики (guardedTurn; Codex 15.10:
      // «fight → interrupted → fight» по 5–8 раз за секунду).
      if (reply?.status === 'interrupted') { b.swarmFightReply = reply; cooldown.set(`fight:${b.name}`, now() + 500) }
      if (result.killed || result.kills?.length) board.noteTacticOutcome(b.name, task.data.doctrine, true)
      const gapAfter = pos[b.name]?.p ? distance(pos[b.name].p, foe.position) : 0
      b.noReach = (reply?.status === 'done' || reply?.status === 'timeout') && result.landed === 0 && gapAfter < 10 && foe.position.y - (pos[b.name]?.p?.y ?? 0) < 2.5 ? (b.noReach || 0) + 1 : 0
      // Итог боя в журнал (арена 14.10: убийств почти нет — видно, чем кончается схватка: попадания, хп, причина конца).
      // Чем бил (пользователь 14.10: «булавой, копьём, элитрами не атакуют») — выбор графа боя и приёмы особого оружия.
      const special = Object.keys(result.tricks || {}).filter(k => /булав|копь|элитр|пике|таран|трезуб|удочк|молни|заряд|зель|щит|опор|яму|столкн/.test(k)).slice(0, 5)
      // Сломать опору под ним (pvp.ts breakUnder): попыток/сломал/упал — видно, работает ли сброс на краю.
      if (result.breakUnder?.tries) special.unshift(`опора ${result.breakUnder.ok}/${result.breakUnder.tries}${result.breakUnder.fell ? `, упал ${result.breakUnder.fell}` : ''}`)
      log(`⚔ ${b.name} → ${foe.id}: попаданий ${result.landed ?? '?'}/${result.swings ?? '?'}, хп ${result.hp ?? '?'}${result.killed || result.kills?.length ? ', убил' : ''}${result.stopped || result.why ? ' — ' + String(result.stopped || result.why).slice(0, 70) : ''}${result.calc?.picks ? ` | граф ${Object.entries(result.calc.picks).map(([k, n]) => `${k}:${n}`).join(',')}` : ''}${special.length ? ` | ${special.join('; ')}` : ''}${reply?.status === 'interrupted' ? ` | interrupted ${JSON.stringify(reply.by)}` : ''}`)
      return
    }
    if (aggressive && task.kind === 'loot' && await tour(b, board)) return
    // Лут, а брать нечего (сундуки у врага, обход занят) и враг виден в 30 бл. — отойти от него, а не «искать» (поиск вёл прямо
    // к нему: поле s10 — 24 → 13 бл. за 3 с, и снова бегство; «лут ↔ бегство» по кругу).
    if (task.kind === 'loot') {
      const foe = enemies.filter(e => now() - e.seenAt < 3000).sort((a, c) => distance(a.position, m.p) - distance(c.position, m.p))[0]
      if (foe && distance(foe.position, m.p) < 30) {
        const d = Math.hypot(m.p.x - foe.position.x, m.p.z - foe.position.z) || 1
        await go(b, bounded({ x: m.p.x + (m.p.x - foe.position.x) / d * 8, y: m.p.y, z: m.p.z + (m.p.z - foe.position.z) / d * 8 }), 3, 4)
        return
      }
    }
    await search(b, context)
  }
  function reset() {
    generation++
    for (const board of boards.values()) board.resetRound()
    for (const b of bots) { delete b.swarmPosition; delete b.swarmHoldUntil; delete b.swarmPreparingUntil; delete b.swarmReserved; delete b.swarmTask; delete b.swarmTaskAt; delete b.swarmFightReply; delete b.noReach }
    holes.length = 0; walls.clear(); for (const w of ladderSites) walls.set(w.key, { ...w }); ladderRoutes.length = 0; boxed.clear(); boxTries.clear()
    for (const b of bots) { b.boxedCamp = null; b.boxOutTries = 0; delete b.campReacting }
    tourBad.clear(); blockedRoutes.clear()
    blueprints.clear(); transfers.clear(); planned.clear(); plannedAt.clear(); visited.clear(); cooldown.clear(); placed.clear(); toured.clear(); emptyChests.clear(); fullFor.clear(); knownChests.clear()
    for (const b of bots) Promise.resolve(b.c?.call('swarm_keep', { clear: true })).catch(() => {})
  }
  const snapshot = () => Object.fromEntries([...boards].map(([team, board]) => [team, { enemies: board.enemies(), tasks: board.tasks(), stats: { ...telemetry }, learning: board.tacticStats() }]))
  // Оценка «не вытяну» — симуляция боя на 600 тиков; на каждый ответ статуса (40 тел — ~160/с) её не пересчитывать: 250 мс.
  const unsafeCache = new Map<string, { at: number; v: boolean }>()
  const unsafe = b => {
    const c = unsafeCache.get(b.name)
    if (c && now() - c.at >= 0 && now() - c.at < 250) return c.v
    // Свежая опасность — сразу, не дожидаясь плана, но по тому же правилу, что в planPvp (mustFlee: смертельный залп,
    // тяжёлая рана, безнадёжный размен), а липкое бегство плана — тоже паника. Раньше здесь была своя личная оценка, и
    // опрос арены рвал бой, который команда держала (арена 14.10).
    const board = boardOf(b), members = membersOf(b), member = members.find(m => m.id === b.name)
    const risk = member && assessSwarmFight(member, board.enemies(), members)
    const contact = !!member && board.enemies().some(e => distance(e.position, member.position) <= 4)
    const close = aggressive ? !!member && board.enemies().some(e => distance(e.position, member.position) <= 8) : contact
    const v = !rangedAdvantage(b) && !!member && (!!risk && mustFlee(member, risk, close, groupVerdict(groupOf(members, member), board.enemies()), aggressive) || planned.get(teamOf(b))?.get(b.name)?.kind === 'flee')
    unsafeCache.set(b.name, { at: now(), v }); return v
  }
  const panic = b => !b.campReacting && unsafe(b) && !(b.swarmPreparingUntil > now() && boardOf(b).enemies().every(e => distance(e.position, pos[b.name].p) >= 14 && e.threat === 'melee'))
  const canEngage = (b, target) => boardOf(b).enemies().some(e => e.id === target) && !unsafe(b)
  const guardedTurn = async b => {
    if (b.swarmReserved) return
    const round = generation
    // Перебитый бой ждёт освобождения тактики: раз в 0.5 с observe (он и снимает requireObservation), потом перепланирование.
    if (b.swarmFightReply?.status === 'interrupted') {
      const key = `fight:${b.name}`
      if ((cooldown.get(key) || 0) > now()) return
      cooldown.set(key, now() + 500)
      const seen = await b.c.call('observe', { radius: 24, fair: true })
      if (round !== generation || !alive(b.name) || b.swarmReserved) return
      const t = seen?.state?.tactics
      if (seen?.status !== 'done' || t?.action || t?.owner === 'Tactical' || t?.owner === 'Emergency' || t?.requireObservation) return
      delete b.swarmFightReply
      plannedAt.delete(teamOf(b))
    }
    b.swarmExecuting = true
    try { await turn(b) } finally { delete b.swarmExecuting }
  }
  return { observe, turn: guardedTurn, release, reset, snapshot, panic, canEngage, refill, enemies: b => boardOf(b).enemies() }
}
