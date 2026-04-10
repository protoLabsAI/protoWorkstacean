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
ENV NODE_ENV=production
RUN bun test
RUN mkdir -p data
CMD ["bun", "run", "src/index.ts"]
