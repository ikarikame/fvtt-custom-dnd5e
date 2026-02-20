import { MODULE } from "../constants.js";
import { isCustomRoll } from "../rolls.js";

/**
 * Patch the D20Roll to apply custom roll settings.
 */
export function patchD20Roll() {
  if ( !isCustomRoll() ) return;

  libWrapper.register(MODULE.ID, "CONFIG.Dice.D20Roll.fromConfig", fromConfigPatch, "OVERRIDE");
  libWrapper.register(MODULE.ID, "CONFIG.Dice.D20Roll.prototype.configureModifiers", configureModifiersPatch, "WRAPPER");
  libWrapper.register(MODULE.ID, "CONFIG.Dice.D20Roll.prototype.validD20Roll", validD20RollPatch, "OVERRIDE");
}

/* -------------------------------------------- */

/**
 * Override the fromConfig method to support custom dice.
 * @param {object} config The roll configuration
 * @param {object} process The process data
 * @returns {CONFIG.Dice.D20Roll} The configured D20Roll
 */
function fromConfigPatch(config, process) {
  const baseDie = config.options?.customDie || new CONFIG.Dice.D20Die().formula;
  const formula = [baseDie].concat(config.parts ?? []).join(" + ");
  config.options.target ??= process.target;
  return new this(formula, config.data, config.options);
}

/* -------------------------------------------- */

/**
 * Wrapper for configuring modifiers to support custom dice.
 * @param {Function} wrapped The original function
 */
function configureModifiersPatch(wrapped) {
  if ( this.options.customDie ) this.d20.options.customDie = this.options.customDie;

  wrapped();

  apply2d10AdvantageHouseRule(this);
}

/* -------------------------------------------- */

/**
 * Override the validD20Roll method to support custom dice.
 * @returns {boolean} Whether the roll is valid
 */
function validD20RollPatch() {
  return !!this.options.customDie || ((this.d20 instanceof CONFIG.Dice.D20Die) && this.d20.isValid);
}

/* -------------------------------------------- */

/**
 * Get the selected advantage mode from roll options.
 * @param {object} options Roll options.
 * @returns {number} Advantage mode constant.
 */
function getAdvantageMode(options) {
  const advModes = CONFIG.Dice.D20Roll.ADV_MODE;

  if ( Number.isInteger(options.advantageMode) ) return options.advantageMode;
  if ( options.advantage === true ) return advModes.ADVANTAGE;
  if ( options.disadvantage === true ) return advModes.DISADVANTAGE;
  return advModes.NORMAL;
}

/* -------------------------------------------- */

/**
 * Check whether a formula starts with 2d10.
 * @param {string} formula The base die formula.
 * @returns {boolean} Whether the term matches.
 */
function is2d10Formula(formula) {
  return /^\s*2d10\b/i.test(formula ?? "");
}

/* -------------------------------------------- */

/**
 * Apply house rule for 2d10 advantage/disadvantage after modifiers are configured.
 * @param {CONFIG.Dice.D20Roll} roll The roll instance.
 */
function apply2d10AdvantageHouseRule(roll) {
  if ( !roll?.options || roll.options.__houseRule2d10Applied ) return;
  if ( !is2d10Formula(roll.options.customDie) ) return;

  const dieOptions = roll.d20?.options ?? {};
  const advantageMode = getAdvantageMode({ ...roll.options, ...dieOptions });
  const advModes = CONFIG.Dice.D20Roll.ADV_MODE;
  if ( ![advModes.ADVANTAGE, advModes.DISADVANTAGE].includes(advantageMode) ) return;

  roll.options.__houseRule2d10Applied = true;
  roll.options.advantageMode = advModes.NORMAL;
  roll.options.advantage = false;
  roll.options.disadvantage = false;
  if ( roll.d20?.options ) roll.d20.options.advantageMode = advModes.NORMAL;

  const sign = (advantageMode === advModes.ADVANTAGE) ? "+" : "-";
  const bonusTerms = Roll.parse("1d6");
  roll.terms.push(new foundry.dice.terms.OperatorTerm({ operator: sign }));
  roll.terms.push(...(Array.isArray(bonusTerms) ? bonusTerms : (bonusTerms?.terms ?? [])));
  roll.resetFormula();
}
