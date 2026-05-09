/**
 * agent-model.mjs — Sub-step Agent({model}) routing helper.
 *
 * Resolves the model for an Agent tool call based on:
 *   1. role (architect/reviewer/security/executor/designer/debugger/explorer/writer)
 *   2. task size (small/medium/large)
 *   3. current model_profile (economy/default/max) from .xm/config.json
 *
 * Wraps getModelForRole() from x-build/cost-engine.mjs so SKILL.md sub-step
 * delegations can be written as:
 *   Agent({ model: pickModel("explorer", "small"), prompt: "..." })
 * instead of hardcoded:
 *   Agent({ model: "haiku", prompt: "..." })
 *
 * The leader-level model is controlled separately via SKILL.md frontmatter
 * `model:` field, kept in sync by skill-frontmatter-sync.mjs.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Locate cost-engine.mjs across both bundle and source layouts.
function findCostEngine() {
  const candidates = [
    join(__dirname, 'x-build', 'cost-engine.mjs'),                       // xm bundle
    join(__dirname, '..', '..', 'x-build', 'lib', 'x-build', 'cost-engine.mjs'),  // source
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

let _costEngine = null;
async function getCostEngine() {
  if (_costEngine) return _costEngine;
  const path = findCostEngine();
  if (!path) throw new Error('cost-engine.mjs not found in expected paths');
  _costEngine = await import(path);
  return _costEngine;
}

/**
 * Pick the model for a sub-step Agent tool call.
 *
 * @param {string} role  — architect|reviewer|security|executor|designer|debugger|explorer|writer
 * @param {string} size  — small|medium|large (default: medium)
 * @returns {Promise<string>} — "haiku" | "sonnet" | "opus"
 */
export async function pickModel(role, size = 'medium') {
  const ce = await getCostEngine();
  return ce.getModelForRole(role, size);
}

/**
 * Synchronous variant — caller must ensure cost-engine has been pre-imported.
 * Useful in CLI tools that already imported cost-engine for other purposes.
 *
 * @param {object} costEngine — the imported cost-engine module
 * @param {string} role
 * @param {string} size
 */
export function pickModelSync(costEngine, role, size = 'medium') {
  return costEngine.getModelForRole(role, size);
}

/**
 * Convenience: return a model picker bound to a specific size, useful when
 * generating multiple Agent calls of the same task size.
 *
 *   const small = await modelFor('small');
 *   const m1 = small('explorer');  // returns "haiku" under default profile
 *   const m2 = small('reviewer');  // returns "opus" under default profile
 */
export async function modelFor(size = 'medium') {
  const ce = await getCostEngine();
  return (role) => ce.getModelForRole(role, size);
}
