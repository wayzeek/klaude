#!/bin/bash
# SessionStart hook: tell Claude whether the Strudel REPL server is up
# so it never has to check (or guess) before pushing code.

STATUS=$(curl -s -m 2 http://localhost:3000/api/status 2>/dev/null)

if [ -z "$STATUS" ]; then
  CONTEXT="Strudel REPL server: NOT RUNNING at http://localhost:3000. Start it with pnpm dev and wait for it to be ready before pushing code."
else
  case "$STATUS" in
    *'"isPlaying":true'*) PLAYING="currently playing" ;;
    *) PLAYING="idle" ;;
  esac
  CONTEXT="Strudel REPL server: running at http://localhost:3000 ($PLAYING). No need to check again before pushing code."
fi

printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$CONTEXT"
