FROM node:alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3189
VOLUME ["/config", "/logs"]
CMD ["node", "main.js", "/logs", "/config/config.yaml", "/config/last_run_timestamps.json"]