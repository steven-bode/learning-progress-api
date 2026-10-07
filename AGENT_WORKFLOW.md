# Agent workflow

This file records the original implementation session, the CI run that followed the first push, and a later correction pass. It does not claim a human review, an AWS deployment, or that IAM was verified in an AWS account.

## Original implementation session

The workspace was empty. The demo was created at the workspace root. The npm package name is `learning-progress-api`.

The API is three routes on one Lambda, using API Gateway HTTP API payload format 2.0 and one DynamoDB table:

- Read one lesson progress item.
- List a learner's lesson items with an opaque cursor.
- Complete a lesson once, with a score from 0 to 100, `expectedVersion`, and an `Idempotency-Key`.

A missing progress item is logical version 0. The first completion is a conditional put. Ten points are added on the summary item in the same transaction as the progress item and the idempotency record. A retry must not award points twice.

Constraints that stayed in force:

- TypeScript strict checking, with `tsc --noEmit` separate from the emit used for the Lambda package.
- AWS SDK for JavaScript v3, client created outside the request path and reused.
- No learner id from the request body. Deployed identity comes from the JWT `sub` claim. `AUTH_MODE=local` is test-only and is rejected by Terraform.
- Fail closed when that identity is missing.
- Do not log tokens, secrets, or request bodies. Do not return stack traces or raw AWS errors.
- DynamoDB Local via Docker Compose for repository and handler tests. Do not mock the DynamoDB behavior those tests exist to check.
- Minimal Terraform. Do not apply it or deploy unless a later instruction says so.
- Keep the design small enough to explain.

Decisions made in that session:

- Runtime is `nodejs24.x`. `nodejs26.x` was documented as a public preview, so it was not used.
- Package versions were taken from the npm registry: SDK clients `3.1147.0`, `@aws-sdk/util-dynamodb` `3.996.9`, Zod `4.6.5`, Vitest `5.0.3`, TypeScript `7.0.2`, `@types/node` `24.19.1`, `@types/aws-lambda` `8.10.164`, `@smithy/node-http-handler` `4.12.1`.
- DynamoDB Local image is `amazon/dynamodb-local:3.3.1`. Terraform AWS provider is `6.67.0`.
- `GET` of a lesson with no item returns `404` `PROGRESS_NOT_FOUND`. The client treats that as version 0.
- A replay returns the stored `201` body and sets `idempotent-replayed: true`.
- Unknown body fields, including `learnerId`, are rejected.
- Page size defaults to 20 and cannot exceed 50.
- The cursor is base64url JSON `{ v, pk, sk }`. A cursor for another learner is `403`.
- The GSI projects the progress attributes needed to list completions. It is not exposed as an HTTP route.
- Idempotency records are not expired. `ClientRequestToken` is not used.
- Terraform region default is `eu-central-1`. Issuer and audience have no defaults.
- There is no local HTTP server. Tests call the handler with payload format 2.0 events.

Checks that ran in that session, on 7 October 2026:

- AWS documentation for Lambda runtimes, the Node.js runtime, HTTP API JWT authorizers, and `TransactWriteItems` was fetched.
- `npm view` was used for the package versions above.
- `npm install` succeeded with Node `24.21.0` and npm `11.19.0`.
- `npx tsc --noEmit -p tsconfig.json` succeeded.
- `npx tsc -p tsconfig.build.json` succeeded.
- `npm run test:unit` succeeded: Vitest 5.0.3, 3 files, 14 tests.
- `terraform init -backend=false` installed `hashicorp/aws` `6.67.0`.
- `terraform validate` succeeded after the GSI `key_schema` change. `terraform fmt` was applied.

Checks that did not run in that session:

- `npm run test:integration`, and therefore the repository and handler tests against DynamoDB Local.
- `npm test` as a whole.
- `npm run package`.
- The GitHub Actions workflow. It had not been pushed yet.
- `terraform plan`, `terraform apply`, and any call to AWS.

`docker compose up` failed because the Docker daemon was not running. The socket `unix:///Users/stevenbode/.docker/run/docker.sock` did not exist. No integration test was deleted to hide that.

Corrections made during implementation:

- `npm install` on Node `23.10.0` / npm `10.9.2` failed with `Cannot read properties of null (reading 'edgesOut')` while resolving Vitest 5. The same install succeeded on Node 24.
- `terraform validate` warned that the global secondary index `hash_key` and `range_key` arguments are deprecated in AWS provider 6.67.0. They were replaced with `key_schema` blocks. The following validate completed without warnings.
- An unused client list in the repository test was removed before that test file could be executed.

The first commit and push were not done by that session. They happened afterwards.

## Verified CI after the first push

GitHub Actions run [37610425776](https://github.com/steven-bode/learning-progress-api/actions/runs/37610425776) completed with conclusion `success`. The job was `check` on commit `bcb5a5c5b8d55f9443cadb17f9503430e39b7229`, display title `first commit`.

The successful steps were checkout, setup-node, `npm ci`, `npm run typecheck`, and `npm test`. That `npm test` includes the DynamoDB Local integration and handler tests, so those tests ran on the GitHub-hosted runner for that commit. They had not run in the original local session.

The run page also shows an annotation that Node.js 20 is deprecated and that `actions/checkout@v4` and `actions/setup-node@v4` are forced onto Node.js 24. The workflow file was not changed for that annotation.

That CI run does not cover the corrections below. It also does not deploy, run `terraform plan`, or verify the IAM policy in AWS.

## Review findings corrected afterwards

These are corrections from a repository review. They are not a human review.

- The Lambda policy allowed `dynamodb:TransactWriteItems` and omitted the item actions DynamoDB actually checks inside that call. AWS documents those as `dynamodb:PutItem` and `dynamodb:UpdateItem`, and shows `dynamodb:EnclosingOperation` to limit them to transactions. The policy now grants `GetItem` and `Query` for ordinary reads, `Query` on `completions-by-lesson`, and `PutItem` plus `UpdateItem` only when the enclosing operation is `TransactWriteItems`. The `dynamodb:TransactWriteItems` action was removed. This was checked against the DynamoDB transaction IAM page. It was not applied or simulated in AWS.
- The completion path had an update branch that required `status <> completed`. The stored schema and the API only create completed items, so that branch could not succeed. It was removed. `expectedVersion` 0 remains a conditional create. A mismatched version is still `VERSION_CONFLICT`. The current version of an already completed lesson is still `LESSON_ALREADY_COMPLETED`. Idempotency, progress creation, and points stay in one transaction. Documented status codes are unchanged. A non-zero `expectedVersion` is now classified by a consistent read. A concurrent create can be observed as `currentVersion` 0 if that read happens first, and it still awards no points. The demo does not show a successful optimistic-locking update.
- SDK retries were three attempts with a per-call HTTP timeout, which is not the Lambda deadline. The SDK now makes one HTTP attempt. The handler passes `getRemainingTimeInMillis` into a per-request deadline. Repository retries use bounded exponential backoff with jitter, stop before the reserved response time is gone, and abort the in-flight call with that deadline. An abort or timeout does not claim the transaction was rolled back. The stored idempotency result is returned when time remains. Otherwise the client is told to reuse the same `Idempotency-Key`. Validation errors and business conflicts are not retried.
- `.cursor/rules/backend.mdc` and `.cursorignore` were added. The rule file is an instruction. `.cursorignore` limits file search. Neither configures command approval, and neither guarantees that a secret cannot be read through a terminal or another tool.

## Checks during this correction

Run locally on 7 October 2026 with Node `24.21.0`:

- `npx tsc --noEmit -p tsconfig.json` succeeded. `npm run build` runs that check again and then emits `dist/`.
- `npm run test:unit` succeeded: Vitest 5.0.3, 4 files, 21 tests. That includes deadline exhaustion, the retry limit, and recovery after an uncertain write.
- `npm run package` succeeded. `npm ci --omit=dev` added 32 packages. `build/lambda.zip` is present and `unzip -t` reported no errors.
- `terraform fmt` was applied in `infra/`. `terraform validate` succeeded with no warnings.

`npm run test:integration` did not run in that session. `docker compose up -d` failed with:

`unable to get image 'amazon/dynamodb-local:3.3.1': Cannot connect to the Docker daemon at unix:///Users/stevenbode/.docker/run/docker.sock. Is the docker daemon running?`

The socket was absent. The integration and handler tests were not skipped, weakened, or deleted.

## Verified CI for the review corrections

Those corrections were later committed as `0471778eafd23e5333888205c703a6fbc9144510`. GitHub Actions run [37613042957](https://github.com/steven-bode/learning-progress-api/actions/runs/37613042957) completed with conclusion `success` on that commit. The job `check` ran checkout, setup-node, `npm ci`, `npm run typecheck`, and `npm test`.

The same Node.js 20 deprecation annotation is present for `actions/checkout@v4` and `actions/setup-node@v4`. The workflow file was not changed.

That run validates commit `0471778`. It does not validate the idempotency classification correction below. It does not deploy, run `terraform plan`, or verify the IAM policy in AWS.

## Idempotency classification after exhausted retries

After retryable cancellations reached the retry limit, classification read only the lesson progress. A concurrent request with the same `Idempotency-Key` could already have committed, and the response could be `VERSION_CONFLICT` instead of the stored result.

Classification now reads that learner's idempotency record first, with a strongly consistent read. A matching fingerprint is replayed. A different fingerprint is `IDEMPOTENCY_CONFLICT`. If the record is absent, progress is read, and the idempotency record is read again before a progress conflict is returned. If the remaining deadline cannot support that classification, the response is `TEMPORARILY_UNAVAILABLE` and tells the client to retry the same key. An uncertain write is still not described as rolled back.

Checks for this correction, on 7 October 2026 with Node `24.21.0`:

- `npm run typecheck` succeeded.
- `npm run test:unit` succeeded: Vitest 5.0.3, 4 files, 26 tests. The new cases cover a concurrent commit of the same key, a different fingerprint, a marker that appears between the two reads, a completion stored under a different key, and an exhausted budget that starts no further reads.

`npm run test:integration` did not run. `docker compose up -d` failed again because `unix:///Users/stevenbode/.docker/run/docker.sock` does not exist. The DynamoDB Local tests were left in place.

## Still pending

- Human review of the uncommitted idempotency classification change.
- A commit and push of that change. Neither was done here.
- `npm run test:integration` for this change, after Docker is running.
- `terraform plan`, `terraform apply`, deployment, and any check that the IAM policy works in AWS.
- Local tests do not verify AWS IAM.
