# ---- deps stage: resolve pinnule's own dependencies ----
# Kept separate so the npm CLI itself (and everything npm bundles
# internally to do its own job -- tar, pacote, sigstore, minimatch, etc.)
# never has to exist in the final image.
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ---- final stage: runtime only ----
FROM node:20-alpine
RUN apk update && apk upgrade && apk add --no-cache openssl \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server.js ./
COPY public ./public
ENV PORT=4000
ENV HTTPS_PORT=4443
ENV NODE_ENV=production
EXPOSE 4000
EXPOSE 4443
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q --no-check-certificate --spider "https://localhost:${HTTPS_PORT}/api/auth/status" || exit 1
CMD ["node", "server.js"]
