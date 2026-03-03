FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY index.js ./

# No npm install needed — zero dependencies (uses only Node.js built-ins)

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

USER node

CMD ["node", "index.js"]
