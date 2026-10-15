import { registerExpressionRolls } from "./expression-roll.js";

// Keep the diagnostic entry point used during testing; production registers these same types at init.
export { registerExpressionRolls as registerExpressionPrototype };

/**
 * Exercise the real Foundry parser, evaluator, serializer and D&D chat context without posting messages.
 * Call only after the world is ready. Throws on the first failed integration invariant.
 * @returns {Promise<object>} Diagnostic results to share after testing
 */
export async function testExpressionPrototype() {
  if ( !game.ready ) throw new Error("Open a world and wait for it to finish loading first.");
  const nativeClass = CONFIG.Dice.D20Roll;
  const { RollClass } = registerExpressionRolls();
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
