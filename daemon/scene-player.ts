'use strict'
// Второй игрок для сцен: обычный mineflayer-клиент, НЕ через демон.
//
// Зачем отдельный клиент, а не команда /summon: всё, что демон должен заметить
// про игрока, приходит пакетами про игрока — вход в tab-list (playerJoined),
// спавн сущности с type: 'player', экипировка в руке, чат и шёпот, удар. Ни
// одна из этих вещей не воспроизводится мобом или командой, а сцена, которая
// проверяет рефлекс на игрока по мобу, проверяет не то.
//
// Оп есть только у NeuroDown, поэтому этот клиент ничего не телепортирует и не
// раздаёт: двигает его сцена операторской командой через демон
// (`cmd('/tp Igrok x y z')`). Здесь только то, что игрок делает руками.
const mineflayer = require('mineflayer')
const cfg = require('./src/config')

const sleep = ms => new Promise<any>(r => setTimeout(r, ms))

// Джойн, доведённый до состояния «в мире»: до 'spawn' у клиента нет ни entity,
// ни bot.players, и любое обращение к ним падает на undefined.
function joinAsPlayer (opts: any = {} as Record<string, any>) {
  const username = opts.username || 'Igrok'
  const host = opts.host || process.env.MC_HOST || cfg.host
  const port = Number(opts.port || process.env.MC_PORT || cfg.port)
  const version = opts.version || process.env.MC_VERSION || cfg.version
  const timeoutMs = opts.timeoutMs || 30000

  return new Promise<any>((resolve, reject) => {
    const bot = mineflayer.createBot({
      host,
      port,
      username,
      version,
      auth: 'offline',
      hideErrors: false
    })

    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { bot.quit('таймаут входа') } catch {}
      reject(new Error(`${username} не вошёл за ${Math.round(timeoutMs / 1000)}с (${host}:${port})`))
    }, timeoutMs)

    const fail = (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err instanceof Error ? err : new Error(String(err)))
    }

    bot.once('error', fail)
    bot.once('kicked', reason => fail(new Error(`${username} выкинут: ${JSON.stringify(reason)}`)))

    bot.once('spawn', async () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Сервер досылает tab-list и экипировку отдельными пакетами уже после
      // спавна; секунда — чтобы сцена, которая сразу спрашивает bot.players,
      // не увидела пустой мир.
      await sleep(1000)
      resolve(makeHandle(bot, username))
    })
  })
}

function makeHandle (bot, username) {
  let gaze = null

  // Кого мы вообще видим. Игрок вне прогруженного радиуса есть в tab-list, но
  // сущности у него нет — бить и смотреть не на что.
  const entityOf = (name) => {
    const rec = bot.players[name]
    const ent = rec && rec.entity
    if (!ent || !ent.position) throw new Error(`${username} не видит ${name} рядом`)
    return ent
  }

  const eyes = (ent) => ent.position.offset(0, (ent.height || 1.8) * 0.9, 0)

  const handle = {
    name: username,
    // Сырой клиент: сцене иногда нужно то, чего нет в этом наборе.
    bot,

    get entity () { return bot.entity },
    get health () { return bot.health },

    // Чат виден всем, включая демон: session.js:150 превращает его в
    // прерывающее событие 'chat'.
    async say (text) {
      bot.chat(String(text).slice(0, 250))
      await sleep(700) // пакет чата и ответ сервера идут врозь
      return { said: text }
    },

    // Личное сообщение. /tell доступен игроку без опа, а демон слушает его
    // отдельным обработчиком (session.js:158) и помечает whisper: true.
    async whisper (to, text) {
      bot.whisper(to, String(text).slice(0, 250))
      await sleep(700)
      return { whispered: text, to }
    },

    // Удар кулаком. Дальность на сервере ~3 блока: если сцена не подвела
    // игрока вплотную, честнее упасть с внятным текстом, чем молча промазать —
    // непрошедший удар превратил бы проверку «бот не ответил» в проверку
    // «никто никого не трогал».
    async hit (name) {
      const ent = entityOf(name)
      const dist = ent.position.distanceTo(bot.entity.position)
      if (dist > 3.5) throw new Error(`${name} в ${dist.toFixed(1)} блоках — рукой не достать, подведи игрока ближе`)
      await bot.lookAt(eyes(ent), true)
      bot.attack(ent)
      bot.swingArm('right')
      await sleep(600)
      return { hit: name, dist: Math.round(dist * 10) / 10 }
    },

    // Держать взгляд, а не мигнуть им: один lookAt виден только в тот тик, в
    // который он случился, и сцена, которая проверяет реакцию на взгляд, между
    // своими шагами увидела бы отвернувшегося игрока. stare(null) отпускает.
    async stare (name) {
      if (gaze) { clearInterval(gaze); gaze = null }
      if (!name) return { staring: null }
      const ent = entityOf(name)
      await bot.lookAt(eyes(ent), true)
      gaze = setInterval(() => {
        try {
          const live = bot.players[name] && bot.players[name].entity
          if (live && live.position) bot.lookAt(eyes(live), true)
        } catch {}
      }, 250)
      return { staring: name }
    },

    // Что этот клиент видит про чужого игрока — независимая от демона проверка
    // того же факта: yaw чужого тела приезжает пакетами поворота, так что «он
    // повернулся ко мне» можно подтвердить со стороны, а не только по его же
    // словам.
    sees (name) {
      const rec = bot.players[name]
      const ent = rec && rec.entity
      if (!ent || !ent.position) return null
      return {
        name,
        dist: Math.round(ent.position.distanceTo(bot.entity.position) * 10) / 10,
        pos: { x: ent.position.x, y: ent.position.y, z: ent.position.z },
        yaw: Math.round(((ent.yaw * 180 / Math.PI) % 360 + 360) % 360)
      }
    },

    async leave () {
      if (gaze) { clearInterval(gaze); gaze = null }
      const gone = new Promise<any>(resolve => bot.once('end', resolve))
      try { bot.quit('сцена закончена') } catch {}
      // Без ожидания 'end' следующая сцена входит тем же именем, пока сервер
      // ещё держит старую сессию, и получает «уже играет».
      await Promise.race([gone, sleep(5000)])
      await sleep(500)
      return { left: username }
    }
  }

  return handle
}

module.exports = { joinAsPlayer }
