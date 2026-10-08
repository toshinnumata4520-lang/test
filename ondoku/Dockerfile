FROM node:22-alpine
WORKDIR /app
COPY server.js ./
COPY lib ./lib
COPY public ./public
ENV NODE_ENV=production \
    PORT=3100
EXPOSE 3100
USER node
CMD ["node", "server.js"]
