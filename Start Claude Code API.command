#!/bin/bash
# Double-click to start the Claude Code API server (in the background) and open
# its dashboard. Stop the server anytime from the dashboard's Stop button.

cd "$(dirname "$0")" || exit 1

if curl -s http://localhost:8787/health >/dev/null 2>&1; then
  # Already running — just open the dashboard.
  open "http://localhost:8787/"
else
  # Start the server detached so it keeps running after this window closes.
  nohup node server.js >/dev/null 2>&1 &
  disown
  ( sleep 1.5; open "http://localhost:8787/" ) &
fi

# Close this Terminal window so nothing lingers.
( sleep 0.4; osascript -e 'tell application "Terminal" to close (every window whose name contains "Start Claude Code API")' >/dev/null 2>&1 ) &
exit 0
