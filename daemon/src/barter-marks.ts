'use strict'
function markPearls (marks, inventory, seconds) {
  const n = (Number(inventory.ender_pearl) || 0) + (Number(inventory.ender_eye) || 0)
  if (n >= 10 && marks.pearls10 === undefined) marks.pearls10 = seconds / 60
  return marks
}
export { markPearls }
