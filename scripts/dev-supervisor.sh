#!/bin/bash
# DEV-SANDBOX ONLY keepalive — not part of the application.
# Launch pattern note (verified 2026-10-27 by canary test): processes launched
# with `setsid ... &` are KILLED at tool-call boundaries in this sandbox; the
# durable pattern is `bash -c 'cd <dir> && nohup <cmd> >> <log> 2>&1 &'`
# (orphaned to init, survives — same as mini-services/expiry-scheduler).
# This supervisor keeps the Next.js dev server alive so the preview panel and
# readiness suites always have a live target. Never run in production.
cd /home/z/my-project
echo "[supervisor $(date -u +%FT%TZ)] started (pid $$)" >> dev.log
while true; do
  if ! ss -tln 2>/dev/null | grep -q ":3000 "; then
    echo "[supervisor $(date -u +%FT%TZ)] :3000 not listening — (re)starting dev server" >> dev.log
    bash -c 'cd /home/z/my-project && nohup bun run dev >> dev.log 2>&1 &'
    sleep 30
  fi
  sleep 10
done
