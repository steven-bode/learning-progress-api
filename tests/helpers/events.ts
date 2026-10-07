import type { ProgressHttpEvent } from "../../src/http/event.js";

export function gatewayEvent(input: {
  routeKey: string;
  rawPath?: string;
  body?: string;
  headers?: Record<string, string>;
  pathParameters?: Record<string, string>;
  queryStringParameters?: Record<string, string>;
  learnerSub?: string;
  requestId?: string;
  isBase64Encoded?: boolean;
}): ProgressHttpEvent {
  const method = input.routeKey.split(" ")[0] ?? "GET";
  const rawPath = input.rawPath ?? "/";
  return {
    version: "2.0",
    routeKey: input.routeKey,
    rawPath,
    rawQueryString: "",
    headers: input.headers ?? {},
    ...(input.queryStringParameters ? { queryStringParameters: input.queryStringParameters } : {}),
    ...(input.pathParameters ? { pathParameters: input.pathParameters } : {}),
    ...(input.body !== undefined ? { body: input.body } : {}),
    isBase64Encoded: input.isBase64Encoded ?? false,
    requestContext: {
      accountId: "123456789012",
      apiId: "demoapi",
      domainName: "example.execute-api.eu-central-1.amazonaws.com",
      domainPrefix: "example",
      requestId: input.requestId ?? "req-test",
      routeKey: input.routeKey,
      stage: "$default",
      time: "07/Oct/2026:09:00:00 +0000",
      timeEpoch: 1_759_827_600_000,
      http: {
        method,
        path: rawPath,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "vitest",
      },
      ...(input.learnerSub
        ? {
            authorizer: {
              jwt: {
                claims: { sub: input.learnerSub },
                scopes: ["openid"],
              },
            },
          }
        : {}),
    },
  };
}
