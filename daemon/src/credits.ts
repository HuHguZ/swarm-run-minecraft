'use strict'
// Титры после выходного портала Энда (s5c, 06.10). Сервер шлёт win_game и держит игрока вне всякого мира, пока клиент
// не ответит perform_respawn (ServerGamePacketListenerImpl.handleClientCommand: wonGame → respawn). Ванильный клиент
// при значении 0 отвечает сразу, при 1 показывает титры, которые игрок пропускает; mineflayer отвечает только на 1.
// Без ответа нет update_time — игровые часы демона стояли (s5-c5-s1, s5-e23-s7). Отвечаем всегда (как пропуск титров)
// и повторяем раз в 2 с, пока не придёт respawn (лишний ответ сервер молча пропускает: wonGame уже false).
import { wall } from './game-clock'

function install (bot) {
  const c = bot && bot._client
  if (!c || typeof c.on !== 'function' || bot._ndCredits) return
  const st = bot._ndCredits = { answered: 0 }
  let timer = null
  const stop = () => { if (timer) { wall.clearInterval(timer); timer = null } }
  const answer = () => {
    try { c.write('client_command', bot.supportFeature?.('respawnIsPayload') ? { payload: 0 } : { actionId: 0 }); st.answered++ } catch {}
  }
  c.on('game_state_change', pk => {
    if (!pk || !(pk.reason === 4 || pk.reason === 'win_game')) return
    answer()
    stop()
    let n = 0
    timer = wall.setInterval(() => { if (++n > 5) stop(); else answer() }, 2000)
    timer.unref?.()
  })
  c.on('respawn', stop)
  c.on('end', stop)
}

export { install }
