# Local setup and play

[Swarm Run](../README.md) · [По-русски](README.ru.md)

## 1. Install and build

Use Windows PowerShell, Git for Windows, Node.js 24 or later and a **Java 21 JDK**. The managed farm uses Windows process controls and compiles a local Java agent. Join with a regular Minecraft Java **1.21.11** client.

Clone [swarm-run-minecraft](https://github.com/HuHguZ/swarm-run-minecraft) and open PowerShell in the repository root.

```powershell
npm.cmd ci
npm.cmd --prefix daemon ci
npm.cmd --prefix mcp ci
npm.cmd run build
node dist/mcp/smoke.js
```

The MCP smoke test checks tool discovery and schemas over stdio. It works before starting Paper.

## 2. Prepare Paper once

Download **Paper 1.21.11 build 132** from [PaperMC](https://papermc.io/downloads/paper). Put `paper-1.21.11-132.jar` in a new `server-twin/` folder in the clone. This build matches the farm's bytecode verification. The [build record](https://fill.papermc.io/v3/projects/paper/versions/1.21.11/builds/132) provides the download URL and SHA-256 under `downloads["server:default"]`. PaperMC's API requires a descriptive user agent. [PaperMC download service](https://docs.papermc.io/misc/downloads-service/)

Set `JAVA_HOME` to the Java 21 JDK. Run this from the repository root:

```powershell
$java = Join-Path $env:JAVA_HOME 'bin/java.exe'
& $java -version
Push-Location server-twin
& $java -Xms1G -Xmx3G -jar paper-1.21.11-132.jar --nogui
Pop-Location
```

Read the [Minecraft EULA](https://www.minecraft.net/en-us/eula). If you accept it, set `eula=true` in `server-twin/eula.txt`. In `server-twin/server.properties`, set these values and start Paper again:

```properties
server-ip=127.0.0.1
server-port=25569
online-mode=false
enable-rcon=false
spawn-protection=0
```

Keep the offline server, RCON and bot RPC on loopback. Offline mode accepts unverified player names, and the RPC endpoint permits game actions. Wait for Paper's `Done` message. This first start unpacks `libraries/` and `versions/` for the farm. Type `stop` in the Paper console when switching to the arena.

## 3A. Play the arena

Start with four blue bots on an unused farm slot. Use `1` in a fresh checkout. The arena modifies that slot's blocks and rules.

```powershell
$env:FARM_JAVA = Join-Path $env:JAVA_HOME 'bin/java.exe'
$env:MC_HOST = '127.0.0.1'
$env:FARM_MAX_PLAYERS = '6'
$env:ARENA_BOOST = '0'
node dist/farm/farm.js up 1 --from 1 --tick-rate 20
node dist/farm/arena/ffa.js up 1 3

$env:ARMS_MAP = 'colosseum'
$env:ARMS_SOLO = '1'
$env:ARMS_HUMAN_TEAM = 'red'
node dist/farm/arena/ffa.js arms 1
```

The first `up` starts Paper and one bot daemon. The second adds three bot daemons. Wait for the driver to build the Colosseum and log its roster. Open Multiplayer → Direct Connection and join **`127.0.0.1:25601`** as red. Raise `FARM_MAX_PLAYERS` before starting the slot if you add fighters.

End the driver with **Ctrl+C**. After it exits, stop the owned processes:

```powershell
node dist/farm/arena/ffa.js down 1
node dist/farm/farm.js down 1
```

For slot `i`, the game port is `25600 + i` and the base bot RPC port is `8800 + i`. Keep one arena at a time unless you configure distinct extra-daemon ports. `farm/limits.json` controls concurrent worlds, CPU policy and the default tick rate.

## 3B. Run or watch the campaign

Start Paper in `server-twin/`. Run `gamerule keep_inventory false` in its console and leave the bot without operator permissions. A fresh survival world gives a clean start from spawn.

Open another PowerShell in the repository root for the bot daemon:

```powershell
$env:MC_HOST = '127.0.0.1'
$env:MC_PORT = '25569'
$env:MC_USERNAME = 'NeuroDown'
$env:ND_WS_HOST = '127.0.0.1'
$env:ND_WS_PORT = '8769'
$env:ND_KNOWLEDGE = 'rsg'
node dist/daemon/src/index.js
```

Start the autonomous controller in a separate terminal:

```powershell
$env:ND_WS = 'ws://127.0.0.1:8769'
node dist/daemon/campaign.js
```

The campaign connects the bot. Follow its progress in the console and `daemon/campaign.log`, or join with a different player name to watch. The optional `iron` argument selects a specific stage. Stop the campaign with **Ctrl+C**, then disconnect the bot with `node dist/run/rpc.js --ws ws://127.0.0.1:8769 disconnect`. Stop the daemon with **Ctrl+C** and enter `stop` in the Paper console.

## 4. Control one bot with Codex or Claude Code

Start Paper and a bot daemon. Stop the autonomous campaign before taking manual control of the same bot. The MCP bridge forwards commands to one daemon. For the base bot in arena slot 1, change `ND_WS` to `ws://127.0.0.1:8801`. The arena driver controls its bots during a match.

Run the registration for your client from the repository root:

```powershell
$bridge = (Resolve-Path 'dist/mcp/src/index.js').Path

# Codex
codex mcp add swarm-run-minecraft --env ND_WS=ws://127.0.0.1:8769 -- node $bridge
codex mcp list

# Claude Code
claude mcp add --env ND_WS=ws://127.0.0.1:8769 --transport stdio --scope local swarm-run-minecraft -- node $bridge
claude mcp list
```

Reconnect the MCP client or open a new session. Ask the agent to call `mc_status` first, then `mc_connect` and `mc_observe`. For example, “Connect to my local Paper world, report the bot's position and what it can see, then leave it standing.” `mc_stop` cancels the active action and `mc_disconnect` leaves the game.

The agent can also run the documented arena and Paper commands in a shell. Specify the farm slot and ask it to report the game port and stop commands. [Codex MCP documentation](https://developers.openai.com/codex/mcp) · [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp)

## Development checks

```powershell
npm.cmd run typecheck
npm.cmd test
node dist/mcp/smoke.js
```

The full test run covers unit tests and replay fixtures. Use Paper matches and farm scenarios to measure actual game behavior. `node dist/farm/farm.js` lists the scenario, snapshot and tick-control commands.
