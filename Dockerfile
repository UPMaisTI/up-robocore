FROM node:22-bookworm-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl unzip tzdata && \
    rm -rf /var/lib/apt/lists/*

# timezone real
ENV TZ=America/Sao_Paulo
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# Usando Thin mode do node-oracledb (sem Instant Client)
ENV TNS_ADMIN=/app/tns
RUN mkdir -p /app/tns

# 1) Dependências (cache-friendly)
COPY package*.json ./
RUN npm ci --only=production || npm ci
RUN npm i -D @nestjs/cli typescript copyfiles

# 2) Código (inclui tnsnames.ora se existir no repo)
COPY . .

# 3) Se tnsnames.ora existir, move para /app/tns (cópia opcional, sem quebrar build)
RUN if [ -f "/app/tnsnames.ora" ]; then cp /app/tnsnames.ora /app/tns/tnsnames.ora; fi

RUN npx nest build && npx copyfiles -u 1 src/robots.manifest.json dist/

EXPOSE 3000
CMD ["node", "dist/main.js"]
