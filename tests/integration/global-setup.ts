import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
  type DescribeTableCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { COMPLETIONS_INDEX, TEST_ENDPOINT, TEST_REGION, TEST_TABLE } from "../constants.js";

export default async function setup(): Promise<void> {
  const client = new DynamoDBClient({
    region: TEST_REGION,
    endpoint: TEST_ENDPOINT,
    credentials: {
      accessKeyId: "localkey",
      secretAccessKey: "localkey",
    },
    maxAttempts: 5,
  });

  const existing = await describeTable(client);
  if (existing) {
    assertIndex(existing);
    return;
  }

  await client.send(
    new CreateTableCommand({
      TableName: TEST_TABLE,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
        { AttributeName: "gsi1pk", AttributeType: "S" },
        { AttributeName: "gsi1sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: COMPLETIONS_INDEX,
          KeySchema: [
            { AttributeName: "gsi1pk", KeyType: "HASH" },
            { AttributeName: "gsi1sk", KeyType: "RANGE" },
          ],
          Projection: {
            ProjectionType: "INCLUDE",
            NonKeyAttributes: [
              "learnerId",
              "lessonId",
              "entityType",
              "status",
              "score",
              "version",
              "pointsAwarded",
              "completedAt",
            ],
          },
        },
      ],
    }),
  );

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const described = await describeTable(client);
    const index = described?.Table?.GlobalSecondaryIndexes?.find((item) => item.IndexName === COMPLETIONS_INDEX);
    if (described?.Table?.TableStatus === "ACTIVE" && index?.IndexStatus === "ACTIVE") {
      return;
    }
    await delay(200);
  }

  throw new Error(`Table ${TEST_TABLE} did not become active.`);
}

function assertIndex(described: DescribeTableCommandOutput): void {
  const hasIndex = described.Table?.GlobalSecondaryIndexes?.some((index) => index.IndexName === COMPLETIONS_INDEX);
  if (!hasIndex) {
    throw new Error(
      `Table ${TEST_TABLE} exists without ${COMPLETIONS_INDEX}. Restart the in-memory DynamoDB Local container.`,
    );
  }
}

async function describeTable(client: DynamoDBClient): Promise<DescribeTableCommandOutput | null> {
  try {
    return await client.send(new DescribeTableCommand({ TableName: TEST_TABLE }));
  } catch (error) {
    if (error instanceof ResourceNotFoundException || (error instanceof Error && error.name === "ResourceNotFoundException")) {
      return null;
    }
    throw error;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
