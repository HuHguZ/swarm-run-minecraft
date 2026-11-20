import { execFile } from 'child_process'

export const runInspection = (cmd: string, args: string[]) => new Promise<string>(resolve =>
  execFile(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 30000 }, (error, out) => resolve(error ? '' : String(out))))

// Some Windows hosts report listeners and accepted sockets as State=0. A bound port
// alone proves nothing. Match the server end of our held loopback connection.
export const windowsPortOwner = `function Invoke-FarmPortOwners($ports, $bound, [scriptblock]$use) {
  $owners=@{}; $clients=@{}; $tasks=@{}; $expected=@{}
  try {
    foreach ($port in $ports) {
      $port=[int]$port
      $holders=@($bound | Where-Object { $_.LocalPort -eq $port -and ($_.State -eq 0 -or $_.State -eq 2) })
      if (!$holders.Count) { continue }
      $owners[$port]=0
      $ids=@($holders.OwningProcess | Sort-Object -Unique)
      if ($ids.Count -ne 1 -or $ids[0] -le 0) { continue }
      if (@($holders | Where-Object State -eq 2).Count) { $owners[$port]=[int]$ids[0]; continue }
      $client=[Net.Sockets.TcpClient]::new(); $clients[$port]=$client; $expected[$port]=[int]$ids[0]
      $tasks[$port]=$client.ConnectAsync([Net.IPAddress]::Loopback,$port)
    }
    if ($tasks.Count) {
      try { [void][Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($tasks.Values),1500) } catch {}
      $pending=@($clients.Keys | Where-Object { $tasks[$_].Status -eq 'RanToCompletion' })
      for ($attempt=0; $pending.Count -and $attempt -lt 2; $attempt++) {
        if ($attempt) { Start-Sleep -Milliseconds 50 }
        $peers=@(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter "RemotePort>0 AND (RemoteAddress='127.0.0.1' OR RemoteAddress='::ffff:127.0.0.1')" -ErrorAction Stop)
        $missing=@()
        foreach ($port in $pending) {
          $remote=$clients[$port].Client.LocalEndPoint.Port
          $match=@($peers | Where-Object { $_.LocalPort -eq $port -and $_.RemotePort -eq $remote -and $_.LocalAddress -in @('127.0.0.1','::ffff:127.0.0.1') -and $_.RemoteAddress -in @('127.0.0.1','::ffff:127.0.0.1') })
          if (!$match.Count) { $missing+=$port; continue }
          $ids=@($match.OwningProcess | Sort-Object -Unique)
          if ($ids.Count -eq 1 -and $ids[0] -eq $expected[$port]) { $owners[$port]=$expected[$port] }
        }
        $pending=$missing
      }
    }
    & $use $owners
  } finally { foreach ($client in $clients.Values) { $client.Dispose() } }
}`
export const boundPortsQuery = 'Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter "RemotePort=0" -ErrorAction Stop'

export async function listenerOwners(ports: number[], run = runInspection): Promise<Map<number, number> | null> {
  if (ports.some(p => !Number.isInteger(p) || p < 1 || p > 65535)) throw new Error('invalid listener port')
  const tcp = await run('netstat', ['-ano', '-p', 'TCP'])
  if (!tcp.trim()) return null
  const owners = new Map<number, number>()
  for (const line of tcp.split(/\r?\n/)) {
    const m = line.trim().split(/\s+/)
    if (m[3] !== 'LISTENING') continue
    const port = Number(m[1].slice(m[1].lastIndexOf(':') + 1)), pid = Number(m[4])
    if (pid > 0) owners.set(port, !owners.has(port) || owners.get(port) === pid ? pid : 0)
  }
  const missing = [...new Set(ports)].filter(port => !owners.has(port))
  if (!missing.length) return owners
  const raw = await run('powershell', ['-NoProfile', '-Command', `${windowsPortOwner}
    Invoke-FarmPortOwners @(${missing.join(',')}) @(${boundPortsQuery}) { param($owners)
      $found=@(foreach ($port in $owners.Keys) { @{port=$port;owner=$owners[$port]} }); ConvertTo-Json -InputObject $found -Compress
    }`])
  try {
    const rows = JSON.parse(raw)
    if (!Array.isArray(rows)) return null
    for (const { port, owner } of rows) {
      if (!missing.includes(port) || !Number.isInteger(owner) || owner < 0 || owners.has(port)) return null
      owners.set(port, owner)
    }
    return owners
  } catch { return null }
}
