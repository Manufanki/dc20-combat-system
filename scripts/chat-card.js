import { MODULE_ID } from "./multi-advantage.js";
import {
  TACTICAL_CONDITIONS,
  calculateStaticDamageForMessage,
  evaluateHitDegree,
  getTargetsForAttackMessage
} from "./static-damage.js";

export const CARD_TEMPLATE = `modules/${MODULE_ID}/templates/attack-result-card.hbs`;

const DEGREE_ICONS = {
  fumble: "fa-solid fa-skull",
  miss: "fa-solid fa-shield-xmark",
  normal: "fa-solid fa-crosshairs",
  heavy: "fa-solid fa-fire-flame-curved",
  brutal: "fa-solid fa-bolt-lightning",
  critical: "fa-solid fa-crown"
};

/**
 * Check whether a ChatMessage represents a dnd5e Attack Roll.
 */
export function isAttackRollMessage(message) {
  if (!message) return false;
  const rollType = message.getFlag?.("dnd5e", "roll.type") ?? message.flags?.dnd5e?.roll?.type;
  if (rollType === "attack") return true;

  // Also support messages where an attack D20Roll was embedded by an activity
  const activityType = message.getFlag?.("dnd5e", "activity.type") ?? message.flags?.dnd5e?.activity?.type;
  if (activityType === "attack" && message.rolls?.some(r => r instanceof CONFIG.Dice.D20Roll)) {
    return true;
  }
  return false;
}

/**
 * Find the D20 attack roll inside a ChatMessage.
 */
function getAttackRoll(message) {
  if (!message?.rolls?.length) return null;
  const d20Roll =
    message.rolls.find(r => r instanceof CONFIG.Dice.D20Roll || r.dice?.[0]?.faces === 20) ?? message.rolls[0];
  if (!d20Roll) return null;
  return CONFIG.Dice?.D20Roll?.fromRoll ? CONFIG.Dice.D20Roll.fromRoll(d20Roll) : d20Roll;
}

/**
 * Prepare and persist initial DC20 attack & static damage data in message flags before creation.
 */
export function onPreCreateChatMessage(message) {
  if (!game.settings.get(MODULE_ID, "enableStaticDamage")) return;
  if (!isAttackRollMessage(message)) return;

  const damage = calculateStaticDamageForMessage(message);
  const targets = getTargetsForAttackMessage(message);

  const updates = {};
  if (damage) updates[`flags.${MODULE_ID}.damage`] = damage;
  if (targets.length) updates[`flags.${MODULE_ID}.targets`] = targets;

  if (Object.keys(updates).length) {
    message.updateSource(updates);
  }
}

/**
 * Build the template rendering context for the DC20 Attack Result & Static Damage card.
 */
function buildCardContext(message) {
  const attackRoll = getAttackRoll(message);
  if (!attackRoll) return null;

  const attackTotal = Number(attackRoll.total) || 0;
  const d20Die = attackRoll.dice?.[0];
  const isRollCritical = Boolean(attackRoll.isCritical);
  const isRollFumble = Boolean(attackRoll.isFumble);

  // Multi-Advantage / Multi-Disadvantage banner info
  let d20Badge = null;
  const d20Flag = message.getFlag(MODULE_ID, "d20");
  const diceRolled = d20Die?.results?.length ?? d20Flag?.diceCount ?? 1;
  if (diceRolled >= 2 && (attackRoll.hasAdvantage || attackRoll.hasDisadvantage || d20Flag)) {
    const mode = d20Flag?.mode ?? (attackRoll.hasAdvantage ? "advantage" : "disadvantage");
    const tier = diceRolled - 1;
    const label = game.i18n.format(
      mode === "advantage" ? "DC20CS.Advantage.ChatTag" : "DC20CS.Disadvantage.ChatTag",
      { tier, dice: diceRolled }
    );
    const resultsText = (d20Die?.results ?? [])
      .map(r => (r.active ? `[${r.result}]` : `${r.result}`))
      .join(", ");
    d20Badge = { mode, dice: diceRolled, tier, label, resultsText };
  }

  // Retrieve or compute static damage
  const damage = message.getFlag(MODULE_ID, "damage") ?? calculateStaticDamageForMessage(message);
  const hasDamage = Boolean(damage?.tiers);

  // Retrieve targets
  let rawTargets = message.getFlag(MODULE_ID, "targets") ?? getTargetsForAttackMessage(message);
  // If critical hit with no target, still create a virtual target entry so the player gets the Crit choice UI!
  if (!rawTargets.length && isRollCritical) {
    rawTargets = [{
      uuid: "",
      name: game.i18n.localize("DND5E.Target"),
      img: "icons/svg/target.svg",
      ac: null
    }];
  }

  const savedState = message.getFlag(MODULE_ID, "state") ?? {};
  const targetStates = savedState.targets ?? {};
  const showAC = game.user.isGM || game.settings.get("dnd5e", "attackRollVisibility") === "all" || true;

  const conditions = TACTICAL_CONDITIONS.map(c => ({
    id: c.id,
    label: game.i18n.localize(c.key),
    icon: c.icon
  }));

  const targets = rawTargets.map((target, index) => {
    const tState = targetStates[index] ?? {};
    const hasValidAC = target.ac !== null && target.ac !== undefined;
    const evalResult = hasValidAC
      ? evaluateHitDegree({
          attackTotal,
          ac: target.ac,
          isCritical: isRollCritical,
          isFumble: isRollFumble
        })
      : {
          degree: isRollCritical ? "critical" : "normal",
          hit: true,
          margin: 0
        };

    const isCritical = evalResult.degree === "critical";
    const critChoice = tState.critChoice || "max"; // Default to Option A (Maximum Damage)

    let activeDamage = { total: 0, formulaDisplay: "0", parts: [] };
    if (hasDamage && evalResult.hit) {
      if (isCritical) {
        activeDamage = critChoice === "condition" ? damage.tiers.critTactical : damage.tiers.critMax;
      } else {
        activeDamage = damage.tiers[evalResult.degree] ?? damage.tiers.normal;
      }
    }

    const selectedConditionId = tState.selectedConditionId || "";
    const selectedConditionLabel = tState.selectedConditionLabel || "";

    let critSummaryText = "";
    if (isCritical && hasDamage) {
      if (critChoice === "max") {
        critSummaryText = game.i18n.format("DC20CS.Crit.SelectedMax", {
          damage: damage.tiers.critMax.total
        });
      } else if (critChoice === "condition" && selectedConditionLabel) {
        critSummaryText = game.i18n.format("DC20CS.Crit.SelectedCondition", {
          damage: damage.tiers.critTactical.total,
          condition: selectedConditionLabel
        });
      }
    }

    const marginSign = evalResult.margin >= 0 ? "+" : "";
    return {
      uuid: target.uuid,
      name: target.name,
      img: target.img,
      ac: target.ac,
      showAC: hasValidAC && showAC,
      hit: evalResult.hit,
      isCritical,
      activeDegree: evalResult.degree,
      degreeIcon: DEGREE_ICONS[evalResult.degree] || "fa-solid fa-dice-d20",
      degreeLabel: game.i18n.localize(`DC20CS.Degree.${evalResult.degree}`),
      degreeSub: game.i18n.localize(`DC20CS.Degree.Sub.${evalResult.degree}`),
      marginFormatted: `${marginSign}${evalResult.margin}`,
      activeDamage,
      critChoice,
      selectedConditionId,
      selectedConditionLabel: critChoice === "condition" ? selectedConditionLabel : "",
      customConditionText: tState.customConditionText || "",
      critSummaryText,
      damageApplied: Boolean(tState.damageApplied)
    };
  });

  const actor = message.getAssociatedActor?.();
  const canInteract = Boolean(game.user.isGM || message.isAuthor || actor?.isOwner);

  return {
    messageId: message.id,
    attackTotal,
    isRollCritical,
    d20Badge,
    hasDamage,
    damage,
    hasTargets: targets.length > 0,
    targets,
    conditions,
    canInteract
  };
}

/**
 * Render and inject the DC20 Attack Result & Static Damage card into a ChatMessage HTML element.
 */
export async function renderDC20AttackChatCard(message, html) {
  if (!game.settings.get(MODULE_ID, "enableStaticDamage")) return;

  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;

  // Optionally hide the vanilla Damage Roll button on activity cards if configured
  if (game.settings.get(MODULE_ID, "hideVanillaDamageButton")) {
    const dmgBtn = root.querySelector('.card-buttons button[data-action="rollDamage"]');
    if (dmgBtn) dmgBtn.style.display = "none";
  }

  if (!isAttackRollMessage(message)) return;
  if (!message.isContentVisible) return;

  const context = buildCardContext(message);
  if (!context) return;

  const renderHb = foundry.applications?.handlebars?.renderTemplate ?? renderTemplate;
  const markup = await renderHb(CARD_TEMPLATE, context);
  const template = document.createElement("template");
  template.innerHTML = markup.trim();
  const cardEl = template.content.firstElementChild;
  if (!cardEl) return;

  // Hide dnd5e's default collapsible targets tray so our richer target evaluation card replaces it cleanly
  root.querySelectorAll(".targets-tray").forEach(el => {
    el.style.display = "none";
  });

  const existing = root.querySelector(".dc20cs-card");
  if (existing) existing.replaceWith(cardEl);
  else {
    const contentEl = root.querySelector(".message-content") ?? root;
    contentEl.appendChild(cardEl);
  }

  activateCardListeners(message, cardEl);
}

/**
 * Bind interactive events on the rendered DC20 chat card.
 */
function activateCardListeners(message, cardEl) {
  // Hovering / clicking target header pans/highlights token on canvas
  cardEl.querySelectorAll(".dc20cs-target-card[data-target-uuid]").forEach(row => {
    const uuid = row.dataset.targetUuid;
    if (!uuid) return;

    const header = row.querySelector(".dc20cs-target-header");
    header?.addEventListener("mouseenter", event => {
      if (!canvas?.ready) return;
      const actor = fromUuidSync(uuid);
      const token = actor?.token?.object ?? actor?.getActiveTokens?.()?.[0];
      if (token?.isVisible && !token.controlled) {
        token._onHoverIn(event, { hoverOutOthers: true });
      }
    });
    header?.addEventListener("mouseleave", event => {
      if (!canvas?.ready) return;
      const actor = fromUuidSync(uuid);
      const token = actor?.token?.object ?? actor?.getActiveTokens?.()?.[0];
      if (token) token._onHoverOut(event);
    });
    header?.addEventListener("click", event => {
      if (event.target.closest("button, input")) return;
      if (!canvas?.ready) return;
      const actor = fromUuidSync(uuid);
      const token = actor?.token?.object ?? actor?.getActiveTokens?.()?.[0];
      if (token && actor?.testUserPermission(game.user, "OBSERVER")) {
        token.control({ releaseOthers: !event.shiftKey });
        canvas.animatePan(token.center);
      }
    });
  });

  // 1. Select Critical Hit Option (Option A: Max Damage vs Option B: Tactical Condition)
  cardEl.querySelectorAll('button[data-action="selectCritOption"]').forEach(btn => {
    btn.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      const choice = btn.dataset.choice;
      const targetIndex = Number(btn.dataset.targetIndex) || 0;

      const state = foundry.utils.deepClone(message.getFlag(MODULE_ID, "state") ?? {});
      state.targets ??= {};
      state.targets[targetIndex] ??= {};
      state.targets[targetIndex].critChoice = choice;
      state.targets[targetIndex].damageApplied = false;

      await message.update({ [`flags.${MODULE_ID}.state`]: state });
    });
  });

  // 2. Pick a Condition Chip (Option B)
  cardEl.querySelectorAll('button[data-action="pickCritCondition"]').forEach(btn => {
    btn.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      const conditionId = btn.dataset.conditionId;
      const conditionLabel = btn.dataset.conditionLabel;
      const targetUuid = btn.dataset.targetUuid;
      const targetIndex = Number(btn.dataset.targetIndex) || 0;

      await selectAndApplyCondition(message, {
        targetIndex,
        targetUuid,
        conditionId,
        conditionLabel
      });
    });
  });

  // 3. Apply a Custom Condition (Option B)
  cardEl.querySelectorAll('button[data-action="applyCustomCondition"]').forEach(btn => {
    btn.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      const targetUuid = btn.dataset.targetUuid;
      const targetIndex = Number(btn.dataset.targetIndex) || 0;
      const input = btn.parentElement?.querySelector(".dc20cs-custom-condition-input");
      const customText = input?.value?.trim();
      if (!customText) return;

      await selectAndApplyCondition(message, {
        targetIndex,
        targetUuid,
        conditionId: "custom",
        conditionLabel: customText,
        customConditionText: customText
      });
    });
  });

  // 4. Apply Static Damage button
  cardEl.querySelectorAll('button[data-action="applyStaticDamage"]').forEach(btn => {
    btn.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      const targetUuid = btn.dataset.targetUuid;
      const targetIndex = Number(btn.dataset.targetIndex) || 0;
      const btnDamageTotal = Number(btn.dataset.damageTotal);

      const context = buildCardContext(message);
      const targetCtx = context?.targets?.[targetIndex];
      const activeDamage = targetCtx?.activeDamage
        ? {
            ...targetCtx.activeDamage,
            total: Number.isFinite(btnDamageTotal) ? btnDamageTotal : targetCtx.activeDamage.total
          }
        : Number.isFinite(btnDamageTotal)
          ? { total: btnDamageTotal, parts: [{ value: btnDamageTotal }] }
          : null;
      if (!activeDamage) return;

      await applyStaticDamageForTarget(message, targetIndex, targetUuid, activeDamage);
    });
  });

  // 5. Evaluate Current Target button (if player rolled without a target first)
  cardEl.querySelectorAll('button[data-action="evaluateCurrentTarget"]').forEach(btn => {
    btn.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      const currentTargets = Array.from(game.user?.targets ?? []).filter(t => t.actor);
      if (!currentTargets.length) {
        ui.notifications.warn(game.i18n.localize("DC20CS.Damage.NoTargetWarn"));
        return;
      }

      const descriptors = currentTargets.map(token => ({
        uuid: token.actor.uuid,
        name: token.name || token.actor.name,
        img: token.document?.texture?.src || token.actor.img,
        ac: token.actor.system?.attributes?.ac?.value ?? 10
      }));

      const damage = message.getFlag(MODULE_ID, "damage") ?? calculateStaticDamageForMessage(message);
      await message.update({
        [`flags.${MODULE_ID}.targets`]: descriptors,
        ...(damage ? { [`flags.${MODULE_ID}.damage`]: damage } : {})
      });
    });
  });
}

/**
 * Resolve a target UUID to the active token's Actor on the canvas if present, or the document itself.
 */
export function resolveTargetActor(targetUuid) {
  if (!targetUuid) return null;
  const doc = fromUuidSync(targetUuid);
  if (!doc) return null;
  if (doc.documentName === "Token" || doc instanceof foundry.documents.BaseToken) {
    return doc.actor;
  }
  if (doc.isToken) return doc;
  // If it's a world Actor, prefer its active token actor on the current canvas scene
  const activeToken = doc.getActiveTokens?.(true, true)?.[0];
  return activeToken?.actor ?? doc;
}

/**
 * Save the chosen condition in message state and apply the status effect to the target actor.
 */
async function selectAndApplyCondition(
  message,
  { targetIndex, targetUuid, conditionId, conditionLabel, customConditionText }
) {
  const state = foundry.utils.deepClone(message.getFlag(MODULE_ID, "state") ?? {});
  state.targets ??= {};
  state.targets[targetIndex] ??= {};
  state.targets[targetIndex].critChoice = "condition";
  state.targets[targetIndex].selectedConditionId = conditionId;
  state.targets[targetIndex].selectedConditionLabel = conditionLabel;
  if (customConditionText !== undefined) {
    state.targets[targetIndex].customConditionText = customConditionText;
  }

  const updateData = { [`flags.${MODULE_ID}.state`]: state };

  if (targetUuid) {
    const actor = resolveTargetActor(targetUuid);
    if (actor && (game.user.isGM || actor.isOwner)) {
      await executeApplyConditionOnActor(actor, conditionId, conditionLabel);
    } else if (actor) {
      // Queue GM action on message flag so active GM applies the status effect automatically
      updateData[`flags.${MODULE_ID}.gmAction`] = {
        id: foundry.utils.randomID(),
        type: "applyCondition",
        targetUuid,
        conditionId,
        conditionLabel
      };
    }
  }

  await message.update(updateData);
}

/**
 * Apply the calculated static damage to the target actor (or queue GM action if player doesn't own the NPC).
 */
async function applyStaticDamageForTarget(message, targetIndex, targetUuid, activeDamage) {
  if (!activeDamage) return;

  const state = foundry.utils.deepClone(message.getFlag(MODULE_ID, "state") ?? {});
  state.targets ??= {};
  state.targets[targetIndex] ??= {};
  state.targets[targetIndex].damageApplied = true;

  const updateData = { [`flags.${MODULE_ID}.state`]: state };

  // Fallback to currently controlled token if targetUuid is empty
  let effectiveUuid = targetUuid;
  if (!effectiveUuid && canvas?.tokens?.controlled?.[0]?.actor) {
    effectiveUuid = canvas.tokens.controlled[0].actor.uuid;
  }

  if (effectiveUuid) {
    const actor = resolveTargetActor(effectiveUuid);
    if (actor && (game.user.isGM || actor.isOwner)) {
      await executeApplyDamageOnActor(actor, activeDamage);
    } else if (actor) {
      updateData[`flags.${MODULE_ID}.gmAction`] = {
        id: foundry.utils.randomID(),
        type: "applyDamage",
        targetUuid: effectiveUuid,
        activeDamage
      };
    }
  }

  await message.update(updateData);
}

/**
 * Execute exact static damage application on an Actor5e instance.
 * Ignores automatic resistance/reduction overrides so the exact DC20 static damage shown on the card is applied.
 */
export async function executeApplyDamageOnActor(actor, activeDamage) {
  if (!actor || !activeDamage) return;

  const totalDamage = Math.max(0, Math.trunc(Number(activeDamage.total) || 0));
  if (totalDamage <= 0) return;

  const hp = actor.system?.attributes?.hp;
  const beforeValue = Number(hp?.value) || 0;
  const beforeTemp = Number(hp?.temp) || 0;

  const expectedTempDelta = Math.min(beforeTemp, totalDamage);
  const remainingAfterTemp = totalDamage - expectedTempDelta;
  const expectedHpValue = Math.max(0, beforeValue - remainingAfterTemp);
  const expectedTempValue = Math.max(0, beforeTemp - expectedTempDelta);

  if (typeof actor.applyDamage === "function") {
    // Pass numeric totalDamage with ignore: true so dnd5e applies the exact static damage
    await actor.applyDamage(totalDamage, { ignore: true, multiplier: 1 });
  }

  // Verify the exact static damage was applied (protects against external module hooks altering the damage)
  const afterHp = actor.system?.attributes?.hp;
  if (afterHp && (afterHp.value !== expectedHpValue || (Number(afterHp.temp) || 0) !== expectedTempValue)) {
    await actor.update({
      "system.attributes.hp.temp": expectedTempValue,
      "system.attributes.hp.value": expectedHpValue
    });
  }
}

/**
 * Execute status effect / condition application on an Actor5e instance.
 */
export async function executeApplyConditionOnActor(actor, conditionId, conditionLabel) {
  if (!actor) return;

  // Check if conditionId matches a registered status effect in Foundry / dnd5e
  const matchingStatus = CONFIG.statusEffects?.find(s => s.id === conditionId);
  if (matchingStatus && typeof actor.toggleStatusEffect === "function") {
    await actor.toggleStatusEffect(conditionId, { active: true });
    ui.notifications.info(
      game.i18n.format("DC20CS.Crit.ConditionApplied", {
        condition: conditionLabel,
        target: actor.name
      })
    );
    return;
  }

  // Otherwise create a temporary ActiveEffect with the custom/tactical condition name
  const existing = actor.effects?.find(e => e.name === conditionLabel);
  if (!existing) {
    await actor.createEmbeddedDocuments("ActiveEffect", [{
      name: conditionLabel,
      img: "icons/svg/daze.svg",
      description: `DC20 Tactical Critical Condition: ${conditionLabel}`,
      statuses: conditionId && conditionId !== "custom" ? [conditionId] : []
    }]);
  }
  ui.notifications.info(
    game.i18n.format("DC20CS.Crit.ConditionApplied", {
      condition: conditionLabel,
      target: actor.name
    })
  );
}
