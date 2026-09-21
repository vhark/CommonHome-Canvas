#!/bin/sh
# CommonHome Canvas installer.
#
#   curl -fsSL https://raw.githubusercontent.com/vhark/CommonHome-Canvas/main/scripts/install.sh | sh
#
# If you are about to run that: read this file first. Piping a script from the
# internet into a shell means trusting whoever controls that URL, today and
# every day after. That is a real trust decision and this script will not
# pretend otherwise. The honest alternative, which does the same thing:
#
#   git clone https://github.com/vhark/CommonHome-Canvas && cd CommonHome-Canvas && docker compose up -d
#
# What this script does, in full:
#   1. Checks that Docker is present and running.
#   2. Creates a directory (default ./commonhome-canvas).
#   3. Writes a docker-compose.yml and a .env there.
#   4. Starts the container and waits for its health check.
# It does not install packages, modify system configuration, add users, write
# outside the target directory, contact any host other than the container
# registry, or send any telemetry.
#
# POSIX sh, not bash: /bin/sh on Alpine and Debian is not bash, and an
# installer that assumes bashisms fails on exactly the minimal systems people
# run home servers on.
#
# The URL above is the raw file in the repository rather than a short vanity
# domain. That is deliberate for now: a one-liner that 404s is the worst first
# impression an install guide can make, and this address works the moment the
# repository is public, with no DNS, no hosting and nothing to keep alive.
# A vanity URL can be added later as a redirect to this same file - it is
# nicer to type and nicer to say out loud, but it is a second thing that can
# break, and it must never become the only published address.

set -eu

# --- configuration knobs, all overridable -----------------------------------
CANVAS_DIR="${CANVAS_DIR:-./commonhome-canvas}"
CANVAS_IMAGE="${CANVAS_IMAGE:-ghcr.io/vhark/commonhome-canvas:latest}"
CANVAS_HOST_PORT="${CANVAS_HOST_PORT:-4174}"

# --- output helpers ---------------------------------------------------------
# Colour only when stdout is a terminal. Piped into a log, escape codes are
# noise; this script is frequently run non-interactively.
if [ -t 1 ]; then
  BOLD="$(printf '\033[1m')"; DIM="$(printf '\033[2m')"
  RED="$(printf '\033[31m')"; GREEN="$(printf '\033[32m')"
  RESET="$(printf '\033[0m')"
else
  BOLD=""; DIM=""; RED=""; GREEN=""; RESET=""
fi

say()  { printf '%s\n' "$*"; }
step() { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
warn() { printf '%s warning:%s %s\n' "$RED" "$RESET" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

# --- preflight --------------------------------------------------------------
step "Checking prerequisites"

command -v docker >/dev/null 2>&1 || die "Docker is not installed.
  Canvas ships as a container and needs Docker to run.
  Install it from https://docs.docker.com/get-docker/ and run this again."

docker info >/dev/null 2>&1 || die "Docker is installed but not responding.
  Start the Docker daemon (or add your user to the 'docker' group) and retry."

# Compose v2 is a docker subcommand; the old v1 was a separate binary. Support
# both rather than telling someone with a working setup that it is wrong.
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  die "Docker Compose is not available.
  Install the Compose plugin: https://docs.docker.com/compose/install/"
fi
say "    docker: $(docker --version 2>/dev/null | head -1)"
say "    compose: $COMPOSE"

# A port collision is the single most likely failure here, and the default
# error from Docker is unhelpful. Check before writing anything.
if command -v ss >/dev/null 2>&1; then
  if ss -ltn 2>/dev/null | grep -q ":${CANVAS_HOST_PORT} "; then
    die "Port ${CANVAS_HOST_PORT} is already in use.
  Pick another:  CANVAS_HOST_PORT=8080 sh install.sh"
  fi
fi

# --- target directory -------------------------------------------------------
step "Preparing ${CANVAS_DIR}"

if [ -e "${CANVAS_DIR}/docker-compose.yml" ]; then
  die "${CANVAS_DIR}/docker-compose.yml already exists.
  Refusing to overwrite an existing install. Remove it, or set a different
  location:  CANVAS_DIR=./somewhere-else sh install.sh"
fi

mkdir -p "$CANVAS_DIR"
cd "$CANVAS_DIR"

# --- compose file -----------------------------------------------------------
# Written rather than downloaded: one fewer network dependency, and what runs
# is visible in the directory afterwards instead of living only in a pipe.
step "Writing docker-compose.yml"

cat > docker-compose.yml <<COMPOSE_EOF
# CommonHome Canvas - written by install.sh, yours to edit.
services:
  canvas:
    image: ${CANVAS_IMAGE}
    container_name: commonhome-canvas
    restart: unless-stopped
    ports:
      - "\${CANVAS_HOST_PORT:-${CANVAS_HOST_PORT}}:4174"
    env_file:
      - path: .env
        required: false
    environment:
      CANVAS_PORT: "4174"
      CANVAS_DATA_DIR: "/data"
    volumes:
      - canvas-data:/data
    # Canvas writes only to /data, so the rest of the filesystem is read-only.
    read_only: true
    tmpfs:
      - /tmp
    security_opt:
      - no-new-privileges:true
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - fetch('http://127.0.0.1:4174/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 5s

volumes:
  canvas-data:
COMPOSE_EOF

# --- env file ---------------------------------------------------------------
step "Writing .env"

cat > .env <<'ENV_EOF'
# CommonHome Canvas configuration. Every setting is optional: Canvas runs
# with this file completely empty.

# Host port. Change if 4174 is taken.
#CANVAS_HOST_PORT=4174

# Public address, if you put Canvas behind a reverse proxy. Canvas needs this
# to generate correct absolute links; it cannot reliably infer it from
# request headers.
#CANVAS_BASE_URL=https://canvas.example.org

# --- Home Assistant (optional) ---
# Both must be set together. A long-lived access token from your profile.
#HOMEASSISTANT_URL=http://homeassistant.local:8123
#HOMEASSISTANT_TOKEN=

# Entity ids are specific to your setup; unset means Canvas omits that element.
#CANVAS_WEATHER_ENTITY=weather.your_entity
#CANVAS_CALENDAR_ENTITY=calendar.your_entity
#CANVAS_PERSON_ENTITIES=person.one,person.two

# --- Photo backgrounds (optional) ---
# Without a key Canvas still runs; it just has no photo source.
#UNSPLASH_ACCESS_KEY=

# --- Display ---
#CANVAS_LOCALE=en-US
#CANVAS_TIMEZONE=

# Local usage counts for your own admin view. Nothing leaves this machine.
#CANVAS_ANALYTICS=on
ENV_EOF

# --- start ------------------------------------------------------------------
step "Starting Canvas"
$COMPOSE up -d

# --- wait for health --------------------------------------------------------
# Poll the health endpoint rather than sleeping a guessed interval: a slow
# machine pulling an image for the first time needs longer than a fast one,
# and "it didn't work" with no detail is the worst possible install outcome.
step "Waiting for Canvas to become healthy"

healthy=false
i=0
while [ "$i" -lt 60 ]; do
  if curl -fsS "http://127.0.0.1:${CANVAS_HOST_PORT}/healthz" >/dev/null 2>&1; then
    healthy=true
    break
  fi
  i=$((i + 1))
  sleep 1
done

say ""
if [ "$healthy" = true ]; then
  printf '%s  Canvas is running.%s\n' "$GREEN" "$RESET"
  say ""
  say "    ${BOLD}http://localhost:${CANVAS_HOST_PORT}/${RESET}"
  say ""
  say "  Installed in:  $(pwd)"
  say "  Configure:     edit .env, then ${COMPOSE} up -d"
  say "  Logs:          ${COMPOSE} logs -f"
  say "  Stop:          ${COMPOSE} down"
  say ""
  say "${DIM}  Canvas works with nothing configured. Add a Home Assistant token"
  say "  or a photo key in .env only if you want those sources.${RESET}"
else
  warn "Canvas did not report healthy within 60 seconds."
  say ""
  say "  It may still be starting, or something may be wrong. Check with:"
  say "    ${COMPOSE} logs"
  say "    ${COMPOSE} ps"
  say ""
  say "  Installed in: $(pwd)"
  exit 1
fi
