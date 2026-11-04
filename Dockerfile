# Closer as a container: the same server as `npm run ui`. Mock mode unless CLOSER_MODE=real and
# MODEL_API_KEY are passed in at run time (never baked into the image).
#   docker build --build-arg BUILD_SHA=$(git rev-parse HEAD) -t closer .
#   docker run --rm -p 8787:8787 -v closer-data:/data closer      → http://localhost:8787
FROM node:22-slim
WORKDIR /app
# Runtime dependencies only (@meta-sam/parser, three), pinned by the lock file.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY . .
# /version shows this sha: web/server.ts reads the BUILD_SHA file when there is no .git directory.
ARG BUILD_SHA=unknown
RUN printf '%s\n' "$BUILD_SHA" > BUILD_SHA
# Data (the SQLite ledger and uploaded photos) lives outside the image, in a volume at /data.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
ENV CLOSER_DB_PATH=/data/closer.db CLOSER_PORT=8787 CLOSER_HOST=0.0.0.0
EXPOSE 8787
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "web/server.ts"]
