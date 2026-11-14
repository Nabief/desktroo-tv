# Desktroo TV — © 2026 Mdm-services.fr. Tous droits réservés.
# Le moteur est Threadfin (MIT, https://github.com/Threadfin/Threadfin), compilé depuis sa source à la version
# indiquée ci-dessous et lancé par l'app sur son port interne. Sa licence est livrée dans l'image.
#
# Un seul correctif y est appliqué, ci-dessous : son lecteur de listes de lecture a deux chemins, un normal
# et un « optimisé » au-delà de 10 Mo. L'optimisé exige deux lignes utiles par chaîne alors qu'il vient d'en
# écarter une, et renvoie donc zéro chaîne, sans erreur : toute liste de plus de 10 Mo est perdue. Une ligne
# suffit. La compilation échoue si cette ligne n'existe plus, pour ne pas livrer un correctif devenu inutile
# ou déplacé (signalé en amont : https://github.com/Threadfin/Threadfin).
FROM golang:1.23-alpine AS engine
ARG THREADFIN_VERSION=1.2.39
ARG PARSER_BUG='if len(lines) < 2 {'
ARG PARSER_FIX='if len(lines) < 1 {'
RUN apk add --no-cache git \
 && git clone --depth 1 --branch "${THREADFIN_VERSION}" https://github.com/Threadfin/Threadfin /src \
 && cd /src \
 && P=src/internal/m3u-parser/xteve_m3uParser_optimized.go \
 && grep -qF "${PARSER_BUG}" "$P" \
 && sed -i "s|${PARSER_BUG}|${PARSER_FIX}|" "$P" \
 && CGO_ENABLED=0 go build -mod=mod -ldflags="-s -w" -trimpath -o /threadfin threadfin.go

FROM node:20-alpine
ARG THREADFIN_VERSION=1.2.39
LABEL org.opencontainers.image.title="Desktroo TV" \
      org.opencontainers.image.vendor="Mdm-services.fr" \
      org.opencontainers.image.source="https://github.com/Nabief/desktroo-tv" \
      org.opencontainers.image.licenses="LicenseRef-Desktroo AND MIT" \
      fr.desktroo.threadfin="${THREADFIN_VERSION}"
# FFmpeg relaie les flux : le mode de tampon interne du moteur ne démarre rien dans cette version,
# et FFmpeg sait en plus se présenter au fournisseur comme le lecteur qu'il attend.
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY --from=engine /threadfin /app/threadfin
COPY --from=engine /src/LICENSE /app/THREADFIN-LICENSE
# Tous les modules de l'app, pour qu'en ajouter un n'oblige pas à penser à cette ligne.
COPY *.js ./
COPY public ./public
# Garde-fou : l'app démarrerait et s'arrêterait aussitôt s'il manquait un de ses modules.
RUN node -e 'const fs=require("fs");const s=fs.readFileSync("server.js","utf8");let n=0;for(const m of s.matchAll(/require\(.\.\/([a-z-]+)./g)){fs.accessSync(m[1]+".js");n++}console.log("modules locaux presents :",n)'
ENV NODE_ENV=production DATA_DIR=/data
EXPOSE 8080 34400
# Desktroo Apps lance le conteneur sous le compte du NAS prêté à l'app, en lecture seule hors de ses volumes.
CMD ["node", "server.js"]
