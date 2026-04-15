import { MODULE } from "../constants.js";
import {
  clampAttackCriticalLowerBound,
  getActiveD20Results,
  is2d10DieFormula,
  isEqualDiceCriticalRoll,
  isWindowCriticalRoll
} from "../critical-rules.js";
import { isCustomRoll } from "../rolls.js";

/**
 * Patch the D20Roll to apply custom roll settings.
 */
export function patchD20Roll() {
  if ( !isCustomRoll() ) return;

  libWrapper.register(MODULE.ID, "CONFIG.Dice.D20Roll.fromConfig", fromConfigPatch, "OVERRIDE");
  libWrapper.register(MODULE.ID, "CONFIG.Dice.D20Roll.prototype.configureModifiers", configureModifiersPatch, "WRAPPER");
  libWrapper.register(MODULE.ID, "CONFIG.Dice.D20Roll.prototype.validD20Roll", validD20RollPatch, "OVERRIDE");
  patchIsCriticalGetter();
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
  return is2d10DieFormula(formula);
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

/* -------------------------------------------- */

/**
 * Patch D20Roll.isCritical to support alternative 2d10 critical rules.
 */
function patchIsCriticalGetter() {
  const proto = CONFIG.Dice.D20Roll.prototype;
  if ( proto.__customDnd5eIsCriticalPatched ) return;

  const descriptor = getPropertyDescriptor(proto, "isCritical");
  const originalGetter = descriptor?.get;
  const originalValue = descriptor?.value;

  if ( typeof originalGetter !== "function" && typeof originalValue !== "function" ) return;

  if ( typeof originalGetter === "function" ) {
    Object.defineProperty(proto, "isCritical", {
      configurable: true,
      enumerable: descriptor.enumerable ?? false,
      get() {
        if ( usesAlternative2d10CriticalRule(this) ) {
          return isAlternative2d10Critical(this);
        }
        return originalGetter.call(this);
      }
    });
  } else {
    Object.defineProperty(proto, "isCritical", {
      configurable: true,
      enumerable: descriptor.enumerable ?? false,
      writable: true,
      value: function(...args) {
        if ( usesAlternative2d10CriticalRule(this) ) {
          return isAlternative2d10Critical(this);
        }
        return originalValue.call(this, ...args);
      }
    });
  }

  Object.defineProperty(proto, "__customDnd5eIsCriticalPatched", {
    configurable: true,
    enumerable: false,
    value: true,
    writable: false
  });
}

/* -------------------------------------------- */

/**
 * Get a property descriptor from an object or its prototype chain.
 * @param {object} object The object to inspect
 * @param {string} key The property key
 * @returns {PropertyDescriptor|null} The descriptor
 */
function getPropertyDescriptor(object, key) {
  let current = object;
  while ( current ) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if ( descriptor ) return descriptor;
    current = Object.getPrototypeOf(current);
  }
  return null;
}

/* -------------------------------------------- */

/**
 * Check whether the active 2d10 results are equal.
 * @param {CONFIG.Dice.D20Roll} roll The roll instance
 * @returns {boolean} Whether the active 2d10 results are equal
 */
function hasEqual2d10Results(roll) {
  return isEqualDiceCriticalRoll(roll);
}

/* -------------------------------------------- */

/**
 * Check whether the roll uses the equal-dice critical rule for a 2d10 custom die.
 * @param {CONFIG.Dice.D20Roll} roll The roll instance
 * @returns {boolean} Whether the rule applies
 */
function usesAlternative2d10CriticalRule(roll) {
  const rule = roll?.options?.customDnd5eCriticalRule;
  return ["equalDice", "window"].includes(rule) && is2d10Formula(roll?.options?.customDie);
}

/* -------------------------------------------- */

/**
 * Check whether the roll is a critical using an alternative 2d10 rule.
 * @param {CONFIG.Dice.D20Roll} roll The roll instance
 * @returns {boolean} Whether the roll is critical
 */
function isAlternative2d10Critical(roll) {
  const rule = roll?.options?.customDnd5eCriticalRule;
  if ( rule === "equalDice" ) return hasEqual2d10Results(roll);
  if ( rule === "window" ) return meets2d10CriticalWindow(roll);
  return false;
}

/* -------------------------------------------- */

/**
 * Check whether the 2d10 total meets the configured critical window.
 * @param {CONFIG.Dice.D20Roll} roll The roll instance
 * @returns {boolean} Whether the total is in the critical window
 */
function meets2d10CriticalWindow(roll) {
  const activeResults = getActiveD20Results(roll);
  if ( activeResults.length !== 2 ) return false;
  // Window crits in this patch remain 2d10-only; generic window handling for chat/UI lives in scripts/rolls.js.
  if ( !is2d10DieFormula(roll?.options?.customDie) ) return false;
  const threshold = clampAttackCriticalLowerBound(roll?.options?.customDnd5eCriticalLowerBound);
  if ( roll?.options ) roll.options.customDnd5eCriticalLowerBound = threshold;
  return isWindowCriticalRoll(roll);
}
