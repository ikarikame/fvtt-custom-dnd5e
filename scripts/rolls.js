import { CONSTANTS } from "./constants.js";
import { clampAttackCriticalLowerBound } from "./critical-rules.js";
import { c5eLoadTemplates, getDieParts, getSetting, registerMenu, registerSetting } from "./utils.js";
import { RollsForm } from "./forms/rolls-form.js";
import { areWeaponOverridesEnabled, getAttackRollSettings, isExpressionRoll } from "./roll-settings.js";
import { validateExpressionFormula } from "./dice/expression-formula.js";

const constants = CONSTANTS.ROLLS;

/**
 * Register settings and hooks, and load templates.
 */
export function register() {
  registerSettings();
  registerHooks();

  const templates = [constants.TEMPLATE.FORM, "modules/custom-dnd5e/templates/roll-die-fields.hbs"];
  c5eLoadTemplates(templates);
}

/* -------------------------------------------- */

/**
 * Register settings.
 */
function registerSettings() {
  registerMenu(
    constants.MENU.KEY,
    {
      hint: game.i18n.localize(constants.MENU.HINT),
      label: game.i18n.localize(constants.MENU.LABEL),
      name: game.i18n.localize(constants.MENU.NAME),
      icon: constants.MENU.ICON,
      type: RollsForm,
      restricted: true,
      scope: "world",
      requiresReload: true
    }
  );

  registerSetting(
    constants.SETTING.ROLLS.KEY,
    {
      scope: "world",
      config: false,
      type: Object,
      default: {
        weaponTypeOverridesEnabled: false,
        ability: { die: "1d20", rollMode: "default" },
        attack: getDefaultAttackRollSettings(),
        concentration: { die: "1d20", rollMode: "default" },
        initiative: { die: "1d20", rollMode: "default" },
        savingThrow: { die: "1d20", rollMode: "default" },
        skill: { die: "1d20", rollMode: "default" },
        tool: { die: "1d20", rollMode: "default" }
      }
    }
  );
}

/* -------------------------------------------- */

/**
 * Register hooks.
 */
function registerHooks() {
  Hooks.on("dnd5e.preRollV2", (config, dialog, message) => {
    const hookNames = config.hookNames;
    // D&D also emits SavingThrow for death saves; their dedicated natural-1/20 rules stay native.
    if ( hookNames.includes("deathSave") || config.saveType === "death" ) return;
    const rolls = getSetting(constants.SETTING.ROLLS.KEY);

    let roll = null;
    let rollMode = null;

    let isAttackRoll = false;

    if ( hookNames.includes("concentration") ) {
      roll = rolls.concentration;
    } else if ( hookNames.includes("initiativeDialog") ) {
      roll = rolls.initiative;
    } else if ( hookNames.includes("attack") ) {
      isAttackRoll = true;
      const weaponType = config?.subject?.item?.system?.type?.value;
      roll = getAttackRollSettings(rolls, weaponType);
    } else if ( hookNames.includes("skill") ) {
      roll = rolls.skill;
      rollMode = CONFIG.DND5E?.skills[config.skill]?.rollMode;
    } else if ( hookNames.includes("tool") ) {
      roll = rolls.tool;
    } else if ( hookNames.includes("AbilityCheck") ) {
      roll = rolls.ability;
      rollMode = CONFIG.DND5E?.abilities[config.ability]?.rollMode;
    } else if ( hookNames.includes("SavingThrow") ) {
      roll = rolls.savingThrow;
      rollMode = CONFIG.DND5E?.abilities[config.ability]?.rollMode;
    }

    if ( !roll || game.user.isGM ) return;

    const expression = isExpressionRoll(roll);
    let formula;
    if ( expression ) {
      try {
        formula = validateExpressionFormula(roll.die);
      } catch (error) {
        ui.notifications.error(game.i18n.format("CUSTOM_DND5E.rolls.expression.error", { error: error.message }));
        return false;
      }
    }
    const dieParts = expression ? null : getDieParts(roll.die);
    for ( const rollConfig of config.rolls ?? [] ) {
      const options = rollConfig.options ??= {};
      if ( expression ) {
        delete options.customDie;
        options.customDnd5eExpression = formula;
      } else {
        delete options.customDnd5eExpression;
        if ( roll.die !== "1d20" && dieParts ) {
          options.customDie = roll.die;
          options.criticalSuccess = dieParts.number * dieParts.faces;
          options.criticalFailure = dieParts.number;
        }
      }

      // Apply custom windows after assigning the base die's critical thresholds.
      if ( isAttackRoll ) applyAttackCriticalRule(options, roll, dieParts);
    }

    const rollModes = ["publicroll", "gmroll", "blindroll", "selfroll"];
    if ( rollModes.includes(rollMode) ) {
      message.rollMode = rollMode;
    } else if ( rollModes.includes(roll.rollMode) ) {
      message.rollMode = roll.rollMode;
    }
  });
}

/* -------------------------------------------- */

/**
 * Get default attack roll settings.
 * @returns {object} The default attack roll settings
 */
function getDefaultAttackRollSettings() {
  return {
    die: "1d20",
    rollMode: "default",
    criticalRule: "normal",
    criticalLowerBound: 19
  };
}

/* -------------------------------------------- */

/**
 * Apply custom critical rules for attack rolls.
 * @param {object} options The roll options
 * @param {object} rollSettings The roll settings
 * @param {object|null} dieParts Parsed die parts
 */
function applyAttackCriticalRule(options, rollSettings, dieParts) {
  const criticalRule = rollSettings?.criticalRule ?? "normal";
  if ( criticalRule === "normal" ) return;

  const criticalLowerBound = Number.parseInt(rollSettings?.criticalLowerBound, 10);
  const threshold = clampAttackCriticalLowerBound(criticalLowerBound);

  options.customDnd5eCriticalRule = criticalRule;
  options.customDnd5eCriticalLowerBound = threshold;

  if ( criticalRule === "window" ) {
    options.criticalSuccess = threshold;
    return;
  }

  // Equal-dice crits only make sense for 2d10.
  if ( criticalRule === "equalDice" && !(dieParts?.number === 2 && dieParts?.faces === 10) ) {
    delete options.customDnd5eCriticalRule;
    delete options.customDnd5eCriticalLowerBound;
  }
}

/* -------------------------------------------- */

/**
 * Check if custom roll settings are applied.
 *
 * @returns {boolean} Whether custom roll settings are applied
 */
export function isCustomRoll() {
  const rolls = getSetting(constants.SETTING.ROLLS.KEY);

  if ( !rolls ) return false;

  const customRolls = [
    rolls.ability,
    rolls.attack,
    rolls.concentration,
    rolls.initiative,
    rolls.savingThrow,
    rolls.skill,
    rolls.tool,
    ...Object.values(areWeaponOverridesEnabled(rolls) ? (rolls.weaponTypes ?? {}) : {})
  ];

  return customRolls.some(setting => isExpressionRoll(setting) || (setting?.die && setting.die !== "1d20"));
}
