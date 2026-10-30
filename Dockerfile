FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24-alpine AS runner

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

# Tạo sẵn cấu trúc thư mục mount mặc định
RUN mkdir -p /app/data /root/.ssh /mnt/vol1 /mnt/vol2 && chmod 700 /root/.ssh

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
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
