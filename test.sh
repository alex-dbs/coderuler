#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$ROOT/tests/manual/vulnerable_code.js"
BASE_URL="${TYPESAFE_BASE_URL:-https://api.typesafe.ai}"
MODEL="${TYPESAFE_DEFAULT_MODEL:-jev-latest}"

: "${TYPESAFE_API_KEY:?Export TYPESAFE_API_KEY before running test.sh}"

jq -n --rawfile state "$SOURCE" --arg model "$MODEL" '{
  model: $model,
  state: $state,
  questions: {
    follows_instructions: {
      type: "noul",
      instructions: {
        rule: "Check whether attacker-controlled data can inject carriage returns (\r) or newlines (\n) into HTTP response headers or the status line, including through writeHead()’s reason phrase or statusMessage, without validation that rejects those characters (CWE-113).",
      },
      "criteria": {
        "true": "The code is vulnerable"
      }
    }
  }
}' |
  curl --fail-with-body --silent --show-error \
    -H "Authorization: Bearer $TYPESAFE_API_KEY" \
    -H 'Content-Type: application/json' \
    --data-binary @- \
    "${BASE_URL%/}/v1/systemone"
