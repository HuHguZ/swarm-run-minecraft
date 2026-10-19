'use strict'

// Eyes for NeuroDown.
//
// prismarine-viewer ships a headless renderer, but it is built on headless-gl,
// which needs a native toolchain and does not build on this Windows box. So we
// use the viewer's *web* mode instead: it renders the bot's view with three.js
// in a page, and a long-lived headless Chrome grabs frames from it. Slower to
// start, but it needs no compiler and the page stays warm between shots.

const BOOT_MS = 6000 // first paint: chunks have to stream into the page

class Vision {
  declare session: any
  declare cfg: any
  declare viewerBot: any
  declare browser: any
  declare page: any
  declare warm: any
  declare starting: any

  constructor (session, cfg) {
    this.session = session
    this.cfg = cfg
    this.viewerBot = null   // which bot instance the viewer is bound to
    this.browser = null
    this.page = null
    this.warm = false
    this.starting = null
  }

  get port () {
    return this.cfg.viewerPort
  }

  // The viewer binds to one bot object. After a reconnect the bot is a new
  // object, so the viewer has to be rebuilt.
  startViewer () {
    const bot = this.session.bot
    if (!bot) throw new Error('бот не в игре — зрению не на что смотреть')
    if (this.viewerBot === bot) return

    const { mineflayer: mineflayerViewer }: typeof import('prismarine-viewer') = require('prismarine-viewer')
    mineflayerViewer((require('./viewer-adapter') as typeof import('./viewer-adapter')).viewerBot(bot), {
      port: this.port,
      firstPerson: true,
      viewDistance: this.cfg.viewerViewDistance
    })
    this.viewerBot = bot
    this.warm = false
  }

  async ensurePage () {
    if (this.page && !this.page.isClosed()) return this.page
    if (this.starting) return this.starting

    this.starting = (async () => {
      const puppeteer = require('puppeteer')
      if (!this.browser || !this.browser.connected) {
        this.browser = await puppeteer.launch({
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            // Headless Chrome has no real GPU here; force the software WebGL
            // backend or the canvas comes back black.
            '--enable-unsafe-swiftshader',
            '--use-gl=angle',
            '--use-angle=swiftshader'
          ]
        })
      }
      const page = await this.browser.newPage()
      page.on('console', m => {
        const t = m.text()
        if (/error|fail/i.test(t)) console.log('[viewer page]', t)
      })
      await page.goto(`http://127.0.0.1:${this.port}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
      this.page = page
      this.warm = false
      return page
    })().finally(() => { this.starting = null })

    return this.starting
  }

  async capture ({ width = 640, height = 360, fresh = false }: any = {}) {
    this.startViewer()
    const page = await this.ensurePage()

    await page.setViewport({ width, height, deviceScaleFactor: 1 })

    if (!this.warm || fresh) {
      await new Promise<any>(r => setTimeout(r, BOOT_MS))
      this.warm = true
    } else {
      // Let the renderer catch up with the bot having turned or moved.
      await new Promise<any>(r => setTimeout(r, 400))
    }

    // Viewer camera listens to move; a turn in a frozen world produces no physics move event.
    if ((require('./game-clock') as typeof import('./game-clock')).snapshot()?.frozen) {
      this.session.bot.emit('move')
      await new Promise(resolve => setTimeout(resolve, 400))
    }
    const data = await page.screenshot({ type: 'png', encoding: 'base64' })
    return { image: data, mime: 'image/png', width, height }
  }

  async close () {
    try { if (this.page && !this.page.isClosed()) await this.page.close() } catch {}
    try { if (this.browser) await this.browser.close() } catch {}
    try { this.viewerBot?.viewer?.close() } catch {}
    this.page = null
    this.browser = null
    this.viewerBot = null
    this.warm = false
  }
}

export { Vision }
