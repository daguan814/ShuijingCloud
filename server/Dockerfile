FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    TZ=Asia/Shanghai

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

COPY server/src ./src
COPY frontend ./frontend

RUN mkdir -p /data/storage /data/logs && chown -R node:node /app /data

USER node
EXPOSE 8080

CMD ["node", "src/index.js"]
