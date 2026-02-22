import { CONSTANTS } from "./constants.js";
import { clampAttackCriticalLowerBound, isEqualDiceCriticalRoll, isWindowCriticalRoll } from "./critical-rules.js";
import { c5eLoadTemplates, getDieParts, getSetting, registerMenu, registerSetting } from "./utils.js";
import { RollsForm } from "./forms/rolls-form.js";

const constants = CONSTANTS.ROLLS;

/**
 * Register settings and hooks, and load templates.
 */
export function register() {
  registerSettings();
  registerHooks();

  const templates = [constants.TEMPLATE.FORM];
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
      roll = (rolls.weaponTypes?.[weaponType]?.die)
        ? rolls.weaponTypes[weaponType]
        : rolls.attack;
      rollMode = (rolls.weaponTypes?.[weaponType]?.rollMode && rolls.weaponTypes?.[weaponType]?.rollMode !== "default")
        ? rolls.weaponTypes[weaponType].rollMode
        : rolls.attack.rollMode;
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

    const dieParts = getDieParts(roll.die);
    if ( roll.die !== "1d20" && dieParts ) {
      config.rolls[0].options.customDie = roll.die;
      config.rolls[0].options.criticalSuccess = dieParts.number * dieParts.faces;
      config.rolls[0].options.criticalFailure = dieParts.number;
    }

    // Apply attack critical rules after default critical thresholds are assigned so custom windows are not overwritten.
    if ( isAttackRoll ) {
      applyAttackCriticalRule(config.rolls[0].options, roll, dieParts);
    }

    const rollModes = ["publicroll", "gmroll", "blindroll", "selfroll"];
    if ( rollModes.includes(rollMode) ) {
      message.rollMode = rollMode;
    } else if ( rollModes.includes(roll.rollMode) ) {
      message.rollMode = roll.rollMode;
    }
  });

  Hooks.on("renderChatMessage", highlightAlternativeCriticalChat);
  Hooks.on("renderChatMessageHTML", highlightAlternativeCriticalChat);
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
 * Highlight attack rolls in chat when using alternative 2d10 critical rules.
 * @param {ChatMessage} message The chat message
 * @param {HTMLElement|jQuery} html The rendered HTML
 */
function highlightAlternativeCriticalChat(message, html) {
  const rolls = message?.rolls ?? [];
  if ( !rolls.length ) return;

  const criticalRollIndices = [];
  for ( const [index, roll] of rolls.entries() ) {
    if ( !isAlternativeCriticalRoll(roll) ) continue;
    criticalRollIndices.push(index);
  }

  if ( !criticalRollIndices.length ) return;

  const root = html?.[0] ?? html;
  if ( !root?.querySelectorAll ) return;

  const totals = Array.from(root.querySelectorAll(".dice-roll .dice-total"));
  for ( const rollIndex of criticalRollIndices ) {
    const total = totals[rollIndex];
    if ( !total ) continue;
    total.classList.add("success", "critical");
    total.classList.remove("failure", "fumble");
    injectCriticalIcons(total);
  }
}

/* -------------------------------------------- */

/**
 * Whether a roll qualifies as an alternative 2d10 critical.
 * @param {object} roll The roll
 * @returns {boolean} Whether the roll is an alternative critical
 */
function isAlternativeCriticalRoll(roll) {
  const rule = roll?.options?.customDnd5eCriticalRule;
  if ( !["equalDice", "window"].includes(rule) ) return false;

  if ( rule === "equalDice" ) {
    return isEqualDiceCriticalRoll(roll);
  }

  return isWindowCriticalRoll(roll);
}

/* -------------------------------------------- */

/**
 * Inject critical icons into a chat roll total if they are missing.
 * @param {HTMLElement} total The dice total element
 */
function injectCriticalIcons(total) {
  if ( total.querySelector(".icons, .fa-check-double, .fa-check") ) return;

  const icons = document.createElement("span");
  icons.classList.add("icons", `${CONSTANTS.ROLLS.ID}-critical-icons`);

  const first = document.createElement("i");
  first.classList.add("fas", "fa-check");

  const second = document.createElement("i");
  second.classList.add("fas", "fa-check");

  icons.append(first, second);
  total.append(icons);
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
    rolls.ability?.die,
    rolls.attack?.die,
    rolls.concentration?.die,
    rolls.initiative?.die,
    rolls.savingThrow?.die,
    rolls.skill?.die,
    rolls.tool?.die,
    ...Object.values(rolls.weaponTypes ?? {}).map(weaponType => weaponType?.die)
  ];

  return customRolls.some(die => die && die !== "1d20");
}
