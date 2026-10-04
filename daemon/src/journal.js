'use strict'
const fs = require('fs')
const path = require('path')

const EMPTY_STATE = {
  goal: null,
  places: {},        // name -> {x,y,z,dimension,note}
  deaths: [],        // {at, x,y,z, cause, recovered}
  people: {},        // username -> free-form note the bot keeps about them
  promises: [],      // things the bot said it would do
  notes: [],
  updatedAt: null
}

class Journal {
  constructor (dir) {
    this.dir = dir
    this.statePath = path.join(dir, 'state.json')
    this.journalPath = path.join(dir, 'journal.md')
    fs.mkdirSync(dir, { recursive: true })
    this.state = this.loadState()
  }

  loadState () {
    try {
      const raw = fs.readFileSync(this.statePath, 'utf8')
      // Deep copy of the template, not a shallow one: a key missing from the
      // file (every state.json written before today has no `ore`) would come
      // back as the template's own object, and the first push into it would
      // edit the template for the life of the process.
      return Object.assign(JSON.parse(JSON.stringify(EMPTY_STATE)), JSON.parse(raw))
    } catch {
      return JSON.parse(JSON.stringify(EMPTY_STATE))
    }
  }

  saveState () {
    this.state.updatedAt = new Date().toISOString()
    fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), 'utf8')
  }

  patch (fn) {
    fn(this.state)
    this.saveState()
    return this.state
  }

  // One line per entry so the file stays greppable and cheap to re-read after
  // a context compaction.
  append (kind, text, where) {
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
    const loc = where ? ` @${Math.round(where.x)},${Math.round(where.y)},${Math.round(where.z)}` : ''
    const line = `- \`${stamp}\`${loc} **${kind}** — ${text}\n`
    if (!fs.existsSync(this.journalPath)) {
      fs.writeFileSync(this.journalPath, '# Журнал NeuroDown\n\n', 'utf8')
    }
    fs.appendFileSync(this.journalPath, line, 'utf8')
  }

  tail (n = 40) {
    try {
      const lines = fs.readFileSync(this.journalPath, 'utf8').split('\n').filter(Boolean)
      return lines.slice(-n).join('\n')
    } catch {
      return ''
    }
  }
}

module.exports = { Journal }
