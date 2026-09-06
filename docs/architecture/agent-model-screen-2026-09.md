# Agent model and reasoning screen — September 2026

## Decision before live testing

Keep the production default unchanged while screening candidates on the upgraded implementation. Model selection is an experiment, not an architectural migration. Use the existing OpenRouter route, fresh Rooms, identical paused Run copies and the four-question production probe. Assess factual/tool correctness before latency and cost. Reasoning settings must read back correctly and appear in saved provider requests.

The OpenRouter catalog was retrieved on 2026-09-06 at 12:32 UTC. The exact JSON is retained with the private experiment evidence at `/tmp/leitbild-foundations-cycle-20260906/openrouter-model-catalog.json`. Listed prices are catalog rates per million tokens, not an invoice guarantee; routing, long-context tiers and cache writes can affect actual cost. [OpenRouter model catalog](https://openrouter.ai/api/v1/models).

| Candidate | Explicit effort | Input / output / cached input ($/M) | Purpose |
| --- | --- | --- | --- |
| `openai/gpt-5.4` | provider default, then low | 2.50 / 15 / 0.25 | Same-model code comparison, then a reasoning ablation |
| `openai/gpt-5.6-sol` | low | 2 / 10 / 0.20 | Newer balanced candidate at lower catalog rates |
| `openai/gpt-6-astra` | low | 10 / 50 / 1 | Higher-capability candidate; must justify the premium |
| `qwen/qwen3.8-max-0902` | low | 2 / 6 / 0.25 | Independent provider family with tools and reasoning |
| `deepseek/deepseek-v4-pro-0813` | low | 1.12068 / 3.36204 / 0.037356 | Lower-cost independent family, subject to transport eligibility |

All five canonical models advertise tools and approximately one million tokens of context in the catalog. That does not justify expanding our working-history target. GPT-5.6 Luna, Qwen Flash, DeepSeek Flash and Claude are available alternatives, but expanding the first screen into every model/effort combination would add cost without answering the immediate question. Revisit cheaper variants or medium effort if the first results identify a useful trade-off.

## Reasoning is not a universal on/off improvement

Low effort is a deliberate first comparison for interactive discovery. Reasoning can reduce mistaken calls or improve interpretation, but it can also add latency and output-token cost. Medium is a follow-up candidate for difficult evidence interpretation, not an assumption that every sitrep needs more thinking. Astra requires reasoning; its lowest supported effort is low. Direct OpenAI tool use and OpenRouter-translated transport are distinct interfaces. [Astra model documentation](https://developers.openai.com/api/docs/models/gpt-6-astra), [OpenAI reasoning guidance](https://developers.openai.com/api/docs/guides/reasoning).

Qwen's current route defaults to a higher reasoning level, so leaving it implicit would confound the comparison. Use the explicit catalog-supported setting. [Qwen route documentation](https://openrouter.ai/qwen/qwen3.8-max-0902).

DeepSeek's thinking protocol requires prior assistant reasoning for tool-enabled continuations, including across user turns. Our adapter retains current-turn continuation; normal Room replay does not reconstruct native provider reasoning from prior final answers. Test the real route before scoring it. A rejection is a transport limitation, not evidence of poor reasoning. Do not synthesize empty reasoning, reuse another call's opaque state, or silently disable thinking. [DeepSeek thinking protocol](https://api-docs.deepseek.com/guides/thinking_mode/).

## Acceptance and interpretation

1. Repeat the unchanged GPT-5.4/provider-default baseline on upgraded code.
2. Screen explicit low effort and the selected alternatives. Inspect actual model identity, continuation, calls, results and answers.
3. Re-run a promising configuration in another fresh Room before recommending a default.
4. Report factual regressions, transport failures and remaining unsupported cases separately. A four-question screen is not a general model ranking or a statistical benchmark.

Question 2 is intentionally harder than reading a number: it asks what the generator output means in this model and which limitations can actually be established. Persuasive engineering prose without implementation evidence is not a success. Historical recall must use retained prior evidence; deletion must trigger a fresh inventory. Current sitreps should not fetch historian samples without a relevant reason.

Results will be appended after deployment and execution. No candidate quality claim or default change follows from the catalog alone.
