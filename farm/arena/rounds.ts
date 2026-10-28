'use strict'
// Ход раундов: смерти по журналу сервера и счёт, старт (сброс, наборы на раунд, разнос по точкам, мобы), конец
// раунда гонки и цикл бойца.
import { SOLO } from './context'
import { champTurn } from './champion'
import { teamOfHuman } from './humans'
import { dress } from './gear'
import { LAN, lanCmd } from './server'
import type { ArenaContext } from './context'
import * as fs from 'fs'

export function installRounds (ctx: ArenaContext) {
  const { i, teams, arms, bots, names, pos, deaths, kills, deadNow, out, deathAt, killGaps, humans, roundWins, radio, opened, chestBy, chestFail, refills, labNeed, brewed, alchemist, LOGF, BOX, HUMAN_TEAM, Y, teamOf, rcon, log, sleep } = ctx
  ctx.roundT0 = Date.now()
  ctx.lastKillAt = Date.now()
  // Смерти и убийства — по журналу сервера (кто кого: «X was slain/speared by Y»).
  ctx.readDeaths = () => {
    try {
      const st = fs.statSync(LOGF)
      // Paper в полночь заводит новый latest.log: читать его с начала. Прежнее место — в старом файле, и после 00:00 драйвер
      // не видел ни смертей, ни «рестарт» (игра пользователя 22.10: «никита умер — раунд не кончается, рестарт не работает»).
      if (st.size < ctx.logAt || ctx.logBorn && st.birthtimeMs !== ctx.logBorn) ctx.logAt = 0
      ctx.logBorn = st.birthtimeMs
      if (st.size <= ctx.logAt) return
      const fd = fs.openSync(LOGF, 'r'); const buf = Buffer.alloc(st.size - ctx.logAt); fs.readSync(fd, buf, 0, buf.length, ctx.logAt); fs.closeSync(fd); ctx.logAt = st.size
      if (ctx.between) return
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        const cm = /<(\S+)> !?(рестарт|restart)\s*$/i.exec(line)
        if (cm && !names.includes(cm[1])) { ctx.endRound(false, `${cm[1]} написал «${cm[2]}»`).catch(() => {}); continue }
        const m = /\]: (NeuroFarm\S+) (was .+|died.*|fell.+|hit the ground.*|burned.*|tried to swim.*|drowned.*|experienced kinetic.*|suffocated.*|starved.*|froze.*|withered.*|went up in flames.*|blew up.*|walked into.*|discovered.*|left the confines.*)$/.exec(line)
        const hm = !m && /\]: (\S+) (was .+|died.*|fell.+|hit the ground.*|burned.*|tried to swim.*|drowned.*|experienced kinetic.*|suffocated.*|starved.*|froze.*|withered.*|went up in flames.*|blew up.*|walked into.*|discovered.*|left the confines.*)$/.exec(line)
        const dead = m || hm, wind = dead && ctx.windOutAt?.[dead[1]]
        if (wind && Date.now() - wind.at < 4000) {
          ctx.windRecentDeaths = (ctx.windRecentDeaths || 0) + 1; delete ctx.windOutAt[dead[1]]
          log(`🌬☠ ${dead[1]} погиб в течение 4 с после броска ветра (${wind.kind}, бросал ${wind.by}); native причина: ${dead[2]} — всего таких смертей ${ctx.windRecentDeaths}`)
        }
        if (hm && humans[hm[1]] && !names.includes(hm[1])) {
          log(`☠ ${hm[1]} ${hm[2]}`)
          // Соло (12.10: «умер — раунд заново»; 14.10, двое людей: «логика n людей»): погибший выбыл до конца раунда (зритель),
          // как бот; раунд синих — когда выбыли все люди. Набор и место выдаст старт раунда (humanStart → kitHuman).
          if (SOLO) { ctx.humanOut.add(hm[1]); ctx.humanOutWatch(hm[1]).catch(() => {}); ctx.endRound().catch(() => {}) } else ctx.kitHuman(hm[1])
          // Его вещи на земле — лут для бойцов, не подарок (10.10: выпавший трезубец засчитался союзом).
          if (humans[hm[1]].p) deathAt[hm[1]] = { p: humans[hm[1]].p, at: Date.now(), looted: new Set<string>(), inv: {}, armor: {}, team: null }
        }
        if (!m || !names.includes(m[1])) continue
        deaths[m[1]] = (deaths[m[1]] || 0) + 1
        const by = names.find(n => n !== m[1] && (' ' + m[2] + ' ').includes(' ' + n + ' '))
        if (by) { kills[by] = (kills[by] || 0) + 1; const kb = bots.find(o => o.name === by); if (kb) ctx.emote(kb, Math.random() < 0.6 ? 'crouch' : 'wave') }
        const byH = Object.keys(humans).find(h => (' ' + m[2] + ' ').includes(' ' + h + ' '))
        if (byH && teams) ctx.relSay(teamOf(m[1]), byH, -5, `убил ${m[1]}`)
        deadNow.add(m[1])
        killGaps.push(Date.now() - ctx.lastKillAt); ctx.lastKillAt = Date.now()
        if (pos[m[1]]?.p) deathAt[m[1]] = { p: pos[m[1]].p, at: Date.now(), looted: new Set<string>(), inv: pos[m[1]].inv || {}, armor: pos[m[1]].armor || {}, team: teamOf(m[1]), by: by || byH || null, byMob: !by && !byH && / by /.test(m[2]) }
        // Кто и как убил: убийца в полёте (таран) или на земле, чем была занята жертва — разбор смертей от тарана (28.10).
        const vb = bots.find(o => o.name === m[1])
        log(`☠ ${m[1]} ${m[2]}${by ? ` [убийца ${pos[by]?.gliding ? 'летит' : 'на земле'}${pos[by]?.p && pos[m[1]]?.p ? ' в ' + Math.round(Math.hypot(pos[by].p.x - pos[m[1]].p.x, pos[by].p.y - pos[m[1]].p.y, pos[by].p.z - pos[m[1]].p.z)) + ' бл.' : ''}; жертва: ход ${vb?.swarmTask?.kind || '-'}, ${vb?.last?.m || '-'}${pos[m[1]]?.gliding ? ', летела' : ''}]` : ''}`)
      }
    } catch {}
  }
  ctx.board = () => names.map(n => `${teams ? (teamOf(n) === 'red' ? '🟥' : '🟦') : ''}${n.replace(`NeuroFarm${i}`, '#') || '#'}: ${kills[n] || 0}/${deaths[n] || 0}`).join('  ') +
    (teams ? `  | 🟥 ${names.filter(n => teamOf(n) === 'red').reduce((a, n) => a + (kills[n] || 0), 0)} : ${names.filter(n => teamOf(n) === 'blue').reduce((a, n) => a + (kills[n] || 0), 0)} 🟦` : '')
  ctx.reset = async (name) => { for (const c of [`gamemode spectator ${name}`, `clear ${name}`, `effect clear ${name}`, `effect give ${name} minecraft:instant_health 1 10 true`, `effect give ${name} minecraft:saturation 1 20 true`]) await rcon(i, c).catch(() => {}) }
  // Раздача на раунд по флагам: ARMS_AIR=1 — элитры, ракеты, копьё (ARMS_AIR=champ — только чемпиону: погоня пешком за
  // улетающим); ARMS_CRYSTAL=1 — кристаллы Края и обсидиан (10.10: «жёсткая баталия на взрывах»), тотем и поножи от взрывов.
  ctx.roundKit = async (b) => {
    if (b.champ) await ctx.kitStrong(b.name)
    const list = [...(process.env.ARMS_AIR === '1' || process.env.ARMS_AIR === 'champ' && b.champ ? ['elytra 1', 'firework_rocket 48', 'diamond_spear[enchantments={sharpness:3,knockback:1}] 1',
      // Булава с «Порывом ветра» и заряды (10.10: «летающее месиво — и булавы всем чарованные с ветром»).
      'mace[enchantments={density:3,breach:2,wind_burst:3}] 1', 'wind_charge 16',
      // Паутина под цель к тарану товарища (team_hint lanceWeb): в c33 из сундуков её почти не было — связка ни разу.
      'cobweb 4'] : []),
      ...(process.env.ARMS_CRYSTAL === '1' ? ['end_crystal 64', 'end_crystal 64', 'obsidian 64', 'obsidian 64', 'totem_of_undying 1', 'diamond_leggings[enchantments={blast_protection:4}] 1'] : []),
      // ARMS_TNT=1 (10.10: «раунд с кучей динамита — пусть взрывают всё вокруг как психи»): вагонетки с TNT, рельсы и лук
      // с огнём (бой умеет: рельс у врага, вагонетка, горящая стрела — boom.ts).
      ...(process.env.ARMS_TNT === '1' ? ['tnt_minecart 16', 'rail 32', 'bow[enchantments={flame:1,power:2}] 1', 'arrow 64', 'diamond_leggings[enchantments={blast_protection:4}] 1'] : [])]
    for (const it of list) { const [n, c] = it.split(/ (?=\d+$)/); await rcon(i, `give ${b.name} minecraft:${n} ${c || 1}`).catch(() => {}) }
  }
  // Выдача синим в начале каждого раунда (13.10: «ближайшие раунды — с элитрами и фейерверками, чтобы это тестить»):
  // ARMS_GIVE="elytra 1,firework_rocket 64" — через запятую «предмет число», после разноса.
  // Запятые внутри [] и {} — часть предмета (чары трезубца: {loyalty:3,channeling:1}), не разделитель.
  const GIVE = (process.env.ARMS_GIVE || '').split(/,(?![^{[]*[}\]])/).map(x => x.trim()).filter(Boolean)
  // ARMS_GIVE_ALL=1 — обеим командам (пользователь 24.10: «предметы все сразу ботам выдавать, чтобы быстрее тесты прошли»).
  const GIVE_TO = process.env.ARMS_GIVE_ALL === '1' ? '@a[gamemode=survival]' : '@a[team=blue,gamemode=survival]'
  ctx.giveBlue = async () => { for (const g of GIVE) await rcon(i, `give ${GIVE_TO} minecraft:${g}`).catch(() => {}); if (GIVE.length) log(`🎒 ${process.env.ARMS_GIVE_ALL === '1' ? 'всем' : 'синим'} выдано: ${GIVE.join(', ')}`) }
  ctx.spreadBots = async () => {
    const ready = new Set<string>()
    const park = (name: string) => rcon(i, `gamemode spectator ${name}`).catch(e => { ctx.stop = true; throw e })
    for (const [k, b] of bots.entries()) {
      const h = ctx.armsHome(b, k)
      const command = `spreadplayers ${Math.floor(h.x)} ${Math.floor(h.z)} 0 3 under ${Math.max(Y + 3, h.y + 3)} false ${b.name}`
      const spread = async () => String(await (LAN ? lanCmd(command, 20000, /^(Spread |Could not spread|Invalid maxHeight|No (?:player|entity))/) : rcon(i, command, 20000))).trim()
      let receipt = await spread().catch(e => String(e?.message || e))
      // Тела нет в мире (отвалилось) — переподключить и ещё раз; не вышло — без него, а не вся арена (бой роя 24.10: «No
      // entity was found» у одного ронял драйвер на старте).
      if (/^No (player|entity)/.test(receipt)) {
        await b.c.call('connect').catch(() => {})
        await park(b.name) // Новое тело могло загрузить survival из сохранённого состояния.
        await sleep(1500); receipt = await spread().catch(e => String(e?.message || e))
      }
      if (/^Spread 1 entity\/entities\b/.test(receipt)) ready.add(b.name)
      else { out.add(b.name); log(`⚠ разнос ${b.name}: ${receipt || 'сервер молчит'}`); await park(b.name) }
    }
    log(`разнос: подтверждено ${ready.size}/${bots.length}`)
    if (!ready.size) { ctx.stop = true; throw new Error('safe placement: ни одного подтверждённого бойца') }
    return ready
  }
  // Конец раунда: команда без живых — победа другой; пауза, уборка, новые сундуки, все на старт, снова лут и бой.
  // Раунд дольше ROUND_S (420 реальных с) — победа той, где живых больше (ничья — по убийствам).
  ctx.endRound = async function endRound (timeout = false, forced: string | null = null) {
    if (!arms || ctx.between) return
    // Люди в соло: живые — онлайн и не выбывшие; пока никого нет онлайн — считаю одного (раунд ждёт людей, а не кончается).
    // Люди своей команды в игре (ARMS_HUMAN_TEAMS — у каждого своя); людей нет — команда людей не пустеет.
    const humansIn = (t) => ctx.humanNames.length ? ctx.humanNames.filter(h => !ctx.humanOut.has(h) && teamOfHuman(h, HUMAN_TEAM) === t).length : t === HUMAN_TEAM ? 1 : 0
    const alive = (t) => bots.filter(b => b.team === t && !out.has(b.name)).length + (SOLO ? humansIn(t) : 0)
    let win = alive('red') === 0 ? 'blue' : alive('blue') === 0 ? 'red' : null
    if (!win && timeout) {
      const kt = (t) => names.filter(n => teamOf(n) === t).reduce((a, n) => a + (kills[n] || 0), 0)
      win = alive('red') !== alive('blue') ? (alive('red') > alive('blue') ? 'red' : 'blue') : (kt('red') >= kt('blue') ? 'red' : 'blue')
    }
    // Рестарт по чату (10.10: «команда рестарт — перезапускать раунд самому») — без победителя.
    if (forced) win = null
    if (!win && !forced) return
    ctx.between = true
    if (win) roundWins[win]++
    const ru = win === 'red' ? 'красных' : 'синих'
    for (const o of bots) if (o.team === win && !out.has(o.name)) ctx.emote(o, Math.random() < 0.5 ? 'crouch' : 'wave')
    if (forced) log(`🔄 раунд ${ctx.round} перезапущен: ${forced}`)
    else log(`🏁 раунд ${ctx.round}${timeout ? ' (время)' : ''}: победа ${ru} — раунды 🟥 ${roundWins.red} : ${roundWins.blue} 🟦; ${ctx.board()}`)
    await rcon(i, 'title @a times 10 70 20').catch(() => {})
    const tr = String(await rcon(i, `title @a title {"text":"${forced ? 'Рестарт' : 'Победа ' + ru}","color":"${win || 'gold'}"}`, 15000).catch(e => 'ошибка ' + e.message))
    if (!/Showing/i.test(tr)) log(`⚠ титр победы не показан: ${tr.slice(0, 120)}`)
    await rcon(i, `tellraw @a {"text":"${forced ? '🔄 Раунд ' + ctx.round + ' перезапущен' : '🏁 Раунд ' + ctx.round + ': победа ' + ru}","color":"${win || 'gold'}"}`).catch(() => {})
    await rcon(i, `title @a subtitle {"text":"Раунд ${ctx.round} · 🟥 ${roundWins.red} : ${roundWins.blue} 🟦"}`).catch(() => {})
    for (const b of bots) await b.c.call('stop').catch(() => {})
    // Only owned bots leave collision during arena restoration; humans retain their own game mode and position.
    for (const b of bots) await rcon(i, `gamemode spectator ${b.name}`)
    await sleep(forced ? 1500 : 5000)
    ctx.round++
    ctx.swarmDriver.reset()
    for (const t of ['item', 'arrow', 'experience_orb', 'splash_potion']) await rcon(i, `kill @e[type=${t},${BOX}]`).catch(() => {})
    await ctx.restoreArena()
    await ctx.stockChests(ctx.round)
    for (const k of Object.keys(deathAt)) delete deathAt[k]
    for (const k of Object.keys(radio)) delete radio[k]
    opened.clear(); chestBy.clear(); chestFail.clear(); refills.clear()
    for (const k of Object.keys(labNeed)) delete labNeed[k]
    for (const k of Object.keys(brewed)) delete brewed[k]
    for (const k of Object.keys(alchemist)) delete alchemist[k]
    for (const [k, b] of bots.entries()) {
      const h = ctx.armsHome(b, k)
      for (const c of [`tp ${b.name} ${h.x} ${h.y} ${h.z}`, `clear ${b.name}`, `effect clear ${b.name}`, `effect give ${b.name} minecraft:instant_health 1 10 true`, `effect give ${b.name} minecraft:saturation 1 20 true`]) await rcon(i, c).catch(() => {})
      await ctx.roundKit(b)
    }
    // По списку онлайн, а не по карте humans: под нагрузкой сброса раунда чтение Pos у неё отваливается (10.10: «не телепортировало»).
    // Успешно размещённые продолжают раунд; остальные остаются зрителями и не считаются живыми.
    out.clear()
    await ctx.spreadBots()
    ctx.readDeaths()
    deadNow.clear(); ctx.humanOut.clear()
    for (const b of bots) if (!out.has(b.name)) await rcon(i, `gamemode survival ${b.name}`)
    await ctx.giveBlue()
    if (HUMAN_TEAM) for (const h of new Set([...ctx.humanNames, ...Object.keys(humans)])) await ctx.humanStart(h)
    await rcon(i, `title @a title {"text":"Раунд ${ctx.round}","color":"gold"}`).catch(() => {})
    await sleep(1500)
    if (process.env.ARMS_PHASES === '1') await ctx.armsPrep()
    ctx.roundT0 = Date.now(); ctx.lastKillAt = Date.now(); killGaps.length = 0
    ctx.between = false
  }
}

// Старт боя: гонка — все зрителями на точки раскладки, наборы раунда, разнос на свободный верх, потом в бой; дезматч —
// набор и точка входа.
export async function placeFighters (ctx: ArenaContext) {
  const { i, kit, arms, bots, N, rcon } = ctx
  if (arms) {
    ctx.between = true
    for (let k = 0; k < N; k++) { const h = ctx.armsHome(bots[k], k); await ctx.reset(bots[k].name); await rcon(i, `tp ${bots[k].name} ${h.x} ${h.y} ${h.z}`); await ctx.roundKit(bots[k]) }
    ctx.out.clear()
    await ctx.spreadBots()
    ctx.readDeaths()
    for (const b of bots) if (!ctx.out.has(b.name)) await rcon(i, `gamemode survival ${b.name}`)
    await ctx.giveBlue()
    ctx.between = false
  }
  else for (let k = 0; k < N; k++) { await dress(i, bots[k].name, kit); await ctx.place(bots[k].name, ctx.home(bots[k], k)) }
}

export async function startMobs (ctx: ArenaContext) {
  const { i, X, Y, Z, L, R, rcon, log } = ctx
  // Радиус поля: у карты гонки — её, в run/team карты нет (L = null — ARMS_MOBS там падал).
  const field = L?.R ?? R
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
      const a = mrnd() * Math.PI * 2; const r0 = 4 + mrnd() * (field - 6)
      await rcon(i, `summon minecraft:${kind} ${Math.round(X + Math.cos(a) * r0)} ${Y + 12} ${Math.round(Z + Math.sin(a) * r0)} {PersistenceRequired:1b,Tags:["arms_mob","arms_new"],${eq}${extra}}`).catch(() => {})
    }
    // На землю поля (не в холм): spreadplayers кладёт и мобов — на верх рельефа.
    await rcon(i, `spreadplayers ${X} ${Z} 3 ${field - 3} false @e[tag=arms_new]`).catch(() => {})
    await rcon(i, 'tag @e[tag=arms_new] remove arms_new').catch(() => {})
  }
  const topUpMobs = async () => {
    if (!MOBS) return
    const r = String(await rcon(i, 'execute if entity @e[tag=arms_mob]').catch(() => ''))
    const have = Number((/Count: (\d+)/.exec(r) || [])[1] || 0)
    if (have < MOBS) { await spawnMobs(MOBS - have); log(`👹 мобов на арене ${have} → ${MOBS}`) }
  }
  await topUpMobs()
  return MOBS ? setInterval(() => { if (!ctx.between) topUpMobs().catch(() => {}) }, 30000) : null
}

// Цикл бойца: смерть (гонка — зритель до конца раунда; иначе — набор и снова на поле), ход роя.
export async function fighterLoop (ctx: ArenaContext, b) {
  const { i, kit, arms, bots, N, X, Y, Z, pos, deadNow, out, busy, rcon, log, sleep } = ctx
  // Тело не в игре (отвалилось, выкинуто) — переподключить; новое — только когда прежнее кончилось: без этого оно числилось
  // живым до конца раунда, команда не пустела и раунд кончался по времени (бой роя 24.10: трое, 1600 ходов впустую).
  const reconnect = async (b) => {
    if (b.reconnecting) return
    b.reconnecting = true
    try {
      const st = await b.c.call('status').catch(() => null)
      if (st?.state?.pos) return
      const r = await b.c.call('connect').catch(x => ({ why: x.message }))
      log(`🔌 ${b.name}: тело не в игре — переподключаю: ${r?.why || (r?.already ? 'уже в игре' : 'ok')}`)
      if (ctx.arms && out.has(b.name)) await rcon(i, `gamemode spectator ${b.name}`).catch(() => {})
    } finally { b.reconnecting = false }
  }
  while (!ctx.stop) {
    if (arms && ctx.between) { await sleep(500); continue }
    if (arms && (ctx.between || out.has(b.name)) && !deadNow.has(b.name)) { await sleep(500); continue }
    if (busy.has(b.name) && !deadNow.has(b.name)) { await sleep(500); continue }
    if (arms && deadNow.has(b.name)) {
      const deathRound = ctx.round
      ctx.swarmDriver.release(b, true)
      deadNow.delete(b.name)
      out.add(b.name)
      await b.c.call('stop').catch(() => {})
      if (ctx.between || ctx.round !== deathRound) continue
      // Анимация смерти (10.10; 14.10 «опять пропала»): тело лежит, пока демон не возродится (ND_RESPAWN_MS), и не меньше
      // 3.5 с от смерти — зрителем только после (старый хп из опроса давал зрителя через 1.5 с, тело исчезало на лету).
      const diedAt = ctx.deathAt[b.name]?.at || Date.now()
      for (let t = 0; t < 16 && !((pos[b.name]?.hp ?? 0) > 0 && Date.now() - diedAt >= 3500); t++) await sleep(500)
      for (const c of [`gamemode spectator ${b.name}`, `tp ${b.name} ${X} ${Y + 28} ${Z}`]) {
        if (ctx.between || ctx.round !== deathRound) break
        await rcon(i, c).catch(() => {})
      }
      if (ctx.between || ctx.round !== deathRound) continue
      log(`👻 ${b.name} выбыл до конца раунда ${ctx.round} (${b.team === 'red' ? 'красные' : 'синие'}: живых ${bots.filter(o => o.team === b.team && !out.has(o.name)).length})`)
      await ctx.endRound()
      continue
    }
    if (deadNow.has(b.name)) {
      ctx.swarmDriver.release(b, true)
      deadNow.delete(b.name)
      await b.c.call('stop').catch(() => {})
      await sleep(1500)
      if (arms) { const h = ctx.armsHome(b, Math.floor(Math.random() * 6)); for (const c of [`effect give ${b.name} minecraft:instant_health 1 10 true`, `spreadplayers ${Math.floor(h.x)} ${Math.floor(h.z)} 0 3 under ${Y + 3} false ${b.name}`]) await rcon(i, c).catch(() => {}); await b.c.call('armor').catch(() => {}) } else {
        await dress(i, b.name, kit).catch(() => {})
        await ctx.place(b.name, ctx.home(b, Math.floor(Math.random() * N))).catch(() => {})
      }
      await sleep(1000)
      continue
    }
    if (!pos[b.name]?.p) { await reconnect(b); await sleep(250); continue }
    // Ход, вернувшийся без обращения к демону (занят чужой задачей, нет задачи), — пауза: иначе цикл крутится на готовых
    // обещаниях и Node не доходит до таймеров и сокетов (ревью 13.10: вся арена вставала, напарник ждал вечно).
    const turnAt = Date.now()
    try { await (b.champ ? champTurn(ctx, b) : ctx.swarmDriver.turn(b)) }
    catch (e: any) {
      // Тело отвалилось (client timed out под нагрузкой) — переподключить, раз в 5 с: без этого «не в игре» шло до конца
      // раунда, а команда не пустела и раунд кончался по времени (бой роя 24.10: трое, 1600 ходов впустую).
      if (/не в игре/.test(e.message)) await reconnect(b)
      else log(`🐜 ${b.name}: ${e.message}`)
      await sleep(500)
    }
    if (Date.now() - turnAt < 50) await sleep(100)
  }
}
