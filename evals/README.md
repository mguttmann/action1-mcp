# action1-mcp-server — Evaluation Suite

This directory contains the skill-format evaluation suite for the MCP
server. It follows the official Anthropic
[`mcp-builder` skill](https://github.com/anthropics/skills/blob/main/skills/mcp-builder/reference/evaluation.md)
format, where each `<qa_pair>` has a single question and a single
verifiable answer.

## Files

| File | Purpose |
|------|---------|
| `action1-eval.xml` | 12 multi-hop, tool-only-verifiable questions exercising the MCP tools. Every answer is a stable Action1 platform fact — no operator-specific data. |

## Question categories

All 12 questions are platform-stable: the answer is a fact of Action1
itself (template ids, schema field names, parameter values for the
`run_script` payload, status-marker filter words, the four detected
platform values). They pass against any real Action1 instance without
operator-specific snapshots.

The earlier "OPERATOR-FILL-IN-FROM-ENV" placeholder approach was
removed in v0.3 because the skill's harness uses direct string
comparison and dynamic answers are inherently incompatible with that
contract. If you want org-specific evaluation questions, fork the XML
and add them as a separate suite — keep `action1-eval.xml` portable.

## Running the harness

The Anthropic skill ships a `scripts/evaluation.py` harness. Install it
via `pip install -r scripts/requirements.txt` (anthropic + mcp).

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

## Scoring guidelines

A perfect score is 10/10. Realistic targets:

- 9-10/10: server is publication-ready.
- 7-8/10: investigate failed pairs; usually a tool description gap or
  missing schema field.
- ≤6/10: tool layer needs review (descriptions, examples, error messages).

The skill explicitly notes the *agent's feedback* in the report is more
valuable than the raw score — treat low scores as a prompt to improve
descriptions and add examples, not as a rejection.

## Adding more questions

Stick to the skill's six rules:

1. **Independent**: no question depends on the answer of another.
2. **Read-only**: never invokes destructive tools.
3. **Complex**: at least two tool calls or one piece of careful schema
   reasoning.
4. **Realistic**: the kind of question a real RMM operator would care
   about (patch posture, online fleet, vulnerability count).
5. **Verifiable**: a single string compare on the answer.
6. **Stable**: the answer doesn't change as time passes / endpoints
   churn.
