# ============================================================
# Reativador — imagem enxuta pra rodar no EasyPanel.
# O app persiste tudo em /data (montar volume nessa pasta!).
# ============================================================
FROM node:20-alpine

WORKDIR /app

# só as dependências primeiro (cache de build melhor)
COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data

EXPOSE 3000

HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/server.js"]
