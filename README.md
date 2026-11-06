# Swarm Run

**PvP swarms and autonomous speedrunning for Minecraft Java 1.21.11.**

![Cutaway of the Swarm Run Colosseum with blue bots coordinating a wind charge and an elytra approach, alongside a solo speedrun route from a Nether portal to the End dragon](docs/media/cover.jpg)

[PvP swarm](#pvp-swarm) · [Local setup and play](docs/local-play.md) · [По-русски](docs/README.ru.md) · [Architecture](docs/media/architecture.svg)

Swarm Run is an experimental bot lab with two game modes on the same Mineflayer runtime. You can join a local Paper arena with a regular Minecraft client, run a speedrun campaign, or control one bot through MCP from Codex or Claude Code. The autonomous modes run without an AI agent or model API key.

> Unofficial Minecraft project. Not approved by or associated with Mojang or Microsoft. [Minecraft Usage Guidelines](https://www.minecraft.net/en-us/usage-guidelines)

## PvP swarm

One bot pressures an opponent from the front. A second closes off the route around the arena, and a third takes an elytra approach from the centre side. When the opponent is knocked into the air, the next thrower uses their new trajectory to decide whether to continue the ejection or leave the opening to a spear or mace fighter.

![In-world capture of the generated sandstone Colosseum above its lava moat](docs/media/colosseum.png)

*The generated Colosseum, captured from the development viewer. The cover above is an illustration.*

### How the team makes decisions

The coordinator merges recent sightings on a shared team board. It weighs target movement and equipment against the team's health, weapons, supplies, positions and time to reach the fight. Enemy health is an estimate that accounts for confirmed hits, visible healing and regeneration. Combat decisions use that estimate instead of the player's hidden health value. Old sightings lose value as the player moves. [Team board](daemon/src/swarm/board.ts) · [Team planner](daemon/src/swarm/plan-pvp.ts)

- **Loot and regroup.** Bots split up to search for gear, look for caches, and transfer spare weapons, armour and rockets to teammates that can use them. An unarmed fighter facing an equipped opponent can break contact and rearm. An equipped fighter can keep pressure on while wounded teammates recover. [Supplies](farm/swarm/swarm-driver/team.ts) · [Retreat and recovery](daemon/src/swarm/plan-flee.ts)
- **Choose the formation for the fight.** The planner can concentrate on one target, assign different approach sectors, protect recovering teammates with an outward-facing shield ring, or spread the team against explosions. Builders can cut off a fleeing opponent with blocks ahead of their path. A feigned retreat can draw an advancing enemy towards an ambush. These tactics compete for the same fighters, and changing targets has a cost when a bot is already in contact. [Formation scoring](daemon/src/swarm/doctrine.ts) · [Formation tactics](daemon/src/swarm/plan-doctrines.ts) · [Assignments](daemon/src/swarm/plan-assign.ts)
- **Let the client execute.** Each fighter owns its path, equipment, aim and attack. Its combat planner weighs expected damage, attack recharge, shield state, incoming damage and time to contact. An axe can disable a raised shield, a sword can maintain pressure, and a spear can jab from range or use relative speed in a charging attack. A local fighter can drop an approach when the contact or landing window disappears. [Attack planner](daemon/src/pvp/kill-planner.ts) · [Damage model](daemon/src/pvp/damage-model.ts)

### How a wind chain is calculated

1. **Reconstruct the motion.** The planner works from visible position samples and their game ticks. It distinguishes ground movement from jumping and gliding, estimates walking, sprinting and lateral motion where the samples support it, and starts a new forecast after a visible impulse. The thrower's own movement also carries into the projectile's launch velocity. [Motion and launch model](daemon/src/combat/enemy-wind.ts) · [Wind physics](daemon/src/combat/team-wind.ts)
2. **Predict the first contact.** A wind charge has a base launch speed of 1.5 blocks per tick and travels without gravity or drag. The planner checks its path and spread against block shapes and moving hitboxes, then evaluates a direct hit or a burst off a surface. The burst can reach up to 2.4 blocks. A floor burst can lift the target, and a burst on the centre side can add outward speed. Burst position, exposure to the blast, visible gear and uncertain Blast Protection all affect the estimate. [Wind constants](daemon/src/combat/team-wind.ts) · [Collision and impulse model](daemon/src/combat/enemy-wind.ts)
3. **Compare outcomes on the actual arena.** Tick-by-tick rollouts compare the shot with leaving the target alone. They track the target's flight, contact with terrain, and where it can land relative to the Colosseum's elliptical rim. The planner distinguishes a launch that sets up another throw, a useful push, a full ejection, and a dangerous fall. An opponent who launches themselves for a mace strike can become a target for an outward deflection. A high toss can still leave a survivable landing, depending on the last impulse, landing surface and protection such as Feather Falling. [Shot selection](daemon/src/combat/wind-out.ts) · [Body forecasts](daemon/src/combat/enemy-wind.ts)
4. **Coordinate and check again at release.** Ground throwers can move towards the centre side to get a shallower outward angle, and airborne fighters can look for the next intercept. The team radio arbitrates competing shots and tracks whether the lead throw was released. A follow-up can use a visible in-flight charge or the velocity change after a confirmed burst. Before sending the throw, the client rechecks the current trajectory, timing and risk to allies. Changed conditions can cancel the release. [Team wind coordination](farm/swarm/swarm-driver/wind.ts) · [Execution checks](daemon/src/combat/enemy-wind-execute.ts)

### Turning an opening into a hit

| Tactic | What the bot can calculate |
| --- | --- |
| **Elytra assault** | Simulate the effects of pitch, yaw and rocket thrust on the approach. Check clearance through terrain and look for a path to contact with a spear and a viable landing. [Glide physics](daemon/src/elytra/physics.ts) · [Airborne approach](daemon/src/combat/wing-orbit.ts) |
| **Wind into spear or mace** | If the target is projected to come down inside the arena, an airborne fighter can price a spear intercept. The coordinator can send another fighter to self-launch with a wind charge and time a descending mace hit near the projected landing. [Airborne approach](daemon/src/combat/wing-orbit.ts) · [Mace follow-up](daemon/src/combat/pearl-ambush.ts) |
| **Boost a teammate** | The paired wind skill models a thrower's floor burst and a receiver's jump on the same timeline. It checks where both fighters can land. A spear setup can compare the assisted attack with an ordinary approach. [Paired wind skill](daemon/src/combat/team-wind.ts) · [Spear setup](daemon/src/combat/spear-wind.ts) |
| **Pearl intercept** | Track a visible pearl with gravity, drag and block collisions. The predicted teleport point uses the pearl's position at the start of the impact tick. A nearby fighter can move to the arrival point, prepare a cobweb where placement is possible, or time a wind-assisted mace ambush. [Pearl tracking](daemon/src/combat/pearl-watch.ts) · [Response planner](daemon/src/combat/pearl-intercept.ts) |
| **Defence against a late mace swap** | Read the incoming descent and where it can meet the defender, even while the attacker is still holding a wind charge. Start raising the shield early, face the threat, or move away from the predicted landing. [Mace defence](daemon/src/pvp/turn-mace.ts) |

The farm also isolates combinations such as an axe opening a shield for following sword hits, a medic aiming a splash without giving the opponent the same effect, and a teammate placing water at a predicted landing. These have their own scenarios and safety checks. Their presence in the test suite does not imply that the arena coordinator selects each one in a live match. [Combination scenarios](farm/swarm/swarm-driver/)

### What Paper has confirmed

- Controlled trials recorded clean wind ejections, including an interception near the rim after a target launched itself. A separate run recorded the whole hitbox crossing the rim and returning before a fatal fall inside. The latter counts as a fall kill, with no ejection credit.
- Paper recorded spear hits during an elytra assault and two complete shield blocks against a same-tick wind-charge-to-mace swap. In isolated trials, wind-to-spear landed the hit and the pilot safely in both runs. A wind-assisted mace follow-up killed the vulnerable target and the helper landed safely in both runs.
- Sustained ejections from the centre against moving opponents are still inconsistent. Strafing and cover can invalidate a shot, and a teammate may miss the short window for the next throw or hit. Replay tests exercise individual decisions. Paper scenarios measure contact, damage and the final landing or fall. [PvP mechanics notes](PVP-RESEARCH.md) · [Paper probe](farm/swarm/combo-probe/)

## Autonomous speedrun

The campaign moves through milestones for survival, iron, a lava-cast portal, Nether resources, stronghold routing and the dragon. The strategic graph compares prerequisites, costs and risks. It checks results against fresh observations. Tactical and emergency behavior can take over to handle immediate danger.

| Stage | Current development status |
| --- | --- |
| Overworld → Nether | Reached in test series on selected seeds. Early food, equipment and portal access still vary by world. |
| Nether → Stronghold → End | Current bottleneck. Bastion entry, bartering, blaze rods and fortress routing have individual scenarios. Consecutive success in the full route remains open. |
| Dragon fight | Repeated wins from prepared End entries. These trials start with a known loadout and measure the fight. |
| Fresh world → Dragon | Experimental campaign. A repeatable full clear is an open milestone. |

The default knowledge mode is `rsg`. A fair run uses observations available to the bot, without operator permissions or administrative commands. The test farm can stage scenarios, select seeds and run controlled comparisons. See the [speedrun notes](SPEEDRUN.md) and [PvP mechanics notes](PVP-RESEARCH.md).

## How it fits together

[![Architecture showing the campaign, arena coordinator and MCP bridge connected to bot daemons and Paper](docs/media/architecture.svg)](docs/media/architecture.svg)

| Component | Role |
| --- | --- |
| [Bot daemon](daemon/src/) | Owns the Mineflayer session, tick clock, navigation, inventory, combat and reflexes. Exposes local WebSocket RPC. |
| [Campaign](daemon/campaign/) and [strategy core](daemon/src/core/) | Select and run speedrun stages and skills. |
| [Arena](farm/arena/) and [swarm planner](farm/swarm/) | Build arenas, run matches, share observations and assign tasks across bot processes. |
| [MCP bridge](mcp/) | Runs over stdio and forwards `mc_*` tools to a bot daemon. |
| [Test farm](farm/) | Runs isolated Paper worlds and repeatable scenarios. |

## Run and test

Start with [Local setup and play](docs/local-play.md). It covers the Paper template, a bot-vs-human arena, the non-operator campaign, clean shutdown and MCP setup for both clients. The managed farm instructions target Windows and use Java 21 and Node.js.

From the repository root after installing the locked dependencies:

```powershell
npm.cmd run typecheck
npm.cmd test
node dist/mcp/smoke.js
```

Project constraints for coding agents are in [AGENTS.md](AGENTS.md). The bridge exposes a single bot. Use the arena coordinator to manage a whole match.

[MIT license](LICENSE).
