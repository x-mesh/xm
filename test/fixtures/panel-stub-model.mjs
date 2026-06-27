#!/usr/bin/env node
/**
 * Test stub standing in for a model CLI. Invoked as:
 *   node panel-stub-model.mjs <model> <prompt>
 * Returns deterministic JSON so x-panel's flow can be tested without real models.
 * Wraps output in noise to exercise extractJSON.
 */
const [model, prompt = ''] = process.argv.slice(2);
const isRefute = /verdicts/i.test(prompt);
const envModel = String(model || '').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
const delayMs = Number(process.env[`X_PANEL_DELAY_${isRefute ? 'R2' : 'R1'}_${envModel}_MS`] || process.env[`X_PANEL_DELAY_${envModel}_MS`] || 0);

if (Number.isFinite(delayMs) && delayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

if (process.env[`X_PANEL_NO_JSON_${envModel}`]) {
  process.stdout.write('plain text without a JSON payload');
  process.exit(0);
}

if (isRefute) {
  const refs = [...prompt.matchAll(/\[([^\]]+#\d+)\]/g)].map((m) => m[1]); // global ref "owner#idx" (owner may contain ':')
  const verdicts = refs.map((ref, i) => ({
    ref,
    // codex refutes the opponent's first finding → creates one CONTESTED entry
    stance: model === 'codex' && i === 0 ? 'refute' : 'concede',
    reason: 'stub reason',
  }));
  process.stdout.write('noise before ' + JSON.stringify({ verdicts }) + ' noise after');
} else {
  const findings = model === 'claude'
    ? [
        { severity: 'high', file: 'a.js', line: 1, claim: 'shared issue', evidence: 'ev' },
        { severity: 'low', file: 'b.js', line: 2, claim: 'claude-only issue', evidence: 'ev' },
      ]
    : [
        { severity: 'high', file: 'a.js', line: 1, claim: 'shared issue (codex view)', evidence: 'ev' },
        { severity: 'medium', file: 'c.js', line: 3, claim: 'codex-only issue', evidence: 'ev' },
      ];
  process.stdout.write(JSON.stringify({ findings }));
}
