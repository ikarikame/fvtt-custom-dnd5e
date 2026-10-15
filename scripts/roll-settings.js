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
