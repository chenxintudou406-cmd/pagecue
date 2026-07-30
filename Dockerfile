FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY admin ./admin
COPY demo ./demo
COPY data ./data
COPY downloads ./downloads
COPY extension/shared ./extension/shared
COPY shared ./shared
COPY server.js README.md PRIVACY.md ./

EXPOSE 8787
CMD ["node", "server.js"]
