#!/usr/bin/env bash
# Unattended daily run for the systemd timer. Ends by auto-applying (see below).
# Mon/Thu add Indeed (--scrape); Sunday adds the bulk boards (--bulk).
set -uo pipefail
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
cd "$HOME/jobpipe"

flags=()
case "$(date +%u)" in
  1|4) flags+=(--scrape) ;;
  7)   flags+=(--bulk) ;;
esac

echo "== $(date -Is) poll ${flags[*]:-}"
./bin/jobpipe.ts poll "${flags[@]}" || echo "poll failed ($?)"
echo "== screen";  ./bin/jobpipe.ts screen || echo "screen failed ($?)"
# A judge run dying partway is usually the usage limit; tomorrow's run resumes.
echo "== judge";   ./bin/jobpipe.ts judge --limit 40 || echo "judge stopped ($?)"
echo "== report";  ./bin/jobpipe.ts report
echo "== queue";   ./bin/jobpipe.ts queue
# Tory authorized unattended submission on 2026-10-01: up to 10 a day, within
# the lane in src/autoapply.ts. Delete these two lines to go back to manual.
echo "== autoapply"; ./bin/jobpipe.ts autoapply --limit 10 || echo "autoapply stopped ($?)"
./bin/jobpipe.ts export-csv
