'use strict'
const gameClock = require('./src/game-clock')
// Зачарование (src/enchant.js), честно: из сырья (тростник, кожа, доски,
// обсидиан, алмазы, лазурит) бот сам делает бумагу → книги → полки → стол,
// ставит 15 полок кольцом через клетку воздуха, читает подсказки стола и
// выбирает строку по пользе. Уровни опыта — /xp (опыт не предмет; как его
// добыть, бот говорит в плане: плавка, руда, мобы).
//   (а) план без стола: чего не хватает и что зачаровать первым
//   (б) setup: стол + 15 полок, стол видит 15
//   (в) алмазный меч на 30 уровнях — верхняя строка, чары есть, уровни ушли
//   (г) авто: лук берёт доступную строку, алмазные ботинки ждут уровней
//   (д) книга на столе → наковальня (из 3 блоков железа и 4 слитков) на вещь
// Площадка x=2400 z=1600 на камне.
const WebSocket = require('ws')

const ws = new WebSocket(process.env.ND_WS || 'ws://127.0.0.1:8765')
let id = 0
const pending = new Map()
const call = (method, params: any = {} as Record<string, any>) => new Promise<any>((resolve, reject) => {
  const rid = ++id
  pending.set(rid, { resolve, reject })
  ws.send(JSON.stringify({ id: rid, method, params }))
})
ws.on('message', raw => {
  const m = JSON.parse(raw.toString()); gameClock.follow(m.clock || m.result?.state?.clock || m.result?.clock)
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
})
const sleep = ms => gameClock.sleep(ms)
async function cmd (text) { await call('say', { text }); await sleep(350) }
// Автопилот сам крафтит инструмент (keepTools) — тогда крафт мозга отвечает
// «повтори через секунду». Повторяем, как и сказано.
// И серию крафтов за верстаком mineflayer на 1.21.11 рвёт на середине
// (бумага ×3 захода — бывает ноль): добиваем, пока не наберётся.
async function craft (params) {
  let r = null
  for (let i = 0; i < 6; i++) {
    r = await call('craft', params)
    if (r.status === 'failed' && /автопилот/.test(r.error || '')) { await sleep(2000); continue }
    if (((r.state && r.state.inventory) || {} as Record<string, any>)[params.item] >= params.count) break
    if (r.status === 'failed') break
    await sleep(800)
  }
  return r
}

let failures = 0
function check (label, ok, note = '') {
  if (!ok) failures++
  console.log(`  ${ok ? '[ OK ]' : '[ПЛОХО]'} ${label}${note ? ' — ' + note : ''}`)
}
const brief = (r) => JSON.stringify(r.detail || r.error || r.status).slice(0, 600)
const inv = (r) => (r && r.state && r.state.inventory) || {} as Record<string, any>

const X = 2400
const Y = 100
const Z = 1600

async function stage () {
  await cmd(`/tp @s ${X + 0.5} ${Y + 2} ${Z + 0.5}`)
  await cmd('/effect give @s minecraft:slow_falling 5 0 true')
  await sleep(2500)
  await cmd(`/fill ${X - 10} ${Y - 4} ${Z - 10} ${X + 10} ${Y - 1} ${Z + 10} minecraft:stone`)
  await cmd(`/fill ${X - 10} ${Y} ${Z - 10} ${X + 10} ${Y + 6} ${Z + 10} minecraft:air`)
  await cmd('/kill @e[type=!minecraft:player,distance=..40]')
  await cmd(`/tp @s ${X + 0.5} ${Y} ${Z + 0.5}`)
  await cmd('/clear @s')
  await cmd('/xp set @s 0 levels')
  await cmd('/xp set @s 0 points')
  await sleep(600)
}

async function main () {
  await new Promise<any>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  try { await call('connect') } catch {}
  await sleep(1500)
  // На этом сервере бывают и другие боты-операторы: их команды приходят нам
  // чатом «[NeuroDown2: ...]» и рвут намерение как реплика человека.
  await cmd('/gamerule log_admin_commands false')
  await cmd('/difficulty peaceful')
  await cmd('/gamerule advance_time false')
  await cmd('/time set 1000')
  const ONLY = process.env.ONLY || ''
  const on = k => !ONLY || ONLY.includes(k)

  // (в)-(д) без (а)(б) — на уже построенном столе прошлого прогона.
  if (on('а') || on('б')) {
    await stage()
    await cmd('/give @s minecraft:iron_pickaxe 1')
    await cmd('/give @s minecraft:diamond_sword 1')
    await cmd('/give @s minecraft:bow 1')
    await cmd('/give @s minecraft:diamond_boots 1')
    await cmd('/give @s minecraft:sugar_cane 64')
    await cmd('/give @s minecraft:sugar_cane 64')
    await cmd('/give @s minecraft:sugar_cane 24')
    await cmd('/give @s minecraft:leather 50')
    await cmd('/give @s minecraft:oak_planks 64')
    await cmd('/give @s minecraft:oak_planks 40')
    await cmd('/give @s minecraft:obsidian 4')
    await cmd('/give @s minecraft:diamond 2')
    await cmd('/give @s minecraft:lapis_lazuli 24')
    await sleep(800)
  }

  if (on('а')) {
    const r: any = await call('enchant', { mode: 'plan' })
    const d = r.detail || {} as Record<string, any>
    const text = (d.lines || []).join(' | ')
    check('(а) план без стола: стол скрафтим, есть на что', /всё на него есть/.test(text), text.slice(0, 300))
    check('(а) первым — меч, с «зачем»', d.targets && d.targets[0] && d.targets[0].item === 'diamond_sword', JSON.stringify(d.targets))
    check('(а) уровни 0 — сказано, где брать опыт', /плавка/.test(text) && d.level === 0)
  }

  if (on('б')) {
    const t0 = gameClock.now()
    const r: any = await call('enchant', { mode: 'setup' })
    const d = r.detail || {} as Record<string, any>
    check('(б) стол поставлен', r.status === 'done' && !!d.table, brief(r))
    check('(б) стол видит 15 полок', d.shelves === 15, `shelves=${d.shelves}, поставил ${d.placedShelves}, за ${Math.round((gameClock.now() - t0) / 1000)} с`)
    const f: any = await call('blocks_around', { find: 'bookshelf', radius: 12, count: 64 })
    const n = (f.detail && f.detail.found && f.detail.found.length) || 0
    check('(б) в мире ≥15 полок', n >= 15, `нашёл ${n}`)
    const et: any = await call('blocks_around', { find: 'enchanting_table', radius: 12 })
    check('(б) стол в мире', !!(et.detail && et.detail.found && et.detail.found.length))
  }

  if (on('в')) {
    // 33 уровня: верхняя строка (30) доступна и после пары перебросов книгой.
    await cmd('/xp set @s 0 levels')
    await cmd('/xp add @s 33 levels')
    // Свежий меч (на случай повторного прогона на готовом столе) и тростник
    // на запасные книги: бумагу и книги бот делает сам.
    await cmd('/clear @s minecraft:diamond_sword')
    await cmd('/give @s minecraft:diamond_sword 1')
    await cmd('/give @s minecraft:sugar_cane 9')
    await cmd('/give @s minecraft:leather 3')
    await sleep(500)
    await craft({ item: 'paper', count: 9 })
    const c = await craft({ item: 'book', count: 3 })
    check('(в) запасные книги на переброс скрафтил сам', (inv(c).book || 0) >= 2, brief(c))
    await sleep(600)
    const r: any = await call('enchant', { item: 'diamond_sword' })
    const d = r.detail || {} as Record<string, any>
    const e = (d.enchanted || [])[0] || {} as Record<string, any>
    const JUNK = /^(bane_of_arthropods|knockback)$/
    if (e.skipped) {
      // Честный отказ: после перебросов наверху всё ещё то, что закроет остроту.
      check('(в) отказ только ради остроты', /закроет sharpness/.test(e.skipped), e.skipped)
      check('(в) уровни честно: 33 − перебросы', d.level === 33 - (e.rerolls || 0), `level=${d.level} перебросов=${e.rerolls || 0}`)
    } else {
      check('(в) меч зачарован', !!(e.got && e.got.length), brief(r))
      check('(в) алмазному мечу — верхняя строка (30), не дешёвая', e.cost === 30, `cost=${e.cost}`)
      // Мусор допустим, только если его взяли сознательно: подсказка-мусор
      // наверху, перебрасывать нечем, остроту не закрывает (строка «беру»).
      const knowingly = (d.lines || []).some(l => /ничего не закрывает/.test(l))
      check('(в) не только мусор (или взят сознательно)', !e.got.every(g => JUNK.test(g.name)) || knowingly, (e.got || []).map(g => `${g.name} ${g.level}`).join(', '))
      check('(в) уровни честно: 33 − строка − перебросы', d.level === 33 - e.spentLevels - (e.rerolls || 0), `level=${d.level} строка=${e.slot} перебросов=${e.rerolls || 0}`)
      check('(в) объяснил зачем', Array.isArray(e.why) && e.why.length > 0, (e.why || []).join(' / ').slice(0, 200))
    }
    console.log('     предложения:', (e.offers || []).join(' | '), '→', (e.got || []).map(g => `${g.name} ${g.level}`).join(', '), '|', (d.lines || []).join(' | ').slice(0, 300))
  }

  if (on('г')) {
    const r: any = await call('enchant', { count: 3 })
    const d = r.detail || {} as Record<string, any>
    const bow = (d.enchanted || []).find(x => x.item === 'bow') || {} as Record<string, any>
    const boots = (d.enchanted || []).find(x => x.item === 'diamond_boots') || {} as Record<string, any>
    check('(г) лук зачарован доступной строкой', !!(bow.got && bow.got.length), brief(r))
    check('(г) алмазные ботинки ждут верхнюю строку', !!boots.skipped && boots.need && boots.need.count === 30, boots.skipped || JSON.stringify(boots))
    console.log('     лук:', (bow.offers || []).join(' | '), '→', (bow.got || []).map(g => `${g.name} ${g.level}`).join(', '), '| уровней', d.level)
  }

  if (on('д')) {
    await cmd('/give @s minecraft:iron_block 3')
    await cmd('/give @s minecraft:iron_ingot 4')
    // Свежие вещи, на которые книга может лечь (чары книги — случайные).
    await cmd('/give @s minecraft:iron_sword 1')
    await cmd('/give @s minecraft:iron_chestplate 1')
    await cmd('/give @s minecraft:iron_shovel 1')
    await cmd('/give @s minecraft:sugar_cane 9')
    await cmd('/give @s minecraft:leather 3')
    await cmd('/xp add @s 40 levels')
    await sleep(600)
    await craft({ item: 'paper', count: 9 })
    const c = await craft({ item: 'book', count: 3 })
    check('(д) книги скрафтил сам', (inv(c).book || 0) >= 3, brief(c))
    let r = null
    let books = 0
    for (let i = 0; i < 3; i++) {
      const b: any = await call('enchant', { item: 'book', now: true })
      const be = (((b.detail || {} as Record<string, any>).enchanted) || [])[0] || {} as Record<string, any>
      if (be.got) books++
      console.log('     книга:', (be.got || []).map(g => `${g.name} ${g.level}`).join(', ') || brief(b))
      const eb = inv(b).enchanted_book || 0
      r = await call('enchant', { mode: 'anvil' })
      if (r.status === 'done' && r.detail && r.detail.got) {
        check('(д) книга ушла', (inv(r).enchanted_book || 0) === eb - 1, `было ${eb}, стало ${inv(r).enchanted_book || 0}`)
        break
      }
      console.log('     наковальня:', brief(r))
    }
    check('(д) книга зачарована на столе', books > 0)
    const d = (r && r.detail) || {} as Record<string, any>
    check('(д) наковальня перенесла книгу на вещь', r && r.status === 'done' && Array.isArray(d.got) && d.got.length > 0 && d.cost < 40, brief(r))
  }

  console.log(failures ? `\nПЛОХО: ${failures}` : '\nвсё зелёное')
  ws.close()
  process.exit(failures ? 1 : 0)
}

main().catch(e => { console.error('сцена упала:', e); process.exit(2) })
