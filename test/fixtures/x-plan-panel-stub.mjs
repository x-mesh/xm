#!/usr/bin/env node
const [model, role, requirements] = process.argv.slice(2);
if (String(model).includes('fail')) process.exit(1);
const decision = String(model).includes('critic') ? 'Safer staged approach' : 'Direct implementation';
const plan = {
  schema_version: 1, status: 'complete', executable: true, goal: String(requirements).split(/\r?\n/).find(Boolean) || 'Plan',
  requirements: [{ id: 'R1', text: `${role}: ${requirements}`, priority: 'must' }], assumptions: [],
  decision: { selected: decision, alternatives: [] },
  tasks: [{ id: 'T1', title: `${role} task`, depends_on: [], requirement_refs: ['R1'], expected_files: [], done_criteria: ['verified'] }],
  steps: [['T1']], validation: { commands: ['bun test'], requirement_refs: [] }, disagreements: [], unresolved_questions: [], provenance: { model, role },
};
process.stdout.write(`candidate from ${model}\n${JSON.stringify(plan)}\n`);
