'use strict'
const { EventEmitter } = require('node:events')

// Existing VM policy fixtures advance their own Date or replace their own
// timers. Route the explicit game-clock port through that fixture boundary;
// transport and lifecycle wall deadlines retain actual Node timer handles.
const wall: Record<string, any> = { now: () => Date.now(), setTimeout, clearTimeout, setInterval, clearInterval }
wall.sleep = ms => new Promise<any>(resolve => wall.setTimeout(resolve, ms))

function clockFixture (context) {
  const port: Record<string, any> = {
    now: () => (context.Date || Date).now(),
    setTimeout: (...args) => (context.setTimeout || setTimeout)(...args),
    clearTimeout: timer => (context.clearTimeout || clearTimeout)(timer),
    setInterval: (...args) => (context.setInterval || setInterval)(...args),
    clearInterval: timer => (context.clearInterval || clearInterval)(timer),
    wall, changes: new EventEmitter(), snapshot: () => null, follow () {}, bind: () => port
  }
  port.sleep = ms => new Promise<any>(resolve => port.setTimeout(resolve, ms))
  return port
}
function withClockFixture (context) {
  const originalRequire = context.require
  const port = clockFixture(context)
  context.require = function (name) {
    if (name === './game-clock' || name === './src/game-clock') return port
    return originalRequire.call(this, name)
  }
  return context
}
module.exports = { clockFixture, withClockFixture }
