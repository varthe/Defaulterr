FROM node
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3189
VOLUME /config
VOLUME /logs
CMD ["node","main.js","/config/config.yaml"]