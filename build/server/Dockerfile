# syntax=docker/dockerfile:1.7

FROM gcr.io/distroless/base-debian13:nonroot AS distroless-base
FROM node:26-trixie-slim AS node-toolchain

# Only libgcc_s is missing from base-debian13. Keep Debian package metadata and
# copyright material; do not copy the preparation image's OS/tool dependencies.
FROM debian:trixie-slim AS runtime-files
COPY --from=distroless-base /var/lib/dpkg/status.d /tmp/base-status
COPY --from=distroless-base /etc/passwd /runtime/etc/passwd
COPY --from=distroless-base /etc/group /runtime/etc/group
RUN apt-get update \
  && apt-get install -y --no-install-recommends libgcc-s1 \
  && mkdir -p /runtime/var/lib/dpkg/status.d /runtime/usr/share/doc/myoxus-server \
  && dpkg-query -L libgcc-s1 | grep '/libgcc_s\.so\.1$' \
       | xargs -r cp --parents --target-directory=/runtime \
  && for package in libgcc-s1 gcc-14-base; do \
       dpkg-query -s "$package" > "/runtime/var/lib/dpkg/status.d/$package"; \
       cp -a --parents "/usr/share/doc/$package" /runtime; \
     done \
  && awk 'BEGIN { RS=""; FS="\n" } \
       { name=""; version=""; arch=""; \
         for (i=1;i<=NF;i++) { \
           if ($i ~ /^Package: /) name=substr($i,10); \
           if ($i ~ /^Version: /) version=substr($i,10); \
           if ($i ~ /^Architecture: /) arch=substr($i,15); \
         } \
         if (name != "" && version != "" && arch != "") printf "%s\t%s\t%s\n",name,version,arch; \
       }' /tmp/base-status/* /runtime/var/lib/dpkg/status.d/* \
       | LC_ALL=C sort -u > /runtime/usr/share/doc/myoxus-server/os-packages.tsv \
  && printf 'myoxus:x:1000:999::/home/myoxus:/sbin/nologin\n' >> /runtime/etc/passwd \
  && printf 'myoxus:x:999:\n' >> /runtime/etc/group \
  && mkdir -p /runtime/opt/myoxus/config \
              /writable/data/storage \
              /writable/data/logs \
              /writable/data/git-sync \
              /writable/run \
              /writable/runtime-config \
              /writable/runtime-assets/style \
  && chmod 700 /writable/run /writable/runtime-config

FROM distroless-base AS server-runtime
COPY --from=runtime-files /runtime/ /
# Keep package parents root-owned; explicitly grant only these existing writable
# boundaries to the shipped account, independently of preparation-stage owners.
COPY --from=runtime-files --chown=1000:999 /writable/data /opt/myoxus/data
COPY --from=runtime-files --chown=1000:999 /writable/run /run/myoxus
COPY --from=runtime-files --chown=1000:999 /writable/runtime-config /opt/myoxus/runtime-config
COPY --from=runtime-files --chown=1000:999 /writable/runtime-assets /opt/myoxus/runtime-assets

ARG GITHUB_SHA=localdev
ARG MYOXUS_SERVER_VERSION

LABEL org.opencontainers.image.title="Myoxus Server" \
      org.opencontainers.image.version="${MYOXUS_SERVER_VERSION}" \
      org.opencontainers.image.revision="${GITHUB_SHA}" \
      org.opencontainers.image.source="https://github.com/superions/myoxus"

FROM rust:1-slim-trixie AS builder-base

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends pkg-config libssl-dev ca-certificates build-essential \
  && rm -rf /var/lib/apt/lists/*
COPY --from=node-toolchain /usr/local/bin/node /usr/local/bin/node

# Both tool bootstrap and server compilation inherit the caller's Cargo budget.
ARG CARGO_BUILD_JOBS

# Keep the SBOM generator independent of server sources and release metadata.
FROM builder-base AS sbom-tools
RUN --mount=type=cache,id=myoxus-server-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=myoxus-server-cargo-git,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=myoxus-server-cargo-cyclonedx-target,target=/tmp/cargo-cyclonedx-target,sharing=locked \
    CARGO_TARGET_DIR=/tmp/cargo-cyclonedx-target cargo install --locked cargo-cyclonedx --version 0.5.9

FROM builder-base AS builder
ARG MYOXUS_SOURCE_PROVENANCE_SHA256=""
COPY --from=sbom-tools /usr/local/cargo/bin/cargo-cyclonedx /usr/local/cargo/bin/cargo-cyclonedx

COPY LICENSE ./LICENSE
COPY build/scripts/release/assemble-server-legal.mjs ./build/scripts/release/assemble-server-legal.mjs
COPY build/scripts/release/assemble-server-legal.sh ./build/scripts/release/assemble-server-legal.sh
COPY build/scripts/release/generate-sbom.sh ./build/scripts/release/generate-sbom.sh
COPY build/scripts/release/normalize-server-sbom.mjs ./build/scripts/release/normalize-server-sbom.mjs
COPY build/scripts/release/source-correspondence.mjs ./build/scripts/release/source-correspondence.mjs
COPY server/Cargo.toml server/Cargo.lock ./server/
COPY vendor/cargo ./vendor/cargo
COPY vendor/wordcraft ./vendor/wordcraft
COPY build/dependencies/paste-consumers-source.json build/dependencies/safer-bytes-license.txt ./build/dependencies/
COPY server/crates ./server/crates
# Additive label defaults compile from their sole authored locale sources.
COPY server/templates/html/i18n ./server/templates/html/i18n
COPY virgultum/icons/src/icon-names.json ./virgultum/icons/src/icon-names.json
COPY client/libs/core/public/favicon.ico ./client/libs/core/public/favicon.ico
COPY server/provenance ./server/provenance
COPY server/static/branding/theme-catalog.json ./server/static/branding/theme-catalog.json
COPY server/static/branding/text-marker.css ./server/static/branding/text-marker.css
COPY server/static/icc ./server/static/icc

ARG MYOXUS_SERVER_VERSION

# Validate the version against Cargo before paying for the release build.
# Per-commit provenance belongs after compilation so native template revisions
# can reuse binaries without inheriting a new build-argument environment.
RUN set -eu; \
    declared_version="$(awk 'found && /^[[:space:]]*\[/ { exit } found && /^[[:space:]]*version[[:space:]]*=/ { line=$0; sub(/^[^"]*"/, "", line); sub(/".*$/, "", line); print line; exit } /^[[:space:]]*\[workspace.package\][[:space:]]*$/ { found=1 }' server/Cargo.toml)"; \
    [ -n "${MYOXUS_SERVER_VERSION:-}" ] || { echo "MYOXUS_SERVER_VERSION is required" >&2; exit 1; }; \
    [ "$MYOXUS_SERVER_VERSION" = "$declared_version" ] || { echo "Server build version $MYOXUS_SERVER_VERSION does not match server/Cargo.toml $declared_version" >&2; exit 1; }

RUN --mount=type=cache,id=myoxus-server-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=myoxus-server-cargo-git,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=myoxus-server-target-rust-stable-release,target=/app/server/target,sharing=locked \
    set -eux; \
    if [ -n "${CARGO_BUILD_JOBS:-}" ]; then export CARGO_BUILD_JOBS; fi; \
    cd /app/server; \
    # COPY retains source mtimes across checkouts; a shared target may contain newer, unrelated artifacts. \
    # Refresh workspace inputs before Cargo's mtime checks, retaining compiled external dependencies. \
    find crates /app/vendor -type f -exec touch {} +; \
    cargo build --locked --release --bins -p myoxus-api -p myoxus-cli -p myoxus-pdf-export; \
    mkdir -p /tmp/myoxus-server-build; \
    cp target/release/server /tmp/myoxus-server-build/myoxus-server; \
    cp target/release/myoxus-cli /tmp/myoxus-server-build/myoxus-cli; \
    cp target/release/myoxus-pdf-compiler /tmp/myoxus-server-build/myoxus-pdf-compiler

ARG GITHUB_SHA=localdev
ARG SOURCE_DATE_EPOCH=0
# Explicit public-source metadata; never derive a public URL from GITHUB_SHA.
ARG MYOXUS_SOURCE_ARCHIVE_URL
ARG MYOXUS_SOURCE_ARCHIVE_SHA256

# Native source changes invalidate only packing, after the Rust binaries exist.
COPY server/templates ./server/templates
COPY server/config/default.yaml ./server/config/default.yaml
COPY server/config/local.yaml.example ./server/config/local.yaml.example
COPY server/config/features.user.yaml ./server/config/features.user.yaml
COPY server/config/features.workspace.yaml ./server/config/features.workspace.yaml
COPY docs/ops/deployment/systemd ./docs/ops/deployment/systemd
COPY build/scripts/ci/collect-server-runtime-assets.sh ./build/scripts/ci/collect-server-runtime-assets.sh
RUN bash /app/build/scripts/ci/collect-server-runtime-assets.sh \
      /app/server /app/docs/ops/deployment /tmp/myoxus-server-assets \
      /tmp/myoxus-server-build/myoxus-cli

RUN --mount=type=cache,id=myoxus-server-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=myoxus-server-cargo-git,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=secret,id=myoxus_source_provenance \
    set -eux; \
    case "$GITHUB_SHA" in \
      localdev) ;; \
      *[!0-9a-f]*|'') echo "GITHUB_SHA must be a full commit SHA or localdev" >&2; exit 1 ;; \
      *) [ "${#GITHUB_SHA}" -eq 40 ] || [ "${#GITHUB_SHA}" -eq 64 ] || { echo "GITHUB_SHA must be a full commit SHA or localdev" >&2; exit 1; } ;; \
    esac; \
    legal_revision="$GITHUB_SHA"; \
    if [ "$legal_revision" = localdev ]; then legal_revision=0000000000000000000000000000000000000000; fi; \
    if [ -n "$MYOXUS_SOURCE_PROVENANCE_SHA256" ]; then \
      printf '%s  %s\n' "$MYOXUS_SOURCE_PROVENANCE_SHA256" /run/secrets/myoxus_source_provenance | sha256sum -c -; \
      export MYOXUS_SOURCE_PROVENANCE=/run/secrets/myoxus_source_provenance; \
    fi; \
    SKIP_SBOM_VALIDATION=true bash /app/build/scripts/release/assemble-server-legal.sh \
      /tmp/myoxus-server-legal "$legal_revision" "$MYOXUS_SERVER_VERSION" "$SOURCE_DATE_EPOCH"

FROM server-runtime

WORKDIR /opt/myoxus

COPY --from=builder /tmp/myoxus-server-build/myoxus-server /usr/local/bin/myoxus-server
COPY --from=builder /tmp/myoxus-server-build/myoxus-cli /usr/local/bin/myoxus-cli
COPY --from=builder /tmp/myoxus-server-build/myoxus-pdf-compiler /usr/local/bin/myoxus-pdf-compiler
COPY --from=builder /tmp/myoxus-server-legal /usr/share/doc/myoxus-server
# Package-owned defaults and examples only. Operator-local configuration must
# never enter the image; runtime overrides belong to MYOXUS__* settings,
# secrets or the server-owned configuration store.
COPY server/config/default.yaml ./config/default.yaml
COPY server/config/local.yaml.example ./config/local.yaml.example
COPY server/config/features.user.yaml ./config/features.user.yaml
COPY server/config/features.workspace.yaml ./config/features.workspace.yaml
COPY --from=builder /tmp/myoxus-server-assets/templates ./templates
COPY server/static ./static
# Keep the artifact-owned expectation authoritative over raw static authoring.
COPY --from=builder /tmp/myoxus-server-assets/static/features ./static/features

USER myoxus

ENV RUN_MODE=development
ENV MYOXUS__SERVER__HOST=0.0.0.0
ENV MYOXUS__SERVER__PORT=3001
# Container-local defaults must point at the writable directories prepared
# above. Native packages retain the relative paths from default.yaml.
ENV MYOXUS__STORAGE__ROOT=/opt/myoxus/data/storage
ENV MYOXUS__LOGGING__FILE_PATH=/opt/myoxus/data/logs/myoxus.log
ENV MYOXUS__GIT_SYNC__REPO_BASE_DIR=/opt/myoxus/data/git-sync

EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=20s \
  CMD ["/usr/local/bin/myoxus-cli", "container", "health"]

ENTRYPOINT ["/usr/local/bin/myoxus-cli", "container", "start", "--"]
CMD ["/usr/local/bin/myoxus-server"]
