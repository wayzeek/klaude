#!/bin/bash
# SessionStart hook: tell Claude whether the Strudel REPL server is up,
# whether a browser tab is connected, and whether audio is unlocked -
# so it never has to check (or guess) before pushing code.

STATUS=$(curl -s -m 2 http://localhost:3000/api/status 2>/dev/null)

if [ -z "$STATUS" ]; then
  CONTEXT="Strudel REPL server: NOT RUNNING at http://localhost:3000. Start it with pnpm dev and wait for it to be ready before pushing code."
else
  case "$STATUS" in
    *'"browserConnected":true'*) BROWSER=yes ;;
    *) BROWSER=no ;;
  esac
  case "$STATUS" in
    *'"audioReady":true'*) AUDIO=yes ;;
    *) AUDIO=no ;;
  esac
  case "$STATUS" in
    *'"actualPlaying":true'*) PLAYING="currently playing" ;;
    *) PLAYING="idle" ;;
  esac

  if [ "$BROWSER" = "no" ]; then
    CONTEXT="Strudel REPL server: running at http://localhost:3000 but NO BROWSER TAB is connected - nothing can be heard. Ask the user to open http://localhost:3000 before playing music."
  elif [ "$AUDIO" = "no" ]; then
    CONTEXT="Strudel REPL server: running, browser tab connected, but audio is still locked (browser autoplay policy). It unlocks on the first click in the tab - an overlay in the tab asks for it. Pushing code is fine; sound starts after that click."
  else
    CONTEXT="Strudel REPL server: running at http://localhost:3000, browser connected, audio ready ($PLAYING). No need to check again before pushing code. After each push, confirm the eval result via /api/status lastEval."
  fi
fi

printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$CONTEXT"
