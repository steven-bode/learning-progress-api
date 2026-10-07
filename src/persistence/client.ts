import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { loadConfig, type AppConfig } from "../config.js";

export const SDK_MAX_ATTEMPTS = 1;
export const SDK_CONNECTION_TIMEOUT_MS = 500;
export const SDK_REQUEST_TIMEOUT_MS = 2_000;

let documentClient: DynamoDBDocumentClient | undefined;

export function createDocumentClient(config: AppConfig): DynamoDBDocumentClient {
  const client = new DynamoDBClient({
    region: config.region,
    // One HTTP attempt. The repository retries against the Lambda deadline.
    maxAttempts: SDK_MAX_ATTEMPTS,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: SDK_CONNECTION_TIMEOUT_MS,
      requestTimeout: SDK_REQUEST_TIMEOUT_MS,
      throwOnRequestTimeout: true,
    }),
    // Local DynamoDB still signs requests. Dummy credentials stay off the Lambda path.
    ...(config.dynamoEndpoint
      ? {
          endpoint: config.dynamoEndpoint,
          credentials: {
            accessKeyId: "localkey",
            secretAccessKey: "localkey",
          },
        }
      : {}),
  });

  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
}

export function getDocumentClient(): DynamoDBDocumentClient {
  if (!documentClient) {
    // Reuse the client across warm invocations.
    documentClient = createDocumentClient(loadConfig(process.env));
  }
  return documentClient;
}
