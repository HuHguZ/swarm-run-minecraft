const { burrow } = require('./bastion')
async function burrowIntent (session, ctl, p: any = {}) {
  if (require('.././worlds').worldOf(session.bot) !== 'the_nether') return { ok: false, why: 'закапываюсь только в Аду' }
  const st = {}
  return burrow(session, ctl, st, p.why || 'по просьбе')
}

module.exports = { burrowIntent }
