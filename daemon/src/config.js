'use strict'
const path = require('path')

module.exports = {
  host: process.env.MC_HOST || '127.0.0.1',
  port: Number(process.env.MC_PORT || 25565),
  username: process.env.MC_USERNAME || 'NeuroDown',
  version: process.env.MC_VERSION || '1.21.11',
  auth: 'offline',

  wsHost: process.env.ND_WS_HOST || '127.0.0.1',
  wsPort: Number(process.env.ND_WS_PORT || 8765),

  memoryDir: process.env.ND_MEMORY_DIR || path.resolve(__dirname, '..', '..', 'memory'),

  // Fog of war. When true the bot only reports what a human player could
  // actually see: line of sight from its eyes, no ore through stone.
  fairPlay: process.env.ND_FAIR_PLAY !== 'false',

  // Autopilot thresholds
  eatBelowFood: 16,
  lowHealth: 8,

  // Vision: prismarine-viewer's web renderer, screenshotted by headless Chrome.
  viewerPort: Number(process.env.ND_VIEWER_PORT || 3007),
  viewerViewDistance: Number(process.env.ND_VIEWER_DISTANCE || 6)
}
