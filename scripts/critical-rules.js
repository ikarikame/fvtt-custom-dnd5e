import { getDieParts } from "./utils.js";

/**
 * Clamp an attack critical lower bound to the supported range.
 * @param {number|string} value The configured value
 * @returns {number} The clamped value
 */
export function clampAttackCriticalLowerBound(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, 1), 19) : 19;
}

/* -------------------------------------------- */

/**
 * Check whether a die formula is 2d10.
 * @param {string} formula The die formula
 * @returns {boolean} Whether the formula is 2d10
 */
export function is2d10DieFormula(formula) {
  const dieParts = getDieParts(formula);
  return dieParts?.number === 2 && dieParts?.faces === 10;
}

/* -------------------------------------------- */

/**
 * Get active die results from the roll's d20 term.
 * @param {object} roll The roll
 * @returns {number[]} Active result values
 */
export function getActiveD20Results(roll) {
  return (roll?.d20?.results ?? [])
    .filter(result => result?.active !== false)
    .map(result => Number.parseInt(result.result, 10))
    .filter(Number.isInteger);
}

/* -------------------------------------------- */

/**
 * Check whether a roll is a 2d10 equal-dice critical.
 * @param {object} roll The roll
 * @returns {boolean} Whether the roll is an equal-dice critical
 */
export function isEqualDiceCriticalRoll(roll) {
  if ( !is2d10DieFormula(roll?.options?.customDie) ) return false;

  const activeResults = getActiveD20Results(roll);
  return activeResults.length === 2 && activeResults[0] === activeResults[1];
}

/* -------------------------------------------- */

/**
 * Check whether a roll total meets the configured critical window.
 * @param {object} roll The roll
 * @returns {boolean} Whether the roll total is in the critical window
 */
export function isWindowCriticalRoll(roll) {
  const activeResults = getActiveD20Results(roll);
  if ( !activeResults.length ) return false;

  const threshold = clampAttackCriticalLowerBound(roll?.options?.customDnd5eCriticalLowerBound);
  return activeResults.reduce((sum, value) => sum + value, 0) >= threshold;
}
