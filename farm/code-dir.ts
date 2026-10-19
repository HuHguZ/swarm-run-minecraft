// Где лежит собранный код демона и сцен. live — dist/daemon (сборка tsc); снимок серии — .snapshots/<имя>/:
// копия собранных dist/daemon и dist/farm той же раскладки (пути __dirname/.. внутри снимка ведут к его же farm/),
// node_modules демона — ссылкой. Данные, логи и миры фермы по-прежнему в исходном дереве (REPO_ROOT).
import * as path from 'path'
import { DIST_ROOT, REPO_ROOT } from '../daemon/src/paths'

export const LIVE_DAEMON = path.join(DIST_ROOT, 'daemon')
export const SNAPSHOTS = path.join(REPO_ROOT, '.snapshots')
export const snapshotDir = (name: string) => path.join(SNAPSHOTS, name)
export const codeDir = (name?: string | null) => !name || name === 'live' ? LIVE_DAEMON : path.join(snapshotDir(name), 'daemon')
