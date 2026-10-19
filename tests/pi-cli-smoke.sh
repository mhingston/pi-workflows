#!/usr/bin/env bash
# Actual pinned Pi executable + extension, driven through a pseudo terminal.
# Linux CI needs "script" from util-linux. No model credentials are required.
set -euo pipefail
output="$(mktemp)"
trap 'rm -f "$output"' EXIT
{
  sleep 3
  printf '/workflow list\r'
  sleep 4
  printf "/workflow run dynamic_agents --input-json '{\"values\":[1,2,3],\"requiresApproval\":false}'\r"
  sleep 7
  printf '/quit\r'
  sleep 1
} | TERM=xterm-256color timeout -k 3s 35s script -q -e -c   'stty cols 180 rows 50; ./node_modules/.bin/pi --no-session --extension ./src/pi-extension.ts' "$output" >/dev/null

python3 - "$output" <<'PY'
import re
import sys
raw = open(sys.argv[1], 'rb').read()
# Strip ANSI cursor/format controls and NULs from recorded PTY writes.
plain = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', raw).replace(b'\x00', b'')
plain = re.sub(rb'\x1b\][^\x07]*(?:\x07|\x1b\\)', b'', plain)
wanted = [b'"name":"dynamic_agents"', b'"status":"completed"', b'"runId":', b'"output":12']
missing = [item for item in wanted if item not in plain]
if missing:
    print("Real Pi terminal smoke FAILED; missing:", [x.decode() for x in missing])
    print(plain[-12000:].decode('utf-8', 'replace'))
    sys.exit(1)
print("PASS: real Pi CLI loaded extension; /workflow list and run completed with native task ID")
PY
