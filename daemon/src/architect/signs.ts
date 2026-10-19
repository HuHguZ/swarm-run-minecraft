'use strict'
import * as gameClock from '../game-clock'
import * as bp from '../blueprint'
import { sleep } from './world'

// ---------------------------------------------------------------- signs

// Редактор таблички сервер открывает сам сразу после постановки (Paper:
// SignItem запоминает openSign, потом SignBlock.openTextEdit ставит
// playerWhoMayEdit = мы и шлёт open_sign_editor). Пакет прилетает сразу за
// блоком, поэтому ухо ставится ДО клика. updateSignText на сервере пустит
// текст только от того, кто в playerWhoMayEdit (байткод SignBlockEntity).
function onceSignEditor (bot, ms) {
  let settle
  let timer = null
  const p: any = new Promise<any>(resolve => { settle = resolve })
  const on = packet => { cleanup(); settle(packet) }
  const cleanup = () => { gameClock.clearTimeout(timer); bot._client.removeListener('open_sign_entity', on) }
  bot._client.on('open_sign_entity', on)
  timer = gameClock.setTimeout(() => { cleanup(); settle(null) }, ms)
  p.cancel = () => { cleanup(); settle(null) }
  return p
}

function signText (bot, pos) {
  const b = bot.blockAt(pos)
  if (!b || !/_sign$/.test(b.name)) return null
  const e = b.entity
  if (!e) return { front: [], back: [] }
  let nbt = null
  try { nbt = (require('prismarine-nbt') as typeof import('prismarine-nbt')).simplify(e) } catch { nbt = null }
  const side = s => {
    const msgs = (nbt && nbt[s] && nbt[s].messages) || []
    return msgs.map(m => {
      if (typeof m === 'string') {
        if (/^[{["]/.test(m)) {
          try { return flat(JSON.parse(m)) } catch { return m }
        }
        return m
      }
      return flat(m)
    })
  }
  return { front: side('front_text'), back: side('back_text') }
}

function flat (c) {
  if (c == null) return ''
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map(flat).join('')
  return (c.text || '') + (Array.isArray(c.extra) ? c.extra.map(flat).join('') : '')
}

async function writeSign (bot, pos, lines, { opened = null }: any = {}) {
  const want = bp.signLines(lines)
  let pk = opened ? await opened : null
  if (!pk) {
    // Редактор не открылся сам (табличка старая) — клик по ней открывает его,
    // если в руке нет красителя, чернил или сот: они красят, а не открывают.
    const b = bot.blockAt(pos)
    if (!b || !/_sign$/.test(b.name)) return { ok: false, why: 'таблички нет' }
    if (bot.heldItem && /dye$|ink_sac|honeycomb/.test(bot.heldItem.name)) {
      try { await bot.unequip('hand') } catch {}
    }
    const again = onceSignEditor(bot, 2500)
    try { await bot.activateBlock(b) } catch {}
    pk = await again
  }
  if (!pk) return { ok: false, why: 'сервер не открыл табличку для записи (воском покрыта или её правит другой)' }
  const block = bot.blockAt(pos)
  bot.updateSign(block, want.join('\n'), pk.isFrontText === false)
  const deadline = gameClock.now() + 2000
  while (gameClock.now() < deadline) {
    const t = signText(bot, pos)
    const side = t && (pk.isFrontText === false ? t.back : t.front)
    if (side && want.every((s, i) => (side[i] || '') === s)) return { ok: true, side: pk.isFrontText === false ? 'back' : 'front' }
    await sleep(150)
  }
  const t = signText(bot, pos)
  return { ok: false, why: `текст не подтвердился: ${JSON.stringify(t)}` }
}

export { onceSignEditor, signText, writeSign }
