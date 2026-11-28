# NexusFlow Core Gateway & Reactive Rule Engine Container
FROM node:22-alpine AS production

LABEL org.opencontainers.image.title="NexusFlow IoT Telemetry & Rule Engine"
LABEL org.opencontainers.image.description="Visual IoT stream processing gateway, AST rule evaluator, and WebSocket engine"
LABEL org.opencontainers.image.version="1.0.0"

ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0

WORKDIR /app

# Copy manifest and install production-only dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# Copy application source
COPY src ./src

# Provision persistent rule store directory and least-privilege non-root user
RUN addgroup -S nexusflow && adduser -S nexusflow -G nexusflow \
    && mkdir -p /app/data/rules \
    && chown -R nexusflow:nexusflow /app

USER nexusflow

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const http=require('http');http.get('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "src/server.js"]
