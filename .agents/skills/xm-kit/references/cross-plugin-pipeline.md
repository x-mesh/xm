# Cross-Plugin Pipeline

Standard data flow connecting x-build, x-op, and x-eval.

## Pipeline Flow

```
x-build plan → PRD → x-op strategy --verify → x-eval score → x-build tasks update --score
```

## Standard Payload Schema

Structure that the leader constructs internally when passing data between plugins:

```json
{
  "xkit_payload": {
    "version": 1,
    "source": "x-build|x-op|x-eval",
    "type": "prd|strategy-output|eval-result",
    "content": "markdown text",
    "metadata": {
      "project": "project-name",
      "strategy": "refine|null",
      "rubric": "general|code-quality|plan-quality|null",
      "score": 7.8,
      "timestamp": "ISO8601"
    }
  }
}
```

## Plugin Responsibilities

| Plugin | Produces | Consumes |
|--------|----------|----------|
| x-build | PRD, task list, project context | eval scores, strategy outputs |
| x-op | strategy output, self-score | PRD (as context), eval feedback |
| x-eval | rubric scores, judge feedback | strategy output, code output |

## Integration Points

| Trigger | From | To | Data |
|---------|------|----|------|
| `x-build plan` complete | x-build | x-op | PRD + task list |
| `x-op --verify` complete | x-op | x-eval | strategy output for scoring |
| score < threshold | x-eval | x-op | feedback for retry |
| task complete | x-op | x-build | score + output for task update |
