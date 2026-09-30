FROM node:24-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=768 --enable-source-maps"
RUN apt-get update && apt-get install -y tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
