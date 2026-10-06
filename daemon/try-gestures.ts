'use strict'
const gameClock = require('./src/game-clock')
// Жесты человека и ответ телом (src/gestures.js): присед, долгий взгляд,
// прыжки на месте, брошенная вещь, взмах рукой, указание взглядом на блок.
//
// Человек — настоящий клиент (scene-player.js, ник Igrok): присед, поворот
// головы и выброс предмета приходят демону пакетами про игрока, и сцена,
// которая изображала бы их командой, проверяла бы не то.
//
// Каждый жест проверяется тем же путём, каким его увидит мозг: wait(20),
// позванный ДО жеста, должен оборваться событием gesture нужного вида (а не
// досидеть до конца), и тело должно ответить так, чтобы это увидел человек —
// со стороны его клиента (присел в ответ, повернул голову, подобрал вещь).
//
// Мирная сложность на время сцены: удар моба — 'damage', тоже прерывание, и
// он ломает замер «что разбудило wait». В конце — обратно normal.
const WebSocket = require('ws')
const Vec3 = require('vec3')
const { joinAsPlayer } = require('./scene-player')

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
async function cmd (text) { await call('say', { text }); await sleep(500) }

let failures = 0
function check (label, ok, note = '') {
  if (!ok) failures++
  console.log(`  ${ok ? '[ OK ]' : '[ПЛОХО]'} ${label}${note ? ' — ' + note : ''}`)
}

const X = 1600
const Y = 100
const Z = 1600
const ME = 'NeuroDown'

// wait, оборванный жестом: позвать до жеста, жест, дождаться ответа.
async function waitFor (kind, doGesture, seconds = 15) {
  const t0 = gameClock.now()
  const waiting = call('wait', { seconds })
  await sleep(300)
  await doGesture()
  const r: any = await waiting
  const ms = gameClock.now() - t0
  const by = r.by && r.by.type === 'gesture' ? r.by : null
  const all = [by, ...(r.events || []).filter(e => e.type === 'gesture' || e.type === 'picked_up')].filter(Boolean)
  return { r, ms, by, all, hit: all.find(e => e.kind === kind) }
}

// Настроение без мира: друг приходит охотнее незнакомца, враг — реже всех,
// спам зовом снижает шанс.
function moodChecks () {
  const { Mood } = require('./src/mood')
  const fake = { bot: { health: 20, food: 20 } }
  const m = new Mood(fake, null)
  m.bump('Friend', 'подарок', 30, 10)
  m.bump('Enemy', 'ударил', -30, 0)
  const chance = (n) => { const r = m.decideCome(n, { dist: 10 }); m.person(n).calls = []; return r.chance }
  const f = chance('Friend')
  const s = chance('Stranger')
  const e = chance('Enemy')
  check('(0) друг > незнакомец > враг', f > s && s > e, `шанс ${f} / ${s} / ${e}`)
  const seq = [1, 2, 3, 4, 5].map(() => m.decideCome('Stranger', { dist: 10 }).chance)
  check('(0) спам зовом снижает шанс', seq[4] < seq[0], seq.join(' → '))
  fake.bot.health = 5
  m.person('Friend').calls = []
  const hurt = m.decideCome('Friend', { dist: 10 })
  check('(0) раненый сам — идёт неохотнее', hurt.chance < f, `${hurt.chance}: ${hurt.why}`)
}

async function main () {
  moodChecks()
  await new Promise<any>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  try { await call('connect') } catch (e) { console.log('connect:', e.message) }
  await sleep(2000)

  console.log('сцена: площадка, мирный режим, Igrok напротив')
  await cmd('/difficulty peaceful')
  // Сначала сам туда: /fill по незагруженным чанкам молча не делает ничего
  // (первый прогон так и упал в океан с высоты 100).
  await cmd(`/tp @s ${X + 0.5} ${Y + 2} ${Z + 0.5} 0 0`)
  await cmd(`/effect give @s minecraft:slow_falling 5 0 true`)
  await sleep(3000)
  await cmd(`/fill ${X - 16} ${Y - 1} ${Z - 16} ${X + 16} ${Y - 1} ${Z + 16} minecraft:smooth_stone`)
  await cmd(`/fill ${X - 16} ${Y} ${Z - 16} ${X + 16} ${Y + 5} ${Z + 16} minecraft:air`)
  await cmd(`/setblock ${X + 5} ${Y} ${Z + 5} minecraft:gold_block`)
  await cmd('/clear @s')
  await cmd(`/tp @s ${X + 0.5} ${Y} ${Z + 0.5} 0 0`)

  const igrok = await joinAsPlayer({ username: 'Igrok' })
  const ib = igrok.bot
  // Лицом ОТ бота: взгляд в упор с порога засчитался бы до первой проверки.
  await cmd(`/tp Igrok ${X + 0.5} ${Y} ${Z + 3.5} 0 0`)
  await cmd('/clear Igrok')
  await cmd('/give Igrok minecraft:bread 5')
  await sleep(1500)
  // Сброс накопленного: ответы выше выгребли шину, но подход Igrok'а мог
  // прилететь позже.
  await call('status')
  const meEnt = () => ib.players[ME] && ib.players[ME].entity

  // (а) Присед передо мной, глядя в глаза.
  {
    let crouchedBack = 0
    const onCrouch = (e) => { if (e === meEnt()) crouchedBack++ }
    ib.on('entityCrouch', onCrouch)
    await igrok.stare(ME)
    const res = await waitFor('присед', async () => {
      for (let i = 0; i < 3; i++) {
        ib.setControlState('sneak', true); await sleep(180)
        ib.setControlState('sneak', false); await sleep(180)
      }
    })
    await sleep(1500)
    ib.removeListener('entityCrouch', onCrouch)
    await igrok.stare(null)
    await ib.lookAt(new Vec3(X - 20, Y + 1.6, Z + 3.5), true)
    check('(а) присед будит wait', !!res.hit && res.ms < 6000, res.hit ? `${res.ms} мс: ${res.hit.text}` : `пришло: ${JSON.stringify(res.all.map(e => e.kind))}, ${res.ms} мс`)
    check('(а) бот присел в ответ (видно клиенту Igrok)', crouchedBack >= 2, `приседов бота: ${crouchedBack}`)
  }
  await sleep(6000)

  // (б) Долгий взгляд в упор. Сначала развернуть бота от Igrok'а, чтобы
  // поворот головы в ответ было видно.
  {
    await call('look_at', { x: X + 0.5, y: Y + 1.6, z: Z - 10 })
    await igrok.stare(ME)
    const res: any = await waitFor('смотрит', async () => { await sleep(100) })
    await sleep(800)
    const me = meEnt()
    let facing = null
    if (me) {
      const dx = ib.entity.position.x - me.position.x
      const dz = ib.entity.position.z - me.position.z
      const want = Math.atan2(-dx, -dz)
      let err = want - (typeof me.headYaw === 'number' ? me.headYaw : me.yaw)
      while (err > Math.PI) err -= 2 * Math.PI
      while (err < -Math.PI) err += 2 * Math.PI
      facing = Math.round(Math.abs(err) * 180 / Math.PI)
    }
    await igrok.stare(null)
    check('(б) долгий взгляд будит wait', !!res.hit, res.hit ? `${res.ms} мс: ${res.hit.text}` : `пришло: ${JSON.stringify(res.all.map(e => e.kind))}, wait ${res.r.status} за ${res.ms} мс, by=${JSON.stringify(res.r.by || null).slice(0, 120)}`)
    check('(б) бот посмотрел в ответ', facing !== null && facing < 25, `угол до Igrok ${facing}°`)
  }

  // (в) Отвёл глаза — жестов нет: 4 секунды смотрит в сторону.
  {
    await ib.lookAt(new Vec3(X + 0.5, Y + 1.6, Z + 20), true)
    const r: any = await call('wait', { seconds: 4 })
    const g = [r.by, ...(r.events || [])].filter(e => e && e.type === 'gesture')
    check('(в) взгляд в сторону — не жест', g.length === 0 && r.status === 'done', g.length ? JSON.stringify(g.map(e => e.kind)) : `wait ${r.status}`)
  }

  // (г) Прыжки на месте, глядя на бота.
  {
    await igrok.stare(ME)
    const res = await waitFor('прыгает', async () => {
      for (let i = 0; i < 3; i++) {
        ib.setControlState('jump', true); await sleep(150)
        ib.setControlState('jump', false); await sleep(650)
      }
    })
    await igrok.stare(null)
    check('(г) прыжки на месте будят wait', !!res.hit, res.hit ? `${res.ms} мс: ${res.hit.text}` : `пришло: ${JSON.stringify(res.all.map(e => e.kind))}`)
  }
  await sleep(6000)

  // (д) Кинул хлеб — бот понял, что это ему, и подобрал.
  {
    await igrok.stare(ME)
    await sleep(400)
    const bread = ib.inventory.items().find(i => i.name === 'bread')
    const res = await waitFor('кинул мне', async () => {
      if (bread) await ib.toss(bread.type, null, bread.count)
    })
    await igrok.stare(null)
    let got = 0
    for (let i = 0; i < 20 && got < 5; i++) {
      await sleep(500)
      const s: any = await call('status')
      got = (s.state && s.state.inventory && s.state.inventory.bread) || 0
    }
    check('(д) бросок ему будит wait', !!res.hit, res.hit ? `${res.ms} мс: ${res.hit.text}` : `пришло: ${JSON.stringify(res.all.map(e => e.kind))}`)
    check('(д) подобрал весь хлеб', got >= 5, `bread в рюкзаке: ${got}`)
  }

  // (е) Указал взглядом на золотой блок — mc_players знает, на что.
  {
    await cmd(`/tp Igrok ${X + 0.5} ${Y} ${Z + 3.5}`)
    await ib.lookAt(new Vec3(X + 5.5, Y + 0.5, Z + 5.5), true)
    await sleep(2800)
    const pl = ((await call('players', {} as Record<string, any>)) as any).detail || {} as Record<string, any>
    const p = (pl.players || []).find(x => x.name === 'Igrok')
    const pt = p && (p.pointed || p.gaze)
    check('(е) видит, на что указал игрок', !!pt && pt.block === 'gold_block' && pt.x === X + 5 && pt.z === Z + 5,
      pt ? `${pt.block} ${pt.x},${pt.y},${pt.z}; «${pl.text}»` : JSON.stringify(p))
  }

  // (ж) Машет рукой в бота без удара.
  {
    await igrok.stare(ME)
    const res = await waitFor('машет', async () => {
      for (let i = 0; i < 3; i++) { ib.swingArm('right'); await sleep(300) }
    })
    await igrok.stare(null)
    check('(ж) взмахи в сторону бота будят wait', !!res.hit, res.hit ? `${res.ms} мс: ${res.hit.text}` : `пришло: ${JSON.stringify(res.all.map(e => e.kind))}`)
  }

  // (и) Зов издалека: «иди сюда, смотри», глядя на золотой блок, — бот
  // прибегает и смотрит туда же.
  {
    await cmd(`/tp @s ${X - 8.5} ${Y} ${Z - 8.5}`)
    await cmd(`/tp Igrok ${X + 3.5} ${Y} ${Z + 3.5}`)
    await sleep(1200)
    await ib.lookAt(new Vec3(X + 5.5, Y + 0.5, Z + 5.5), true)
    await call('status')
    const t0 = gameClock.now()
    // Зов — дело случая (настроение), как у живого: не пошёл с первого раза —
    // позвать ещё раз, второй зов настойчивее.
    let arrived = null
    let summon = null
    for (let attempt = 0; attempt < 2 && !arrived; attempt++) {
      summon = null
      await igrok.say(attempt ? 'ну иди сюда, ну' : 'иди сюда, смотри что нашёл')
      for (let i = 0; i < 40 && !arrived; i++) {
        const r: any = await call('wait', { seconds: 2 })
        const evs = [r.by, ...(r.events || [])].filter(Boolean)
        summon = summon || evs.find(e => e.type === 'summon')
        arrived = evs.find(e => e.type === 'gesture' && e.kind === 'пришёл')
        if (summon && summon.come === false) break
      }
    }
    check('(и) решил идти на зов', !!summon && summon.come !== false, summon ? summon.text : 'события summon нет')
    check('(и) прибежал и смотрит, что показывают', !!arrived && arrived.block === 'gold_block',
      arrived ? `${Math.round((gameClock.now() - t0) / 1000)} с: ${arrived.text}` : 'не пришёл')
  }

  // (з) Друга бьёт зомби — бот вступается и видит его хп.
  {
    await cmd(`/tp @s ${X + 0.5} ${Y} ${Z + 0.5}`)
    await cmd('/difficulty normal')
    await cmd('/give @s minecraft:iron_sword')
    await cmd(`/tp Igrok ${X + 0.5} ${Y} ${Z + 6.5}`)
    await ib.lookAt(new Vec3(X + 0.5, Y + 1.6, Z + 20), true)
    await sleep(800)
    await call('status')
    const t0 = gameClock.now()
    const waiting = call('wait', { seconds: 25 })
    await sleep(300)
    await cmd(`/summon minecraft:zombie ${X + 0.5} ${Y} ${Z + 8.5} {PersistenceRequired:1b}`)
    const r: any = await waiting
    const ev = [r.by, ...(r.events || [])].find(e => e && e.type === 'friend_hurt')
    check('(з) удар по другу будит wait', !!ev, ev ? `${gameClock.now() - t0} мс: ${ev.text}` : `wait ${r.status} by ${JSON.stringify(r.by || null).slice(0, 100)}: ${JSON.stringify((r.events || []).map(e => e.type))}`)
    check('(з) видно его хп', !!ev && typeof ev.hp === 'number', ev ? `hp ${ev.hp}` : '')
    let done = null
    for (let i = 0; i < 40 && !done; i++) {
      await sleep(500)
      const s2: any = await call('status')
      done = (s2.events || []).find(e => e.type === 'defended')
    }
    check('(з) отбил друга от зомби', !!done && /отбил/.test(done.text), done ? done.text : 'события defended нет за 20 с')
    await cmd('/kill @e[type=minecraft:zombie,distance=..30]')
  }

  await cmd('/difficulty normal')
  ib.quit()
  console.log(failures ? `\nПЛОХО: ${failures}` : '\nвсё зелёное')
  ws.close()
  process.exit(failures ? 1 : 0)
}

main().catch(e => { console.error('сцена упала:', e); process.exit(2) })
