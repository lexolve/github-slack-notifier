FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production --frozen-lockfile || npm install --production

COPY index.js ./

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

USER node

CMD ["node", "index.js"]
