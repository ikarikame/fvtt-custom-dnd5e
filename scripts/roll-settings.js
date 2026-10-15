/**
 * Preserve legacy overrides when loading settings saved before the enable switch existed.
 * New worlds explicitly register the switch as false.
 * @param {object} rolls
 * @returns {boolean}
 */
export function areWeaponOverridesEnabled(rolls) {
  return rolls?.weaponTypeOverridesEnabled ?? true;
}

/**
 * Resolve attack settings once, including the inherited message visibility.
 * @param {object} rolls
 * @param {string} weaponType
 * @returns {object|undefined}
 */
export function getAttackRollSettings(rolls, weaponType) {
  const override = areWeaponOverridesEnabled(rolls) ? rolls.weaponTypes?.[weaponType] : null;
  if ( !override?.die ) return rolls.attack;
  return {
    ...override,
    rollMode: override.rollMode && override.rollMode !== "default" ? override.rollMode : rolls.attack?.rollMode
  };
}
import { validateExpressionFormula } from "./dice/expression-formula.js";

/**
 * Missing modes retain the legacy simple-die behavior.
 * @param {object} setting
 * @returns {boolean}
 */
export function isExpressionRoll(setting) {
  return setting?.mode === "expression";
}

/**
 * Validate and normalize a newly submitted configuration before changing persisted settings.
 * Disabled weapon overrides are retained without interpreting their formulas.
 * @param {object} rolls
 * @returns {void}
 */
export function validateRollConfiguration(rolls) {
  const entries = ["ability", "attack", "concentration", "initiative", "savingThrow", "skill", "tool"]
    .map(key => [key, rolls[key]]);
  if ( areWeaponOverridesEnabled(rolls) ) {
    entries.push(...Object.entries(rolls.weaponTypes ?? {}).map(([key, value]) => [`weaponTypes.${key}`, value]));
  }
  for ( const [key, value] of entries ) {
    if ( !value ) continue;
    try {
      if ( value.mode && !["simple", "expression"].includes(value.mode) ) throw new Error("Unknown formula mode.");
      if ( isExpressionRoll(value) ) value.die = validateExpressionFormula(value.die);
      else {
        const die = value.die?.trim();
        if ( !/^[1-9]\d*[dD][1-9]\d*$/.test(die ?? "") ) {
          throw new Error("Use a single NdM die, or select Expression for arithmetic formulas.");
        }
        value.die = die.toLowerCase();
      }
    } catch (error) {
      error.field = `rolls.${key}.die`;
      throw error;
    }
  }
}
