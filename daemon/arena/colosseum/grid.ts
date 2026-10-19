'use strict'
// Колизей (часть colosseum.ts): воксельная сетка модели.

// ---------------------------------------------------------------- сетка

class Grid {
  declare x0: number
  declare x1: number
  declare y0: number
  declare y1: number
  declare z0: number
  declare z1: number
  declare sx: any
  declare sy: any
  declare sz: any
  declare data: any
  declare pal: any
  declare palIdx: any
  declare nbt: any

  constructor (x0, x1, y0, y1, z0, z1) {
    Object.assign(this, { x0, x1, y0, y1, z0, z1 })
    this.sx = x1 - x0 + 1; this.sy = y1 - y0 + 1; this.sz = z1 - z0 + 1
    this.data = new Uint16Array(this.sx * this.sy * this.sz)
    this.pal = ['']; this.palIdx = new Map([['', 0]])
    this.nbt = new Map() // i → NBT блока (флаги)
  }

  in (x, y, z) { return x >= this.x0 && x <= this.x1 && y >= this.y0 && y <= this.y1 && z >= this.z0 && z <= this.z1 }
  i (x, y, z) { return ((y - this.y0) * this.sz + (z - this.z0)) * this.sx + (x - this.x0) }
  get (x, y, z) { return this.in(x, y, z) ? this.pal[this.data[this.i(x, y, z)]] : '' }
  id (s) {
    let k = this.palIdx.get(s)
    if (k === undefined) { k = this.pal.length; this.pal.push(s); this.palIdx.set(s, k) }
    return k
  }

  set (x, y, z, s) { if (this.in(x, y, z)) this.data[this.i(x, y, z)] = this.id(s || '') }
}

export { Grid }
