# OpenStore Local Development: Registry + Storage Nodes + Web Dashboard

This is the exact setup for running the **Live** web app against **real**
local storage nodes. All three pieces (registry, nodes, dashboard) run
together in one process via the standalone web server entrypoint.

## Prerequisites

```sh
npm install
npm run build
```

## Start everything together

```sh
mkdir -p ./data/manifests ./data/node1 ./data/node2

OPENSTORE_WEB_PORT=4173 \
OPENSTORE_WEB_MANIFEST_DIR=./data/manifests \
OPENSTORE_WEB_KEYSTORE=./data/identity.json \
OPENSTORE_WEB_STORAGE_DIRS=./data/node1,./data/node2 \
OPENSTORE_WEB_STORAGE_PORTS=4101,4102 \
node dist/apps/web/server.js
```

Or via npm (builds first):

```sh
OPENSTORE_WEB_MANIFEST_DIR=./data/manifests \
OPENSTORE_WEB_STORAGE_DIRS=./data/node1,./data/node2 \
npm run web
```

Expected log output (ports/paths only — never keys):

```text
OpenStore storage node at http://127.0.0.1:4101/ (./data/node1)
OpenStore storage node at http://127.0.0.1:4102/ (./data/node2)
OpenStore web dashboard at http://127.0.0.1:4173/
```

## Environment reference

| Variable | Required | Effect |
|---|---|---|
| `OPENSTORE_WEB_PORT` | No (default `4173`) | Dashboard port. |
| `OPENSTORE_WEB_MANIFEST_DIR` | No | Live file catalog. Unset → demo files. |
| `OPENSTORE_WEB_KEYSTORE` | No | Local identity file (created on first Create). Unset → demo identity. |
| `OPENSTORE_WEB_STORAGE_DIRS` | No | Comma-separated storage dirs — **one real storage node per dir**, sharing the web backend's registry with signed registration + heartbeat. Unset → demo nodes (uploads fail honestly). |
| `OPENSTORE_WEB_STORAGE_PORTS` | No | Per-node ports matching `STORAGE_DIRS` (1–65535). Unset → ephemeral ports (actual URLs are logged). Count mismatch fails fast. |
| `OPENSTORE_WEB_STORAGE_CAPACITY_BYTES` | No | Per-node quota in bytes (positive integer). Unset → 1 GiB default. |

## First-run flow in the browser

1. Open `http://127.0.0.1:4173/`. The header badge must read **Live**
   (not "Demo data"). If it reads demo, the env above did not apply —
   restart the server with them set.
2. **Settings → Create identity**: set a device password, back up the
   12-word recovery phrase. Status becomes Configured · Unlocked.
3. **Storage Nodes**: must list `http://127.0.0.1:4101` and
   `http://127.0.0.1:4102` with scores — never `demo-node-*`.
   A node whose heartbeat expires shows **Offline** and is excluded
   from upload/download selection automatically.
4. **Upload**: choose a JPG/PNG/binary → staged → Upload → Complete.
5. **My Files**: the file appears (live catalog).
6. **Download**: reconstructs the exact original bytes (verified by
   piece hash, envelope, GCM auth, and plaintext hash/size checks).

## Stopping

`Ctrl-C` (SIGINT/SIGTERM) closes nodes (graceful registry unregister)
and the dashboard. Data dirs persist across restarts; node identities
are ephemeral per boot, which is fine because pieces are
content-addressed and selection uses current registry endpoints.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Demo data" badge | Storage/manifest env unset | Set the env vars above and restart. |
| Storage Nodes shows `demo-node-*` | No `OPENSTORE_WEB_STORAGE_DIRS` | Set it; the backend only uses demo nodes when no registry exists. |
| Upload fails: "no storage nodes available" | Registry empty or all heartbeats expired | Check node processes/ports; check the Nodes page for Offline pills. |
| Port already in use | Stale process or fixed-port clash | Kill it or drop `OPENSTORE_WEB_STORAGE_PORTS` for ephemeral ports. |
