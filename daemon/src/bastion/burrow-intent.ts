const { burrow } = require('./bastion')
async function burrowIntent (session, ctl, p: any = {}) {
  if (require('.././worlds').worldOf(session.bot) !== 'the_nether') return { ok: false, why: 'закапываюсь только в Аду' }
  // Вслепую — по видимому (nether-cover.coverHere), а не колонной, выбранной по скрытым блокам.
  if (require('.././nether-cover').blind()) return require('.././nether-cover').coverHere(session, ctl)
  const st = {}
  const r = await burrow(session, ctl, st, p.why || 'по просьбе')
  if ((r && r.ok) || ctl.aborted || process.env.ND_BURROW_PIT === '0') return r
  // S1d 07.10: колонны рядом нет (помост спавнера, мост крепости: «закопаться: к колонне не дошёл» ×3 → тактика «карман» с открытыми
  // клетками, s1d-F22-8 — смерть под шарами) — яма 3 с крышкой на месте или рядом (blaze.digInNear).
  const d: any = await require('.././blaze').digInNear(session.bot, ctl).catch(e => ({ ok: false, why: e.message }))
  return d.ok ? { ok: true, how: 'яма на месте', sealed: d.sealed, at: d.at, burrow: r && r.why } : { ...(r || {}), pit: d.why }
}

module.exports = { burrowIntent }
