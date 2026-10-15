import { validateExpressionFormula } from "./expression-formula.js";

/**
 * Register expression challenge types for native evaluation and restoration of stored chat rolls.
 * Registration is additive: the global D20Roll implementation is never replaced.
 * @returns {{DieClass: Function, RollClass: Function}}
 */
export function registerExpressionRolls() {
  const registered = CONFIG.Dice.rolls.find(cls => cls.name === "CustomDnd5eExpressionRoll");
  if ( registered ) return { DieClass: CONFIG.Dice.termTypes.CustomDnd5eExpressionDie, RollClass: registered };

  class CustomDnd5eExpressionDie extends CONFIG.Dice.D20Die {
    /** @override */
    get expression() { return `(${this.options.customDnd5eExpression})`; }

    /** @override */
    get isValid() { return true; }

    /**
     * Restore the nested native roll, including its discarded dice, from serialized term options.
     * @returns {Roll|undefined}
     */
    get expressionRoll() {
      if ( !this._expressionRoll && this.options.customDnd5eExpressionRoll ) {
        this._expressionRoll = foundry.dice.Roll.fromData(this.options.customDnd5eExpressionRoll);
      }
      return this._expressionRoll;
    }

    /** @override */
    get dice() { return this.expressionRoll?.dice ?? []; }

    /** @override */
    _evaluate(options = {}) {
      const formula = validateExpressionFormula(this.options.customDnd5eExpression);
      const inner = new foundry.dice.Roll(formula);
      const complete = () => {
        if ( !Number.isFinite(inner.total) ) throw new Error("The expression produced a non-finite result.");
        this._expressionRoll = inner;
        this.options.customDnd5eExpressionRoll = inner.toJSON();
        this.results = [{ result: inner.total, active: true }];
        return this;
      };
      if ( options.maximize || options.minimize ) {
        inner.evaluateSync(options);
        return complete();
      }
      return inner.evaluate({ ...options, allowInteractive: false }).then(complete).catch(error => {
        ui.notifications.error(game.i18n.format("CUSTOM_DND5E.rolls.expression.error", { error: error.message }));
        throw error;
      });
    }
  }

  class CustomDnd5eExpressionRoll extends CONFIG.Dice.D20Roll {
    /** @override */
    constructor(formula, data = {}, options = {}) {
      // Keep the native constructor and its D20Die invariant; do not configure the placeholder.
      super(formula, data, { ...options, configured: true });
      if ( !options.customDnd5eExpression ) throw new Error("Missing expression roll metadata.");
      if ( this.terms.length ) {
        this.terms[0] = new CustomDnd5eExpressionDie({
          number: 1,
          faces: 20,
          options: { customDnd5eExpression: options.customDnd5eExpression }
        });
        this.configureModifiers();
        this.resetFormula();
      }
    }

    /** @override */
    configureModifiers() {
      const die = this.terms[0];
      if ( !(die instanceof CustomDnd5eExpressionDie) ) return;
      for ( const key of ["criticalSuccess", "criticalFailure", "target"] ) {
        if ( this.options[key] !== undefined ) die.options[key] = this.options[key];
      }
      this.options.configured = true;
    }

    /** @override */
    get dice() {
      // Expose real inner dice to tooltips, not a fictitious extra d20 for the aggregate result.
      return [...new Set(super.dice.flatMap(die => die instanceof CustomDnd5eExpressionDie ? die.dice : [die]))];
    }

    /**
     * Construct an expression challenge while retaining the native D20Roll identity.
     * @param {string} expression
     * @param {object} [options={}]
     * @param {string[]} [parts=[]]
     * @param {object} [data={}]
     * @returns {CustomDnd5eExpressionRoll}
     */
    static fromExpression(expression, options = {}, parts = [], data = {}) {
      const formula = validateExpressionFormula(expression);
      for ( const flag of ["halflingLucky", "reliableTalent", "elvenAccuracy"] ) {
        if ( options[flag] ) throw new Error(`${flag} has no defined behavior for expressions yet.`);
      }
      if ( Number.isFinite(options.minimum) || Number.isFinite(options.maximum) ) {
        throw new Error("Minimum/maximum die adjustments have no defined behavior for expressions yet.");
      }
      const mode = options.advantageMode ?? (options.advantage && !options.disadvantage ? 1
        : options.disadvantage && !options.advantage ? -1 : 0);
      const bonus = mode === 1 ? " + 1d6" : mode === -1 ? " - 1d6" : "";
      const suffix = parts.length ? ` + ${parts.join(" + ")}` : "";
      return new this(`1d20${bonus}${suffix}`, data, {
        criticalSuccess: 20,
        criticalFailure: 1,
        ...options,
        advantageMode: mode,
        customDnd5eExpression: formula
      });
    }
  }

  CONFIG.Dice.termTypes.CustomDnd5eExpressionDie = CustomDnd5eExpressionDie;
  CONFIG.Dice.rolls.push(CustomDnd5eExpressionRoll);
  return { DieClass: CustomDnd5eExpressionDie, RollClass: CustomDnd5eExpressionRoll };
}
