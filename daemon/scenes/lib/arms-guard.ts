'use strict'
// Сторож PvP-сцен (2026-10-06): только ферма. Демоны фермы — ws 8801–8832
// (NeuroFarm<i>) и 8901–8932 (второй боец, farm/crystal/bside), сервер слота —
// 25601–25632. Живая арена (8765/8768), server/ (25565) и основной мир
// (8769/25569) — отказ до первого подключения. Порт без явного env — тоже отказ:
// старые сцены по умолчанию смотрели на 8765 и 25565.
const FARM_WS = (p) => (p >= 8801 && p <= 8832) || (p >= 8901 && p <= 8932)
const FARM_MC = (p) => p >= 25601 && p <= 25632

function portOf (url) {
  const m = String(url || '').match(/^wss?:\/\/(127\.0\.0\.1|localhost):(\d+)\/?$/)
  return m ? Number(m[2]) : NaN
}

// ws — адреса демонов, mc — порты сервера (undefined — сцена к серверу сама не ходит).
function farmOnly ({ ws = [], mc = [] }: { ws?: any[], mc?: any[] } = {}) {
  const bad = []
  for (const u of ws) if (!FARM_WS(portOf(u))) bad.push(`ws ${u || '(не задан)'}`)
  for (const p of mc) if (p !== undefined && !FARM_MC(Number(p))) bad.push(`сервер ${p || '(не задан)'}`)
  if (bad.length) throw new Error(`только ферма (демоны 8801–8832/8901–8932, сервер 25601–25632): ${bad.join(', ')}`)
  return ws.map(portOf)
}

// Сервер, к которому подключён демон (status.detail.server = «127.0.0.1:256xx»).
function farmServer (server) {
  const p = Number(String(server || '').split(':').pop())
  if (!FARM_MC(p)) throw new Error(`демон подключён не к ферме: ${server || '(нет)'}`)
  return p
}

export { farmOnly, farmServer, portOf }
