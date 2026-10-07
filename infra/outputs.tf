output "api_endpoint" {
  description = "Default HTTP API endpoint. Requests still need a JWT accepted by the authorizer."
  value       = aws_apigatewayv2_api.http.api_endpoint
}

output "table_name" {
  value = aws_dynamodb_table.progress.name
}

output "function_name" {
  value = aws_lambda_function.progress.function_name
}
