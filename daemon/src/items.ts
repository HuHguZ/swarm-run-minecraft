'use strict'

// Inventory and block-name vocabulary shared by every action. Pulled out of
// actions.js once mining, smelting, armour and combat all needed the same
// "what is the best thing I own for this job" answers — three copies of the
// tier list would drift apart the first time netherite showed up.

// Best tier first, so "find the first match" already means "find the best".
const TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']

// Tiers worth *making* on the spot, best first. Netherite is not craftable at
// a table and gold is left out on purpose: 32 swings is worse than the stone
// pick a bag full of rubble can always make, and the ingot is worth more
// elsewhere.
const CRAFT_TIERS = ['diamond', 'iron', 'stone', 'wooden']

// What the autopilot is allowed to spend without asking. Cobblestone and
// planks are things the bot dug itself on the way down; ingots and diamonds
// are the brain's currency, and a routine that quietly melts three iron into a
// pickaxe when three cobblestone would do is a routine nobody can trust.
const FREE_TIERS = ['stone', 'wooden']

// Swings per cell of rock. Measured on the descent that stranded the bot at
// y=-58 (diamond run, 2026-08-31): a 40-level staircase cost 166 swings, the
// next one 182, a 12-level one 37, a 2-level one 8 — 3.1 to 4.6 swings per
// level over three cells each. The surcharge over a flat 1.0 is gravel
// refilling the slot and the odd swing the server drops.
const SWINGS_PER_CELL = 1.35
// A staircase step cuts head, middle and low.
const SWINGS_PER_LEVEL = 3 * SWINGS_PER_CELL

// What has to still be in the bag when a long dig stops on its own: ten levels
// of staircase, which is one leg of the climb home, or the minute it takes to
// notice and craft. Not a round number for its own sake — that run reported
// pickaxeLeft 33 on its second-to-last descent and 25 on the last, and both
// were already too late: two calls later there was no pickaxe at all, 208
// cobblestone and a crafting table in the bag, and no way up or down.
const TOOL_RESERVE = 40
// A broken sword does not wall anyone in, so it gets a smaller line: the point
// is only that the bot is never empty-handed in a drift. Sprint is off and a
// zombie is faster than this body (README), so not fighting is not an option
// the way it is for a player who can run.
const WEAPON_RESERVE = 20

// Two planks make four sticks in the 2x2 grid — no table needed. At depth the
// bag holds planks and never sticks, so a plan that refuses to see the
// conversion refuses every craft the bot could actually do down there.
const PLANKS_PER_STICKS = 2
const STICKS_PER_CRAFT = 4

// The same idea as TOOL_RESERVE, for wood. A crafting table is four planks and
// nothing else, and without one the 3x3 grid does not exist — no stone pickaxe,
// no way home. Measured on the diamond run (2026-08-31): the brain asked for
// «палки» twice, every one of the 16 planks became a stick, and the pickaxe
// craft at y=-59 answered «для stone_pickaxe нужен верстак, а его нет ни рядом,
// ни в инвентаре» while the bag held 394 cobbled_deepslate and 30 sticks. Four
// planks were the difference between that and the climb out.
const TABLE_PLANKS = 4

// "Нарубить дров" should not require knowing the tree species in advance.
const GROUPS = {
  any_log: /_log$|_stem$/,
  any_wood: /_log$|_wood$|_stem$|_hyphae$/,
  any_planks: /_planks$/,
  any_sapling: /_sapling$/,
  any_leaves: /_leaves$/,
  any_ore: /_ore$|^ancient_debris$/,
  stone_like: /^(stone|cobblestone|deepslate|cobbled_deepslate|andesite|diorite|granite|tuff|blackstone|basalt)$/,
  any_sand: /^(sand|red_sand|gravel)$/,
  // Любой блок постройки (ямы-ловушки арены: в мире на месте ямы бывает не тот блок, что в модели — «не вижу cut_sandstone»).
  arena_block: /sandstone|quartz|_slab$|_stairs$|stone|bricks|terracotta|concrete|_planks$|cobble|^dirt$|^sand$|^gravel$/,
  any_bed: /_bed$/,
  any_container: /^(chest|trapped_chest|barrel|ender_chest)$/,
  any_furnace: /^(furnace|blast_furnace|smoker)$/
}

// ---------------------------------------------------------------- tools

function toolKindFor (blockName) {
  if (/_log$|_wood$|planks|_door$|crafting_table|chest|bookshelf|barrel|fence|ladder|sign/.test(blockName)) return 'axe'
  if (/dirt|grass_block|sand|gravel|clay|soul_sand|soul_soil|podzol|mycelium|farmland|snow/.test(blockName)) return 'shovel'
  if (/leaves|wool|web/.test(blockName)) return null
  return 'pickaxe'
}

// Swings left in a tool. Blocks that never wear out report Infinity so the
// callers can treat everything the same.
function usesLeft (item) {
  if (!item || !item.maxDurability) return Infinity
  return item.maxDurability - (item.durabilityUsed || 0)
}

// Total swings of a given kind in the bag. The number the brain needs before
// committing to a hundred-block descent.
function toolBudget (bot, kind) {
  return bot.inventory.items()
    .filter(i => i.name.endsWith(`_${kind}`) && TIERS.includes(i.name.slice(0, -kind.length - 1)))
    .reduce((n, i) => n + usesLeft(i), 0)
}

// The sum is the right number for deciding *can I still get home*: bestOfKind
// moves to the spare the moment the held one shatters, so every swing in the
// bag is really available. It is a misleading number to *report*, though —
// try-tools measured pickaxeLeft 135 for "five swings of iron plus a fresh
// stone pick", and neither the scene nor a brain reading 135 could tell the
// tool in hand was one block from breaking. So the answer carries both.
function toolStatus (bot, kind) {
  const tools = bot.inventory.items()
    .filter(i => i.name.endsWith(`_${kind}`) && TIERS.includes(i.name.slice(0, -kind.length - 1)))
    .map(i => ({ name: i.name, left: usesLeft(i) }))
    .sort((a, b) => b.left - a.left)
  const held = bot.heldItem && bot.heldItem.name.endsWith(`_${kind}`) ? usesLeft(bot.heldItem) : null
  return {
    total: tools.reduce((n, t) => n + t.left, 0),
    count: tools.length,
    best: tools.length ? tools[0].left : 0,
    inHand: held,
    tools
  }
}

// Best tier first — but a pickaxe that shatters at y=-58 strands the bot as
// surely as a lava pocket does, and a fresh stone pick beats an iron one with
// three swings left. So: best tier that is not about to break, and if the whole
// bag is nearly spent, whatever has the most left.
function bestOfKind (bot, kind, { minUses = 8 }: any = {}) {
  if (!kind) return null
  const rank = name => TIERS.indexOf(name.slice(0, -kind.length - 1))
  const candidates = bot.inventory.items()
    .filter(i => i.name.endsWith(`_${kind}`) && rank(i.name) >= 0)
    .sort((a, b) => rank(a.name) - rank(b.name))
  if (!candidates.length) return null
  return candidates.find(i => usesLeft(i) > minUses) ||
    candidates.slice().sort((a, b) => usesLeft(b) - usesLeft(a))[0]
}

// Породу — каменной киркой, пока она есть, а железную беречь под руду: алмаз,
// золото и редстоун роняет только железо и выше (harvestTools), а лесенка и
// штрек съедают по ~4 удара на уровень. Спуск с y=16 до -54 — ~280 ударов, а у
// железной кирки их 250 (maxDurability): она кончалась бы до первой алмазной
// руды. Игрок копает штреки каменной — так и здесь. Цена — скорость: каменная
// 4 против железной 6 (Tiers), порода копается в полтора раза дольше.
// Только железная: у алмазной 1561 удар, беречь её незачем.
const BULK_ROCK = /^(stone|deepslate|cobblestone|cobbled_deepslate|andesite|diorite|granite|tuff|calcite|dripstone_block|netherrack|basalt|smooth_basalt|blackstone|sandstone|red_sandstone)$/
function conserveTool (bot, block, tool) {
  if (bot.ndPlayPolicy?.mode === 'free' || tool?.name !== 'iron_pickaxe' || !BULK_ROCK.test(block.name)) return tool
  return bot.inventory.items().find(i => i.name === 'stone_pickaxe' && usesLeft(i) > 8) || tool
}
async function equipBestTool (bot, block) {
  const tool = conserveTool(bot, block, bestOfKind(bot, toolKindFor(block.name)))
  if (tool && (!bot.heldItem || bot.heldItem.type !== tool.type)) {
    await bot.equip(tool, 'hand')
  } else if (!tool && bot.heldItem?.maxDurability) {
    // No shovel is not permission to spend the sword left over from a fight.
    // Swapping to an ordinary item also works when no empty bag slot remains.
    const safe = bot.inventory.items().find(i => !i.maxDurability)
    if (safe) await bot.equip(safe, 'hand')
    else await bot.unequip('hand')
  }
  return tool
}

// ---------------------------------------------------------------- what to craft

const TOOL_RU: any = {
  pickaxe: { nom: 'кирка', gen: 'кирки' },
  sword: { nom: 'меч', gen: 'меча' },
  shovel: { nom: 'лопата', gen: 'лопаты' },
  axe: { nom: 'топор', gen: 'топора' },
  hoe: { nom: 'мотыга', gen: 'мотыги' }
}

function swingWord (n) {
  const a = Math.abs(n) % 100
  const b = a % 10
  if (a > 10 && a < 20) return 'ударов'
  if (b === 1) return 'удар'
  if (b > 1 && b < 5) return 'удара'
  return 'ударов'
}

function cap (s) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// Which kind of tool a harvestTools list is asking for. Every entry in such a
// list is a tier of the same tool, so one word covers the whole list; null
// means something exotic (shears) and the caller falls back to naming ids.
function harvestKind (needed, mcData) {
  const kinds = new Set()
  for (const id of needed) {
    const name = mcData.items[id] ? mcData.items[id].name : ''
    const m = /_(pickaxe|axe|shovel|hoe|sword)$/.exec(name)
    if (!m) return null
    kinds.add(m[1])
  }
  return kinds.size === 1 ? [...kinds][0] : null
}

// Ingredient counts of one recipe, by item name. minecraft-data writes shaped
// recipes as a grid of ids with holes in it and shapeless ones as a flat list;
// both shapes turn up for tools depending on the entry.
function recipeNeeds (recipe, mcData) {
  const need = {}
  const add = cell => {
    if (cell === null || cell === undefined) return
    const id = typeof cell === 'object' ? cell.id : cell
    if (id === null || id === undefined || id < 0) return
    const item = mcData.items[id]
    if (!item) return
    need[item.name] = (need[item.name] || 0) + 1
  }
  if (recipe.inShape) for (const row of recipe.inShape) for (const cell of row) add(cell)
  else if (recipe.ingredients) for (const cell of recipe.ingredients) add(cell)
  return need
}

// Can the bag become a tool of this kind right now, and if not, what is short.
// Returns the first ready variant in `tiers` order, otherwise the variant it is
// closest to completing (so the message names one shopping list and not twelve),
// or null when the kind has no recipe at all.
//
// On the deepslate question: minecraft-data 1.21.11 lists three stone-tier
// variants for every stone tool — cobbled_deepslate, blackstone, cobblestone —
// which matches the vanilla #stone_tool_materials tag. A bag full of deepslate
// rubble therefore *is* a stone pickaxe. Nothing here prefers one variant over
// another; whichever the bag satisfies is the one returned, so the answer stays
// right whatever the server thinks.
// Planks of every species together. Sticks, crafting tables and the wooden
// tier all come out of this one number, and at depth the bag holds whatever
// species the surface happened to have.
function plankCount (bot) {
  return bot.inventory.items()
    .reduce((n, i) => n + (GROUPS.any_planks.test(i.name) ? i.count : 0), 0)
}

// minecraft-data writes a shaped recipe as rows of cells; anything taller or
// wider than the 2x2 inventory grid can only be made at a table (checked on
// 1.21.11: stone_pickaxe is [[9,9,9],[_,946,_],[_,946,_]], stick is [[41],[41]],
// crafting_table itself is [[41,41],[41,41]] — so the table is craftable from
// the bag, which is the whole reason this reserve is worth holding).
function recipeNeedsTable (recipe) {
  if (recipe.inShape) return recipe.inShape.length > 2 || recipe.inShape.some(row => row.length > 2)
  if (recipe.ingredients) return recipe.ingredients.length > 4
  return false
}

// Where a 3x3 grid would come from right now, or null. A table in the bag or
// one already standing within reach costs no planks; anything else costs four.
function hasTableHandy (bot, mcData) {
  if (bot.inventory.items().some(i => i.name === 'crafting_table')) return 'в рюкзаке'
  try {
    const data = mcData && mcData.blocksByName && mcData.blocksByName.crafting_table
    if (data && bot.findBlock({ matching: [data.id], maxDistance: 3 })) return 'рядом'
  } catch {}
  return null
}

// Planks that must survive whatever is being crafted. Held unconditionally and
// not only underground: the bot has no way to know it is about to go down, and
// on the surface a single log lifts the reserve anyway — which is exactly the
// case where four planks are cheap.
function plankReserve (bot, mcData) {
  if (hasTableHandy(bot, mcData)) return 0
  if (bot.inventory.items().some(i => GROUPS.any_wood.test(i.name))) return 0
  return TABLE_PLANKS
}

// What may actually be spent on sticks, tools and everything else.
function spendablePlanks (bot, mcData) {
  return Math.max(0, plankCount(bot) - plankReserve(bot, mcData))
}

// How many planks one run of this recipe eats. prismarine-recipe puts the
// consumed ingredients in `delta` with negative counts, so this covers shaped
// and shapeless recipes alike and every wood species at once.
function planksPerCraft (recipe, mcData) {
  let n = 0
  for (const d of (recipe && recipe.delta) || []) {
    if (d.count >= 0) continue
    const item = mcData.items[d.id]
    if (item && GROUPS.any_planks.test(item.name)) n += -d.count
  }
  return n
}

function craftPlan (bot, mcData, kind, { tiers = CRAFT_TIERS }: any = {}) {
  if (!mcData || !mcData.itemsByName || !mcData.recipes) return null
  const have: any = countItems(bot)
  const planks = plankCount(bot)
  const table = hasTableHandy(bot, mcData)
  let closest = null

  for (const tier of tiers) {
    const data = mcData.itemsByName[`${tier}_${kind}`]
    if (!data) continue
    for (const recipe of mcData.recipes[data.id] || []) {
      const need = recipeNeeds(recipe, mcData)
      const missing = []
      const pre = []
      // The table comes off the top of the plank pile, before a single plank is
      // allowed to become a stick — otherwise the plan promises a craft that
      // cannot happen, which is exactly what «можно скрафтить stone_pickaxe:
      // cobbled_deepslate×394, палок 14 (нужен верстак)» was at y=-59 with zero
      // planks and no table in the world.
      const needTable = !table && recipeNeedsTable(recipe)
      const forTable = needTable ? TABLE_PLANKS : 0
      const sticksFromPlanks =
        Math.floor(Math.max(0, planks - forTable) / PLANKS_PER_STICKS) * STICKS_PER_CRAFT
      if (needTable) {
        // First in the list on purpose: the caller crafts `pre` in order, and a
        // table in the bag is what lets the sticks craft spend planks at all.
        if (planks >= TABLE_PLANKS) pre.push('crafting_table')
        else missing.push({ name: 'crafting_table', need: 1, have: 0 })
      }
      for (const [name, n] of (Object.entries(need) as [string, any][])) {
        const owned = have[name] || 0
        if (owned >= n) continue
        if (name === 'stick' && owned + sticksFromPlanks >= n) { pre.push('stick'); continue }
        missing.push({ name, need: n, have: owned })
      }
      // The handle is always sticks; the head is what the tier is named after,
      // and that is the number the brain actually wants to hear.
      const material = Object.keys(need).find(n => n !== 'stick') || null
      const plan = {
        kind,
        item: data.name,
        tier,
        uses: data.maxDurability || 0,
        material,
        materialHave: material ? (have[material] || 0) : 0,
        planks,
        sticks: have.stick || 0,
        table,
        pre,
        missing
      }
      if (!missing.length) return Object.assign(plan, { ready: true })
      const short = missing.reduce((n, m) => n + (m.need - m.have), 0)
      // `<=`, not `<`: tiers are walked best-first, so a tie has to go to the
      // *later* one. With an empty bag every tier is short the same five items
      // and strict `<` handed the advice to diamond — «не хватает diamond×3,
      // stick×2» to a bot standing on deepslate with nothing in its hands.
      // The best tool you can actually make is worth naming; the most
      // expensive one you cannot is not.
      if (!closest || short <= closest.short) closest = Object.assign(plan, { ready: false, short })
    }
  }
  return closest
}

// The half of every tool message that says what to do about it. «сделать не из
// чего» is load-bearing text: survival.js → AGAIN_WONT_HELP matches on it to
// decide whether calling surface again could possibly go better.
function fixLine (plan) {
  if (!plan) return 'и сделать не из чего: рецепта нет'
  if (plan.ready) {
    const handle = plan.pre.includes('stick')
      ? `палки из досок (${plan.planks})`
      : `палок ${plan.sticks}`
    // «нужен верстак» said nothing about whether we have one, and that was the
    // half of the message the bot needed at y=-59. Say where the table is
    // coming from, because that is the part that can be missing.
    const table = plan.table
      ? `верстак ${plan.table}`
      : plan.pre.includes('crafting_table')
        ? `верстак сделаю из досок (${plan.planks})`
        : 'верстак не нужен'
    return `можно скрафтить ${plan.item}: ${plan.material}×${plan.materialHave}, ${handle}, ${table}`
  }
  // «не хватает stick×2 (досок 4)» reads as a lie — four planks are eight
  // sticks. Naming the reserve is what turns the line into an instruction: the
  // answer is more wood, not one more attempt at the same craft.
  const held = plan.pre.includes('crafting_table') ? `, но ${TABLE_PLANKS} уйдут на верстак` : ''
  const parts = plan.missing.map(m => {
    if (m.name === 'crafting_table') return `верстак (на него ${TABLE_PLANKS} доски, а досок ${plan.planks})`
    const short = `${m.name}×${m.need - m.have}`
    return m.name === 'stick' ? `${short} (досок ${plan.planks}${held})` : short
  })
  return `и сделать не из чего: на ${plan.item} не хватает ${parts.join(', ')}`
}

// The line a long dig stops on while it still can. `need` is what the next
// piece of work costs in swings, `reserve` is what has to survive it.
//
// Asked every step rather than once at the start, so one call site is both the
// up-front refusal (nothing dug yet and the budget is already under the line)
// and the early stop. `onlyIfFixable` is for the climb out: holding a reserve
// back on the way *up* would strand the bot on purpose, so surface only stops
// when stopping is strictly better — a replacement is craftable out of what is
// already in the bag, and crafting costs no swings at all.
function toolShortfall (bot, mcData, { kind = 'pickaxe', need = 0, reserve = TOOL_RESERVE, onlyIfFixable = false }: any = {}) {
  const left = toolBudget(bot, kind)
  if (!Number.isFinite(left)) return null
  if (left >= Math.ceil(need) + reserve) return null
  const plan = craftPlan(bot, mcData, kind)
  if (onlyIfFixable && !(plan && plan.ready)) return null
  const ru = TOOL_RU[kind] || { nom: 'инструмент', gen: 'инструмента' }
  const head = left <= 0
    ? `${cap(ru.gen)} нет вовсе`
    : `У ${ru.gen} осталось ~${left} ${swingWord(left)}, а дальше нужно ~${Math.ceil(need)}` +
      (reserve ? ` и ещё ${reserve} на дорогу назад` : '')
  return `${head} — останавливаюсь заранее. ${fixLine(plan)}`
}

// What the autopilot should make right now, or null when nothing is wrong.
// The list is two tools long on purpose.
//
// Pickaxe: mandatory. Without one the bot can neither dig nor climb, and at
// y=-58 that is not a setback but the end of the run — measured, with 208
// cobblestone and a crafting table sitting in the bag the entire time.
// Sword: sprint is off, so walking away from a zombie does not work in any
// amount (README, three separate measurements), and a body that can neither
// run nor hit dies in the drift. Two rubble and a stick.
// Shovel and axe are deliberately out: nothing in the game *requires* them to
// harvest — dirt, sand, gravel and wood all drop bare-handed — so they would
// buy digging speed with exactly the cobblestone and sticks the pickaxe and the
// sword need, and at depth there is no wood for an axe to be worth anything on.
function toolPlan (bot, mcData) {
  return wantTool(bot, mcData, 'pickaxe', TOOL_RESERVE) ||
    // Only after the pickaxe: the last three rubble belong to the tool that
    // gets the bot out, not to the one that makes the fight shorter.
    wantTool(bot, mcData, 'sword', WEAPON_RESERVE)
}

// null when this kind is fine. Otherwise `item` is what to craft, or null when
// the bag cannot produce anything better than what is already in it — the
// caller still needs to hear about that case, it is the one that strands the
// bot, and saying nothing is what the old code did.
function wantTool (bot, mcData, kind, reserve) {
  const left = toolBudget(bot, kind)
  if (!Number.isFinite(left) || left >= reserve) return null
  const free = craftPlan(bot, mcData, kind, { tiers: FREE_TIERS })
  // Never trade a working tool for a worse one: a stone pick is 131 swings and
  // there is no sense making one while 140 are still in the bag.
  if (free && free.ready && free.uses > left) {
    return { kind, left, item: free.item, pre: free.pre, uses: free.uses, why: fixLine(free) }
  }
  // Nothing free will do. When an expensive tier would, that is a decision and
  // not a routine: three ingots are worth more than the 131 swings this would
  // turn them into, and a rule that quietly melts loot is a rule nobody can
  // leave running unattended. Refusing is right; refusing in silence is not —
  // silence is exactly what left the bot standing at y=-58.
  const any = craftPlan(bot, mcData, kind, { tiers: CRAFT_TIERS })
  const why = any && any.ready && any.uses > left
    ? `сам не берусь: из рюкзака выходит только ${any.item} (${any.material}×${any.materialHave}), ` +
      'а железо и алмазы рутина не тратит — скрафти сам'
    : fixLine(any)
  return { kind, left, item: null, pre: [], uses: 0, why }
}

// ---------------------------------------------------------------- refusals

// A block with harvestTools drops nothing unless the right tool is held.
// Digging stone bare-handed for two minutes and getting zero cobblestone is
// the most demoralising way to fail, so refuse up front.
//
// The old wording listed the tiers that would do and never said the thing that
// mattered: whether the bag holds a pickaxe at all. The run that ended walled
// in at y=-58 answered «нужен инструмент (wooden_pickaxe / copper_pickaxe /
// stone_pickaxe / golden_pickaxe), а его нет» while carrying 208 cobblestone,
// 16 planks and a crafting table — everything needed to fix it — and that reads
// as a tier problem. So: name the kind, say whether we own one at all, and say
// what the bag can be turned into.
function missingHarvestTool (bot, block, mcData) {
  const data = mcData.blocks[block.type]
  if (!data || !data.harvestTools) return null
  const needed = Object.keys(data.harvestTools).map(Number)
  const have = bot.inventory.items().some(i => needed.includes(i.type))
  if (have) return null

  const kind: any = harvestKind(needed, mcData)
  const names = needed.map(id => (mcData.items[id] ? mcData.items[id].name : id))
  if (!kind || !TOOL_RU[kind]) {
    return `для ${block.name} нужен инструмент (${names.slice(0, 4).join(' / ')}), а его нет`
  }

  const ru = TOOL_RU[kind]
  // Owning the tool but not a good enough one is a different problem with a
  // different answer, and calling that "нет вовсе" would send the brain hunting
  // for sticks it does not need.
  const ours = [...new Set(bot.inventory.items()
    .filter(i => i.name.endsWith(`_${kind}`) && TIERS.includes(i.name.slice(0, -kind.length - 1)))
    .map(i => i.name))]
  if (ours.length) {
    return `для ${block.name} нужна ${ru.nom} получше (${names.slice(0, 4).join(' / ')}), ` +
      `а в рюкзаке только ${ours.join(', ')}`
  }

  return `${block.name} голыми руками не ломается, а ${ru.gen} в рюкзаке нет вовсе. ` +
    fixLine(craftPlan(bot, mcData, kind))
}

function bestWeapon (bot) {
  const items = bot.inventory.items()
  for (const tier of TIERS) {
    const sword = items.find(i => i.name === `${tier}_sword`)
    if (sword) return sword
  }
  for (const tier of TIERS) {
    const axe = items.find(i => i.name === `${tier}_axe`)
    if (axe) return axe
  }
  return items.find(i => /^(mace|trident)$|_spear$/.test(i.name)) || null
}

// ---------------------------------------------------------------- inventory

function itemNamed (bot, name) {
  return bot.inventory.items().find(i => i.name === name) || null
}

function itemMatching (bot, re) {
  return bot.inventory.items().find(i => re.test(i.name)) || null
}

function countOf (bot, name) {
  return bot.inventory.items().reduce((n, i) => n + (i.name === name ? i.count : 0), 0)
}

function countItems (bot) {
  const out: Record<string, number> = {}
  for (const i of bot.inventory.items()) out[i.name] = (out[i.name] || 0) + i.count
  return out
}

function diffItems (before, after) {
  const out = {}
  for (const [k, v] of ((Object.entries(after) as [string, any][]) as any)) {
    const d = v - (before[k] || 0)
    if (d > 0) out[k] = d
  }
  return out
}

// ---------------------------------------------------------------- names

// Accepts a single block name, a comma-separated list, or one of the GROUPS
// aliases, and returns the block ids behind it.
function resolveBlockIds (name, mcData) {
  const parts = String(name || '').split(',').map(s => s.trim()).filter(Boolean)
  if (!parts.length) throw new Error('не указано, что добывать')
  const ids = new Set<number>()
  for (const part of parts) {
    if (GROUPS[part]) {
      for (const b of ((Object.values(mcData.blocksByName) as any[]) as any)) {
        if (GROUPS[part].test(b.name)) ids.add(b.id)
      }
    } else if (mcData.blocksByName[part]) {
      ids.add(mcData.blocksByName[part].id)
    } else {
      throw new Error(`нет такого блока: ${part}. Группы: ${Object.keys(GROUPS).join(', ')}`)
    }
  }
  return [...ids]
}

// Same idea for items, so "положи в сундук any_ore" works the way mining does.
function resolveItemNames (name, bot) {
  const parts = String(name || '').split(',').map(s => s.trim()).filter(Boolean)
  if (!parts.length) return []
  const owned = new Set<string>(bot.inventory.items().map(i => i.name))
  const out = new Set<string>()
  for (const part of parts) {
    if (part === 'all' || part === 'всё' || part === 'все') {
      for (const n of owned) out.add(n)
    } else if (GROUPS[part]) {
      for (const n of owned) if (GROUPS[part].test(n)) out.add(n)
    } else {
      out.add(part)
    }
  }
  return [...out]
}

export {
  TIERS,
  CRAFT_TIERS,
  FREE_TIERS,
  GROUPS,
  SWINGS_PER_CELL,
  SWINGS_PER_LEVEL,
  TOOL_RESERVE,
  WEAPON_RESERVE,
  TABLE_PLANKS,
  toolKindFor,
  bestOfKind,
  usesLeft,
  toolBudget,
  toolStatus,
  plankCount,
  plankReserve,
  spendablePlanks,
  planksPerCraft,
  recipeNeedsTable,
  hasTableHandy,
  craftPlan,
  toolShortfall,
  toolPlan,
  equipBestTool,
  conserveTool,
  missingHarvestTool,
  bestWeapon,
  itemNamed,
  itemMatching,
  countOf,
  countItems,
  diffItems,
  resolveBlockIds,
  resolveItemNames
}
