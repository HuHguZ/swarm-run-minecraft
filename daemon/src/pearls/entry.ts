'use strict'
import { countOf } from '../items'
import * as worlds from '../worlds'
import { seesMob } from './common'
import { hunt } from './hunt'
import { barter } from './barter'

// Без mode — по тому, что видно (так зовёт автомат: pearls {count}): пиглин
// в 24 блоках и слитки в рюкзаке в Аду — бартер всеми слитками; иначе охота
// (без эндермена в поле зрения она сразу отвечает, где их искать).
async function pearls (session, ctl, p: any = {}) {
  if (p.mode === 'barter') return barter(session, ctl, p)
  if (p.mode === 'hunt') return hunt(session, ctl, p)
  if (p.mode === 'seek') return (require('./seek') as typeof import('./seek')).seek(session, ctl, p)
  const bot = session.bot
  const me = bot.entity.position
  const seen = (name, r) => (Object.values(bot.entities) as any[]).some((e : any) => e && e.name === name && e.position &&
    e.position.distanceTo(me) <= r && seesMob(bot, e))
  const inNether = worlds.worldOf(bot) === 'the_nether'
  let r
  if (inNether && countOf(bot, 'gold_ingot') > 0 && seen('piglin', 24) && !seen('enderman', 40)) {
    r = await barter(session, ctl, { ...p, count: undefined })
  } else {
    r = await hunt(session, ctl, p)
    if (inNether && !r.kills && countOf(bot, 'gold_ingot') > 0 && !seen('piglin', 24)) {
      r.note = (r.note || '') + ` Слитков ${countOf(bot, 'gold_ingot')} — пиглинам (mode=barter), когда увижу взрослого пиглина.`
    }
  }
  return { ...r, auto: true }
}

export { pearls }
