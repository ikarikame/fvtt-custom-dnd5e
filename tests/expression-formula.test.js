/* eslint jsdoc/require-jsdoc: "off" */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createContext, SourceTextModule } from "node:vm";
import { validateExpressionFormula } from "../scripts/dice/expression-formula.js";

const formula = "10.5 + (2 * 1d2 - 3) * (2d10kh - 0.5)";
const parserBoundary = { validate: () => true };

test("expression validation forwards the original arithmetic to Foundry without evaluating dice", () => {
  let seen;
  const parser = { validate(value) { seen = value; return true; } };
  assert.equal(validateExpressionFormula(`  ${formula}  `, parser), formula);
  assert.equal(seen, formula);
  assert.throws(() => validateExpressionFormula("1d20 +", { validate: () => false }), /Foundry could not parse/);
});

test("expression input whitelist rejects references, functions, pools, rerolls and exploding dice", () => {
  for ( const value of ["1d20 + @prof", "max(1d20, 2)", "{1d20,1d20}kh", "1d20r1", "1d6x6",
    "1d20;alert(1)", "1d20 ** 3", "1d20 // 2", "1d20[flavor]", "1d20 + Infinity"] ) {
    assert.throws(() => validateExpressionFormula(value, parserBoundary), undefined, value);
  }
});

test("expression resource limits reject excessive dice, faces, constants, nesting and token counts", () => {
  for ( const value of ["0d20", "51d2", "25d6 + 26d6", "1d1", "1d1001", "1d20 + 1000001",
    "2d10kh0", "2d10kl3", `${"(".repeat(17)}1d20${")".repeat(17)}`, `${"1d20 + ".repeat(100)}1`,
    `1d20${"+1".repeat(65)}`, "(1d20", "1d20)", "2 + 3", "", null] ) {
    assert.throws(() => validateExpressionFormula(value, parserBoundary), undefined, String(value));
  }
  for ( const value of ["50d2", "1d1000", "1d20 / 2", "2d10kh1", "3d6kl2", formula] ) {
    assert.equal(validateExpressionFormula(value, parserBoundary), value);
  }
});

test("the proposed expression really spans integer natural values 1 through 20", () => {
  // Enumerate the mathematical contract, not a replacement for Foundry evaluation.
  const counts = new Map();
  for ( const signDie of [1, 2] ) {
    for ( let a = 1; a <= 10; a++ ) {
      for ( let b = 1; b <= 10; b++ ) {
        const value = 10.5 + (((2 * signDie) - 3) * (Math.max(a, b) - 0.5));
        assert.ok(Number.isInteger(value) && value >= 1 && value <= 20);
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
  }
  assert.equal(counts.size, 20);
  assert.equal(counts.get(1), 19);
  assert.equal(counts.get(20), 19);
});

test("prototype import is inert; registration is additive and the factory preserves metadata", async () => {
  class NativeDie {
    constructor({ number = 1, faces = 20, options = {} } = {}) {
      Object.assign(this, { number, faces, options, results: [] });
    }
  }
  class NativeRoll {
    constructor(source, data, options) {
      Object.assign(this, { source, data, options });
      this.terms = [new NativeDie()];
    }

    resetFormula() {}
  }
  const config = { Dice: { D20Die: NativeDie, D20Roll: NativeRoll, termTypes: {}, rolls: [] } };
  const context = createContext({ CONFIG: config, foundry: { dice: { Roll: parserBoundary } } });
  const root = fileURLToPath(new URL("../", import.meta.url));
  const cache = new Map();
  const load = path => {
    if ( cache.has(path) ) return cache.get(path);
    const module = new SourceTextModule(readFileSync(path, "utf8"), { context, identifier: path });
    cache.set(path, module);
    return module;
  };
  const module = load(resolve(root, "scripts/dice/expression-prototype.js"));
  await module.link((specifier, reference) => load(resolve(dirname(reference.identifier), specifier)));
  await module.evaluate();
  assert.equal(config.Dice.rolls.length, 0, "no experimental behavior should activate just by loading the file");
  const { RollClass, DieClass } = module.namespace.registerExpressionPrototype();
  assert.equal(config.Dice.D20Roll, NativeRoll);
  assert.equal(config.Dice.termTypes.CustomDnd5eExpressionDie, DieClass);
  assert.equal(module.namespace.registerExpressionPrototype().RollClass, RollClass);
  assert.equal(config.Dice.rolls.length, 1);
  const options = { advantageMode: -1, target: 16, criticalSuccess: 19 };
  const roll = RollClass.fromExpression(formula, options, ["3"]);
  assert.ok(roll instanceof NativeRoll);
  assert.ok(roll.terms[0] instanceof NativeDie);
  assert.equal(roll.source, "1d20 - 1d6 + 3");
  assert.equal(roll.terms[0].expression, `(${formula})`);
  assert.equal(roll.terms[0].options.criticalSuccess, 19);
  assert.equal(roll.terms[0].options.criticalFailure, 1);
  assert.equal(roll.terms[0].options.target, 16);
  assert.equal(roll.options.advantageMode, -1);
  assert.equal(RollClass.fromExpression(formula, { advantage: true, disadvantage: true }).source, "1d20");
  const unsupported = [{ halflingLucky: true }, { reliableTalent: true }, { elvenAccuracy: true }, { minimum: 10 }];
  for ( const options of unsupported ) {
    assert.throws(() => RollClass.fromExpression(formula, options), /no defined behavior/);
  }
});
