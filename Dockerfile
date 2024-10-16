FROM node:alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3189
VOLUME ["/config", "/logs"]
CMD ["node", "main.js", "/logs/defaulterr.log", "/config/config.yaml", "/config/last_run_timestamps.json"]