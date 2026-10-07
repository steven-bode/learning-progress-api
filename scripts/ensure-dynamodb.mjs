import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { execSync } from "node:child_process";

const endpoint = process.env.DYNAMODB_ENDPOINT ?? "http://127.0.0.1:8000";

execSync("docker compose up -d", { stdio: "inherit" });

const client = new DynamoDBClient({
  region: "eu-central-1",
  endpoint,
  credentials: {
    accessKeyId: "localkey",
    secretAccessKey: "localkey",
  },
  maxAttempts: 1,
});

let ready = false;
for (let attempt = 0; attempt < 30; attempt += 1) {
  try {
    await client.send(new ListTablesCommand({ Limit: 1 }));
    ready = true;
    break;
  } catch {
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }
}

if (!ready) {
  console.error("DynamoDB Local did not become ready on " + endpoint);
  process.exit(1);
}
