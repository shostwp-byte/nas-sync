FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

COPY . .
RUN mkdir -p /app/public
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-alpine AS runner

LABEL org.opencontainers.image.title="NAS-Sync" \
      org.opencontainers.image.description="Open-Source Agentless Multi-Panel VPS Backup & Cross-Panel Migration Platform for Multi-NAS & Docker" \
      org.opencontainers.image.source="https://github.com/shostwp-byte/nas-sync" \
      org.opencontainers.image.licenses="MIT"

# Cài đặt công cụ lõi phục vụ Agentless Pull Backup, Restore, PostgreSQL/MariaDB Verification & su-exec non-root
RUN apk add --no-cache \
    openssh-client \
    rsync \
    zstd \
    gzip \
    jq \
    mariadb-client \
    postgresql-client \
    sqlite \
    bash \
    coreutils \
    git \
    curl \
    tar \
    su-exec \
    tzdata && \
    deluser --remove-home node 2>/dev/null || true && \
    addgroup -g 1000 -S nassync && \
    adduser -u 1000 -S -G nassync -h /home/nassync -s /sbin/nologin nassync

ENV TZ=Asia/Ho_Chi_Minh
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV DATA_DIR=/app/data
ENV SSH_KEYS_DIR=/app/ssh_keys

WORKDIR /app

# Tạo sẵn cấu trúc thư mục mount mặc định & kho ghim khóa SSH TOFU (0700)
RUN mkdir -p /app/data/known_hosts /app/ssh_keys /root/.ssh /home/nassync/.ssh /mnt/vol1 /mnt/vol2 && \
    chmod 700 /app/ssh_keys /root/.ssh /home/nassync/.ssh /app/data/known_hosts && \
    chown -R nassync:nassync /app /home/nassync /mnt/vol1 /mnt/vol2

COPY --from=builder --chown=nassync:nassync /app/package.json ./package.json
COPY --from=builder --chown=nassync:nassync /app/package-lock.json ./package-lock.json
COPY --from=builder --chown=nassync:nassync /app/node_modules ./node_modules
COPY --from=builder --chown=nassync:nassync /app/.next ./.next
COPY --from=builder --chown=nassync:nassync /app/public ./public
COPY --from=builder --chown=nassync:nassync /app/scripts ./scripts
COPY --from=builder --chown=nassync:nassync /app/src ./src
COPY --from=builder --chown=nassync:nassync /app/server.ts ./server.ts
COPY --from=builder --chown=nassync:nassync /app/next.config.mjs ./next.config.mjs
COPY --from=builder --chown=nassync:nassync /app/postcss.config.mjs ./postcss.config.mjs
COPY --from=builder --chown=nassync:nassync /app/tailwind.config.ts ./tailwind.config.ts
COPY --from=builder --chown=nassync:nassync /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/docker-entrypoint.sh ./docker-entrypoint.sh

RUN sed -i 's/\r$//' /app/docker-entrypoint.sh && chmod +x /app/docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "--import", "tsx", "server.ts"]
