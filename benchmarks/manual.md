# Rulekeeper benchmark

- Command: `node index.ts check tests/manual --rules .rulekeeper --json`
- Latest run: restored original instructions `{rule, examples, question}`, with no criteria. AI requests used the process-only override `TYPESAFE_DEFAULT_MODEL=jev-1.13`; `.env` was not changed. All current rules, including `service-proto`, were included.
- Score: the verdict the decision reported, preceded by the unrounded probability it returned and the model that returned it in parentheses, for example `0.4881 (jev-latest) PASS` or `0 (regex) VIOLATION`; a cell an earlier script wrote keeps its bare score.
- Missing: `—` means the run reported no verification for that rule and that scope or group.
- Columns: UTC ISO-8601 run timestamps. The rightmost column is the current run and the one before it the previous run; a row is kept while either of those two runs reported it.

| Rule | Verification | Structured criteria (2026-10-16T18:44:12.606Z) | Original restored (2026-10-16T22:11:10.065Z) |
| --- | --- | --- | --- |
| .rulekeeper/duplicated-env.yaml | group folder tests/manual | 0.89 (jev-1.13) PASS | 0.95 (jev-1.13) PASS |
| .rulekeeper/memory.yaml | scope tests/manual/compliant.yml 0:/app/container/resources | 0.98 (jev-1.13) PASS | 0.99 (jev-1.13) PASS |
| .rulekeeper/memory.yaml | scope tests/manual/production.yml 0:/app/container/resources | 0.03 (jev-1.13) VIOLATION | 0.02 (jev-1.13) VIOLATION |
| .rulekeeper/public-proto.yaml | scope tests/manual/proto/public/service.proto acme.billing.v1.BillingService.CreateInvoice:/http/bindings/0/url | 1 (regex) PASS | 1 (regex) PASS |
| .rulekeeper/public-proto.yaml | scope tests/manual/proto/public/service.proto acme.billing.v1.BillingService.CreateInvoice:/http/bindings/1/url | 0 (regex) VIOLATION | 0 (regex) VIOLATION |
| .rulekeeper/public-proto.yaml | scope tests/manual/proto/public/service.proto acme.billing.v1.BillingService.GetInvoice:/http/bindings/0/url | 1 (regex) PASS | 1 (regex) PASS |
| .rulekeeper/service-proto.yaml | scope tests/manual/proto/internal/service.proto acme.billing.v1.BillingService.GetInvoice:/http/bindings/0/url | — | 0.54 (jev-1.13) PASS |
