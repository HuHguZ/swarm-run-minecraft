// Сцена фермы (агент Ада 14.10): гаст с живым ИИ стреляет по телу на площадке 5×5 над лавой — смерть b6-7-1/b6-6-3 «сброс
// шаром гаста». Меряет на каждую попытку: жив ли, упал ли с площадки, мин. хп, удары по шару и отбитые шары (журнал демона
// «шар гаста: удар/отбит»), жив ли гаст (отражённый шар его убивает). Сравнение — демон фермы с ND_GHAST_SWAT=0.
// FARM_SLOT, ND_WS, ND_SERVER_LOG, LAB_OUT — от farm.js run; TRIALS (5), SECONDS (40 игровых), GHAST_DIST (20);
// BUSY=1 — тело всё время ходит по площадке (goto): навык ставит свой взгляд каждый тик, как в походе к бастиону (b8-7-1).
import fs from 'node:fs'
import path from 'node:path'
const { connect, createKit } = require('./scene-kit')
const wallSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function main () {
  const slot = Number(process.env.FARM_SLOT)
  if (!(slot >= 1 && slot <= 32) || process.env.ND_WS !== `ws://127.0.0.1:${8800 + slot}`) throw new Error('только ферма')
  const player = `NeuroFarm${slot}`
  const trials = Number(process.env.TRIALS || 5), seconds = Number(process.env.SECONDS || 40), dist = Number(process.env.GHAST_DIST || 20)
  const conn = connect(process.env.ND_WS)
  await conn.ready
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    let timer: NodeJS.Timeout
    try { return await Promise.race([conn.call(method, params), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 20000) })]) }
    finally { clearTimeout(timer) }
  }
  const kit = createKit({ call, heard: conn.heard, logFile: process.env.ND_SERVER_LOG, player, replyMs: 3000 })
  const cmd = (text: string) => kit.cmd(text)
  const daemonLog = path.join(__dirname, '..', 'farm', `daemon-${slot}.out.log`)
  const logSize = () => { try { return fs.statSync(daemonLog).size } catch { return 0 } }
  const logSince = (from: number) => { try { const b = fs.readFileSync(daemonLog); return b.subarray(from).toString('utf8') } catch { return '' } }
  const X = 4400, Y = 100, Z = 4400
  const box = [[X - 26, Y - 38, Z - 26], [X + 26, Y + 12, Z + 26]]
  try {
    await call('connect')
    if ((await call('status')).detail?.server !== `127.0.0.1:${25600 + slot}`) throw new Error('не сервер фермы')
    await call('stop')
    await call('play_mode', { mode: 'free' })
    await cmd('/gamemode creative')
    await kit.setDifficulty('normal')
    await kit.gamerule('spawn_mobs', false)
    await kit.gamerule('keep_inventory', false)
    await cmd('/execute in minecraft:the_nether run gamerule spawn_mobs false')
    await kit.forceload('the_nether', box)
    await kit.fillExact('the_nether', box, 'air')
    await kit.fillExact('the_nether', [[X - 26, Y - 38, Z - 26], [X + 26, Y - 38, Z + 26]], 'netherrack')
    await kit.fillExact('the_nether', [[X - 26, Y - 37, Z - 26], [X + 26, Y - 37, Z + 26]], 'lava')
    await kit.fillExact('the_nether', [[X - 2, Y - 1, Z - 2], [X + 2, Y - 1, Z + 2]], 'netherrack')
    await kit.ensureWorld('the_nether', { tp: `${X + .5} ${Y} ${Z + .5} -90 0` })
    await cmd('/scoreboard objectives add nd_deaths deathCount')
    await kit.randomReset(process.env.RNG_SEED || 1014)
    for (let trial = 1; trial <= trials; trial++) {
      await cmd('/gamemode creative')
      await cmd(`/execute in minecraft:the_nether run kill @e[type=!minecraft:player,x=${X},y=${Y},z=${Z},distance=..60]`)
      await kit.fillExact('the_nether', [[X - 2, Y - 1, Z - 2], [X + 2, Y - 1, Z + 2]], 'netherrack')
      await kit.fillExact('the_nether', [[X - 3, Y, Z - 3], [X + 3, Y + 4, Z + 3]], 'air')
      await kit.ensureWorld('the_nether', { tp: `${X + .5} ${Y} ${Z + .5} -90 0` })
      await cmd('/clear @s')
      await cmd('/effect clear @s')
      for (const item of ['iron_sword', 'iron_pickaxe', 'netherrack 64', 'bread 16']) await cmd(`/give @s minecraft:${item}`)
      await cmd('/item replace entity @s weapon.offhand with minecraft:shield')
      await cmd('/item replace entity @s armor.feet with minecraft:golden_boots')
      await cmd('/effect give @s minecraft:instant_health 1 5 true')
      await cmd('/effect give @s minecraft:saturation 1 5 true')
      await cmd('/scoreboard players set @s nd_deaths 0')
      await wallSleep(500)
      const mark = conn.heard.length, from = logSize(), t0 = Date.now()
      await cmd(`/summon minecraft:ghast ${X + dist + .5} ${Y + 4} ${Z + .5} {Tags:["nd_swat"],PersistenceRequired:1b}`)
      await cmd('/gamemode survival')
      let st = (await call('status')).state, minHp = st.health ?? 20, fell = false, died = false
      let walking: Promise<unknown> | null = null, flip = false
      const tick0 = st.clock?.ticks ?? 0
      for (;;) {
        if (process.env.BUSY === '1' && !walking) {
          flip = !flip
          walking = call('goto', { x: X + (flip ? 1 : -1), y: Y, z: Z + (flip ? 1 : -1), range: 0, timeoutSeconds: 8 }).catch(() => null).finally(() => { walking = null })
        }
        await wallSleep(100)
        st = (await call('status')).state
        minHp = Math.min(minHp, st.health ?? 20)
        if (st.pos && st.pos.y < Y - 2) fell = true
        died = conn.heard.slice(mark).some((e: any) => e.type === 'death')
        if (died || (st.clock?.ticks ?? 0) - tick0 >= seconds * 20 || Date.now() - t0 > 120000) break
      }
      const ghastAlive = (await call('ask', { command: '/execute if entity @e[type=minecraft:ghast,tag=nd_swat]', match: 'Test ', ms: 3000 })).detail?.lines?.some((l: string) => /Test passed/.test(l))
      const text = logSince(from)
      const row = { slot, trial, seconds, dist, busy: process.env.BUSY === '1', swat: process.env.ND_GHAST_SWAT_EXPECT || '?', died, fell, minHp: Math.round(minHp * 10) / 10,
        hits: (text.match(/шар гаста: удар/g) || []).length, back: (text.match(/шар гаста: отбит/g) || []).length, ghastAlive,
        damage: conn.heard.slice(mark).filter((e: any) => e.type === 'damage').map((e: any) => e.cause || e.type).slice(0, 12),
        ticks: (st.clock?.ticks ?? 0) - tick0 }
      console.log(JSON.stringify(row))
      if (process.env.LAB_OUT) fs.appendFileSync(process.env.LAB_OUT, JSON.stringify(row) + '\n')
      // Возрождение — само (mineflayer respawn: true), затем следующая попытка вернёт тело в Ад.
      if (died) await wallSleep(3000)
    }
  } finally {
    try { await call('stop') } catch {}
    try { await cmd('/gamemode creative') } catch {}
    try { await cmd(`/execute in minecraft:the_nether run kill @e[type=minecraft:ghast,x=${X},y=${Y},z=${Z},distance=..80]`) } catch {}
    try { await kit.unforceload('the_nether', box) } catch {}
    conn.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
