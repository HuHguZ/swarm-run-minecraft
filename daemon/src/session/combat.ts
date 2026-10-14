'use strict'
const gameClock = require('../game-clock')
const Vec3 = require('vec3')
const combat = require('../combat')
const flee = require('../flee')
const fauna = require('../fauna')
const bow = require('../bow')
const throwMod = require('../throw')
const lootMod = require('../loot')
function sleep (ms, ctl?: any) {
  if (ctl?.aborted) return Promise.resolve()
  return new Promise<void>(resolve => {
    const t = gameClock.setTimeout(resolve, ms)
    if (ctl) ctl.onAbort.push(() => { gameClock.clearTimeout(t); resolve() })
  })
}

function fight (this: any, p: any = {}) {
    return this.runIntent('fight', ctl => {
      this.require()
      this.updateMovements()
      return combat.fight(this, ctl, p)
    }, {
      params: p,
      timeoutMs: (Math.min(300, p.timeoutSeconds ?? 60) + 15) * 1000,
      interruptOn: p.allowPlayer
        ? ['death', 'kicked', 'disconnected']
        : ['chat', 'death', 'kicked', 'disconnected']
    })
  }

function fleeIntent (this: any, p: any = {}) {
    return this.runIntent('flee', ctl => {
      this.require()
      // from — игроки, от кого бежать (арена: бот слабее гонящегося — бег по ходу, без долгого поиска пути).
      const foes = (Array.isArray(p.from) ? p.from : []).map(n => this.bot.players?.[n]?.entity?.id).filter(id => id != null)
      return flee.smartFlee(this, ctl, {
        timeoutMs: Math.min(60, p.timeoutSeconds ?? 15) * 1000,
        safeDist: p.safeDist ?? 14,
        arena: p.arena || null,
        reason: p.reason || null,
        foes,
        // toward — куда бежать выгоднее (свои, неоткрытые сундуки): {x,y,z}[].
        goals: Array.isArray(p.toward) ? p.toward.filter(g => Number.isFinite(g?.x) && Number.isFinite(g?.z)) : []
      })
    }, {
      timeoutMs: (Math.min(60, p.timeoutSeconds ?? 15) + 5) * 1000,
      interruptOn: ['chat', 'death', 'kicked', 'disconnected']
    })
  }

function loot (this: any, p: any = {}) {
    return this.runIntent('loot', ctl => {
      this.require()
      this.updateMovements()
      return lootMod.loot(this, ctl, p)
    }, { timeoutMs: Math.max(1, Math.min(90000, (p.timeoutSeconds ?? 90) * 1000)), interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected'] })
  }

function structure (this: any, p: any = {}) {
    const S = require('../structures')
    const mode = p.mode || 'scan'
    if (mode !== 'explore' && mode !== 'loot') {
      return this.immediate(async () => {
        this.require()
        if (mode === 'list') return { known: S.known(this, { all: !!p.all }) }
        if (mode === 'where') return S.whereNext(this, p.kind || 'village')
        if (mode === 'plan') return { go: S.opportunities(this, { radius: p.radius || 192 }) }
        if (mode === 'forget') return S.forget(this, p)
        if (mode === 'fit') return S.fitKnown(this, p)
        if (mode === 'maps') return { maps: S.readTreasureMaps(this) }
        const r = S.scan(this, { radius: Math.min(96, p.radius || 48) })
        return { seen: r.found, fresh: r.fresh.length, dim: r.dim, blocks: p.blocks ? r.blocks : undefined }
      })
    }
    const secs = Math.min(600, p.timeoutSeconds || 300)
    return this.runIntent('structure', ctl => {
      this.require()
      return S.explore(this, ctl, { ...p, chestsOnly: mode === 'loot' || p.chestsOnly })
    }, { timeoutMs: (secs + 5) * 1000, interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected'] })
  }

async function autoLoot (this: any, target) {
    this.require()
    if (this.current && this.current.name !== 'wait') return { busy: this.current.name }
    const ctl: any = { aborted: false, onAbort: [] }
    ctl.abort = () => {
      if (ctl.aborted) return
      ctl.aborted = true
      for (const fn of ctl.onAbort) { try { fn() } catch {} }
    }
    this.current = { name: 'loot', ctl }
    const t = gameClock.setTimeout(() => ctl.abort(), 60000)
    try {
      this.updateMovements()
      return await lootMod.loot(this, ctl, target.entityId !== undefined ? { entityId: target.entityId } : target.at)
    } catch (err) {
      return { error: String((err && err.message) || err) }
    } finally {
      gameClock.clearTimeout(t)
      ctl.abort()
      if (this.current && this.current.ctl === ctl) this.current = null
    }
  }

function shoot (this: any, p: any = {}) {
    const count = Math.max(1, Math.min(20, p.count ?? 1))
    return this.runIntent('shoot', async ctl => {
      const bot = this.require()
      const target = bot.nearestEntity(e => e && e.name === p.target && e.position)
      if (!target) throw new Error(`не вижу ${p.target}`)
      const shots = []
      let last = null
      let vel = { x: 0, y: 0, z: 0 }
      const velFn = () => {
        const now = gameClock.now()
        const pos = target.position
        if (last) {
          const dt = (now - last.t) / 50
          if (dt > 0.3) vel = { x: (pos.x - last.x) / dt, y: (pos.y - last.y) / dt, z: (pos.z - last.z) / dt }
        }
        last = { x: pos.x, y: pos.y, z: pos.z, t: now }
        return vel
      }
      let side = 'left'
      const onDraw = p.strafe
        ? (ms) => {
            if (ms % 600 < 60) side = side === 'left' ? 'right' : 'left'
            try { bot.setControlState('left', side === 'left'); bot.setControlState('right', side === 'right') } catch {}
          }
        : null
      const probeArrow = async () => {
        const lines = []
        const onMsg = (m) => { if (/Motion|Pos|\[/.test(m)) lines.push(m) }
        bot.on('messagestr', onMsg)
        try {
          const sel = `@e[type=arrow,sort=nearest,limit=1,distance=..8]`
          bot.chat(`/data get entity ${sel} Motion`)
          await sleep(250)
          bot.chat(`/data get entity ${sel} Pos`)
          await sleep(350)
        } finally { bot.removeListener('messagestr', onMsg) }
        return lines
      }
      for (let i = 0; i < count && !ctl.aborted; i++) {
        const release: any = {}
        const shot = await bow.shoot(bot, target, {
          velFn,
          onDraw,
          follow: !p.probe,
          mode: p.mode || 'compensate',
          shouldStop: () => ctl.aborted,
          onRelease: (moved) => {
            const v = bot.entity.velocity
            release.vel = v ? { x: +v.x.toFixed(4), y: +v.y.toFixed(4), z: +v.z.toFixed(4) } : null
            const yw = bot.entity.yaw; const pt = bot.entity.pitch
            const m = moved || { x: 0, y: 0, z: 0 }
            release.predicted = {
              x: +(-Math.sin(yw) * Math.cos(pt) * 3 + m.x).toFixed(3),
              y: +(Math.sin(pt) * 3 + (bot.entity.onGround ? 0 : m.y)).toFixed(3),
              z: +(-Math.cos(yw) * Math.cos(pt) * 3 + m.z).toFixed(3)
            }
            release.yawDeg = +(bot.entity.yaw * 180 / Math.PI).toFixed(2)
            release.pitchDeg = +(bot.entity.pitch * 180 / Math.PI).toFixed(2)
            const pp = bot.entity.position
            release.pos = { x: +pp.x.toFixed(3), y: +pp.y.toFixed(3), z: +pp.z.toFixed(3) }
            release.onGround = bot.entity.onGround
          }
        })
        if (p.probe && shot.shot) { shot.release = release; shot.server = await probeArrow() }
        shots.push(shot)
        if (p.probe) await sleep(1500)
      }
      const hit = shots.filter(s => s.hit).length
      return { target: p.target, hit, of: shots.length, shots }
    }, { timeoutMs: count * 6000 + 10000, interruptOn: ['chat', 'death', 'kicked', 'disconnected'] })
  }

function throwTest (this: any, p: any = {}) {
    return this.runIntent('throw', async ctl => {
      const bot = this.require()
      const it = bot.inventory.items().find(i => i.name === p.item)
      if (!it) throw new Error(`нет ${p.item}`)
      const to = new Vec3(p.to.x, p.to.y, p.to.z)
      const keys = ['forward', 'back', 'left', 'right', 'jump', 'sprint']
      const set = (k, v) => { try { bot.setControlState(k, v) } catch {} }
      const move = p.move || 'still'
      await bot.equip(it, 'hand')
      await bot.lookAt(to, true)
      let side = 'left'
      const t0 = gameClock.now()
      const drive = () => {
        if (move === 'strafe' || move === 'jump') {
          if ((gameClock.now() - t0) % 700 < 60) side = side === 'left' ? 'right' : 'left'
          set('left', side === 'left'); set('right', side === 'right')
        }
        if (move === 'run') { set('forward', true); set('sprint', true) }
        if (move === 'back') set('back', true)
      }
      while (gameClock.now() - t0 < 900 && !ctl.aborted) {
        drive()
        await bot.lookAt(to, true).catch(() => {})
        await sleep(50)
      }
      if (move === 'jump') {
        set('jump', true)
        const j0 = gameClock.now()
        while (gameClock.now() - j0 < 600 && (bot.entity.onGround || bot.entity.velocity.y > 0.1)) { drive(); await sleep(10) }
        set('jump', false)
      }
      let landed = null
      const onMove = () => { if (!landed) landed = bot.entity.position.clone() }
      const onSpawn = (e) => {
        if (!landed && e && e.name === 'area_effect_cloud' && e.position && e.position.distanceTo(to) < 12) landed = e.position.clone()
      }
      bot.on('forcedMove', onMove)
      bot.on('entitySpawn', onSpawn)
      let r
      try {
        r = await throwMod.throwAt(bot, to, { item: bot.heldItem, mode: p.mode || 'exact', jump: p.jump ?? false, sprint: !!p.sprint })
        for (const k of keys) set(k, false)
        const w0 = gameClock.now()
        while (!landed && gameClock.now() - w0 < 8000 && !ctl.aborted) await sleep(50) // жемчуг на 90 бл. летит ~85 тиков
      } finally {
        for (const k of keys) set(k, false)
        bot.removeListener('forcedMove', onMove)
        bot.removeListener('entitySpawn', onSpawn)
      }
      const err = landed ? Math.round(Math.hypot(landed.x - to.x, landed.z - to.z) * 100) / 100 : null
      return {
        ...r,
        move,
        landed: landed ? { x: +landed.x.toFixed(2), y: +landed.y.toFixed(2), z: +landed.z.toFixed(2) } : null,
        err,
        predictedErr: r.land ? Math.round(Math.hypot(r.land.x - to.x, r.land.z - to.z) * 100) / 100 : null,
        modelErr: r.land && landed ? Math.round(Math.hypot(r.land.x - landed.x, r.land.z - landed.z) * 100) / 100 : null
      }
    }, { timeoutMs: 15000, interruptOn: ['chat', 'death', 'kicked', 'disconnected'] })
  }

function animals (this: any, p: any = {}) {
    const mode = p.mode || 'tame'
    return this.runIntent('animals', ctl => {
      this.require()
      this.updateMovements()
      if (mode === 'tame') return fauna.tame(this, ctl, p)
      if (mode === 'breed') return fauna.breed(this, ctl, p)
      if (mode === 'sit' || mode === 'stand') return fauna.pet(this, ctl, { ...p, sit: mode === 'sit' })
      throw new Error(`не знаю режим ${mode}: tame / breed / sit / stand`)
    }, { timeoutMs: 120000, interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected'] })
  }

function golem (this: any, p: any = {}) {
    return this.runIntent('golem', ctl => {
      this.require()
      return fauna.golem(this, ctl, p)
    }, { timeoutMs: p && p.mode === 'kill' ? (Math.min(110, Number(p.timeoutSeconds) || 85) + 15) * 1000 : 60000, interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected'] })
  }

function trade (this: any, p: any = {}) {
    return this.runIntent('trade', ctl => {
      this.require()
      this.updateMovements()
      return fauna.trade(this, ctl, p)
    }, { timeoutMs: 60000, interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected'] })
  }

async function retaliate (this: any, name, p: any = {}) {
    if (this.tactics?.enabled()) await this.tactics.waitForRelease()
    const bot = this.require()
    if (this.current && this.current.name === 'retaliate') return { already: true }
    this.cancel()
    const ctl: any = { aborted: false, onAbort: [] }
    ctl.abort = () => {
      if (ctl.aborted) return
      ctl.aborted = true
      for (const fn of ctl.onAbort) { try { fn() } catch {} }
    }
    this.current = { name: 'retaliate', ctl, target: name }
    const onDeath = () => ctl.abort()
    bot.once('death', onDeath)
    try {
      this.updateMovements()
      return await require('../reflex-lock').run(this, ctl, () => combat.fight(this, ctl, { target: name, allowPlayer: true, ...p }))
    } catch (err) {
      return { error: String((err && err.message) || err) }
    } finally {
      bot.removeListener('death', onDeath)
      ctl.abort()
      if (this.current && this.current.ctl === ctl) this.current = null
    }
  }

async function defend (this: any, entityId, friend, p: any = {}) {
    if (this.tactics?.enabled()) await this.tactics.waitForRelease()
    const bot = this.require()
    if (this.current && this.current.name !== 'wait') return { busy: this.current.name }
    this.cancel()
    const ctl: any = { aborted: false, onAbort: [] }
    ctl.abort = () => {
      if (ctl.aborted) return
      ctl.aborted = true
      for (const fn of ctl.onAbort) { try { fn() } catch {} }
    }
    this.current = { name: 'defend', ctl, target: `#${entityId}`, friend }
    const onDeath = () => ctl.abort()
    bot.once('death', onDeath)
    let slain = false
    const onDead = (e) => { if (e && e.id === entityId) slain = true }
    bot.on('entityDead', onDead)
    try {
      this.updateMovements()
      const r = await require('../reflex-lock').run(this, ctl, () => combat.fight(this, ctl, { target: `#${entityId}`, allowPlayer: false, timeoutSeconds: 45, retreatAtHealth: 6, ...p }))
      if (slain && r && typeof r === 'object' && !r.killed) r.killed = r.target || true
      return r
    } catch (err) {
      return { error: String((err && err.message) || err), killed: slain || undefined }
    } finally {
      bot.removeListener('entityDead', onDead)
      bot.removeListener('death', onDeath)
      ctl.abort()
      if (this.current && this.current.ctl === ctl) this.current = null
    }
  }

module.exports = { fight, flee: fleeIntent, loot, structure, autoLoot, shoot, throwTest, animals, golem, trade, retaliate, defend }
