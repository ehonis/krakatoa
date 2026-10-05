# Krakatoa in one container. The log and settings live in the /data volume.
#
#   docker compose up -d        then open the setup link from: docker compose logs
#
# The AI features need the Claude Code CLI. Build with WITH_CLAUDE=1 to include
# it, then either sign in once (docker compose exec krakatoa claude) or paste an
# Anthropic API key in Settings -> AI.
FROM node:22-slim

ARG WITH_CLAUDE=0
# poppler-utils: pdftotext/pdfinfo, used when Ask AI reads a chain's nutrition PDF.
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && if [ "$WITH_CLAUDE" = "1" ]; then npm install -g @anthropic-ai/claude-code && npm cache clean --force; fi

WORKDIR /srv/krakatoa
COPY app/package.json app/package-lock.json app/
RUN npm --prefix app ci --no-audit --no-fund
COPY . .
RUN npm --prefix app run build \
 && mkdir -p /data /home/node/.claude \
 && chown node:node /data /home/node/.claude

USER node
ENV KRAKATOA_DATA_DIR=/data \
    KRAKATOA_BIND=0.0.0.0 \
    KRAKATOA_PORT=8101
VOLUME ["/data"]
EXPOSE 8101
CMD ["node", "server/server.js"]
