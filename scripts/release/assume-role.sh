#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo 'usage: assume-role.sh ROLE_ARN PROFILE SESSION_NAME' >&2
  exit 64
fi
role_arn=$1
profile=$2
session_name=$3
: "${AWS_SHARED_CREDENTIALS_FILE:?AWS_SHARED_CREDENTIALS_FILE must be set}"

umask 077
mkdir -p "$(dirname "$AWS_SHARED_CREDENTIALS_FILE")"
credentials=$(aws sts assume-role --role-arn "$role_arn" --role-session-name "$session_name" \
  --duration-seconds 3600 --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)
read -r access_key secret_key session_token <<<"$credentials"
aws configure set aws_access_key_id "$access_key" --profile "$profile"
aws configure set aws_secret_access_key "$secret_key" --profile "$profile"
aws configure set aws_session_token "$session_token" --profile "$profile"
unset credentials access_key secret_key session_token
echo "Created short-lived AWS profile: $profile"
