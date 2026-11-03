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
COPY client/web/workspaces/ client/web/workspaces/
COPY client/libs/ client/libs/
COPY server/templates/documents/ server/templates/documents/
COPY server/templates/features/base/manifest.yaml server/templates/features/base/manifest.yaml
COPY build/scripts/templates/generate-document-bundles.mjs build/scripts/templates/generate-document-bundles.mjs
COPY build/scripts/templates/native-payload.mjs build/scripts/templates/native-payload.mjs
COPY build/scripts/frontends/verify-public-static-root.sh build/scripts/frontends/verify-public-static-root.sh
COPY tsconfig.json tsconfig.web.json ./

RUN --mount=type=cache,id=myoxus-web-yarn-cache,target=/usr/local/share/.cache/yarn,sharing=locked \
    YARN_CACHE_FOLDER=/usr/local/share/.cache/yarn \
    node .yarn/releases/yarn-4.18.0.cjs workspaces focus @myoxus/web @myoxus-tools/cli
RUN rm -rf client/web/workspaces/web/dist client/libs/i18n/dist
RUN node .yarn/releases/yarn-4.18.0.cjs workspace @virgultum/icons build
COPY server/config/default.yaml server/config/default.yaml
# Release metadata must not invalidate dependency installation or icon generation.
ARG GITHUB_SHA=localdev
ARG MYOXUS_CLIENT_VERSION
ENV GITHUB_SHA=${GITHUB_SHA}

RUN node build/scripts/release/write-release-identity.mjs \
      --role web \
      --revision "${GITHUB_SHA}" \
      --expected-version "${MYOXUS_CLIENT_VERSION}" \
      --output /out/release.json

RUN PUBLIC_PATH=/ node tools/cli/bin/runner.js tools/cli/src/myoxus.ts build -p @myoxus/web

RUN mkdir -p /out/frontends/web \
  && cp -a client/web/workspaces/web/dist/. /out/frontends/web/
RUN mkdir -p /out/frontends/web/imgs \
  && for channel in stable beta internal canary; do \
       cp /out/frontends/web/favicon.ico /out/frontends/web/imgs/app-icon-$channel.ico; \
     done
RUN find /out/frontends/web -type d -name "__tests__" -prune -exec rm -rf {} + \
  && find /out/frontends/web -type f \( \
       -name "*.map" -o \
       -name "*.spec.js" -o \
       -name "*.d.ts" -o \
       -name "tsconfig.tsbuildinfo" \
     \) -delete
RUN build/scripts/frontends/verify-public-static-root.sh /out/frontends/web

FROM scratch AS artifact

ARG GITHUB_SHA=localdev
ARG MYOXUS_CLIENT_VERSION
LABEL org.opencontainers.image.title="Myoxus Web static artifact" \
      org.opencontainers.image.version="${MYOXUS_CLIENT_VERSION}" \
      org.opencontainers.image.revision="${GITHUB_SHA}" \
      org.opencontainers.image.source="https://github.com/superions/myoxus"

COPY --from=build /out/release.json /myoxus-artifact/release.json
COPY --from=build /out/frontends/web/ /myoxus-artifact/web/
COPY server/static/fonts/ /myoxus-artifact/api/fonts/
COPY client/branding/theme-fallback.css /myoxus-artifact/style/theme-fallback.css
COPY client/branding/brand-identity-fallback.json /myoxus-artifact/style/brand-identity-fallback.json
COPY client/branding/artwork/ /myoxus-artifact/style/artwork/
COPY assets/branding/myoxus_text.svg /myoxus-artifact/canonical-style/logo.svg
COPY client/libs/icons/src/assets/platform/browser-favicon.svg /myoxus-artifact/canonical-style/product-mark.svg
COPY client/frontends/nginx/myoxus.conf /myoxus-artifact/deployment/nginx/myoxus.conf
COPY build/scripts/frontends/render-basepath-nginx.sh /myoxus-artifact/deployment/nginx/render-basepath-nginx.sh
COPY build/scripts/frontends/materialize-static-artifacts.sh /myoxus-artifact/deployment/materialize-static-artifacts.sh
COPY build/scripts/frontends/verify-public-static-root.sh /myoxus-artifact/deployment/verify-public-static-root.sh
COPY build/scripts/server/prepare-swarm-state.sh /myoxus-artifact/deployment/prepare-swarm-state.sh
COPY build/scripts/server/prepare-templates.sh /myoxus-artifact/deployment/prepare-templates.sh
COPY build/server/docker-stack.registry.yml /myoxus-artifact/deployment/docker-stack.registry.yml
COPY build/server/docker-compose.selfhost.yml /myoxus-artifact/deployment/docker-compose.selfhost.yml
COPY build/server/docker-compose.registry.yml /myoxus-artifact/deployment/docker-compose.registry.yml
