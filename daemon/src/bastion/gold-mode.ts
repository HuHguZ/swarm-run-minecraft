// Быстрый безопасный режим золота (ND_GOLD_FAST_SAFE / p.fastSafe): ставит bastion(), читают goldExposes, burrowColumn,
// burrow, sealBody — режим последнего вызова держится и для burrow() из fortress и burrow-intent (у них пустой st).
const goldMode = { fastSafe: process.env.ND_GOLD_FAST_SAFE === '1' }

export { goldMode }
