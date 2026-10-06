import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const jar = path.resolve(process.argv[2] ?? path.join(root, 'farm/server-31/versions/1.21.11/server-1.21.11.jar'))
const content = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/read-vanilla-data.ps1'), '-Jar', jar], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true })
const raw = JSON.parse(content.replace(/^\uFEFF/, ''))
const version = JSON.parse(raw.version)
if (version.id !== '1.21.11') throw new Error(`Expected vanilla 1.21.11 jar, found ${version.id}`)
const ordered = object => Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([name, json]) => [name, JSON.parse(json)]))
const data = { version: version.id, source: 'vanilla server jar', jarSha256: crypto.createHash('sha256').update(fs.readFileSync(jar)).digest('hex'),
  recipes: ordered(raw.recipes), blockLoot: ordered(raw.blockLoot), itemTags: ordered(raw.itemTags) }
const destination = path.join(root, 'daemon/data/conversions-1.21.11.json')
fs.writeFileSync(destination, JSON.stringify(data) + '\n')
console.log(JSON.stringify({ file: path.relative(root, destination), bytes: fs.statSync(destination).size, recipes: Object.keys(data.recipes).length, blockLoot: Object.keys(data.blockLoot).length, itemTags: Object.keys(data.itemTags).length, jarSha256: data.jarSha256 }))
