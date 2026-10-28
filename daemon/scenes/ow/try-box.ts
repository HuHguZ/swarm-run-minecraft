'use strict'
// Коробка на месте (shelter box) — как часто «ответа от сервера нет» (sr27 full: 400+ отказов в полных проходах).
// Ровный каменный пол высоко (y 150), тело в случайной точке своей клетки (до 0.29 от центра), 32 булыжника;
// ROUNDS раз: shelter {mode: box} → строка JSON (sealed, причина, смещение тела). Только ферма.
import * as fs from 'fs'
import { connect, createKit, sleep } from '../lib/scene-kit'

const ROUNDS = Math.max(1, Number(process.env.ROUNDS || 20))
const OUT = process.env.LAB_OUT || 'lab-box.jsonl'
const X = 3000, Y = 150, Z = 3000

async function main () {
  const slot = Number(process.env.FARM_SLOT)
  if (!(slot >= 1 && slot <= 32) || process.env.ND_WS !== `ws://127.0.0.1:${8800 + slot}`) throw new Error('только ферма')
  const conn = connect(process.env.ND_WS)
  await conn.ready
  const call = conn.call
  const kit = createKit({ call, heard: conn.heard, logFile: process.env.ND_SERVER_LOG, player: process.env.MC_USERNAME })
  await call('connect'); await call('stop')
  const cmd = async (text: string) => { const r = await kit.cmd(text); if (!r.ok) throw new Error('команда не подтверждена: ' + text) }
  await kit.setDifficulty('peaceful')
  await cmd('/gamemode survival')
  for (let i = 0; i < ROUNDS; i++) {
    await cmd(`/fill ${X - 4} ${Y - 1} ${Z - 4} ${X + 4} ${Y - 1} ${Z + 4} stone`)
    await cmd(`/fill ${X - 4} ${Y} ${Z - 4} ${X + 4} ${Y + 4} ${Z + 4} air`)
    await cmd('/clear @s')
    await cmd('/give @s cobblestone 32')
    const dx = (Math.random() * 2 - 1) * 0.29, dz = (Math.random() * 2 - 1) * 0.29
    await cmd(`/tp @s ${X + 0.5 + dx} ${Y} ${Z + 0.5 + dz} ${Math.floor(Math.random() * 360)} 0`)
    await sleep(600)
    const r = await call('shelter', { mode: 'box' }).catch(e => ({ error: e.message }))
    const d: any = (r as any).detail || r
    const rec = { i, dx: +dx.toFixed(2), dz: +dz.toFixed(2), sealed: !!d.sealed, stopped: d.stopped || d.note || d.error || null }
    console.log(JSON.stringify(rec))
    fs.appendFileSync(OUT, JSON.stringify(rec) + '\n')
  }
  await call('disconnect', { reason: 'try-box окончена' }).catch(() => {})
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
