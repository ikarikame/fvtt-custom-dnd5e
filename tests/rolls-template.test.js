/* eslint jsdoc/require-jsdoc: "off" */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Handlebars from "handlebars";

const handlebars = Handlebars.create();
handlebars.registerHelper("localize", key => key);
handlebars.registerHelper("checked", value => new Handlebars.SafeString(value ? "checked" : ""));
handlebars.registerHelper("selectOptions", (choices, options) => new Handlebars.SafeString(
  Object.entries(choices).map(([key, label]) => {
    const selected = String(options.hash.selected) === key ? " selected" : "";
    return `<option value="${key}"${selected}>${Handlebars.escapeExpression(label)}</option>`;
  }).join("")
));
handlebars.registerPartial("modules/custom-dnd5e/templates/roll-die-fields.hbs",
  readFileSync(new URL("../templates/roll-die-fields.hbs", import.meta.url), "utf8"));
const render = handlebars.compile(readFileSync(new URL("../templates/rolls-form.hbs", import.meta.url), "utf8"));
const categories = ["ability", "attack", "concentration", "initiative", "savingThrow", "skill", "tool"];

function view(enabled) {
  return {
    rolls: {
      ...Object.fromEntries(categories.map(key => [key, { mode: "simple", die: "1d20" }])),
      weaponTypeOverridesEnabled: enabled,
      weaponTypes: {
        simpleM: { mode: "simple", die: "2d10", label: "Simple Melee" },
        martialM: { mode: "expression", die: "1d20 + 3", isExpression: true, label: "Martial Melee" }
      }
    },
    selects: {
      formulaMode: { choices: { simple: "Simple", expression: "Expression" } },
      rollMode: { choices: { default: "Default" } },
      criticalRule: { choices: { normal: "Normal", equalDice: "Equal Dice", window: "Window" } },
      criticalLowerBound: { choices: { 19: 19 } }
    }
  };
}

test("real Handlebars renders unique mode/formula field names in all categories and weapon rows", () => {
  const html = render(view(true));
  const names = [...html.matchAll(/name="([^"]+)"/g)].map(match => match[1]);
  assert.equal(names.length, new Set(names).size);
  for ( const prefix of [...categories.map(key => `rolls.${key}`),
    "rolls.weaponTypes.simpleM", "rolls.weaponTypes.martialM"] ) {
    assert.ok(names.includes(`${prefix}.mode`), prefix);
    assert.ok(names.includes(`${prefix}.die`), prefix);
  }
  assert.equal((html.match(/data-roll-formula-mode/g) ?? []).length, 9);
});

test("disabling overrides hides them without disabling or removing their saved input values", () => {
  const html = render(view(false));
  assert.ok(html.includes('data-weapon-overrides class="hidden"'));
  assert.ok(html.includes('name="rolls.weaponTypes.simpleM.die" type="text" value="2d10"'));
  assert.ok(!html.includes(" disabled"));
  assert.ok(render(view(true)).includes('data-weapon-overrides class=""'));
});

test("expression fields select the right mode, show the hint and escape dirty settings", () => {
  const context = view(true);
  context.rolls.attack = { mode: "expression", isExpression: true, die: '1d20 + "<script>"' };
  const html = render(context);
  assert.equal((html.match(/value="expression" selected/g) ?? []).length, 2);
  assert.equal((html.match(/class="hint " data-roll-expression-hint/g) ?? []).length, 2);
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});
