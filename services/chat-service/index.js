require('dotenv').config();
const http = require('http');
const cors = require('cors');
const express = require('express');
const { Server } = require('socket.io');
const chatRoutes = require('./routes/chatRoutes');
const { authenticateSocket } = require('./middleware/auth');
const { query, isDbConfigured, closePool } = require('./db');
const { requireConversationMembership } = require('./controllers/chatController');

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT) || 3005;
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:5000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

const corsOptions = {
    origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }

        return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
};

const io = new Server(server, {
    path: '/chat/socket.io',
    cors: corsOptions,
});

app.locals.io = io;

app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
        const elapsedMs = Date.now() - startedAt;
        console.log(`[chat-service] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${elapsedMs}ms)`);
    });
    next();
});

app.get('/', (req, res) => {
    return res.json({
        health: 'Chat service OK',
        socketPath: '/chat/socket.io',
        endpoints: [
            'POST /chat/conversations/dm',
            'GET /chat/conversations',
            'GET /chat/conversations/:id/messages',
            'POST /chat/conversations/:id/messages',
            'POST /chat/conversations/:id/read',
        ],
    });
});

app.get('/health', async (req, res) => {
    if (!isDbConfigured()) {
        return res.status(503).json({
            service: 'chat-service',
            status: 'degraded',
            error: 'SUPABASE_DB_URL is missing',
        });
    }

    try {
        await query('SELECT 1');
        return res.json({
            service: 'chat-service',
            status: 'ok',
        });
    } catch (error) {
        return res.status(503).json({
            service: 'chat-service',
            status: 'degraded',
            error: error.message,
        });
    }
});

app.use('/chat', chatRoutes);

app.use((error, req, res, next) => {
    const statusCode = Number(error.status) || 500;
    const payload = {
        error: statusCode >= 500 ? 'Internal server error' : error.message || 'Request failed',
    };

    if (error.details) {
        payload.details = error.details;
    }

    if (statusCode >= 500) {
        console.error('[chat-service] Unhandled error', error);
    }

    return res.status(statusCode).json(payload);
});

io.use(authenticateSocket);

io.on('connection', (socket) => {
    const userId = socket.user.id;
    socket.join(`user:${userId}`);
    console.log(`[chat-service] socket connected user=${userId} socket=${socket.id}`);

    socket.on('conversation:join', async (payload = {}, ack) => {
        const callback = typeof ack === 'function' ? ack : () => {};
        const conversationId = String(payload?.conversationId || '').trim();

        if (!conversationId) {
            callback({ ok: false, error: 'conversationId is required' });
            return;
        }

        try {
            await requireConversationMembership(conversationId, userId);
            await socket.join(`conversation:${conversationId}`);
            callback({ ok: true, conversationId });
        } catch (error) {
            const status = Number(error.status) || 500;
            callback({
                ok: false,
                error: status === 403 ? 'Forbidden' : status === 404 ? 'Conversation not found' : 'Failed to join',
            });
        }
    });

    socket.on('conversation:leave', async (payload = {}, ack) => {
        const callback = typeof ack === 'function' ? ack : () => {};
        const conversationId = String(payload?.conversationId || '').trim();

        if (!conversationId) {
            callback({ ok: false, error: 'conversationId is required' });
            return;
        }

        await socket.leave(`conversation:${conversationId}`);
        callback({ ok: true, conversationId });
    });

    socket.on('disconnect', (reason) => {
        console.log(`[chat-service] socket disconnected user=${userId} socket=${socket.id} reason=${reason}`);
    });
});

const gracefulShutdown = async (signal) => {
    console.log(`[chat-service] ${signal} received, shutting down`);
    io.close();

    server.close(async () => {
        await closePool();
        process.exit(0);
    });

    setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

server.listen(PORT, () => {
    console.log(`Chat service is running on port ${PORT}`);
});
