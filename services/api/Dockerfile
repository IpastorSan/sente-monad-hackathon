# services/api — the image the box runs.
#
# BUILD CONTEXT IS THE REPO ROOT, not this directory:
#
#     docker build -f services/api/Dockerfile -t sente-api:<tag> .
#
# `infra/deploy.sh` does that for you. The context has to be the root because
# `@sente/api` depends on two workspace packages (`@sente/mandate`,
# `@sente/venues`) that pnpm resolves through the root lockfile, and because
# `@sente/venues`' runtime entry is its own `dist/` (CLAUDE.md gotcha 10) — so
# the packages must be built here, in dependency order, before `nest build`.
#
# ## Nothing secret is in this image, and that is enforced by shape
#
# There is no `ARG` and no `COPY .env`. A build arg lands in the image history
# and a copied file lands in a layer; both are readable by anyone who can pull
# the image. Every secret arrives at RUN time from `/opt/sente/api.env` on the
# box, which `infra/push-secrets.sh` delivers out of band (0600, root-owned)
# and `infra/docker-compose.yml` reads with `env_file`. See docs/deploy.md.
#
# ## Why node:26.10.0-slim
#
# The exact version mise pins (`mise.toml`), so the box runs the interpreter
# this repo is tested against rather than "whatever node:26 resolves to today".
# Debian slim rather than alpine: the tree pulls native bindings through
# viem/permissionless' transitive deps, and musl is one variable this deploy
# does not need.

# ---------------------------------------------------------------------------
# build — full workspace install, then the topological build
# ---------------------------------------------------------------------------
FROM node:26.10.0-slim AS build

# Pinned to the patch exactly as package.json's packageManager does. A floating
# pnpm major resolves peers differently and that is how a lockfile that installs
# here stops installing in CI.
#
# `npm i -g`, not corepack: corepack is GONE from the node 26 images (removed
# from Node itself after 24), so `corepack enable` is `not found` — verified by
# hitting it, 2026-09-24. npm ships in the image and is the boring way in.
RUN npm install --global --no-fund --no-audit pnpm@12.3.4

WORKDIR /app

# The lockfile layer first, so a source-only change does not re-resolve 1000
# packages. `--frozen-lockfile` is the point of copying the lockfile at all:
# the image must install exactly what the repo pins.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/mandate/package.json packages/mandate/
COPY packages/venues/package.json packages/venues/
COPY services/api/package.json services/api/
RUN pnpm install --frozen-lockfile --filter @sente/api... --filter .

COPY tsconfig.base.json ./
COPY packages/ packages/
COPY services/api/ services/api/

# `-r` walks the workspace in dependency order: mandate and venues emit their
# `dist/`, then `nest build` emits services/api/dist. Without the packages'
# dist/ the API's CommonJS output has nothing to require at runtime.
RUN pnpm -r --filter @sente/api... run build

# Drop everything dev from the store and re-link, so the tree copied into the
# runtime stage is production-only.
RUN pnpm install --frozen-lockfile --prod --filter @sente/api... --filter .

# ---------------------------------------------------------------------------
# runtime — no pnpm, no compiler, no sources it does not need
# ---------------------------------------------------------------------------
FROM node:26.10.0-slim AS runtime

# NODE_ENV=production is what arms the API's boot refusals (auth placeholder,
# GAS_DRIP_DRY_RUN, AGENT_PRECHECK=off, AGENT_MANDATE_OWNER=server,
# OPENROUTER_API_KEY without a management key). It is set here AND again in
# docker-compose.yml, where `environment` outranks `env_file` — so an env file
# that tries to turn production off cannot.
ENV NODE_ENV=production
# Default only. docker-compose.yml pins it to a path on a host bind mount.
ENV STATE_DIR=/var/lib/sente/state
ENV PORT=3000

WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/services/api/node_modules ./services/api/node_modules
COPY --from=build --chown=node:node /app/services/api/package.json ./services/api/package.json
COPY --from=build --chown=node:node /app/services/api/dist ./services/api/dist

# `node`, uid 1000, ships in the image. The state directory is a bind mount
# owned by 1000 on the host (deploy.sh creates it that way) — json-file.ts
# writes 0700/0600 and a root-owned mount would make every write EACCES at the
# first wallet registration, which is precisely the moment you cannot afford it.
USER node

EXPOSE 3000

# Only reached through Caddy on the same compose network, so bind is internal.
# `main.js` listens on 0.0.0.0 itself (services/api/src/main.ts).
WORKDIR /app/services/api
CMD ["node", "dist/main.js"]
