export type AuthMode = "local" | "jwt";

export interface AppConfig {
  tableName: string;
  region: string;
  authMode: AuthMode;
  dynamoEndpoint?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const tableName = env.TABLE_NAME;
  if (!tableName) {
    throw new Error("TABLE_NAME is not configured.");
  }

  const region = env.AWS_REGION || "eu-central-1";
  const dynamoEndpoint = env.DYNAMODB_ENDPOINT;

  return {
    tableName,
    region,
    // Anything other than the explicit local mode stays on the deployed JWT path.
    authMode: env.AUTH_MODE === "local" ? "local" : "jwt",
    ...(dynamoEndpoint ? { dynamoEndpoint } : {}),
  };
}
