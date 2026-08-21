function list(values, empty = 'None') {
  return values.length ? values.map((value) => '- ' + value).join('\n') : '- ' + empty;
}

export function renderPlan(plan, { artifactPath = null } = {}) {
  const sections = [
    '# Plan: ' + plan.goal,
    'Status: ' + plan.status + ' · Executable: ' + (plan.executable ? 'yes' : 'no'),
    '## Decision',
    plan.decision.selected || 'Not decided',
  ];

  if (plan.decision.alternatives.length) {
    sections.push('### Alternatives', list(plan.decision.alternatives.map((item) => item.name + ': ' + item.rejected_because)));
  }
  sections.push('## Requirements', list(plan.requirements.map((item) => '[' + item.id + '] (' + item.priority + ') ' + item.text)));
  if (plan.assumptions.length) {
    sections.push('## Assumptions', list(plan.assumptions.map((item) => '[' + item.id + '] ' + item.text + ' (' + item.confidence + ')' + (item.evidence ? ' — ' + item.evidence : ''))));
  }

  sections.push('## Implementation plan');
  for (let index = 0; index < plan.steps.length; index += 1) {
    sections.push('### Step ' + (index + 1));
    for (const id of plan.steps[index]) {
      const task = plan.tasks.find((item) => item.id === id);
      if (!task) continue;
      const details = ['- [' + task.id + '] ' + task.title];
      if (task.depends_on.length) details.push('  - Depends on: ' + task.depends_on.join(', '));
      if (task.expected_files.length) details.push('  - Files: ' + task.expected_files.join(', '));
      details.push('  - Done when: ' + task.done_criteria.join('; '));
      sections.push(details.join('\n'));
    }
  }

  sections.push('## Validation', list(plan.validation.commands, 'No commands recorded'));
  if (plan.disagreements.length) {
    sections.push('## Disagreements', list(plan.disagreements.map((item) => item.topic + ': ' + item.positions.join(' / ') + ' → ' + (item.resolution || 'unresolved'))));
  }
  if (plan.unresolved_questions.length) sections.push('## Open questions', list(plan.unresolved_questions));
  if (artifactPath) sections.push('Plan artifact: ' + artifactPath);
  return sections.join('\n\n') + '\n';
}

export function renderValidation(result) {
  if (result.valid) return 'PlanEnvelope is valid. Executable: ' + (result.value.executable ? 'yes' : 'no') + '\n';
  return ['PlanEnvelope is invalid.', ...result.errors.map((entry) => '- [' + entry.code + '] ' + entry.path + ': ' + entry.message)].join('\n') + '\n';
}
