import { MODULE_ID, enhanceRollDialog, registerMultiAdvantagePatches } from "./multi-advantage.js";
import {
  CARD_TEMPLATE,
  executeApplyConditionOnActor,
  executeApplyDamageOnActor,
  onPreCreateChatMessage,
  renderDC20AttackChatCard,
  resolveTargetActor
} from "./chat-card.js";

function registerSettings() {
  game.settings.register(MODULE_ID, "enableMultiAdv", {
    name: "DC20CS.Settings.EnableMultiAdv.Name",
    hint: "DC20CS.Settings.EnableMultiAdv.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "enableStaticDamage", {
    name: "DC20CS.Settings.EnableStaticDamage.Name",
    hint: "DC20CS.Settings.EnableStaticDamage.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => ui.chat?.render()
  });

  game.settings.register(MODULE_ID, "hideVanillaDamageButton", {
    name: "DC20CS.Settings.HideVanillaDamageButton.Name",
    hint: "DC20CS.Settings.HideVanillaDamageButton.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => ui.chat?.render()
  });
}

Hooks.once("init", () => {
  registerSettings();
  const loadHb = foundry.applications?.handlebars?.loadTemplates ?? loadTemplates;
  loadHb([CARD_TEMPLATE]);
  registerMultiAdvantagePatches();
  console.log(`${MODULE_ID} | Initialized`);
});

Hooks.once("ready", () => {
  registerMultiAdvantagePatches();
});

// Enhance V1 Roll Dialogs (used by dnd5e 4.0 D20Roll#configureDialog)
Hooks.on("renderDialog", (app, html) => {
  enhanceRollDialog(app, html);
});

// Enhance V2 RollConfigurationDialog / D20ConfigurationDialog (used in dnd5e 4.1+ / Foundry v13)
Hooks.on("renderRollConfigurationDialog", (app, html) => {
  enhanceRollDialog(app, html);
});

Hooks.on("renderApplicationV2", (app, html) => {
  if (app?.constructor?.name?.includes("ConfigurationDialog")) {
    enhanceRollDialog(app, html);
  }
});

// Pre-populate DC20 static damage and target snapshots when an attack roll message is created
Hooks.on("preCreateChatMessage", message => {
  onPreCreateChatMessage(message);
});

// Render the DC20 Hit Degree, Static Damage & Critical Hit Choice card in chat
Hooks.on("dnd5e.renderChatMessage", (message, html) => {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (root) {
    root.dataset.dc20csRendered = "true";
    renderDC20AttackChatCard(message, root);
  }
});

Hooks.on("renderChatMessage", (message, html) => {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (root && !root.dataset.dc20csRendered && !root.querySelector(".dc20cs-card")) {
    root.dataset.dc20csRendered = "true";
    renderDC20AttackChatCard(message, root);
  }
});

// Active GM relay: when a player applies static damage or a critical condition to an NPC they don't own
const processedGMActions = new Set();
Hooks.on("updateChatMessage", async (message, changed) => {
  if (!game.users.activeGM?.isSelf) return;
  const gmAction = changed?.flags?.[MODULE_ID]?.gmAction;
  if (!gmAction?.id || processedGMActions.has(gmAction.id)) return;
  processedGMActions.add(gmAction.id);

  const actor = gmAction.targetUuid ? resolveTargetActor(gmAction.targetUuid) : null;
  if (!actor) return;

  if (gmAction.type === "applyDamage" && gmAction.activeDamage) {
    await executeApplyDamageOnActor(actor, gmAction.activeDamage);
  } else if (gmAction.type === "applyCondition" && gmAction.conditionId) {
    await executeApplyConditionOnActor(actor, gmAction.conditionId, gmAction.conditionLabel);
  }
});
