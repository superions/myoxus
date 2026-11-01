# syntax=docker/dockerfile:1.7

FROM node:26-trixie-slim AS build
WORKDIR /workspace

COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/ .yarn/
COPY .npmrc .nvmrc ./

COPY tools/ tools/
COPY build/scripts/release/write-release-identity.mjs build/scripts/release/write-release-identity.mjs
COPY virgultum/ virgultum/
COPY assets/ assets/
COPY client/admin/workspaces/ client/admin/workspaces/
COPY client/libs/ client/libs/
COPY build/scripts/frontends/verify-public-static-root.sh build/scripts/frontends/verify-public-static-root.sh
COPY tsconfig.json tsconfig.web.json ./

RUN --mount=type=cache,id=myoxus-admin-yarn-cache,target=/usr/local/share/.cache/yarn,sharing=locked \
    YARN_CACHE_FOLDER=/usr/local/share/.cache/yarn \
    node .yarn/releases/yarn-4.18.0.cjs workspaces focus @myoxus/admin @myoxus-tools/cli
RUN rm -rf client/admin/workspaces/admin/dist client/libs/i18n/dist
RUN node .yarn/releases/yarn-4.18.0.cjs workspace @virgultum/icons build
# Release metadata must not invalidate dependency installation or icon generation.
ARG GITHUB_SHA=localdev
ARG MYOXUS_CLIENT_VERSION
ENV GITHUB_SHA=${GITHUB_SHA}

RUN node build/scripts/release/write-release-identity.mjs \
      --role admin \
      --revision "${GITHUB_SHA}" \
      --expected-version "${MYOXUS_CLIENT_VERSION}" \
      --output /out/release.json

RUN PUBLIC_PATH=/ node tools/cli/bin/runner.js tools/cli/src/myoxus.ts build -p @myoxus/admin

RUN mkdir -p /out/frontends/admin \
  && cp -a client/admin/workspaces/admin/dist/. /out/frontends/admin/
RUN find /out/frontends/admin -type d -name "__tests__" -prune -exec rm -rf {} + \
  && find /out/frontends/admin -type f \( \
       -name "*.map" -o \
       -name "*.spec.js" -o \
       -name "*.d.ts" -o \
       -name "tsconfig.tsbuildinfo" \
     \) -delete
RUN build/scripts/frontends/verify-public-static-root.sh /out/frontends/admin

FROM scratch AS artifact

ARG GITHUB_SHA=localdev
ARG MYOXUS_CLIENT_VERSION
LABEL org.opencontainers.image.title="Myoxus Admin static artifact" \
      org.opencontainers.image.version="${MYOXUS_CLIENT_VERSION}" \
      org.opencontainers.image.revision="${GITHUB_SHA}" \
      org.opencontainers.image.source="https://github.com/superions/myoxus"

COPY --from=build /out/release.json /myoxus-artifact/release.json
COPY --from=build /out/frontends/admin/ /myoxus-artifact/admin/
