require('dotenv').config();
const express = require('express');

const app = express();

const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
    }
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }

    return next();
});

app.use(express.json());

const PORT = process.env.PORT || 3004;

const authRoutes = require('./routes/authRoute');
function healthHandler(req, res) {
    return res.json({ health: 'Auth service OK' });
}

app.get('/', healthHandler);
app.get('/health', healthHandler);
app.use('/auth', authRoutes);
app.use('/', authRoutes);

app.listen(PORT, () => {
    console.log(`Auth Service is running on port ${PORT}`);
});
