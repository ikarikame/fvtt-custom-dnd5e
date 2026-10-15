import { MODULE } from "../constants.js";
import {
  clampAttackCriticalLowerBound,
  getActiveD20Results,
  is2d10DieFormula,
  isEqualDiceCriticalRoll,
  isWindowCriticalRoll
} from "../critical-rules.js";
import { isCustomRoll } from "../rolls.js";
import { registerExpressionRolls } from "../dice/expression-roll.js";

/**
 * Patch the D20Roll to apply custom roll settings.
 */
export function patchD20Roll() {
  // Stored expression messages must deserialize even after custom formulas have been disabled.
  registerExpressionRolls();
  if ( !isCustomRoll() ) return;

  libWrapper.register(MODULE.ID, "CONFIG.Dice.D20Roll.fromConfig", fromConfigPatch, "WRAPPER");
  libWrapper.register(MODULE.ID, "CONFIG.Dice.D20Roll.prototype.configureModifiers", configureModifiersPatch, "WRAPPER");
  libWrapper.register(MODULE.ID, "CONFIG.Dice.D20Roll.prototype.validD20Roll", validD20RollPatch, "OVERRIDE");
  libWrapper.register(
    MODULE.ID,
    "CONFIG.Dice.D20Roll.prototype._prepareChatRenderContext",
    prepareChatRenderContextPatch,
    "WRAPPER"
  );
  patchIsCriticalGetter();
}

/* -------------------------------------------- */

/**
 * Restore native outcome styling for custom multi-die challenge rolls.
 * D&D's renderer otherwise stops when the primary term has more than one active value.
 * Let the message's canCrit flag decide whether criticals are displayed, and never reveal private rolls.
 * @param {Function} wrapped
 * @param {object} [options={}]
 * @returns {Promise<object>}
 */
async function prepareChatRenderContextPatch(wrapped, options = {}) {
  const context = await wrapped(options);
  if ( !this.options.customDie || options.isPrivate || context.isPrivate || !this._evaluated
    || !this.validD20Roll ) return context;

  const die = this.d20;
  if ( !die?.results?.length || die.values.length <= 1 ) return context;
  // Preserve the native exclusions for dice using success-counting or margin modifiers.
  if ( ("success" in die.results[0]) || die.options.marginSuccess || die.options.marginFailure ) return context;

  const classes = new Set((context.classes ?? "").split(/\s+/).filter(Boolean));
  for ( const name of ["success", "failure", "critical", "fumble"] ) classes.delete(name);
  if ( die.options.target && options.displayResult ) {
    classes.add(this.isSuccess || options.forceSuccess ? "success" : "failure");
  }
  const critical = options.canCrit && this.isCritical;
  if ( critical ) classes.add("critical");
  // Equal-dice rules can make 1+1 a critical: give critical success precedence in the card as in attack resolution.
  if ( options.canCrit && !critical && this.isFumble && !options.forceSuccess ) classes.add("fumble");

  let icons = [];
  if ( classes.has("critical") ) icons = ["fa-check", "fa-check"];
  else if ( classes.has("fumble") ) icons = ["fa-xmark", "fa-xmark"];
  else if ( classes.has("success") ) icons = ["fa-check"];
  else if ( classes.has("failure") ) icons = ["fa-xmark"];
  const extraIcons = (context.icons ?? []).filter(icon => !["fa-check", "fa-xmark"].includes(icon));
  context.classes = [...classes].join(" ");
  context.icons = [...icons, ...extraIcons];
  return context;
}

/* -------------------------------------------- */

/**
 * Wrap the fromConfig method to support custom dice.
 * @param {Function} wrapped
 * @param {object} config
 * @param {object} process
 * @returns {CONFIG.Dice.D20Roll} Configured D20Roll
 */
function fromConfigPatch(wrapped, config, process) {
  const roll = wrapped(config, process);
  if ( config.options?.customDnd5eExpression ) {
    try {
      const { RollClass } = registerExpressionRolls();
      return RollClass.fromExpression(config.options.customDnd5eExpression,
        { ...roll.options, ...config.options }, config.parts ?? [], config.data ?? {});
    } catch (error) {
      ui.notifications.error(game.i18n.format("CUSTOM_DND5E.rolls.expression.error", { error: error.message }));
      throw error;
    }
  }
  const customDie = config.options?.customDie;
  if ( !customDie ) return roll;

  // Clear so the custom roll configures its own die.
  delete config.options.configured;

  const formula = [customDie].concat(config.parts ?? []).join(" + ");
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
  // The fromConfig wrapper first constructs the system's d20 roll before replacing it with the custom die.
  // Do not consume the advantage mode or add the bonus on that temporary roll.
  if ( roll.d20?.faces !== 10 ) return;

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
  // Other dice use the native criticalSuccess threshold; 2d10 needs its aggregate natural result.
  if ( !is2d10DieFormula(roll?.options?.customDie) ) return false;
  const threshold = clampAttackCriticalLowerBound(roll?.options?.customDnd5eCriticalLowerBound);
  if ( roll?.options ) roll.options.customDnd5eCriticalLowerBound = threshold;
  return isWindowCriticalRoll(roll);
}
