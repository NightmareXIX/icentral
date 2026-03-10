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

const userServiceUrl = process.env.USER_SERVICE_URL || 'http://localhost:3001';
const postServiceUrl = process.env.POST_SERVICE_URL || 'http://localhost:3002';
const jobServiceUrl = process.env.JOB_SERVICE_URL || 'http://localhost:3003';
const authServiceUrl = process.env.AUTH_SERVICE_URL || 'http://localhost:3004';

app.get('/posts/search', buildServiceProxy(postServiceUrl, {
    pathRewrite: {
        '^/posts/search$': '/search',
    },
}));

app.get('/posts', buildServiceProxy(postServiceUrl, {
    pathRewrite: {
        '^/posts$': '/feed',
    },
}));

app.use('/posts/collab-posts', buildServiceProxy(postServiceUrl, {
    pathRewrite: (path) => `/collab-posts${path === '/' ? '' : path}`,
}));

app.use('/posts/join-requests', buildServiceProxy(postServiceUrl, {
    pathRewrite: (path) => `/join-requests${path === '/' ? '' : path}`,
}));

app.use('/posts/collab-notifications', buildServiceProxy(postServiceUrl, {
    pathRewrite: (path) => `/collab-notifications${path === '/' ? '' : path}`,
}));

app.use('/users', buildServiceProxy(userServiceUrl));
app.use('/posts', buildServiceProxy(postServiceUrl));
app.use('/jobs', buildServiceProxy(jobServiceUrl));
app.use('/auth', buildServiceProxy(authServiceUrl));

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
        routes: ['/auth', '/users', '/posts', '/posts/collab-posts', '/posts/join-requests', '/posts/collab-notifications', '/jobs', '/chat'],
    });
});

server.on('upgrade', (req, socket, head) => {
    if (req.url && req.url.startsWith('/chat/')) {
        req.url = req.url.replace(/^\/chat/, '');
        chatProxy.upgrade(req, socket, head);
    }
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`API Gateway is running on port ${PORT}`);
});
