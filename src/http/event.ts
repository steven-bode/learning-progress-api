import type {
  APIGatewayEventRequestContextV2,
  APIGatewayProxyEventV2WithRequestContext,
} from "aws-lambda";

export type ProgressHttpEvent = APIGatewayProxyEventV2WithRequestContext<
  APIGatewayEventRequestContextV2 & {
    authorizer?: {
      jwt?: {
        claims?: Record<string, string | number | boolean | string[]>;
        scopes?: string[] | null;
      };
    };
  }
>;
