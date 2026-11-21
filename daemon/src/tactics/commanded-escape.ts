// Canonical registry of commanded escape/manoeuvre intents shared across
// tactical observation and session intent-runner (matching reflex-lock.ts).
export const COMMANDED_ESCAPE = /^(evade|juke|take_cover|douse_lava|lava_escape|clear_water|wind_jump|pearl_to|fly_to|lance|boost_lance|boost_shot|pearl_ambush|pearl_trap|pearl_test_up|jump_down|wing_orbit|burrow|block_behind|peek_shot|wind_leap|dodge_blast|clear_web|cut_ally_web)$/

// Timed offensive combos yield to active tactical defense before starting (so expired
// windows return ACTION_EXPIRED without cancelling an active route), while once running
// they stay protected by COMMANDED_ESCAPE.
export const TIMED_COMBOS = /^(boost_lance|boost_shot|pearl_trap)$/
