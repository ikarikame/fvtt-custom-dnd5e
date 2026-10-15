/* eslint jsdoc/require-jsdoc: "off" */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, SourceTextModule } from "node:vm";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

// A small Foundry boundary double, not a replacement for testing in a real world.
function environment(rolls = { attack: { die: "2d10", rollMode: "default" } }) {
  const hooks = new Map();
  const patches = new Map();
  const settings = new Map([["rolls", rolls], ["ruler-travel-time", true]]);
  const registrations = new Map();
  const errors = [];
  class Die {
    constructor({ number = 1, faces = 20, options = {} } = {}) {
      Object.assign(this, { number, faces, options, modifiers: [], results: [] });
    }

    get isValid() { return this.faces === 20; }

    get values() { return this.results.filter(result => result.active !== false).map(result => result.result); }

    get total() { return this.values.reduce((sum, value) => sum + value, 0); }

    applyAdvantage(mode) {
      this.options.advantageMode = mode;
      this.number = mode === 0 ? 1 : 2;
    }
  }
  class D20Roll {
    static ADV_MODE = { NORMAL: 0, ADVANTAGE: 1, DISADVANTAGE: -1 };

    constructor(formula, data, options = {}) {
      this.options = options;
      this.source = formula;
      this._evaluated = false;
      this.data = data;
      const [, number, faces] = formula.match(/(\d+)d(\d+)/);
      this.d20 = new Die({ number: Number(number), faces: Number(faces) });
      this.terms = [this.d20];
      if ( !options.configured ) this.configureModifiers();
    }

    // Models the 6.0.6 factory: it constructs a d20 before the upstream wrapper replaces it.
    static fromConfig(config, process) {
      config.options.criticalSuccess ??= 20;
      config.options.criticalFailure ??= 1;
      config.options.target ??= process.target;
      config.options.halflingLucky ??= process.halflingLucky;
      config.options.reliableTalent ??= process.reliableTalent;
      return new this("1d20", config.data, config.options);
    }

    get validD20Roll() { return this.d20.isValid; }

    get d20() { return this.terms?.[0]; }

    set d20(value) { (this.terms ??= [])[0] = value; }

    get dice() { return this.terms.filter(term => term instanceof Die); }

    get isCritical() { return this.d20.total >= (this.options.criticalSuccess ?? 20); }

    get isFumble() { return this.d20.total <= (this.options.criticalFailure ?? 1); }

    get total() { return this._total ?? this.d20.total; }

    get isSuccess() { return this.total >= this.options.target; }

    // Boundary double for the 6.0.6 renderer's early return on multi-value challenge dice.
    async _prepareChatRenderContext(options = {}) {
      const context = { classes: "", icons: [], isPrivate: options.isPrivate, total: this.total };
      if ( options.isPrivate || !this._evaluated || !this.validD20Roll ) return context;
      context.d20 = this.d20;
      if ( this.d20.values.length !== 1 ) return context;
      const classes = [];
      if ( this.d20.options.target && options.displayResult ) {
        classes.push(this.isSuccess || options.forceSuccess ? "success" : "failure");
      }
      if ( options.canCrit && this.isCritical ) classes.push("critical");
      if ( options.canCrit && this.isFumble && !options.forceSuccess ) classes.push("fumble");
      context.classes = classes.join(" ");
      if ( classes.includes("critical") ) context.icons = ["fa-check", "fa-check"];
      else if ( classes.includes("fumble") ) context.icons = ["fa-xmark", "fa-xmark"];
      else if ( classes.includes("success") ) context.icons = ["fa-check"];
      else if ( classes.includes("failure") ) context.icons = ["fa-xmark"];
      return context;
    }

    configureModifiers() {
      if ( !this.validD20Roll ) return;
      this.options.advantageMode ??= this.options.advantage ? 1 : this.options.disadvantage ? -1 : 0;
      this.d20.applyAdvantage(this.options.advantageMode);
      for ( const key of ["criticalSuccess", "criticalFailure", "target"] ) {
        if ( this.options[key] !== undefined ) this.d20.options[key] = this.options[key];
      }
      this.options.configured = true;
    }

    resetFormula() {}
  }
  const context = createContext({
    console,
    CONFIG: {
      Dice: { D20Die: Die, D20Roll, rolls: [], termTypes: {} },
      DND5E: { weaponTypes: { simpleM: "Simple Melee" } },
      Canvas: { rulerClass: class {} },
      Token: { movement: { actions: { walk: { label: "Walk" }, fly: { label: "Fly" } } } }
    },
    game: {
      user: { isGM: false },
      i18n: { localize: key => key, format: (key, values) => `${key}: ${JSON.stringify(values)}` },
      settings: {
        get: (module, key) => settings.get(key),
        register: (module, key, value) => registrations.set(`${module}.${key}`, value),
        settings: registrations,
        set: async (module, key, value) => settings.set(key, value),
        registerMenu: () => {}
      }
    },
    foundry: {
      utils: {
        deepClone: structuredClone,
        setProperty(object, key, value) {
          const parts = key.split(".");
          const last = parts.pop();
          const target = parts.reduce((o, part) => o[part] ??= {}, object);
          target[last] = value;
        }
      },
      applications: {
        handlebars: { loadTemplates: async () => {} },
        settings: { SettingsConfig: { reloadConfirm: () => {} } }
      },
      dice: {
        Roll: { validate: () => true, _mapLegacyRollMode: value => value },
        terms: { OperatorTerm: class { constructor(data) { Object.assign(this, data); } } }
      }
    },
    Roll: { parse: () => [{ number: 1, faces: 6 }] },
    Hooks: { on: (name, fn) => hooks.set(name, fn) },
    ui: { notifications: { error: message => errors.push(message) } },
    canvas: {
      grid: { units: "ft" }, stage: { scale: { x: 1 } }, tokens: new Map()
    },
    libWrapper: {
      register(module, path, fn, type) {
        patches.set(path, { fn, type });
        if ( !path.startsWith("CONFIG.Dice.") ) return;
        const parts = path.split(".");
        const key = parts.pop();
        const object = parts.reduce((o, part) => o[part], context);
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if ( descriptor?.get ) {
          Object.defineProperty(object, key, { configurable: true, get() { return fn.call(this); } });
        } else {
          const original = object[key];
          object[key] = function(...args) {
            return type === "WRAPPER" ? fn.call(this, original.bind(this), ...args) : fn.call(this, ...args);
          };
        }
      }
    }
  });
  const cache = new Map();
  function load(path) {
    if ( cache.has(path) ) return cache.get(path);
    const source = path.endsWith("custom-dnd5e-form.js")
      ? "export class CustomDnd5eForm { _onRender() {} }"
      : readFileSync(path, "utf8");
    const module = new SourceTextModule(source, { context, identifier: path });
    cache.set(path, module);
    return module;
  }
  async function importModule(path) {
    const module = load(resolve(root, path));
    if ( module.status === "unlinked" ) {
      await module.link((specifier, reference) => load(resolve(dirname(reference.identifier), specifier)));
    }
    if ( module.status === "linked" ) await module.evaluate();
    return module.namespace;
  }
  return { context, hooks, patches, settings, errors, importModule, D20Roll };
}

async function patchedRolls() {
  const env = environment();
  (await env.importModule("scripts/patches/d20-die.js")).patchD20Die();
  (await env.importModule("scripts/patches/d20-roll.js")).patchD20Roll();
  return env;
}

for ( const [mode, operator] of [[1, "+"], [-1, "-"]] ) {
  test(`2d10 factory retains exactly one ${operator}1d6 and upstream defaults`, async () => {
    const { D20Roll } = await patchedRolls();
    const config = { options: { customDie: "2d10", advantageMode: mode } };
    const roll = D20Roll.fromConfig(config, { target: 15, halflingLucky: true });
    assert.equal(roll.d20.number, 2);
    assert.equal(roll.d20.faces, 10);
    assert.equal(roll.terms.length, 3);
    assert.equal(roll.terms[1].operator, operator);
    assert.equal(roll.terms[2].faces, 6);
    assert.equal(roll.options.target, 15);
    assert.equal(roll.options.halflingLucky, true);
    roll.configureModifiers();
    assert.equal(roll.terms.length, 3, "reconfiguration must not duplicate the bonus");
  });
}

test("normal 2d10 and standard d20 do not acquire a bonus die", async () => {
  const { D20Roll } = await patchedRolls();
  const custom = D20Roll.fromConfig({ options: { customDie: "2d10" } }, {});
  assert.equal(custom.terms.length, 1);
  assert.equal(custom.d20.number, 2);
  const standard = D20Roll.fromConfig({ options: { advantageMode: 1 } }, {});
  assert.equal(standard.terms.length, 1);
  assert.equal(standard.d20.faces, 20);
  assert.equal(standard.d20.number, 2);
});

test("alternative criticals use only active base dice, not the d6 bonus", async () => {
  const { D20Roll } = await patchedRolls();
  const roll = D20Roll.fromConfig({ options: {
    customDie: "2d10", customDnd5eCriticalRule: "equalDice"
  } }, {});
  roll.d20.results = [{ result: 5, active: true }, { result: 5, active: true }];
  assert.equal(roll.isCritical, true);
  roll.d20.results[1].result = 6;
  assert.equal(roll.isCritical, false);
  roll.options.customDnd5eCriticalRule = "window";
  roll.options.customDnd5eCriticalLowerBound = 19;
  roll.d20.results = [{ result: 9 }, { result: 10 }, { result: 1, active: false }];
  assert.equal(roll.isCritical, true);
  roll.d20.results[0].result = 8;
  assert.equal(roll.isCritical, false);
});

test("critical helpers clamp legacy values and reject equal-dice rules for other dice", async () => {
  const env = environment();
  const helpers = await env.importModule("scripts/critical-rules.js");
  assert.equal(helpers.clampAttackCriticalLowerBound(-4), 1);
  assert.equal(helpers.clampAttackCriticalLowerBound(30), 19);
  assert.equal(helpers.clampAttackCriticalLowerBound(undefined), 19);
  assert.equal(helpers.isEqualDiceCriticalRoll({
    options: { customDie: "2d6" }, d20: { results: [{ result: 3 }, { result: 3 }] }
  }), false);
});

async function evaluatedCustomRoll(options, results, total) {
  const { D20Roll } = await patchedRolls();
  const roll = D20Roll.fromConfig({ options: {
    customDie: "2d10", criticalSuccess: 20, criticalFailure: 2, ...options
  } }, {});
  roll._evaluated = true;
  roll.d20.results = results;
  if ( total !== undefined ) roll._total = total;
  return roll;
}

test("equal 9+9 attacks render native double-check icons, including on repeated renders", async () => {
  const roll = await evaluatedCustomRoll({ customDnd5eCriticalRule: "equalDice" }, [{ result: 9 }, { result: 9 }]);
  const before = JSON.stringify(roll.d20.results);
  for ( let i = 0; i < 2; i++ ) {
    const context = await roll._prepareChatRenderContext({ canCrit: true });
    assert.equal(context.classes, "critical");
    assert.deepEqual([...context.icons], ["fa-check", "fa-check"]);
    assert.equal(context.d20, roll.d20, "preserve the native compact card's challenge total");
  }
  assert.equal(JSON.stringify(roll.d20.results), before, "rendering must not mutate the dice");
  assert.equal(roll.isCritical, true);
});

test("custom critical windows and normal 2d10 criticals use native rendering", async () => {
  for ( const options of [{ customDnd5eCriticalRule: "window", customDnd5eCriticalLowerBound: 19 }, {}] ) {
    const roll = await evaluatedCustomRoll(options, [{ result: 10 }, { result: 10 }]);
    const context = await roll._prepareChatRenderContext({ canCrit: true });
    assert.equal(context.classes, "critical");
    assert.deepEqual([...context.icons], ["fa-check", "fa-check"]);
  }
});

test("custom checks use the total against the DC but never display critical or fumble icons", async () => {
  for ( const target of [15, 25] ) {
    const roll = await evaluatedCustomRoll({ target, customDnd5eCriticalRule: "equalDice" },
      [{ result: 9 }, { result: 9 }]);
    const context = await roll._prepareChatRenderContext({ canCrit: false, displayResult: true });
    assert.equal(context.classes, target === 15 ? "success" : "failure");
    assert.deepEqual([...context.icons], [target === 15 ? "fa-check" : "fa-xmark"]);
  }
  const fumble = await evaluatedCustomRoll({}, [{ result: 1 }, { result: 1 }]);
  assert.equal((await fumble._prepareChatRenderContext({ canCrit: false })).classes, "");
});

test("private and unevaluated custom rolls never receive outcome icons", async () => {
  const roll = await evaluatedCustomRoll({ customDnd5eCriticalRule: "equalDice" }, [{ result: 9 }, { result: 9 }]);
  const hidden = await roll._prepareChatRenderContext({ canCrit: true, displayResult: true, isPrivate: true });
  assert.equal(hidden.classes, "");
  assert.deepEqual([...hidden.icons], []);
  roll._evaluated = false;
  const pending = await roll._prepareChatRenderContext({ canCrit: true });
  assert.equal(pending.classes, "");
  assert.deepEqual([...pending.icons], []);
});

test("1+1 equal-dice attacks display critical success, not conflicting fumble icons", async () => {
  const roll = await evaluatedCustomRoll({ customDnd5eCriticalRule: "equalDice" }, [{ result: 1 }, { result: 1 }]);
  const context = await roll._prepareChatRenderContext({ canCrit: true });
  assert.equal(context.classes, "critical");
  assert.deepEqual([...context.icons], ["fa-check", "fa-check"]);
});

test("normal multi-die fumbles render natively, with forceSuccess and visibility respected", async () => {
  const roll = await evaluatedCustomRoll({ target: 15 }, [{ result: 1 }, { result: 1 }]);
  const context = await roll._prepareChatRenderContext({ canCrit: true, displayResult: true });
  assert.equal(context.classes, "failure fumble");
  assert.deepEqual([...context.icons], ["fa-xmark", "fa-xmark"]);
  const forced = await roll._prepareChatRenderContext({ canCrit: true, displayResult: true, forceSuccess: true });
  assert.equal(forced.classes, "success");
  assert.deepEqual([...forced.icons], ["fa-check"]);
  const hiddenDC = await roll._prepareChatRenderContext({ canCrit: false, displayResult: false });
  assert.equal(hiddenDC.classes, "");
  assert.deepEqual([...hiddenDC.icons], []);
});

test("native exclusions for margin and success-count dice remain untouched", async () => {
  for ( const flag of ["marginSuccess", "marginFailure", "successCount"] ) {
    const roll = await evaluatedCustomRoll({ customDnd5eCriticalRule: "equalDice" }, [{ result: 9 }, { result: 9 }]);
    if ( flag === "successCount" ) roll.d20.results[0].success = true;
    else roll.d20.options[flag] = true;
    const context = await roll._prepareChatRenderContext({ canCrit: true });
    assert.equal(context.classes, "");
    assert.deepEqual([...context.icons], []);
  }
});

test("bonus d6 affects the DC comparison but not the critical window", async () => {
  const roll = await evaluatedCustomRoll({
    advantageMode: 1, target: 20, customDnd5eCriticalRule: "window", customDnd5eCriticalLowerBound: 19
  }, [{ result: 9 }, { result: 9 }], 24);
  const context = await roll._prepareChatRenderContext({ canCrit: true, displayResult: true });
  assert.equal(context.classes, "success");
  assert.deepEqual([...context.icons], ["fa-check"]);
  assert.equal(roll.isCritical, false);
});

test("single active result and standard d20 cards continue to use native rendering", async () => {
  const roll = await evaluatedCustomRoll({ customDie: "1d12", criticalSuccess: 12 }, [{ result: 12 }]);
  const context = await roll._prepareChatRenderContext({ canCrit: true });
  assert.equal(context.classes, "critical");
  assert.deepEqual([...context.icons], ["fa-check", "fa-check"]);
  const { D20Roll } = await patchedRolls();
  const standard = D20Roll.fromConfig({ options: {} }, {});
  standard._evaluated = true;
  standard.d20.results = [{ result: 20 }];
  assert.equal((await standard._prepareChatRenderContext({ canCrit: true })).classes, "critical");
});

test("player attacks receive house rules; GM attacks keep the original configuration", async () => {
  const env = environment({ attack: {
    die: "2d10", rollMode: "blindroll", criticalRule: "window", criticalLowerBound: 18
  } });
  (await env.importModule("scripts/rolls.js")).register();
  const hook = env.hooks.get("dnd5e.preRollV2");
  const config = () => ({ hookNames: ["attack"], rolls: [{ options: {} }] });
  const player = config();
  const playerMessage = {};
  hook(player, {}, playerMessage);
  assert.equal(player.rolls[0].options.customDie, "2d10");
  assert.equal(player.rolls[0].options.criticalSuccess, 18);
  assert.equal(player.rolls[0].options.customDnd5eCriticalRule, "window");
  assert.equal(playerMessage.rollMode, "blindroll");
  env.context.game.user.isGM = true;
  const gm = config();
  const gmMessage = {};
  hook(gm, {}, gmMessage);
  assert.deepEqual(gm.rolls[0].options, {});
  assert.deepEqual(gmMessage, {});
});

test("weapon settings override general attacks and legacy settings get safe UI defaults", async () => {
  const env = environment({ attack: { die: "1d20", rollMode: "default" }, weaponTypes: {
    simpleM: { die: "2d10", rollMode: "default", criticalRule: "equalDice" }
  } });
  (await env.importModule("scripts/rolls.js")).register();
  const config = {
    hookNames: ["attack"], subject: { item: { system: { type: { value: "simpleM" } } } },
    rolls: [{ options: {} }]
  };
  env.hooks.get("dnd5e.preRollV2")(config, {}, {});
  assert.equal(config.rolls[0].options.customDnd5eCriticalRule, "equalDice");
  const { RollsForm } = await env.importModule("scripts/forms/rolls-form.js");
  const context = await new RollsForm()._prepareContext();
  assert.equal(context.rolls.attack.criticalRule, "normal");
  assert.equal(context.rolls.attack.criticalLowerBound, 19);
  assert.equal(context.rolls.weaponTypes.simpleM.criticalRule, "equalDice");
  assert.equal(context.rolls.weaponTypeOverridesEnabled, true);
  assert.equal(env.settings.get("rolls").weaponTypeOverridesEnabled, undefined, "render must not mutate settings");
});

test("disabled overrides use all global attack settings for every roll and retain saved weapons", async () => {
  const saved = {
    weaponTypeOverridesEnabled: false,
    attack: { die: "2d10", rollMode: "blindroll", criticalRule: "window", criticalLowerBound: 18 },
    weaponTypes: { simpleM: { die: "1d20", rollMode: "publicroll", criticalRule: "normal" } }
  };
  const env = environment(saved);
  (await env.importModule("scripts/rolls.js")).register();
  const config = {
    hookNames: ["attack"], subject: { item: { system: { type: { value: "simpleM" } } } },
    rolls: [{ options: { target: 12 } }, {}]
  };
  const message = {};
  env.hooks.get("dnd5e.preRollV2")(config, {}, message);
  for ( const entry of config.rolls ) {
    assert.equal(entry.options.customDie, "2d10");
    assert.equal(entry.options.criticalSuccess, 18);
    assert.equal(entry.options.customDnd5eCriticalRule, "window");
  }
  assert.equal(config.rolls[0].options.target, 12);
  assert.equal(message.rollMode, "blindroll");
  assert.equal(saved.weaponTypes.simpleM.die, "1d20");
  const { RollsForm } = await env.importModule("scripts/forms/rolls-form.js");
  const context = await new RollsForm()._prepareContext();
  assert.equal(context.rolls.weaponTypeOverridesEnabled, false);
  assert.equal(context.rolls.weaponTypes.simpleM.die, "1d20");
});

test("only enabled weapon overrides activate custom patches; new settings disable overrides", async () => {
  const env = environment({ weaponTypeOverridesEnabled: false, attack: { die: "1d20" }, weaponTypes: {
    simpleM: { die: "2d10" }
  } });
  const rolls = await env.importModule("scripts/rolls.js");
  rolls.register();
  assert.equal(rolls.isCustomRoll(), false);
  assert.equal(env.context.game.settings.settings.get("custom-dnd5e.rolls").default.weaponTypeOverridesEnabled, false);
  env.settings.get("rolls").weaponTypeOverridesEnabled = true;
  assert.equal(rolls.isCustomRoll(), true);
  const { getAttackRollSettings } = await env.importModule("scripts/roll-settings.js");
  assert.equal(getAttackRollSettings(env.settings.get("rolls"), "unknown").die, "1d20");
});

test("saving disabled overrides preserves their values and they work again when enabled", async () => {
  const env = environment();
  (await env.importModule("scripts/rolls.js")).register();
  const { RollsForm } = await env.importModule("scripts/forms/rolls-form.js");
  await RollsForm.submit({}, {}, { object: {
    "rolls.weaponTypeOverridesEnabled": false,
    "rolls.attack.die": "2d10",
    "rolls.attack.rollMode": "blindroll",
    "rolls.weaponTypes.simpleM.die": "1d12",
    "rolls.weaponTypes.simpleM.rollMode": "default"
  } });
  const saved = env.settings.get("rolls");
  const { getAttackRollSettings } = await env.importModule("scripts/roll-settings.js");
  assert.equal(getAttackRollSettings(saved, "simpleM").die, "2d10");
  saved.weaponTypeOverridesEnabled = true;
  assert.equal(getAttackRollSettings(saved, "simpleM").die, "1d12");
  assert.equal(getAttackRollSettings(saved, "simpleM").rollMode, "blindroll");
});

const customExpression = "10.5 + (2 * 1d2 - 3) * (2d10kh - 0.5)";

test("expression attack settings propagate to every roll without misidentifying the inner 1d2", async () => {
  const env = environment({ weaponTypeOverridesEnabled: false, attack: {
    mode: "expression", die: customExpression, criticalRule: "normal", rollMode: "blindroll"
  }, weaponTypes: { simpleM: { die: "1d20" } } });
  const module = await env.importModule("scripts/rolls.js");
  module.register();
  assert.equal(module.isCustomRoll(), true);
  const config = {
    hookNames: ["attack"], subject: { item: { system: { type: { value: "simpleM" } } } },
    rolls: [{ options: { criticalSuccess: 19, target: 15 } }, { options: {} }]
  };
  const message = {};
  env.hooks.get("dnd5e.preRollV2")(config, {}, message);
  for ( const entry of config.rolls ) {
    assert.equal(entry.options.customDnd5eExpression, customExpression);
    assert.equal(entry.options.customDie, undefined);
    assert.equal(entry.options.criticalFailure, undefined);
  }
  assert.equal(config.rolls[0].options.criticalSuccess, 19, "keep the character's expanded critical range");
  assert.equal(message.rollMode, "blindroll");
});

test("expression factory retains native defaults, all system parts/data and exactly one advantage bonus", async () => {
  for ( const mode of [-1, 0, 1] ) {
    const env = environment({ attack: { mode: "expression", die: customExpression } });
    (await env.importModule("scripts/patches/d20-roll.js")).patchD20Roll();
    const data = { prof: 4, mod: 3 };
    const roll = env.D20Roll.fromConfig({
      options: { customDnd5eExpression: customExpression, advantageMode: mode, criticalSuccess: 19 },
      parts: ["@prof", "@mod"], data
    }, { target: 17 });
    assert.equal(roll.constructor.name, "CustomDnd5eExpressionRoll");
    assert.equal(roll.data, data);
    assert.equal(roll.options.target, 17);
    assert.equal(roll.options.criticalSuccess, 19);
    assert.equal(roll.options.criticalFailure, 1);
    assert.equal(roll.options.advantageMode, mode);
    assert.equal(roll.d20.options.customDnd5eExpression, customExpression);
    assert.equal((roll.source.match(/1d6/g) ?? []).length, mode ? 1 : 0);
    assert.ok(roll.source.endsWith(" + @prof + @mod"));
    if ( mode ) assert.ok(roll.source.includes(mode === 1 ? "+ 1d6" : "- 1d6"));
  }
});

test("expression classes are registered for old messages even with no active custom settings", async () => {
  const env = environment({ attack: { die: "1d20" }, weaponTypeOverridesEnabled: false });
  (await env.importModule("scripts/patches/d20-roll.js")).patchD20Roll();
  assert.ok(env.context.CONFIG.Dice.rolls.find(cls => cls.name === "CustomDnd5eExpressionRoll"));
  assert.ok(env.context.CONFIG.Dice.termTypes.CustomDnd5eExpressionDie);
  assert.equal(env.patches.size, 0, "standard rolls do not need factory patches");
});

test("malformed saved expressions cancel the hook rather than silently rolling a d20", async () => {
  const env = environment({ attack: { mode: "expression", die: "1d20 + @prof" } });
  (await env.importModule("scripts/rolls.js")).register();
  const config = { hookNames: ["attack"], rolls: [{ options: {} }] };
  const result = env.hooks.get("dnd5e.preRollV2")(config, {}, {});
  assert.equal(result, false);
  assert.equal(env.errors.length, 1);
  assert.deepEqual(config.rolls[0].options, {});
});

test("undefined talent interactions abort expression construction with a visible error", async () => {
  const env = environment({ attack: { mode: "expression", die: customExpression } });
  (await env.importModule("scripts/patches/d20-roll.js")).patchD20Roll();
  assert.throws(() => env.D20Roll.fromConfig({ options: {
    customDnd5eExpression: customExpression
  } }, { reliableTalent: true }), /no defined behavior/);
  assert.equal(env.errors.length, 1);
});

test("death saves and GM rolls bypass expressions even when generic SavingThrow is also present", async () => {
  const env = environment({
    attack: { mode: "expression", die: customExpression },
    savingThrow: { mode: "expression", die: customExpression }
  });
  (await env.importModule("scripts/rolls.js")).register();
  const hook = env.hooks.get("dnd5e.preRollV2");
  const death = { hookNames: ["deathSave", "SavingThrow", "d20Test"], rolls: [{ options: { target: 10 } }] };
  hook(death, {}, {});
  assert.deepEqual(death.rolls[0].options, { target: 10 });
  env.context.game.user.isGM = true;
  const gm = { hookNames: ["attack"], rolls: [{ options: {} }] };
  hook(gm, {}, {});
  assert.deepEqual(gm.rolls[0].options, {});
});

test("saving expressions preserves their mode and disabled overrides; malformed input never replaces settings", async () => {
  const env = environment();
  (await env.importModule("scripts/rolls.js")).register();
  const { RollsForm } = await env.importModule("scripts/forms/rolls-form.js");
  await RollsForm.submit({}, {}, { object: {
    "rolls.weaponTypeOverridesEnabled": false,
    "rolls.attack.mode": "expression",
    "rolls.attack.die": customExpression,
    "rolls.weaponTypes.simpleM.mode": "expression",
    "rolls.weaponTypes.simpleM.die": "pending invalid expression @data"
  } });
  const saved = env.settings.get("rolls");
  assert.equal(saved.attack.mode, "expression");
  assert.equal(saved.attack.die, customExpression);
  assert.equal(saved.weaponTypes.simpleM.die, "pending invalid expression @data");
  const context = await new RollsForm()._prepareContext();
  assert.equal(context.rolls.attack.isExpression, true);
  assert.equal(context.rolls.attack.mode, "expression");
  let field;
  const input = { setCustomValidity: () => {}, reportValidity: () => {} };
  await RollsForm.submit({}, { querySelector: selector => { field = selector; return input; } }, { object: {
    "rolls.attack.mode": "expression", "rolls.attack.die": "1d20 + @prof"
  } });
  assert.equal(env.settings.get("rolls"), saved);
  assert.equal(env.errors.length, 1);
  assert.equal(field, '[name="rolls.attack.die"]');
});

test("enabled weapon expressions override globals and legacy modes remain simple", async () => {
  const env = environment({ weaponTypeOverridesEnabled: true, attack: { die: "1d20" }, weaponTypes: {
    simpleM: { mode: "expression", die: customExpression }
  } });
  const { getAttackRollSettings, validateRollConfiguration } = await env.importModule("scripts/roll-settings.js");
  assert.equal(getAttackRollSettings(env.settings.get("rolls"), "simpleM").mode, "expression");
  const legacy = { attack: { die: " 2D10 " } };
  validateRollConfiguration(legacy);
  assert.equal(legacy.attack.die, "2d10");
  assert.equal(legacy.attack.mode, undefined);
  assert.throws(() => validateRollConfiguration({ attack: { die: customExpression } }), /select Expression/);
});

test("changing the form mode updates labels and hides equal-dice rules for expressions", async () => {
  const env = environment();
  const { RollsForm } = await env.importModule("scripts/forms/rolls-form.js");
  const listeners = [];
  const hidden = new Map();
  const mode = { value: "simple", addEventListener: (event, fn) => listeners.push(fn) };
  const input = { value: "2d10", addEventListener: () => {}, setCustomValidity: () => {} };
  const equalOption = {};
  const rule = { value: "equalDice", querySelector: () => equalOption, addEventListener: () => {} };
  const label = {};
  const group = { classList: { toggle: (name, value) => hidden.set(`bound:${name}`, value) } };
  const hint = { classList: { toggle: (name, value) => hidden.set(`hint:${name}`, value) } };
  const elements = new Map([
    ["[data-roll-formula-mode]", mode], ['input[name$=".die"]', input],
    ['select[name$=".criticalRule"]', rule], ["[data-critical-lower-bound-group]", group],
    ["[data-roll-formula-label]", label], ["[data-roll-expression-hint]", hint]
  ]);
  const fieldset = { querySelector: selector => elements.get(selector) };
  const form = new RollsForm();
  form.element = { querySelectorAll: () => [fieldset], querySelector: () => null };
  form._onRender({}, {});
  assert.equal(equalOption.disabled, false);
  assert.equal(hidden.get("hint:hidden"), true);
  mode.value = "expression";
  for ( const listener of listeners ) listener();
  assert.equal(equalOption.disabled, true);
  assert.equal(rule.value, "normal");
  assert.equal(hidden.get("hint:hidden"), false);
  assert.equal(label.textContent, "CUSTOM_DND5E.formula");
});

test("combat tracker initiative routes expressions through the native factory, preserving modifiers and cached rolls", async () => {
  const env = environment({ initiative: { mode: "expression", die: customExpression } });
  (await env.importModule("scripts/patches/d20-roll.js")).patchD20Roll();
  (await env.importModule("scripts/patches/initiative-roll.js")).patchInitiativeRoll();
  const configure = env.patches.get("CONFIG.Actor.documentClass.prototype.getInitiativeRollConfig").fn;
  const construct = env.patches.get("CONFIG.Actor.documentClass.prototype.getInitiativeRoll").fn;
  const data = { init: 4 };
  const config = configure.call({}, () => ({ parts: ["@init"], data, options: { advantage: true } }));
  assert.equal(config.options.customDnd5eExpression, customExpression);
  assert.equal(config.options.customDie, undefined);
  const original = new env.D20Roll("1d20", data, config.options);
  const actor = { getInitiativeRollConfig: () => config };
  const roll = construct.call(actor, () => original);
  assert.equal(roll.constructor.name, "CustomDnd5eExpressionRoll");
  assert.equal(roll.data, data);
  assert.equal(roll.source, "1d20 + 1d6 + @init");
  actor._cachedInitiativeRoll = roll;
  assert.equal(construct.call(actor, () => original), original);
});

test("initiative expressions leave fixed scores, explicit message modes and GM rolls native", async () => {
  const env = environment({ initiative: { mode: "expression", die: customExpression, rollMode: "blindroll" } });
  (await env.importModule("scripts/patches/d20-roll.js")).patchD20Roll();
  (await env.importModule("scripts/patches/initiative-roll.js")).patchInitiativeRoll();
  const configure = env.patches.get("CONFIG.Actor.documentClass.prototype.getInitiativeRollConfig").fn;
  const fixed = { options: { fixed: 12 } };
  assert.equal(configure.call({}, () => fixed), fixed);
  assert.equal(fixed.options.customDnd5eExpression, undefined);
  const display = env.patches.get("CONFIG.Combat.documentClass.prototype.rollInitiative").fn;
  const combat = { combatants: new Map([["id", { hidden: false }]]) };
  const wrapped = (ids, options) => options;
  assert.equal(display.call(combat, wrapped, ["id"], {}).messageMode, "blindroll");
  const explicit = { messageMode: "publicroll" };
  assert.equal(display.call(combat, wrapped, ["id"], explicit), explicit);
  env.context.game.user.isGM = true;
  const original = { options: {} };
  assert.equal(configure.call({}, () => original), original);
  assert.equal(original.options.customDnd5eExpression, undefined);
  const gmOptions = {};
  assert.equal(display.call(combat, wrapped, ["id"], gmOptions), gmOptions);
});

async function ruler(token, units = "ft") {
  const env = environment();
  env.context.canvas.grid.units = units;
  (await env.importModule("scripts/interface/ruler-travel-time.js")).register();
  if ( token ) {
    token.id = "test-token";
    token.bounds = { contains: () => true };
    env.context.canvas.tokens.set(token.id, token);
    env.hooks.get("hoverToken")(token, true);
  }
  const patch = env.patches.get("CONFIG.Canvas.rulerClass.prototype._getWaypointLabelContext").fn;
  const measure = distance => patch(() => ({}), { x: 0, y: 0, measurement: { distance } }, {});
  return { env, measure };
}

test("ruler reads the D&D 6 movement.speeds schema", async () => {
  const { measure } = await ruler({
    actor: { system: { attributes: { movement: { speeds: { walk: 30 } } } } }, document: {}
  });
  assert.equal(measure(300).travelTime.paces[1].time, "1m");
});

for ( const [units, speed] of [["mph", 3], ["kph", 4.828032]] ) {
  test(`group ruler preserves ${units} conversion and custom travel days`, async () => {
    const { measure } = await ruler({
      actor: { type: "group", system: { attributes: {
        travel: { speeds: { land: speed }, units, time: 6 }
      } } }, document: {}
    }, "mi");
    assert.equal(measure(3).travelTime.paces[1].time, "1h");
    assert.equal(measure(21).travelTime.paces[1].time, "1d 1h");
  });
}

test("ruler retains fallback paces and does not show travel time during combat", async () => {
  const { env, measure } = await ruler(null);
  assert.equal(measure(300).travelTime.paces[1].time, "1m");
  env.context.game.combat = { started: true };
  assert.equal(measure(300).travelTime, undefined);
});

test("English translations have no duplicate keys and retain the critical labels", () => {
  const text = readFileSync(resolve(root, "languages/en.json"), "utf8");
  const keys = [...text.matchAll(/^\s*"([^"]+)"\s*:/gm)].map(match => match[1]);
  assert.equal(new Set(keys).size, keys.length);
  const translations = JSON.parse(text);
  assert.equal(translations["CUSTOM_DND5E.rolls.criticalRule.equalDice"], "Equal Dice Results");
});
