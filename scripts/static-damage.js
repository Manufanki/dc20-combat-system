import { MODULE_ID } from "./multi-advantage.js";

/**
 * Standard tactical conditions selectable on a Critical Hit (Option B).
 * Maps to standard D&D 5e condition IDs in CONFIG.DND5E.conditionTypes / CONFIG.statusEffects.
 */
export const TACTICAL_CONDITIONS = [
  { id: "prone", key: "DC20CS.Conditions.prone", icon: "fa-solid fa-person-falling" },
  { id: "blinded", key: "DC20CS.Conditions.blinded", icon: "fa-solid fa-eye-slash" },
  { id: "grappled", key: "DC20CS.Conditions.grappled", icon: "fa-solid fa-hand-fist" },
  { id: "restrained", key: "DC20CS.Conditions.restrained", icon: "fa-solid fa-link" },
  { id: "frightened", key: "DC20CS.Conditions.frightened", icon: "fa-solid fa-face-grimace" },
  { id: "stunned", key: "DC20CS.Conditions.stunned", icon: "fa-solid fa-bolt" },
  { id: "poisoned", key: "DC20CS.Conditions.poisoned", icon: "fa-solid fa-skull-crossbones" },
  { id: "deafened", key: "DC20CS.Conditions.deafened", icon: "fa-solid fa-ear-deaf" },
  { id: "incapacitated", key: "DC20CS.Conditions.incapacitated", icon: "fa-solid fa-ban" },
  { id: "crippled", key: "DC20CS.Conditions.crippled", icon: "fa-solid fa-crutch" }
];

/**
 * Determine the DC20 Hit Degree for an attack roll against an Armor Class.
 *
 * @param {object} params
 * @param {number} params.attackTotal  Final total of the attack roll.
 * @param {number} params.ac           Target's Armor Class.
 * @param {boolean} params.isCritical  Whether the attack was a critical hit (e.g. Nat 20).
 * @param {boolean} params.isFumble    Whether the attack was a critical miss (Nat 1).
 * @returns {{ degree: "fumble"|"miss"|"normal"|"heavy"|"brutal"|"critical", hit: boolean, margin: number }}
 */
export function evaluateHitDegree({ attackTotal, ac, isCritical = false, isFumble = false }) {
  const numericAC = Number.isFinite(Number(ac)) ? Number(ac) : 10;
  const margin = attackTotal - numericAC;

  if (isCritical) {
    return { degree: "critical", hit: true, margin };
  }
  if (isFumble) {
    return { degree: "fumble", hit: false, margin };
  }
  if (margin < 0) {
    return { degree: "miss", hit: false, margin };
  }
  if (margin >= 10) {
    return { degree: "brutal", hit: true, margin };
  }
  if (margin >= 5) {
    return { degree: "heavy", hit: true, margin };
  }
  return { degree: "normal", hit: true, margin };
}

/**
 * Parse a single resolved Roll into its dice terms (total max dice) and deterministic flat modifier.
 *
 * @param {Roll} roll
 * @returns {{ diceFormula: string, diceMax: number, flatBonus: number }}
 */
function parseRollDiceAndFlat(roll) {
  const { DiceTerm, OperatorTerm } = foundry.dice.terms;
  let diceMax = 0;
  const diceLabels = [];

  // Clone the roll and replace all DiceTerms with 0 to safely evaluate the deterministic flat bonus
  const flatTerms = [];
  let sign = 1;

  for (const term of roll.terms) {
    if (term instanceof OperatorTerm) {
      if (term.operator === "-") sign = -1;
      else if (term.operator === "+") sign = 1;
      flatTerms.push(term.operator);
    } else if (term instanceof DiceTerm) {
      const number = Number(term.number) || 0;
      const faces = Number(term.faces) || 0;
      const maxVal = number * faces;
      diceMax += sign * maxVal;
      diceLabels.push(`${sign < 0 ? "-" : diceLabels.length ? "+" : ""}${number}d${faces}`);
      flatTerms.push("0");
      sign = 1;
    } else if (typeof term.total === "number" && Number.isFinite(term.total)) {
      flatTerms.push(String(term.total));
      sign = 1;
    } else if (term.formula) {
      flatTerms.push(term.formula);
      sign = 1;
    }
  }

  let flatBonus = 0;
  const flatExpr = flatTerms.join(" ").trim();
  if (flatExpr) {
    try {
      const evalRoll = new Roll(flatExpr, roll.data);
      evalRoll.evaluateSync({ strict: false });
      if (Number.isFinite(evalRoll.total)) flatBonus = evalRoll.total;
    } catch (_err) {
      flatBonus = 0;
    }
  }

  return {
    diceFormula: diceLabels.join(" ") || "0",
    diceMax: Math.max(0, diceMax),
    flatBonus: Math.trunc(flatBonus)
  };
}

/**
 * Extract damage parts from a dnd5e AttackActivity or Item5e and compute the DC20 Static Damage table:
 * - Normal (1/2): floor(0.5 * diceMax) + flatBonus
 * - Heavy (3/4):  floor(0.75 * diceMax) + flatBonus
 * - Brutal (Max): diceMax + flatBonus
 * - Crit Max (Option A): diceMax + floor(0.5 * diceMax) + flatBonus
 * - Crit Tactical (Option B): diceMax + flatBonus (+ Condition)
 *
 * @param {ChatMessage} message
 * @returns {object|null}
 */
export function calculateStaticDamageForMessage(message) {
  const activity = message.getAssociatedActivity?.();
  const item = message.getAssociatedItem?.();
  const actor = message.getAssociatedActor?.();
  if (!activity && !item) return null;

  const attackMode =
    message.getFlag("dnd5e", "roll.attackMode") ||
    message.rolls?.[0]?.options?.attackMode ||
    (activity && item?.getFlag("dnd5e", `last.${activity.id}.attackMode`)) ||
    "oneHanded";

  let ammunition = null;
  const ammoId =
    message.getFlag("dnd5e", "roll.ammunition") ||
    (activity && item?.getFlag("dnd5e", `last.${activity.id}.ammunition`));
  if (ammoId && actor?.items) {
    ammunition = actor.items.get(ammoId) ?? null;
  }

  const scaling = message.getFlag("dnd5e", "scaling") ?? item?.getFlag("dnd5e", "scaling") ?? 0;

  let rawRolls = [];
  if (activity?.getDamageConfig) {
    const damageConfig = activity.getDamageConfig({ attackMode, ammunition, scaling });
    rawRolls = damageConfig?.rolls ?? [];
  } else if (item?.system?.damage?.parts?.length) {
    const rollData = item.getRollData?.() ?? actor?.getRollData?.() ?? {};
    rawRolls = item.system.damage.parts.map(([formula, type]) => ({
      parts: [formula],
      data: rollData,
      options: { type }
    }));
  }

  if (!rawRolls.length) return null;

  const damageTypesConfig = {
    ...(CONFIG.DND5E?.damageTypes ?? {}),
    ...(CONFIG.DND5E?.healingTypes ?? {})
  };

  const parts = [];
  let totalDiceMax = 0;
  let totalFlatBonus = 0;
  const diceFormulas = [];

  for (const raw of rawRolls) {
    const formulaStr = (raw.parts ?? []).filter(Boolean).join(" + ");
    if (!formulaStr) continue;

    let roll;
    try {
      roll = new Roll(formulaStr, raw.data ?? {});
      if (typeof roll.simplify === "function") roll.simplify();
    } catch (_e) {
      continue;
    }

    const { diceFormula, diceMax, flatBonus } = parseRollDiceAndFlat(roll);
    const type = raw.options?.type || raw.options?.types?.[0] || "";
    const typeCfg = damageTypesConfig[type];

    totalDiceMax += diceMax;
    totalFlatBonus += flatBonus;
    if (diceFormula && diceFormula !== "0") diceFormulas.push(diceFormula);

    parts.push({
      diceFormula,
      diceMax,
      flatBonus,
      type,
      typeLabel: typeCfg?.label ? game.i18n.localize(typeCfg.label) : type,
      typeIcon: typeCfg?.icon || null,
      properties: Array.from(raw.options?.properties ?? [])
    });
  }

  if (!parts.length) return null;

  // Calculate exact DC20 Static Damage values matching the homebrew table:
  // Normal = floor(1/2 * D_max) + M
  // Heavy  = floor(3/4 * D_max) + M
  // Brutal = D_max + M
  // Crit A = D_max + floor(1/2 * D_max) + M
  // Crit B = D_max + M (+ Condition)
  const normalDice = Math.floor(totalDiceMax * 0.5);
  const heavyDice = Math.floor(totalDiceMax * 0.75);
  const brutalDice = totalDiceMax;
  const critMaxDice = brutalDice + normalDice;
  const critTacticalDice = brutalDice;

  const calcTotal = diceVal => Math.max(0, diceVal + totalFlatBonus);

  const buildTierBreakdown = factor => {
    // Distribute across parts proportionally/per-part so multi-type damage works with Actor5e#applyDamage
    if (parts.length === 1) {
      const p = parts[0];
      const dVal =
        factor === "normal"
          ? normalDice
          : factor === "heavy"
            ? heavyDice
            : factor === "critMax"
              ? critMaxDice
              : brutalDice;
      return [{
        value: Math.max(0, dVal + p.flatBonus),
        diceValue: dVal,
        flatBonus: p.flatBonus,
        type: p.type,
        typeLabel: p.typeLabel,
        typeIcon: p.typeIcon,
        properties: p.properties
      }];
    }

    return parts.map(p => {
      const pNormal = Math.floor(p.diceMax * 0.5);
      const pHeavy = Math.floor(p.diceMax * 0.75);
      const pBrutal = p.diceMax;
      const dVal =
        factor === "normal"
          ? pNormal
          : factor === "heavy"
            ? pHeavy
            : factor === "critMax"
              ? pBrutal + pNormal
              : pBrutal;
      return {
        value: Math.max(0, dVal + p.flatBonus),
        diceValue: dVal,
        flatBonus: p.flatBonus,
        type: p.type,
        typeLabel: p.typeLabel,
        typeIcon: p.typeIcon,
        properties: p.properties
      };
    });
  };

  const primaryPart = parts[0];
  const modSign = totalFlatBonus >= 0 ? "+" : "-";
  const baseSummary = `${diceFormulas.join(" + ") || "0"}${totalFlatBonus !== 0 ? ` ${modSign} ${Math.abs(totalFlatBonus)}` : ""}`;

  return {
    baseSummary,
    diceFormula: diceFormulas.join(" + ") || "0",
    totalDiceMax,
    totalFlatBonus,
    primaryType: primaryPart.type,
    primaryTypeLabel: primaryPart.typeLabel,
    primaryTypeIcon: primaryPart.typeIcon,
    tiers: {
      miss: {
        dice: 0,
        flat: 0,
        total: 0,
        formulaDisplay: "0",
        parts: []
      },
      fumble: {
        dice: 0,
        flat: 0,
        total: 0,
        formulaDisplay: "0",
        parts: []
      },
      normal: {
        dice: normalDice,
        flat: totalFlatBonus,
        total: calcTotal(normalDice),
        formulaDisplay: formatCalculation(normalDice, totalFlatBonus),
        parts: buildTierBreakdown("normal")
      },
      heavy: {
        dice: heavyDice,
        flat: totalFlatBonus,
        total: calcTotal(heavyDice),
        formulaDisplay: formatCalculation(heavyDice, totalFlatBonus),
        parts: buildTierBreakdown("heavy")
      },
      brutal: {
        dice: brutalDice,
        flat: totalFlatBonus,
        total: calcTotal(brutalDice),
        formulaDisplay: formatCalculation(brutalDice, totalFlatBonus),
        parts: buildTierBreakdown("brutal")
      },
      critMax: {
        dice: critMaxDice,
        flat: totalFlatBonus,
        total: calcTotal(critMaxDice),
        formulaDisplay: `${brutalDice} + ${normalDice}${totalFlatBonus !== 0 ? ` ${modSign} ${Math.abs(totalFlatBonus)}` : ""}`,
        parts: buildTierBreakdown("critMax")
      },
      critTactical: {
        dice: critTacticalDice,
        flat: totalFlatBonus,
        total: calcTotal(critTacticalDice),
        formulaDisplay: formatCalculation(critTacticalDice, totalFlatBonus),
        parts: buildTierBreakdown("brutal")
      }
    }
  };
}

function formatCalculation(diceVal, flatBonus) {
  if (!flatBonus) return `${diceVal}`;
  const sign = flatBonus >= 0 ? "+" : "-";
  return `${diceVal} ${sign} ${Math.abs(flatBonus)}`;
}

/**
 * Collect target descriptors from the message flags or current user targets.
 *
 * @param {ChatMessage} message
 * @returns {Array<{ uuid: string, tokenUuid: string|null, name: string, img: string, ac: number }>}
 */
export function getTargetsForAttackMessage(message) {
  const flagTargets = message.getFlag("dnd5e", "targets");
  if (Array.isArray(flagTargets) && flagTargets.length > 0) {
    return flagTargets.map(t => {
      const actor = t.uuid ? fromUuidSync(t.uuid) : null;
      const ac = t.ac ?? actor?.system?.attributes?.ac?.value ?? 10;
      return {
        uuid: t.uuid,
        name: t.name || actor?.name || "Target",
        img: t.img || actor?.img || "icons/svg/mystery-man.svg",
        ac: Number.isFinite(Number(ac)) ? Number(ac) : 10
      };
    });
  }

  // Fallback to current user targets if message was created by current user and had no dnd5e.targets flag
  if (message.isAuthor && game.user?.targets?.size) {
    return Array.from(game.user.targets)
      .filter(t => t.actor)
      .map(token => ({
        uuid: token.actor.uuid,
        name: token.name || token.actor.name,
        img: token.document?.texture?.src || token.actor.img,
        ac: token.actor.system?.attributes?.ac?.value ?? 10
      }));
  }

  return [];
}
