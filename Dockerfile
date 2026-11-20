# Shadow Agent server: agents, scheduler, gateway, MCP and A2A endpoints.
# Node 24 runs the TypeScript sources directly, so there is no build step.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY app/package.json app/
RUN npm ci --omit=dev --workspace server --include-workspace-root=false && npm cache clean --force

COPY server/src server/src

ENV SHADOW_HOME=/data SHADOW_HOST=0.0.0.0 SHADOW_PORT=7777
VOLUME /data
EXPOSE 7777
USER node
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s CMD wget -qO- http://127.0.0.1:7777/health || exit 1
CMD ["node", "server/src/index.ts"]
