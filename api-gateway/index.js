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
const chatServiceUrl = process.env.CHAT_SERVICE_URL || 'http://localhost:3005';

async function fetchDependencyHealth(service, url, healthPath = '/health') {
    try {
        const response = await fetch(`${url}${healthPath}`, {
            signal: AbortSignal.timeout(5_000),
        });

        return {
            service,
            ok: response.ok,
            status: response.status,
            url,
        };
    } catch (error) {
        return {
            service,
            ok: false,
            status: 503,
            url,
            error: error?.message || 'Dependency health check failed',
        };
    }
}

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

app.use('/posts/newsletter', buildServiceProxy(postServiceUrl, {
    pathRewrite: (path) => `/newsletter${path === '/' ? '' : path}`,
}));

app.use('/users', buildServiceProxy(userServiceUrl));
app.use('/posts', buildServiceProxy(postServiceUrl));
app.use('/jobs', buildServiceProxy(jobServiceUrl));
app.use('/auth', buildServiceProxy(authServiceUrl));

const chatProxy = buildServiceProxy(
    chatServiceUrl,
    {
        ws: true,
        proxyTimeout: 20_000,
        timeout: 20_000,
    }
);

app.use('/chat', chatProxy);

app.get('/health', async (req, res) => {
    const dependencies = await Promise.all([
        fetchDependencyHealth('auth-service', authServiceUrl),
        fetchDependencyHealth('user-service', userServiceUrl),
        fetchDependencyHealth('post-service', postServiceUrl),
        fetchDependencyHealth('job-service', jobServiceUrl),
        fetchDependencyHealth('chat-service', chatServiceUrl),
    ]);

    const allHealthy = dependencies.every((item) => item.ok);

    return res.status(allHealthy ? 200 : 503).json({
        service: 'api-gateway',
        status: allHealthy ? 'ok' : 'degraded',
        routes: ['/auth', '/users', '/posts', '/posts/collab-posts', '/posts/join-requests', '/posts/collab-notifications', '/posts/newsletter', '/jobs', '/chat'],
        dependencies,
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
