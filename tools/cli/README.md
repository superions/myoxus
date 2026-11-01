# Myoxus Monorepo CLI

The repository root manifest owns the client product version. Internal client,
tool and test workspaces are private and versionless; CLI package discovery
must not infer product identity from a workspace manifest. The Electron
manifest is the sole packaging mirror of the root version.

## Start

```bash
yarn myoxus -h
```

### Run build command defined in package.json

```bash
yarn myoxus i18n build
# or
yarn build -p i18n
```

### Run dev command defined in package.json

```bash
yarn myoxus web dev
# or
yarn dev -p web
```

### Clean

```bash
yarn myoxus clean --dist --rust
# clean node_modules
yarn myoxus clean --node-modules
```

### Init

> Generate files that make the monorepo work properly, the per project codegen will not be included anymore

```bash
yarn myoxus init
```

## Tricks

### Short your key presses

```bash
# af is also available for running the scripts
yarn af web build
```
