import { validateExpressionFormula } from "./expression-formula.js";

/**
 * Experimental native-dice integration. Nothing is patched or registered on import.
 * Run testExpressionPrototype() in a disposable Foundry world before exposing this in settings.
 * This prototype intentionally uses digital evaluation only and never creates chat messages.
 * @returns {{DieClass: Function, RollClass: Function}}
 */
export function registerExpressionPrototype() {
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
      return inner.evaluate({ ...options, allowInteractive: false }).then(complete);
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
     * This is a prototype factory, not a replacement of the system factory.
     * @param {string} expression
     * @param {object} [options={}]
     * @param {string[]} [parts=[]]
     * @returns {CustomDnd5eExpressionRoll}
     */
    static fromExpression(expression, options = {}, parts = []) {
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
      return new this(`1d20${bonus}${suffix}`, {}, {
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

/**
 * Exercise the real Foundry parser, evaluator, serializer and D&D chat context without posting messages.
 * Call only after the world is ready. Throws on the first failed integration invariant.
 * @returns {Promise<object>} Diagnostic results to share after testing
 */
export async function testExpressionPrototype() {
  if ( !game.ready ) throw new Error("Open a world and wait for it to finish loading first.");
  const nativeClass = CONFIG.Dice.D20Roll;
  const { RollClass } = registerExpressionPrototype();
  const checks = [];
  const check = (name, ok) => {
    checks.push({ check: name, passed: !!ok });
    if ( !ok ) throw new Error(`Expression prototype failed: ${name}`);
  };
  const expression = "10.5 + (2 * 1d2 - 3) * (2d10kh - 0.5)";
  const samples = [];
  for ( const mode of [0, 1, -1] ) {
    const roll = RollClass.fromExpression(expression, { advantageMode: mode, target: 15 }, ["3"]);
    await roll.evaluate({ allowInteractive: false });
    const natural = roll.d20.total;
    check(`mode ${mode}: natural result is an integer from 1 to 20`, Number.isInteger(natural)
      && natural >= 1 && natural <= 20);
    const bonus = roll.dice.filter(die => die.faces === 6);
    check(`mode ${mode}: exactly the expected bonus dice`, bonus.length === (mode ? 1 : 0));
    check(`mode ${mode}: native total includes natural, signed d6 and system modifier`,
      roll.total === natural + (mode * (bonus[0]?.total ?? 0)) + 3);
    check(`mode ${mode}: internal dice remain visible`, roll.dice.some(die => die.faces === 2)
      && roll.dice.some(die => die.faces === 10));

    const data = JSON.parse(JSON.stringify(roll.toJSON()));
    const restored = foundry.dice.Roll.fromData(data);
    check(`mode ${mode}: native roundtrip retains roll class, natural result and total`,
      restored instanceof RollClass && restored instanceof nativeClass
      && restored.d20.total === natural && restored.total === roll.total);
    check(`mode ${mode}: nested roll and discarded dice survive serialization`,
      JSON.stringify(restored.d20.expressionRoll.toJSON()) === JSON.stringify(roll.d20.expressionRoll.toJSON()));
    check(`mode ${mode}: native tooltip renders`, typeof await restored.getTooltip() === "string");
    const clone = restored.clone();
    check(`mode ${mode}: clone is unevaluated`, !clone._evaluated);
    await clone.evaluate({ allowInteractive: false });
    check(`mode ${mode}: clone does not duplicate the bonus`,
      clone.dice.filter(die => die.faces === 6).length === (mode ? 1 : 0));
    samples.push({ mode, natural, total: roll.total, formula: roll.formula });
  }

  const criticalCases = [[20, -1, true, false], [19, 1, false, false], [1, 1, false, true]];
  for ( const [natural, mode, critical, fumble] of criticalCases ) {
    const roll = RollClass.fromExpression(`${natural} + 0 * 1d2`, { advantageMode: mode });
    await roll.evaluate({ allowInteractive: false });
    check(`natural ${natural}: critical and fumble ignore the bonus`, roll.isCritical === critical
      && roll.isFumble === fumble);
    const attack = await roll._prepareChatRenderContext({ canCrit: true, displayResult: false });
    const skill = await roll._prepareChatRenderContext({ canCrit: false, displayResult: false });
    check(`natural ${natural}: native attack styling`, attack.classes.includes("critical") === critical
      && attack.classes.includes("fumble") === fumble);
    check(`natural ${natural}: native check styling has no critical or fumble`,
      !skill.classes.includes("critical") && !skill.classes.includes("fumble"));
  }
  check("global system D20Roll is unchanged", CONFIG.Dice.D20Roll === nativeClass);
  console.table(checks);
  return { passed: checks.length, samples, foundry: game.version, dnd5e: game.dnd5e.version };
}
