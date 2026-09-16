# openstore
Open-source decentralized encrypted storage network.

## Standalone libp2p storage node

The HTTP storage-node runtime remains available through the existing APIs. For
a separate libp2p process, create an encrypted identity keystore and run:

```sh
npm run storage-node -- --storage-dir ./pieces \
  --identity ./openstore-identity.json --password-env OPENSTORE_PASSWORD \
  --listen /ip4/127.0.0.1/tcp/4102 \
  --capacity-bytes 1073741824 --refresh-interval-ms 5000
```

`--listen` may be repeated with libp2p multiaddrs. DHT bootstrap descriptors
can be supplied with `--bootstrap <json-file>`; descriptors are validated and
must contain an identity binding. The process logs only its peer ID and listen
addresses, and shuts down cleanly on SIGINT/SIGTERM. Piece data is opaque,
validated for safe IDs, persisted under `--storage-dir`, and constrained by
the configured capacity when using the runtime API.

For non-CLI configuration, `--config <json-file>` accepts the same runtime
fields: `storageDir`, `identityPath`, `identityPassword`, `listenAddrs`,
`bootstrapPeers`, `capacityBytes`, `maxPieceBytes`, and
`discoveryRefreshIntervalMs`. Prefer `--password-env` for interactive launches
so the password is not present in the process command line.
