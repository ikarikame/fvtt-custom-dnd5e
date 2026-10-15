import { CONSTANTS, JOURNAL_HELP_BUTTON, MODULE } from "../constants.js";
import { getDieParts, getSetting, setSetting } from "../utils.js";
import { CustomDnd5eForm } from "./custom-dnd5e-form.js";
import { areWeaponOverridesEnabled, isExpressionRoll, validateRollConfiguration } from "../roll-settings.js";

/**
 * Class representing the Rolls Form.
 */
export class RollsForm extends CustomDnd5eForm {
  /**
   * Constructor for RollsForm.
   *
   * @param {...any} args
   */
  constructor(...args) {
    super(args);
    this.type = "sheet";
    this.headerButton = JOURNAL_HELP_BUTTON;
    this.headerButton.uuid = CONSTANTS.ROLLS.UUID;
  }

  /* -------------------------------------------- */

  /**
   * Default options for the form.
   *
   * @type {object}
   */
  static DEFAULT_OPTIONS = {
    actions: {
      reset: RollsForm.reset
    },
    form: {
      handler: RollsForm.submit
    },
    id: `${MODULE.ID}-rolls-form`,
    window: {
      title: "CUSTOM_DND5E.form.rolls.title"
    }
  };

  /* -------------------------------------------- */

  /**
   * Parts of the form.
   *
   * @type {object}
   */
  static PARTS = {
    form: {
      template: CONSTANTS.ROLLS.TEMPLATE.FORM
    }
  };

  /* -------------------------------------------- */

  /**
   * Prepare the context for rendering the form.
   *
   * @returns {Promise<object>} Context data
   */
  async _prepareContext() {
    const rolls = foundry.utils.deepClone(getSetting(CONSTANTS.ROLLS.SETTING.ROLLS.KEY) ?? {});
    rolls.weaponTypeOverridesEnabled = areWeaponOverridesEnabled(rolls);
    const weaponTypes = {};
    for ( const key of ["ability", "attack", "concentration", "initiative", "savingThrow", "skill", "tool"] ) {
      const setting = rolls[key] ??= {};
      setting.mode ??= "simple";
      setting.die ??= "1d20";
      setting.isExpression = isExpressionRoll(setting);
    }

    Object.entries(CONFIG.DND5E.weaponTypes).forEach(([key, value]) => {
      const die = rolls.weaponTypes?.[key]?.die || "1d20";
      const label = value;
      const rollMode = rolls.weaponTypes?.[key]?.rollMode || "default";
      const criticalRule = rolls.weaponTypes?.[key]?.criticalRule || "normal";
      const criticalLowerBound = Math.min(Number.parseInt(rolls.weaponTypes?.[key]?.criticalLowerBound, 10) || 19, 19);
      const mode = rolls.weaponTypes?.[key]?.mode ?? "simple";
      weaponTypes[key] = { die, label, rollMode, criticalRule, criticalLowerBound, mode, isExpression: mode === "expression" };
    });

    rolls.attack.criticalRule ||= "normal";
    rolls.attack.criticalLowerBound = Math.min(Number.parseInt(rolls.attack.criticalLowerBound, 10) || 19, 19);
    rolls.weaponTypes = weaponTypes;

    return {
      rolls,
      selects: {
        formulaMode: {
          choices: {
            simple: "CUSTOM_DND5E.rolls.formulaMode.simple",
            expression: "CUSTOM_DND5E.rolls.formulaMode.expression"
          }
        },
        criticalLowerBound: {
          choices: Object.fromEntries(Array.from({ length: 19 }, (_, i) => {
            const value = i + 1;
            return [value, value];
          }))
        },
        criticalRule: {
          choices: {
            normal: "CUSTOM_DND5E.rolls.criticalRule.normal",
            equalDice: "CUSTOM_DND5E.rolls.criticalRule.equalDice",
            window: "CUSTOM_DND5E.rolls.criticalRule.window"
          }
        },
        rollMode: {
          choices: {
            default: "CUSTOM_DND5E.default",
            blindroll: "CHAT.MODES.blind",
            gmroll: "CHAT.MODES.gm",
            publicroll: "CHAT.MODES.public",
            selfroll: "CHAT.MODES.self"
          }
        }
      }
    };
  }

  /* -------------------------------------------- */

  /**
   * Reset the form to default settings.
   */
  static async reset() {
    const reset = async () => {
      this.render(true);
    };

    await foundry.applications.api.DialogV2.confirm({
      window: {
        title: game.i18n.localize("CUSTOM_DND5E.dialog.reset.title")
      },
      content: `<p>${game.i18n.localize("CUSTOM_DND5E.dialog.reset.content")}</p>`,
      modal: true,
      yes: {
        label: game.i18n.localize("CUSTOM_DND5E.yes"),
        callback: async () => {
          reset();
        }
      },
      no: {
        label: game.i18n.localize("CUSTOM_DND5E.no")
      }
    });
  }

  /* -------------------------------------------- */

  /**
   * Submit the form data.
   *
   * @param {Event} event The event that triggered the action.
   * @param {HTMLFormElement} form The form element.
   * @param {object} formData The form data.
   */
  static async submit(event, form, formData) {
    const rolls = {};

    Object.entries(formData.object).forEach(([key, value]) => {
      if ( key.startsWith("rolls") ) {
        foundry.utils.setProperty(rolls, key, value);
      }
    });

    try {
      validateRollConfiguration(rolls.rolls);
    } catch (error) {
      ui.notifications.error(game.i18n.format("CUSTOM_DND5E.rolls.invalidFormula", {
        field: error.field, error: error.message
      }));
      const input = form.querySelector(`[name="${error.field}"]`);
      input?.setCustomValidity(error.message);
      input?.reportValidity();
      return;
    }

    await setSetting(CONSTANTS.ROLLS.SETTING.ROLLS.KEY, {});
    await setSetting(CONSTANTS.ROLLS.SETTING.ROLLS.KEY, rolls.rolls);

    foundry.applications.settings.SettingsConfig.reloadConfirm();
  }

  /* -------------------------------------------- */

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);
    this._bindCriticalRuleVisibility();
    for ( const fieldset of this.element.querySelectorAll("fieldset") ) {
      const mode = fieldset.querySelector("[data-roll-formula-mode]");
      const label = fieldset.querySelector("[data-roll-formula-label]");
      const hint = fieldset.querySelector("[data-roll-expression-hint]");
      const input = fieldset.querySelector('input[name$=".die"]');
      if ( !mode || !input ) continue;
      const updateMode = () => {
        const expression = mode.value === "expression";
        label.textContent = game.i18n.localize(expression ? "CUSTOM_DND5E.formula" : "CUSTOM_DND5E.die");
        hint.classList.toggle("hidden", !expression);
        input.setCustomValidity("");
      };
      mode.addEventListener("change", updateMode);
      input.addEventListener("input", () => input.setCustomValidity(""));
      updateMode();
    }
    const checkbox = this.element.querySelector('[name="rolls.weaponTypeOverridesEnabled"]');
    const overrides = this.element.querySelector("[data-weapon-overrides]");
    checkbox?.addEventListener("change", () => {
      overrides?.classList.toggle("hidden", !checkbox.checked);
    });
  }

  /* -------------------------------------------- */

  /**
   * Toggle lower-bound visibility based on the selected critical rule.
   */
  _bindCriticalRuleVisibility() {
    const fieldsets = this.element.querySelectorAll("fieldset");
    for ( const fieldset of fieldsets ) {
      const dieInput = fieldset.querySelector('input[name$=".die"]');
      const modeSelect = fieldset.querySelector("[data-roll-formula-mode]");
      const ruleSelect = fieldset.querySelector('select[name$=".criticalRule"]');
      const lowerBoundGroup = fieldset.querySelector("[data-critical-lower-bound-group]");
      if ( !ruleSelect || !lowerBoundGroup ) continue;

      const equalDiceOption = ruleSelect.querySelector('option[value="equalDice"]');

      const updateVisibility = () => {
        lowerBoundGroup.classList.toggle("hidden", ruleSelect.value !== "window");
      };

      const updateEqualDiceAvailability = () => {
        if ( !equalDiceOption ) return;

        const dieParts = getDieParts(dieInput?.value?.trim());
        const canUseEqualDice = modeSelect?.value !== "expression" && dieParts?.number === 2 && dieParts?.faces === 10;

        equalDiceOption.disabled = !canUseEqualDice;
        if ( !canUseEqualDice && ruleSelect.value === "equalDice" ) {
          ruleSelect.value = "normal";
        }
      };

      updateEqualDiceAvailability();
      updateVisibility();
      ruleSelect.addEventListener("change", updateVisibility);
      modeSelect?.addEventListener("change", () => {
        updateEqualDiceAvailability();
        updateVisibility();
      });
      dieInput?.addEventListener("input", () => {
        updateEqualDiceAvailability();
        updateVisibility();
      });
      dieInput?.addEventListener("change", () => {
        updateEqualDiceAvailability();
        updateVisibility();
      });
    }
  }
}
