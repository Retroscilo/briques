# Le serveur du module de rendez-vous. Node 24 pour node:sqlite ; Alpine
# parce qu'il n'y a rien à compiler (une seule dépendance, nodemailer, en pur
# JavaScript).
FROM node:24-alpine

WORKDIR /app

# Les dépendances d'abord, pour que le cache de construction tienne tant que
# package.json ne bouge pas.
COPY serveur/package.json serveur/package-lock.json* ./serveur/
RUN cd serveur && npm ci --omit=dev --no-audit --no-fund

# La brique (servie par la page autonome) et le serveur.
COPY rdv.css rdv.js ./
COPY serveur ./serveur

# Le dossier des données est un volume ; il appartient à l'utilisateur node.
RUN mkdir -p /donnees && chown node:node /donnees
ENV DONNEES=/donnees PORT=3000 NODE_ENV=production
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/sante || exit 1

CMD ["node", "serveur/serveur.js"]
