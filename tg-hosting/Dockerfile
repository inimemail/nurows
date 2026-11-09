FROM node:22-bookworm-slim AS runner
WORKDIR /runtime
COPY tg-hosting/package*.json ./
RUN npm ci --omit=dev
COPY tg-hosting/runner.mjs ./runner.mjs
COPY shared/tg-hosting.js ./shared/tg-hosting.js
COPY shared/tg-cpu-group.js ./shared/tg-cpu-group.js
COPY shared/tg-http.js ./shared/tg-http.js
COPY shared/tg-docker.js ./shared/tg-docker.js
COPY shared/tg-frame-relay.js ./shared/tg-frame-relay.js
COPY shared/tg-profile-storage.js ./shared/tg-profile-storage.js
COPY server/backup-crypto.cjs ./backup-crypto.cjs
CMD ["node", "runner.mjs"]

FROM node:22-bookworm-slim AS browser
RUN apt-get update && apt-get install -y --no-install-recommends chromium openbox tigervnc-standalone-server tigervnc-tools xclip tini python3 fonts-noto-cjk fonts-noto-color-emoji ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd -g 10001 browser && useradd -m -u 10001 -g 10001 browser
COPY tg-hosting/browser-policy.json /etc/chromium/policies/managed/nurossh.json
COPY tg-hosting/browser.mjs /opt/browser.mjs
COPY tg-hosting/openbox.xml /opt/openbox.xml
COPY tg-hosting/profile-archive.cjs tg-hosting/profile-archive.py /opt/
USER 10001:10001
ENV DISPLAY=:99 HOME=/home/browser
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/browser.mjs"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 CMD node -e "const n=require('net');const s=n.connect(5900,'127.0.0.1');s.setTimeout(2000);s.once('data',d=>process.exit(d.toString().startsWith('RFB ')?0:1));s.once('error',()=>process.exit(1));s.once('timeout',()=>process.exit(1));"
