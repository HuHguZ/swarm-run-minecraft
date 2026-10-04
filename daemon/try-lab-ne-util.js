'use strict'
// Общие куски сцен потока nether-end (try-lab-ne-*.js), 03.10.
//   deaths(LOG, PLAYER, from) — смерти тела в журнале сервера с отметки from (байты). В полночь Paper перекладывает
//     logs/latest.log (файл короче отметки) — тогда читаем новый файл с начала, найденное раньше не теряем
//     (ошибка измерителя 03.10 01:38: смерти после 00:00 не видны, сцена писала deathCount 0).
//   portalTp(kit, status, inner) — запасной вход на подготовке: тело в клетку портала командой (ферма). Портал горит,
//     а «к порталу не подойти» (neF-A0f22-1 03.10: рама на y 113, у нижнего ряда нет клетки, где встать).
const fs = require('fs')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const DEATH_RE = /was |died|drowned|burned|tried to swim|fell|blew up|hit the ground|went up|withered|suffocated|starved|froze|walked into|experienced|discovered the floor|didn't want to live|squashed|skewered|stung|obliterated|impaled|poked|killed/
function deaths (LOG, PLAYER, from) {
  let pos = from
  const seen = []
  const parse = text => {
    for (const l of text.split('\n')) {
      if (!l.includes(`]: ${PLAYER} `)) continue
      if (/issued server command|joined|left|lost connection|logged in|advancement|moved too quickly|moved wrongly/.test(l)) continue
      if (DEATH_RE.test(l)) seen.push(l.replace(/^.*\]: /, '').trim())
    }
  }
  return () => {
    let size = 0
    try { size = fs.statSync(LOG).size } catch { return seen }
    if (size < pos) pos = 0
    if (size > pos) {
      try {
        const fd = fs.openSync(LOG, 'r')
        const buf = Buffer.alloc(size - pos)
        fs.readSync(fd, buf, 0, buf.length, pos)
        fs.closeSync(fd)
        // До последнего перевода строки — недописанная строка подождёт следующего чтения.
        const text = buf.toString('utf8')
        const cut = text.lastIndexOf('\n')
        if (cut >= 0) { parse(text.slice(0, cut)); pos += Buffer.byteLength(text.slice(0, cut + 1), 'utf8') }
      } catch {}
    }
    return seen
  }
}

async function portalTp (kit, status, inner) {
  if (!inner || !Number.isFinite(Number(inner.x))) return false
  await kit.cmd(`/tp @s ${Number(inner.x) + 0.5} ${Number(inner.y)} ${Number(inner.z) + 0.5}`)
  for (let w = 0; w < 20; w++) {
    await sleep(1000)
    const s = await status()
    if (s.dimension === 'the_nether') return true
  }
  return false
}

module.exports = { deaths, portalTp }
