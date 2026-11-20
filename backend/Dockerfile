# Keep the base immutable; refresh this digest deliberately with dependency updates.
FROM node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 AS build
WORKDIR /app
RUN apk add --no-cache python3 py3-pip
RUN python3 -m venv /opt/bankai-scanners \
    && /opt/bankai-scanners/bin/pip install --no-cache-dir semgrep==1.186.0 bandit==1.9.4 pip-audit==2.10.1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . ./
RUN npm run build

FROM node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false

RUN addgroup -S -g 10001 bankai \
    && adduser -S -D -H -u 10001 -G bankai bankai

# Scanner releases are pinned. These tools analyze repository files only; Bankai
# never runs a customer's build or package installation as part of a scan.
ARG TARGETARCH
RUN apk add --no-cache ca-certificates curl tar python3 libffi libstdc++ \
    && case "$TARGETARCH" in arm64) BINARCH=ARM64; GOARCH=arm64; GITLEAKS_ARCH=arm64 ;; *) BINARCH=64bit; GOARCH=amd64; GITLEAKS_ARCH=x64 ;; esac \
    && curl -fsSL "https://github.com/aquasecurity/trivy/releases/download/v0.76.2/trivy_0.76.2_Linux-${BINARCH}.tar.gz" -o /tmp/trivy.tgz \
    && tar -xzf /tmp/trivy.tgz -C /usr/local/bin trivy \
    && curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_${GITLEAKS_ARCH}.tar.gz" -o /tmp/gitleaks.tgz \
    && tar -xzf /tmp/gitleaks.tgz -C /usr/local/bin gitleaks \
    && curl -fsSL "https://github.com/google/osv-scanner/releases/download/v2.7.1/osv-scanner_linux_${GOARCH}" -o /usr/local/bin/osv-scanner \
    && chmod 0755 /usr/local/bin/osv-scanner \
    && rm -f /tmp/trivy.tgz /tmp/gitleaks.tgz \
    && mkdir -p /home/bankai/.cache \
    && chown -R 10001:10001 /home/bankai

ENV PATH="/opt/bankai-scanners/bin:${PATH}" \
    HOME="/home/bankai" \
    XDG_CACHE_HOME="/home/bankai/.cache" \
    TRIVY_CACHE_DIR=/tmp/trivy-cache

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force \
    && rm -rf /root/.npm
COPY --from=build /opt/bankai-scanners /opt/bankai-scanners
COPY --from=build --chown=10001:10001 /app/dist ./dist

USER 10001:10001

EXPOSE 4000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
