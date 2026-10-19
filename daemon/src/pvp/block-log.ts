'use strict'
// Блоки в бою (S7d, пункт G пользователя): кто, что и как ставил и ломал за дуэль. Один перехват на всех
// исполнителей — bot._genericPlace (через него ставят build.placeBlockAt, fortify, crystal, clutch, мосты, столбы) и
// bot.dig; приём — по кадру стека (файл и функция вызвавшего), успех — подтверждение сервера (blockUpdate в клетке
// за 400 мс; копка — без исключения и блок исчез), время — от вызова до подтверждения. Ошибки: «поставил не туда»
// (сервер не подтвердил). errors.ownSupport — старый счётчик попыток подкопа; новый supportDig отделяет намерение и итог.
import * as gameClock from '../game-clock'

const r1 = (x) => Math.round(x * 10) / 10

// Приём по кадрам стека: [файл, функция] → метка.
const RULES: [RegExp, string][] = [
  [/wallToward/, 'стенка от стрелка'], [/coverFrom/, 'укрытие (колонна)'], [/pillarOut|towerUp/, 'столб вверх'],
  [/dropFromPerch/, 'спуск по своей опоре'],
  [/fortOut|boxIn|patch/, 'коробка'], [/breakOut|siege/, 'вскрыть коробку'], [/bridge/, 'мост'],
  [/towerShield/, 'заслон на подъёме'], [/climbOut|climbBack/, 'подъём/ступени'], [/punchThrough|unblockPath/, 'пробить проход'],
  [/digWatch/, 'прорубить стену/укрытие к нему'], [/useOnGroundAt/, 'вода/лава ведром'],
  [/blockIn/, 'ловушка: коробка 1×2'], [/dropAnvil|anvil/i, 'наковальня'], [/clutch|mlg/i, 'клатч (под ноги в падении)'],
  [/wallSpot|wall\b|guardFor|guard/, 'заслон от взрыва'], [/surround/, 'обсидиан вокруг ног'], [/obby/, 'обсидиан под кристалл'],
  [/combatHop|parkour/, 'ступенька для прыжка'], [/webPlan|cobweb|web/i, 'паутина'], [/lava/i, 'лава ведром']
]
function tagOf (stack, item) {
  const frames = String(stack || '').split('\n').slice(2).filter(f => !/node_modules|block-log\.js|<anonymous>|new Promise/.test(f))
  const text = frames.slice(0, 8).join(' ')
  if (item === 'end_crystal') return 'кристалл'
  if (item === 'respawn_anchor') return 'якорь'
  if (item === 'glowstone') return /guard/.test(text) ? 'заслон от якоря (светокамень)' : 'заряд якоря'
  if (item === 'cobweb') return 'паутина'
  for (const [re, k] of RULES) if (re.test(text)) return k
  // Копает сам pathfinder (кадры только из node_modules): путь «насквозь» — спуск со столба, проход сквозь стенку.
  if (!frames.length && /mineflayer-pathfinder/.test(String(stack || ''))) return 'путь (копает pathfinder)'
  // Неизвестный приём — первые кадры «функция@файл:строка» (по ним видно, кто копал/ставил).
  const fr = frames.slice(0, 3).map(f => { const m = /at (?:async )?(?:([\w.$<>]+) )?\(?.*?([\w-]+)\.js:(\d+)/.exec(f); return m ? `${m[1] || '?'}@${m[2]}:${m[3]}` : null }).filter(Boolean)
  return fr.length ? 'прочее: ' + fr.join(' < ') : 'прочее'
}

function install (bot) {
  const out = { place: {}, dig: {}, supportDig: {}, items: {}, errors: { notConfirmed: 0, ownSupport: 0 } }
  const add = (map, k, ok, ms) => {
    const e = map[k] || (map[k] = { n: 0, ok: 0, ms: 0 })
    e.n++
    if (ok) { e.ok++; e.ms = r1(e.ms + ms) }
  }
  const origPlace = bot._genericPlace
  const origDig = bot.dig
  let myPlace = null; let myDig = null
  if (typeof origPlace === 'function') {
    bot._genericPlace = myPlace = function (ref, face, opts) {
      const t0 = gameClock.now()
      const item = bot.heldItem ? bot.heldItem.name : null
      const hint = bot._ndBlockTag
      const tag = hint && gameClock.wall.now() - hint.at < 3000 ? hint.what : tagOf(new Error().stack, item)
      let cell = null
      // Клик по якорю (заряд светокамнем / подрыв) меняет сам якорь, а не соседнюю клетку.
      const onAnchor = !!(ref && ref.name === 'respawn_anchor')
      try { cell = onAnchor ? ref.position : ref.position.plus(face) } catch {}
      // Ставится ли блок: предмет в руке — блок по реестру (меч/ведро/кристалл — нет), или заряд якоря.
      const isBlockItem = !!(item && bot.registry && bot.registry.blocksByName && bot.registry.blocksByName[item])
      const block = onAnchor ? item === 'glowstone' : isBlockItem && !/end_crystal|bucket|firework|potion|egg|pearl|boat|minecart/.test(item)
      if (item) out.items[item] = (out.items[item] || 0) + 1
      if (onAnchor && cell) {
        // Клик по якорю: заряд (светокамень — меняется состояние) или подрыв (клетка пустеет) — S7d: подрывы
        // считались неудачным «зарядом» (133/378).
        const charge = item === 'glowstone' ? 'заряд якоря' : 'подрыв якоря'
        const st0 = ref.stateId
        let done = false
        const onUpd = (oldB, newB) => {
          if (done || !newB || !newB.position || !newB.position.equals(cell)) return
          const gone = newB.name !== 'respawn_anchor'
          if (!gone && newB.stateId === st0) return
          done = true
          bot.removeListener('blockUpdate', onUpd)
          add(out.place, gone ? 'подрыв якоря' : charge, true, gameClock.now() - t0)
        }
        bot.on('blockUpdate', onUpd)
        gameClock.setTimeout(() => {
          if (done) return
          done = true
          bot.removeListener('blockUpdate', onUpd)
          let b = null
          try { b = bot.blockAt(cell, false) } catch {}
          const gone = !b || b.name !== 'respawn_anchor'
          add(out.place, gone ? 'подрыв якоря' : charge, gone, gameClock.now() - t0)
          if (!gone) out.errors.notConfirmed++
        }, 400)
      } else if (block && cell) {
        let done = false
        const onUpd = (oldB, newB) => {
          if (done || !newB || !newB.position || !newB.position.equals(cell)) return
          if (newB.name === 'air' || newB.name === 'cave_air') return
          if (onAnchor && oldB && newB.stateId === oldB.stateId) return
          done = true
          bot.removeListener('blockUpdate', onUpd)
          add(out.place, tag, true, gameClock.now() - t0)
        }
        bot.on('blockUpdate', onUpd)
        gameClock.setTimeout(() => {
          if (done) return
          done = true
          bot.removeListener('blockUpdate', onUpd)
          // Уже стоял такой блок (сервер не прислал обновление) — не ошибка.
          let b = null
          try { b = bot.blockAt(cell, false) } catch {}
          const there = !!(b && b.name !== 'air' && b.boundingBox === 'block')
          add(out.place, tag, there, gameClock.now() - t0)
          if (!there) out.errors.notConfirmed++
        }, 400)
      } else add(out.place, tag, true, 0)
      return origPlace.apply(this, arguments)
    }
  }
  if (typeof origDig === 'function') {
    bot.dig = myDig = async function (block, ...rest) {
      const t0 = gameClock.now()
      const hint = bot._ndBlockTag
      const tagged = hint && gameClock.wall.now() - hint.at < 3000 && (!hint.cell || block?.position?.equals(hint.cell))
      const tag = tagged ? hint.what : tagOf(new Error().stack, null)
      const begin = (map, key) => {
        const row = map[key] || (map[key] = { n: 0, ok: 0, ms: 0, failed: 0, pending: 0, unconfirmed: 0 })
        row.n++; row.pending++
        return row
      }
      const entries = [begin(out.dig, tag)]
      try {
        const me = bot.entity
        if (me && me.onGround && block && block.position) {
          const f = me.position.floored()
          if (block.position.x === f.x && block.position.z === f.z && block.position.y === f.y - 1) {
            out.errors.ownSupport++
            entries.push(begin(out.supportDig, tagged && hint.intent === 'perch-descent' ? 'perch-descent' : 'unclassified'))
          }
        }
      } catch {}
      let ok = false, returned = false
      try {
        const r = await origDig.call(this, block, ...rest)
        returned = true
        let b = null
        try { b = bot.blockAt(block.position, false) } catch {}
        ok = !!b && b.boundingBox === 'empty'
        return r
      } finally {
        for (const row of entries) {
          row.pending--
          if (ok) { row.ok++; row.ms = r1(row.ms + gameClock.now() - t0) }
          else if (returned) row.unconfirmed++
          else row.failed++
        }
      }
    }
  }
  return {
    report () {
      const any = Object.keys(out.place).length || Object.keys(out.dig).length
      if (!any) return undefined
      const avg = (m) => { const o = {}; for (const [k, e] of Object.entries<any>(m)) o[k] = { ...e, ms: e.ok ? Math.round(e.ms / e.ok) : null }; return o }
      return { place: avg(out.place), dig: avg(out.dig), supportDig: avg(out.supportDig), items: { ...out.items }, errors: { ...out.errors } }
    },
    close () {
      // Сверху мог встать чужой перехватчик — тогда не снимаем (он держит ссылку на наш).
      if (myPlace && bot._genericPlace === myPlace) bot._genericPlace = origPlace
      if (myDig && bot.dig === myDig) bot.dig = origDig
    }
  }
}

export { install, tagOf }
