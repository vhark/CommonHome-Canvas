#!/usr/bin/env bash
# Build the published Canvas tree from this development repository.
#
# The development repo and the published repo are deliberately different
# trees. 3655 of 3712 tracked files here are .planning/ phase evidence - 919
# PNG screenshots, Playwright traces, GSD artifacts. A stranger cloning Canvas
# to run a dashboard should not download four thousand files of planning
# record to get 57 files of program.
#
# It is not only size. The same .planning/ files embed absolute developer
# paths, which PRE-PUBLICATION.md blocks publication on. Excluding the
# directory from a fresh root commit removes both problems at once: a
# .gitignore would hide the files from the working tree but leave them in
# history, where anyone can still read them with `git log -p`.
#
# Usage:  ./scripts/build-public-tree.sh [output-dir]
# Default output: ../canvas-public
#
# The result is a directory, not a push. Review it, then add a remote
# yourself. This script deliberately does not know how to publish.

set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-$(dirname "$SOURCE_DIR")/canvas-public}"

cd "$SOURCE_DIR"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is dirty. Commit or stash first." >&2
  echo "       The published tree is built from committed content only, so" >&2
  echo "       that what ships is what was reviewed." >&2
  exit 1
fi

# Two modes, and the difference matters.
#
# FIRST EXPORT: the output directory does not exist. A fresh tree is written
# and the caller creates a single root commit in it. That root commit is the
# public project's entire prehistory - none of this repository's 44 commits,
# none of its planning evidence, and so none of the identifiers those contain.
#
# EVERY EXPORT AFTER: the output directory is an existing clone of the public
# repository. Files are synced INTO it and its .git is left alone, so the
# public repo accumulates its own honest history and stays bisectable.
#
# The rejected alternative is re-initialising every time and force-pushing.
# That resets public history on every release, breaks every existing clone,
# and teaches contributors that the history is disposable. Doing it once is a
# clean start; doing it repeatedly is a habit of destroying the record.
SYNC_MODE=false
if [[ -d "$OUT_DIR/.git" ]]; then
  SYNC_MODE=true
elif [[ -e "$OUT_DIR" ]]; then
  echo "error: $OUT_DIR exists but is not a git repository." >&2
  echo "       Pass a path that is either absent (first export) or a clone" >&2
  echo "       of the public repository (every export after)." >&2
  exit 1
fi

echo "==> source: $SOURCE_DIR"
echo "==> output: $OUT_DIR"
if $SYNC_MODE; then
  echo "==> mode:   sync into existing repository"
  # Remove previously-published files so a deletion here becomes a deletion
  # there. Without this, a file removed from the source lingers in the public
  # repo forever - which is how a retracted feature or a withdrawn example
  # stays online after it was deliberately taken out.
  while IFS= read -r stale; do
    rm -f "$OUT_DIR/$stale"
  done < <(cd "$OUT_DIR" && git ls-files)
else
  echo "==> mode:   first export (fresh tree)"
fi
mkdir -p "$OUT_DIR"

# Everything tracked EXCEPT the private development record. Driven by
# git ls-files so an untracked scratch file can never leak into a release.
EXCLUDE_PREFIXES=(
  ".planning/"        # phase evidence: private paths, 919 screenshots
  ".hermes/"          # agent working notes, references private tooling
  "PRE-PUBLICATION.md" # the checklist itself is a development artifact
  "touch-check.html"  # one-off device probe, not part of the product
)

published=0
skipped=0
while IFS= read -r file; do
  skip=false
  for prefix in "${EXCLUDE_PREFIXES[@]}"; do
    if [[ "$file" == "$prefix"* ]]; then skip=true; break; fi
  done
  if $skip; then skipped=$((skipped + 1)); continue; fi
  mkdir -p "$OUT_DIR/$(dirname "$file")"
  cp "$file" "$OUT_DIR/$file"
  published=$((published + 1))
done < <(git ls-files)

echo "==> copied $published files, excluded $skipped"

# ---------------------------------------------------------------------------
# Verify before declaring success. A publication script that trusts itself is
# how private data ships.
# ---------------------------------------------------------------------------
echo "==> scanning the published tree"

fail=0
# scan <label> <pattern> [allowed-file...] — a file named as allowed is dropped
# from the hit list ONLY if every one of its matching lines also matches that
# check's reviewed EXEMPT_RE. A real leak landing in an allowlisted file still
# fails, because the exemption is per-line, not per-file.
scan() {
  local label="$1" pattern="$2"; shift 2
  local allowed=("$@")
  local hits kept=""
  # The scanner excludes itself: its own patterns are literal strings like
  # 'ghp_', so scanning them matches every time. A check that always fails
  # gets ignored, and an ignored check protects nothing.
  # --exclude-dir=.git matters in sync mode: the scan would otherwise read
  # the public repo's own objects, remote URL and old commit messages. Those
  # are not the published tree, and the noise would bury a real hit.
  hits="$(grep -rIlE "$pattern" "$OUT_DIR" \
            --exclude-dir=".git" \
            --exclude="build-public-tree.sh" 2>/dev/null || true)"
  while IFS= read -r hit; do
    [[ -z "$hit" ]] && continue
    local rel="${hit#"$OUT_DIR"/}" ok=false
    for a in ${allowed+"${allowed[@]}"}; do
      if [[ "$rel" == "$a" ]]; then
        # Every matching line must be explained by the exemption pattern.
        if [[ -z "$(grep -nIE "$pattern" "$hit" | grep -vIE "$EXEMPT_RE" || true)" ]]; then
          ok=true
        fi
        break
      fi
    done
    $ok || kept+="$hit"$'\n'
  done <<< "$hits"
  kept="${kept%$'\n'}"
  if [[ -n "$kept" ]]; then
    echo "    FAIL: $label"
    echo "$kept" | sed "s|$OUT_DIR/|      |"
    fail=1
  elif [[ -n "$hits" ]]; then
    echo "    ok: no $label (reviewed exemptions only)"
  else
    echo "    ok: no $label"
  fi
}

scan "developer home paths"  '/home/[a-z]'
# 192.0.2.0/24, 198.51.100.0/24 and 203.0.113.0/24 are RFC 5737 documentation
# ranges - reserved precisely so examples can show an address without naming a
# real host. Flagging them would push authors toward inventing a plausible
# address instead, which is worse. 192.168.x is still caught.
# api.test.ts asserts that RFC1918 addresses are REJECTED by
# isLoopbackAddress(). The addresses are the test's subject matter; deleting
# them would delete the check that keeps the admin API loopback-only. The
# exemption is a line shape, so any OTHER RFC1918 address in that same file
# still fails.
EXEMPT_RE='isLoopbackAddress|must not be treated as loopback|const bad|::ffff:'
scan "private LAN addresses" '\b(10\.[0-9]{1,3}|192\.168)\.[0-9]{1,3}\.[0-9]{1,3}\b' \
     "src/server/api.test.ts"
EXEMPT_RE=''
scan "VPN addresses"         '\b100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}\b'
scan "household domains"     '\.wvs\.lol'
scan "token shapes"          'ghp_|xox[baprs]-|eyJ[A-Za-z0-9_-]{10}'
scan "personal email"        '[a-z0-9._%+-]+@(gmail|outlook|yahoo|proton|icloud|hotmail)\.'

# Household member names. Added after a real miss: the earlier scans checked
# paths, addresses, domains and tokens but never NAMES, and a greeting test
# fixture shipped four real first names - including two children - through
# every one of them. A leak scan only finds the categories it was told about.
#
# Names live in an optional file rather than this script, so the list itself
# is not published. Format: one name per line, blank lines and # comments
# ignored. Without the file this check is skipped and says so, because a
# silent skip reads as a pass.
NAMES_FILE="${CANVAS_PRIVATE_NAMES:-$HOME/.config/commonhome/private-names.txt}"
# A household first name can legitimately belong to a public figure quoted in
# the quotations library ("Vince Lombardi", "Serena Williams"). Those lines are
# exempt; any OTHER line in the same file still fails, so the exemption cannot
# hide a real leak. The exemption is a line shape, not a blanket file pass.
NAME_EXEMPT_RE="author: '[A-Z]"
NAME_ALLOWED=("src/quotes/library.ts" "spikes/quotes.ts")
if [[ -f "$NAMES_FILE" ]]; then
  while IFS= read -r name; do
    [[ -z "$name" || "$name" == \#* ]] && continue
    # Word-boundary, case-insensitive. Deliberately reports a generic label so
    # this script's own output never prints the private name either.
    while IFS= read -r hit; do
      [[ -z "$hit" ]] && continue
      rel="${hit#"$OUT_DIR"/}"
      for a in "${NAME_ALLOWED[@]}"; do
        if [[ "$rel" == "$a" ]]; then
          # Every line mentioning the name must be a quotation attribution.
          if [[ -z "$(grep -nIEi "\\b${name}\\b" "$hit" | grep -vIE "$NAME_EXEMPT_RE" || true)" ]]; then
            continue 2
          fi
        fi
      done
      echo "    FAIL: a household member name appears in the published tree"
      echo "      $rel"
      fail=1
    done < <(grep -rIlEi "\\b${name}\\b" "$OUT_DIR" \
               --exclude-dir=".git" --exclude="build-public-tree.sh" 2>/dev/null || true)
  done < "$NAMES_FILE"
  echo "    ok: name check ran against $NAMES_FILE"
else
  echo "    SKIPPED: no name list at $NAMES_FILE - household names are NOT checked"
  echo "             create it (one name per line) to enable this check"
fi

if [[ -e "$OUT_DIR/.planning" ]]; then
  echo "    FAIL: .planning/ present in the published tree"
  fail=1
else
  echo "    ok: no .planning/"
fi

for required in README.md LICENSE Dockerfile docker-compose.yml package.json; do
  if [[ ! -f "$OUT_DIR/$required" ]]; then
    echo "    FAIL: missing $required"
    fail=1
  fi
done
echo "    ok: required files present"

if [[ $fail -ne 0 ]]; then
  echo "==> REFUSING: the published tree did not pass its own scan." >&2
  echo "    Left at $OUT_DIR for inspection. Do not push it." >&2
  exit 1
fi

echo "==> published tree is clean"
echo

# Stops at a directory on purpose. Pushing is the one step that cannot be
# undone, so it stays a human decision made after looking at the diff.
if $SYNC_MODE; then
  changed="$(cd "$OUT_DIR" && git status --porcelain | wc -l | tr -d ' ')"
  if [[ "$changed" -eq 0 ]]; then
    echo "No changes since the last export. Nothing to publish."
  else
    echo "$changed path(s) changed. Review, then commit in the public repo:"
    echo
    echo "  cd $OUT_DIR"
    echo "  git status && git diff"
    echo "  git add -A && git commit"
    echo "  git push"
    echo
    echo "Write the commit message for someone who cannot see the private"
    echo "repository: describe what changed and why, not which internal phase"
    echo "it came from."
  fi
else
  echo "First export. Create the root commit by hand:"
  echo
  echo "  cd $OUT_DIR"
  echo "  git init -b main && git add -A"
  echo "  git commit -m 'CommonHome Canvas'"
  echo "  # review, then add the remote and push"
  echo
  echo "That single commit is the public project's entire prehistory. Every"
  echo "later export syncs into this same directory and commits normally, so"
  echo "the public repository builds a real history of its own."
fi
