import type { CheckResult, ScopeSubject } from '@alex-dbs/coderuler';

export interface GoldenCase {
  readonly group: string;
  readonly name: string;
  readonly status: 'pass' | 'skipped';
  readonly reason?: string;
  readonly evaluations: readonly {
    readonly subject: ScopeSubject;
    readonly result: CheckResult;
  }[];
}

export const GOLDEN_CASES: readonly GoldenCase[] = [
  {
    group: "billing-http-url-leaves",
    name: "01-file-url-leaves",
    status: "pass",
    evaluations: [
      {
        subject: { kind: 'scope', filepath: "proto/billing/v1/invoice.proto", id: "acme.billing.v1.BillingService.GetInvoice:/options/google.api.http/get", source: "\"/v1/billing/invoices/{invoice_id}\"", data: "/v1/billing/invoices/{invoice_id}", lines: { start: 8, end: 8 } },
        result: { status: 'pass' },
      },
      {
        subject: { kind: 'scope', filepath: "proto/billing/v1/invoice.proto", id: "acme.billing.v1.BillingService.CreateInvoice:/options/google.api.http/post", source: "\"/v1/billing/invoices\"", data: "/v1/billing/invoices", lines: { start: 16, end: 16 } },
        result: { status: 'pass' },
      },
      {
        subject: { kind: 'scope', filepath: "proto/billing/v1/invoice.proto", id: "acme.billing.v1.BillingService.CreateInvoice:/options/google.api.http/additional_bindings/get", source: "\"/v1/billing/invoices/{invoice_id}/items\"", data: "/v1/billing/invoices/{invoice_id}/items", lines: { start: 18, end: 18 } },
        result: { status: 'pass' },
      },
    ],
  },
  {
    group: "billing-http-url-leaves",
    name: "10-empty-url",
    status: "pass",
    evaluations: [
      {
        subject: { kind: 'scope', filepath: "proto/billing/v1/invoice.proto", id: "acme.billing.v1.BillingService.GetInvoice:/options/google.api.http/get", source: "\"\"", data: "", lines: { start: 8, end: 8 } },
        result: { status: 'pass' },
      },
    ],
  },
  {
    group: "billing-http-url-leaves",
    name: "11-unannotated-rpc",
    status: "skipped",
    reason: 'no matching subjects',
    evaluations: [
    ],
  },
  {
    group: "billing-http-url-leaves",
    name: "12-dotted-option-form",
    status: "pass",
    evaluations: [
      {
        subject: { kind: 'scope', filepath: "proto/billing/v1/invoice.proto", id: "acme.billing.v1.BillingService.GetInvoice:/options/google.api.http/get", source: "\"/v1/billing/invoices\"", data: "/v1/billing/invoices", lines: { start: 7, end: 7 } },
        result: { status: 'pass' },
      },
    ],
  },
  {
    group: "billing-http-url-leaves",
    name: "13-custom-binding",
    status: "pass",
    evaluations: [
      {
        subject: { kind: 'scope', filepath: "proto/billing/v1/invoice.proto", id: "acme.billing.v1.BillingService.GetInvoice:/options/google.api.http/custom/path", source: "\"/v1/billing/invoices\"", data: "/v1/billing/invoices", lines: { start: 10, end: 10 } },
        result: { status: 'pass' },
      },
    ],
  },
  {
    group: "billing-http-url-leaves",
    name: "14-excluded-file",
    status: "skipped",
    reason: 'no matching subjects',
    evaluations: [
    ],
  },
  {
    group: "billing-http-url",
    name: "11-file-rpcs",
    status: "pass",
    evaluations: [
      {
        subject: { kind: 'scope', filepath: "proto/billing/v1/invoice.proto", id: "acme.billing.v1.BillingService.GetInvoice", source: "rpc GetInvoice(GetInvoiceRequest) returns (GetInvoiceResponse) {\n    option (google.api.http) = {\n      get: \"/v1/billing/invoices/{invoice_id}\"\n    };\n  }", data: {"id":"acme.billing.v1.BillingService.GetInvoice","name":"GetInvoice","parent":"acme.billing.v1.BillingService","options":{"google.api.http":{"get":"/v1/billing/invoices/{invoice_id}"}}}, lines: { start: 6, end: 10 } },
        result: { status: 'pass' },
      },
      {
        subject: { kind: 'scope', filepath: "proto/billing/v1/invoice.proto", id: "acme.billing.v1.BillingService.CreateInvoice", source: "rpc CreateInvoice(CreateInvoiceRequest) returns (CreateInvoiceResponse) {\n    option (google.api.http) = {\n      post: \"/v1/billing/invoices\"\n      additional_bindings {\n        get: \"/v1/billing/invoices/{invoice_id}/items\"\n      }\n    };\n  }", data: {"id":"acme.billing.v1.BillingService.CreateInvoice","name":"CreateInvoice","parent":"acme.billing.v1.BillingService","options":{"google.api.http":{"post":"/v1/billing/invoices","additional_bindings":{"get":"/v1/billing/invoices/{invoice_id}/items"}}}}, lines: { start: 14, end: 21 } },
        result: { status: 'pass' },
      },
    ],
  },
  {
    group: "billing-http-url",
    name: "12-file-unannotated",
    status: "skipped",
    reason: 'no matching subjects',
    evaluations: [
    ],
  },
  {
    group: "billing-http-url",
    name: "13-file-excluded",
    status: "skipped",
    reason: 'no matching subjects',
    evaluations: [
    ],
  },
  {
    group: "corp-http-route",
    name: "01-route-paths",
    status: "pass",
    evaluations: [
      {
        subject: { kind: 'scope', filepath: "proto/organization_deactivations/firstparty/v3/deactivation_voucher_service.proto", id: "corp.account_management.api.organization_deactivations.firstparty.v3.DeactivationVoucherService.GetDeactivationVoucherEligibility:/options/corp.http.route/get", source: "\"/v3/organizations/:id/deactivation_voucher_eligibility\"", data: "/v3/organizations/:id/deactivation_voucher_eligibility", lines: { start: 16, end: 16 } },
        result: { status: 'pass' },
      },
      {
        subject: { kind: 'scope', filepath: "proto/organization_deactivations/firstparty/v3/deactivation_voucher_service.proto", id: "corp.account_management.api.organization_deactivations.firstparty.v3.DeactivationVoucherService.DeactivationVoucherRedeem:/options/corp.http.route/post", source: "\"/v3/organizations/:id/deactivation_voucher_redeem\"", data: "/v3/organizations/:id/deactivation_voucher_redeem", lines: { start: 23, end: 23 } },
        result: { status: 'pass' },
      },
    ],
  },
  {
    group: "memory-ratio",
    name: "11-file-containers-mixed",
    status: "pass",
    evaluations: [
      {
        subject: { kind: 'scope', filepath: "charts/payments-api/values.yaml", id: "0:payments-api", source: "name: payments-api\n    image: registry.example.com/payments-api:1.4.2\n    resources:\n      requests:\n        memory: 512Mi\n      limits:\n        memory: 2Gi\n", data: {"name":"payments-api","image":"registry.example.com/payments-api:1.4.2","resources":{"requests":{"memory":"512Mi"},"limits":{"memory":"2Gi"}}}, lines: { start: 2, end: 8 } },
        result: { status: 'pass' },
      },
      {
        subject: { kind: 'scope', filepath: "charts/payments-api/values.yaml", id: "0:ledger", source: "name: ledger\n    image: registry.example.com/ledger:2.0.0\n    resources:\n      requests:\n        memory: 256Mi\n", data: {"name":"ledger","image":"registry.example.com/ledger:2.0.0","resources":{"requests":{"memory":"256Mi"}}}, lines: { start: 9, end: 13 } },
        result: { status: 'pass' },
      },
      {
        subject: { kind: 'scope', filepath: "charts/payments-api/values.yaml", id: "0:cache", source: "name: cache\n    image: registry.example.com/cache:3.1.0\n    resources:\n      limits:\n        memory: 1Gi\n", data: {"name":"cache","image":"registry.example.com/cache:3.1.0","resources":{"limits":{"memory":"1Gi"}}}, lines: { start: 14, end: 18 } },
        result: { status: 'pass' },
      },
    ],
  },
  {
    group: "memory-ratio",
    name: "12-file-empty-and-null-settings",
    status: "skipped",
    reason: 'no matching subjects',
    evaluations: [
    ],
  },
  {
    group: "go-slice-append",
    name: "conditional-append-retained",
    status: "pass",
    evaluations: [
      {
        subject: { kind: 'scope', filepath: "internal/store/filter.go", id: "function_declaration:filterScores", source: "func filterScores(scores []int) []int {\n    out := make([]int, 0, len(scores))\n    for _, score := range scores {\n        if score > 0 {\n            out = append(out, score)\n        }\n    }\n    return out\n}", captures: {"SLICE":"out","ARGS":["score"]}, lines: { start: 3, end: 11 } },
        result: { status: 'pass' },
      },
    ],
  },
  {
    group: "go-slice-append",
    name: "file-candidates-and-noncandidates",
    status: "pass",
    evaluations: [
      {
        subject: { kind: 'scope', filepath: "internal/store/review.go", id: "function_declaration:addTags", source: "func addTags(tags []string) []string {\n    out := make([]string, len(tags))\n    for _, tag := range tags {\n        out = append(out, tag)\n    }\n    return out\n}", captures: {"SLICE":"out","ARGS":["tag"]}, lines: { start: 3, end: 9 } },
        result: { status: 'pass' },
      },
      {
        subject: { kind: 'scope', filepath: "internal/store/review.go", id: "function_declaration:growScores", source: "func growScores(scores []int) []int {\n    out := make([]int, 0, len(scores))\n    for _, score := range scores {\n        out = append(out, score)\n    }\n    return out\n}", captures: {"SLICE":"out","ARGS":["score"]}, lines: { start: 11, end: 17 } },
        result: { status: 'pass' },
      },
    ],
  },
];
