'use strict'
// Дезматч (FFA, показ 09.10): N ботов на сервере слота фермы бьются каждый против всех в Колизее.
// Цель бота — ближайший живой противник, пересматривается по концу боя или раз в SEG_S (30) с: чаще — обрыв тарана в воздухе (бой pvp — по одной цели за вызов);
// умер — набор заново и обратно на поле. Счёт убийств — по журналу сервера.
//   node farm/ffa.js up 31 4          поднять ещё 4 бойца (NeuroFarm31c…f, ws 8961…) на сервере слота 31
//   node farm/ffa.js run 31 [kit]     бой: NeuroFarm31, NeuroFarm31b и поднятые; kit — elytra (умолч.) | sword | crystal
//   node farm/ffa.js team 31 [kit]    команды 6 на 6 (красные/синие): фокус, прикрытие, зелья союзникам, стенки (набор team)
//   node farm/ffa.js arms 31          командная гонка вооружений 6 на 6: карта arms-layout (SEED, ARMS_POS), старт пустым,
//                                     лут LOOT_S (60) с зонами по команде → каптёр (лишнее своим) → бой
//   node farm/ffa.js down 31          погасить поднятых этой командой
// Только ферма: команды — RCON слота, бойцы — снимок кода из farm/slots.json (FFA_CODE — свой).
const fs = require('fs')
const path = require('path')
const net = require('net')
const { spawn, execFileSync } = require('child_process')
const ROOT = path.resolve(__dirname, '..')
const WebSocket = require(path.join(ROOT, 'daemon', 'node_modules', 'ws'))
const crowd = require(path.join(ROOT, 'daemon', 'src', 'pvp', 'crowd'))
const sleep = ms => new Promise<any>(r => setTimeout(r, ms))
const log = (...a) => console.log(`[${new Date().toTimeString().slice(0, 8)}]`, ...a)

const EXTRA = 'cdefghijklmnopqrstuvwxyz' // до 24 бойцов на слот (с NeuroFarm<i> и <i>b; 10.10: «по 12 в команде — замес»)
const extra = (i, k) => ({ name: `NeuroFarm${i}${EXTRA[k]}`, ws: 8961 + k, viewer: 3261 + k, mem: path.join(ROOT, 'farm', `memory-${i}${EXTRA[k]}`) })
const SEG_S = Number(process.env.FFA_SEG_S || 30)
// Центр поля: Колизей (600 120 600); гонка вооружений — своя карта arms-layout (ARMS_POS, по умолчанию 2000 100 2000).
let X = 600; let Y = 120; let Z = 600; let R = 24
// Снаряжение: оружие, еда, слоты брони; ступень материала — кому отдавать худшее.
const WEAPON = /(_sword|_axe|_spear|^mace|^trident|^bow|^crossbow)$/
const FOOD = /^(golden_apple|enchanted_golden_apple|bread|cooked_\w+|baked_potato|apple|carrot|golden_carrot|pumpkin_pie)$/
const ARMOR_SLOT: Record<string, RegExp> = { head: /_helmet$/, torso: /_chestplate$/, legs: /_leggings$/, feet: /_boots$/ }
const ALCHEMY = /^(nether_wart|glistering_melon_slice|glowstone_dust|gunpowder|blaze_powder|glass_bottle|fermented_spider_eye|spider_eye|redstone)$/
// Ценность вещи в гонке (подарок игрока, 10.10: «кидаю предметы — пусть думают, брать ли; ценное — союз»).
const worthOf = (n: string) => {
  const t = /^(netherite|diamond)_/.test(n) ? 5 : /^iron_/.test(n) ? 3 : /^(chainmail|golden|copper)_/.test(n) ? 2 : /^(stone|wooden|leather)_/.test(n) ? 1 : 0
  if (/_(helmet|chestplate|leggings|boots|sword|axe|spear)$/.test(n)) return t
  if (/^(enchanted_golden_apple|totem_of_undying|mace|trident)$/.test(n)) return 8
  if (/^(golden_apple|diamond|netherite_ingot)$/.test(n)) return 4
  if (/^(bow|crossbow|shield|splash_potion|potion|lingering_potion|iron_ingot)$/.test(n)) return 3
  if (/^(ender_pearl|arrow|wind_charge|firework_rocket|golden_carrot|cooked_\w+|bread|baked_potato)$/.test(n)) return 1
  return 0.2
}
// Снаряжён ли боец: оружие и не больше одной пустой части брони (видно глазами — что в руке и на теле).
const geared = (m: any) => !!m && Object.keys(m.inv || {}).some(n => WEAPON.test(n)) && Object.keys(ARMOR_SLOT).filter(sl => !(m.armor || {})[sl]).length < 2
// Сила бойца — по тому, что видно (пользователь 10.10: «не хардкодь блоки — адаптивно»): хп × оружие × броня (ступень
// материала). Только для сравнения «кто сильнее здесь», не модель урона. Спринт игрока — 5.6 бл./с (физика 1.21).
const SPRINT = 5.6
const power = (hp: number, inv: any, armor: any) => {
  const w = Object.keys(inv || {}).filter(n => WEAPON.test(n)).reduce((a, n) => Math.max(a, tierOf(n) + 2), 0)
  const a = Object.values(armor || {}).reduce((s: number, n: any) => s + (n ? tierOf(String(n)) + 2 : 0), 0) as number
  return Math.max(1, hp) * (1 + w / 4) * (1 + a / 18)
}
// Кто кого (10.10: «руками бьют меня в жёсткой броне — бесполезно, даже толпой; надо за лутом, потом драться»): урон
// по броне по формуле 1.21 (очки брони, твёрдость, защита EPF), темп удара оружия; бой «мы против него» — он валит
// нас по одному (слабейшего первым), наш общий урон падает с каждым. Видно глазами: оружие в руке, броня, блеск чар.
const WDMG = (n?: string) => !n ? 1 : /netherite_sword/.test(n) ? 8 : /diamond_sword/.test(n) ? 7 : /iron_sword/.test(n) ? 6 : /stone_sword/.test(n) ? 5 : /_sword/.test(n) ? 4
  : /^(netherite|diamond|iron|stone)_axe/.test(n) ? 9 : /_axe/.test(n) ? 7 : /^mace$/.test(n) ? 6 : /trident/.test(n) ? 9 : /_spear/.test(n) ? 5 : 1
const WSPD = (n?: string) => !n ? 4 : /_axe/.test(n) ? 0.9 : /^mace$/.test(n) ? 0.6 : /trident|_spear/.test(n) ? 1.1 : /_sword/.test(n) ? 1.6 : 4
const APTS: Record<string, number[]> = { leather: [1, 3, 2, 1], golden: [2, 5, 3, 1], chainmail: [2, 5, 4, 1], copper: [2, 4, 3, 1], iron: [2, 6, 5, 2], diamond: [3, 8, 6, 3], netherite: [3, 8, 6, 3], turtle: [2, 0, 0, 0] }
const armorStat = (armor: any, epf = 0) => {
  let pts = 0; let tough = 0
  for (const [k, sl] of [[0, 'head'], [1, 'torso'], [2, 'legs'], [3, 'feet']] as [number, string][]) {
    const n = String((armor || {})[sl] || ''); const mat = n.split('_')[0]
    if (APTS[mat]) { pts += APTS[mat][k]; tough += mat === 'netherite' ? 3 : mat === 'diamond' ? 2 : 0 }
  }
  return { pts, tough, epf }
}
const hitDmg = (d: number, A: any) => d * (1 - Math.min(20, Math.max(A.pts / 5, A.pts - 4 * d / (A.tough + 8))) / 25) * (1 - Math.min(20, A.epf) / 25)
const bestWeapon = (inv: any) => Object.keys(inv || {}).filter(n => WEAPON.test(n) && !/bow|crossbow/.test(n)).sort((a, b) => WDMG(b) * WSPD(b) - WDMG(a) * WSPD(a))[0]
const dpsOn = (att: any, def: any) => hitDmg(WDMG(att.weapon) + att.bonus, def.A) * (att.mob ? 1 : WSPD(att.weapon))
// edge — наш запас на удачу (криты, первый удар, его промахи): бежать, только когда проигрываешь и с ним, иначе равные
// бегут друг от друга (гонка 10.10: 31u бежал от 31t, а 31t — от 31u).
const winsAgainst = (us: any[], foe: any, edge = 1.5) => {
  let H = foe.hp; let D = us.reduce((s, f) => s + dpsOn(f, foe), 0) * edge
  for (const o of us.map(f => ({ f, t: f.hp / Math.max(0.05, dpsOn(foe, f)) })).sort((a, b) => a.t - b.t)) {
    if (D * o.t >= H) return true
    H -= D * o.t; D -= dpsOn(o.f, foe) * edge
  }
  return false
}
// Мобы (те же правила «кто кого»): хп, базовый урон (атрибут attack_damage 1.21 + оружие в руке), скорость погони бл/с.
const MOB_HP: Record<string, number> = { piglin_brute: 50, vindicator: 24, ravager: 100, iron_golem: 100, bogged: 16 }
const MOB_HIT: Record<string, number> = { zombie: 3, husk: 3, drowned: 3, zombie_villager: 3, wither_skeleton: 4, vindicator: 5, piglin_brute: 7, piglin: 5, skeleton: 2, stray: 2, bogged: 2, spider: 2, cave_spider: 2, ravager: 12, enderman: 7 }
const MOB_SPD: Record<string, number> = { zombie: 2.3, husk: 2.3, drowned: 2.3, wither_skeleton: 2.75, skeleton: 2.5, stray: 2.5, bogged: 2.5, vindicator: 3.5, piglin_brute: 3.5, spider: 4, cave_spider: 4, enderman: 6 }
const tierOf =(n: string) => ['wooden', 'golden', 'stone', 'copper', 'chainmail', 'iron', 'diamond', 'netherite'].findIndex(t => n.startsWith(t)) + (/^(mace|trident)$/.test(n) ? 6 : 0)

function props (i) { return fs.readFileSync(path.join(ROOT, 'farm', `server-${i}`, 'server.properties'), 'utf8') }
const prop = (p, k) => (p.match(new RegExp('^' + k.replace('.', '\\.') + '=(.*)$', 'm')) || [])[1]
// Одно соединение RCON на слот (колизей 10.10: соединение на команду — 3754 сокета в TIME_WAIT за три постройки по
// ~1800 команд, EADDRINUSE и падение гонки). Ответ — по номеру пакета; оборвалось — следующая команда откроет заново.
const pkt = (id, type, body) => { const b = Buffer.from(body, 'utf8'); const buf = Buffer.alloc(14 + b.length); buf.writeInt32LE(10 + b.length, 0); buf.writeInt32LE(id, 4); buf.writeInt32LE(type, 8); b.copy(buf, 12); return buf }
const RCON: Record<number, any> = {}
function rconConn (i) {
  if (RCON[i]?.ok) return RCON[i].ready
  const p = props(i)
  const port = Number(prop(p, 'rcon.port')); const pass = prop(p, 'rcon.password')
  const s: any = { ok: true, wait: new Map(), id: 10, acc: Buffer.alloc(0) }
  RCON[i] = s
  s.sock = net.connect(port, '127.0.0.1', () => s.sock.write(pkt(1, 3, pass)))
  s.ready = new Promise<any>((resolve, reject) => s.wait.set(1, { resolve: (_b, id) => id === -1 ? reject(new Error('rcon auth failed')) : resolve(s), reject }))
  s.sock.on('data', d => {
    s.acc = Buffer.concat([s.acc, d])
    while (s.acc.length >= 4) {
      const len = s.acc.readInt32LE(0)
      if (s.acc.length < len + 4) break
      const id = s.acc.readInt32LE(4); const body = s.acc.slice(12, len + 2).toString('utf8')
      s.acc = s.acc.slice(len + 4)
      const key = id === -1 ? 1 : id
      const w = s.wait.get(key); if (w) { s.wait.delete(key); w.resolve(body, id) }
    }
  })
  const fail = e => { s.ok = false; for (const w of s.wait.values()) w.reject(e); s.wait.clear() }
  s.sock.on('error', fail)
  s.sock.on('close', () => fail(new Error('rcon closed')))
  s.ready.catch(() => {})
  return s.ready
}
// LAN-мир пользователя (ARMS_LAN=<порт>, 10.10): RCON нет — команды шлёт бот-распорядитель чатом (в LAN с читами все —
// операторы, анти-спам их не кикает). Ответ ждём только у list и data get (системным сообщением); весь чат распорядителя —
// в свой журнал: по нему смерти, как по latest.log сервера фермы.
const LAN = Number(process.env.ARMS_LAN || 0)
const LAN_NAME = process.env.ARMS_LAN_CMD || 'NeuroArena'
const LAN_LOG = path.join(ROOT, 'farm', 'results', 'lan-chat.log')
let lanBot: Promise<any> | null = null
const lanWait: any[] = []
function lanConn () {
  if (lanBot) return lanBot
  lanBot = new Promise<any>((resolve, reject) => {
    const mf = require(path.join(ROOT, 'daemon', 'node_modules', 'mineflayer'))
    const bot = mf.createBot({ host: '127.0.0.1', port: LAN, username: LAN_NAME, version: '1.21.11', auth: 'offline' })
    bot.once('spawn', () => resolve(bot))
    bot.on('messagestr', (m) => {
      try { fs.appendFileSync(LAN_LOG, `[${new Date().toTimeString().slice(0, 8)}] [Server thread/INFO]: ${m}\n`) } catch {}
      const k = lanWait.findIndex(w => w.re.test(m)); if (k >= 0) lanWait.splice(k, 1)[0].resolve(m)
    })
    bot.on('kicked', r => log('распорядитель кикнут: ' + JSON.stringify(r)))
    bot.on('end', () => { lanBot = null })
    bot.on('error', e => { log('распорядитель: ' + e.message); lanBot = null; reject(e) })
  })
  return lanBot
}
let lanAt = 0
async function lanCmd (cmd, timeoutMs = 3000, re: RegExp | null = null) {
  const bot = await lanConn()
  const due = Math.max(lanAt + 8, Date.now()); lanAt = due; if (due > Date.now()) await sleep(due - Date.now()) // ≤ 125 команд/с
  const ent = /^data get entity (\S+)/.exec(cmd)
  re = re || (/^list/.test(cmd) ? /players online/ : ent ? new RegExp(`^(${ent[1]} has the following|No entity was found|Found no elements)`) : null)
  if (!re) { bot.chat('/' + cmd); return '' }
  return new Promise<any>(resolve => {
    const w = { re, resolve }; lanWait.push(w); bot.chat('/' + cmd)
    setTimeout(() => { const k = lanWait.indexOf(w); if (k >= 0) { lanWait.splice(k, 1); resolve('') } }, timeoutMs)
  })
}
function rcon (i, cmd, timeoutMs = 8000) {
  if (LAN) return lanCmd(cmd, Math.min(timeoutMs, 3000))
  return rconConn(i).then((s: any) => new Promise<any>((resolve, reject) => {
    const id = ++s.id
    const t = setTimeout(() => { s.wait.delete(id); reject(new Error('rcon timeout')) }, timeoutMs)
    s.wait.set(id, { resolve: (b) => { clearTimeout(t); resolve(b) }, reject: (e) => { clearTimeout(t); reject(e) } })
    s.sock.write(pkt(id, 2, cmd))
  }))
}
const portOpen = port => new Promise<any>(resolve => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(true) }); s.once('error', () => resolve(false)) })

function client (url) {
  const ws = new WebSocket(url); let id = 0; const pending = new Map()
  ws.on('message', raw => { const m = JSON.parse(raw.toString()); const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.ok ? p.resolve(m.result) : p.reject(new Error(m.error)) })
  const ready = new Promise<any>((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  const call = (method, params: any = {}) => new Promise<any>((resolve, reject) => { const rid = ++id; pending.set(rid, { resolve, reject }); ws.send(JSON.stringify({ id: rid, method, params })) })
  return { ws, ready, call }
}

function codeDir (i) {
  let code = process.env.FFA_CODE || null
  if (!code) try { code = JSON.parse(fs.readFileSync(path.join(ROOT, 'farm', 'slots.json'), 'utf8')).slots?.[i]?.code || null } catch {}
  return code ? path.join(ROOT, '.daemon-' + code) : path.join(ROOT, 'daemon')
}
async function up (i, n) {
  const cwd = codeDir(i)
  for (let k = 0; k < n; k++) {
    const s = extra(i, k)
    if (await portOpen(s.ws)) { log(`${s.name}: уже ${s.ws}`); continue }
    fs.mkdirSync(s.mem, { recursive: true })
    const out = fs.openSync(path.join(ROOT, 'farm', `daemon-ffa-${s.name}.out.log`), 'w')
    const env = { ...process.env, ND_WS_PORT: String(s.ws), MC_USERNAME: s.name, MC_PORT: String(LAN || 25600 + i), ND_VIEWER_PORT: String(s.viewer), ND_MEMORY_DIR: s.mem }
    const p = spawn(process.execPath, ['src/index.js'], { cwd, env, detached: true, stdio: ['ignore', out, out], windowsHide: true })
    p.unref()
    try { require('os').setPriority(p.pid, require('os').constants.priority.PRIORITY_BELOW_NORMAL) } catch {}
    for (let t = 0; t < 30 && !(await portOpen(s.ws)); t++) await sleep(1000)
    log(`${s.name}: демон ${s.ws} ${await portOpen(s.ws) ? '✓' : 'НЕ поднялся'} (${path.basename(cwd)})`)
  }
}
function down (i) {
  for (let k = 0; k < EXTRA.length; k++) {
    const s = extra(i, k)
    try {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' })
      const line = out.split(/\r?\n/).map(l => l.trim().split(/\s+/)).find(m => m.length >= 5 && m[3] === 'LISTENING' && m[1].endsWith(':' + s.ws))
      if (line) { process.kill(Number(line[4])); log(`${s.name}: погашен`) }
    } catch {}
  }
}

const ARMOR = ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots']
const KITS = {
  elytra: ['elytra', 'firework_rocket 48', 'iron_spear', 'diamond_sword', 'golden_apple 4', 'water_bucket', 'cobblestone 32', 'splash_potion[potion_contents={potion:"minecraft:strong_healing"}] 2'],
  sword: ['diamond_sword', 'diamond_axe', 'shield', 'golden_apple 4', 'cobblestone 32'],
  // Кристаллы — как набор арены «кристаллы» (arena.ts): тотем в левой руке, обсидиан под кристаллы, «Взрывоустойчивость» на поножах.
  arms: [],
  // Командный: зелья лечения — бросать союзникам, булыжник — стенки прикрытия.
  team: ['diamond_sword', 'diamond_axe', 'golden_apple 2', 'splash_potion[potion_contents={potion:"minecraft:strong_healing"}] 6', 'cobblestone 64'],
  // Командный в воздухе: элитры и копьё + зелья своим (бросок и с полёта) и блоки.
  teamair: ['elytra', 'firework_rocket 48', 'iron_spear', 'diamond_sword', 'golden_apple 2', 'splash_potion[potion_contents={potion:"minecraft:strong_healing"}] 4', 'water_bucket', 'cobblestone 32'],
  teamcrystal: ['diamond_sword[enchantments={sharpness:5}]', 'end_crystal 64', 'obsidian 64', 'bow[enchantments={power:1}]', 'golden_apple 8', 'totem_of_undying 3', 'arrow 64', 'splash_potion[potion_contents={potion:"minecraft:strong_healing"}] 4', 'cobblestone 32'],
  crystal: ['diamond_sword[enchantments={sharpness:5}]', 'end_crystal 64', 'obsidian 64', 'bow[enchantments={power:1}]', 'golden_apple 12', 'totem_of_undying 4', 'arrow 64', 'enchanted_golden_apple 1']
}
const ARMOR_OF = {
  teamcrystal: ['diamond_helmet[enchantments={protection:4,unbreaking:3}]', 'diamond_chestplate[enchantments={protection:4,unbreaking:3}]', 'diamond_leggings[enchantments={blast_protection:4,unbreaking:3}]', 'diamond_boots[enchantments={protection:4,unbreaking:3}]'],
  crystal: ['diamond_helmet[enchantments={protection:4,unbreaking:3}]', 'diamond_chestplate[enchantments={protection:4,unbreaking:3}]', 'diamond_leggings[enchantments={blast_protection:4,unbreaking:3}]', 'diamond_boots[enchantments={protection:4,unbreaking:3}]']
}
const OFFHAND = { crystal: 'totem_of_undying', teamcrystal: 'totem_of_undying' }
// Бой взрывами: цель — куча врагов, свои — врозь.
const BLAST = /crystal/
async function dress (i, who, kit) {
  await rcon(i, `clear ${who}`)
  await rcon(i, `effect clear ${who}`)
  for (const [a, slot] of (ARMOR_OF[kit] || ARMOR).map((a, k) => [a, ['armor.head', 'armor.chest', 'armor.legs', 'armor.feet'][k]])) await rcon(i, `item replace entity ${who} ${slot} with minecraft:${a}`)
  if (OFFHAND[kit]) await rcon(i, `item replace entity ${who} weapon.offhand with minecraft:${OFFHAND[kit]}`)
  for (const it of KITS[kit]) { const [n, c] = it.split(/ (?=\d+$)/); await rcon(i, `give ${who} minecraft:${n} ${c || 1}`) }
  await rcon(i, `effect give ${who} minecraft:instant_health 1 10 true`)
  await rcon(i, `effect give ${who} minecraft:saturation 1 20 true`)
}
const spot = (k, n) => { const a = 2 * Math.PI * k / n; return `${(X + 0.5 + Math.cos(a) * 14).toFixed(1)} ${Y + 1} ${(Z + 0.5 + Math.sin(a) * 14).toFixed(1)}` }

async function run (i, kit = 'elytra', { teams = false, arms = false } = {}) {
  // Гонка вооружений командой: карта arms-layout (сундуки, тайники, комнаты), старт пустым, лут → каптёр → бой.
  // ARMS_MAP=colosseum — гонка в Колизее (daemon/colosseum-arms: камеры, лаборатория, галереи, лестницы); иначе arms-layout.
  const COLOS_MAP = process.env.ARMS_MAP === 'colosseum'
  const AL = arms ? require(path.join(ROOT, 'daemon', COLOS_MAP ? 'colosseum-arms' : 'arms-layout')) : null
  const L = arms ? AL.generate(process.env.SEED || 'team1') : null
  // Набивка сундуков — на каждый раунд своя (зерно: seed карты + номер раунда).
  let stockChests = async (_round: number) => {}
  let restoreArena = async () => {}
  let spawnAt: any = null
  const perches: any[] = []
  if (arms) {
    const [ax, ay, az] = (process.env.ARMS_POS || (COLOS_MAP ? '600 120 600' : '2000 100 2000')).split(/\s+/).map(Number)
    X = ax; Y = ay; Z = az; R = COLOS_MAP ? L.half : 27 // бой по всему Колизею, не только по полю
    await rcon(i, `forceload add ${X - L.half} ${Z - L.half} ${X + L.half} ${Z + L.half}`).catch(() => {})
    // Колизей — заново каждый раунд (10.10: «скидывай все блоки каждый раунд, а то засирается»): чистая копия постройки
    // лежит в стороне (X+400, снята один раз после полной перестройки), раунд — clone копии на место + раскладка (поле,
    // сундуки) поверх. Копия — слоями по 1 блоку (clone ≤ 32768 блоков). ARMS_RESET=0 — без копии, как было.
    let bad = 0
    restoreArena = async () => {
      const SX = 400; const h = L.half; const y0 = Y + L.y0; const y1 = Y + L.y1
      if (COLOS_MAP && process.env.ARMS_RESET !== '0') {
        const flagF = path.join(ROOT, 'farm', 'results', `colos-stash-${i}.json`)
        const want = `${X} ${Y} ${Z} h${h} y${L.y0}..${L.y1}`
        await rcon(i, `forceload add ${X + SX - h} ${Z - h} ${X + SX + h} ${Z + h}`).catch(() => {})
        let have = ''; try { have = JSON.parse(fs.readFileSync(flagF, 'utf8')).at } catch {}
        if (have !== want) {
          const t0 = Date.now()
          const CZB = require(path.join(ROOT, 'daemon', 'build-colosseum'))
          const P = CZB.plan({ X, Y, Z, R: 24, ceilH: 16 })
          for (const c of [...P.clear, ...P.cmds, ...P.field]) await rcon(i, c.replace(/^\//, ''), 20000).catch(() => {})
          for (let y = y0; y <= y1; y++) await rcon(i, `clone ${X - h} ${y} ${Z - h} ${X + h} ${y} ${Z + h} ${X + SX - h} ${y} ${Z - h}`, 20000).catch(() => {})
          fs.writeFileSync(flagF, JSON.stringify({ at: want, builtAt: new Date().toISOString() }))
          log(`гонка: Колизей перестроен целиком и снят в копию (${P.cmds.length} команд, ${Math.round((Date.now() - t0) / 1000)} с)`)
        }
        const t1 = Date.now()
        for (let y = y0; y <= y1; y++) await rcon(i, `clone ${X + SX - h} ${y} ${Z - h} ${X + SX + h} ${y} ${Z + h} ${X - h} ${y} ${Z - h}`, 20000).catch(() => {})
        log(`гонка: Колизей восстановлен из копии за ${((Date.now() - t1) / 1000).toFixed(1)} с`)
      }
      bad = 0
      for (const c of AL.commands(L, { X, Y, Z })) { const r = await rcon(i, c, 20000).catch(e => String(e)); if (/Unknown|Incorrect|Expected|not loaded|Too many|timeout/i.test(r)) bad++ }
      // Точка возрождения людей — в центре поля на земле (10.10: «точка возрождения сломалась»: рельеф поля каждый раунд
      // новый, и старая точка оказалась в блоке — сервер сбросил её на спавн мира). Ищу 2 клетки воздуха над опорой.
      let sy = Y
      for (let y = Y; y < Y + 10; y++) if (/passed/.test(String(await rcon(i, `execute if block ${X} ${y} ${Z} minecraft:air if block ${X} ${y + 1} ${Z} minecraft:air unless block ${X} ${y - 1} ${Z} minecraft:air`).catch(() => '')))) { sy = y; break }
      const ppl = String(await rcon(i, 'list').catch(() => '')).replace(/^.*online:\s*/, '').split(/,\s*/).map(x => x.trim()).filter(x => x && !x.startsWith(`NeuroFarm${i}`) && x !== LAN_NAME)
      for (const h of ppl) await rcon(i, `spawnpoint ${h} ${X} ${sy} ${Z}`).catch(() => {})
      spawnAt = { x: X, y: sy, z: Z }
    }
    await restoreArena()
    await rcon(i, `kill @e[type=!minecraft:player,x=${X - L.half},y=${Y + L.y0},z=${Z - L.half},dx=${2 * L.half},dy=${L.y1 - L.y0},dz=${2 * L.half}]`).catch(() => {})
    // Насесты (10.10: «жемчуг высоко на Колизей — никто не достанет»): клетки, где можно стоять, на крышах ярусов и
    // вершинах (модель постройки: опора, над ней 2 воздуха; 11+ над полем). Туда бросает жемчуг тот, кому не убежать.
    if (COLOS_MAP) {
      const g = require(path.join(ROOT, 'daemon', 'build-colosseum')).plan({ X, Y, Z, R: 24, ceilH: 16 }).m.g
      const pal = (x, y, z) => (x < g.x0 || x > g.x1 || y < g.y0 || y > g.y1 || z < g.z0 || z > g.z1) ? 'air' : (g.pal[g.data[g.i(x, y, z)]] || 'air')
      const solid = (x, y, z) => { const n = pal(x, y, z); return n !== 'air' && !/air|slab|stairs|fence|wall|pane|bars|torch|lantern/.test(n) }
      for (let x = g.x0; x <= g.x1; x += 2) for (let z = g.z0; z <= g.z1; z += 2) for (let y = g.y1; y >= 11; y--) {
        if (!solid(x, y, z)) continue
        if (pal(x, y + 1, z) === 'air' && pal(x, y + 2, z) === 'air') perches.push({ x: X + x + 0.5, y: Y + y + 1, z: Z + z + 0.5 })
        break
      }
    }
    log(`гонка: карта seed ${L.seed} у ${X} ${Y} ${Z} — сундуков ${L.chests.length}, команд не прошло ${bad}`)
    // Свой лут на 12 бойцов (пользователь 10.10: «добавь ресурсов, покруче»): карта arms-layout рассчитана на дуэль —
    // 14 оружия на 12, лава в сундуках. Сундук очищается и набивается заново (seed): оружие железо/алмаз, броня,
    // щиты, яблоки, зелья, жемчуг, еда, блоки; тайники — лучше. Нарочно неровно: кому-то два меча, кому-то пусто —
    // каптёру есть что делить. ARMS_LOOT=layout — как было.
    stockChests = async (round: number) => {
      if (process.env.ARMS_LOOT === 'layout') return
      let seed = [...(String(L.seed) + ':' + round)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7)
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
      const pickOne = (arr) => arr[Math.floor(rnd() * arr.length)]
      const pot = (kind, name) => `${kind}[potion_contents={potion:"minecraft:${name}"}]`
      const heal = pot('splash_potion', 'strong_healing')
      const stats = { weapons: 0, armor: 0, items: 0 }
      const used = new Map<string, number>()
      for (const c of L.chests) {
        const hidden = /secret|under|niche/.test(c.kind)
        const mat = () => (rnd() < (hidden ? 0.6 : 0.25) ? 'diamond' : 'iron')
        const items: string[] = []
        // Оружие (пользователь 10.10: «разное — булава, копьё, чарованное; лут как в сундуках Края»): в 80% сундуков, в
        // тайнике — и второе; чары — в 40% (тайник 70%), уровни случайны. Тайник — лут города Края: алмаз, изредка незерит.
        const lv = (max) => 1 + Math.floor(rnd() * max)
        const ench = (base, list) => rnd() < (hidden ? 0.7 : 0.4) ? `${base}[enchantments={${list.filter(() => rnd() < 0.7).join(',') || list[0]}}]` : base
        const mat2 = () => hidden && rnd() < 0.08 ? 'netherite' : mat()
        for (let w = 0; w < (hidden ? 3 : 2); w++) if (rnd() < 0.8) {
          const kind = pickOne(['sword', 'sword', 'sword', 'axe', 'axe', 'spear', 'spear', 'mace', 'trident', 'bow', 'bow', 'crossbow'])
          const m = mat2()
          if (kind === 'sword') items.push(ench(`${m}_sword`, [`sharpness:${lv(5)}`, `fire_aspect:${lv(2)}`, `knockback:${lv(2)}`, 'sweeping_edge:2']) + ' 1')
          else if (kind === 'axe') items.push(ench(`${m}_axe`, [`sharpness:${lv(5)}`, 'efficiency:3']) + ' 1')
          else if (kind === 'spear') items.push(ench(`${m === 'netherite' ? 'diamond' : m}_spear`, [`sharpness:${lv(5)}`, `knockback:${lv(2)}`]) + ' 1')
          else if (kind === 'mace') items.push(ench('mace', [`density:${lv(5)}`, `breach:${lv(4)}`, 'wind_burst:1']) + ' 1', 'wind_charge 6')
          else if (kind === 'trident') items.push(ench('trident', [`impaling:${lv(5)}`, `loyalty:${lv(3)}`]) + ' 1')
          else if (kind === 'bow') items.push(ench('bow', [`power:${lv(5)}`, `punch:${lv(2)}`, 'flame:1']) + ' 1', 'arrow 32')
          else items.push(ench('crossbow', [`quick_charge:${lv(3)}`, 'multishot:1', `piercing:${lv(4)}`]) + ' 1', 'arrow 32')
          stats.weapons++
        }
        const nArmor = Math.floor(rnd() * (hidden ? 3 : 2)) + 2
        for (let a = 0; a < nArmor; a++) {
          const piece = pickOne(['helmet', 'chestplate', 'leggings', 'boots'])
          items.push(ench(`${mat2()}_${piece}`, [`protection:${lv(4)}`, 'unbreaking:3', ...(piece === 'boots' ? [`feather_falling:${lv(4)}`] : []), ...(piece === 'leggings' ? [`blast_protection:${lv(4)}`] : [])]) + ' 1')
          stats.armor++
        }
        for (let e = 0; e < 2 + (hidden ? 2 : 1); e++) items.push(pickOne(['golden_apple 2', `${heal} 2`, 'shield 1', 'ender_pearl 2', 'cooked_beef 8', 'cobblestone 32', 'golden_apple 1', `${heal} 1`, 'wind_charge 4', 'wind_charge 8']))
        if (hidden && rnd() < 0.12) items.push('enchanted_golden_apple 1')
        // Щит — в каждом втором (10.10: «от булавы без щита не защищаются»; щит держит и смэш булавы).
        if (rnd() < 0.5) items.push('shield 1')
        // Чем уничтожать чужой лут (лава, огонь): ведро лавы, огниво, огненный заряд — иногда.
        if (rnd() < 0.3) items.push(pickOne(['flint_and_steel 1', 'lava_bucket 1', 'fire_charge 3']))
        // Ведро воды (10.10: «гасить урон от падения и тушиться, а то не хватает») — в 45% сундуков.
        if (rnd() < 0.45) items.push('water_bucket 1')
        // Паутина — закрыть проход за собой (10.10).
        if (rnd() < 0.4) items.push('cobweb 4')
        if (hidden && rnd() < 0.1) items.push('totem_of_undying 1')
        // Зелья (пользователь 10.10: «больше зелий — хилок и опасных»): лечение чаще всего, вред/яд взрывные, сила/реген.
        for (let e = 0; e < (hidden ? 4 : 3); e++) items.push(pickOne([`${heal} 2`, `${heal} 1`, `${heal} 2`, pot('splash_potion', 'strong_harming') + ' 1', pot('splash_potion', 'harming') + ' 2',
          pot('splash_potion', 'poison') + ' 1', pot('potion', 'strength') + ' 1', pot('potion', 'regeneration') + ' 1']))
        // Баффы (10.10: «больше зелий — усиления на скорость, урон, чтобы ускорялись жёстко и мочили»): в каждом сундуке
        // 2 (тайник 3). Скорость и сила — сверх обычных (Скорость IV, Сила III на 90 с); основа — strong_* (бой их
        // узнаёт по potion и пьёт сам: перед боем и между разменами).
        const fx = (base, id, amp, sec) => `potion[potion_contents={potion:"minecraft:${base}",custom_effects:[{id:"minecraft:${id}",amplifier:${amp},duration:${sec * 20}}]}]`
        for (let e = 0; e < (hidden ? 3 : 2); e++) items.push(pickOne([fx('strong_swiftness', 'speed', 3, 90) + ' 1', fx('strong_swiftness', 'speed', 3, 90) + ' 2', fx('strong_strength', 'strength', 2, 90) + ' 1',
          fx('strong_strength', 'strength', 2, 90) + ' 2', pot('potion', 'strong_regeneration') + ' 1', pot('potion', 'long_fire_resistance') + ' 1', pot('potion', 'strong_turtle_master') + ' 1',
          pot('potion', 'strong_leaping') + ' 1', pot('splash_potion', 'strong_slowness') + ' 1', pot('splash_potion', 'long_weakness') + ' 1']))
        // Алхимия и кузница — по частям в разных сундуках: полный набор только у команды вместе (свозят алхимику).
        if (rnd() < 0.45) items.push(pickOne(['nether_wart 3', 'glistering_melon_slice 3', 'glowstone_dust 3', 'gunpowder 3', 'blaze_powder 2', 'glass_bottle 3', 'fermented_spider_eye 2']))
        if (rnd() < 0.3) items.push(pickOne(['iron_ingot 2', 'diamond 2', 'stick 2']))
        // Кирки (10.10: «добавь в сундуки кирки — ботам не хватает»): ломать стенки, столбы, крышки нычек; и набор на
        // свою кирку — 3 слитка/алмаза, 2 палки, верстак (крафтят сами, если кирки нет).
        if (rnd() < 0.45) items.push(ench(`${mat2()}_pickaxe`, [`efficiency:${lv(5)}`, 'unbreaking:3']) + ' 1')
        if (rnd() < 0.2) items.push(pickOne(['iron_ingot 3', 'diamond 3']), 'stick 2', 'crafting_table 1')
        const p = { x: X + c.x, y: Y + c.y, z: Z + c.z }
        await rcon(i, `data merge block ${p.x} ${p.y} ${p.z} {Items:[]}`).catch(() => {})
        let slot = 0
        used.set(c.id, items.length)
        for (const it of items) { const [n, k] = it.split(/ (?=\d+$)/); await rcon(i, `item replace block ${p.x} ${p.y} ${p.z} container.${slot++} with minecraft:${n} ${k || 1}`).catch(() => {}); stats.items++ }
      }
      {
        const secretChests = L.chests.filter(c => /secret|under|niche/.test(c.kind))
        const c = secretChests[Math.floor(rnd() * secretChests.length)]
        if (c) for (const it of ['elytra[enchantments={unbreaking:3}] 1', 'firework_rocket 24']) {
          const [n, cnt] = it.split(/ (?=\d+$)/); const sl = used.get(c.id) || 0; used.set(c.id, sl + 1)
          await rcon(i, `item replace block ${X + c.x} ${Y + c.y} ${Z + c.z} container.${sl} with minecraft:${n} ${cnt}`).catch(() => {})
        }
        if (c) log(`гонка: элитры в этом раунде — тайник ${c.room}`)
      }
      // Полный набор на взрывное лечение — на каждой половине карты (запад — красным, восток — синим), каждый
      // ингредиент в своём сундуке: сварит команда, что обыщет свою сторону и свезёт алхимику (10.10: случайно — не собирался).
      for (const side of [-1, 1]) {
        const mine = L.chests.filter(c => c.x * side > 0).sort(() => rnd() - 0.5)
        const SET = ['nether_wart 3', 'glistering_melon_slice 3', 'glowstone_dust 3', 'gunpowder 3', 'blaze_powder 2', 'glass_bottle 3', 'fermented_spider_eye 1']
        // Кузница: слитки и алмазы — вместе с палкой (в одном сундуке: крафт меча без своза).
        for (const [k, pair] of [['iron_ingot 2', 'stick 1'], ['diamond 2', 'stick 1']].entries()) {
          const c = mine[(SET.length + k) % mine.length]; if (!c) continue
          for (const it of pair) { const [n, cnt] = it.split(/ (?=\d+$)/); const sl = used.get(c.id) || 0; used.set(c.id, sl + 1); rcon(i, `item replace block ${X + c.x} ${Y + c.y} ${Z + c.z} container.${sl} with minecraft:${n} ${cnt}`).catch(() => {}) }
        }
        SET.forEach((it, k) => {
          const c = mine[k % mine.length]; if (!c) return
          const [n, cnt] = it.split(/ (?=\d+$)/); const sl = used.get(c.id) || 0; used.set(c.id, sl + 1)
          rcon(i, `item replace block ${X + c.x} ${Y + c.y} ${Z + c.z} container.${sl} with minecraft:${n} ${cnt}`).catch(() => {})
        })
      }
      await sleep(500)
      // Припасы лаборатории (гонка 10: набор по сундукам поля не собирался ни разу — обыскивали не все) — по набору
      // на каждую команду; алхимик берёт только недостающее, так что второй команде тоже останется.
      const LC = { x: X + L.lab.brewing.x - 1, y: Y + L.lab.brewing.y, z: Z + L.lab.brewing.z }
      await rcon(i, `setblock ${LC.x} ${LC.y} ${LC.z} chest[facing=south]`).catch(() => {})
      for (const [k, it] of ['nether_wart 2', 'glistering_melon_slice 2', 'glowstone_dust 2', 'gunpowder 2', 'blaze_powder 4', 'glass_bottle 6', 'fermented_spider_eye 2'].entries())
        await rcon(i, `item replace block ${LC.x} ${LC.y} ${LC.z} container.${k} with minecraft:${it}`).catch(() => {})
      log(`гонка: сундуки набиты (раунд ${round}) — оружия ${stats.weapons}, брони ${stats.armor}, всего предметов ${stats.items} (без лавы)`)
    }
    await stockChests(1)
  }
  const bots: any[] = []
  for (const s of [{ name: `NeuroFarm${i}`, ws: 8800 + i }, { name: `NeuroFarm${i}b`, ws: 8900 + i }, ...[...EXTRA].map((_, k) => extra(i, k))]) if (await portOpen(s.ws)) bots.push({ name: s.name, ws: s.ws })
  const N = bots.length
  // Нрав — по кругу: в одной толпе разные почерки (crowd.PERSONAS).
  const PERS = Object.keys(crowd.PERSONAS)
  bots.forEach((b, k) => { b.persona = process.env.FFA_PERSONA || PERS[k % PERS.length] })
  // Команды (6 на 6): красные и синие через одного, цветные ники, без урона по своим.
  if (teams) bots.forEach((b, k) => { b.team = k % 2 ? 'blue' : 'red' })
  const teamOf = n => bots.find(b => b.name === n)?.team
  log(`${teams ? 'команды' : 'дезматч'}: ${N} бойцов (${bots.map(b => `${b.name} — ${b.persona}`).join(', ')}), набор ${kit}, цель — по толпе (pvp/crowd), пересмотр ≤ ${SEG_S} с`)
  for (const b of bots) { b.c = client(`ws://127.0.0.1:${b.ws}`); await b.c.ready; await b.c.call('connect').catch(() => {}); await b.c.call('temper', { enabled: false }).catch(() => {}); await b.c.call('play_mode', { mode: 'free' }).catch(() => {}) }
  if (teams) {
    for (const [t, color] of [['red', 'red'], ['blue', 'blue']]) {
      await rcon(i, `team add ${t}`).catch(() => {})
      await rcon(i, `team modify ${t} color ${color}`).catch(() => {})
      await rcon(i, `team modify ${t} friendlyFire false`).catch(() => {})
      // По одному: team join берёт одного участника, списком через пробел — никого (10.10: команды были пусты, 4 убийства своих).
      for (const b of bots.filter(b => b.team === t)) await rcon(i, `team join ${t} ${b.name}`).catch(() => {})
    }
  }
  for (const c of ['gamerule immediate_respawn true', `gamerule keep_inventory ${arms && process.env.ARMS_KEEP !== '1' ? 'false' : 'true'}`, 'gamerule spawn_mobs false', LAN ? 'gamerule log_admin_commands false' : 'gamerule send_command_feedback false', 'gamerule advance_time false', 'time set day', 'weather clear']) await rcon(i, c).catch(() => {})
  const pos: Record<string, any> = {}
  const deaths: Record<string, number> = {}
  const kills: Record<string, number> = {}
  const LOGF = LAN ? LAN_LOG : path.join(ROOT, 'farm', `server-${i}`, 'logs', 'latest.log')
  if (LAN && !fs.existsSync(LOGF)) fs.writeFileSync(LOGF, '')
  let logAt = fs.statSync(LOGF).size
  const names = bots.map(b => b.name)
  const deadNow = new Set<string>()
  // Раунды гонки (пользователь 10.10): погибший — зритель до конца раунда; вся команда выбыла — новый раунд для всех.
  const out = new Set<string>()
  const deathAt: Record<string, any> = {}
  // Сундуки раунда: открытые и чей заявлен (двое к одному не бегут).
  const opened = new Set<string>()
  const chestBy = new Map<string, string>()
  const chestFail = new Map<string, number>()
  const roundWins = { red: 0, blue: 0 }
  let round = 1
  let between = false
  let roundT0 = Date.now()
  // Охота (10.10: «когда мало ботов остаётся, тупят — активнее искать соперников»): убийств давно нет (вдвое дольше
  // обычного промежутка в этом раунде, не меньше 20 с) или живых осталась треть — без отходов, сборов и ожиданий,
  // все идут на ближайшего врага.
  let lastKillAt = Date.now(); const killGaps: number[] = []; let huntSaid = false
  const hunt = () => {
    if (!arms || between) return false
    const g = [...killGaps].sort((a, c) => a - c)[killGaps.length >> 1] || 0
    const live = names.filter(n => pos[n]?.hp > 0 && !deadNow.has(n) && !out.has(n))
    // Пока большинство голые — это лут, а не затишье (охота включалась на 21-й секунде раунда).
    const armed = live.filter(n => geared(pos[n])).length >= live.length / 2
    const on = (armed && Date.now() - lastKillAt > Math.max(20000, 2 * g)) || live.length <= names.length / 3
    if (on && !huntSaid) { huntSaid = true; log(`⚡ охота: ${Math.round((Date.now() - lastKillAt) / 1000)} с без убийств — все ищут врагов, без отходов и сборов`) }
    if (!on) huntSaid = false
    return on
  }
  // Смерти и убийства — по журналу сервера (кто кого: «X was slain/speared by Y»).
  // Набор живому игроку после смерти (пользователь 10.10: «после смерти выдавай всё снова и скорость»): силач против толпы.
  // ARMS_HUMAN_KIT=0 — выкл. Вещи погибшего остаются на земле — их лутают боты.
  const E = 'enchantments={'
  const HUMAN_KIT = [`netherite_sword[${E}sharpness:30,fire_aspect:3,knockback:1,looting:3,sweeping_edge:3,unbreaking:3,mending:1}] 1`, `mace[${E}density:5,wind_burst:3,unbreaking:3}] 1`,
    `bow[${E}power:5,punch:2,flame:1,infinity:1}] 1`, 'arrow 1', `shield[${E}unbreaking:3}] 1`, 'golden_apple 16', 'enchanted_golden_apple 2', 'totem_of_undying 2',
    'wind_charge 64', 'ender_pearl 16', 'cooked_beef 32']
  const HUMAN_ARMOR = [['armor.head', `netherite_helmet[${E}protection:4,unbreaking:3,mending:1}]`], ['armor.chest', `netherite_chestplate[${E}protection:4,unbreaking:3,mending:1}]`],
    ['armor.legs', `netherite_leggings[${E}protection:4,unbreaking:3,mending:1}]`], ['armor.feet', `netherite_boots[${E}protection:4,feather_falling:4,unbreaking:3,mending:1}]`]]
  const kitHuman = async (h) => {
    if (process.env.ARMS_HUMAN_KIT === '0') return
    // Дождаться живого (экран смерти — выданное мёртвому пропадает при возрождении): хп > 0 два опроса подряд.
    let ok = 0
    for (let t = 0; t < 60 && ok < 2; t++) { await sleep(500); const hp = /([\d.]+)f/.exec(String(await rcon(i, `data get entity ${h} Health`).catch(() => ''))); ok = hp && +hp[1] > 0 ? ok + 1 : 0 }
    if (ok < 2) { log(`🎽 ${h} не возродился за 30 с — набор не выдан`); return }
    for (const [slot, it] of HUMAN_ARMOR) await rcon(i, `item replace entity ${h} ${slot} with minecraft:${it}`).catch(() => {})
    for (const it of HUMAN_KIT) { const [n, c] = it.split(/ (?=\d+$)/); await rcon(i, `give ${h} minecraft:${n} ${c || 1}`).catch(() => {}) }
    await rcon(i, `effect give ${h} minecraft:speed infinite 4 true`).catch(() => {})
    await rcon(i, `effect give ${h} minecraft:strength infinite 1 true`).catch(() => {})
    await rcon(i, `effect give ${h} minecraft:resistance 4 4 true`).catch(() => {})
    log(`🎽 ${h} возродился — набор и «Скорость V» выданы`)
  }
  const readDeaths = () => {
    try {
      const st = fs.statSync(LOGF); if (st.size <= logAt) return
      const fd = fs.openSync(LOGF, 'r'); const buf = Buffer.alloc(st.size - logAt); fs.readSync(fd, buf, 0, buf.length, logAt); fs.closeSync(fd); logAt = st.size
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        const m = /\]: (NeuroFarm\S+) (was .+|died.*|fell.+|hit the ground.*|burned.*|tried to swim.*|drowned.*|experienced kinetic.*|suffocated.*|starved.*|froze.*|withered.*|went up in flames.*|blew up.*|walked into.*|discovered.*|left the confines.*)$/.exec(line)
        const hm = !m && /\]: (\S+) (was .+|died.*|fell.+|hit the ground.*|burned.*|tried to swim.*|drowned.*|experienced kinetic.*|suffocated.*|starved.*|froze.*|withered.*|went up in flames.*|blew up.*|walked into.*|discovered.*|left the confines.*)$/.exec(line)
        if (hm && humans[hm[1]] && !names.includes(hm[1])) {
          log(`☠ ${hm[1]} ${hm[2]}`); kitHuman(hm[1])
          // Его вещи на земле — лут для бойцов, не подарок (10.10: выпавший трезубец засчитался союзом).
          if (humans[hm[1]].p) deathAt[hm[1]] = { p: humans[hm[1]].p, at: Date.now(), looted: new Set<string>(), inv: {}, armor: {}, team: null }
        }
        if (!m || !names.includes(m[1])) continue
        deaths[m[1]] = (deaths[m[1]] || 0) + 1
        const by = names.find(n => n !== m[1] && (' ' + m[2] + ' ').includes(' ' + n + ' '))
        if (by) { kills[by] = (kills[by] || 0) + 1; const kb = bots.find(o => o.name === by); if (kb) emote(kb, Math.random() < 0.6 ? 'crouch' : 'wave') }
        const byH = Object.keys(humans).find(h => (' ' + m[2] + ' ').includes(' ' + h + ' '))
        if (byH && teams) relSay(teamOf(m[1]), byH, -5, `убил ${m[1]}`)
        deadNow.add(m[1])
        killGaps.push(Date.now() - lastKillAt); lastKillAt = Date.now()
        if (pos[m[1]]?.p) deathAt[m[1]] = { p: pos[m[1]].p, at: Date.now(), looted: new Set<string>(), inv: pos[m[1]].inv || {}, armor: pos[m[1]].armor || {}, team: teamOf(m[1]), byMob: !by && !byH && / by /.test(m[2]) }
        log(`☠ ${m[1]} ${m[2]}`)
      }
    } catch {}
  }
  const board = () => names.map(n => `${teams ? (teamOf(n) === 'red' ? '🟥' : '🟦') : ''}${n.replace(`NeuroFarm${i}`, '#') || '#'}: ${kills[n] || 0}/${deaths[n] || 0}`).join('  ') +
    (teams ? `  | 🟥 ${names.filter(n => teamOf(n) === 'red').reduce((a, n) => a + (kills[n] || 0), 0)} : ${names.filter(n => teamOf(n) === 'blue').reduce((a, n) => a + (kills[n] || 0), 0)} 🟦` : '')
  // Команды — по своим сторонам поля (красные с запада, синие с востока); дезматч — кольцом.
  // Точка входа — центр своей стороны (команды) или кольца; ставит spreadplayers на свободный верх под барьерным
  // потолком (tp в рельеф: двое красных задохнулись в стене, 10.10).
  const home = (b, k) => teams ? `${X + (b.team === 'red' ? -12 : 12)} ${Z + (k % 6) * 3 - 7}` : spot(k, N).split(' ').filter((_, j) => j !== 1).join(' ')
  const place = (name, at) => rcon(i, `spreadplayers ${at} 0 3 under ${Y + 15} false ${name}`)
  // Гонка: старт — точки раскладки (запад красным, восток синим), пустыми; после смерти вещи при себе (keep_inventory).
  const armsHome = (b, k) => { const s0 = L.spawns[b.team === 'red' ? 0 : 1]; return { x: X + s0.x + 0.5, y: Y + s0.y, z: Z + s0.z + ((k >> 1) % 12) - 6 + 0.5 } }
  const reset = async (name) => { for (const c of [`gamemode survival ${name}`, `clear ${name}`, `effect clear ${name}`, `effect give ${name} minecraft:instant_health 1 10 true`, `effect give ${name} minecraft:saturation 1 20 true`]) await rcon(i, c).catch(() => {}) }
  // Раздача на раунд по флагам: ARMS_AIR=1 — элитры, ракеты, копьё; ARMS_CRYSTAL=1 — кристаллы Края и обсидиан
  // (10.10: «жёсткая баталия на взрывах»), тотем и поножи от взрывов.
  const roundKit = async (b) => {
    const list = [...(process.env.ARMS_AIR === '1' ? ['elytra 1', 'firework_rocket 48', 'diamond_spear[enchantments={sharpness:3,knockback:1}] 1'] : []),
      ...(process.env.ARMS_CRYSTAL === '1' ? ['end_crystal 32', 'obsidian 32', 'totem_of_undying 1', 'diamond_leggings[enchantments={blast_protection:4}] 1'] : []),
      // ARMS_TNT=1 (10.10: «раунд с кучей динамита — пусть взрывают всё вокруг как психи»): вагонетки с TNT, рельсы и лук
      // с огнём (бой умеет: рельс у врага, вагонетка, горящая стрела — boom.ts).
      ...(process.env.ARMS_TNT === '1' ? ['tnt_minecart 16', 'rail 32', 'bow[enchantments={flame:1,power:2}] 1', 'arrow 64', 'diamond_leggings[enchantments={blast_protection:4}] 1'] : [])]
    for (const it of list) { const [n, c] = it.split(/ (?=\d+$)/); await rcon(i, `give ${b.name} minecraft:${n} ${c || 1}`).catch(() => {}) }
  }
  // Мобы (ARMS_MOBS=N, 10.10: «жёстких мобов с бронёй, чарами и оружием — много, чтобы месиво; пусть боты их бьют»):
  // в начале раунда и раз в 30 с — добор до N живых. Каски у всех (днём не горят), не исчезают, бруты не превращаются.
  const MOBS = Number(process.env.ARMS_MOBS || 0)
  let mobSeed = 99991
  const mrnd = () => { mobSeed = (mobSeed * 1664525 + 1013904223) >>> 0; return mobSeed / 4294967296 }
  const spawnMobs = async (n) => {
    const kinds = ['zombie', 'zombie', 'husk', 'skeleton', 'stray', 'wither_skeleton', 'vindicator', 'piglin_brute', 'bogged', 'zombie']
    // Слабее (10.10: «боты не вывозят — выносят с начала раунда»): оружие камень/железо/изредка алмаз, броня кольчуга/железо,
    // чары до 2 (ARMS_MOBS_HARD=1 — прежние: железо/алмаз/незерит, чары до 5).
    const hard = process.env.ARMS_MOBS_HARD === '1'
    const mat = () => { const r = mrnd(); return hard ? (r < 0.5 ? 'iron' : r < 0.85 ? 'diamond' : 'netherite') : r < 0.45 ? 'stone' : r < 0.9 ? 'iron' : 'diamond' }
    const amat = () => { const r = mrnd(); return hard ? mat() : r < 0.45 ? 'chainmail' : r < 0.9 ? 'iron' : 'diamond' }
    const lv = (m) => 1 + Math.floor(mrnd() * (hard ? m : Math.min(m, 2)))
    const it = (id, ench) => `{id:"minecraft:${id}",count:1${ench ? `,components:{"minecraft:enchantments":{${ench}}}` : ''}}`
    for (let k = 0; k < n; k++) {
      const kind = kinds[Math.floor(mrnd() * kinds.length)]
      const ranged = /skeleton|stray|bogged/.test(kind) && kind !== 'wither_skeleton'
      const hand = ranged ? it('bow', `power:${lv(5)},punch:${lv(2)}${mrnd() < 0.3 ? ',flame:1' : ''}`)
        : kind === 'vindicator' ? it(`${mat()}_axe`, `sharpness:${lv(5)}`) : it(`${mat()}_sword`, `sharpness:${lv(5)}${mrnd() < 0.3 ? `,fire_aspect:${lv(2)}` : ''}`)
      const arm = (sl) => it(`${amat()}_${sl}`, `protection:${lv(4)}`)
      const eq = `equipment:{mainhand:${hand},head:${arm('helmet')},chest:${arm('chestplate')},legs:${arm('leggings')},feet:${arm('boots')}},drop_chances:{mainhand:0.15f,head:0.1f,chest:0.1f,legs:0.1f,feet:0.1f}`
      const extra = kind === 'piglin_brute' ? ',IsImmuneToZombification:1b' : ''
      const a = mrnd() * Math.PI * 2; const r0 = 4 + mrnd() * (L.R - 6)
      await rcon(i, `summon minecraft:${kind} ${Math.round(X + Math.cos(a) * r0)} ${Y + 12} ${Math.round(Z + Math.sin(a) * r0)} {PersistenceRequired:1b,Tags:["arms_mob","arms_new"],${eq}${extra}}`).catch(() => {})
    }
    // На землю поля (не в холм): spreadplayers кладёт и мобов — на верх рельефа.
    await rcon(i, `spreadplayers ${X} ${Z} 3 ${L.R - 3} false @e[tag=arms_new]`).catch(() => {})
    await rcon(i, 'tag @e[tag=arms_new] remove arms_new').catch(() => {})
  }
  const topUpMobs = async () => {
    if (!MOBS) return
    const r = String(await rcon(i, 'execute if entity @e[tag=arms_mob]').catch(() => ''))
    const have = Number((/Count: (\d+)/.exec(r) || [])[1] || 0)
    if (have < MOBS) { await spawnMobs(MOBS - have); log(`👹 мобов на арене ${have} → ${MOBS}`) }
  }
  if (arms) for (let k = 0; k < N; k++) { const h = armsHome(bots[k], k); await reset(bots[k].name); await rcon(i, `tp ${bots[k].name} ${h.x} ${h.y} ${h.z}`); await roundKit(bots[k]) }
  else for (let k = 0; k < N; k++) { await dress(i, bots[k].name, kit); await place(bots[k].name, home(bots[k], k)) }
  await topUpMobs()
  const mobT = MOBS ? setInterval(() => { if (!between) topUpMobs().catch(() => {}) }, 30000) : null
  const healing = new Set<string>()
  const busy = new Set<string>()
  const labNeed: Record<string, string[]> = {}
  const brewed: Record<string, boolean> = {}
  const alchemist: Record<string, string> = {}
  // Сбор на хилку (по команде лекаря): раненые сбегаются к нему, он бросает зелье в гущу, все — обратно в бой.
  // Рамки, чтобы не зациклиться и не ломать бой: один сбор на команду, длится ≤ 6 игровых с (4 — взрывы отбрасывали, не добегали) (без паузы между сборами —
  // пользователь 10.10: экстренно нужен снова, особенно с кристаллами); бегут
  // только раненые (≤ 12 хп) на земле в 12 бл.; враг у лекаря (< 3 бл.) — бросок сразу.
  const rally: Record<string, any> = {}
  const giving = new Set<string>()
  const spreadAt: Record<string, number> = {}
  // Чего не хватает бойцу (по его рюкзаку): яблоко при ≤ 14 хп, зелья лекарю, блоки на стенки, оружие.
  // Что из ресурсов в этом бою вообще бывает (набор): зелья и блоки просят, только если их выдают.
  const kitHas = (re: RegExp) => (KITS[kit] || []).some(it => re.test(it))
  const needOf = (m: any) => {
    const inv = m?.inv || {}
    const lab = (m?.labNeed || []).find(x => !inv[x])
    if (lab) return { item: lab }
    const names = Object.keys(inv)
    if (!names.some(n => WEAPON.test(n))) return { item: 'оружие' }
    if (!names.some(n => FOOD.test(n)) && (m.hp ?? 20) <= 14) return { item: 'еда' }
    // Пустой слот брони (не надето и нет в рюкзаке) — попросить у своих.
    const worn = m?.armor || {}
    for (const [slot, re] of Object.entries(ARMOR_SLOT)) if (!worn[slot] && !names.some(n => (re as RegExp).test(n))) return { item: 'броня:' + slot }
    if (kitHas(/splash_potion/) && !inv.splash_potion) return { item: 'splash_potion' }
    if (kitHas(/cobblestone/) && (inv.cobblestone || 0) < 8) return { item: 'cobblestone' }
    return null
  }
  // Что отдать из своего запаса (себе — неприкосновенное: лучшее оружие, 1 еда, 1 зелье, 16 блоков, надетая броня).
  const spare = (inv: any, need: any, worn: any = {}) => {
    const names = Object.keys(inv)
    if (need.item === 'оружие') {
      const w = names.filter(n => WEAPON.test(n)).sort((a, b) => tierOf(b) - tierOf(a))
      return w.length >= 2 ? { item: w[w.length - 1], count: 1 } : null
    }
    if (ALCHEMY.test(need.item)) return (inv[need.item] || 0) > 0 ? { item: need.item, count: inv[need.item] } : null
    if (need.item === 'еда') {
      const f = names.filter(n => FOOD.test(n)).sort((a, b) => (inv[b] || 0) - (inv[a] || 0))
      const total = f.reduce((a, n) => a + inv[n], 0)
      return total >= 2 ? { item: f[0], count: Math.max(1, Math.min(4, Math.floor(total / 2))) } : null
    }
    if (need.item.startsWith('броня:')) {
      const slot = need.item.slice(6)
      // Лишняя — в рюкзаке, а свой слот уже надет.
      const it = names.filter(n => ARMOR_SLOT[slot].test(n)).sort((a, b) => tierOf(b) - tierOf(a))[0]
      return it && worn[slot] ? { item: it, count: 1 } : null
    }
    const keep = { golden_apple: 1, splash_potion: 1, cobblestone: 16 }[need.item] ?? 1
    const have = inv[need.item] || 0
    const n = need.item === 'cobblestone' ? Math.min(24, have - keep) : Math.min(1, have - keep)
    return n > 0 ? { item: need.item, count: n } : null
  }
  // Просьба вслух — в чат (видно зрителю): новая нужда, не чаще раза в 30 с на бойца.
  const asked: Record<string, number> = {}
  const announce = setInterval(() => {
    if (!teams) return
    for (const b of bots) {
      // Вслух — не чаще раза в 30 с (гонка 10.10: 1008 строк «нужно:» за 4 минуты — спам).
      const need = needOf(pos[b.name]); if (!need || deadNow.has(b.name) || out.has(b.name) || between) continue
      if ((asked[b.name] || 0) > Date.now()) continue
      asked[b.name] = Date.now() + 30000
      const ru = ALCHEMY.test(need.item) ? 'для зелий ' + need.item : { оружие: 'оружие', еда: 'еда', golden_apple: 'золотое яблоко', splash_potion: 'зелье лечения', cobblestone: 'блоки', 'броня:head': 'шлем', 'броня:torso': 'нагрудник', 'броня:legs': 'поножи', 'броня:feet': 'ботинки' }[need.item]
      tell(b, `[${b.team === 'red' ? 'красные' : 'синие'}] нужно: ${ru}`)
    }
  }, 2000)
  const help: Record<string, number> = {}
  // Чат бойцов — сообщением сервера (tellraw), не чатом бота: чат игрока рвёт задачи всех демонов (interruptOn 'chat' —
  // это для человека), и рация отряда срывала сундуки: 220 «interrupted» за минуту (гонка 10.10).
  // В чат игры — только с ARMS_CHAT=1 (10.10: «бесит спам в чате»); журнал гонки пишет всё равно.
  const tell = (b, text) => process.env.ARMS_CHAT !== '1' ? null : rcon(i, `tellraw @a ${JSON.stringify({ text: `<${b.name}> ${text}`, color: b.team === 'red' ? 'red' : b.team === 'blue' ? 'aqua' : 'white' })}`).catch(() => {})
  // ---------------------------------------------------------------- рация отряда
  // 10.10: «команды друг другу как в CS — прикрой, за мной, помогите; группироваться сразу и атаковать толпой».
  // Отряды по 4 (порядок в команде), лидер — сильнейший живой (держится, пока жив). Вызовы:
  //  help  — «нужна помощь»: врагов рядом сильнее, чем нас (power), отвечают ближайшие свободные (не в ближнем бою), сколько
  //          нужно, чтобы сравнять число, и кто успеет за время вызова; cover — то же, когда бойца сорвали с лута;
  //  gather — лидер «за мной»: ждёт снаряжённых своих, пока добегут (срок — время пути дальнего + 2 с), потом атака;
  //  фокус — цель лидера бьёт весь отряд («в атаку на …»). Пороги — во времени пути (SPRINT), не в блоках.
  const SQUAD = 4
  const radio: Record<string, any> = {}
  const leadOf: Record<string, string> = {}
  const saidAt: Record<string, number> = {}
  const short = (n) => String(n).replace('NeuroFarm', '')
  const alive = (n) => !!(pos[n]?.p && pos[n].hp > 0 && !deadNow.has(n) && !out.has(n))
  const squadOf = (n) => { const tb = bots.filter(o => o.team === teamOf(n)); const s = Math.floor(tb.findIndex(o => o.name === n) / SQUAD); return tb.slice(s * SQUAD, s * SQUAD + SQUAD).map(o => o.name) }
  const leaderOf = (n) => {
    const sq = squadOf(n); const key = sq[0]; const live = sq.filter(alive)
    if (!live.length) return null
    if (live.includes(leadOf[key])) return leadOf[key]
    return (leadOf[key] = live.sort((a, c) => power(pos[c].hp, pos[c].inv, pos[c].armor) - power(pos[a].hp, pos[a].inv, pos[a].armor))[0])
  }
  const radioSay = (b, text) => {
    log(`📻 ${b.name}: ${text}`)
    if ((saidAt[b.name] || 0) > Date.now()) return
    saidAt[b.name] = Date.now() + 4000
    tell(b, `[${b.team === 'red' ? 'красные' : 'синие'}] ${text}`)
  }
  const callout = (b, kind, data, ttl, text) => {
    const k = `${b.name}:${kind}`; const was = radio[k]
    const fresh = !was || was.until < Date.now() || was.foe !== data.foe
    radio[k] = { kind, from: b.name, team: b.team, until: Date.now() + ttl, ans: fresh ? new Set() : was.ans, t0: fresh ? Date.now() : was.t0, ...data }
    if (fresh) radioSay(b, text)
  }
  const calls = (team, kind) => Object.values(radio).filter((c: any) => c.team === team && c.kind === kind && c.until > Date.now() && alive(c.from)) as any[]
  const inMelee = (b) => { const m = pos[b.name]; return !!m?.p && enemiesOf(b, m.p).some(e => e.d / Math.max(e.spd, SPRINT) < 1.25) }
  const foeAlive = (n) => alive(n) || (humans[n]?.hp > 0)
  // Ответ на «помогите/прикройте»: я среди тех, кто нужен (ближайшие свободные, успевают за остаток вызова + 2 с).
  const answerHelp = (b) => {
    const me = pos[b.name]; if (!teams || !me?.p || inMelee(b)) return null
    for (const c of [...calls(b.team, 'help'), ...calls(b.team, 'cover')]) {
      if (c.from === b.name || !c.foe || !foeAlive(c.foe)) continue
      const at = pos[c.from].p; const left = (c.until - Date.now()) / 1000
      const free = names.filter(n => n !== c.from && teamOf(n) === b.team && alive(n) && !inMelee(bots.find(o => o.name === n)))
        .map(n => ({ n, t: dist3(pos[n].p, at) / SPRINT })).filter(o => o.t <= left + 2).sort((a, z) => a.t - z.t)
      if (!free.slice(0, Math.max(1, (c.foes || 1) - (c.mates || 0))).some(o => o.n === b.name)) continue
      if (!c.ans.has(b.name)) { c.ans.add(b.name); radioSay(b, c.kind === 'help' ? `иду к ${short(c.from)}!` : `прикрываю ${short(c.from)}!`) }
      return { target: c.foe, why: `${c.kind === 'help' ? 'на помощь' : 'прикрываю'} ${c.from}` }
    }
    return null
  }
  // Фокус отряда: цель лидера, если на мне самом никто не висит в ближнем бою (тогда отбиваюсь сам).
  const focusPick = (b) => {
    const Ld = teams && leaderOf(b.name); if (!Ld || Ld === b.name) return null
    const lc = bots.find(o => o.name === Ld)?.cur
    if (!lc || !foeAlive(lc) || teamOf(lc) === b.team) return null
    const me = pos[b.name]
    if (enemiesOf(b, me.p).some(e => e.n !== lc && e.d / Math.max(e.spd, SPRINT) < 1.25)) return null
    // Игрок — не больше трёх своих на одном (иначе вся команда на нём — 10.10: «а то меня только бьют»).
    if (humans[lc] && bots.filter(o => o !== b && o.team === b.team && o.cur === lc).length >= 3 && b.cur !== lc) return null
    return { target: lc, why: `фокус отряда — за ${Ld}` }
  }
  await sleep(1500)
  let stop = false
  process.on('SIGINT', () => { stop = true })
  const STOPF = path.join(ROOT, 'farm', `ffa-${i}.stop`)
  try { fs.unlinkSync(STOPF) } catch {}
  // Живые игроки (пользователь 10.10): кто бьёт бойцов — враг всей их команды (вся команда на него), кто помогает (вещи,
  // зелья) — союзник: его не бьют и прикрывают (бьют того, кто бьёт его). Отношение копится: удар −3, убийство −5, помощь +2.
  const humans: Record<string, any> = {}
  const rel: Record<string, Record<string, number>> = { red: {}, blue: {} }
  let humanNames: string[] = []
  let humanListAt = 0
  const emote = (b, kind, at = null) => b.c.call('emote', { kind, at }).catch(() => {})
  const eyeOf = (h) => humans[h]?.p ? { x: humans[h].p.x, y: humans[h].p.y + 1.6, z: humans[h].p.z } : null
  const relSay = (team, h, d, why) => {
    if (!teams || !team) return
    const was = rel[team][h] || 0; const now = Math.max(-20, Math.min(20, was + d)); rel[team][h] = now
    if (Math.sign(was) !== Math.sign(now)) {
      const tn = team === 'red' ? 'красные' : 'синие'
      log(now < 0 ? `😠 ${h} — враг: ${tn} все на него (${why})` : now > 0 ? `🤝 ${h} — союзник ${tn === 'красные' ? 'красных' : 'синих'} (${why})` : `😐 ${h} — нейтрал для ${tn}`)
      for (const o of bots) {
        const m = pos[o.name]; const hp = humans[h]?.p
        if (o.team !== team || out.has(o.name) || !m?.p || !hp || Math.hypot(m.p.x - hp.x, m.p.z - hp.z) > 16) continue
        if (now < 0) emote(o, 'shake', eyeOf(h)); else if (now > 0) emote(o, 'nod', eyeOf(h)).then(() => emote(o, 'crouch'))
      }
      const b0 = bots.find(o => o.team === team && !out.has(o.name))
      if (b0) tell(b0, now < 0 ? `[${tn}] ${h} напал — все на него!` : `[${tn}] ${h} с нами — прикрываем`)
    }
  }
  let humanBusy = false
  const humanT = setInterval(async () => {
    if (humanBusy) return
    humanBusy = true
    try {
    if (Date.now() - humanListAt > 5000) {
      humanListAt = Date.now()
      const l = await rcon(i, 'list').catch(() => '')
      humanNames = String(l).replace(/^.*online:\s*/, '').split(/,\s*/).map(x => x.trim()).filter(x => x && !names.includes(x) && x !== LAN_NAME)
    }
    for (const h of humanNames) {
      const ps = await rcon(i, `data get entity ${h} Pos`).catch(() => '')
      const hs = await rcon(i, `data get entity ${h} Health`).catch(() => '')
      const m = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(String(ps)); const hm = /([\d.]+)f/.exec(String(hs))
      if (!m) { delete humans[h]; continue }
      const prev = humans[h]
      const cur: any = { p: { x: +m[1], y: +m[2], z: +m[3] }, hp: hm ? +hm[1] : 20, hurtBy: prev?.hurtBy, hurtAt: prev?.hurtAt || 0, at: Date.now(), spd: prev?.spd || 0 }
      if (prev?.p && Date.now() > prev.at) { const inst = Math.hypot(cur.p.x - prev.p.x, cur.p.z - prev.p.z) / ((Date.now() - prev.at) / 1000); cur.spd = Math.max(inst, prev.spd * 0.85); cur.top = Math.max(inst, (prev.top || 0) * 0.98) }
      // Игрока ранили — кто из бойцов рядом (≤ 5 бл.): обидчик, его прикрывающие союзники бьют первым.
      if (prev && cur.hp < prev.hp - 0.5) {
        const near = bots.filter(o => !out.has(o.name) && pos[o.name]?.p && Math.hypot(pos[o.name].p.x - cur.p.x, pos[o.name].p.y - cur.p.y, pos[o.name].p.z - cur.p.z) <= 5)
          .sort((a, c) => Math.hypot(pos[a.name].p.x - cur.p.x, pos[a.name].p.z - cur.p.z) - Math.hypot(pos[c.name].p.x - cur.p.x, pos[c.name].p.z - cur.p.z))[0]
        if (near) { cur.hurtBy = near.name; cur.hurtAt = Date.now() }
      }
      // Враг в воздухе над бойцом (булава с высоты/заряда ветра; 10.10: «от булавы плохо защищаются») — тот бросает дело
      // и берёт его целью: защита от булавы (щит, уход, жемчуг, встречный удар) живёт в бою с ним (pvp.duel).
      if (prev?.p && teams) {
        const vy = (cur.p.y - prev.p.y) / Math.max(0.05, (Date.now() - prev.at) / 1000)
        for (const o of bots) {
          const m = pos[o.name]
          if (out.has(o.name) || !m?.p || o.cur === h || (rel[o.team][h] || 0) >= 0) continue
          if (cur.p.y - m.p.y > 1.5 && Math.hypot(cur.p.x - m.p.x, cur.p.z - m.p.z) < 6 && (vy > 2 || cur.p.y - m.p.y > 3)) {
            log(`☂ ${o.name}: ${h} надо мной в воздухе — к бою с ним`)
            o.cur = h; o.c.call('stop').catch(() => {})
          }
        }
      }
      // Что на нём видно — броня и предмет в руке (раз в 5 с): сила для решения «драться или к своим». Хп игрока — не
      // берём (только оценка, AGENTS): в силе он всегда «полный».
      if (!prev?.gearAt || Date.now() - prev.gearAt > 5000) {
        const eq = String(await rcon(i, `data get entity ${h} equipment`).catch(() => ''))
        const held = /"minecraft:([a-z0-9_]+)"/.exec(String(await rcon(i, `data get entity ${h} SelectedItem.id`).catch(() => '')))
        const slot = (k) => (new RegExp(k + ': \\{[^}]*?id: "minecraft:([a-z0-9_]+)"').exec(eq) || [])[1] || null
        cur.armor = { head: slot('head'), torso: slot('chest'), legs: slot('legs'), feet: slot('feet') }
        cur.weapon = held ? held[1] : null
        // Чары видны блеском, уровни — нет; по ним бой «кто кого» (оценка: острота на оружии, защита на броне).
        const ench = String(await rcon(i, `data get entity ${h} SelectedItem.components."minecraft:enchantments"`).catch(() => ''))
        cur.sharp = Number((/"minecraft:sharpness": (\d+)/.exec(ench) || [])[1] || 0)
        cur.epf = [...eq.matchAll(/"minecraft:protection": (\d+)/g)].reduce((a, m) => a + Number(m[1]), 0)
        cur.gearAt = Date.now()
      } else { cur.armor = prev.armor; cur.weapon = prev.weapon; cur.sharp = prev.sharp; cur.epf = prev.epf; cur.gearAt = prev.gearAt }
      // Точка возрождения — центр поля этого раунда (ставится и тем, кто зашёл позже восстановления арены).
      const sk = spawnAt ? `${spawnAt.x},${spawnAt.y},${spawnAt.z}` : null
      cur.spawnKey = prev?.spawnKey
      if (sk && cur.spawnKey !== sk) { await rcon(i, `spawnpoint ${h} ${spawnAt.x} ${spawnAt.y} ${spawnAt.z}`).catch(() => {}); cur.spawnKey = sk }
      humans[h] = cur
    }
    } finally { humanBusy = false }
  }, 250)
  // Тревога (10.10: «подбегаю быстро — тупят, не реагируют, как будто не успевают; должны понимать, что я быстрый»):
  // раз в 250 мс у каждого бойца не в бою — кто доберётся до меня быстрее чем за 2 с (по его скорости, а не по блокам:
  // игрок со «Скоростью V» — 10+ бл/с), тот рвёт текущее дело (лут, путь, крафт); цикл бойца решит заново — бежать,
  // звать своих или драться. Не чаще раза в 1.5 с на бойца, иначе дело рвётся по кругу.
  const lootWatch = setInterval(() => {
    if (between) return
    for (const b of bots) {
      const m = pos[b.name]; if (!m?.p || !alive(b.name) || (b.alarmAt || 0) > Date.now()) continue
      // Бой и уход (жемчуг, заряд, подкоп, бег) — не рвать: это и есть ответ на угрозу.
      if (!b.looting && (/^(fight|drink_buffs|pearl_to|wind_jump|burrow|flee|block_behind)$/.test(b.last?.m || '') || b.waiting)) continue
      const en = enemiesOf(b, m.p)
      const t = (e) => Math.max(0, e.d - 3) / Math.max(e.spd, SPRINT)
      const hot = en.filter(e => t(e) < 2 && (e.human || e.d < 6 || bots.find(o => o.name === e.n)?.cur === b.name))
      if (!hot.length) continue
      b.alarmAt = Date.now() + 1500
      if (b.looting || Date.now() - (b.last?.at || 0) < 30000) { b.looting = false; b.c.call('stop').catch(() => {}) }
      const ours = names.filter(n => n !== b.name && teamOf(n) === b.team && alive(n) && dist3(pos[n].p, m.p) / SPRINT < 2.5).length
      if (teams) callout(b, 'cover', { foe: hot[0].n, foes: hot.length, mates: ours }, 6000, `прикройте! на меня ${short(hot[0].n)}${hot.length > 1 ? ` и ещё ${hot.length - 1}` : ''}`)
    }
  }, 250)
  const dist3 = (a, c) => Math.hypot(a.x - c.x, a.y - c.y, a.z - c.z)
  const enemiesOf = (b, at) => [
    ...names.filter(n => n !== b.name && (!teams || teamOf(n) !== b.team) && !out.has(n) && !deadNow.has(n) && pos[n]?.p && pos[n].hp > 0)
      .map(n => ({ n, p: pos[n].p, spd: Math.hypot(pos[n].v?.x || 0, pos[n].v?.z || 0) * 20, geared: geared(pos[n]), human: false, pow: power(pos[n].hp, pos[n].inv, pos[n].armor) })),
    // Игрок: враг — да; нейтрал с оружием в руке — тоже угроза (бежать, звать своих, не лутать у него под носом), но не
    // цель — бьют его только после удара (10.10: «голые бежали лутаться, на меня не реагировали — вырезал как дурачков»).
    ...(teams ? Object.entries(humans).filter(([n, h]: any) => ((rel[b.team][n] || 0) < 0 || (!(rel[b.team][n] > 0) && h.weapon && WEAPON.test(h.weapon))) && h.p && h.hp > 0)
      .map(([n, h]: any) => ({ n, p: h.p, spd: Math.max(h.spd || 0, h.top || 0), geared: true, human: true,
        pow: power(20, h.weapon ? { [h.weapon]: 1 } : { diamond_sword: 1 }, h.armor || { head: 'diamond_helmet', torso: 'diamond_chestplate', legs: 'diamond_leggings', feet: 'diamond_boots' }) })) : []),
    // Мобы — те же враги (10.10: «от мобов бегут, а меня не видят»): что видит сам боец (демон, раз в секунду).
    ...((pos[b.name]?.mobs || []) as any[]).map(m => ({ n: `mob${m.id}`, id: m.id, p: m.p, spd: MOB_SPD[m.name] ?? 3, geared: true, human: false, mob: true, kind: m.name, pow: 0 }))
  ].map(e => ({ ...e, d: at ? dist3(e.p, at) : Infinity })).sort((a, c) => a.d - c.d)
  // Отход к своим (10.10: «один — иногда убегать к союзникам»; «не хардкодь блоки — адаптивно»). Без порогов в блоках:
  // враг сильнее моей силы «здесь» (я + свои, кто успеет за секунду) — к той группе своих, что даст больше силы на
  // секунду пути, если добегу раньше, чем он догонит (разрыв до удара / разница скоростей). Догонит раньше — драться.
  const retreatPlan = (b) => {
    const me = pos[b.name]; if (!teams || !me?.p) return null
    // Тот, кто гонится за мной: игрок или боец, у которого я — цель (10.10: бегали от всех подряд — бои вымерли, 1 смерть за 2.5 мин).
    const chaser = enemiesOf(b, me.p).find(e => e.geared && e.d / Math.max(e.spd, SPRINT) < 5 && (e.human || bots.find(o => o.name === e.n)?.cur === b.name))
    if (!chaser) return null
    const myPow = power(me.hp ?? 20, me.inv, me.armor)
    const allies = names.filter(n => n !== b.name && teamOf(n) === b.team && !out.has(n) && !deadNow.has(n) && pos[n]?.p && pos[n].hp > 0)
      .map(n => ({ n, p: pos[n].p, d: dist3(pos[n].p, me.p), pow: power(pos[n].hp, pos[n].inv, pos[n].armor) }))
    const near = (q) => allies.filter(o => dist3(o.p, q) / SPRINT < 1).reduce((s, o) => s + o.pow, 0)
    const local = myPow + near(me.p)
    // Заметно сильнее (на треть), а не на волос: иначе равные бегают друг от друга по кругу.
    if (chaser.pow <= local * 1.3) return null
    const catchT = chaser.spd > SPRINT ? Math.max(0, chaser.d - 3) / (chaser.spd - SPRINT) : Infinity
    let best = null
    for (const a of allies) {
      const tA = a.d / SPRINT
      if (tA < 1 || tA > catchT + 0.5) continue
      const group = myPow + near(a.p)
      const score = group / (tA + 1)
      // Бежать — только к тем, с кем вместе его не слабее; иначе бег — та же смерть, только в спину.
      if (group > local && group >= chaser.pow && (!best || score > best.score)) best = { ...a, tA, group, score }
    }
    return { ally: best, catchT, local, enemy: chaser }
  }
  // Безнадёжно (10.10: «голыми руками против меня нет смысла — они видят броню и оружие; должны понимать, что проиграют,
  // и убегать, а не суицидничать»): тот, кто за мной гонится, вдвое сильнее меня (сила по видимому снаряжению) — бой
  // не брать, бежать (к своим, к сундуку, прочь) и звать помощь, даже если догонит: на бегу тянешь время своим.
  const mobInfo: Record<string, any> = {}
  const fighterOf = (n) => /^mob\d+$/.test(n) && mobInfo[n] ? { hp: MOB_HP[mobInfo[n].name] ?? 20, weapon: mobInfo[n].held, bonus: (MOB_HIT[mobInfo[n].name] ?? 3) - 1, A: armorStat(mobInfo[n].armor), mob: true }
    : humans[n] ? { hp: 20, weapon: humans[n].weapon, bonus: humans[n].sharp ? 0.5 * humans[n].sharp + 0.5 : 0, A: armorStat(humans[n].armor, humans[n].epf || 0) }
    : { hp: pos[n]?.hp ?? 20, weapon: bestWeapon(pos[n]?.inv), bonus: 0, A: armorStat(pos[n]?.armor) }
  // От кого бежать разом (игроки и бойцы рядом; мобов демон видит сам): направление — от всех, а не от одного.
  const fleeFrom = (b, at) => enemiesOf(b, at).filter(e => !e.mob && e.d < 24).map(e => e.n)
  // Куда бежать выгоднее (10.10: «просчитывал — где сундук, где союзники»): живые свои и неоткрытые сундуки в 30 бл.
  const fleeToward = (b, at) => [
    ...names.filter(n => n !== b.name && teams && teamOf(n) === b.team && alive(n)).map(n => pos[n].p),
    ...(L ? L.chests.filter(c => !opened.has(`${c.x},${c.y},${c.z}`)).map(c => ({ x: X + c.x, y: Y + c.y, z: Z + c.z })) : [])
  ].filter(q => q && Math.hypot(q.x - at.x, q.z - at.z) < 30).map(q => ({ x: q.x, y: q.y, z: q.z }))
  const outmatched = (b) => {
    const me = pos[b.name]; if (!teams || !me?.p) return null
    // Кто на меня идёт (в 5 с бега): игрок, боец с целью «я» или кто уже вплотную.
    const threat = enemiesOf(b, me.p).find(e => e.d / Math.max(e.spd, SPRINT) < 5 && (e.human || e.d < 6 || bots.find(o => o.name === e.n)?.cur === b.name))
    if (!threat) return null
    const near = names.filter(n => n !== b.name && teamOf(n) === b.team && alive(n) && dist3(pos[n].p, me.p) / SPRINT < 1.5)
    if (winsAgainst([b.name, ...near].map(fighterOf), fighterOf(threat.n))) return null
    const catchT = threat.spd > SPRINT ? Math.max(0, threat.d - 3) / (threat.spd - SPRINT) : Infinity
    return { enemy: threat, catchT, ally: null, local: 0, group: near.length + 1 }
  }
  // Нужны ли вещи погибшего моей команде: расходники — всегда; оружие/броня — если лучше, чем у кого-то из моих.
  const bestW = (inv) => Object.keys(inv || {}).filter(n => WEAPON.test(n)).reduce((a, n) => Math.max(a, tierOf(n)), -1)
  const gearUseful = (d, team) => {
    if (Object.keys(d.inv || {}).some(n => /golden_apple|potion|totem|ender_pearl|wind_charge|elytra|firework/.test(n))) return true
    const w = bestW(d.inv)
    return team.some(n => {
      const m = pos[n]; if (!m) return false
      if (w > bestW(m.inv)) return true
      return Object.entries(d.armor || {}).some(([sl, nm]) => nm && tierOf(String(nm)) > (m.armor?.[sl] ? tierOf(String(m.armor[sl])) : -1))
    })
  }
  // Брошенное игроком (10.10: «не видят, как кидаю предметы — хочу делиться»): раз в секунду — что лежит у игрока с меткой
  // «бросил он» (Thrower, видно в игре как вылет из его рук). Ценное — ближнему бойцу (любой команды, даже если игрок ему
  // враг: подарок — путь к миру): бросить дело и взять.
  const uuidOf: Record<string, string> = {}
  let giftBusy = false
  const giftT = setInterval(async () => {
    if (giftBusy || !teams) return
    giftBusy = true
    try {
      for (const [h, hu] of Object.entries(humans) as [string, any][]) {
        if (!hu.p) continue
        if (!uuidOf[h]) uuidOf[h] = (/\[I;[^\]]+\]/.exec(String(await rcon(i, `data get entity ${h} UUID`).catch(() => ''))) || [''])[0].replace(/\s/g, '')
        const sel = `@e[type=item,x=${hu.p.x.toFixed(1)},y=${hu.p.y.toFixed(1)},z=${hu.p.z.toFixed(1)},distance=..10,sort=nearest,limit=1]`
        const thrower = (/\[I;[^\]]+\]/.exec(String(await rcon(i, `data get entity ${sel} Thrower`).catch(() => ''))) || [''])[0].replace(/\s/g, '')
        if (!thrower || thrower !== uuidOf[h]) continue
        const id = (/"minecraft:([a-z0-9_]+)"/.exec(String(await rcon(i, `data get entity ${sel} Item.id`).catch(() => ''))) || [])[1]
        const pm = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(String(await rcon(i, `data get entity ${sel} Pos`).catch(() => '')))
        if (!id || !pm || worthOf(id) < 1) continue
        const at = { x: +pm[1], y: +pm[2], z: +pm[3] }
        const taker = bots.filter(o => !out.has(o.name) && !o.gift && pos[o.name]?.p && dist3(pos[o.name].p, at) / SPRINT < 4)
          .sort((a, c) => dist3(pos[a.name].p, at) - dist3(pos[c.name].p, at))[0]
        if (!taker || bots.some(o => o.gift && dist3(o.gift.at, at) < 1)) continue
        taker.gift = { id, at, from: h }
        log(`👀 ${taker.name} видит: ${h} бросил ${id} — иду взять`)
        taker.c.call('stop').catch(() => {})
      }
    } finally { giftBusy = false }
  }, 1000)
  const humanNear = (p, r) => Object.entries(humans).filter(([, h]: any) => h.p && h.hp > 0 && Math.hypot(h.p.x - p.x, h.p.y - p.y, h.p.z - p.z) <= r).map(([n]) => n)
  // Позиции всех — раз в секунду (цель — ближайший живой).
  // Сторож зависаний (10.10: «подвисают, ничего не делая — фармлю их»): живой боец 8 с на месте, рядом (3 бл.) нет
  // врага и он не ждёт нарочно (сбор, хилка) — в журнал, чем занят (последний вызов демона и сколько длится), и стоп:
  // цикл бойца выберет дело заново.
  for (const b of bots) { const raw = b.c.call.bind(b.c); b.c.call = (m, p) => { if (!/^(status|emote|look_at|armor|team_hint|stop|mobs)$/.test(m)) b.last = { m, at: Date.now(), p }; return raw(m, p) } }
  // Мобы глазами бойцов — раз в секунду (только с мобами на арене: ARMS_MOBS).
  const mobPollT = process.env.ARMS_MOBS ? setInterval(() => {
    for (const b of bots) {
      if (!pos[b.name]?.p || deadNow.has(b.name)) continue
      b.c.call('mobs', { radius: 24 }).then(r => {
        const list = (r?.detail || r)?.mobs || []
        if (pos[b.name]) pos[b.name].mobs = list
        for (const m of list) mobInfo[`mob${m.id}`] = m
      }).catch(() => {})
    }
  }, 1000) : null
  const frozenT = setInterval(() => {
    if (between) return
    for (const b of bots) {
      const m = pos[b.name]
      if (!m?.p || !alive(b.name) || b.waiting || (b.last?.m === 'craft' && Date.now() - b.last.at < 16000)) { b.anchor = null; continue }
      if (!b.anchor || dist3(b.anchor.p, m.p) > 1) { b.anchor = { p: { ...m.p }, at: Date.now() }; continue }
      const still = Date.now() - b.anchor.at
      // Враг вплотную, а я стою и не в бою — это хуже всего (10.10: «стоит рядом, не атакует, я ваншочу»): 3 с; иначе 5 с.
      const near = enemiesOf(b, m.p).some(e => e.d < 3)
      if ((near && b.last?.m === 'fight') || still < (b.last?.m === 'fight' ? 8000 : near ? 3000 : 5000)) continue
      const L0 = b.last || {}
      // Куда шёл и встал — туда 20 с не ходить (сундук, лидер): иначе тот же путь и та же стойка по кругу.
      if (L0.p && Number.isFinite(L0.p.x)) (b.badSpots ||= []).push({ x: L0.p.x, y: L0.p.y, z: L0.p.z, until: Date.now() + 20000 })
      if (b.following) b.followCd = Date.now() + 20000
      log(`🧊 ${b.name} стоит ${Math.round(still / 1000)} с — ${L0.m || '?'} ${L0.p?.item || L0.p?.target || L0.p?.mode || ''} (${L0.at ? Math.round((Date.now() - L0.at) / 1000) + ' с' : ''}) — сброс`)
      // Застрял наверху (крыша камеры, уступ галереи: спуск 6+ без воды pathfinder не планирует) — спрыгнуть.
      if (m.p.y > Y + 3) b.needDrop = true
      // Шёл выше (галерея, ярус) и встал — подбросить себя зарядом ветра (10.10), если есть.
      else if (L0.p && Number.isFinite(L0.p.y) && L0.p.y - m.p.y >= 3 && (m.inv || {}).wind_charge && !((b.windCd || 0) > Date.now())) b.needLift = { x: L0.p.x, z: L0.p.z }
      b.c.call('stop').catch(() => {})
      b.anchor = { p: { ...m.p }, at: Date.now() }
    }
  }, 2000)
  const poll = setInterval(async () => {
    readDeaths()
    if (fs.existsSync(STOPF)) stop = true
    // Ход — по смещению за секунду (б/т); «ранен» — его хп упало (вспышка удара, видна глазами), в решения хп не идёт.
    for (const b of bots) {
      const s = await b.c.call('status').catch(() => null)
      if (!s || !s.state || !s.state.pos) continue
      const was = pos[b.name]; const p = s.state.pos
      // Игровые тики (clock.ticks): на ускоренном сервере секунда стены — десятки игровых.
      const tick = s.state.clock?.ticks ?? 0
      const dt = was && was.p && tick > was.tick ? tick - was.tick : 0
      const v = dt ? { x: (p.x - was.p.x) / dt, y: (p.y - was.p.y) / dt, z: (p.z - was.p.z) / dt } : { x: 0, y: 0, z: 0 }
      // «Ранен» — только рядом с противником (≤ 8 бл.): своя посадка и удар о землю — не повод его добивать.
      const foeNear = Object.entries(pos).some(([n, o]: any) => n !== b.name && o && o.p && Math.hypot(o.p.x - p.x, o.p.y - p.y, o.p.z - p.z) <= 8)
      const hurtTick = was && s.state.health < was.hp && foeNear ? tick : (was ? was.hurtTick : 0)
      if (was && teams) {
        const hNear = humanNear(p, 4.5)
        const botFoeNear = Object.entries(pos).some(([n, o]: any) => n !== b.name && teamOf(n) !== b.team && o && o.p && Math.hypot(o.p.x - p.x, o.p.y - p.y, o.p.z - p.z) <= 4.5)
        if (hNear.length && s.state.health < was.hp - 0.5 && !botFoeNear) relSay(b.team, hNear[0], -3, `ударил ${b.name}`)
        const cnt = (inv) => Object.values(inv || {}).reduce((a: number, n: any) => a + (Number(n) || 0), 0) as number
        const nearChest = arms && L.chests.some(c => Math.hypot(X + c.x - p.x, Y + c.y - p.y, Z + c.z - p.z) < 4)
        const gNear = humanNear(p, 8)
        if (gNear.length && cnt(s.state.inventory) > cnt(was.inv) && !nearChest && !Object.keys(deathAt).some(k => deathAt[k].p && Math.hypot(deathAt[k].p.x - p.x, deathAt[k].p.z - p.z) < 6)) {
          const got = Object.entries(s.state.inventory || {}).filter(([n, c]: any) => c > ((was.inv || {})[n] || 0)).map(([n, c]: any) => [n, c - ((was.inv || {})[n] || 0)]) as [string, number][]
          const value = got.reduce((a, [n, c]) => a + worthOf(n) * (worthOf(n) >= 1 ? 1 : c), 0)
          log(`🎁 ${b.name} принял от ${gNear[0]}: ${got.map(([n, c]) => n + '×' + c).join(', ')} — ценность ${value.toFixed(1)}`)
          if (value >= 1) { relSay(b.team, gNear[0], Math.min(10, Math.round(value) + 1), `подарил ${b.name} ${got.map(([n]) => n).join(', ')}`); emote(b, 'crouch', eyeOf(gNear[0])).then(() => emote(b, 'wave')) }
        }
        const hHeal = humanNear(p, 6)
        if (hHeal.length && s.state.health > was.hp + 3) relSay(b.team, hHeal[0], 2, `вылечил ${b.name}`)
      }
      pos[b.name] = { p, v, hp: s.state.health, hurtTick, tick, pots: (s.state.inventory || {}).splash_potion || 0, inv: s.state.inventory || {}, armor: s.state.armor || {}, labNeed: labNeed[b.name] || [] }
    }
  }, Number(process.env.FFA_POLL_MS || 250))
  // Дроп, стрелы, опыт — раз в 30 с по габариту Колизея (вещи копились и тормозили игру). Ракеты и трезубцы в
  // полёте не трогаем: ракета держит разгон элитр.
  const BOX = arms ? `x=${X - L.half},y=${Y - 6},z=${Z - L.half},dx=${2 * L.half},dy=${COLOS_MAP ? 46 : 24},dz=${2 * L.half}` : 'x=524,y=110,z=536,dx=152,dy=60,dz=128'
  const boardT = setInterval(() => {
    log('счёт (убил/умер) ' + board())
    for (const t of arms ? ['arrow', 'experience_orb'] : ['item', 'arrow', 'experience_orb']) rcon(i, `kill @e[type=${t},${BOX}]`).catch(() => {})
  }, 30000)
  if (arms) { roundT0 = Date.now(); if (process.env.ARMS_PHASES === '1') await armsPrep() }
  // ---------------------------------------------------------------- роли, отход команды, ротации
  // Роли — по снаряжению (crowd.assignRoles), пересчёт раз в минуту. Отход: видимые силы (crowd.teamForce) — заметно
  // слабее → вся команда к своему старту на ≤ 10 игровых с, обратно — когда сравнялись; новый отход не раньше 15 с
  // (гистерезис, иначе дёргается). Ротация: раненый (≤ 10 хп) при здоровом своём рядом уходит к лекарю, его врага
  // берёт здоровый («подменяю»); на бойца не чаще раза в 10 игровых с.
  const roles: Record<string, string> = {}
  const teamMode: Record<string, any> = { red: { retreat: false, until: 0, nextAt: 0 }, blue: { retreat: false, until: 0, nextAt: 0 } }
  const rotating: Record<string, any> = {}
  const rotateCd: Record<string, number> = {}
  const homeOf = (b) => arms ? armsHome(b, 0) : { x: X + (b.team === 'red' ? -12 : 12), y: Y, z: Z }
  const assign = () => {
    if (!teams) return
    for (const t of ['red', 'blue']) Object.assign(roles, crowd.assignRoles(bots.filter(b => b.team === t && pos[b.name]).map(b => ({ name: b.name, inv: pos[b.name].inv, armor: pos[b.name].armor })), tierOf))
    log('роли: ' + ['red', 'blue'].map(t => (t === 'red' ? '🟥 ' : '🟦 ') + bots.filter(b => b.team === t).map(b => `${b.name.replace('NeuroFarm' + i, '#') || '#'}=${roles[b.name] || '?'}`).join(' ')).join('  '))
  }
  await sleep(600)
  assign()
  const rolesT = setInterval(assign, 60000)
  const tactT = setInterval(() => {
    if (!teams) return
    if (arms && !between && Date.now() - roundT0 > Number(process.env.ROUND_S || 420) * 1000) endRound(true).catch(() => {})
    if (arms) for (const t of ['red', 'blue']) {
      const chef = bots.find(b => b.name === alchemist[t])
      if (chef && !busy.has(chef.name) && !brewed[t + 'strong_healing'] && (labNeed[chef.name] || []).length && labNeed[chef.name].every(x => (pos[chef.name]?.inv || {})[x])) { log(`⚗ ${chef.name}: набор собран — снова в лабораторию`); brewTask(chef, t) }
    }
    for (const t of ['red', 'blue']) {
      const ours = bots.filter(b => b.team === t && pos[b.name]?.p && pos[b.name].hp > 0 && !deadNow.has(b.name) && !out.has(b.name))
      if (!ours.length) continue
      const tick = Math.max(...ours.map(b => pos[b.name].tick || 0))
      const cx = ours.reduce((a, b) => a + pos[b.name].p.x, 0) / ours.length; const cz = ours.reduce((a, b) => a + pos[b.name].p.z, 0) / ours.length
      // Снаряжение видно: броня на теле, оружие (лучшее — его он и держит в бою).
      const gear = (n) => { const m = pos[n] || {}; const ar = Object.values(m.armor || {}).filter(Boolean).length; const w = Object.keys(m.inv || {}).filter(x => WEAPON.test(x)).reduce((a, x) => Math.max(a, tierOf(x) + 1), 0); return 1 + 0.15 * ar + 0.08 * w }
      const seen = bots.filter(b => b.team !== t && pos[b.name]?.p && pos[b.name].hp > 0 && Math.hypot(pos[b.name].p.x - cx, pos[b.name].p.z - cz) < 24).map(b => ({ name: b.name, p: pos[b.name].p, gear: gear(b.name) }))
      const f = crowd.teamForce(ours.map(b => ({ name: b.name, p: pos[b.name].p, hp: pos[b.name].hp, gear: gear(b.name) })), seen)
      const m = teamMode[t]
      if (!m.retreat && f.retreat && tick >= m.nextAt) { m.retreat = true; m.until = tick + 400; log(`⏪ ${t === 'red' ? 'красные' : 'синие'} отходят к старту: наших ${ours.length} (${Math.round(f.ours)} хп) против ${seen.length} видимых`) }
      else if (m.retreat && (f.push || tick > m.until)) { m.retreat = false; m.nextAt = tick + 300; log(`⏩ ${t === 'red' ? 'красные' : 'синие'} снова в атаку (${f.push ? 'силы сравнялись' : 'срок отхода'})`) }
    }
  }, 2000)
  // ---------------------------------------------------------------- гонка: лут и каптёр
  // Лут (LOOT_S игровых с): зоны — комнаты (кроме тайных) и четверти поля — делятся в команде (своя заявка на зону:
  // двое не бегут в одну). Сундук — только увиденный (blocks_around seen), забирается целиком; один сундук — одному.
  // Каптёр: команда сходится на своём старте, лишнее — тем, у кого пусто (оружие, слот брони, еда), всё надеть.
  async function armsPrep () {
    const LOOT_T = Number(process.env.LOOT_S || 150) * 20
    const areas = L.areas || [...L.rooms.filter(r => !L.secret.includes(r.id)).map(r => ({ id: r.id, x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 })),
      ...[[-1, -1], [-1, 1], [1, -1], [1, 1]].map(([sx, sz]) => ({ id: `поле${sx}${sz}`, x: 6 * sx, z: 6 * sz })),
      // Крыши коридора и комнат (y=5) — по лестницам, как в arms-run.knownAreas.
      { id: 'крышаW', x: -21, y: 5, z: 0 }, { id: 'крышаE', x: 21, y: 5, z: 0 }]
    const claimed: Record<string, Set<string>> = { red: new Set(), blue: new Set() }
    const taken = new Set<string>()
    const got: Record<string, number> = {}
    await sleep(800)
    const t0 = Math.max(...bots.map(b => pos[b.name]?.tick || 0))
    const w0 = Date.now(); const LOOT_WALL = Number(process.env.LOOT_WALL_S || 25) * 1000
    const looting = (b) => (pos[b.name]?.tick || 0) - t0 < LOOT_T || Date.now() - w0 < LOOT_WALL
    log(`гонка: лут ${LOOT_T / 20} игровых с, зон ${areas.length} — делятся в команде`)
    await Promise.all(bots.map(async (b) => {
      while (looting(b)) {
        const me = pos[b.name]; if (!me?.p) { await sleep(300); continue }
        const mine = claimed[b.team]
        const area = areas.filter(a => !mine.has(a.id)).sort((a, c) => Math.hypot(X + a.x - me.p.x, Z + a.z - me.p.z) - Math.hypot(X + c.x - me.p.x, Z + c.z - me.p.z))[0]
        if (!area) break
        mine.add(area.id)
        await b.c.call('goto', { x: X + area.x, y: Y + ((area as any).y || 0), z: Z + area.z, range: 3, timeoutSeconds: 15 }).catch(() => {})
        // Тайники: облицовка (доски в стене, каменистая земля в полу — признак, виден глазами) — сломать, за ней сундук.
        for (const cover of [AL.FACADE, AL.UNDER]) {
          const cv = await b.c.call('blocks_around', { find: cover, seen: true, radius: 10, count: 4 }).catch(() => null)
          for (const q of ((cv && cv.detail && cv.detail.found) || [])) {
            const ck = 'cv' + q.x + ',' + q.y + ',' + q.z
            if (taken.has(ck) || Math.max(Math.abs(q.x - X), Math.abs(q.z - Z)) > L.half) continue
            taken.add(ck)
            const r = await b.c.call('mine', { block: cover, at: { x: q.x, y: q.y, z: q.z }, collect: false, timeoutSeconds: 20 }).catch(e => ({ error: e.message }))
            log(`⛏ ${b.name} тайник ${q.x},${q.y},${q.z}: ${r && r.status}`)
          }
        }
        const res = await b.c.call('blocks_around', { find: 'chest', seen: true, radius: 14, count: 16 }).catch(() => null)
        for (const c of ((res && res.detail && res.detail.found) || [])) {
          if (!looting(b)) break
          const key = `${c.x},${c.y},${c.z}`
          if (taken.has(key) || Math.max(Math.abs(c.x - X), Math.abs(c.z - Z)) > L.half) continue
          taken.add(key)
          const r = await b.c.call('chest_take', { item: 'all', x: c.x, y: c.y, z: c.z }).catch(e => ({ error: e.message }))
          const moved = Object.values((r && r.detail && (r.detail.took || r.detail.moved)) || {}).reduce((a: number, n: any) => a + (Number(n) || 0), 0)
          got[b.name] = (got[b.name] || 0) + (moved as number)
          log(`🧰 ${b.name} сундук ${key} (${area.id}): ${moved ? '+' + moved : (r && (r.error || r.detail?.stopped)) || 'пусто'}`)
        }
      }
      await b.c.call('armor').catch(() => {})
    }))
    log(`гонка: лут окончен — сундуков открыто ${taken.size}/${L.chests.length}; ${bots.map(b => `${b.name.replace('NeuroFarm' + i, '#') || '#'}:${got[b.name] || 0}`).join(' ')}`)
    // Каптёр: сход на своём старте (≤ 10 игровых с), затем передачи «лишнее → пустому» внутри команды.
    await Promise.all(bots.map((b, k) => { const h = armsHome(b, k); return b.c.call('goto', { x: h.x, y: h.y, z: h.z, range: 2, timeoutSeconds: COLOS_MAP ? 40 : 10 }).catch(() => {}) }))
    await sleep(1500)
    // Передача — только тем, кто сошёлся (≤ 10 бл.): дальних каптёр не гоняет (колизей 10.10: «далеко 74 бл.», бой стоял минуты).
    const near = (a, c) => pos[a.name]?.p && pos[c.name]?.p && Math.hypot(pos[a.name].p.x - pos[c.name].p.x, pos[a.name].p.y - pos[c.name].p.y, pos[a.name].p.z - pos[c.name].p.z) <= 10
    let moves = 0
    for (const team of ['red', 'blue']) {
      const tm = bots.filter(b => b.team === team)
      for (const r of tm) {
        for (let n = 0; n < 4; n++) {
          const need = needOf(pos[r.name]); if (!need) break
          const donor = tm.filter(d => d !== r && pos[d.name] && near(d, r)).map(d => ({ d, give: spare(pos[d.name].inv, need, pos[d.name].armor) })).find(x => x.give)
          if (!donor) break
          await donor.d.c.call('goto', { x: pos[r.name].p.x, y: pos[r.name].p.y, z: pos[r.name].p.z, range: 2, timeoutSeconds: 4 }).catch(() => {})
          const t = await donor.d.c.call('assist', { mode: 'toss', ally: r.name, item: donor.give.item, count: donor.give.count }).catch(e => ({ detail: { why: e.message } }))
          const pu = await r.c.call('assist', { mode: 'pickup', item: donor.give.item }).catch(e => ({ detail: { why: e.message } }))
          await sleep(900)
          moves++
          log(`🎒 каптёр ${donor.d.name} → ${r.name}: ${donor.give.item}×${donor.give.count} (нужно ${need.item}) — ${t?.detail?.why || t?.status}; ${pu?.detail?.why || pu?.status}`)
          if (!(t?.detail?.ok)) break
        }
      }
    }
    // Алхимия: алхимик команды — у кого больше ингредиентов; свои свозят ему всё для варки (каптёр).
    for (const team of ['red', 'blue']) {
      const tm = bots.filter(b => b.team === team && pos[b.name])
      const alch = (n) => Object.entries(pos[n]?.inv || {}).filter(([k]) => ALCHEMY.test(k)).reduce((a, [, c]) => a + (c as number), 0)
      const chef = [...tm].sort((a, c) => alch(c.name) - alch(a.name))[0]
      if (!chef || !tm.some(b => alch(b.name) > 0)) continue
      alchemist[team] = chef.name
      for (const d of tm) {
        if (d === chef || !near(d, chef)) continue
        for (const [k, c] of Object.entries(pos[d.name].inv || {})) {
          if (!ALCHEMY.test(k)) continue
          await d.c.call('goto', { x: pos[chef.name].p.x, y: pos[chef.name].p.y, z: pos[chef.name].p.z, range: 2, timeoutSeconds: 4 }).catch(() => {})
          const t = await d.c.call('assist', { mode: 'toss', ally: chef.name, item: k, count: c }).catch(e => ({ detail: { why: e.message } }))
          const pu = await chef.c.call('assist', { mode: 'pickup', item: k }).catch(e => ({ detail: { why: e.message } }))
          moves++
          log(`⚗ ${d.name} → алхимику ${chef.name}: ${k}×${c} — ${t?.detail?.why || t?.status}; ${pu?.detail?.why || pu?.status}`)
        }
      }
    }
    // Апгрейд: надетое хуже лишнего у своего (железный шлем при запасном алмазном) — отдать лучшее.
    await Promise.all(bots.map(b => b.c.call('armor').catch(() => {})))
    await sleep(800)
    for (const team of ['red', 'blue']) {
      const tm = bots.filter(b => b.team === team && pos[b.name])
      for (const r of tm) for (const [slot, re] of Object.entries(ARMOR_SLOT)) {
        const worn = (pos[r.name].armor || {})[slot]
        const cur = worn ? tierOf(worn) : -1
        const offer = tm.filter(d => d !== r && near(d, r) && (pos[d.name].armor || {})[slot]).map(d => ({ d, it: Object.keys(pos[d.name].inv || {}).filter(n => (re as RegExp).test(n)).sort((a, c) => tierOf(c) - tierOf(a))[0] }))
          .filter(o => o.it && tierOf(o.it) > cur).sort((a, c) => tierOf(c.it) - tierOf(a.it))[0]
        if (!offer) continue
        await offer.d.c.call('goto', { x: pos[r.name].p.x, y: pos[r.name].p.y, z: pos[r.name].p.z, range: 2, timeoutSeconds: 4 }).catch(() => {})
        const t = await offer.d.c.call('assist', { mode: 'toss', ally: r.name, item: offer.it, count: 1 }).catch(e => ({ detail: { why: e.message } }))
        const pu = await r.c.call('assist', { mode: 'pickup', item: offer.it }).catch(e => ({ detail: { why: e.message } }))
        await sleep(900)
        moves++
        log(`🎒⬆ каптёр ${offer.d.name} → ${r.name}: ${offer.it} вместо ${worn || 'пусто'} — ${t?.detail?.why || t?.status}; ${pu?.detail?.why || pu?.status}`)
      }
    }
    await Promise.all(bots.map(b => b.c.call('armor').catch(() => {})))
    await sleep(800)
    const gear = (n) => { const m = pos[n] || {}; const w = Object.keys(m.inv || {}).filter(x => WEAPON.test(x)).sort((a, c) => tierOf(c) - tierOf(a))[0]; const a = Object.values(m.armor || {}).filter(Boolean).length; return `${w || 'без оружия'}+${a}бр` }
    log(`гонка: каптёр — передач ${moves}; к бою: ${bots.map(b => `${b.name.replace('NeuroFarm' + i, '#') || '#'} ${gear(b.name)}`).join(', ')}`)
    // Лаборатория (комната N2: стойка, верстак, вода): алхимик варит взрывное лечение II (есть ферм. глаз — и вред),
    // кузнец (слитки/алмазы + палки, без хорошего оружия) крафтит меч. Пока в лаборатории — не дерётся (busy).
    const labAt = { x: X + L.lab.brewing.x, y: Y + L.lab.brewing.y, z: Z + L.lab.brewing.z + 1 }
    const craftAt = { x: X + L.lab.crafting.x, y: Y + L.lab.crafting.y, z: Z + L.lab.crafting.z + 1 }
    for (const team of ['red', 'blue']) {
      const chef = bots.find(b => b.name === alchemist[team])
      if (chef) brewTask(chef, team)
      for (const b of bots.filter(o => o.team === team && o !== chef)) {
        const inv = pos[b.name]?.inv || {}
        const best = Object.keys(inv).filter(n => WEAPON.test(n)).reduce((a, n) => Math.max(a, tierOf(n)), -1)
        const item = (inv.diamond || 0) >= 2 && (inv.stick || 0) >= 1 && best < tierOf('diamond_sword') ? 'diamond_sword'
          : (inv.iron_ingot || 0) >= 2 && (inv.stick || 0) >= 1 && best < tierOf('iron_sword') ? 'iron_sword' : null
        if (item) labTask(b, async () => {
          await b.c.call('goto', { ...craftAt, range: 2, timeoutSeconds: 20 }).catch(() => {})
          const r = await b.c.call('craft', { item, count: 1 }).catch(e => ({ error: e.message }))
          log(`🔨 ${b.name} крафтит ${item}: ${r && r.status}${r && r.detail && r.detail.stopped ? ' — ' + r.detail.stopped : ''}`)
        })
      }
    }
  }
  // Алхимик в лаборатории: взрывное лечение II, потом взрывной вред. Не хватает — просит своих (labNeed → needOf),
  // повтор — когда набор полный (сторож tactT).
  function brewTask (chef, team) {
    const labAt = { x: X + L.lab.brewing.x, y: Y + L.lab.brewing.y, z: Z + L.lab.brewing.z + 1 }
    const labChest = { x: labAt.x - 1, y: labAt.y, z: labAt.z - 1 }
    labTask(chef, async () => {
      await chef.c.call('goto', { ...labAt, range: 2, timeoutSeconds: 20 }).catch(() => {})
      for (const [potion, why] of [['strong_healing', 'лечение'], ['harming', 'вред']]) {
        if (brewed[team + potion]) continue
        let r = await chef.c.call('brew', { potion, splash: true, count: 3 }).catch(e => ({ error: e.message }))
        let d = r && r.detail
        if (d && !d.made && Array.isArray(d.missing) && d.missing.length) {
          const t = await chef.c.call('chest_take', { item: d.missing.map(m => m.what).join(','), count: d.missing.reduce((a, m) => a + m.count - m.have, 0), ...labChest }).catch(e => ({ error: e.message }))
          log(`⚗ ${chef.name} берёт в лаборатории: ${JSON.stringify(t?.detail?.took || t?.error || t?.status)}`)
          r = await chef.c.call('brew', { potion, splash: true, count: 3 }).catch(e => ({ error: e.message })); d = r && r.detail
        }
        log(`⚗ ${chef.name} варит взрывное ${why}: ${d ? (d.made ? 'сварил ' + d.made : d.stopped || 'нет') : r.error || r.status}`)
        if (d && d.made) { brewed[team + potion] = true; labNeed[chef.name] = []; continue }
        if (potion === 'strong_healing' && d && Array.isArray(d.missing)) labNeed[chef.name] = d.missing.map(m => m.what).filter(w => ALCHEMY.test(w))
        break
      }
    })
  }
  // Конец раунда: команда без живых — победа другой; пауза, уборка, новые сундуки, все на старт, снова лут и бой.
  // Раунд дольше ROUND_S (420 реальных с) — победа той, где живых больше (ничья — по убийствам).
  async function endRound (timeout = false) {
    if (!arms || between) return
    const alive = (t) => bots.filter(b => b.team === t && !out.has(b.name)).length
    let win = alive('red') === 0 ? 'blue' : alive('blue') === 0 ? 'red' : null
    if (!win && timeout) {
      const kt = (t) => names.filter(n => teamOf(n) === t).reduce((a, n) => a + (kills[n] || 0), 0)
      win = alive('red') !== alive('blue') ? (alive('red') > alive('blue') ? 'red' : 'blue') : (kt('red') >= kt('blue') ? 'red' : 'blue')
    }
    if (!win) return
    between = true
    roundWins[win]++
    const ru = win === 'red' ? 'красных' : 'синих'
    for (const o of bots) if (o.team === win && !out.has(o.name)) emote(o, Math.random() < 0.5 ? 'crouch' : 'wave')
    log(`🏁 раунд ${round}${timeout ? ' (время)' : ''}: победа ${ru} — раунды 🟥 ${roundWins.red} : ${roundWins.blue} 🟦; ${board()}`)
    await rcon(i, `title @a title {"text":"Победа ${ru}","color":"${win}"}`).catch(() => {})
    await rcon(i, `title @a subtitle {"text":"Раунд ${round} · 🟥 ${roundWins.red} : ${roundWins.blue} 🟦"}`).catch(() => {})
    for (const b of bots) await b.c.call('stop').catch(() => {})
    await sleep(5000)
    round++
    for (const t of ['item', 'arrow', 'experience_orb', 'splash_potion']) await rcon(i, `kill @e[type=${t},${BOX}]`).catch(() => {})
    await restoreArena()
    await stockChests(round)
    for (const k of Object.keys(deathAt)) delete deathAt[k]
    for (const k of Object.keys(radio)) delete radio[k]
    opened.clear(); chestBy.clear(); chestFail.clear()
    for (const k of Object.keys(labNeed)) delete labNeed[k]
    for (const k of Object.keys(brewed)) delete brewed[k]
    for (const k of Object.keys(alchemist)) delete alchemist[k]
    for (const [k, b] of bots.entries()) {
      const h = armsHome(b, k)
      for (const c of [`gamemode survival ${b.name}`, `clear ${b.name}`, `effect clear ${b.name}`, `effect give ${b.name} minecraft:instant_health 1 10 true`, `effect give ${b.name} minecraft:saturation 1 20 true`, `tp ${b.name} ${h.x} ${h.y} ${h.z}`]) await rcon(i, c).catch(() => {})
      await roundKit(b)
    }
    out.clear(); deadNow.clear()
    await rcon(i, `title @a title {"text":"Раунд ${round}","color":"gold"}`).catch(() => {})
    await sleep(1500)
    if (process.env.ARMS_PHASES === '1') await armsPrep()
    roundT0 = Date.now(); lastKillAt = Date.now(); killGaps.length = 0
    between = false
  }
  function labTask (b, fn) {
    busy.add(b.name)
    fn().catch(() => {}).finally(() => { busy.delete(b.name); b.c.call('armor').catch(() => {}) })
  }
  await Promise.all(bots.map(async (b, k) => {
    while (!stop) {
      if (arms && (between || out.has(b.name)) && !deadNow.has(b.name)) { await sleep(500); continue }
      if (busy.has(b.name) && !deadNow.has(b.name)) { await sleep(500); continue }
      if (arms && deadNow.has(b.name)) {
        deadNow.delete(b.name)
        out.add(b.name)
        await b.c.call('stop').catch(() => {})
        await sleep(800)
        for (const c of [`gamemode spectator ${b.name}`, `tp ${b.name} ${X} ${Y + 28} ${Z}`]) await rcon(i, c).catch(() => {})
        log(`👻 ${b.name} выбыл до конца раунда ${round} (${b.team === 'red' ? 'красные' : 'синие'}: живых ${bots.filter(o => o.team === b.team && !out.has(o.name)).length})`)
        await endRound()
        continue
      }
      if (deadNow.has(b.name)) {
        deadNow.delete(b.name)
        await b.c.call('stop').catch(() => {})
        await sleep(1500)
        if (arms) { const h = armsHome(b, Math.floor(Math.random() * 6)); for (const c of [`effect give ${b.name} minecraft:instant_health 1 10 true`, `spreadplayers ${Math.floor(h.x)} ${Math.floor(h.z)} 0 3 under ${Y + 3} false ${b.name}`]) await rcon(i, c).catch(() => {}); await b.c.call('armor').catch(() => {}) } else {
          await dress(i, b.name, kit).catch(() => {})
          await place(b.name, home(b, Math.floor(Math.random() * N))).catch(() => {})
        }
        await sleep(1000)
        continue
      }
      const me = pos[b.name]
      const foes = names.filter(n => n !== b.name && pos[n] && pos[n].hp > 0 && !deadNow.has(n) && !out.has(n) && (!teams || teamOf(n) !== b.team))
      const mates = teams ? names.filter(n => n !== b.name && teamOf(n) === b.team && pos[n] && pos[n].hp > 0 && !deadNow.has(n) && !out.has(n)) : []
      if (!me || !me.p || !foes.length) { await sleep(500); continue }
      // На насесте — сидеть, пока гнавшийся рядом; ушёл — слезать по делам.
      if ((b.perchUntil || 0) > Date.now()) {
        // Насест высоко — враг внизу далеко по прямой (16+ по высоте): «рядом» — по горизонтали 24 бл.
        if (enemiesOf(b, me.p).some(e => Math.hypot(e.p.x - me.p.x, e.p.z - me.p.z) < 24)) { b.waiting = true; await sleep(1000); b.waiting = false; continue }
        b.perchUntil = 0
      }
      if (b.needLift) {
        const to = b.needLift; b.needLift = null; b.windCd = Date.now() + 6000
        const r = await b.c.call('wind_jump', { toward: to, up: true, times: 1 }).catch(e => ({ error: e.message }))
        const d0 = r?.detail || r
        log(`💨 ${b.name} подбросил себя зарядом ветра к ярусу: ${d0?.why || `подъём ${d0?.rise ?? '?'}`}`)
        continue
      }
      if (b.needDrop) {
        b.needDrop = false
        const r = await b.c.call('goto', { x: X + 0.5, y: Y, z: Z + 0.5, range: 6, timeoutSeconds: 8, descent: { maxFallDamage: 8, minGain: 0 } }).catch(e => ({ error: e.message }))
        log(`🪂 ${b.name} спрыгивает с высоты ${Math.round(me.p.y - Y)}: ${r?.error || r?.status} → y ${Math.round(pos[b.name]?.p?.y ?? 0)}`)
        // Яма в постройке арены (замурован: пол и стены вокруг, выход на 2 выше, блоков нет) — третий раз не вышло:
        // вытащить на свой старт (ферма, команды можно), чтобы боец не простоял весь раунд.
        const y1 = pos[b.name]?.p?.y ?? me.p.y
        b.dropFails = y1 > Y + 3 ? (b.dropFails || 0) + 1 : 0
        if (b.dropFails >= 3) { const h = armsHome(b, bots.indexOf(b)); await rcon(i, `tp ${b.name} ${h.x} ${h.y} ${h.z}`).catch(() => {}); log(`🆘 ${b.name} не может спуститься с ${Math.round(me.p.x)} ${Math.round(y1)} ${Math.round(me.p.z)} — вытащил на старт`); b.dropFails = 0 }
        continue
      }
      if (b.gift) {
        const g = b.gift
        await b.c.call('look_at', { x: humans[g.from]?.p?.x ?? g.at.x, y: (humans[g.from]?.p?.y ?? g.at.y) + 1.6, z: humans[g.from]?.p?.z ?? g.at.z }).catch(() => {})
        await b.c.call('goto', { x: g.at.x, y: g.at.y, z: g.at.z, range: 1, timeoutSeconds: 5 }).catch(() => {})
        await b.c.call('assist', { mode: 'pickup', item: g.id, maxD: 4 }).catch(() => {})
        await b.c.call('armor').catch(() => {})
        b.gift = null
        continue
      }
      if (arms) {
        // Враги рядом — все противники одним списком (боты чужой команды и враждебные игроки), ближние первыми.
        const enemies = enemiesOf(b, me.p)
        const need = !geared(me)
        // Чужая смерть видна (сообщение в чате, вещи на земле): ближний труп в 30 бл. — бежать за вещами, пока не забрали
        // (10.10). Голым — не туда, где на вещах стоит снаряжённый враг (≤ 5 бл.).
        // Время до встречи вместо радиусов (10.10): враг успеет к точке раньше меня — она его.
        const reachT = (e, q) => dist3(e.p, q) / Math.max(e.spd, SPRINT)
        // Убил моб (10.10: бежали за вещами туда, где виндикатор только что убил, — и ложились рядом): место его, пока
        // кто-то из своих видит моба в 10 бл. от вещей; никто не видит — первые 20 с всё равно его.
        const mobGuards = (d) => d.byMob && (Date.now() - d.at < 20000 || Object.values(pos).some((o: any) => (o?.mobs || []).some(m0 => dist3(m0.p, d.p) < 10)))
        const guardedBy = (q) => enemies.some(e => e.geared && reachT(e, q) < dist3(me.p, q) / SPRINT)
        const spot = Object.entries(deathAt).filter(([, d]: any) => Date.now() - d.at < 120000 && !d.looted.has(b.name) && !d.empty && !mobGuards(d) && Math.hypot(d.p.x - me.p.x, d.p.z - me.p.z) < 30 && Math.abs(d.p.y - me.p.y) < 10 && !(need && guardedBy(d.p)))
          .sort((a: any, c: any) => Math.hypot(a[1].p.x - me.p.x, a[1].p.z - me.p.z) - Math.hypot(c[1].p.x - me.p.x, c[1].p.z - me.p.z))[0]
        const foeClose = enemies.some(e => reachT(e, me.p) < 1.25)
        const friend = teams ? Object.entries(humans).filter(([n, h]: any) => (rel[b.team][n] || 0) >= 0 && h.p && h.hp > 0 && Math.hypot(h.p.x - me.p.x, h.p.y - me.p.y, h.p.z - me.p.z) < 10)[0] as any : null
        if (friend && Date.now() - (b.noticeAt || 0) > 3000) {
          b.noticeAt = Date.now()
          const [hn, h] = friend
          await b.c.call('look_at', { x: h.p.x, y: h.p.y + 1.6, z: h.p.z }).catch(() => {})
          const r0 = Math.random(); if (r0 < 0.4) await emote(b, (rel[b.team][hn] || 0) > 0 ? (r0 < 0.2 ? 'crouch' : 'wave') : (r0 < 0.2 ? 'nod' : 'wave'))
          const r = String(await rcon(i, `data get entity @e[type=item,x=${me.p.x.toFixed(1)},y=${me.p.y.toFixed(1)},z=${me.p.z.toFixed(1)},distance=..7,limit=1,sort=nearest] Item`).catch(() => ''))
          const im = /id: "minecraft:([a-z0-9_]+)"/.exec(r); const cm = /count: (\d+)/.exec(r)
          if (im) {
            const w = worthOf(im[1])
            const said = (b.itemSaid ||= {})
            if (w >= 1) {
              log(`🤔 ${b.name} видит ${im[1]}×${cm ? cm[1] : 1} рядом с ${hn} — стоит взять`)
              await b.c.call('assist', { mode: 'pickup', item: im[1], maxD: 7 }).catch(() => {})
              await b.c.call('armor').catch(() => {})
              continue
            } else if (!said[im[1]]) { said[im[1]] = 1; log(`🤔 ${b.name} видит ${im[1]} рядом с ${hn} — не нужно`) }
          }
        }
        const foeNear = enemies.some(e => reachT(e, me.p) < 2.5) // столько уходит на сундук: дойти, открыть, надеть
        // Враг сильнее моей силы здесь (retreatPlan): к своим, если успеваю. Не успеваю, а сам не снаряжён — к неоткрытому
        // сундуку, до которого добегу раньше, чем догонят (и он не ближе к врагу), или прочь, если не догонят вовсе. Иначе — бой.
        const dP = dist3
        const lost = outmatched(b)
        const hopeless = !!lost
        const plan = hunt() && !hopeless ? null : (lost || retreatPlan(b))
        const threat = plan?.enemy || null
        if (plan?.ally) {
          if (Date.now() - (b.fleeSaid || 0) > 6000) { b.fleeSaid = Date.now(); radioSay(b, `отхожу к ${short(plan.ally.n)}, за мной ${short(threat.n)}!`); log(`🏃 ${b.name} к своим — ${plan.ally.n} (${plan.ally.tA.toFixed(1)} с пути; ${threat.n} догонит ${plan.catchT === Infinity ? 'не раньше' : 'через ' + plan.catchT.toFixed(1) + ' с'}; сила ${Math.round(plan.local)} → ${Math.round(plan.ally.group)} против ${Math.round(threat.pow)})`) }
          await b.c.call('goto', { x: plan.ally.p.x, y: plan.ally.p.y, z: plan.ally.p.z, range: 2, timeoutSeconds: Math.max(2, Math.ceil(plan.ally.tA)) }).catch(() => {})
          continue
        }
        if (need && !hopeless && threat && plan.catchT < 1.5 && Date.now() - (b.fleeSaid || 0) > 10000) { b.fleeSaid = Date.now(); log(`🥊 ${b.name} от ${threat.n} не убежать (догонит через ${plan.catchT.toFixed(1)} с, своих не успеть) — дерусь`) }
        if ((need || hopeless) && threat && (plan.catchT >= 1.5 || hopeless)) {
          if (hopeless) callout(b, 'help', { foe: threat.n, foes: 1, mates: 0 }, 6000, `помогите! за мной ${short(threat.n)}, мне его не взять`)
          // Медленный моб (громила 3.5 бл/с против спринта 5.6) «не догонит» по прямой, но в комнате и у стены догоняет (10.10:
          // бежали к сундуку мимо виндикатора и умирали) — рядом с безнадёжным врагом только бег, без сундуков и поиска пути.
          const urgent = hopeless && (plan.catchT < 1.5 || threat.d < 8)
          const pinned = hopeless && (plan.catchT < 1 || threat.d < 3.5)
          const ck = (c) => `${c.x},${c.y},${c.z}`
          const at = (c) => ({ x: X + c.x, y: Y + c.y, z: Z + c.z })
          const away = L.chests.filter(c => !opened.has(ck(c)) && (!chestBy.has(ck(c)) || chestBy.get(ck(c)) === b.name))
            .map(c => ({ c, me: dP(at(c), me.p), him: dP(at(c), threat.p) })).filter(o => !urgent && o.him > o.me && o.me / SPRINT < plan.catchT).sort((a, c) => a.me - c.me)[0]
          if (!away && plan.catchT < Infinity && !hopeless) { /* бежать некуда, догонит — бой */ } else {
          if (Date.now() - (b.fleeSaid || 0) > 10000) { b.fleeSaid = Date.now(); log(`🏃 ${b.name} ${hopeless ? `не одолеть ${threat.mob ? threat.kind : threat.n} (нас рядом ${plan.group}, мой урон по нему ${dpsOn(fighterOf(b.name), fighterOf(threat.n)).toFixed(2)}/с, его по мне ${dpsOn(fighterOf(threat.n), fighterOf(b.name)).toFixed(1)}/с)` : 'без снаряги'} — бегу от ${threat.mob ? threat.kind : threat.n}${away ? ' к сундуку ' + away.c.room : ''}`) }
          // Открыть на бегу (~1 с у сундука) — если враг за это время не дотянется.
          if (away && away.me < 3 && threat.d / Math.max(threat.spd, SPRINT) > 1.5) {
            const k0 = ck(away.c); const A = at(away.c)
            const r = await b.c.call('chest_take', { item: 'all', ...A }).catch(e => ({ error: e.message }))
            const moved = Object.values((r && r.detail && (r.detail.took || r.detail.moved)) || {}).reduce((a: number, n: any) => a + (Number(n) || 0), 0)
            opened.add(k0)
            if (moved) { await b.c.call('armor').catch(() => {}); log(`🧰 ${b.name} сундук ${away.c.room} на бегу: +${moved}`) }
            continue
          }
          let to = away ? at(away.c) : null
          // Некуда к сундуку — к ближайшему своему, что не за спиной у врага (там помогут), иначе прочь от него.
          const mate = !to && mates.map(n => pos[n]?.p).filter(q => q && dP(q, threat.p) > dP(me.p, threat.p) * 0.8).sort((a, c) => dP(a, me.p) - dP(c, me.p))[0]
          if (mate) to = mate
          if (!to) {
            const dx = me.p.x - threat.p.x; const dz = me.p.z - threat.p.z; const l = Math.hypot(dx, dz) || 1
            const lim = (v, c) => Math.max(c - L.half + 8, Math.min(c + L.half - 8, v))
            to = { x: lim(me.p.x + dx / l * 16, X), y: me.p.y, z: lim(me.p.z + dz / l * 16, Z) }
          } else if (away) chestBy.set(ck(away.c), b.name)
          // Безнадёжно и он рядом (догонит за 1.5 с) — бег по ходу (smartFlee: прочь, уклон, жемчуг), а не поиск пути к
          // точке: путь в Колизее ищется секунды (3000+ узлов), и бот стоял, пока его ваншотят.
          // Чем уйти, по цене (10.10): заряд ветра — рывок вперёд-вверх на 7–10 бл. (быстрее его бега); кирка и стена рядом —
          // в стену, заложиться и сидеть на шифте; иначе — бег по ходу.
          const inv0 = me.inv || {}
          const perch = !away && urgent && inv0.ender_pearl && !((b.pearlCd || 0) > Date.now()) && perches
            .map(q => ({ q, dm: Math.hypot(q.x - me.p.x, q.z - me.p.z), dt: Math.hypot(q.x - threat.p.x, q.z - threat.p.z) }))
            .filter(o => o.dm >= 8 && o.dm <= 38 && o.dt > o.dm * 0.7).sort((a, c) => (c.dt - c.dm * 0.5) - (a.dt - a.dm * 0.5))[0]
          // Насеста нет, а прижали (догонит меньше чем за секунду, 10.10: «упёрся в стену, прыгал в потолок, а жемчуг был») —
          // жемчуг просто прочь от него на 16 бл. (земля поля; посадку ищет планировщик броска).
          const awayPearl = !perch && !away && pinned && inv0.ender_pearl && !((b.pearlCd || 0) > Date.now())
          const pq = perch ? perch.q : null
          if (pq || awayPearl) {
            const dx0 = me.p.x - threat.p.x; const dz0 = me.p.z - threat.p.z; const l0 = Math.hypot(dx0, dz0) || 1
            const to = pq || { x: X + Math.max(-L.R + 3, Math.min(L.R - 3, me.p.x - X + dx0 / l0 * 16)), y: Y, z: Z + Math.max(-L.R + 3, Math.min(L.R - 3, me.p.z - Z + dz0 / l0 * 16)) }
            const r = await b.c.call('pearl_to', { to, loose: !pq }).catch(e => ({ error: e.message }))
            const d0 = r?.detail || r
            // Долетел — сидеть; не вышло (нет дуги, сорвали) — 8 с не бросать (гонка 10.10: «нет броска» каждую секунду).
            if (d0?.ok && pq) b.perchUntil = Date.now() + 20000; else if (!d0?.ok) b.pearlCd = Date.now() + 8000
            log(`🌀 ${b.name} жемчугом ${pq ? `на высоту ${Math.round(pq.y - Y)}` : 'прочь'} от ${threat.n}: ${d0?.ok ? (pq ? 'долетел, сижу' : 'ушёл') : (d0?.stop || r?.error || r?.status)}`)
            if (d0?.ok && !pq) b.perchUntil = 0
          } else if (!away && urgent && inv0.wind_charge && !((b.windCd || 0) > Date.now())) {
            b.windCd = Date.now() + 6000
            const dx = me.p.x - threat.p.x; const dz = me.p.z - threat.p.z; const l = Math.hypot(dx, dz) || 1
            const r = await b.c.call('wind_jump', { toward: { x: me.p.x + dx / l * 16, z: me.p.z + dz / l * 16 }, times: 2 }).catch(e => ({ error: e.message }))
            const d0 = r?.detail || r
            if (Date.now() - (b.windSaid || 0) > 5000) { b.windSaid = Date.now(); log(`💨 ${b.name} уходит от ${threat.n} на зарядах ветра: ${d0?.why || (d0?.used != null ? `${d0.used} шт., подъём ${d0.rise}` : (r?.error || r?.status))}`) }
          } else if (!away && pinned && !((b.burrowCd || 0) > Date.now()) && Object.keys(inv0).some(n => /_pickaxe$/.test(n))) {
            const r = await b.c.call('burrow', { away: threat.p, depth: 4 }).catch(e => ({ error: e.message }))
            const d0 = r?.detail || r
            // Не вышло (нет стены, копать вниз нельзя) — 8 с не пробовать (гонка 10.10: 1081 попытка за 30 с у одного) и бежать.
            // Зарылся — сидеть в ходе (как на насесте), а не рыть дальше каждые 2 с.
            if (d0?.ok) b.perchUntil = Date.now() + 20000
            if (!d0?.ok) { b.burrowCd = Date.now() + 8000; await b.c.call('flee', { from: fleeFrom(b, me.p), toward: fleeToward(b, me.p), timeoutSeconds: 3, safeDist: 16 }).catch(() => {}) }
            if (d0?.ok || Date.now() - (b.burrowSaid || 0) > 8000) b.burrowSaid = Date.now(), log(`🕳 ${b.name} ${d0?.down ? 'закапывается' : 'уходит в стену'} от ${threat.n}: ${d0?.ok ? `прорыл ${d0.dug}, заложил ${d0.sealed}` : (d0?.why || r?.error || r?.status)}`)
          } else if (!away && urgent) {
            const r = await b.c.call('flee', { from: fleeFrom(b, me.p), toward: fleeToward(b, me.p), timeoutSeconds: 3, safeDist: 16 }).catch(() => null)
            const d0 = r?.detail || r || {}
            if (Date.now() - (b.fleeLogAt || 0) > 8000) { b.fleeLogAt = Date.now(); log(`🏃‍♂️ ${b.name} бег от ${threat.mob ? threat.kind : threat.n}: ${d0.mode || r?.status || '?'}${d0.ran != null ? `, ${d0.ran} бл.` : ''}${d0.jukes ? `, рывков ${d0.jukes}` : ''}`) }
          }
          // Догоняет вплотную — закрыть проход за собой (паутина, стена в проходе, лава/вода на его пути), не чаще 2 с.
          const tq = pos[threat.n]?.p || humans[threat.n]?.p || (threat.mob ? threat.p : null)
          if (tq && pos[b.name]?.p && dist3(tq, pos[b.name].p) < 6 && (b.blockAt || 0) < Date.now()) {
            b.blockAt = Date.now() + 2000
            const r = await b.c.call('block_behind', threat.mob ? { fromId: threat.id } : { from: threat.n }).catch(() => null)
            const d0 = r?.detail || r
            if (d0?.ok) log(`🧱 ${b.name} закрыл проход от ${threat.n}: ${d0.how}${d0.corridor ? ' (в проходе)' : ''}`)
          }
          else await b.c.call('goto', { x: to.x, y: to.y, z: to.z, range: away ? 2 : 3, timeoutSeconds: 4 }).catch(() => {})
          if (away) chestBy.delete(ck(away.c))
          continue
          }
        }
        // Своя кирка (10.10: «пусть крафтят кирки, если есть возможность»): кирки нет, есть 3 алмаза/слитка/булыжника и
        // палки (или доски на них) — скрафтить, пока враг не рядом; верстак — из рюкзака, иначе демон сделает из досок.
        const inv = me.inv || {}
        if (!foeNear && (b.craftAt || 0) < Date.now() && !Object.keys(inv).some(n => /_pickaxe$/.test(n))) {
          const planks = Object.keys(inv).filter(n => /_planks$/.test(n)).reduce((a, n) => a + inv[n], 0)
          const mat = [['diamond', 'diamond'], ['iron_ingot', 'iron'], ['cobblestone', 'stone']].find(([it]) => (inv[it] || 0) >= 3)
          if (mat && ((inv.stick || 0) >= 2 || planks >= 2) && (inv.crafting_table || planks >= 4 + ((inv.stick || 0) >= 2 ? 0 : 2))) {
            b.craftAt = Date.now() + 30000
            if ((inv.stick || 0) < 2) await b.c.call('craft', { item: 'stick', count: 1, timeoutSeconds: 8 }).catch(() => {})
            const r = await b.c.call('craft', { item: `${mat[1]}_pickaxe`, count: 1, timeoutSeconds: 15 }).catch(e => ({ error: e.message }))
            log(`⛏ ${b.name} крафтит ${mat[1]}_pickaxe: ${r?.error || r?.detail?.why || r?.status || 'готово'}`)
            continue
          }
        }
        b.looting = true
        try {
        if (!foeNear && !(spot && !foeClose)) {
          const key = (c) => `${c.x},${c.y},${c.z}`
          const d3 = (c) => Math.hypot(X + c.x - me.p.x, (Y + c.y - me.p.y) * 2, Z + c.z - me.p.z)
          // Отряд держится кучно и на луте: из равных сундуков — ближе к лидеру.
          const Lp = teams && leaderOf(b.name) !== b.name ? pos[leaderOf(b.name)]?.p : null
          const nearLead = (c) => Lp ? Math.hypot(X + c.x - Lp.x, Z + c.z - Lp.z) / 2 : 0
          const ch = L.chests.filter(c => !opened.has(key(c)) && (!chestBy.has(key(c)) || chestBy.get(key(c)) === b.name) && !((b.chestCd ||= {})[key(c)] > Date.now()) && !(b.badSpots || []).some(s0 => s0.until > Date.now() && Math.hypot(s0.x - X - c.x, s0.y - Y - c.y, s0.z - Z - c.z) < 2.5))
            .filter(c => d3(c) < (need ? 90 : 14)).sort((a, c) => d3(a) + nearLead(a) - d3(c) - nearLead(c))[0]
          if (ch) {
            const k0 = key(ch); chestBy.set(k0, b.name)
            const A = { x: X + ch.x, y: Y + ch.y, z: Z + ch.z }
            await b.c.call('goto', { x: A.x, y: A.y, z: A.z, range: 2, timeoutSeconds: 15 }).catch(() => {})
            for (const cv of ch.cover || []) await b.c.call('mine', { block: cv.block, at: { x: X + cv.x, y: Y + cv.y, z: Z + cv.z }, collect: false, timeoutSeconds: 8 }).catch(() => {})
            const r = await b.c.call('chest_take', { item: 'all', ...A }).catch(e => ({ error: e.message }))
            const moved = Object.values((r && r.detail && (r.detail.took || r.detail.moved)) || {}).reduce((a: number, n: any) => a + (Number(n) || 0), 0)
            const fails = (chestFail.get(k0) || 0) + (moved || /прервано|interrupted/.test(String(r?.error || r?.status || '')) ? 0 : 1); chestFail.set(k0, fails)
            if (moved || fails >= 2 || /пуст|нет ни сундука/.test(String(r?.error || r?.detail?.stopped || ''))) opened.add(k0)
            chestBy.delete(k0)
            // Сорвали (бьют издали, тревога) — этот сундук мне на 15 с не цель: гонка 10.10 — 227 срывов подряд у одних и тех же.
            if (!moved && /прервано|interrupted/.test(String(r?.error || r?.status || ''))) b.chestCd[k0] = Date.now() + 15000
            if (moved) { await b.c.call('armor').catch(() => {}); log(`🧰 ${b.name} сундук ${ch.room}: +${moved}`) }
            else log(`⚠ ${b.name} сундук ${ch.room} (${A.x} ${A.y} ${A.z}) не взят: ${String(r?.error || r?.detail?.stopped || JSON.stringify(r?.detail?.left || r?.detail?.contents || r?.status || '')).slice(0, 160)}`)
            continue
          }
        }
        if (spot && !foeClose) {
          const [victim, d]: any = spot
          d.looted.add(b.name)
          const far = Math.hypot(d.p.x - me.p.x, d.p.z - me.p.z)
          // Вещи врага (10.10: «уничтожать вражеский лут, если самим не нужен — экономика важна»): что было на нём,
          // нужно кому-то из моих — забрать; не нужно никому, а у врага ещё есть кому подобрать — сжечь/залить лавой.
          const mine = names.filter(n => teamOf(n) === b.team && !out.has(n) && !deadNow.has(n))
          const foesLeft = names.some(n => teamOf(n) !== b.team && !out.has(n) && !deadNow.has(n)) || enemies.some(e => e.human)
          const canBurn = Object.keys(me.inv || {}).some(n => /^(lava_bucket|flint_and_steel|fire_charge)$/.test(n))
          if (teams && d.team && d.team !== b.team && foesLeft && canBurn && !gearUseful(d, mine)) {
            log(`🔥 ${b.name}: вещи ${victim} никому из наших не нужны — уничтожаю, чтобы не достались врагу`)
            await b.c.call('goto', { x: d.p.x, y: d.p.y, z: d.p.z, range: 3, timeoutSeconds: Math.round(4 + far / 4) }).catch(() => {})
            const r = await b.c.call('assist', { mode: 'deny', at: d.p, maxD: 6 }).catch(e => ({ error: e.message }))
            const dd = r?.detail || {}
            log(`🔥 ${b.name} → ${victim}: ${dd.ok ? `${dd.how}, сгорело ${dd.burned}, осталось ${dd.left}` : (dd.why || r?.error || r?.status)}`)
            if (/нет вещей/.test(String(dd.why))) d.empty = true
            if ((dd.ok && !dd.left) || d.empty) continue
          }
          if (far > 8) log(`💀 ${b.name} бежит за вещами ${victim} (${Math.round(far)} бл.)`)
          await b.c.call('goto', { x: d.p.x, y: d.p.y, z: d.p.z, range: 1, timeoutSeconds: Math.round(4 + far / 4) }).catch(() => {})
          let n = 0
          for (let k = 0; k < 8; k++) { const r = await b.c.call('assist', { mode: 'pickup', maxD: 6 }).catch(() => null); if (!r?.detail?.ok) break; n++ }
          if (n) { await b.c.call('armor').catch(() => {}); log(`💰 ${b.name} лутает ${victim}: подобрал ${n}`) }
          continue
        }
        } finally { b.looting = false }
      }
      const body = n => ({ name: n, p: pos[n].p, v: pos[n].v, hurtAgo: pos[n].hurtTick ? (pos[b.name].tick - pos[n].hurtTick) * 50 : Infinity })
      const ally = n => ({ ...body(n), hp: pos[n].hp, target: bots.find(o => o.name === n)?.cur ?? null })
      const live = () => foes.filter(n => pos[n] && !deadNow.has(n)).map(body)
      const cur = b.cur && !deadNow.has(b.cur) && foes.includes(b.cur) ? b.cur : null
      const pickNow = () => teams
        ? crowd.chooseTeamTarget(body(b.name), mates.map(ally), live(), { persona: b.persona, current: cur, blast: BLAST.test(kit) || process.env.ARMS_CRYSTAL === '1' || process.env.ARMS_TNT === '1', hotspots: Object.entries(rally).filter(([t, r]) => t !== b.team && r).map(([, r]) => r.at), role: roles[b.name] || '', relieve: Object.entries(rotating).filter(([n, r]: any) => n !== b.name && teamOf(n) === b.team && r.until > (pos[b.name]?.tick || 0)).map(([, r]: any) => r.foe) })
        : crowd.chooseTarget(body(b.name), live(), { persona: b.persona, current: cur })
      // Командная помощь — до боя: лечить раненого рядом, стенка между ним и тем, кто его бьёт, самому на ≤ 6 хп — к своим.
      // Хп союзников знаю (свои говорят в чате), не чаще раза в 2 с на бойца.
      const support = () => {
        if (!teams) return null
        // Свежие данные: support зовёт и сторож во время боя (до 30 игровых с) — me из начала боя устарел, и срок сбора
        // считался от старого тика: остальные тут же снимали сбор как просроченный (показ 10.10: 3 сбора, 0 хилок).
        const me = pos[b.name]
        if (!me || !me.p) return null
        const tick = me.tick || 0
        let R = rally[b.team]
        const dist = (a, c) => Math.hypot(a.x - c.x, a.y - c.y, a.z - c.z)
        // Лекарь погиб или сбор пережил свой срок (+2 с) — снять, иначе команда больше не соберётся.
        if (R && (deadNow.has(R.healer) || !pos[R.healer] || tick > R.untilTick + 40)) { log(`📣✗ сбор ${R.healer} снят (${deadNow.has(R.healer) ? 'лекарь погиб' : 'срок'}, видел ${b.name})`); delete rally[b.team]; R = null }
        if (R) {
          if (R.healer === b.name) {
            const arrived = [...R.members].filter(n => pos[n] && dist(pos[n].p, R.at) < 3).length
            if (arrived >= 2 || tick >= R.untilTick || live().some(e => dist(e.p, R.at) < 3)) return { mode: 'rally_heal' }
            return { mode: 'rally_wait' }
          }
          if (R.members.has(b.name) && tick < R.untilTick) return dist(me.p, R.at) > 2 ? { mode: 'rally_go', at: R.at } : { mode: 'rally_wait' }
        // Сбор объявляет лекарь; нет живого лекаря — любой с зельями.
        } else if (me.pots >= 2 && me.hp > 10 && me.p.y <= Y + 4.5 && (roles[b.name] === 'лекарь' || !mates.some(n => roles[n] === 'лекарь'))) {
          const hurt = mates.filter(n => pos[n].hp <= 12 && pos[n].p.y <= Y + 4.5 && dist(pos[n].p, me.p) <= 12)
          if (hurt.length >= 2) {
            rally[b.team] = { at: { ...me.p }, healer: b.name, members: new Set(hurt), untilTick: tick + 120 }
            log(`📣 ${b.name}: хилка у меня — ${hurt.join(', ')}`)
            tell(b, `[${b.team === 'red' ? 'красные' : 'синие'}] хилка у меня, сюда!`)
            return { mode: 'rally_wait' }
          }
        }
        // Кристаллы: свои врозь — ближе 4 бл. к союзнику — шаг прочь на 5 (один взрыв не должен брать двоих); не чаще 3 с.
        if ((BLAST.test(kit) || process.env.ARMS_CRYSTAL === '1' || process.env.ARMS_TNT === '1') && (spreadAt[b.name] || 0) < Date.now()) {
          const near = mates.filter(n => pos[n]?.p && dist(pos[n].p, me.p) < 4)
          if (near.length) {
            const ax = near.reduce((a, n) => a + pos[n].p.x, 0) / near.length; const az = near.reduce((a, n) => a + pos[n].p.z, 0) / near.length
            const dx = me.p.x - ax; const dz = me.p.z - az; const h = Math.hypot(dx, dz) || 1
            spreadAt[b.name] = Date.now() + 3000
            return { mode: 'spread', at: { x: me.p.x + dx / h * 5, y: me.p.y, z: me.p.z + dz / h * 5 }, from: near.join('+') }
          }
        }
        // Алхимик ждёт ингредиент у стойки (точка встречи), если он есть у своих — носильщик идёт туда; ни у кого нет —
        // дерётся (гонка 10.10: носильщик 19 раз не догнал алхимика в бою: «далеко 5–10 бл.», «не видно»).
        if (arms && alchemist[b.team] === b.name && (labNeed[b.name] || []).length) {
          const miss = labNeed[b.name].filter(x => !(me.inv || {})[x])
          if (miss.length && mates.some(n => miss.some(x => (pos[n]?.inv || {})[x]))) {
            const at = { x: X + L.lab.brewing.x, y: Y + L.lab.brewing.y, z: Z + L.lab.brewing.z + 1 }
            return { mode: 'lab_wait', at, far: dist(me.p, at) > 2 }
          }
        }
        // Отход команды: к своему старту; на месте — обычный бой (кто догнал — получит).
        if (teamMode[b.team]?.retreat) { const h = homeOf(b); if (dist(me.p, h) > 4) return { mode: 'retreat', at: h } }
        // Ротация: раненый на фронте при здоровом своём рядом — назад к лекарю (или к центру своих), врага берёт здоровый.
        if (roles[b.name] !== 'лекарь' && me.hp <= 10 && b.cur && tick >= (rotateCd[b.name] || 0)) {
          const fresh = mates.find(n => pos[n].hp >= 16 && dist(pos[n].p, me.p) <= 10)
          if (fresh) {
            const healer = mates.find(n => roles[n] === 'лекарь' && pos[n]?.p)
            const to = healer ? pos[healer].p : homeOf(b)
            rotating[b.name] = { foe: b.cur, until: tick + 100 }
            rotateCd[b.name] = tick + 200
            return { mode: 'rotate', at: to, foe: b.cur, fresh, healer }
          }
        }
        if ((help[b.name] || 0) > Date.now()) return null
        const meB = body(b.name)
        // Зелье — в точку, где всплеск вылечит больше своих (crowd.healPlan); зелий нет — не лекарь (показ 10.10: 19 из 47).
        const hp = me.pots > 0 && me.hp > 8 ? crowd.healPlan({ ...meB, hp: me.hp }, mates.filter(n => !healing.has(n)).map(ally), live()) : null
        if (hp) return { mode: 'heal', at: hp.at, ally: hp.allies.join('+'), value: hp.value }
        for (const m of mates) {
          if ((pos[m].hp ?? 20) > 10 || Math.hypot(pos[m].p.x - me.p.x, pos[m].p.z - me.p.z) > 4) continue
          const f = live().find(e => Math.hypot(e.p.x - pos[m].p.x, e.p.z - pos[m].p.z) < 4 && crowd.aimingAt(e, ally(m)))
          if (f) return { mode: 'wall', ally: m, foe: f.name }
        }
        // Запросы своих: кому чего не хватает — отдаёт ближайший с запасом (свои говорят в чате, «нужно: …»).
        for (const m of mates) {
          const need = needOf(pos[m])
          // ≤ 4 бл. — кинуть из рук (Q); дальше — не отдавать в бою.
          const far = need && ALCHEMY.test(need.item) ? 30 : 3
          if (!need || Math.hypot(pos[m].p.x - me.p.x, pos[m].p.y - me.p.y, pos[m].p.z - me.p.z) > far || me.hp <= 12 || giving.has(m)) continue
          const give = spare(me.inv, need, me.armor)
          if (give) return { mode: 'give', ally: m, item: give.item, count: give.count, need: need.item }
        }
        // К своим на ≤ 6 хп — если они не рядом (уже среди своих — не бегать кругами: 45 «к своим» подряд у одного) и не охота.
        if (me.hp <= 6 && mates.length && !hunt()) {
          const cx = mates.reduce((a, n) => a + pos[n].p.x, 0) / mates.length; const cz = mates.reduce((a, n) => a + pos[n].p.z, 0) / mates.length
          if (Math.hypot(cx - me.p.x, cz - me.p.z) / SPRINT > 1.5) return { mode: 'regroup' }
        }
        return null
      }
      const job = support()
      if (job && job.mode === 'lab_wait') {
        if (job.far) await b.c.call('goto', { x: job.at.x, y: job.at.y, z: job.at.z, range: 1, timeoutSeconds: 4 }).catch(() => {})
        else { await b.c.call('stop').catch(() => {}); await sleep(500) }
        continue
      }
      if (job && (job.mode === 'retreat' || job.mode === 'rotate')) {
        if (job.mode === 'rotate') log(`🔄 ${b.name} (${Math.round(me.hp)} хп) уходит ${job.healer ? 'к лекарю ' + job.healer : 'к своим'}, ${job.foe} берёт ${job.fresh}`)
        await b.c.call('goto', { x: job.at.x, y: job.at.y, z: job.at.z, range: 2, timeoutSeconds: 3 }).catch(() => {})
        continue
      }
      if (job && job.mode === 'spread') {
        log(`↔ ${b.name} врозь от ${job.from}`)
        await b.c.call('goto', { x: job.at.x, y: job.at.y, z: job.at.z, range: 1.5, timeoutSeconds: 1.5 }).catch(() => {})
        continue
      }
      if (job && /^rally/.test(job.mode)) {
        const R = rally[b.team]
        if (job.mode === 'rally_go') { await b.c.call('goto', { x: job.at.x, y: job.at.y, z: job.at.z, range: 1.5, timeoutSeconds: 2 }).catch(() => {}); continue }
        if (job.mode === 'rally_wait') { b.waiting = true; await b.c.call('stop').catch(() => {}); await sleep(250); b.waiting = false; continue }
        // Бросок — в точку наибольшей пользы среди собравшихся (healPlan), не нашлось — в точку сбора.
        const plan = crowd.healPlan({ ...body(b.name), hp: me.hp }, mates.map(ally), live())
        if (!plan && !R) continue
        const at = plan ? plan.at : R.at
        const r = await b.c.call('assist', { mode: 'heal', at }).catch(e => ({ detail: { why: e.message } }))
        const d = r && r.detail
        log(`💊📣 ${b.name}: хилка — ${plan ? plan.allies.join('+') + ' (+' + plan.value + ' хп)' : 'никто не успел'}: ${d ? d.why : r.status}`)
        delete rally[b.team]
        continue
      }
      if (job) {
        help[b.name] = Date.now() + 2000
        if (job.mode === 'regroup') {
          const cx = mates.reduce((a, n) => a + pos[n].p.x, 0) / mates.length; const cz = mates.reduce((a, n) => a + pos[n].p.z, 0) / mates.length
          log(`↩ ${b.name} (${Math.round(me.hp)} хп) — к своим`)
          await b.c.call('goto', { x: cx, y: Y, z: cz, range: 2, timeoutSeconds: 4 }).catch(() => {})
          continue
        }
        if (job.mode === 'give') {
          giving.add(job.ally)
          if (ALCHEMY.test(job.item)) await b.c.call('goto', { x: pos[job.ally].p.x, y: pos[job.ally].p.y, z: pos[job.ally].p.z, range: 2, timeoutSeconds: 8 }).catch(() => {})
          const had = (pos[job.ally]?.inv || {})[job.item] || 0
          const r = await b.c.call('assist', { mode: 'toss', ally: job.ally, item: job.item, count: job.count }).catch(e => ({ status: 'failed', error: e.message }))
          // Стак ложится между нами — получатель шагает ко мне и проходит по нему (он дрался в стороне: 4 броска, 0 подобрано).
          const rc = bots.find(o => o.name === job.ally)
          if (r && r.detail && r.detail.ok && rc) await rc.c.call('assist', { mode: 'pickup', item: job.item }).catch(() => {})
          await sleep(800)
          giving.delete(job.ally)
          const d = r && r.detail
          const got = ((pos[job.ally]?.inv || {})[job.item] || 0) > had
          log(`📦 ${b.name} → ${job.ally}: ${job.item}×${job.count} (просил ${job.need}) — ${d ? d.why : r.error || r.status}${d && d.ok ? (got ? ', подобрал' : ', не подобрал') : ''}`)
          continue
        }
        if (job.mode === 'heal') for (const n of job.ally.split('+')) healing.add(n)
        const r = await b.c.call('assist', job).catch(e => ({ detail: { why: e.message } }))
        if (job.mode === 'heal') setTimeout(() => { for (const n of job.ally.split('+')) healing.delete(n) }, 3000)
        const d = r && r.detail
        log(`${job.mode === 'heal' ? '💊' : '🧱'} ${b.name} → ${job.ally}${job.foe ? ' от ' + job.foe : ''}${job.value ? ' (+' + job.value + ' хп своим)' : ''}: ${d ? d.why : r.status}`)
        continue
      }
      const humanPick = () => {
        if (!teams) return null
        const d = (q) => Math.hypot(q.x - me.p.x, q.y - me.p.y, q.z - me.p.z)
        const hostile = Object.entries(humans).filter(([n, h]: any) => (rel[b.team][n] || 0) < 0 && h.hp > 0 && d(h.p) < (COLOS_MAP ? 160 : 48)).sort((a: any, c: any) => d(a[1].p) - d(c[1].p))[0]
        // Игрок — такой же враг, как боты другой команды (10.10: «пусть друг с другом дерутся, а то меня только бьют»):
        // беру его, только если он ближе ближайшего вражеского бота или уже на мне, и не больше трёх своих на одном.
        // Безнадёжно против него — не лезть (бежит цикл бойца выше).
        if (hostile && arms && outmatched(b)?.enemy?.n === hostile[0]) return null
        if (hostile) {
          const hd = d((hostile[1] as any).p)
          const botD = Math.min(Infinity, ...foes.filter(n => !deadNow.has(n) && pos[n]?.p).map(n => d(pos[n].p)))
          const onHim = bots.filter(o => o !== b && teamOf(o.name) === b.team && o.cur === hostile[0]).length
          if (b.cur === hostile[0] || hd < 6 || (hd <= botD && onHim < 3)) return { target: hostile[0], why: 'игрок напал на нашу команду' }
        }
        const guard = Object.entries(humans).find(([n, h]: any) => (rel[b.team][n] || 0) > 0 && h.hurtBy && Date.now() - h.hurtAt < 6000 && teamOf(h.hurtBy) !== b.team && !out.has(h.hurtBy) && d(h.p) < 40)
        if (guard) return { target: (guard[1] as any).hurtBy, why: `прикрываю ${guard[0]}` }
        return null
      }
      const pickAll = () => answerHelp(b) || humanPick() || focusPick(b) || pickNow()
      // Мобы рядом, а врага-бойца в 3 с бега нет — бить мобов (fight без цели: ближний враждебный моб в 24 бл.), не чаще
      // раза в 3 с на бойца; моба не видно — бой отказывает сразу.
      const nearMob = enemiesOf(b, me.p).find(e => e.mob)
      if (MOBS && (b.mobTry || 0) < Date.now() && !enemiesOf(b, me.p).some(e => !e.mob && e.d / Math.max(e.spd, SPRINT) < 3) && nearMob && winsAgainst([fighterOf(b.name)], fighterOf(nearMob.n))) {
        b.mobTry = Date.now() + 3000
        const fr = await b.c.call('fight', { clearArea: 16, purpose: 'defense', timeoutSeconds: 15, retreatAtHealth: 5 }).catch(e => ({ status: 'error', error: e.message }))
        if (fr && fr.status !== 'failed' && fr.status !== 'error') { if (Date.now() - (b.mobSaid || 0) > 10000) { b.mobSaid = Date.now(); log(`👹 ${b.name} бьётся с мобами: ${fr.status} ${String(fr.detail?.killed || fr.detail?.stopped || '').slice(0, 60)}`) } continue }
      }
      // Отряд: лидер вне боя собирает снаряжённых своих («за мной!»), они бегут к нему; враг в 2.5 с пути — бой как есть.
      if (teams && !hunt() && !answerHelp(b) && !enemiesOf(b, me.p).some(e => e.d / Math.max(e.spd, SPRINT) < 2.5)) {
        const Ld = leaderOf(b.name)
        if (Ld === b.name) {
          const far = squadOf(b.name).filter(n => n !== b.name && alive(n) && geared(pos[n])).map(n => dist3(pos[n].p, me.p) / SPRINT).filter(t => t > 1.5)
          const gk = `${b.name}:gather`; const g = radio[gk]
          if (g && Date.now() > g.until + 15000) delete radio[gk]
          if (far.length && (!radio[gk] || radio[gk].until > Date.now())) {
            if (!radio[gk]) callout(b, 'gather', { at: { ...me.p } }, (Math.max(...far) + 2) * 1000, `за мной! собираемся (${far.length} в пути)`)
            b.waiting = true; await b.c.call('stop').catch(() => {}); await sleep(400); b.waiting = false; continue
          }
        } else if (Ld && geared(me) && pos[Ld]?.p && !((b.followCd || 0) > Date.now())) {
          const t = dist3(pos[Ld].p, me.p) / SPRINT
          const tFoe = Math.min(Infinity, ...enemiesOf(b, me.p).map(e => e.d / SPRINT))
          // К лидеру — если он ближе врага (иначе бой с тем, кто ближе: бежали к лидеру за 60 с пути мимо врагов).
          if (t > 1.5 && t < tFoe) {
            if (Date.now() - (b.followSaid || 0) > 8000) { b.followSaid = Date.now(); log(`👣 ${b.name} → к лидеру ${Ld} (${t.toFixed(1)} с пути)`) }
            b.following = true
            await b.c.call('goto', { x: pos[Ld].p.x, y: pos[Ld].p.y, z: pos[Ld].p.z, range: 2, timeoutSeconds: Math.ceil(t) + 1 }).catch(() => {})
            b.following = false
            continue
          }
        }
      }
      const pick = pickAll()
      if (!pick) {
        // Охота: цели нет (выбор пуст) — к ближайшему врагу.
        const e0 = hunt() && enemiesOf(b, me.p)[0]
        if (e0) await b.c.call('goto', { x: e0.p.x, y: e0.p.y, z: e0.p.z, range: 3, timeoutSeconds: Math.ceil(e0.d / SPRINT) + 2 }).catch(() => {})
        else await sleep(500)
        continue
      }
      if (pick.target !== b.cur) log(`🎯 ${b.name} → ${pick.target} (${pick.why})`)
      if (teams && pick.target !== b.cur && leaderOf(b.name) === b.name && squadOf(b.name).filter(alive).length > 1) radioSay(b, `в атаку на ${short(pick.target)}!`)
      ;b.cur = pick.target
      // Цель далеко (игрок или боец) — сначала дойти (бой с целью за полкарты срывался «не вижу цель», и бот стоял).
      const hp0 = humans[pick.target] || (hunt() ? pos[pick.target] : null)
      if (hp0?.p && Math.hypot(hp0.p.x - me.p.x, hp0.p.y - me.p.y, hp0.p.z - me.p.z) > 16) {
        await b.c.call('goto', { x: hp0.p.x, y: hp0.p.y, z: hp0.p.z, range: 10, timeoutSeconds: 5 }).catch(() => {})
        continue
      }
      // Баффы перед сшибкой (10.10: «пусть ускоряются жёстко и мочат»): цель в 3 с бега — выпить скорость и силу, если их
      // нет (не чаще раза в 12 с; зелья — из сундуков).
      const tp = humans[pick.target]?.p || pos[pick.target]?.p
      if (arms && tp && dist3(tp, me.p) / SPRINT < 3 && (b.buffAt || 0) < Date.now()) {
        b.buffAt = Date.now() + 12000
        const r = await b.c.call('drink_buffs', { kinds: ['swiftness', 'strength'] }).catch(() => null)
        const dr = (r?.detail || r)?.drunk
        if (dr?.length) log(`🧪 ${b.name} выпил перед боем с ${pick.target}: ${dr.join(', ')}`)
      }
      // Клещи (воздух): напарник бьёт ту же цель — сказать, откуда он заходит; таран зайдёт с другой стороны.
      const pincer = () => {
        if (!teams) return
        const mate = mates.find(n => bots.find(o => o.name === n)?.cur === b.cur && pos[n]?.p)
        if (mate) b.c.call('team_hint', { target: b.cur, from: { x: pos[mate].p.x, z: pos[mate].p.z } }).catch(() => {})
      }
      pincer()
      // Пересмотр на земле: толпа меняется быстрее 30 с; в воздухе таран не обрываем (обрыв — потеря управления).
      const watch = setInterval(() => {
        pincer()
        const m = pos[b.name]
        if (!m || !m.p || (!COLOS_MAP && m.p.y > Y + 4.5)) return
        // «Нужна помощь»: враги в 1.5 с пути сильнее меня со своими рядом (power) — вызов, отвечают свободные.
        if (teams) {
          const en = enemiesOf(b, m.p).filter(e => e.d / Math.max(e.spd, SPRINT) < 1.5)
          const ours = names.filter(n => n !== b.name && teamOf(n) === b.team && alive(n) && dist3(pos[n].p, m.p) / SPRINT < 1.5)
          const pe = en.reduce((s, e) => s + e.pow, 0); const pm = power(m.hp, m.inv, m.armor) + ours.reduce((s, n) => s + power(pos[n].hp, pos[n].inv, pos[n].armor), 0)
          if (en.length && pe > pm) callout(b, 'help', { foe: b.cur && foeAlive(b.cur) ? b.cur : en[0].n, foes: en.length, mates: ours.length }, 6000, `нужна помощь! ${en.length} на ${ours.length + 1}, у меня ${Math.round(m.hp)} хп`)
        }
        const again = pickAll()
        // Свою цель новый выбор перебил с учётом липкости (stick) — сменить.
        // С игроком — только смена цели (сторож рвал бой каждые 2 с задачами поддержки: «прервано (cancelled)»).
        // Враг сильнее, свои успевают помочь (retreatPlan) — бросить бой и к ним (10.10: «один — убегать к союзникам»).
        if ((again && again.target !== b.cur) || (!humans[b.cur] && support()) || (arms && !hunt() && retreatPlan(b)?.ally) || (arms && outmatched(b))) b.c.call('stop').catch(() => {})
      }, 2000)
      try {
        // Враг быстрее моего спринта (игрок со «Скоростью», 10.10: «убегать начал, хотя я быстрее») — бой до конца: лечиться под
        // ударами и бить, а не отворачиваться спиной (отход в демоне на низком хп).
        const foe = enemiesOf(b, me.p).find(e => e.n === pick.target)
        const fr = await b.c.call('fight', { target: pick.target, allowPlayer: true, timeoutSeconds: SEG_S, retreatAtHealth: 3, lastStand: !!foe && foe.spd > SPRINT && !retreatPlan(b)?.ally, arena: { x: X + 0.5, y: Y, z: Z + 0.5, r: R } }).catch(e => { sleep(1000); return { status: 'error', error: e.message } })
        // Бой с живым игроком — в журнал итог: чем кончился и что делал (разбор «в углу мечется, не лечится, не бьёт»).
        if (fr && fr.status === 'failed') await sleep(700) // не вижу цель / умер — не крутить попытки сотнями
        if (humans[pick.target] && fr && fr.status !== 'failed') { const d = fr.detail || {}; log(`⚔ ${b.name} vs ${pick.target}: ${fr.status} хп ${Math.round(pos[b.name]?.hp ?? 0)} | ${d.stopped || fr.error || ''} | ${JSON.stringify(d.used || d.moves || d.notes || Object.keys(d)).slice(0, 300)}`) }
      } finally { clearInterval(watch) }
    }
  }))
  clearInterval(poll); clearInterval(frozenT); if (mobPollT) clearInterval(mobPollT); if (mobT) clearInterval(mobT); clearInterval(humanT); clearInterval(lootWatch); clearInterval(giftT); clearInterval(boardT); clearInterval(announce); clearInterval(rolesT); clearInterval(tactT)
  for (const b of bots) await b.c.call('stop').catch(() => {})
  log('итог (убил/умер) ' + board())
  process.exit(0)
}

async function buildLan (who) {
  if (!LAN) throw new Error('нужен ARMS_LAN=<порт>')
  await lanConn()
  let [X0, Y0, Z0] = (process.env.ARMS_POS || '').split(/\s+/).map(Number)
  if (!process.env.ARMS_POS) {
    const ps = await lanCmd(`data get entity ${who} Pos`)
    const m = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(String(ps)); if (!m) throw new Error(`нет позиции ${who}: ${ps}`)
    X0 = Math.floor(+m[1]); Y0 = Number(process.env.ARMS_Y || 200); Z0 = Math.floor(+m[3])
  }
  log(`Колизей в LAN ${LAN}: ${X0} ${Y0} ${Z0}`)
  await lanCmd('gamerule log_admin_commands false')
  process.env.ARENA_COLOS_FLAG = process.env.ARENA_COLOS_FLAG || path.join(ROOT, 'farm', 'results', 'lan-colosseum.json')
  const CZB = require(path.join(ROOT, 'daemon', 'build-colosseum'))
  const esc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const call = async (m, p) => {
    if (m === 'say') { await lanCmd(String(p.text).replace(/^\//, '')); return {} }
    if (m === 'ask') { const l = await lanCmd(String(p.command).replace(/^\//, ''), p.ms || 3000, new RegExp(esc(p.match))); return { detail: { lines: l ? [l] : [] } } }
  }
  await CZB.run({ call, log, X: X0, Y: Y0, Z: Z0, R: 24, ceilH: 16, who: LAN_NAME, rules: false, rate: Number(process.env.ARENA_COLOS_RATE || 120) })
  fs.writeFileSync(path.join(ROOT, 'farm', 'results', 'lan-pos.txt'), `${X0} ${Y0} ${Z0}`)
  log(`готово: ARMS_POS="${X0} ${Y0} ${Z0}"`)
}

const [cmd, slot, arg] = process.argv.slice(2)
if (cmd === 'build-lan') buildLan(slot || 'HuHguZ').then(() => process.exit(0), e => { console.error(e); process.exit(1) })
else {
const i = Number(slot)
if (!(i >= 1 && i <= 32)) { console.log('node farm/ffa.js up|run|down <слот> [N|набор]'); process.exit(1) }
;(cmd === 'up' ? up(i, Number(arg || 4)).then(() => process.exit(0)) : cmd === 'down' ? Promise.resolve(down(i)).then(() => process.exit(0)) : cmd === 'run' ? run(i, arg || 'elytra') : cmd === 'team' ? run(i, arg || 'team', { teams: true }) : cmd === 'arms' ? run(i, 'arms', { teams: true, arms: true }) : Promise.reject(new Error('команда?'))).catch(e => { console.error(e); process.exit(1) })
}
