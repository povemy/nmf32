#!/bin/bash
# Sandbox watchdog: the recycler kills next-server and the chat-hub between
# tool calls, which silently broke real-time chat (hub dead → broadcasts fail
# → messages only appear after refresh). This loop revives both within 5s.
cd /home/z/my-project
while true; do
  pgrep -f "next-server" >/dev/null || {
    setsid nohup bun run dev > /dev/null 2>&1 &
  }
  pgrep -f "bun --hot index.ts" >/dev/null || {
    cd /home/z/my-project/mini-services/chat-service
    setsid nohup bun run dev > /dev/null 2>&1 &
    cd /home/z/my-project
  }
  sleep 5
done
