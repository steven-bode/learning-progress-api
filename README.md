# learning-progress-api

Small interview demo for a learner progress API. One TypeScript Lambda behind an API Gateway HTTP API stores lesson completions in DynamoDB. The repository is meant to be read and explained, not operated as a production platform.

## Scope

- `GET /me/lessons/{lessonId}/progress`
- `GET /me/progress`
- `POST /me/lessons/{lessonId}/completion`

A completion stores a score from 0 to 100 and awards 10 points. Each lesson can be completed once. There is no lesson catalog: a missing progress item is logical version 0.

## Stack

Checked against current docs and registries on 7 October 2026:

| Choice | Version | Why |
| --- | --- | --- |
| Lambda runtime | `nodejs24.x` | Supported GA runtime. `nodejs26.x` is still a public preview. |
| Local Node for the checks below | 24.21.0 | Vitest 5 requires Node 22.12+, 24, or 26. The machine default was 23.10.0. |
| AWS SDK for JavaScript | `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` 3.1147.0 | Pinned in the deployment package. The runtime-included SDK version varies by Region. |
| `@aws-sdk/util-dynamodb` | 3.996.9 | Latest published version at the time of the install. `lib-dynamodb` accepts `^3.996.9`. |
| Zod | 4.6.5 | Runtime validation. |
| Vitest | 5.0.3 | Unit, repository, and handler tests. |
| DynamoDB Local | `amazon/dynamodb-local:3.3.1` | Integration tests. |
| Terraform AWS provider | 6.67.0 | Declared for a later manual plan. Not applied. |

`npm run build` runs `tsc --noEmit` and then a separate emit. The SDK client is created once per execution environment and reused.

## Setup

```bash
nvm use
npm ci
docker compose up -d
npm test
```

`npm test` runs the unit tests, starts DynamoDB Local if Docker is available, and runs the repository and handler tests.

Other commands:

```bash
npm run typecheck
npm run build
npm run package
npm run dynamodb:down
```

`npm run package` writes `build/lambda.zip`. Run it before `terraform plan`.

## API

Deployed routes require `Authorization: Bearer <jwt>`. API Gateway validates the issuer and audience. The function reads the learner id from `requestContext.authorizer.jwt.claims.sub`.

Local tests set `AUTH_MODE=local` and send `x-local-learner-id`. That header is ignored unless the mode is exactly `local`. Terraform refuses any deployed mode other than `jwt`.

### Read one lesson

```bash
curl -sS "$API_URL/me/lessons/intro/progress" \
  -H "authorization: Bearer $TOKEN"
```

`200` returns the completed progress item. `404` with `PROGRESS_NOT_FOUND` means there is no item. Treat that as version 0.

### List progress

```bash
curl -sS "$API_URL/me/progress?limit=20" \
  -H "authorization: Bearer $TOKEN"
```

```json
{
  "totalPoints": 10,
  "items": [
    {
      "lessonId": "intro",
      "status": "completed",
      "score": 80,
      "version": 1,
      "pointsAwarded": 10,
      "completedAt": "2026-10-07T09:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

`limit` defaults to 20 and must be an integer from 1 to 50. `nextCursor` is an opaque base64url value. Send it back as `cursor`. The cursor must belong to the authenticated learner and to this lesson query. Pagination ends when `nextCursor` is `null`. An empty `items` array is not proof that the query is finished, because a filter could skip a whole page. This query has no filter, and the code still keys the cursor only off `LastEvaluatedKey`.

`totalPoints` comes from a separate consistent read of the summary item. It is not one snapshot with the page.

### Complete a lesson

```bash
curl -sS "$API_URL/me/lessons/intro/completion" \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -H "idempotency-key: 4f3c0a1e-6b2d-4c8a-9d5e-1a2b3c4d5e6f" \
  -d '{"score":80,"expectedVersion":0}'
```

First success is `201`:

```json
{
  "lessonId": "intro",
  "status": "completed",
  "score": 80,
  "version": 1,
  "pointsAwarded": 10,
  "completedAt": "2026-10-07T09:00:00.000Z"
}
```

The same key and the same score, lesson, and `expectedVersion` return that stored `201` body again, with `idempotent-replayed: true`. Points are not awarded again.

The same key with a different payload returns `409` `IDEMPOTENCY_CONFLICT`.

A different key after the lesson is already stored:

- `expectedVersion` does not match the stored version: `409` `VERSION_CONFLICT`, including `currentVersion`. No points are awarded.
- `expectedVersion` matches and the lesson is completed: `409` `LESSON_ALREADY_COMPLETED`. No points are awarded.

The body schema is strict. `learnerId` in the body is rejected.

### Errors

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request body is invalid.",
    "requestId": "request-id",
    "details": [{ "path": "score", "message": "Score must be an integer from 0 to 100." }]
  }
}
```

| HTTP | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Body, path, cursor, limit, or idempotency key is invalid. |
| 401 | `MISSING_IDENTITY` | JWT `sub` or the local test header is missing or not a safe id. |
| 403 | `FORBIDDEN` | The cursor belongs to another learner. |
| 404 | `PROGRESS_NOT_FOUND` | This learner has no item for the lesson. |
| 404 | `NOT_FOUND` | The route key is not one of the three routes. |
| 409 | `VERSION_CONFLICT` | `expectedVersion` does not match. `currentVersion` is 0 when the item is still absent. |
| 409 | `LESSON_ALREADY_COMPLETED` | The version matches and the lesson is already completed. |
| 409 | `IDEMPOTENCY_CONFLICT` | The key was reused for a different payload. |
| 503 | `TEMPORARILY_UNAVAILABLE` | The completion result is uncertain, or bounded retries could not finish it. Retry the same `Idempotency-Key`. A timeout does not mean the transaction was rolled back. |
| 500 | `INTERNAL_ERROR` | Anything else. The body does not include a stack trace or the AWS error. |

## Access patterns and schema

One table, partition key `pk`, sort key `sk`.

| Access | Key | API |
| --- | --- | --- |
| One learner's lesson | `pk = LEARNER#<learnerId>`, `sk = LESSON#<lessonId>` | `GetItem` |
| One learner's lessons, in lesson-id order | `pk = LEARNER#<learnerId>` and `sk begins_with LESSON#` | `Query`, consistent |
| Learner's point total | `pk = LEARNER#<learnerId>`, `sk = SUMMARY` | `GetItem`, consistent |
| Idempotency record | `pk = LEARNER#<learnerId>`, `sk = REQUEST#<idempotencyKey>` | `GetItem` inside conflict handling |
| Learners who completed a lesson | GSI `completions-by-lesson`, `gsi1pk = LESSON#<lessonId>` | `Query` on the index |

Progress items store `version`. Summary items store `totalPoints`. Idempotency items store a SHA-256 fingerprint of the operation, learner, lesson, score, and expected version, plus the successful response. Only completed progress items carry `gsi1pk` and `gsi1sk`, so the index stays sparse.

The GSI projects the progress fields needed to answer the query (`INCLUDE`), not every attribute that might be added later. `KEYS_ONLY` would force a second read per learner and add load to a hot lesson partition. `ALL` would copy new large attributes onto the index automatically.

The index partition is the lesson id. A popular lesson becomes a hot key. This demo does not shard it. A GSI read can lag behind the base-table write. The index can lag behind the successful write.

DynamoDB Local does not prove IAM, real GSI propagation timing, or production throttling.

## Idempotency and concurrency

`POST` requires `Idempotency-Key`. The record is stored under the authenticated learner, so the same key for two learners is two records.

One `TransactWriteItems` call creates a lesson that does not exist yet:

1. Put the idempotency record if `pk` does not exist.
2. Put the progress item when `expectedVersion` is 0.
3. Add 10 points to the summary.

`expectedVersion` 0 is the only successful write. It is a conditional create. A non-zero `expectedVersion` does not update the item. If that version is the stored completed version, the response is `LESSON_ALREADY_COMPLETED`. Any other version is `VERSION_CONFLICT`. This demo does not demonstrate a successful optimistic-locking update of existing progress. A non-zero `expectedVersion` is classified by a consistent read, not by a transaction. A concurrent create can therefore be seen as `currentVersion` 0 if that read happens first. It still awards no points.

A retry must not award points twice. Cancellation reasons stay in the order above:

- A failed idempotency condition is read and compared. The same fingerprint returns the stored result. A different fingerprint is a conflict.
- A failed progress condition is a version conflict. The missing item was version 0, and the stored item is already completed at version 1.
- `TransactionConflict` and throttling are retried with bounded exponential backoff and jitter, but only while the Lambda invocation still has time reserved for a response. When those retries stop, the learner's idempotency record is read before a progress conflict is returned, and again after the progress read. A matching record is replayed.
- A timeout or abort is uncertain. When time remains, the function reads the idempotency record and returns it. Otherwise it asks the client to retry the same key. It does not claim the transaction was rolled back.
- Validation errors and business conflicts are not retried.
- Other cancellation codes become an internal error. They are not treated as duplicates.

`ClientRequestToken` is not used. That token only covers ten minutes and 36 characters. These records are kept for the demo. A production table should expire them with a TTL and a documented retention window.

## Architecture

- `src/http` validates input, resolves identity, and maps errors.
- `src/domain` owns the point rule, the fingerprint, and conflict classification.
- `src/mapping` converts API and domain values to item attributes.
- `src/persistence` owns keys, the shared SDK client, and DynamoDB calls.

The SDK makes one HTTP attempt, with a 500 ms connection timeout and a 2 second request timeout. Those timeouts bound one call. They are not the Lambda deadline. The handler reads `getRemainingTimeInMillis` for that invocation, reserves 250 ms to answer, and aborts an in-flight call when that budget runs out. Repository retries stay inside the same budget. Lambda and the HTTP API integration are both limited to 10 seconds. Credentials are the Lambda execution role. Dummy local credentials are attached only when `DYNAMODB_ENDPOINT` is set.

Logs are one JSON object per request: request id, operation, duration, status, and an error category. Tokens, secrets, and request bodies are not logged.

Watch API Gateway `Count`, `4XXError`, `5XXError`, `Latency`, and `IntegrationLatency`. Watch Lambda `Invocations`, `Errors`, `Throttles`, `Duration`, and `ConcurrentExecutions`. Watch DynamoDB `ThrottledRequests`, `SystemErrors`, and `SuccessfulRequestLatency` on the table and the GSI. This repo does not create alarms or dashboards.

## Security boundaries

- Deployed routes use a JWT authorizer. Issuer and audience are Terraform variables.
- The learner id comes from the verified `sub` claim.
- Local authentication cannot be selected by a request header when `AUTH_MODE` is not `local`.
- Missing or malformed identity fails closed with `401`.
- Ids used in keys cannot contain `#` or whitespace.
- A cursor for another learner is `403`.
- Clients do not receive stack traces or raw AWS errors.

## Deployment

These commands are manual. Nothing in this repo has been applied.

```bash
npm run package
cd infra
terraform init
terraform plan -var-file=terraform.tfvars
terraform apply -var-file=terraform.tfvars
terraform destroy -var-file=terraform.tfvars
```

Copy `infra/terraform.tfvars.example` and replace the issuer and audience. `terraform plan` needs `build/lambda.zip`. Apply creates on-demand DynamoDB, Lambda, CloudWatch Logs, and an HTTP API. Those resources can incur charges. The role can `GetItem` and `Query` the table, and `Query` `completions-by-lesson`. `PutItem` and `UpdateItem` are allowed only when `dynamodb:EnclosingOperation` is `TransactWriteItems`, which is how DynamoDB authorizes items written by that call. The role can write to this function's log group. It has no embedded AWS keys. Local tests do not verify this IAM policy.

CI runs typecheck and tests only. It has no AWS credentials and does not publish a package.

## Limitations

- The only successful completion write is a conditional create at `expectedVersion` 0. There is no successful update of an existing progress item.
- One completion per lesson, and a score of 0 still awards 10 points.
- No user pool, no token issuer, and no deployed environment are included.
- Idempotency records are not expired.
- The lesson list and `totalPoints` are two reads.
- GSI queries are eventually consistent.
- A popular lesson can hot-partition the index.
- DynamoDB Local does not stand in for IAM, GSI lag, or account-level throttling.
- The handler is invoked in tests with API Gateway payload format 2.0 events. There is no local HTTP server.

## Agent instructions

`.cursor/rules/` tells an editor agent how to work in this repository. `.cursorignore` keeps common secret and state files out of that agent's file search. Neither file configures shell or tool approval, and neither is a guarantee that a secret cannot be read through a terminal or another integration. Those permissions are separate controls.
