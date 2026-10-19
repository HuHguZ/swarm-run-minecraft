'use strict'
import { REPO_ROOT } from './paths'
import path = require('path')

const host = process.env.MC_HOST || '127.0.0.1'
const port = Number(process.env.MC_PORT || 25565)
const username = process.env.MC_USERNAME || 'NeuroDown'
const version = process.env.MC_VERSION || '1.21.11'
const auth = 'offline'
const wsHost = process.env.ND_WS_HOST || '127.0.0.1'
const wsPort = Number(process.env.ND_WS_PORT || 8765)
const memoryDir = process.env.ND_MEMORY_DIR || path.resolve(REPO_ROOT, 'memory')
const fairPlay = process.env.ND_FAIR_PLAY !== 'false' || (require('./perception/knowledge') as typeof import('./perception/knowledge')).level() !== 'scan'
const eatBelowFood = 16
const lowHealth = 8
const viewerPort = Number(process.env.ND_VIEWER_PORT || 3007)
const viewerViewDistance = Number(process.env.ND_VIEWER_DISTANCE || 6)
export {
  host,
  port,
  username,
  version,
  auth,

  wsHost,
  wsPort,

  memoryDir,

  // Fog of war. When true the bot only reports what a human player could
  // actually see: line of sight from its eyes, no ore through stone.
  // Выключить можно только на уровне знания scan (S10, perception/knowledge): в rsg/ssg рентгена нет.
  fairPlay,

  // Autopilot thresholds
  eatBelowFood,
  lowHealth,

  // Vision: prismarine-viewer's web renderer, screenshotted by headless Chrome.
  viewerPort,
  viewerViewDistance
}
