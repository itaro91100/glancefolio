#!/bin/bash
# Glancefolio bot keepalive check — exit 0 when the worker is alive,
# exit 1 when it is dead. Used by the 15-minute keepalive cron, whose
# body restarts the worker as a tracked background session when this
# check fails (never nohup: nohup-started processes die within minutes
# on this VM — proven by the Dialectica serve).
#
# Token: put TELEGRAM_BOT_TOKEN=... in bot/.env (mode 600, gitignored);
# the cron start command sources it. Without a token the bot still polls +
# publishes; Telegram stays disabled until a token is present.
set -u
BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if pgrep -f "node src/index\.mjs" >/dev/null 2>&1; then
  echo "glancefolio bot alive: $(pgrep -f 'node src/index\.mjs' | tr '\n' ' ')"
  exit 0
fi
echo "glancefolio bot NOT running (dir: $BOT_DIR)"
exit 1
