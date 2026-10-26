# action1-mcp-server: evaluation suite

This directory contains an evaluation suite for the MCP server in the
format of Anthropic's
[`mcp-builder` evaluation guide](https://github.com/anthropics/skills/blob/main/skills/mcp-builder/reference/evaluation.md):
each `<qa_pair>` has one question and one verifiable answer.

## Files

| File | Purpose |
|------|---------|
| `action1-eval.xml` | Multi-hop questions that can only be answered by calling the MCP tools. Every answer is a stable Action1 platform fact, no operator-specific data. |

## Question categories

All questions are platform-stable: the answer is a fact of Action1
itself (template ids, schema field names, parameter values for the
`run_script` payload, status-marker filter words, the four detected
platform values). They pass against any real Action1 instance without
operator-specific snapshots.

The harness compares answers as strings, so answers that depend on a
tenant's data cannot be part of this file. If you want org-specific
questions, fork the XML and keep them in a separate suite;
`action1-eval.xml` stays portable.

## Running the harness

The harness is `scripts/evaluation.py` in Anthropic's `mcp-builder`
repository (linked above), not part of this project. Install its
requirements with `pip install -r scripts/requirements.txt` (anthropic +
mcp). Running it needs a live Action1 tenant, a read-only credential and
an Anthropic API key, and it costs API usage.

```bash
python scripts/evaluation.py \
  -t stdio -c node -a dist/index.js \
  -e ACTION1_BASE_URL=https://app.eu.action1.com/api/3.0 \
  -e ACTION1_ORG_ID=<your-org-uuid> \
  -e ACTION1_CLIENT_ID=<your-client-id> \
  -e ACTION1_CLIENT_SECRET=<your-client-secret> \
  -o eval-report.md \
  evals/action1-eval.xml
```

The harness:

1. Boots the MCP server (stdio).
2. Issues each question to a Claude model.
3. Lets the model use any tool.
4. Compares the model's final answer to the `<answer>` value via direct
   string comparison.
5. Writes a Markdown report with pass/fail, per-task duration, tool calls.

## Status

The evaluation is not part of CI and no run result is committed. It is a
tool for checking tool descriptions against a real tenant before a
release. Schema and registration problems are caught without a tenant by
the test suite (`tests/integration/`), which calls the tools through MCP
with mocked Action1 responses.

## Scoring guidelines

The score is the share of questions answered correctly. Rough targets:

- 90 % or more: the tool layer works for an agent.
- 70 to 89 %: look at the failed questions; usually a tool description
  gap or a missing schema field.
- Below 70 %: review descriptions, examples and error messages.

The agent's feedback in the report is more useful than the raw score:
treat low scores as a prompt to improve descriptions and add examples.

## Adding more questions

Follow these rules from the evaluation guide:

1. **Independent**: no question depends on the answer of another.
2. **Read-only**: never invokes destructive tools.
3. **Complex**: at least two tool calls or one piece of careful schema
   reasoning.
4. **Realistic**: the kind of question a real RMM operator would care
   about (patch posture, online fleet, vulnerability count).
5. **Verifiable**: a single string compare on the answer.
6. **Stable**: the answer doesn't change as time passes / endpoints
   churn.
