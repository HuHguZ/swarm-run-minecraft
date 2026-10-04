'use strict'
// Paper 1.21.11 ignores player actions while hasClientLoaded() is false.
// Mineflayer 4.37.1 does not send this packet; creative fixture commands can
// conceal the missing handshake. A predicted local dig is not server proof.
function install (bot) {
  if (bot._ndClientLoaded || !bot.registry?.protocol?.play?.toServer?.types?.packet_player_loaded) return
  bot._ndClientLoaded = true
  let generation = 0
  bot.on('end', () => { generation++ })
  bot.on('spawn', async () => {
    const mine = ++generation
    try {
      await bot.waitForChunksToLoad()
      if (mine === generation) bot._client.write('player_loaded', {})
    } catch {}
  })
}
module.exports = { install }
