import { existsSync } from 'node:fs'
import { join } from 'node:path'

export function javaExecutable (): string {
  const { FARM_JAVA, JAVA_HOME, APPDATA } = process.env
  const executable = process.platform === 'win32' ? 'java.exe' : 'java'
  if (FARM_JAVA) return FARM_JAVA
  if (JAVA_HOME) return join(JAVA_HOME, 'bin', executable)
  if (process.platform === 'win32' && APPDATA) {
    const launcherJava = join(APPDATA, '.minecraft', 'runtime', 'java-runtime-delta', 'windows', 'java-runtime-delta', 'bin', executable)
    if (existsSync(launcherJava)) return launcherJava
  }
  return executable
}
