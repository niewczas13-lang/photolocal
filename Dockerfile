# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS base
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

FROM base AS node-dependencies
RUN apt-get update \
    && apt-get install -y --no-install-recommends make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
# Native dependencies are installed in Linux; host node_modules never enter the image.
RUN npm ci

FROM node-dependencies AS build
COPY backend/ ./backend/
COPY frontend/ ./frontend/
COPY scripts/copy-schema.mjs ./scripts/copy-schema.mjs
RUN npm run build

FROM node-dependencies AS production-dependencies
RUN npm ci --omit=dev --workspace backend --include-workspace-root=false \
    && node --input-type=module -e "import Database from 'better-sqlite3'; import sharp from 'sharp'; const db = new Database(':memory:'); db.close(); await sharp({create:{width:1,height:1,channels:3,background:'white'}}).png().toBuffer();"

FROM base AS python-dependencies
COPY pobierzchat/requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt

FROM base AS runtime
ENV NODE_ENV=production \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PHOTO_LOCAL_HOST=0.0.0.0 \
    PHOTO_LOCAL_PORT=4873 \
    PHOTO_LOCAL_DB=/data/photo-local.sqlite \
    PHOTO_LOCAL_LOG=/data/logs/app.log \
    GOOGLE_CHAT_PYTHON=/opt/venv/bin/python \
    GOOGLE_CHAT_CREDENTIALS_FILE=/google/credentials.json \
    GOOGLE_CHAT_TOKEN_FILE=/google/token.json \
    GOOGLE_CHAT_DOWNLOAD_ROOT=/downloads \
    GOOGLE_CHAT_JOB_STATE_FILE=/data/google-chat-download.json
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/frontend/dist ./frontend/dist
COPY --from=python-dependencies /opt/venv /opt/venv
COPY package.json ./package.json
COPY backend/package.json ./backend/package.json
COPY pobierzchat/chat.py ./pobierzchat/chat.py
COPY scripts/migrate-docker-data.mjs ./scripts/migrate-docker-data.mjs
RUN mkdir -p /data /google /downloads /photos \
    && chown node:node /data /google /downloads /photos
USER node
EXPOSE 4873
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:4873/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "backend/dist/server.js"]
