# Connexion Two — ClamAV scanner image.
FROM node:20-slim

# ClamAV daemon + updater. clamdscan talks to clamd over TCP (see server.js).
RUN apt-get update \
 && apt-get install -y --no-install-recommends clamav clamav-daemon clamav-freshclam ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Make clamd listen on TCP 3310 (default config only enables a unix socket) and
# turn on heuristics so it catches more than exact-signature matches:
#   DetectPUA            — potentially-unwanted apps
#   AlertOLE2Macros      — Office docs carrying macros (a top malware vector)
#   AlertEncrypted*      — password-protected files/archives that can't be inspected
#   AlertBrokenExecutables / HeuristicAlerts — malformed/heuristic hits
RUN sed -i 's/^#\?LocalSocket/#LocalSocket/' /etc/clamav/clamd.conf \
 && { \
      echo "TCPSocket 3310"; \
      echo "TCPAddr 127.0.0.1"; \
      echo "DetectPUA yes"; \
      echo "AlertOLE2Macros yes"; \
      echo "AlertEncrypted yes"; \
      echo "AlertEncryptedArchive yes"; \
      echo "AlertBrokenExecutables yes"; \
      echo "HeuristicAlerts yes"; \
    } >> /etc/clamav/clamd.conf

WORKDIR /app

# Install deps first for better layer caching.
COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh \
 # clamav needs to own its DB + run dirs, and node runs as the same unprivileged user.
 && chown -R clamav:clamav /var/lib/clamav /var/log/clamav /var/run/clamav /app

# Drop root — the API and clamd both run as the clamav user.
USER clamav

EXPOSE 8080

# Simple container healthcheck against the /health route.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./entrypoint.sh"]
