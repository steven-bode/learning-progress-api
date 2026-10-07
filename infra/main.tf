resource "aws_dynamodb_table" "progress" {
  name         = "${var.name}-progress"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  attribute {
    name = "gsi1pk"
    type = "S"
  }

  attribute {
    name = "gsi1sk"
    type = "S"
  }

  global_secondary_index {
    name            = "completions-by-lesson"
    projection_type = "INCLUDE"
    non_key_attributes = [
      "learnerId",
      "lessonId",
      "entityType",
      "status",
      "score",
      "version",
      "pointsAwarded",
      "completedAt",
    ]

    key_schema {
      attribute_name = "gsi1pk"
      key_type       = "HASH"
    }

    key_schema {
      attribute_name = "gsi1sk"
      key_type       = "RANGE"
    }
  }
}

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${var.name}-progress"
  retention_in_days = 14
}

data "aws_iam_policy_document" "assume_lambda" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "lambda" {
  statement {
    sid       = "ReadProgress"
    actions   = ["dynamodb:GetItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.progress.arn]
  }

  statement {
    sid       = "QueryLessonCompletions"
    actions   = ["dynamodb:Query"]
    resources = ["${aws_dynamodb_table.progress.arn}/index/completions-by-lesson"]
  }

  # DynamoDB authorizes items inside TransactWriteItems as PutItem and UpdateItem.
  statement {
    sid       = "TransactCompletionWrites"
    actions   = ["dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.progress.arn]

    condition {
      test     = "ForAnyValue:StringEquals"
      variable = "dynamodb:EnclosingOperation"
      values   = ["TransactWriteItems"]
    }
  }

  statement {
    sid = "WriteFunctionLogs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.lambda.arn}:*"]
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${var.name}-lambda"
  assume_role_policy = data.aws_iam_policy_document.assume_lambda.json
}

resource "aws_iam_role_policy" "lambda" {
  name   = "${var.name}-lambda"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda.json
}

resource "aws_lambda_function" "progress" {
  function_name    = "${var.name}-progress"
  filename         = var.lambda_zip_path
  source_code_hash = filebase64sha256(var.lambda_zip_path)
  handler          = "dist/index.handler"
  runtime          = "nodejs24.x"
  role             = aws_iam_role.lambda.arn
  timeout          = 10
  memory_size      = 256

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.progress.name
      AUTH_MODE  = var.auth_mode
    }
  }

  depends_on = [aws_cloudwatch_log_group.lambda]
}

resource "aws_apigatewayv2_api" "http" {
  name          = "${var.name}-http"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_authorizer" "jwt" {
  api_id           = aws_apigatewayv2_api.http.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "${var.name}-jwt"

  jwt_configuration {
    audience = [var.jwt_audience]
    issuer   = var.jwt_issuer
  }
}

resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.progress.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
  timeout_milliseconds   = 10000
}

resource "aws_apigatewayv2_route" "get_lesson_progress" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "GET /me/lessons/{lessonId}/progress"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
  target             = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_route" "list_progress" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "GET /me/progress"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
  target             = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_route" "complete_lesson" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "POST /me/lessons/{lessonId}/completion"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
  target             = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "http_api" {
  statement_id  = "AllowHttpApiInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.progress.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}
