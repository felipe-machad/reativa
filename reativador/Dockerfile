# ============================================================
# Reativador — imagem enxuta pra rodar no EasyPanel.
# O app persiste tudo em /data (monte um volume nessa pasta!).
# ============================================================
FROM node:20-alpine

# dumb-init garante que o SIGTERM chegue no Node (desligamento limpo)
RUN apk add --no-cache dumb-init

WORKDIR /app

# só o manifesto primeiro: aproveita o cache de build
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public
COPY testes ./testes

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data
ENV TZ=America/Sao_Paulo

# a pasta dos dados existe mesmo se ninguém montar o volume
RUN mkdir -p /data

EXPOSE 3000

HEALTHCHECK --interval=60s --timeout=5s --start-period=15s \
  CMD wget -qO- http://localhost:3000/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]
