#!/usr/bin/env bash
set -eu
source .env

curl --silent --show-error --fail-with-body \
  "${TYPESAFE_BASE_URL%/}/v1/systemone" \
  -H "Authorization: Bearer ${TYPESAFE_API_KEY}" \
  -H 'Content-Type: application/json' \
  --data-binary @- <<'JSON'
{
  "model": "jev-1.13",
  "state": {
      "url": "/service/v1/billing/invoices/{invoice_id}"
  },
  "questions": {
    "follows_instructions": {
      "type": "noul",
      "instructions": {
        "rule": "The URL must begin with `/service/vX/`, where X is a number. The one path segment immediately after this prefix must itself be a plural resource noun. A singular noun or an uncountable activity name in that position violates the rule. Do not skip to a later plural word. Further path segments are allowed only after this valid prefix.\n\nContrastive examples:\n- /service/v2/accounts/invoices is valid: accounts is plural.\n- /service/v2/accounting/invoices is invalid: accounting is not plural; later invoices does not fix it.\n-/service/v3/devices/users is valid: devices is plural.\n- /service/v3/device/users is invalid: device is singular; later users does not fix it.\n- /service/v1/transactions is valid.\n- /service/v3/invoices is valid.\n- /api/v2/bank_accounts and /internal/v1/invoices are invalid: wrong prefix.\n",
        "question": "Is the rule respected?"
      }
    }
  }
}
JSON
