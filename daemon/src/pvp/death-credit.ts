// Only translated public death announcements name a killer. The second argument is the
// attacker; the third may be a renamed weapon (thorns can even print the weapon first).
const language = require('minecraft-data')('1.21.11').language as Record<string, string>
const deathKey = (key: string) => /^death\.(attack|fell)\./.test(key) && language[key]?.startsWith('%1$s ')
const patterns = [...new Set(Object.keys(language).filter(key => deathKey(key) && key !== 'death.attack.badRespawnPoint.message').map(key => language[key]))].map(text => {
  const pattern = text.split(/(%[123]\$s)/).map(part => part === '%1$s' ? '(?<victim>[A-Za-z0-9_]{1,16})'
    : part === '%2$s' ? '(?<killer>[A-Za-z0-9_]{1,16})' : part === '%3$s' ? '\\[.*\\]' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('')
  return new RegExp('^' + pattern + '$')
})

export function publicDeathNotice(text: string) {
  for (const pattern of patterns) { const match = pattern.exec(text); if (match) return { victim: match.groups.victim, killer: match.groups.killer || null } }
  return null
}

export function clientDeathNotice(message, position) {
  const key = message?.translate
  if (position !== 'system' || !deathKey(key)) return null
  const victim = message.with?.[0]?.toString()
  if (typeof victim !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(victim)) return null
  const author = key !== 'death.attack.badRespawnPoint.message' && language[key].includes('%2$s') && message.with?.[1]?.toString()
  return { victim, killer: typeof author === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(author) ? author : null }
}
