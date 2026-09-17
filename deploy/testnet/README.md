# OpenStore 050A Docker testnet

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

`testnet.sh stop` and `docker compose down` without `-v` preserve named
volumes. `testnet.sh reset --yes` is explicitly destructive and removes all
testnet persistence:

```sh
deploy/testnet/testnet.sh reset --yes
deploy/testnet/testnet.sh start
```

The reset command does not restart the testnet implicitly. This prevents an
accidental destructive command from immediately creating new state.

050C will add the complete three-node client and failure smoke test.

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
