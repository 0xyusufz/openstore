FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY deploy/testnet/entrypoint-coordinator.sh deploy/testnet/entrypoint-storage-node.sh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/entrypoint-coordinator.sh /usr/local/bin/entrypoint-storage-node.sh \
  && mkdir -p /var/lib/openstore

ENTRYPOINT ["/usr/local/bin/entrypoint-storage-node.sh"]
