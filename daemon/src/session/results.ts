'use strict'
const INTERRUPT_CODES = { chat: 'CHAT', gesture: 'GESTURE', damage: 'DAMAGE', low_health: 'LOW_HP', death: 'DIED',
  kicked: 'KICKED', disconnected: 'DISCONNECTED', emergency: 'EMERGENCY', friend_hurt: 'FRIEND_HURT' }

const isCode = c => typeof c === 'string' && /^[A-Z][A-Z0-9_]*$/.test(c)

function resultCode (result) {
  if (!result) return 'FAILED'
  const own = result.detail && typeof result.detail === 'object' && isCode(result.detail.code) ? result.detail.code : null
  if (result.status === 'timeout') return 'TIMEOUT'
  if (result.status === 'interrupted') {
    const t = result.by && result.by.type
    return INTERRUPT_CODES[t] || (t ? String(t).toUpperCase().replace(/[^A-Z0-9]+/g, '_') : 'INTERRUPTED')
  }
  if (result.status === 'failed') return isCode(result.code) ? result.code : own || 'FAILED'
  return own || 'OK'
}

export { resultCode }
