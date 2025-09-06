FROM node:22-bookworm-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl unzip libaio1 tzdata && \
    rm -rf /var/lib/apt/lists/*

# timezone real
ENV TZ=America/Sao_Paulo
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# Oracle Instant Client Basic Lite 21.13
ENV OCI_VER_DIR=instantclient_21_13
RUN curl -fsSL https://download.oracle.com/otn_software/linux/instantclient/211300/instantclient-basiclite-linux.x64-21.13.0.0.0dbru.zip -o /tmp/oci.zip && \
    mkdir -p /opt/oracle && unzip -qo /tmp/oci.zip -d /opt/oracle && rm -f /tmp/oci.zip && \
    echo "/opt/oracle/${OCI_VER_DIR}" > /etc/ld.so.conf.d/oracle-instantclient.conf && ldconfig

ENV LD_LIBRARY_PATH=/opt/oracle/${OCI_VER_DIR}
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
