'use strict'
const gameClock = require('./src/game-clock')
// Ловушки выживания (поток survival, research/dev-B-refuge.md, 02.10): тело в типовой смертельной
// обстановке начала игры, дальше решает НАСТОЯЩАЯ кампания (campaign.js, все этапы) — без команд и без
// сцены-мозга. Сцена только готовит место, набор и мобов, ждёт ROUND_MIN минут и смотрит со стороны:
// умер ли, сколько ушло хп, когда стихло (20 с без урона и без врага ближе 8 бл.) и когда кампания снова
// сделала рабочий шаг этапа (mine/dig_down/tunnel/explore/goto/craft/... → done).
//
// Смотрит через RPC peek (без выемки шины: status/situation забирали бы у кампании события отхода).
// Только ферма, слоты 16–20 (поток survival); перед каждым раундом /random reset.
//
// VARIANT:
//   night   — ночь в поле без укрытия: поверхность, 14000, 3 зомби + скелет + паук в 14–18 бл.; ранний набор;
//   cave    — пещера с мобами: комната 17×6×17 на y 30 в скорлупе из камня, темно, 2 зомби, скелет, паук; набор этапа железа,
//             железная руда в стенах;
//   mine    — бой в штреке: штрек 1×2×41 на y 30, 2 зомби в 5–7 бл. с одной стороны, скелет в 8 с другой; набор железа;
//   water   — утопленники в воде: пруд 15×5×15 с берегами вровень с водой, тело в воде, 3 утопленника (один с трезубцем);
//   creeper — крипер у стройки: поверхность, день, 2 крипера в 6–8 бл. за спиной, третий в 12; ранний набор;
//   lowhp   — мало хп без еды: ночь 13500, хп 5, сытость 6, еды нет, 3 зомби в 12–16 бл. и скелет; 16 земли.
// ROUNDS (3), ROUND_MIN (по варианту), CAMPAIGN (campaign.js), ONLY — фильтр этапов кампании (по умолчанию все).
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { connect, createKit, sleep } = require('./scene-kit')

// VARIANT — один или список через запятую: раунды идут по кругу (слоты — со сдвигом, чтобы разом шли разные).
const VARIANTS = String(process.env.VARIANT || 'night').split(',').map(s => s.trim()).filter(Boolean)
const ROUNDS = Math.max(1, Number(process.env.ROUNDS || 3))
// Ночь и «мало хп» — до рассвета (14000 → ~23000 за 7.5 мин) и возврата к делу после него.
const DEFAULT_MIN = { night: 9, cave: 4, mine: 4, water: 3, creeper: 3, lowhp: 9 }
const roundMin = v => Number(process.env.ROUND_MIN || DEFAULT_MIN[v] || 4)
const CAMPAIGN = process.env.CAMPAIGN || 'campaign.js'
const ONLY = process.env.ONLY || ''
const PLAYER = process.env.MC_USERNAME
const LOG = process.env.ND_SERVER_LOG || ''
const OUT = process.env.LAB_OUT || path.join(__dirname, 'lab-surv-trap.jsonl')
const YS = 30 // подземные варианты
for (const v of VARIANTS) if (!DEFAULT_MIN[v]) { console.error(`VARIANT=${v}: жду ${Object.keys(DEFAULT_MIN).join(', ')}`); process.exit(1) }

// Наборы: «ранний» — после дерева (этап камня/еды дальше), «железо» — каменный набор, еда есть.
const EARLY = ['wooden_pickaxe', 'wooden_sword', 'crafting_table', 'oak_log 6', 'oak_planks 4', 'stick 4', 'cooked_beef 4']
const IRON = ['stone_pickaxe 2', 'stone_sword', 'stone_axe', 'crafting_table', 'furnace', 'cobblestone 32', 'coal 4', 'stick 4', 'oak_planks 8', 'cooked_beef 10']
const KITS = {
  night: EARLY,
  creeper: EARLY,
  cave: IRON,
  mine: IRON,
  water: IRON,
  lowhp: ['wooden_pickaxe', 'wooden_sword', 'crafting_table', 'oak_log 4', 'stick 2', 'dirt 16']
}
// Мобы: [имя, dx, dy, dz, nbt-добавка]
const MOBS = {
  night: [['zombie', 15, 0, 3], ['zombie', -12, 0, 10], ['zombie', 4, 0, -16], ['skeleton', -14, 0, -10], ['spider', 10, 0, 13]],
  // Под землёй — вплотную (4–8 бл.): иначе лесенка этапа железа уводит тело из виду раньше, чем дойдут (trap0 mine r1).
  cave: [['zombie', 4, 0, 3], ['zombie', -5, 0, -3], ['skeleton', 6, 0, -6], ['spider', -6, 0, 5]],
  mine: [['zombie', 5, 0, 0], ['zombie', 7, 0, 0], ['skeleton', -8, 0, 0]],
  water: [['drowned', 5, -3, 4], ['drowned', -5, -3, -3], ['drowned', 3, -3, -6, 'equipment:{mainhand:{id:"minecraft:trident",count:1}}']],
  creeper: [['creeper', -7, 0, 1], ['creeper', 1, 0, -8], ['creeper', 11, 0, 6]],
  lowhp: [['zombie', 13, 0, 4], ['zombie', -12, 0, 8], ['zombie', 5, 0, -15], ['skeleton', -16, 0, -8]]
}
const TIME = { night: 14000, creeper: 4000, water: 3000, cave: 6000, mine: 6000, lowhp: 13500 }
// Рабочие шаги этапа (не самозащита, не осмотр).
const WORK = /^(mine|mine_seen|dig_down|tunnel|explore|goto|craft|smelt|collect|place|build|chest_put|chest_take|fight)$/

const conn = connect(process.env.ND_WS)
const call = conn.call

function deathLines (from) {
  try {
    // Срез по БАЙТАМ (размер файла — байты): строка JS режется по символам, и кириллица в журнале сдвигала начало
    // дальше смерти — раунд её не видел минутами (trap1 02.10, slot 16 r6).
    // Журнал сервера в полночь начинается заново (Paper: latest.log → дата.log.gz): файл короче смещения — читать с
    // начала (trapJ 03.10 00:05, слот 17: смерть в раунде через полночь не увидена).
    const all = fs.readFileSync(LOG)
    const buf = all.subarray(all.length < from ? 0 : from).toString('utf8')
    return buf.split('\n').filter(l => l.includes(`]: ${PLAYER} `) && !/issued server command|joined|left|lost connection|logged in|advancement/.test(l) &&
      /was |died|drowned|burned|tried to swim|fell|blew up|hit the ground|went up|withered|suffocated|starved|froze|walked into|experienced/.test(l))
      .map(l => l.replace(/^.*\]: /, '').trim())
  } catch { return [] }
}
const logSize = () => { try { return fs.statSync(LOG).size } catch { return 0 } }

async function main () {
  const slot = Number(process.env.FARM_SLOT)
  if (!(slot >= 16 && slot <= 20) || process.env.ND_WS !== `ws://127.0.0.1:${8800 + slot}` || PLAYER !== `NeuroFarm${slot}`) throw new Error('только ферма, слоты 16–20')
  await conn.ready
  await call('connect')
  await call('stop')
  if ((await call('status')).detail.server !== `127.0.0.1:${25600 + slot}`) throw new Error('не сервер фермы')
  const kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })
  await kit.setDifficulty('normal')
  await kit.gamerule('keep_inventory', true)
  await kit.gamerule('spawn_mobs', true)
  await kit.gamerule('advance_time', true)
  await kit.gamerule('send_command_feedback', true)
  // Центры раундов — разные места мира: свежая местность, без следов прошлого раунда.
  const base = Math.floor(Math.random() * 8) * 3000 + 2000
  try {
    for (let round = 1; round <= ROUNDS; round++) {
      const variant = VARIANTS[(round - 1 + slot) % VARIANTS.length]
      const rec: Record<string, any> = { labFixture: true, slot, variant, round, ok: false }
      const t0 = gameClock.now()
      let child = null
      try {
        const site = await prepare(kit, round, base, variant)
        rec.site = site
        child = await play(kit, rec, site)
      } catch (e) { rec.error = e.message }
      if (child && child.exitCode === null) { try { child.kill() } catch {} }
      try { await call('stop') } catch {}
      rec.seconds = Math.round((gameClock.now() - t0) / 1000)
      rec.ok = !!(rec.fixtureReady && rec.survived)
      fs.appendFileSync(OUT, JSON.stringify(rec) + '\n')
      console.log(JSON.stringify({ slot, variant, round, ok: rec.ok, survived: rec.survived, deaths: rec.deaths, minHp: rec.minHp, firstHitS: rec.firstHitS,
        calmS: rec.calmS, backS: rec.backS, refuges: rec.refuges, how: rec.how, error: rec.error, death: rec.deathMsgs && rec.deathMsgs[0] }))
      await cleanup(kit, rec.site).catch(() => {})
    }
  } finally {
    try { await call('stop') } catch {}
    try { await Promise.race([call('disconnect', { reason: 'сцена try-lab-surv-trap окончена' }), gameClock.wall.sleep(8000)]) } catch {}
    conn.close()
  }
}

// Место раунда: поверхность (spreadplayers) или подземная выработка в скорлупе из камня.
async function prepare (kit, round, base, VARIANT) {
  const cmd = async text => { const r = await kit.cmd(text); if (!r.ok) throw new Error('не подтверждена команда: ' + text) }
  // Тело могло выпасть из игры (кампания, выходя сама, отключает его в finally) — вернуть до команд.
  try { await call('connect') } catch {}
  await sleep(500)
  await kit.cmd('/random reset *')
  await cmd('/gamemode creative')
  await cmd('/effect clear @s')
  // Место — до трёх попыток (генерация новых чанков бывает дольше 40 с, а «Could not» — на воде/в океане).
  let sp = null
  for (let k = 0; k < 3; k++) {
    const cx = base + round * 700 + k * 450
    const cz = (Number(process.env.FARM_SLOT) - 18) * 900 + k * 300
    sp = await kit.cmd(`/spreadplayers ${cx} ${cz} 0 300 false @s`, { reply: /Spread|Could not/, ms: 60000 })
    if (sp.ok && !/Could not/.test(sp.reply || '')) break
    sp = null
  }
  if (!sp) throw new Error('spreadplayers не нашёл места за 3 попытки')
  await kit.ensureWorld('overworld', { seconds: 20 })
  await sleep(1500)
  let s = (await call('status')).state
  const P = { x: Math.floor(s.pos.x), y: Math.floor(s.pos.y), z: Math.floor(s.pos.z) }
  const site: Record<string, any> = { ...P, surfaceY: P.y }
  const ow = 'overworld'
  if (VARIANT === 'cave' || VARIANT === 'mine') {
    const y = Math.min(YS, P.y - 12)
    site.y = y
    if (VARIANT === 'cave') {
      await kit.fillExact(ow, [[P.x - 9, y - 1, P.z - 9], [P.x + 9, y + 6, P.z + 9]], 'stone')
      await kit.fillExact(ow, [[P.x - 8, y, P.z - 8], [P.x + 8, y + 5, P.z + 8]], 'air')
      // Руда в стенах: железо по разным сторонам, уголь.
      for (const [dx, dy, dz] of [[-9, 1, 2], [-9, 2, 2], [9, 0, -3], [9, 1, -3], [3, 1, 9], [-2, 0, -9]]) await kit.cmd(`/setblock ${P.x + dx} ${y + dy} ${P.z + dz} minecraft:iron_ore`)
      for (const [dx, dy, dz] of [[4, 2, -9], [-9, 3, -5]]) await kit.cmd(`/setblock ${P.x + dx} ${y + dy} ${P.z + dz} minecraft:coal_ore`)
    } else {
      await kit.fillExact(ow, [[P.x - 21, y - 1, P.z - 1], [P.x + 21, y + 2, P.z + 1]], 'stone')
      await kit.fillExact(ow, [[P.x - 20, y, P.z], [P.x + 20, y + 1, P.z]], 'air')
      for (const [dx, dy, dz] of [[15, 0, 1], [15, 1, 1], [-16, 1, -1], [6, 1, -1]]) await kit.cmd(`/setblock ${P.x + dx} ${y + dy} ${P.z + dz} minecraft:iron_ore`)
    }
    await kit.ensureWorld(ow, { tp: `${P.x}.5 ${y} ${P.z}.5` })
  } else if (VARIANT === 'water') {
    // Пруд с берегами: вода 15×5×15, вокруг — берег в 3 бл. вровень с водой (как у реки, а не колодец в холме:
    // trap3 — «берега в 16 бл. не вижу», стены пруда выше 2 бл. в лесу на склоне), над ним чисто.
    await kit.fillExact(ow, [[P.x - 10, P.y - 2, P.z - 10], [P.x + 10, P.y - 1, P.z + 10]], 'dirt')
    await kit.fillExact(ow, [[P.x - 10, P.y, P.z - 10], [P.x + 10, P.y + 5, P.z + 10]], 'air')
    await kit.fillExact(ow, [[P.x - 7, P.y - 5, P.z - 7], [P.x + 7, P.y - 1, P.z + 7]], 'water')
    await kit.ensureWorld(ow, { tp: `${P.x}.5 ${P.y - 3} ${P.z}.5` })
  } else {
    await kit.ensureWorld(ow, { tp: `${P.x}.5 ${P.y} ${P.z}.5` })
  }
  await cmd(`/time set ${TIME[VARIANT]}`)
  await cmd('/clear @s')
  for (const item of KITS[VARIANT]) await cmd('/give @s minecraft:' + item)
  await cmd('/effect give @s minecraft:instant_health 1 10 true')
  await cmd('/effect give @s minecraft:saturation 1 20 true')
  await sleep(300)
  await cmd('/effect clear @s')
  await cmd('/gamemode survival')
  if (VARIANT === 'lowhp') {
    // Сытость 6 без насыщения: регенерации нет (FoodData.tick — с 18), еды в рюкзаке нет.
    await cmd('/effect give @s minecraft:hunger 30 200 true')
    const until = gameClock.now() + 15000
    while (gameClock.now() < until && (await call('status')).state.food > 6) await sleep(40)
    await cmd('/effect clear @s minecraft:hunger')
    await kit.cmd('/damage @s 15 minecraft:generic')
  }
  await sleep(400)
  s = (await call('status')).state
  site.before = { hp: s.health, food: s.food, pos: s.pos }
  site.variant = VARIANT
  return site
}

// Враждебные мобы, что уже были у места (пещера рядом, ночь), — убрать до раунда: число мобов — сценой, дальше —
// естественный спавн (ночь, темнота) как в игре.
const HOSTILE_TYPES = ['zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'bogged', 'creeper', 'spider', 'cave_spider', 'witch', 'enderman', 'slime', 'phantom', 'silverfish']
async function clearHostiles (kit, site, r = 40) {
  for (const t of HOSTILE_TYPES) await kit.cmd(`/execute positioned ${site.x} ${site.y} ${site.z} run kill @e[type=minecraft:${t},distance=..${r}]`)
}

async function summonMobs (kit, site) {
  await clearHostiles(kit, site)
  for (const [name, dx, dy, dz, extra] of MOBS[site.variant]) {
    const y = site.y + (dy || 0)
    const nbt = `{PersistenceRequired:1b,Tags:["nd_trap"]${extra ? ',' + extra : ''}}`
    const r = await kit.cmd(`/summon minecraft:${name} ${site.x + dx}.5 ${y} ${site.z + dz}.5 ${nbt}`)
    if (!r.ok) throw new Error(`моб не встал: ${name}`)
  }
}

async function cleanup (kit, site) {
  if (!site) return
  await kit.cmd('/gamemode creative')
  await kit.cmd(`/kill @e[tag=nd_trap]`)
  await kit.cmd(`/execute positioned ${site.x} ${site.y} ${site.z} run kill @e[type=!player,distance=..64]`)
}

async function play (kit, rec, site) {
  await summonMobs(kit, site)
  rec.fixtureReady = true
  const size = logSize()
  const clog = OUT.replace(/\.jsonl$/, '') + `-r${rec.round}-` + new Date().toISOString().slice(11, 19).replace(/:/g, '') + '.campaign.log'
  try { fs.writeFileSync(clog, '') } catch {}
  rec.campaignLog = path.basename(clog)
  const args = [CAMPAIGN]
  if (ONLY) args.push(ONLY)
  const t0 = gameClock.now()
  const child = spawn(process.execPath, args, { cwd: __dirname, env: { ...process.env, ND_CAMPAIGN_LOG: clog }, stdio: 'ignore' })
  let exited = null
  child.on('exit', code => { exited = code })
  const until = t0 + roundMin(site.variant) * 60000
  let lastHp = site.before.hp
  let minHp = lastHp
  let firstHit = null
  let lastHit = null
  let calm = null
  let lastNear = null
  const hits = []
  const work = []
  let workLines = 0
  // Campaign log headers are calendar time. Record completion when observed
  // on the game clock instead of comparing those headers with tick deadlines.
  const captureWork = () => {
    let log = ''
    try { log = fs.readFileSync(clog, 'utf8') } catch {}
    const complete = log.slice(0, log.lastIndexOf('\n') + 1).split('\n').slice(0, -1)
    for (const l of complete.slice(workLines)) {
      const m = /^\[[^\]]+\] \S+\s+([a-z_]+) (\{.*?\}) → (\w+)/.exec(l)
      if (!m || !WORK.test(m[1]) || m[3] !== 'done') continue
      if (m[1] === 'fight' && !/"purpose":"food"/.test(m[2])) continue
      work.push({ ms: gameClock.now(), method: m[1] })
    }
    workLines = complete.length
  }
  let died = false
  while (gameClock.now() < until) {
    await sleep(500)
    let pk = null
    try { pk = await call('peek') } catch {}
    captureWork()
    const st = pk && pk.state
    const now = gameClock.now()
    if (st && typeof st.health === 'number') {
      if (st.health < lastHp - 0.01) { hits.push(Math.round((now - t0) / 100) / 10); lastHit = now; if (!firstHit) firstHit = now; calm = null }
      lastHp = st.health
      minHp = Math.min(minHp, st.health)
    }
    const foes = (pk && pk.detail && pk.detail.foes) || []
    if (foes.some(f => f.d <= 8 && !/^(enderman|zombified_piglin|piglin)$/.test(f.name))) lastNear = now
    // Стихло: 20 с без урона и без врага ближе 8 бл. (после первого удара или первого сближения).
    const started = firstHit || lastNear
    if (started && !calm && (!lastHit || now - lastHit >= 20000) && (!lastNear || now - lastNear >= 20000)) calm = Math.max(lastHit || 0, lastNear || 0) || now
    if (deathLines(size).length) { died = true; await sleep(1500); break }
    if (exited !== null) break
  }
  captureWork()
  const text = (() => { try { return fs.readFileSync(clog, 'utf8') } catch { return '' } })()
  const deaths = deathLines(size)
  rec.deaths = deaths.length
  rec.deathMsgs = deaths
  rec.survived = deaths.length === 0 && !died
  rec.minHp = Math.round(minHp)
  rec.hits = hits.slice(0, 30)
  rec.firstHitS = firstHit ? Math.round((firstHit - t0) / 1000) : null
  rec.calmS = calm ? Math.round((calm - t0) / 1000) : null
  rec.campaignExit = exited
  // Возврат к делу: первый рабочий шаг этапа (done), кончившийся после «стихло».
  const lines = text.split('\n')
  const after = calm ? work.find(w => w.ms !== null && w.ms >= calm - 1000) : null
  rec.backS = after ? Math.round((after.ms - t0) / 1000) : null
  rec.backMethod = after ? after.method : null
  rec.workSteps = work.length
  rec.refuges = (text.match(/отход кончился|отход: /g) || []).length
  rec.how = [...text.matchAll(/отход(?: кончился)?: ([a-zа-яё]+)(?: ([A-Z_]+))?/g)].map(m => m[1] + (m[2] ? ' ' + m[2] : '')).slice(0, 4)
  // Простой (правило «ночью не пережидать»): секунды wait кампании и пересидки в отходе — всё, что дольше 30 с на
  // отход (коробка/нора сама строится за секунды; дольше — сидит), и свой отход кампании, и аварийный автопилота.
  rec.idleS = idleSeconds(text)
  rec.fights = (text.match(/ fight \{/g) || []).length
  rec.flees = (text.match(/ flee \{/g) || []).length
  rec.tail = lines.filter(l => /умер|отход|РИСК|БЛОКЕР|после отхода|не дерусь|дерусь|утопленник|крипер|ночь|прячусь/.test(l)).slice(-10).map(l => l.slice(0, 220))
  const end = (await call('peek').catch(() => null))
  if (end && end.state) rec.end = { hp: end.state.health, food: end.state.food, pos: end.state.pos }
  return child
}

function idleSeconds (text) {
  let s = 0
  for (const l of String(text || '').split('\n')) {
    const w = / wait \{"seconds":(\d+)\}/.exec(l)
    if (w) { s += Number(w[1]); continue }
    const r = / refuge \{.*?(\d+(?:\.\d+)?) с(?=[\s;|]|$)/.exec(l) || /отход кончился: .*?, (\d+(?:\.\d+)?) с;/.exec(l)
    if (r) s += Math.max(0, Number(r[1]) - 30)
  }
  return Math.round(s)
}

if (require.main === module) main().catch(e => { console.error(e); process.exitCode = 1 })
