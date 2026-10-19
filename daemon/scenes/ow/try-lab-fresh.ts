'use strict'
const { REPO_ROOT }: typeof import('../../src/paths') = require('../../src/paths')
const gameClock: typeof import('../../src/game-clock') = require('../../src/game-clock')
// Лаборатория «новый мир → ступень» (research/05-synthesis.md J1): новый мир со случайным сидом
// (farm.js up N --fresh --random), тело на спавне с пустым рюкзаком, дальше — campaign.js полным порядком
// этапов, без команд и без человека. Подготовка — только до старта кампании (ферма): /random reset,
// выживание, normal, keep_inventory=false (правило 02.10; KEEP_INV=true — по-старому), /clear, /effect clear, утро.
//
// Успех — ступень UNTIL:
//   nether    тело в Аду (status.dimension)
//   rods      стержней (+порох/2) ≥ 7
//   pearls    жемчуг + очи ≥ 12
//   eyes      очей ≥ EYES (12)
//   endportal комната портала в Край найдена (ВЕХА stronghold)
//   end       тело в Крае
//   dragon    «ДРАКОН УБИТ» в журнале кампании
// Провал — кампания вышла, БЛОКЕР или сторож в журнале, ≥ DEATHS_MAX (5) смертей, MINUTES (150) вышли.
// Итог попытки — строка JSON в LAB_OUT: ok, минуты, чем кончилось, класс провала (scene-kit.classify),
// ВЕХИ с минутами, смерти, последние коды, рюкзак.
//
//   ND_WS=… MC_USERNAME=NeuroFarmN ND_SERVER_LOG=… LAB_OUT=… node try-lab-fresh.js   UNTIL=nether MINUTES=150
//   CAMPAIGN=campaign.js — какой файл кампании запускать (снимок для A/B).
// Лаборатория отрезка (поток overworld, 02.10): KIT="bucket;water_bucket;cobblestone 64" — выдать набор до старта;
// STAGES=cast,portal,nether — фильтр этапов кампании (argv); UNTIL=portal — успех, когда портал горит (ВЕХА
// cast или portal в журнале кампании); START_Y=-50 — тело вниз на эту высоту (карман воздуха 1×2, у спавна мира).
const fs: typeof import('fs') = require('fs')
const path: typeof import('path') = require('path')
const { spawn }: typeof import('child_process') = require('child_process')
const { connect, createKit, sleep, classify, campaignFacts }: typeof import('../lib/scene-kit') = require('../lib/scene-kit')
const { farmBootstrap }: typeof import('../lib/farm-bootstrap') = require('../lib/farm-bootstrap')

const WS = process.env.ND_WS || 'ws://127.0.0.1:8801'
const PLAYER = process.env.MC_USERNAME || 'NeuroFarm1'
const LOG = process.env.ND_SERVER_LOG || ''
const OUT = process.env.LAB_OUT || path.join(REPO_ROOT, 'daemon/lab-fresh.jsonl')
const MINUTES = Number(process.env.MINUTES || 150)
const UNTIL = process.env.UNTIL || 'nether'
const EYES = Number(process.env.EYES || 12)
const DEATHS_MAX = Number(process.env.DEATHS_MAX || 5)
const CAMPAIGN = process.env.CAMPAIGN || 'campaign.js'
// «предмет*N» — то же, что «предмет N», но без пробела (env сцен делится по пробелам: snap-scene.sh).
const KIT = (process.env.KIT || '').split(';').map(x => x.trim().replace(/\*(\d+)$/, ' $1')).filter(Boolean)
const STAGES = process.env.STAGES || ''
const KEEP_INV = process.env.KEEP_INV === 'true' || process.env.KEEP_INV === '1'
const START_Y = process.env.START_Y !== undefined && process.env.START_Y !== '' ? Number(process.env.START_Y) : null
// KEEP_STATE=1 — сцена со снимка перед этапом (16.10): мир, тело, рюкзак и время суток — как в снимке; только /random reset и правила.
const KEEP_STATE = process.env.KEEP_STATE === '1'
// A replacement KIT is a separate laboratory fixture; preserve snapshot position, health and day phase.
const KIT_REPLACE = process.env.KIT_REPLACE === '1'
const STEPS = ['kit', 'portal', 'nether', 'rods', 'pearls', 'eyes', 'endportal', 'end', 'dragon']
if (!STEPS.includes(UNTIL)) { console.error(`UNTIL=${UNTIL}: жду одно из ${STEPS.join(', ')}`); process.exit(1) }

const conn = connect(WS)
const call = conn.call
const kit = createKit({ call, heard: conn.heard, logFile: LOG, player: PLAYER })
const logSize = () => { try { return fs.statSync(LOG).size } catch { return 0 } }
function deathLines (from) {
  try {
    const buf = fs.readFileSync(LOG, 'utf8').slice(from)
    return buf.split('\n').filter(l => l.includes(`]: ${PLAYER} `) && !/issued server command|joined|left|lost connection|logged in|advancement/.test(l) &&
      /was |died|drowned|burned|tried to swim|fell|blew up|hit the ground|went up|withered|suffocated|starved|froze|walked into|experienced/.test(l))
      .map(l => l.replace(/^.*\]: /, '').trim())
  } catch { return [] }
}
const cnt = (inv, re) => Object.entries<any>(inv || {} as Record<string, any>).filter(([k]: any) => re.test(k)).reduce((n, [, v]: any) => n + v, 0)
// Сид мира слота: level-seed из server.properties самого слота (мир создан с ним), потом slots.json. slots.json общий для
// всей фермы и переписывается чужими up/down — rt-R6 03.10: записи слотов 8–15 пропали, ND_WORLD_SEED ушёл пустым,
// маршрут не построился (8 прогонов вышли «вслепую»).
function seedOf () {
  try {
    const props = fs.readFileSync(path.join(REPO_ROOT, 'farm', `server-${process.env.FARM_SLOT}`, 'server.properties'), 'utf8')
    const m = /^level-seed=(-?\d+)\s*$/m.exec(props)
    if (m) return m[1]
  } catch {}
  try { return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'farm/slots.json'), 'utf8')).slots[process.env.FARM_SLOT].seed } catch { return null }
}

// Достигнута ли ступень — по состоянию тела и журналу кампании.
const ROUTE_IN = /МАРШРУТ маршрут кончился: в Аду, ([0-9]+) с/
// Минута входа: по журналу маршрута (секунды от старта маршрута ≈ от старта кампании), иначе — время опроса.
const enteredAt = (text, fallback) => { const m = UNTIL === 'nether' ? ROUTE_IN.exec(text) : null; return m ? Math.round(Number(m[1]) / 6) / 10 : fallback }
function reached (s, text) {
  const inv = s.inventory || {} as Record<string, any>
  const rods = cnt(inv, /^blaze_rod$/) + Math.floor(cnt(inv, /^blaze_powder$/) / 2) + Math.floor(cnt(inv, /^ender_eye$/) / 2)
  switch (UNTIL) {
    // Набор литья (короткие прогоны бисекта 16.10): ведро (любое) и огниво/огненный заряд в рюкзаке, или уже в Аду.
    case 'kit': return s.dimension === 'the_nether' || (cnt(inv, /bucket$/) > 0 && cnt(inv, /^(flint_and_steel|fire_charge)$/) > 0)
    case 'portal': return /ВЕХА (cast|portal)/.test(text) || s.dimension === 'the_nether'
    // Вход по журналу маршрута тоже считается: граф Ада мог сразу увести тело назад (s8-f1-9: «для ифритов не хватает еды —
    // домой» через 1 с после входа, опрос раз в 30 с его не застал — прогон записан таймаутом).
    case 'nether': return s.dimension === 'the_nether' || ROUTE_IN.test(text)
    case 'rods': return rods >= 7
    case 'pearls': return cnt(inv, /^(ender_pearl|ender_eye)$/) >= 12
    case 'eyes': return cnt(inv, /^ender_eye$/) >= EYES
    case 'endportal': return /ВЕХА stronghold/.test(text)
    case 'end': return s.dimension === 'the_end'
    case 'dragon': return /ДРАКОН УБИТ/.test(text)
  }
  return false
}

async function scene () {
  const expected = new Map<string, number>()
  if (KIT_REPLACE) {
    if (!KIT.length) throw new Error('KIT_INVALID: empty replacement')
    for (const g of KIT) {
      const m = /^([a-z0-9_]+)(?: (\d+))?$/.exec(g)
      const count = Number(m?.[2] || 1)
      if (!m || !Number.isSafeInteger(count) || count < 1) throw new Error(`KIT_INVALID: ${g}`)
      expected.set(m[1], (expected.get(m[1]) || 0) + count)
    }
  }
  // Сиды мира и копии мира независимы только со сброшенными последовательностями ГСЧ (AGENTS.md: ферма).
  await kit.randomReset()
  await kit.cmd('/gamemode survival')
  await kit.setDifficulty('normal')
  // Правило пользователя 02.10: в боевом режиме спидрана инвентарь при смерти не сохраняется — смерть = провал прогона.
  // KEEP_INV=true — старые серии (до 02.10 17:15) для сравнения.
  await kit.gamerule('keep_inventory', KEEP_INV ? 'true' : 'false')
  await kit.gamerule('send_command_feedback', 'true')
  if (!KEEP_STATE) {
    await kit.cmd('/clear @s')
    await kit.cmd('/effect clear @s')
    // Утро: мир поднят за минуты до прогона, сутки — 20 минут.
    await kit.cmd('/time set 1000')
  }
  if (KEEP_STATE && KIT_REPLACE) await kit.cmd('/clear @s')
  for (const g of KIT) await kit.cmd(`/give @s minecraft:${g}`)
  if (KIT_REPLACE) {
    let s, actual, missing
    // Server command feedback can precede the client's inventory packet; only this transport wait uses wall time.
    for (let attempt = 0; attempt < 20; attempt++) {
      await call('armor', {} as Record<string, any>)
      s = await status()
      actual = { ...s.inventory }
      for (const item of [...Object.values(s.armor || {}), s.offHand?.item]) {
        if (typeof item === 'string') actual[item] = (actual[item] || 0) + 1
      }
      missing = [...expected].filter(([item, count]) => (actual[item] || 0) < count)
      for (const [suffix, slot] of [['helmet', 'head'], ['chestplate', 'torso'], ['leggings', 'legs'], ['boots', 'feet']]) {
        const requested = [...expected.keys()].filter(item => item.endsWith('_' + suffix))
        if (requested.length && !requested.includes(s.armor?.[slot])) missing.push([`worn:${requested.join('|')}`, 1])
      }
      if (expected.has('shield') && s.offHand?.item !== 'shield') missing.push(['offhand:shield', 1])
      if (!missing.length) break
      if (attempt < 19) await gameClock.wall.sleep(50)
    }
    if (missing.length) throw new Error(`KIT_MISSING: ${missing.map(([item, count]) => `${item}:${actual[item] || 0}/${count}`).join(', ')}`)
    console.log('KIT_READY', JSON.stringify({ inventory: s.inventory, armor: s.armor, offHand: s.offHand, health: s.health, food: s.food }))
  }
  if (START_Y !== null) {
    // Вниз у места, где стоит тело: карман 1×2 и опора под ногами (лаборатория отрезка «у лавы»).
    await kit.cmd(`/fill ~ ${START_Y} ~ ~ ${START_Y + 1} ~ air`)
    await kit.cmd(`/setblock ~ ${START_Y - 1} ~ minecraft:stone`)
    await kit.cmd(`/tp @s ~ ${START_Y} ~`)
    await sleep(2000)
  }
}

async function status () {
  for (let i = 0; i < 3; i++) {
    const st = await call('status', {} as Record<string, any>).catch(() => null)
    if (st && st.state && st.state.dimension) return st.state
    await gameClock.wall.sleep(50)
  }
  return {} as Record<string, any>
}

async function main () {
  await conn.ready
  // Свежий мир под нагрузкой (8 серверов стартуют разом): «Timeout waiting for 4 chunks to load» у connect/первой
  // команды — повторить, а не терять слот партии (ow-P2/P4/P5 02.10: по 1–2 слота на партию).
  for (let k = 0; ; k++) {
    try { await farmBootstrap(call, WS, PLAYER); await call('stop'); break } catch (e) {
      if (k >= 3 || !/Timeout waiting for|chunks/.test(String(e.message))) throw e
      await sleep(8000)
    }
  }
  const t0 = gameClock.now()
  for (let k = 0; ; k++) {
    try { await scene(); break } catch (e) {
      if (k >= 3 || !/Timeout waiting for|chunks/.test(String(e.message))) throw e
      await sleep(8000)
    }
  }
  await sleep(1000)
  const size = logSize()
  const clog = OUT.replace(/\.jsonl$/, '') + '-' + new Date().toISOString().slice(11, 19).replace(/:/g, '') + '.campaign.log'
  try { fs.writeFileSync(clog, '') } catch {}
  const tc = gameClock.now()
  // Preparation may clear/give items; autonomous work starts only after it is complete.
  await call('connect', { bootstrapPaused: false })
  // MAP_LAVA=1 — место лавы под небом из скана копии мира (good-v2 / portal-scan, portal-natural.poolInfo) кампании
  // (ND_OW_LAVA_HINT); правило AGENTS.md: знание карты из копии этого же мира разрешено. Отдельная метрика.
  // Уровень знания карты (S8c, route.mapLevel): ND_MAP=0 — вслепую, подсказки лавы тоже нет.
  const mapLevel = (require('../../src/route') as typeof import('../../src/route')).mapLevel()
  let lavaHint = null
  if (process.env.MAP_LAVA === '1' && mapLevel !== 'blind') { try { lavaHint = (require('../../src/portal-natural') as typeof import('../../src/portal-natural')).poolInfo(seedOf()).hint } catch {} }
  const child = spawn(process.execPath, [CAMPAIGN, ...(STAGES ? [STAGES] : [])], {
    cwd: path.join(__dirname, '..', '..'),
    env: { ...process.env, ND_WS: WS, ND_CAMPAIGN_LOG: clog, ...(seedOf() ? { ND_WORLD_SEED: String(seedOf()) } : {} as Record<string, any>), ...(lavaHint ? { ND_OW_LAVA_HINT: JSON.stringify(lavaHint) } : {} as Record<string, any>) },
    stdio: 'ignore'
  })
  let exited = null
  child.on('exit', code => { exited = code })
  let stoppedBy = 'время'
  let ok = false
  let reachedAt = null
  let lastCheck = 0
  const until = tc + MINUTES * 60000
  while (gameClock.now() < until) {
    await gameClock.wall.sleep(50)
    let text = ''
    try { text = fs.readFileSync(clog, 'utf8') } catch {}
    if (gameClock.now() - lastCheck > 30000 || exited !== null) {
      lastCheck = gameClock.now()
      const s = await status()
      if (reached(s, text)) { ok = true; reachedAt = enteredAt(text, Math.round((gameClock.now() - tc) / 6000) / 10); stoppedBy = `ступень ${UNTIL} пройдена`; break }
    } else if (UNTIL === 'nether' && ROUTE_IN.test(text)) { ok = true; reachedAt = enteredAt(text, null); stoppedBy = `ступень ${UNTIL} пройдена`; break }
    if (exited !== null) { stoppedBy = `кампания вышла (${exited})`; break }
    const deaths = deathLines(size)
    if (deaths.length >= DEATHS_MAX) { stoppedBy = `смертей ${deaths.length}`; break }
    if (/БЛОКЕР/.test(text)) { stoppedBy = (text.match(/БЛОКЕР[^\n]{0,160}/) || ['БЛОКЕР'])[0]; break }
  }
  if (exited === null) { try { child.kill() } catch {} }
  try { await call('stop') } catch {}
  await gameClock.wall.sleep(50)
  const s = await status()
  let text = ''
  try { text = fs.readFileSync(clog, 'utf8') } catch {}
  // Кампания с фильтром этапов выходит сама сразу после ВЕХИ — проверка в цикле могла прочесть журнал до неё.
  if (!ok && reached(s, text)) {
    ok = true
    const m = /ВЕХА (?:cast|portal): готово в \S+, (\d+) мин/.exec(text)
    reachedAt = m && UNTIL === 'portal' ? Number(m[1]) : enteredAt(text, Math.round((gameClock.now() - tc) / 6000) / 10)
    stoppedBy = `ступень ${UNTIL} пройдена`
  }
  const facts = campaignFacts(text)
  const inv = s.inventory || {} as Record<string, any>
  const deaths = deathLines(size)
  const rec: Record<string, any> = {
    at: new Date().toISOString(),
    seed: seedOf(),
    until: UNTIL,
    ...(KIT.length ? { kit: KIT.join(';') } : {} as Record<string, any>),
    ...(STAGES ? { stages: STAGES } : {} as Record<string, any>),
    ...(START_Y !== null ? { startY: START_Y } : {} as Record<string, any>),
    keepInv: KEEP_INV,
    map: mapLevel,
    ...(process.env.MAP_LAVA === '1' ? { lavaHint } : {} as Record<string, any>),
    ok,
    minutes: Math.round((gameClock.now() - tc) / 6000) / 10,
    reachedAt,
    stoppedBy,
    exitCode: exited,
    deathCount: deaths.length,
    deaths,
    miles: facts.miles,
    lastStage: facts.lastStage,
    lastCodes: facts.codes.filter(c => c.code !== 'OK').slice(-5).map(c => `${c.method}:${c.code}@${c.minute}м`),
    dimension: s.dimension || null,
    pos: s.pos || null,
    bag: Object.entries<any>(inv).map(([k, v]: any) => `${k}×${v}`).join(' '),
    campaignLog: path.basename(clog),
    setupSeconds: Math.round((tc - t0) / 1000)
  }
  rec.class = classify({ ...rec, deathsMax: DEATHS_MAX }, text)
  rec.tail = text.split('\n').filter(l => /ВЕХА|БЛОКЕР|итог этапа|этап упал|умер|прогон упал|РИСК|сторож|жду|нет доступного/.test(l)).slice(-12).map(l => l.slice(0, 220))
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n')
  console.log(JSON.stringify(rec))
  // Тело без кампании в мире — лёгкая добыча; мир слота остаётся контрольной точкой следующей ступени.
  try { await Promise.race([call('disconnect', { reason: 'сцена try-lab-fresh окончена' }), gameClock.wall.sleep(10000)]) } catch {}
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
