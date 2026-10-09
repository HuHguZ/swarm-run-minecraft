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

const EXTRA = 'cdefghijkl' // до 12 бойцов на слот (с NeuroFarm<i> и <i>b)
const extra = (i, k) => ({ name: `NeuroFarm${i}${EXTRA[k]}`, ws: 8961 + k, viewer: 3261 + k, mem: path.join(ROOT, 'farm', `memory-${i}${EXTRA[k]}`) })
const SEG_S = Number(process.env.FFA_SEG_S || 30)
// Центр поля: Колизей (600 120 600); гонка вооружений — своя карта arms-layout (ARMS_POS, по умолчанию 2000 100 2000).
let X = 600; let Y = 120; let Z = 600; let R = 24
// Снаряжение: оружие, еда, слоты брони; ступень материала — кому отдавать худшее.
const WEAPON = /(_sword|_axe|_spear|^mace|^trident|^bow|^crossbow)$/
const FOOD = /^(golden_apple|enchanted_golden_apple|bread|cooked_w+|baked_potato|apple|carrot|golden_carrot|pumpkin_pie)$/
const ARMOR_SLOT: Record<string, RegExp> = { head: /_helmet$/, torso: /_chestplate$/, legs: /_leggings$/, feet: /_boots$/ }
const ALCHEMY = /^(nether_wart|glistering_melon_slice|glowstone_dust|gunpowder|blaze_powder|glass_bottle|fermented_spider_eye|spider_eye|redstone)$/
const tierOf = (n: string) => ['wooden', 'golden', 'stone', 'copper', 'chainmail', 'iron', 'diamond', 'netherite'].findIndex(t => n.startsWith(t)) + (/^(mace|trident)$/.test(n) ? 6 : 0)

function props (i) { return fs.readFileSync(path.join(ROOT, 'farm', `server-${i}`, 'server.properties'), 'utf8') }
const prop = (p, k) => (p.match(new RegExp('^' + k.replace('.', '\\.') + '=(.*)$', 'm')) || [])[1]
function rcon (i, cmd, timeoutMs = 8000) {
  const p = props(i)
  const port = Number(prop(p, 'rcon.port')); const pass = prop(p, 'rcon.password')
  return new Promise<any>((resolve, reject) => {
    const pkt = (id, type, body) => { const b = Buffer.from(body, 'utf8'); const buf = Buffer.alloc(14 + b.length); buf.writeInt32LE(10 + b.length, 0); buf.writeInt32LE(id, 4); buf.writeInt32LE(type, 8); b.copy(buf, 12); return buf }
    const sock = net.connect(port, '127.0.0.1', () => sock.write(pkt(1, 3, pass)))
    let acc = Buffer.alloc(0); let authed = false
    const t = setTimeout(() => { sock.destroy(); reject(new Error('rcon timeout')) }, timeoutMs)
    sock.on('data', d => {
      acc = Buffer.concat([acc, d])
      while (acc.length >= 4) {
        const len = acc.readInt32LE(0)
        if (acc.length < len + 4) break
        const id = acc.readInt32LE(4); const body = acc.slice(12, len + 2).toString('utf8')
        acc = acc.slice(len + 4)
        if (!authed) { if (id === -1) { clearTimeout(t); sock.end(); return reject(new Error('rcon auth failed')) } authed = true; sock.write(pkt(2, 2, cmd)) } else { clearTimeout(t); sock.end(); return resolve(body) }
      }
    })
    sock.on('error', e => { clearTimeout(t); reject(e) })
  })
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
    const env = { ...process.env, ND_WS_PORT: String(s.ws), MC_USERNAME: s.name, MC_PORT: String(25600 + i), ND_VIEWER_PORT: String(s.viewer), ND_MEMORY_DIR: s.mem }
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
  const AL = arms ? require(path.join(ROOT, 'daemon', 'arms-layout')) : null
  const L = arms ? AL.generate(process.env.SEED || 'team1') : null
  if (arms) {
    const [ax, ay, az] = (process.env.ARMS_POS || '2000 100 2000').split(/\s+/).map(Number)
    X = ax; Y = ay; Z = az; R = 27
    await rcon(i, `forceload add ${X - L.half} ${Z - L.half} ${X + L.half} ${Z + L.half}`).catch(() => {})
    let bad = 0
    for (const c of AL.commands(L, { X, Y, Z })) { const r = await rcon(i, c, 20000).catch(e => String(e)); if (/Unknown|Incorrect|Expected|not loaded|Too many|timeout/i.test(r)) bad++ }
    await rcon(i, `kill @e[type=!minecraft:player,x=${X - L.half},y=${Y + L.y0},z=${Z - L.half},dx=${2 * L.half},dy=${L.y1 - L.y0},dz=${2 * L.half}]`).catch(() => {})
    log(`гонка: карта seed ${L.seed} у ${X} ${Y} ${Z} — сундуков ${L.chests.length}, команд не прошло ${bad}`)
    // Свой лут на 12 бойцов (пользователь 10.10: «добавь ресурсов, покруче»): карта arms-layout рассчитана на дуэль —
    // 14 оружия на 12, лава в сундуках. Сундук очищается и набивается заново (seed): оружие железо/алмаз, броня,
    // щиты, яблоки, зелья, жемчуг, еда, блоки; тайники — лучше. Нарочно неровно: кому-то два меча, кому-то пусто —
    // каптёру есть что делить. ARMS_LOOT=layout — как было.
    if (process.env.ARMS_LOOT !== 'layout') {
      let seed = [...String(L.seed)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7)
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
        // Оружие: в 65% сундуков, в тайнике — и второе (пара — повод делиться).
        for (let w = 0; w < (hidden ? 2 : 1); w++) if (rnd() < 0.65) {
          const kind = pickOne(['sword', 'sword', 'axe', 'bow', 'crossbow'])
          if (kind === 'bow' || kind === 'crossbow') items.push(`${kind} 1`, 'arrow 24'); else items.push(`${mat()}_${kind} 1`)
          stats.weapons++
        }
        const nArmor = Math.floor(rnd() * (hidden ? 3 : 2)) + (hidden ? 1 : 0)
        for (let a = 0; a < nArmor; a++) { items.push(`${mat()}_${pickOne(['helmet', 'chestplate', 'leggings', 'boots'])} 1`); stats.armor++ }
        for (let e = 0; e < 1 + (hidden ? 2 : 1); e++) items.push(pickOne(['golden_apple 2', `${heal} 2`, 'shield 1', 'ender_pearl 2', 'cooked_beef 8', 'cobblestone 32', 'golden_apple 1', `${heal} 1`]))
        // Зелья (пользователь 10.10: «больше зелий — хилок и опасных»): лечение чаще всего, вред/яд взрывные, сила/реген.
        for (let e = 0; e < (hidden ? 3 : 2); e++) items.push(pickOne([`${heal} 2`, `${heal} 1`, `${heal} 2`, pot('splash_potion', 'strong_harming') + ' 1', pot('splash_potion', 'harming') + ' 2',
          pot('splash_potion', 'poison') + ' 1', pot('potion', 'strength') + ' 1', pot('potion', 'regeneration') + ' 1']))
        // Алхимия и кузница — по частям в разных сундуках: полный набор только у команды вместе (свозят алхимику).
        if (rnd() < 0.45) items.push(pickOne(['nether_wart 3', 'glistering_melon_slice 3', 'glowstone_dust 3', 'gunpowder 3', 'blaze_powder 2', 'glass_bottle 3', 'fermented_spider_eye 2']))
        if (rnd() < 0.3) items.push(pickOne(['iron_ingot 2', 'diamond 2', 'stick 2']))
        const p = { x: X + c.x, y: Y + c.y, z: Z + c.z }
        await rcon(i, `data merge block ${p.x} ${p.y} ${p.z} {Items:[]}`).catch(() => {})
        let slot = 0
        used.set(c.id, items.length)
        for (const it of items) { const [n, k] = it.split(/ (?=\d+$)/); await rcon(i, `item replace block ${p.x} ${p.y} ${p.z} container.${slot++} with minecraft:${n} ${k || 1}`).catch(() => {}); stats.items++ }
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
      log(`гонка: сундуки набиты — оружия ${stats.weapons}, брони ${stats.armor}, всего предметов ${stats.items} (без лавы)`)
    }
  }
  const bots: any[] = [{ name: `NeuroFarm${i}`, ws: 8800 + i }, { name: `NeuroFarm${i}b`, ws: 8900 + i }]
  for (let k = 0; k < EXTRA.length; k++) { const s = extra(i, k); if (await portOpen(s.ws)) bots.push({ name: s.name, ws: s.ws }) }
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
  for (const c of ['gamerule do_immediate_respawn true', 'gamerule keep_inventory true', 'gamerule spawn_mobs false', 'gamerule send_command_feedback false', 'gamerule do_daylight_cycle false', 'time set day', 'weather clear']) await rcon(i, c).catch(() => {})
  const pos: Record<string, any> = {}
  const deaths: Record<string, number> = {}
  const kills: Record<string, number> = {}
  const LOGF = path.join(ROOT, 'farm', `server-${i}`, 'logs', 'latest.log')
  let logAt = fs.statSync(LOGF).size
  const names = bots.map(b => b.name)
  const deadNow = new Set<string>()
  // Смерти и убийства — по журналу сервера (кто кого: «X was slain/speared by Y»).
  const readDeaths = () => {
    try {
      const st = fs.statSync(LOGF); if (st.size <= logAt) return
      const fd = fs.openSync(LOGF, 'r'); const buf = Buffer.alloc(st.size - logAt); fs.readSync(fd, buf, 0, buf.length, logAt); fs.closeSync(fd); logAt = st.size
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        const m = /\]: (NeuroFarm\S+) (was .+|died.*|fell.+|hit the ground.*|burned.*|tried to swim.*|drowned.*|experienced kinetic.*|suffocated.*|starved.*|froze.*|withered.*|went up in flames.*|blew up.*|walked into.*|discovered.*|left the confines.*)$/.exec(line)
        if (!m || !names.includes(m[1])) continue
        deaths[m[1]] = (deaths[m[1]] || 0) + 1
        const by = names.find(n => n !== m[1] && (' ' + m[2] + ' ').includes(' ' + n + ' '))
        if (by) kills[by] = (kills[by] || 0) + 1
        deadNow.add(m[1])
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
  const armsHome = (b, k) => { const s0 = L.spawns[b.team === 'red' ? 0 : 1]; return { x: X + s0.x + 0.5, y: Y + s0.y, z: Z + s0.z + (k % 6) * 2 - 5 + 0.5 } }
  const reset = async (name) => { for (const c of [`clear ${name}`, `effect clear ${name}`, `effect give ${name} minecraft:instant_health 1 10 true`, `effect give ${name} minecraft:saturation 1 20 true`]) await rcon(i, c).catch(() => {}) }
  if (arms) for (let k = 0; k < N; k++) { const h = armsHome(bots[k], k); await reset(bots[k].name); await rcon(i, `tp ${bots[k].name} ${h.x} ${h.y} ${h.z}`) }
  else for (let k = 0; k < N; k++) { await dress(i, bots[k].name, kit); await place(bots[k].name, home(bots[k], k)) }
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
      const need = needOf(pos[b.name]); if (!need || deadNow.has(b.name)) continue
      if ((asked[b.name] || 0) > Date.now()) continue
      asked[b.name] = Date.now() + 30000
      const ru = ALCHEMY.test(need.item) ? 'для зелий ' + need.item : { оружие: 'оружие', еда: 'еда', golden_apple: 'золотое яблоко', splash_potion: 'зелье лечения', cobblestone: 'блоки', 'броня:head': 'шлем', 'броня:torso': 'нагрудник', 'броня:legs': 'поножи', 'броня:feet': 'ботинки' }[need.item]
      b.c.call('say', { text: `[${b.team === 'red' ? 'красные' : 'синие'}] нужно: ${ru}` }).catch(() => {})
    }
  }, 2000)
  const help: Record<string, number> = {}
  await sleep(1500)
  let stop = false
  process.on('SIGINT', () => { stop = true })
  const STOPF = path.join(ROOT, 'farm', `ffa-${i}.stop`)
  try { fs.unlinkSync(STOPF) } catch {}
  // Позиции всех — раз в секунду (цель — ближайший живой).
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
      pos[b.name] = { p, v, hp: s.state.health, hurtTick, tick, pots: (s.state.inventory || {}).splash_potion || 0, inv: s.state.inventory || {}, armor: s.state.armor || {}, labNeed: labNeed[b.name] || [] }
    }
  }, Number(process.env.FFA_POLL_MS || 250))
  // Дроп, стрелы, опыт — раз в 30 с по габариту Колизея (вещи копились и тормозили игру). Ракеты и трезубцы в
  // полёте не трогаем: ракета держит разгон элитр.
  const BOX = arms ? `x=${X - 30},y=${Y - 6},z=${Z - 30},dx=60,dy=24,dz=60` : 'x=524,y=110,z=536,dx=152,dy=60,dz=128'
  const boardT = setInterval(() => {
    log('счёт (убил/умер) ' + board())
    for (const t of ['item', 'arrow', 'experience_orb']) rcon(i, `kill @e[type=${t},${BOX}]`).catch(() => {})
  }, 30000)
  if (arms) await armsPrep()
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
    if (arms) for (const t of ['red', 'blue']) {
      const chef = bots.find(b => b.name === alchemist[t])
      if (chef && !busy.has(chef.name) && !brewed[t + 'strong_healing'] && (labNeed[chef.name] || []).length && labNeed[chef.name].every(x => (pos[chef.name]?.inv || {})[x])) { log(`⚗ ${chef.name}: набор собран — снова в лабораторию`); brewTask(chef, t) }
    }
    for (const t of ['red', 'blue']) {
      const ours = bots.filter(b => b.team === t && pos[b.name]?.p && pos[b.name].hp > 0 && !deadNow.has(b.name))
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
    const areas = [...L.rooms.filter(r => !L.secret.includes(r.id)).map(r => ({ id: r.id, x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 })),
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
    await Promise.all(bots.map((b, k) => { const h = armsHome(b, k); return b.c.call('goto', { x: h.x, y: h.y, z: h.z, range: 2, timeoutSeconds: 10 }).catch(() => {}) }))
    await sleep(1500)
    let moves = 0
    for (const team of ['red', 'blue']) {
      const tm = bots.filter(b => b.team === team)
      for (const r of tm) {
        for (let n = 0; n < 4; n++) {
          const need = needOf(pos[r.name]); if (!need) break
          const donor = tm.filter(d => d !== r && pos[d.name]).map(d => ({ d, give: spare(pos[d.name].inv, need, pos[d.name].armor) })).find(x => x.give)
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
        if (d === chef) continue
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
        const offer = tm.filter(d => d !== r && (pos[d.name].armor || {})[slot]).map(d => ({ d, it: Object.keys(pos[d.name].inv || {}).filter(n => (re as RegExp).test(n)).sort((a, c) => tierOf(c) - tierOf(a))[0] }))
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
  function labTask (b, fn) {
    busy.add(b.name)
    fn().catch(() => {}).finally(() => { busy.delete(b.name); b.c.call('armor').catch(() => {}) })
  }
  await Promise.all(bots.map(async (b, k) => {
    while (!stop) {
      if (busy.has(b.name) && !deadNow.has(b.name)) { await sleep(500); continue }
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
      const foes = names.filter(n => n !== b.name && pos[n] && pos[n].hp > 0 && !deadNow.has(n) && (!teams || teamOf(n) !== b.team))
      const mates = teams ? names.filter(n => n !== b.name && teamOf(n) === b.team && pos[n] && pos[n].hp > 0 && !deadNow.has(n)) : []
      if (!me || !me.p || !foes.length) { await sleep(500); continue }
      const body = n => ({ name: n, p: pos[n].p, v: pos[n].v, hurtAgo: pos[n].hurtTick ? (pos[b.name].tick - pos[n].hurtTick) * 50 : Infinity })
      const ally = n => ({ ...body(n), hp: pos[n].hp, target: bots.find(o => o.name === n)?.cur ?? null })
      const live = () => foes.filter(n => pos[n] && !deadNow.has(n)).map(body)
      const cur = b.cur && !deadNow.has(b.cur) && foes.includes(b.cur) ? b.cur : null
      const pickNow = () => teams
        ? crowd.chooseTeamTarget(body(b.name), mates.map(ally), live(), { persona: b.persona, current: cur, blast: BLAST.test(kit), hotspots: Object.entries(rally).filter(([t, r]) => t !== b.team && r).map(([, r]) => r.at), role: roles[b.name] || '', relieve: Object.entries(rotating).filter(([n, r]: any) => n !== b.name && teamOf(n) === b.team && r.until > (pos[b.name]?.tick || 0)).map(([, r]: any) => r.foe) })
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
            b.c.call('say', { text: `[${b.team === 'red' ? 'красные' : 'синие'}] хилка у меня, сюда!` }).catch(() => {})
            return { mode: 'rally_wait' }
          }
        }
        // Кристаллы: свои врозь — ближе 4 бл. к союзнику — шаг прочь на 5 (один взрыв не должен брать двоих); не чаще 3 с.
        if (BLAST.test(kit) && (spreadAt[b.name] || 0) < Date.now()) {
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
        if (me.hp <= 6 && mates.length) return { mode: 'regroup' }
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
        if (job.mode === 'rally_wait') { await b.c.call('stop').catch(() => {}); await sleep(250); continue }
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
      const pick = pickNow()
      if (!pick) { await sleep(500); continue }
      if (pick.target !== b.cur) log(`🎯 ${b.name} → ${pick.target} (${pick.why})`)
      ;b.cur = pick.target
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
        if (!m || !m.p || m.p.y > Y + 4.5) return
        const again = pickNow()
        // Свою цель новый выбор перебил с учётом липкости (stick) — сменить.
        if ((again && again.target !== b.cur) || support()) b.c.call('stop').catch(() => {})
      }, 2000)
      try {
        await b.c.call('fight', { target: pick.target, allowPlayer: true, timeoutSeconds: SEG_S, retreatAtHealth: 3, arena: { x: X + 0.5, y: Y, z: Z + 0.5, r: R } }).catch(() => sleep(1000))
      } finally { clearInterval(watch) }
    }
  }))
  clearInterval(poll); clearInterval(boardT); clearInterval(announce); clearInterval(rolesT); clearInterval(tactT)
  for (const b of bots) await b.c.call('stop').catch(() => {})
  log('итог (убил/умер) ' + board())
  process.exit(0)
}

const [cmd, slot, arg] = process.argv.slice(2)
const i = Number(slot)
if (!(i >= 1 && i <= 32)) { console.log('node farm/ffa.js up|run|down <слот> [N|набор]'); process.exit(1) }
;(cmd === 'up' ? up(i, Number(arg || 4)) : cmd === 'down' ? Promise.resolve(down(i)) : cmd === 'run' ? run(i, arg || 'elytra') : cmd === 'team' ? run(i, arg || 'team', { teams: true }) : cmd === 'arms' ? run(i, 'arms', { teams: true, arms: true }) : Promise.reject(new Error('команда?'))).catch(e => { console.error(e); process.exit(1) })
