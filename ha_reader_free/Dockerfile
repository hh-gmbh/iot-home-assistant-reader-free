# Wird vom Supervisor direkt auf dem Home-Assistant-Host gebaut (kein image: in config.yaml)
FROM node:22-alpine AS build
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci
COPY app/tsconfig.json ./
COPY app/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY app/package.json ./
COPY app/public ./public
COPY app/scripts ./scripts
CMD ["node", "dist/index.js"]
