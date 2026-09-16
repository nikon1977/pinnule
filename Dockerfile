FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY public ./public
ENV PORT=4000
ENV HTTPS_PORT=4443
EXPOSE 4000
EXPOSE 4443
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q --no-check-certificate --spider "https://localhost:${HTTPS_PORT}/api/auth/status" || exit 1
CMD ["node", "server.js"]
