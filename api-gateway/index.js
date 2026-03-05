require('dotenv').config();
const http = require('http');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: true, credentials: true }));

function buildServiceProxy(target, extraOptions = {}) {
    return createProxyMiddleware({
        target,
        changeOrigin: true,
        ...extraOptions,
    });
}

app.use('/users', buildServiceProxy(process.env.USER_SERVICE_URL || 'http://localhost:3001'));
app.use('/posts', buildServiceProxy(process.env.POST_SERVICE_URL || 'http://localhost:3002'));
app.use('/jobs', buildServiceProxy(process.env.JOB_SERVICE_URL || 'http://localhost:3003'));
app.use('/auth', buildServiceProxy(process.env.AUTH_SERVICE_URL || 'http://localhost:3004'));

const chatProxy = buildServiceProxy(
    process.env.CHAT_SERVICE_URL || 'http://localhost:3005',
    {
        ws: true,
        proxyTimeout: 20_000,
        timeout: 20_000,
    }
);

app.use('/chat', chatProxy);

app.get('/health', (req, res) => {
    return res.json({
        service: 'api-gateway',
        status: 'ok',
        routes: ['/auth', '/users', '/posts', '/jobs', '/chat'],
    });
});

server.on('upgrade', (req, socket, head) => {
    if (req.url && req.url.startsWith('/chat/')) {
        chatProxy.upgrade(req, socket, head);
    }
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`API Gateway is running on port ${PORT}`);
});
