export const MODULE_ID = "dc20-combat-system";

const MIN_DICE = 2;
const MAX_DICE = 4;

/**
 * Patch D20Roll so it natively supports 2, 3, or 4 dice for Advantage (kh) and Disadvantage (kl).
 */
export function registerMultiAdvantagePatches() {
  const D20Roll = CONFIG.Dice?.D20Roll;
  if (!D20Roll || D20Roll.prototype._dc20csPatched) return;

  const origConfigureModifiers = D20Roll.prototype.configureModifiers;
  D20Roll.prototype.configureModifiers = function (...args) {
    const result = origConfigureModifiers.apply(this, args);
    if (!this.validD20Roll) return result;

    const d20 = this.terms[0];
    if (this.hasAdvantage) {
      const count = Number(this.options.dc20AdvDice ?? this.options.dc20DiceCount);
      if (Number.isInteger(count) && count >= MIN_DICE && count <= MAX_DICE) {
        d20.number = count;
        if (!d20.modifiers.includes("kh")) d20.modifiers.push("kh");
        d20.options.advantage = true;
        this.options.dc20DiceCount = count;
        this._formula = this.constructor.getFormula(this.terms);
      }
    } else if (this.hasDisadvantage) {
      const count = Number(this.options.dc20DisDice ?? this.options.dc20DiceCount);
      if (Number.isInteger(count) && count >= MIN_DICE && count <= MAX_DICE) {
        d20.number = count;
        if (!d20.modifiers.includes("kl")) d20.modifiers.push("kl");
        d20.options.disadvantage = true;
        this.options.dc20DiceCount = count;
        this._formula = this.constructor.getFormula(this.terms);
      }
    }
    return result;
  };

  if (typeof D20Roll.prototype._onDialogSubmit === "function") {
    const origOnDialogSubmit = D20Roll.prototype._onDialogSubmit;
    D20Roll.prototype._onDialogSubmit = function (html, advantageMode, ...rest) {
      const root = html instanceof HTMLElement ? html : html?.[0];
      const dialogEl = root?.closest?.(".app, .application") ?? root;
      const advDice = Number(root?.dataset?.dc20AdvDice ?? dialogEl?.dataset?.dc20AdvDice) || 2;
      const disDice = Number(root?.dataset?.dc20DisDice ?? dialogEl?.dataset?.dc20DisDice) || 2;

      if (advantageMode === D20Roll.ADV_MODE.ADVANTAGE) {
        this.options.dc20AdvDice = advDice;
        this.options.dc20DiceCount = advDice;
      } else if (advantageMode === D20Roll.ADV_MODE.DISADVANTAGE) {
        this.options.dc20DisDice = disDice;
        this.options.dc20DiceCount = disDice;
      } else {
        this.options.dc20DiceCount = 1;
      }

      return origOnDialogSubmit.call(this, html, advantageMode, ...rest);
    };
  }

  const origToMessage = D20Roll.prototype.toMessage;
  D20Roll.prototype.toMessage = async function (messageData = {}, options = {}) {
    const diceCount = Number(this.options.dc20DiceCount ?? this.dice?.[0]?.number ?? 1);
    if (diceCount >= MIN_DICE && (this.hasAdvantage || this.hasDisadvantage)) {
      foundry.utils.setProperty(messageData, `flags.${MODULE_ID}.d20`, {
        mode: this.hasAdvantage ? "advantage" : "disadvantage",
        diceCount,
        tier: diceCount - 1
      });
    }

    // Temporarily customize flavor if >2 dice were rolled
    const baseFlavor = messageData.flavor || this.options.flavor || "";
    const result = await origToMessage.call(this, messageData, options);

    if (diceCount > 2 && messageData.flavor) {
      const tier = diceCount - 1;
      const tag = game.i18n.format(
        this.hasAdvantage ? "DC20CS.Advantage.ChatTag" : "DC20CS.Disadvantage.ChatTag",
        { tier, dice: diceCount }
      );
      const customFlavor = `${baseFlavor} (${tag})`;
      if (result instanceof ChatMessage && result.flavor !== customFlavor) {
        await result.update({ flavor: customFlavor });
      }
    }
    return result;
  };

  D20Roll.prototype._dc20csPatched = true;

  // Also hook dnd5e.buildRollConfig so ApplicationV2 RollConfigurationDialog rebuilds preserve dice counts
  Hooks.on("dnd5e.buildRollConfig", (app, config) => {
    if (!app) return;
    config.options ??= {};
    if (app.dc20AdvDice) config.options.dc20AdvDice = app.dc20AdvDice;
    if (app.dc20DisDice) config.options.dc20DisDice = app.dc20DisDice;
  });
}

/**
 * Format the button content for Advantage or Disadvantage with a compact 2-line layout
 * that fits cleanly inside 400px roll dialogs without clipping the + button.
 */
function buildRollButtonMarkup(type, diceCount) {
  const isAdv = type === "advantage";
  const tier = diceCount - 1;
  const baseLabel = game.i18n.localize(isAdv ? "DC20CS.Advantage.Label" : "DC20CS.Disadvantage.Label");
  const dieUnit = game.i18n.lang === "de" ? "W20" : "d20";
  const tierPrefix = tier > 1 ? `${tier}× • ` : "";

  const pips = Array.from({ length: diceCount }, (_, i) =>
    `<span class="dc20cs-die-pip ${i === 0 ? "dc20cs-die-pip-base" : "dc20cs-die-pip-extra"}"></span>`
  ).join("");

  return `
    <span class="dc20cs-roll-btn-inner">
      <span class="dc20cs-roll-btn-title">
        <i class="fa-solid ${isAdv ? "fa-angles-up" : "fa-angles-down"}"></i>
        <span>${baseLabel}</span>
      </span>
      <span class="dc20cs-roll-btn-sub">
        <span class="dc20cs-dice-tag">${tierPrefix}${diceCount}${dieUnit}</span>
        <span class="dc20cs-roll-btn-pips" aria-hidden="true">${pips}</span>
      </span>
    </span>
  `;
}

/**
 * Update the formula preview field and big d20 icon label inside the roll dialog when the user changes dice count.
 */
function updateFormulaPreview(root, mode, diceCount) {
  const formulaInput = root.querySelector('input[name="formula"]');
  const formulaSpan = root.querySelector(".formula-line .formula");
  const dieLabel = root.querySelector(".rolls .dice .label");
  const modifier = mode === "advantage" ? "kh" : "kl";
  const replacement = `${diceCount}d20${modifier}`;

  if (formulaInput) {
    if (!formulaInput.dataset.dc20BaseFormula) {
      formulaInput.dataset.dc20BaseFormula = formulaInput.value;
    }
    formulaInput.value = formulaInput.dataset.dc20BaseFormula.replace(
      /^\s*\d*d20(?:k[hl]\d*)?/i,
      replacement
    );
  }

  if (formulaSpan) {
    if (!formulaSpan.dataset.dc20BaseFormula) {
      formulaSpan.dataset.dc20BaseFormula = formulaSpan.textContent.trim();
    }
    formulaSpan.textContent = formulaSpan.dataset.dc20BaseFormula.replace(
      /^\s*\d*d20(?:k[hl]\d*)?/i,
      replacement
    );
  }

  if (dieLabel) {
    dieLabel.textContent = replacement;
  }
}

/**
 * Inject the + buttons next to Advantage and Disadvantage buttons in D20 roll dialogs.
 * Supports both Foundry V1 Dialog (dnd5e 4.0) and ApplicationV2 RollConfigurationDialog (dnd5e 4.1+).
 */
export function enhanceRollDialog(app, html) {
  if (!game.settings.get(MODULE_ID, "enableMultiAdv")) return;

  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || root.querySelector(".dc20cs-roll-btn-group")) return;

  const buttonsContainer = root.querySelector(".dialog-buttons");
  if (!buttonsContainer) return;

  const advBtn =
    buttonsContainer.querySelector('button.advantage, button[data-button="advantage"], button[data-action="advantage"]');
  const disBtn =
    buttonsContainer.querySelector('button.disadvantage, button[data-button="disadvantage"], button[data-action="disadvantage"]');

  if (!advBtn || !disBtn) return;

  // Initialize state on the root element and app
  let advDice = Number(app?.dc20AdvDice ?? root.dataset.dc20AdvDice) || 2;
  let disDice = Number(app?.dc20DisDice ?? root.dataset.dc20DisDice) || 2;
  root.dataset.dc20AdvDice = String(advDice);
  root.dataset.dc20DisDice = String(disDice);

  buttonsContainer.classList.add("dc20cs-dialog-buttons");

  // Helper to wrap a button (Advantage or Disadvantage) with its + stepper button
  const setupButtonGroup = (btn, type) => {
    const isAdv = type === "advantage";
    const group = document.createElement("div");
    group.className = `dc20cs-roll-btn-group dc20cs-${type}-group`;
    group.dataset.dice = String(isAdv ? advDice : disDice);

    btn.parentNode.insertBefore(group, btn);
    btn.classList.add("dc20cs-main-roll-btn", `dc20cs-${type}-btn`);
    group.appendChild(btn);

    const plusBtn = document.createElement("button");
    plusBtn.type = "button";
    plusBtn.className = `dc20cs-plus-btn dc20cs-${type}-plus`;
    plusBtn.dataset.tooltip = game.i18n.localize(
      isAdv ? "DC20CS.Advantage.IncreaseHint" : "DC20CS.Disadvantage.IncreaseHint"
    );
    plusBtn.setAttribute(
      "aria-label",
      game.i18n.localize(isAdv ? "DC20CS.Advantage.IncreaseHint" : "DC20CS.Disadvantage.IncreaseHint")
    );
    plusBtn.innerHTML = `<i class="fa-solid fa-plus"></i>`;
    group.appendChild(plusBtn);

    const refreshGroupUI = (count, preview = false) => {
      group.dataset.dice = String(count);
      btn.innerHTML = buildRollButtonMarkup(type, count);
      plusBtn.innerHTML = count < MAX_DICE
        ? `<i class="fa-solid fa-plus"></i><span class="dc20cs-plus-next">${count + 1}d</span>`
        : `<i class="fa-solid fa-rotate-left"></i><span class="dc20cs-plus-next">2d</span>`;
      if (preview) updateFormulaPreview(root, type, count);
    };

    refreshGroupUI(isAdv ? advDice : disDice, false);

    // Left-click: increment 2 -> 3 -> 4 -> 2
    plusBtn.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (isAdv) {
        advDice = advDice >= MAX_DICE ? MIN_DICE : advDice + 1;
        root.dataset.dc20AdvDice = String(advDice);
        if (app) app.dc20AdvDice = advDice;
        refreshGroupUI(advDice, true);
      } else {
        disDice = disDice >= MAX_DICE ? MIN_DICE : disDice + 1;
        root.dataset.dc20DisDice = String(disDice);
        if (app) app.dc20DisDice = disDice;
        refreshGroupUI(disDice, true);
      }
    });

    // Right-click: decrement 4 -> 3 -> 2 -> 4
    plusBtn.addEventListener("contextmenu", event => {
      event.preventDefault();
      event.stopPropagation();
      if (isAdv) {
        advDice = advDice <= MIN_DICE ? MAX_DICE : advDice - 1;
        root.dataset.dc20AdvDice = String(advDice);
        if (app) app.dc20AdvDice = advDice;
        refreshGroupUI(advDice, true);
      } else {
        disDice = disDice <= MIN_DICE ? MAX_DICE : disDice - 1;
        root.dataset.dc20DisDice = String(disDice);
        if (app) app.dc20DisDice = disDice;
        refreshGroupUI(disDice, true);
      }
    });

    // Ensure clicking the main button in ApplicationV2 also records the chosen dice count on the app's rolls
    btn.addEventListener("click", () => {
      const chosenCount = isAdv ? advDice : disDice;
      if (app?.rolls?.length) {
        for (const r of app.rolls) {
          r.options.dc20AdvDice = advDice;
          r.options.dc20DisDice = disDice;
          r.options.dc20DiceCount = chosenCount;
        }
      }
    }, { capture: true });
  };

  setupButtonGroup(advBtn, "advantage");
  setupButtonGroup(disBtn, "disadvantage");

  // Resize dialog window height if needed so buttons fit comfortably
  if (typeof app?.setPosition === "function") {
    requestAnimationFrame(() => {
      try {
        app.setPosition({ height: "auto" });
      } catch (_e) {
        // Ignore on V2 dialogs that manage height automatically
      }
    });
  }
}
