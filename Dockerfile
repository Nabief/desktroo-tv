# Desktroo TV — © 2026 Mdm-services.fr. Tous droits réservés.
# Le moteur est Threadfin (MIT, https://github.com/Threadfin/Threadfin), compilé depuis sa source à la version
# indiquée ci-dessous, sans modification, et lancé par l'app sur son port interne. Sa licence est livrée dans l'image.
FROM golang:1.23-alpine AS engine
ARG THREADFIN_VERSION=1.2.39
RUN apk add --no-cache git \
 && git clone --depth 1 --branch "${THREADFIN_VERSION}" https://github.com/Threadfin/Threadfin /src \
 && cd /src \
 && CGO_ENABLED=0 go build -mod=mod -ldflags="-s -w" -trimpath -o /threadfin threadfin.go

FROM node:20-alpine
ARG THREADFIN_VERSION=1.2.39
LABEL org.opencontainers.image.title="Desktroo TV" \
      org.opencontainers.image.vendor="Mdm-services.fr" \
      org.opencontainers.image.source="https://github.com/Nabief/desktroo-tv" \
      org.opencontainers.image.licenses="LicenseRef-Desktroo AND MIT" \
      fr.desktroo.threadfin="${THREADFIN_VERSION}"
WORKDIR /app
COPY --from=engine /threadfin /app/threadfin
COPY --from=engine /src/LICENSE /app/THREADFIN-LICENSE
COPY server.js tf.js jellyfin.js ./
COPY public ./public
ENV NODE_ENV=production DATA_DIR=/data
EXPOSE 8080 34400
# Desktroo Apps lance le conteneur sous le compte du NAS prêté à l'app, en lecture seule hors de ses volumes.
CMD ["node", "server.js"]
