FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache bash

COPY api-gateway/package*.json /app/api-gateway/
COPY services/auth-service/package*.json /app/services/auth-service/
COPY services/user-service/package*.json /app/services/user-service/
COPY services/post-service/package*.json /app/services/post-service/
COPY services/job-service/package*.json /app/services/job-service/
COPY services/chat-service/package*.json /app/services/chat-service/

RUN cd /app/api-gateway && npm install --no-audit --no-fund \
    && cd /app/services/auth-service && npm install --no-audit --no-fund \
    && cd /app/services/user-service && npm install --no-audit --no-fund \
    && cd /app/services/post-service && npm install --no-audit --no-fund \
    && cd /app/services/job-service && npm install --no-audit --no-fund \
    && cd /app/services/chat-service && npm install --no-audit --no-fund

COPY api-gateway /app/api-gateway
COPY services /app/services
COPY render /app/render

RUN chmod +x /app/render/start-backend.sh

ENV NODE_ENV=production \
    USER_SERVICE_URL=http://127.0.0.1:3001 \
    POST_SERVICE_URL=http://127.0.0.1:3002 \
    JOB_SERVICE_URL=http://127.0.0.1:3003 \
    AUTH_SERVICE_URL=http://127.0.0.1:3004 \
    CHAT_SERVICE_URL=http://127.0.0.1:3005

CMD ["/app/render/start-backend.sh"]
