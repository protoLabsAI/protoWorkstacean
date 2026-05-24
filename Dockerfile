# use the official Bun image
# see all versions at https://hub.docker.com/r/oven/bun/tags
FROM oven/bun:1 AS base
WORKDIR /usr/src/app
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl wget jq sqlite3 netcat-openbsd telnet git unzip zip \
    && rm -rf /var/lib/apt/lists/*
# Install Docker CLI + Compose + Buildx from official static binaries
ENV DOCKER_VERSION=27.5.1
ENV COMPOSE_VERSION=2.32.4
ENV BUILDX_VERSION=0.20.1
RUN curl -fsSL "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_VERSION}.tgz" | \
    tar xz --strip-components=1 -C /usr/local/bin docker/docker && \
    mkdir -p /usr/local/lib/docker/cli-plugins && \
    curl -fsSL "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-x86_64" -o /usr/local/lib/docker/cli-plugins/docker-compose && \
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose && \
    curl -fsSL "https://github.com/docker/buildx/releases/download/v${BUILDX_VERSION}/buildx-v${BUILDX_VERSION}.linux-amd64" -o /usr/local/lib/docker/cli-plugins/docker-buildx && \
    chmod +x /usr/local/lib/docker/cli-plugins/docker-buildx

# clawpatch (protoLabs fork) — installed in a dedicated Node stage so it
# stays isolated from the bun-based release image. The fork ships a `gateway`
# provider that POSTs the assembled prompt to our LiteLLM endpoint
# (http://gateway:4000/v1 inside the docker-ai network); Quinn uses it via
# the `clawpatch_review` tool during pr_review for structural code findings.
# pnpm is pinned to the version protoPatch uses so the global install runs
# its prepack build with the same toolchain.
FROM node:22-bookworm-slim AS clawpatch-build
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate
# Pin every pnpm path into /opt/clawpatch so the entire install (bin, global
# manifests, AND the content-addressable store) is self-contained and can be
# COPY'd to the release stage in one shot. Without store-dir pointing here,
# packages land in /root/.local/share/pnpm/store and the release-stage
# binaries break with MODULE_NOT_FOUND.
RUN pnpm config set global-bin-dir /opt/clawpatch/bin && \
    pnpm config set global-dir /opt/clawpatch/pnpm && \
    pnpm config set store-dir /opt/clawpatch/store
# pnpm refuses to install globally unless its bin dir is in PATH at the
# time of install. Add it ahead of the global add.
ENV PATH="/opt/clawpatch/bin:${PATH}"
# pnpm 11 refuses to run prepack on git deps unless the package is
# allowlisted. protoPatch needs to compile TS via its prepack, so allow it.
RUN pnpm add -g --allow-build=@protolabsai/protopatch github:protoLabsAI/protoPatch && \
    ls /opt/clawpatch/bin
# protoCLI (@protolabsai/proto) speaks the Agent Client Protocol via
# `proto --acp`, and acpx is the generic ACP-agent driver. Together they give
# us a path to drive clawpatch's `acpx` provider with protoCLI as the
# underlying agent — phase 2 of the Quinn-clawpatch integration, when we
# want interactive tool-use review on top of the gateway provider's
# stateless LLM path. Installed in the same stage so they share the
# self-contained /opt/clawpatch install root.
RUN pnpm add -g @protolabsai/proto@latest acpx@latest && \
    proto --version && \
    acpx --version

# build the dashboard Astro static site
FROM oven/bun:1 AS dashboard-build
WORKDIR /dashboard
COPY dashboard/package.json ./
RUN bun install
COPY dashboard/ .
RUN bun run build

# install dependencies into temp directory
# this will cache them and speed up future builds
FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json bun.lock /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile

# install with --production (exclude devDependencies)
RUN mkdir -p /temp/prod
COPY package.json bun.lock /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

# dev: full source + dev deps, no tests (source + node_modules mounted from host)
FROM base AS dev
RUN mkdir -p data
CMD ["bun", "run", "--watch", "src/index.ts"]

# release: production deps + source, tests as build gate
FROM base AS release
COPY --from=install /temp/prod/node_modules node_modules
COPY . .
COPY --from=dashboard-build /dashboard/dist dashboard/dist
# clawpatch + a minimal Node runtime to run it (the JS CLI is shebanged
# `#!/usr/bin/env node`). PATH puts /opt/clawpatch/bin first so the
# `clawpatch` / `protopatch` binaries resolve.
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=clawpatch-build /opt/clawpatch /opt/clawpatch
ENV PATH="/opt/clawpatch/bin:${PATH}"
ENV NODE_ENV=production
RUN bun test
RUN clawpatch --version
RUN mkdir -p data
CMD ["bun", "run", "src/index.ts"]
