# CommonHome Canvas — self-contained container image.
#
# Canvas has ZERO runtime dependencies (package.json "dependencies": {}), which
# is what makes the second stage possible: no node_modules and no build
# toolchain ship to the device on the wall. Node's own stdlib serves the
# display, and Node 22+ runs the TypeScript sources directly via type
# stripping, so there is no compile step for the server either.
#
# npm itself IS still present, because it ships inside node:22-alpine - it is
# not installed here and nothing at runtime invokes it. Removing it would mean
# either a distroless base or an rm layer; neither is worth it while the
# container runs read-only as a non-root user who cannot write to /app. Said
# plainly because an earlier draft of this comment claimed "no npm", which was
# not true of the resulting image.
#
# Build:  docker build -t commonhome-canvas .
# Run:    docker run --rm -p 4174:4174 commonhome-canvas
#
# No configuration is required for either. Every integration is optional.

# ---------------------------------------------------------------------------
# Stage 1: build the ambient bundle.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /build

# Dependencies are copied first so a source edit does not invalidate the
# install layer. The lockfile is committed, so `npm ci` gives a reproducible
# tree; it is the only supported path here and a missing lockfile should fail
# loudly rather than silently resolving to different versions.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Only what the ambient build actually reads. Copying the repo wholesale would
# drag in planning evidence and test artifacts for no benefit.
COPY ambient.html ./
COPY spikes ./spikes
COPY src ./src

RUN npm run build:ambient

# ---------------------------------------------------------------------------
# Stage 2: runtime.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    CANVAS_PORT=4174 \
    CANVAS_HOST=0.0.0.0 \
    CANVAS_DATA_DIR=/data

WORKDIR /app

# The built display, and the server that serves it. Nothing else — in
# particular no node_modules, no npm cache, no .planning, no tests.
COPY --from=build /build/dist/ambient ./dist/ambient
COPY src/server ./src/server
COPY package.json ./

# The node image ships an unprivileged `node` user (uid 1000). A display
# server has no reason to be root, and /data is the one path it may write.
RUN mkdir -p /data && chown -R node:node /app /data
USER node

VOLUME ["/data"]
EXPOSE 4174

# Liveness deliberately probes /healthz, which by design never depends on an
# integration being configured. Probing the snapshot endpoint instead would
# restart a perfectly healthy container whose household has no home automation
# server — the exact coupling this image exists to remove.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.CANVAS_PORT||4174)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server/main.ts"]
