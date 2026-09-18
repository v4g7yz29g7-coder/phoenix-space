#!/bin/sh
# Wrapper: run the full require-call scan for the project.
cd "$(dirname "$0")" || exit 1
python3 .scan_require_calls.sh "$(pwd)"
