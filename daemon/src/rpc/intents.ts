'use strict'
// RPC демона — тонкие привязки к навыкам сессии (интенты).
// Фабрика методов над контекстом демона (rpc/context.ts); обработчики перенесены из src/index.ts.
import type { RpcContext } from './context'

function intentMethods ({ session, bus, vision }: RpcContext) {
  return {
    connect: async (p) => {
      const r = await session.connect(p || {})
      // Same envelope as every other method so the brain reads one shape.
      return { status: 'done', detail: r.already ? { already: true } : { joined: true }, events: bus.drain(), state: session.state() }
    },
    disconnect: async (p) => { await vision.close(); return session.disconnect(p && p.reason) },
    say: async (p) => session.say(p.text, p.to),
    goto: async (p) => session.goto(p),
    flight_route: async (p) => session.flightRoute(p || {}),
    boat_hop: async (p) => session.boatHop(p || {}),
    boat_climb: async (p) => session.boatClimb(p || {}),
    parkour: async (p) => session.parkour(p || {}),
    follow: async (p) => session.follow(p),
    escort: async (p) => session.escort(p || {}),
    give: async (p) => session.giveItem(p || {}),
    take: async (p) => session.takeItem(p || {}),
    // Спасение на элитрах (rescue) стоп драйвера не рвёт: тревога «человек рядом» глушила полёт из пропасти.
    stop: async () => (session.current?.name === 'fly_to' && session.current?.params?.rescue && !session.current.ctl?.aborted) ? { status: 'done', detail: { ignored: 'спасаюсь на элитрах' } } : session.stop(),
    wait: async (p) => session.wait(p || {}),
    look_at: async (p) => session.lookAt(p),
    observe: async (p) => session.observe(p || {}),
    players: async (p) => session.players(p || {}),
    mine: async (p) => session.mine(p || {}),
    explore: async (p) => session.explore(p || {}),
    dig_down: async (p) => session.digDown(p || {}),
    craft: async (p) => session.craft(p || {}),
    place: async (p) => session.place(p || {}),
    // S8: кремень из гравия рюкзака на месте — поставить у ног и сломать до удачи (src/flint-grind.ts).
    flint_grind: async (p) => session.runIntent('flint_grind', ctl => { session.require(); return require('../flint-grind').flintGrind(session, ctl, p || {}) },
      { timeoutMs: (Math.min(300, (p && p.timeoutSeconds) ?? 90) + 15) * 1000, interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected'], params: p || {} }),
    fight: async (p) => session.fight(p || {}),
    temper: async (p) => session.setTemper(p || {}),
    play_mode: async (p) => session.setPlayMode(p || {}),
    flee: async (p) => session.flee(p || {}),
    stronghold: async (p) => session.stronghold(p || {}),
    bucket: async (p) => session.bucket(p || {}),
    obsidian: async (p) => session.obsidian(p || {}),
    pack: async (p) => session.pack(p || {}),
    cache: async (p) => session.cache(p || {}),
    animals: async (p) => session.animals(p || {}),
    golem: async (p) => session.golem(p || {}),
    // Шерсть на кровать (поток route, 03.10; fauna.wool): стадо одного цвета на виду (или по карте x,z) — убить или
    // остричь до count шерсти этого цвета.
    wool: async (p: any = {}) => session.runIntent('wool', ctl => {
      session.require()
      session.updateMovements()
      return require('../fauna').wool(session, ctl, p || {})
    }, { timeoutMs: (Math.min(240, Number(p && p.timeoutSeconds) || 90) + 20) * 1000, params: p, interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected'] }),
    trade: async (p) => session.trade(p || {}),
    blaze: async (p) => session.blaze(p || {}),
    fortress: async (p) => session.fortress(p || {}),
    pearls: async (p) => session.pearls(p || {}),
    bastion: async (p) => session.bastion(p || {}),
    nether_tunnel: async (p) => session.netherTunnel(p || {}),
    // Поток nether-end: закопаться в толщу (bastion.burrowIntent) — штрек по Аду с открытого места не начинается.
    ne_burrow: async (p) => session.runIntent('ne_burrow', ctl => require('../bastion').burrowIntent(session, ctl, p || {}), { timeoutMs: 60000, params: p || {}, interruptOn: ['chat', 'death', 'kicked', 'disconnected'] }),
    // Поток S2 (06.10): загон пиглинов «люк за окном» из ямы со ртом (bastion/pen-trap.penIntent: mode pen|pit, timeoutSeconds, pearls, want, lanes).
    pen: async (p) => session.runIntent('pen', ctl => { session.require(); return require('../bastion/pen-trap').penIntent(session, ctl, p || {}) }, { timeoutMs: (Math.min(1200, Number(p && p.timeoutSeconds) || 240) + 40) * 1000, params: p || {}, interruptOn: ['chat', 'death', 'kicked', 'disconnected'] }),
    // Поток nether (03.10): ход по Аду по сетке копии мира (nether-route.routeTo: {x,y,z,r,dy,timeoutSeconds}).
    ne_route: async (p) => { p = p || {}; const s = Math.min(1500, Number(p.timeoutSeconds) || 600); return session.runIntent('ne_route', async ctl => { session.updateMovements(); return require('../nether-route').routeTo(session, ctl, { ...p, timeoutSeconds: s }) }, { timeoutMs: (s + 20) * 1000, params: p, interruptOn: ['chat', 'death', 'kicked', 'disconnected'] }) },
    // Поток unstuck: лестница выхода из застревания здесь и сейчас (unstuck.freeHere; {x,y,z} — куда надо, необязательно).
    unstuck: async (p) => session.runIntent('unstuck', ctl => require('../unstuck').freeHere(session, ctl, { toward: p && p.x != null && p.z != null ? new (require('vec3'))(Number(p.x) + 0.5, p.y != null ? Number(p.y) : session.bot.entity.position.y, Number(p.z) + 0.5) : null }), { timeoutMs: 45000, params: p || {}, interruptOn: ['chat', 'death', 'kicked', 'disconnected'] }),
    dragon: async (p) => session.dragon(p || {}),
    shoot: async (p) => session.shoot(p || {}),
    throw: async (p) => session.throwTest(p || {}),
    prep: async (p) => session.prep(p || {}),
    // Зачарование, зелья, сборы в поход (enchant.js, brew.js, fightkit.js).
    enchant: async (p) => session.enchant(p || {}),
    brew: async (p) => session.brew(p || {}),
    kit: async (p) => session.kit(p || {}),
    loot: async (p) => session.loot(p || {}),
    // Постройки игры: scan | list | where | plan | forget | explore | loot (structures.js).
    structure: async (p) => session.structure(p || {}),
    // Автолут сундуков автопилотом (autopilot.lootIfSeen): {enabled:false} — выключить (арена «гонки вооружений»,
    // s7: бот брал сундуки сам, мимо графа, и при 750 TPS скан каждые 5 игровых с жёг процессор).
    auto_loot: async (p) => session.immediate(async () => { session.lootAuto = !(p && p.enabled === false); return { lootAuto: session.lootAuto } }),
    // Бутылки опыта под ноги — уровни для стола зачарований (pvp/xp-bottles, гонка вооружений s7).
    xp_bottles: async (p) => session.runIntent('xp_bottles', ctl => { session.require(); return require('../pvp/xp-bottles').drink(session, ctl, p || {}) },
      { timeoutMs: 30000, interruptOn: ['death', 'kicked', 'disconnected'] }),
    tunnel: async (p) => session.tunnel(p || {}),
    mine_seen: async (p) => session.mineSeen(p || {}),
    smelt: async (p) => session.smelt(p || {}),
    furnace_take: async (p) => session.furnaceTake(p || {}),
    chest_put: async (p) => session.chestPut(p || {}),
    chest_take: async (p) => session.chestTake(p || {}),
    chest_list: async (p) => session.chestList(p || {}),
    base: async (p) => session.base(p || {}),
    stash: async (p) => session.stash(p || {}),
    armor: async (p) => session.wearBestArmor(p || {}),
    shelter: async (p) => session.shelter(p || {}),
    // Аварийный отход (survival.refuge, research/05-synthesis.md F.5): оценить
    // место, коробка у стены / нора / замкнутый карман / бегство, внутри — еда
    // и зелья до minHp, выход. Урон и low_health его не рвут — только чат и
    // смерть. Через runIntent прямо здесь (survival.runRefuge): тот же запуск
    // зовёт автопилот на EMERGENCY.
    refuge: async (p) => require('../survival').runRefuge(session, p || {}),
    surface: async (p) => session.surface(p || {}),
    recover: async (p) => session.recoverLoot(p || {}),
    portal: async (p) => session.portal(p || {}),
    // Природная лава для портала (portal-natural.js, агент G): survey/order — только чтение; run — ND_PORTAL_NATURAL=1.
    portal_natural: async (p) => require('../portal-natural').rpc(session, p || {}),
    build: async (p) => session.build(p || {}),
    sort: async (p) => session.sortStorage(p || {}),
    sign: async (p) => session.writeSign(p || {}),
    farm: async (p) => session.farm(p || {}),
    ride: async (p) => session.ride(p || {}),
    mechanism: async (p) => session.mechanism(p || {}),
    sleep: async (p) => session.sleepInBed(p || {}),
    wake: async () => session.wakeUp(),
    equip: async (p) => session.equipItem(p || {}),
    eat: async (p) => session.eat(p || {}),
    drop: async (p) => session.dropItem(p || {}),
    set_goal: async (p) => session.setGoal(p),
    remember: async (p) => session.remember(p),
    recall: async (p) => session.recall(p || {})
  }
}

export { intentMethods }
