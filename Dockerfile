FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --include=dev --no-audit --no-fund && npm cache clean --force

COPY . .
RUN mkdir -p /app/public
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24-alpine AS runner

LABEL org.opencontainers.image.title="NAS-Sync" \
      org.opencontainers.image.description="Open-Source Agentless Multi-Panel VPS Backup & Cross-Panel Migration Platform for Synology NAS" \
      org.opencontainers.image.source="https://github.com/shostwp-byte/nas-sync" \
      org.opencontainers.image.licenses="MIT"

# Cài đặt đầy đủ công cụ lõi phục vụ Agentless Pull Backup, Restore & GitHub Self-Update trên Synology NAS
RUN apk add --no-cache \
    openssh-client \
    rsync \
    zstd \
    gzip \
    jq \
    mariadb-client \
    sqlite \
    bash \
    coreutils \
    git \
    curl \
    tar \
    tzdata

ENV TZ=Asia/Ho_Chi_Minh
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV DATA_DIR=/app/data
ENV SSH_KEYS_DIR=/root/.ssh

WORKDIR /app

# Tạo sẵn cấu trúc thư mục mount mặc định & kho ghim khóa SSH TOFU (0700)
RUN mkdir -p /app/data/known_hosts /root/.ssh /mnt/vol1 /mnt/vol2 && \
    chmod 700 /root/.ssh /app/data/known_hosts

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/src ./src
COPY --from=builder /app/server.ts ./server.ts
COPY --from=builder /app/next.config.mjs ./next.config.mjs
COPY --from=builder /app/postcss.config.mjs ./postcss.config.mjs
COPY --from=builder /app/tailwind.config.ts ./tailwind.config.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/docker-entrypoint.sh ./docker-entrypoint.sh

RUN sed -i 's/\r$//' /app/docker-entrypoint.sh && chmod +x /app/docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "--import", "tsx", "server.ts"]
