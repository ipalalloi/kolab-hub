FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
# Hanya dependensi produksi (driver PostgreSQL `pg`).
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN addgroup -S kolab && adduser -S kolab -G kolab && mkdir -p /app/data && chown -R kolab:kolab /app/data
USER kolab
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--no-warnings=ExperimentalWarning", "src/server.js"]
