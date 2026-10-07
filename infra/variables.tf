variable "aws_region" {
  description = "Region for the demo resources."
  type        = string
  default     = "eu-central-1"
}

variable "name" {
  description = "Prefix for resource names."
  type        = string
  default     = "learning-progress"
}

variable "jwt_issuer" {
  description = "JWT issuer URL. API Gateway fetches the JWKS from this issuer."
  type        = string

  validation {
    condition     = startswith(var.jwt_issuer, "https://")
    error_message = "jwt_issuer must be an https URL."
  }
}

variable "jwt_audience" {
  description = "Expected JWT audience. API Gateway also accepts client_id when aud is absent."
  type        = string

  validation {
    condition     = length(var.jwt_audience) > 0
    error_message = "jwt_audience is required."
  }
}

variable "auth_mode" {
  description = "Lambda identity mode. Deployed functions must stay on jwt. local is test-only."
  type        = string
  default     = "jwt"

  validation {
    condition     = var.auth_mode == "jwt"
    error_message = "Deployed functions must use jwt. Local authentication is test-only."
  }
}

variable "lambda_zip_path" {
  description = "Path to the zip created by npm run package."
  type        = string
  default     = "../build/lambda.zip"
}
