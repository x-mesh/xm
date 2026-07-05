/*
 * widget-serialize.mjs — pure serialization/diff helpers for the config
 * schema editor's structured object widgets (t7, config-gap-close): worktree
 * gate_policy (severity grid), model_overrides (role -> tier rows),
 * vendor_models / vendor_profiles (vendor row editors) — plus
 * cfgResolveScalarFieldOp, the equivalent per-field decision for every other
 * (scalar) schema field, used by configSaveSchemaFields (F2). Standalone
 * module so it's unit-testable without loading app.js (a 6.9k-line classic
 * <script> with top-level DOM side effects — same reason validate-field.mjs
 * is split out; see that file's header comment).
 *
 * app.js does NOT load this file via a <script> tag — it inlines an
 * identical copy of every function/constant here directly. The two copies
 * must be kept byte-for-byte in sync; this file exists purely so
 * x-dashboard/test/widget-serialize.test.mjs can exercise the logic.
 *
 *   - browser: app.js's own top-level copies (search for "mirrored in
 *     widget-serialize.mjs").
 *   - tests:   `import '../public/widget-serialize.mjs'` runs the IIFE,
 *     then reads globalThis.XMWidgetSerialize.
 */
(function (g) {
  'use strict';

  // Fixed domain vocabulary for worktree.gate_policy. No /config/schema or
  // /config/model-routing endpoint exposes these (unlike model/vendor tiers
  // below) — they mirror x-build/lib/shared-config.mjs's
  // GATE_POLICY_SEVERITY_KEYS / SEVERITY_VALUES verbatim. Update both sides
  // together if that vocabulary ever changes.
  const GATE_POLICY_ROWS = ['block_confirmed', 'block_unreviewed', 'block_contested'];
  const SEVERITY_VALUES = ['critical', 'high', 'medium', 'low'];

  // 'inherit' is a routing sentinel (run on the session model), never a
  // billable tier — cost-engine's MODEL_COSTS deliberately excludes it (see
  // cost-engine.mjs costFromTokens), so /api/config/model-routing's `models`
  // list never contains it and structurally never will. getModelForRole
  // honors 'inherit' for any role, so it is appended here in exactly one
  // place instead of re-declaring a role/tier array at each call site.
  const CFG_INHERIT_TIER = 'inherit';

  // True only for an array containing exclusively known severity strings —
  // the grid widget's "safe to render as checkboxes" test. Anything else
  // (wrong shape, unknown severity value) must fall back to a raw-JSON
  // editor instead of silently dropping data.
  function isKnownSeverityArray(v) {
    return Array.isArray(v) && v.every((s) => SEVERITY_VALUES.includes(s));
  }

  // Billable tiers come from the server (/api/config/model-routing `models`);
  // 'inherit' is always appended. Falls back to the historical 3-tier list
  // only when the routing endpoint is unavailable (503/network error) — NOT
  // a reintroduction of a hardcoded role/tier catalog, just a degrade path.
  function cfgModelOverrideTiers(routingModels) {
    const billable = Array.isArray(routingModels) ? routingModels : ['haiku', 'sonnet', 'opus'];
    return [...billable, CFG_INHERIT_TIER];
  }

  // Diffs a flat (one-level) object against what is currently set at this
  // tier and the effective (merged) default, producing per-leaf dotted `_set`
  // / `_delete` ops relative to `prefix`. Mirrors configSaveSchemaFields'
  // scalar-field diff (app.js), generalized to object subkeys so sibling keys
  // are always preserved (only the changed leaves are ever sent).
  //
  //  - leaf present in `loaded` but missing from `edited` -> delete
  //  - leaf present in `edited`:
  //      - `loaded` has it and unchanged (deep-equal)      -> no-op
  //      - `loaded` doesn't have it, but equals `effective` -> no-op (still default)
  //      - otherwise                                        -> set
  //
  // `edited`/`loaded`/`effective` may be null/undefined/non-object; treated
  // as `{}`. Unknown keys in `edited` (preserved verbatim by the caller, e.g.
  // gate_policy's "other keys" passthrough) diff exactly like known ones —
  // no special-casing needed here.
  function diffFlatObjectSubkeys(prefix, edited, loaded, effective) {
    const editedObj = (edited && typeof edited === 'object' && !Array.isArray(edited)) ? edited : {};
    const loadedObj = (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) ? loaded : {};
    const effectiveObj = (effective && typeof effective === 'object' && !Array.isArray(effective)) ? effective : {};
    const setOps = {};
    const deleteOps = [];
    for (const k of Object.keys(loadedObj)) {
      if (!Object.prototype.hasOwnProperty.call(editedObj, k)) deleteOps.push(`${prefix}.${k}`);
    }
    for (const [k, v] of Object.entries(editedObj)) {
      const wasSet = Object.prototype.hasOwnProperty.call(loadedObj, k);
      if (wasSet) {
        if (JSON.stringify(loadedObj[k]) === JSON.stringify(v)) continue;
      } else if (JSON.stringify(effectiveObj[k]) === JSON.stringify(v)) {
        continue;
      }
      setOps[`${prefix}.${k}`] = v;
    }
    return { setOps, deleteOps };
  }

  // { vendor: { tier: spec } } -> { 'vendor.tier': spec }. Skips a
  // non-object vendor entry defensively (never crashes on a malformed value)
  // rather than surfacing it — vendor_models has no "unknown shape" raw
  // fallback requirement like gate_policy does.
  function flattenTwoLevel(obj) {
    const out = {};
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
    for (const [k, v] of Object.entries(obj)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      for (const [k2, v2] of Object.entries(v)) out[`${k}.${k2}`] = v2;
    }
    return out;
  }

  // Row editor (key -> value) serialization shared by model_overrides
  // (role -> tier) and vendor_profiles (vendor -> profile). Blank key or
  // blank/undefined/null value drops the row — a blank value means "(unset)"
  // / "(profile default)" was selected, i.e. no override for that row.
  function rowsToFlatObject(rows) {
    const out = {};
    for (const r of (rows || [])) {
      const key = String(r?.key ?? '').trim();
      const value = r?.value;
      if (!key || value === undefined || value === null || value === '') continue;
      out[key] = value;
    }
    return out;
  }

  // vendor_models row editor serialization: [{ vendor, tiers: { haiku, ... } }]
  // -> { vendor: { tier: spec } }. Blank tier values are dropped (no override
  // for that tier); a vendor left with zero populated tiers is dropped
  // entirely — this is how "remove a vendor row" round-trips to a delete.
  function rowsToVendorModelsObject(rows) {
    const out = {};
    for (const r of (rows || [])) {
      const vendor = String(r?.vendor ?? '').trim();
      if (!vendor) continue;
      const tiersIn = (r?.tiers && typeof r.tiers === 'object') ? r.tiers : {};
      const cleaned = {};
      for (const [tier, spec] of Object.entries(tiersIn)) {
        const s = String(spec ?? '').trim();
        if (s) cleaned[tier] = s;
      }
      if (Object.keys(cleaned).length) out[vendor] = cleaned;
    }
    return out;
  }

  // Merges the gate_policy grid's resolved known fields (block_confirmed /
  // block_unreviewed / block_contested / allow_low — each already resolved
  // to its final JS value by the DOM layer) with any preserved unknown
  // subkeys. `otherRaw` spreads first so a known field always wins on
  // collision (it never should collide — otherRaw excludes known keys by
  // construction — but this keeps the merge direction unambiguous).
  function buildGatePolicyObject(known, otherRaw) {
    const base = (otherRaw && typeof otherRaw === 'object' && !Array.isArray(otherRaw)) ? otherRaw : {};
    return { ...base, ...(known || {}) };
  }

  // Resolves what configSaveSchemaFields (app.js) should do with one scalar
  // schema field — everything except the 4 object widgets above (those go
  // through diffFlatObjectSubkeys instead). Given:
  //  - wasSet: was this key present at this tier as loaded
  //  - unsetFlagged: did the user click "reset" this edit session (F2
  //    sentinel — only ever set for string/array controls; see
  //    configResetSchemaField)
  //  - value: cfgReadWidgetValue's coerced current value (undefined means
  //    "unset" for every type except string/array, where '' / [] is a real value)
  //  - loadedValue / effectiveValue: this tier's loaded value and the merged
  //    default, for the "unchanged from loaded" / "still at default" skips
  //
  // string/array get a dedicated blank check (F2): those two types can hold
  // a legitimate '' / [] as a *set* value, so a blank, never-touched control
  // must stay a no-op rather than manufacturing a spurious empty override.
  function cfgResolveScalarFieldOp(entry, { wasSet, unsetFlagged, value, loadedValue, effectiveValue }) {
    if (unsetFlagged) return wasSet ? { kind: 'delete' } : { kind: 'skip' };
    if (value === undefined) return wasSet ? { kind: 'delete' } : { kind: 'skip' };
    if (!wasSet && (entry.type === 'string' || entry.type === 'array')) {
      const isBlank = entry.type === 'array' ? value.length === 0 : value === '';
      if (isBlank) return { kind: 'skip' };
    }
    if (wasSet) {
      if (JSON.stringify(loadedValue) === JSON.stringify(value)) return { kind: 'skip' };
    } else if (entry.type === 'boolean' && !entry.nullable) {
      // Plain checkboxes always resolve to a concrete boolean (never undefined)
      // even when the field was never set — skip if it's still showing the
      // default so an untouched checkbox never becomes a spurious _set.
      if (value === effectiveValue) return { kind: 'skip' };
    }
    return { kind: 'set', value };
  }

  g.XMWidgetSerialize = {
    GATE_POLICY_ROWS,
    SEVERITY_VALUES,
    CFG_INHERIT_TIER,
    isKnownSeverityArray,
    cfgModelOverrideTiers,
    diffFlatObjectSubkeys,
    flattenTwoLevel,
    rowsToFlatObject,
    rowsToVendorModelsObject,
    buildGatePolicyObject,
    cfgResolveScalarFieldOp,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
