'use strict'
// Живые игроки: набор человеку и его старт в своей команде, отношения команд к людям (враг, союзник), кто онлайн и кто
// кому враг, подарки.
import { SOLO } from './context'
import { LAN_NAME } from './server'
import type { ArenaContext } from './context'
const fs = require('fs')

// Человек в команде (ARMS_HUMAN_TEAM=red|blue, 10.10: «сделай меня красным, спавни вместе с ними — буду бегать за лутом»):
// своя команда — союзник (не бьют, прикрывают), чужая — враг; на старте раунда — пустой, со своими на их точке.
export const humanTeam = (teams) => teams && /^(red|blue)$/.test(process.env.ARMS_HUMAN_TEAM || (SOLO ? 'red' : '')) ? process.env.ARMS_HUMAN_TEAM || 'red' : null

export function installHumanKit (ctx: ArenaContext) {
  const { i, L, X, Y, Z, bots, rel, HUMAN_TEAM, rcon, log, sleep } = ctx
  // Место человека — комната спавна своей команды (колизей, 14.10): по кругу по комнатам в порядке появления, в комнате —
  // рядом через 2 бл. вдоль неё. Нет комнат (другая карта) — null, как было.
  const seat = new Map<string, number>()
  ctx.humanHome = (h) => {
    const rooms = (L?.spawnRooms || []).filter(r => r.team === HUMAN_TEAM)
    if (!rooms.length) return null
    if (!seat.has(h)) seat.set(h, seat.size)
    const k = seat.get(h) as number; const r = rooms[k % rooms.length]
    const du = [0, -2, 2, -4, 4][Math.floor(k / rooms.length) % 5]
    return { x: X + r.spot.x + du + 0.5, y: Y + r.spot.y, z: Z + r.spot.z + 0.5, yaw: r.spot.yaw, room: r.id }
  }
  // Выбыл (соло): после возрождения — зритель над полем до конца раунда; раунд сменился раньше — старт раунда уже вернул его.
  ctx.humanOutWatch = async (h) => {
    const r = ctx.round
    const gone = () => ctx.round !== r || ctx.between
    let ok = 0
    for (let t = 0; t < 240 && ok < 2 && !gone(); t++) { await sleep(500); const hp = /([\d.]+)f/.exec(String(await rcon(i, `data get entity ${h} Health`).catch(() => ''))); ok = hp && +hp[1] > 0 ? ok + 1 : 0 }
    if (gone() || ok < 2) return
    for (const c of [`gamemode spectator ${h}`, `tp ${h} ${X} ${Y + 28} ${Z}`, `title ${h} actionbar {"text":"Выбыл до конца раунда — смотри за своими","color":"gray"}`]) await rcon(i, c).catch(() => {})
    log(`👻 ${h} выбыл до конца раунда ${r} (людей в бою: ${ctx.humanNames.filter(n => !ctx.humanOut.has(n)).join(', ') || 'никого'})`)
  }
  // Набор живому игроку после смерти (пользователь 10.10: «после смерти выдавай всё снова и скорость»): силач против толпы.
  // ARMS_HUMAN_KIT=0 — выкл. Вещи погибшего остаются на земле — их лутают боты.
  const E = 'enchantments={'
  const HUMAN_KIT = [`netherite_sword[${E}sharpness:${SOLO ? 5 : 30},fire_aspect:3,knockback:1,looting:3,sweeping_edge:3,unbreaking:3,mending:1}] 1`, `mace[${E}density:5,wind_burst:3,unbreaking:3}] 1`,
    `bow[${E}power:5,punch:2,flame:1,infinity:1}] 1`, 'arrow 1', `shield[${E}unbreaking:3}] 1`, 'golden_apple 16', 'enchanted_golden_apple 2', ...(SOLO ? [] : ['totem_of_undying 2']),
    'wind_charge 64', 'ender_pearl 16', 'cooked_beef 32',
    // Кирка (12.10: «выдавай кирку — не могу ломать блоки»).
    `netherite_pickaxe[${E}efficiency:5,unbreaking:3}] 1`,
    ...(SOLO ? ['splash_potion[potion_contents={custom_effects:[{id:"minecraft:instant_damage",amplifier:1,duration:1}]}] 8',
      'lingering_potion[potion_contents={custom_effects:[{id:"minecraft:instant_damage",amplifier:0,duration:1}]}] 4', 'cobweb 32', 'obsidian 64', 'water_bucket 1'] : [])]
  const TH = SOLO ? 'thorns:3,' : ''
  const HUMAN_ARMOR = [['armor.head', `netherite_helmet[${E}${TH}protection:4,unbreaking:3,mending:1}]`], ['armor.chest', `netherite_chestplate[${E}${TH}protection:4,unbreaking:3,mending:1}]`],
    ['armor.legs', `netherite_leggings[${E}${TH}protection:4,unbreaking:3,mending:1}]`], ['armor.feet', `netherite_boots[${E}${TH}protection:4,feather_falling:4,unbreaking:3,mending:1}]`]]
  ctx.kitHuman = async (h) => {
    if (process.env.ARMS_HUMAN_KIT === '0') return
    // Дождаться живого (экран смерти — выданное мёртвому пропадает при возрождении): хп > 0 два опроса подряд.
    let ok = 0
    for (let t = 0; t < 240 && ok < 2; t++) { await sleep(500); const hp = /([\d.]+)f/.exec(String(await rcon(i, `data get entity ${h} Health`).catch(() => ''))); ok = hp && +hp[1] > 0 ? ok + 1 : 0 }
    if (ok < 2) { log(`🎽 ${h} не возродился за 2 мин — набор не выдан`); return }
    // Соло (12.10: «возрождает не в Колизее — спавн ломается, блоки на арене меняются»): точку возрождения боты застраивают,
    // и сервер кидает на спавн мира, — после смерти ставлю сам на красную сторону, на свободный верх (как ботов).
    // Есть комнаты спавна (колизей, 14.10) — в свою комнату, её боты не застраивают сами по себе.
    const home = ctx.humanHome(h)
    if (home) await rcon(i, `tp ${h} ${home.x} ${home.y} ${home.z} ${home.yaw} 0`).catch(() => {})
    else if (SOLO && L) { const s0 = ctx.armsHome({ team: 'red' }, 0); await rcon(i, `spreadplayers ${Math.floor(s0.x)} ${Math.floor(s0.z)} 0 3 under ${Y + 3} false ${h}`).catch(() => {}) }
    // Уже в наборе (зашёл с ним, раунд сменился) — не дублировать.
    if (/passed/i.test(String(await rcon(i, `execute if items entity ${h} container.* minecraft:netherite_sword if items entity ${h} armor.chest minecraft:netherite_chestplate`).catch(() => '')))) return
    for (const [slot, it] of HUMAN_ARMOR) await rcon(i, `item replace entity ${h} ${slot} with minecraft:${it}`).catch(() => {})
    for (const it of HUMAN_KIT) { const [n, c] = it.split(/ (?=\d+$)/); await rcon(i, `give ${h} minecraft:${n} ${c || 1}`).catch(() => {}) }
    await rcon(i, `effect give ${h} minecraft:speed infinite ${SOLO ? 1 : 4} true`).catch(() => {})
    if (!SOLO) await rcon(i, `effect give ${h} minecraft:strength infinite 1 true`).catch(() => {})
    await rcon(i, `effect give ${h} minecraft:resistance 4 4 true`).catch(() => {})
    // Соло: Сопротивление I (−20%), +8 хп, огнестойкость, сытость — бессрочно; без Силы и регенерации (12.10: «слишком легко»).
    if (SOLO) for (const fx of ['resistance infinite 0', 'health_boost infinite 1', 'fire_resistance infinite 0', 'saturation infinite 0', 'instant_health 1 10'])
      await rcon(i, `effect give ${h} minecraft:${fx} true`).catch(() => {})
    log(`🎽 ${h} возродился — набор и «Скорость V» выданы`)
  }
  ctx.humanStart = async (h) => {
    const other = HUMAN_TEAM === 'red' ? 'blue' : 'red'
    rel[HUMAN_TEAM][h] = 20; rel[other][h] = -20
    const mate = bots.find(b => b.team === HUMAN_TEAM)
    // Комната спавна (колизей) — старт и точка возрождения; иначе — к своим, как было.
    const home = ctx.humanHome(h)
    const at = home || (mate ? ctx.armsHome(mate, bots.indexOf(mate)) : SOLO ? ctx.armsHome({ team: HUMAN_TEAM }, 0) : null)
    const res: string[] = []
    for (const c of [`team join ${HUMAN_TEAM} ${h}`, `gamemode survival ${h}`, `clear ${h}`, `effect clear ${h}`, `effect give ${h} minecraft:instant_health 1 10 true`,
      `effect give ${h} minecraft:saturation 1 20 true`, ...(at ? [`tp ${h} ${at.x} ${at.y} ${at.z}${home ? ` ${home.yaw} 0` : ''}`] : []),
      ...(home ? [`spawnpoint ${h} ${Math.floor(home.x)} ${Math.floor(home.y)} ${Math.floor(home.z)} ${home.yaw}`] : [])]) res.push(String(await rcon(i, c, 15000).catch(e => 'ошибка: ' + e.message)).slice(0, 40))
    // Набор — в фоне: после смерти он на экране возрождения, а сброс раунда ждать его не должен.
    if (SOLO) ctx.kitHuman(h).catch(() => {})
    log(`🧍 ${h} — в ${HUMAN_TEAM === 'red' ? 'красных' : 'синих'}, на старт ${home ? `${home.room} ` : ''}${at ? `${Math.round(at.x)} ${Math.round(at.y)} ${Math.round(at.z)}` : '?'}: ${res.filter(r => /ошибка|Unknown|Incorrect|No player|not found/i.test(r)).join('; ') || 'ок'}`)
  }
}

export function installHumans (ctx: ArenaContext) {
  const { teams, bots, pos, out, rel, humans, log } = ctx
  ctx.emote = (b, kind, at = null) => b.c.call('emote', { kind, at }).catch(() => {})
  ctx.eyeOf = (h) => humans[h]?.p ? { x: humans[h].p.x, y: humans[h].p.y + 1.6, z: humans[h].p.z } : null
  ctx.relSay = (team, h, d, why) => {
    if (!teams || !team) return
    const was = rel[team][h] || 0; const now = Math.max(-20, Math.min(20, was + d)); rel[team][h] = now
    if (Math.sign(was) !== Math.sign(now)) {
      const tn = team === 'red' ? 'красные' : 'синие'
      log(now < 0 ? `😠 ${h} — враг: ${tn} все на него (${why})` : now > 0 ? `🤝 ${h} — союзник ${tn === 'красные' ? 'красных' : 'синих'} (${why})` : `😐 ${h} — нейтрал для ${tn}`)
      for (const o of bots) {
        const m = pos[o.name]; const hp = humans[h]?.p
        if (o.team !== team || out.has(o.name) || !m?.p || !hp || Math.hypot(m.p.x - hp.x, m.p.z - hp.z) > 16) continue
        if (now < 0) ctx.emote(o, 'shake', ctx.eyeOf(h)); else if (now > 0) ctx.emote(o, 'nod', ctx.eyeOf(h)).then(() => ctx.emote(o, 'crouch'))
      }
      const b0 = bots.find(o => o.team === team && !out.has(o.name))
      if (b0) ctx.tell(b0, now < 0 ? `[${tn}] ${h} напал — все на него!` : `[${tn}] ${h} с нами — прикрываем`)
    }
  }
}

export function watchHumans (ctx: ArenaContext) {
  const { i, teams, arms, bots, names, rel, humans, LOGF, HUMAN_TEAM, teamOf, rcon, log } = ctx
  const started = new Set<string>()
  const joined = new Set<string>(); let joinAt = 0
  let humanListAt = 0
  let humanBusy = false
  let humanErrAt = 0
  ctx.hostile = (b, name) => names.includes(name) ? name !== b.name && (!teams || teamOf(name) !== b.team) : !teams || (HUMAN_TEAM ? HUMAN_TEAM !== b.team : (rel[b.team]?.[name] || 0) < 0)
  const watchedFoes = new Map<string, string>()
  const humanT = setInterval(async () => {
    if (humanBusy) return
    humanBusy = true
    try {
    if (Date.now() - humanListAt > 5000) {
      humanListAt = Date.now()
      const l = await rcon(i, 'list').catch(() => '')
      // list по RCON обрезается после ~16 имён («...», 12.10: при 60 ботах человека не видело) — кто зашёл/вышел, беру
      // ещё из журнала сервера, с начала (зашедшие до старта драйвера тоже).
      try {
        const st = fs.statSync(LOGF)
        if (st.size < joinAt) joinAt = 0
        if (st.size > joinAt) {
          const fd = fs.openSync(LOGF, 'r'); const buf = Buffer.alloc(st.size - joinAt); fs.readSync(fd, buf, 0, buf.length, joinAt); fs.closeSync(fd); joinAt = st.size
          for (const m of buf.toString('utf8').matchAll(/\]: (\w+) (joined|left) the game/g)) if (m[2] === 'joined') joined.add(m[1]); else joined.delete(m[1])
        }
      } catch {}
      ctx.humanNames = [...new Set([...String(l).replace(/^.*online:\s*/, '').split(/,\s*/).map(x => x.trim()), ...joined])].filter(x => x && x !== '...' && !names.includes(x) && x !== LAN_NAME)
      if (arms) for (const o of bots) {
        const foes = [...names, ...ctx.humanNames].filter(name => ctx.hostile(o, name))
        const key = foes.join(',')
        if (watchedFoes.get(o.name) !== key) { watchedFoes.set(o.name, key); o.c.call('watch_dangers', { on: true, foes }).catch(() => {}) }
      }
    }
    // Tab/list and join logs are public; RCON remains administrative, never an enemy sensor.
    for (const h of ctx.humanNames) {
      const fresh = !humans[h]
      humans[h] ||= { hp: 20 }
      if (fresh && !SOLO) ctx.kitHuman(h).catch(() => {})
      if (fresh && HUMAN_TEAM && !started.has(h)) { started.add(h); ctx.humanStart(h).catch(e => log(`⚠ ${h}: в команду не поставил — ${e.message}`)) }
    }
    } catch (e: any) { if (Date.now() - (humanErrAt || 0) > 10000) { humanErrAt = Date.now(); log(`⚠ слежка за игроками: ${e.message}`) } } finally { humanBusy = false }
  }, 250)
  // Брошенное игроком (10.10: «не видят, как кидаю предметы — хочу делиться»): раз в секунду — что лежит у игрока с меткой
  // «бросил он» (Thrower, видно в игре как вылет из его рук). Ценное — ближнему бойцу (любой команды, даже если игрок ему
  // враг: подарок — путь к миру): бросить дело и взять.
  const uuidOf: Record<string, string> = {}
  let giftBusy = false
  const giftT = null
  const humanNear = (p, r) => Object.entries(humans).filter(([, h]: any) => h.p && h.hp > 0 && Math.hypot(h.p.x - p.x, h.p.y - p.y, h.p.z - p.z) <= r).map(([n]) => n)
  return { humanT, giftT }
}
