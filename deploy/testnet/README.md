# OpenStore 050A/057A Docker testnet

This directory packages the existing coordinator and standalone libp2p
storage-node runtimes. It does not add a client daemon or change any storage,
identity, provenance, manifest, or P2P protocol.

## Prerequisites

- Docker Engine with Compose v2
- A working Docker build environment
- A checkout with dependencies available for the image build

Create local secrets without committing them:

```sh
cp deploy/testnet/.env.example deploy/testnet/.env.testnet
chmod 600 deploy/testnet/.env.testnet
```

Replace every placeholder in `.env.testnet`. It is ignored by Git. The file
contains only environment values; keystores are generated into persistent
volumes on first node startup.

## Build and start

```sh
docker compose --env-file deploy/testnet/.env.testnet \
  -f deploy/testnet/docker-compose.yml build
docker compose --env-file deploy/testnet/.env.testnet \
  -f deploy/testnet/docker-compose.yml up -d
```

The topology contains one coordinator and three independent libp2p nodes.
Nodes advertise `/dns4/node-N/tcp/410N`, which is reachable from other
containers on `openstore-net`; `127.0.0.1` is used only for host-published
operator ports.

For the isolated 057A testnet, use the dedicated port range 4290/4201–4203
in the environment file so it cannot disturb the legacy 4190 testnet:

```sh
cp deploy/testnet/.env.example deploy/testnet/.env.057a
sed -i.bak \
  -e 's/OPENSTORE_COORDINATOR_HOST_PORT=4190/OPENSTORE_COORDINATOR_HOST_PORT=4290/' \
  -e 's/OPENSTORE_NODE_1_HOST_PORT=4101/OPENSTORE_NODE_1_HOST_PORT=4201/' \
  -e 's/OPENSTORE_NODE_2_HOST_PORT=4102/OPENSTORE_NODE_2_HOST_PORT=4202/' \
  -e 's/OPENSTORE_NODE_3_HOST_PORT=4103/OPENSTORE_NODE_3_HOST_PORT=4203/' \
  deploy/testnet/.env.057a
rm -f deploy/testnet/.env.057a.bak
# Replace the four local placeholder secrets in .env.057a.
OPENSTORE_TESTNET_ENV_FILE=deploy/testnet/.env.057a deploy/testnet/testnet.sh start
```

The 057A integration test allocates free localhost ports for CI isolation;
it uses the same Compose services and always removes its temporary project and
volumes during cleanup.

## Operations

The small lifecycle helper keeps the secret environment file out of command
arguments and logs. It never deletes volumes except for an explicitly
confirmed reset:

```sh
deploy/testnet/testnet.sh start
deploy/testnet/testnet.sh status
deploy/testnet/testnet.sh logs coordinator
deploy/testnet/testnet.sh stop
deploy/testnet/testnet.sh restart
```

The named volumes preserve coordinator registry state, each node identity,
and each node's piece/provenance directory across stop/start and restart.
Services also use Docker's `unless-stopped` restart policy so an unexpected
container exit does not discard persistent state.

The image performs a minimal root-owned volume initialization/migration, then
executes the coordinator and storage-node processes as the dedicated
unprivileged `openstore` user. Mounted directories are kept private (`0700`)
and files are created restrictively (`0600`); no volume is made
world-writable. The Compose profile drops all capabilities except the
short-lived volume-init capabilities needed by the entrypoint, enables
`no-new-privileges`, limits coordinator/node CPU, memory, and process counts,
and rotates JSON logs at 10 MiB with three retained files. A 1.5 GiB node
memory limit is independent of the node's logical 1 GiB piece quota.

The final image prunes development dependencies after the build. It retains
only runtime packages and compiled output; the entrypoints use environment
variable names for passwords and coordinator tokens. The legacy
`--coordinator-token` CLI option remains supported for compatibility but is
deprecated and is never used by the Docker testnet. Non-local deployments
must provide a secure transport boundary (for example, a TLS reverse proxy);
TLS is intentionally not part of this testnet milestone.

The helper reads `deploy/testnet/.env.testnet` by default. Set
`OPENSTORE_TESTNET_ENV_FILE` to use another local environment file. It does
not print or pass secret values as command-line arguments.

To inspect coordinator health from the host, use the token in your current
shell environment rather than putting it in a committed script:

```sh
curl -fsS \
  -H "Authorization: Bearer ${OPENSTORE_COORDINATOR_TOKEN}" \
  http://127.0.0.1:4190/v1/health
curl -fsS \
  -H "Authorization: Bearer ${OPENSTORE_COORDINATOR_TOKEN}" \
  http://127.0.0.1:4190/v1/nodes
```

`deploy/testnet/testnet.sh status` (or `docker compose ps`) reports Docker
health states. `healthy` means the coordinator readiness contract or the
storage-node local initialization check passed; `starting` and `unhealthy`
indicate that the process is not currently ready. Coordinator readiness does
not require storage nodes to be registered. Nodes become locally ready after
identity, piece storage, provenance storage, and libp2p initialization succeed,
and continue reconnecting if the coordinator is temporarily unavailable.
The unauthenticated `/v1/ready` endpoint exposes only this non-secret
coordinator readiness result for the container healthcheck.

`testnet.sh stop` and `docker compose down` without `-v` preserve named
volumes. `testnet.sh reset --yes` is explicitly destructive and removes all
testnet persistence:

```sh
deploy/testnet/testnet.sh reset --yes
deploy/testnet/testnet.sh start
```

Coordinator registry writes flush the temporary file before atomically
replacing the registry and flush the containing directory where supported.
This protects a completed write from ordinary process or coordinator
container crashes; it does not protect against device/filesystem destruction,
so the registry volume should be backed up for recovery.

The reset command does not restart the testnet implicitly. This prevents an
accidental destructive command from immediately creating new state.

The Docker integration test is opt-in because it builds images, starts
containers, and removes its own temporary project resources:

```sh
OPENSTORE_RUN_DOCKER_TESTNET=1 npx vitest run tests/integration/milestone-050c.test.ts
```

It uses a unique Compose project and temporary credentials/ports, then
removes only that project in its cleanup path.

## Troubleshooting

- If Compose reports an unset variable, check `.env.testnet` and its
  permissions.
- If a node cannot register, inspect coordinator and node logs and verify
  the token values match.
- If a node fails to start after changing its password, preserve the identity
  volume and use the original password; replacing the password does not
  re-encrypt an existing keystore.
- If peers cannot connect, verify that node descriptors advertise
  `dns4/node-N` addresses rather than loopback addresses and that the
  internal ports are distinct.
