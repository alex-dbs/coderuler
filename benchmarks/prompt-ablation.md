# Jev prompt ablation

- AI model: `jev-1.13`, pinned for every stage. Regex is evaluated locally.
- Command per stage: `TYPESAFE_DEFAULT_MODEL=jev-1.13 node index.ts check tests/manual --rules .rulekeeper --json --verbose`.
- Corpus: the same three `.rulekeeper` rules and six matching manual verifications in every stage, including compliant and violating cases. No fixture or rule changed during the experiment.
- Controls: the three actual outbound AI request bodies per stage were checked for the intended prompt shape. Model, state, rule text, good/bad example contents and effective threshold (`0.4`, from the environment) were identical between stages.
- Measurement: one run per stage; every cell below is the actual returned compliance probability and reported verdict. Verdicts were not recomputed from the probability.
- Decision after the ablation: use the original request format (A), not the structured-criteria variant (E). The results below remain historical measurements.

## Variants

The outer `questions.follows_instructions` entry remains a `noul` in every stage. “Question” below means only the nested `instructions.question` field, originally `Is the rule respected?`.

| Stage | Variant and isolated change | Started (UTC) |
| --- | --- | --- |
| A — Original | Rule, good/bad examples and question in instructions; no criteria. | 2026-10-16T21:57:23.808+00:00 |
| B — Remove question | A without instructions.question; examples remain in instructions. | 2026-10-16T21:57:42.040+00:00 |
| C — Move examples | Rule-only instructions; good/bad examples in criteria.true/false; no explanations. | 2026-10-16T21:57:58.918+00:00 |
| D — Explain true | C plus criteria.true.what: ALL requirements from the rule are respected. | 2026-10-16T21:58:06.253+00:00 |
| E — Structured false | D plus criteria.false.what: At least one requirement of the rule is violated. | 2026-10-16T21:58:18.275+00:00 |
| F — Alternative false | D plus criteria.false.what: The evaluated state fails at least one requirement of the rule. | 2026-10-16T21:58:27.251+00:00 |

## All verification results

| Verification | Returned model | Expected | A | B | C | D | E | F |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Env folder group | jev-1.13 | PASS | 0.94 PASS | 0.83 PASS | 0.8 PASS | 0.86 PASS | 0.87 PASS | 0.88 PASS |
| Memory: compliant | jev-1.13 | PASS | 0.99 PASS | 0.98 PASS | 0.97 PASS | 0.97 PASS | 0.98 PASS | 0.98 PASS |
| Memory: production | jev-1.13 | VIOLATION | 0.02 VIOLATION | 0.04 VIOLATION | 0.03 VIOLATION | 0.03 VIOLATION | 0.03 VIOLATION | 0.02 VIOLATION |
| Proto: CreateInvoice URL | regex | PASS | 1 PASS | 1 PASS | 1 PASS | 1 PASS | 1 PASS | 1 PASS |
| Proto: /public/ URL | regex | VIOLATION | 0 VIOLATION | 0 VIOLATION | 0 VIOLATION | 0 VIOLATION | 0 VIOLATION | 0 VIOLATION |
| Proto: GetInvoice URL | regex | PASS | 1 PASS | 1 PASS | 1 PASS | 1 PASS | 1 PASS | 1 PASS |

## Interpretation

- Every stage matched all six expected verdicts, including all three AI cases. Regex controls were unchanged. This experiment showed no classification-accuracy gain from any prompt change.
- The original prompt had the strongest observed compliance probabilities on both positive AI cases and tied the lowest probability on the violating AI case. Removing the question worsened score direction on all three AI cases; moving examples had mixed effects.
- Adding the true and false explanations recovered some positive-case score margin. The alternative false explanation marginally improved the observed scores compared with the structured false explanation, without changing a verdict.
- These are single observations on three AI cases, not a statistically reliable estimate of prompt quality. Small differences can be model variability; repeat on a larger labeled corpus before choosing a prompt based on them.

## Verification identities

- **Env folder group**: `.rulekeeper/duplicated-env.yaml`; `group folder tests/manual`.
- **Memory: compliant**: `.rulekeeper/memory.yaml`; `scope tests/manual/compliant.yml 0:/app/container/resources`.
- **Memory: production**: `.rulekeeper/memory.yaml`; `scope tests/manual/production.yml 0:/app/container/resources`.
- **Proto: CreateInvoice URL**: `.rulekeeper/public-proto.yaml`; `scope tests/manual/proto/public/service.proto acme.billing.v1.BillingService.CreateInvoice:/http/bindings/0/url`.
- **Proto: /public/ URL**: `.rulekeeper/public-proto.yaml`; `scope tests/manual/proto/public/service.proto acme.billing.v1.BillingService.CreateInvoice:/http/bindings/1/url`.
- **Proto: GetInvoice URL**: `.rulekeeper/public-proto.yaml`; `scope tests/manual/proto/public/service.proto acme.billing.v1.BillingService.GetInvoice:/http/bindings/0/url`.
