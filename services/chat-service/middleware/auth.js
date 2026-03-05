const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'HelloWorldKey';

function parseBearerToken(req) {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) return null;

    const token = authHeader.slice(7).trim();
    return token || null;
}

function normalizeUserFromPayload(payload = {}) {
    const userId = payload.id || payload.userId || payload.sub;
    const rawRoles = payload.roles ?? payload.role;
    const roles = Array.isArray(rawRoles)
        ? rawRoles.map((role) => String(role).trim()).filter(Boolean)
        : rawRoles
            ? [String(rawRoles).trim()]
            : [];

    if (!userId) {
        throw new Error('Token payload missing user id');
    }

    return {
        id: String(userId),
        roles,
    };
}

function verifyToken(token) {
    if (!token) {
        throw new Error('Missing token');
    }

    const payload = jwt.verify(token, JWT_SECRET);
    return normalizeUserFromPayload(payload);
}

function authenticateRequest(req, res, next) {
    try {
        const token = parseBearerToken(req);
        if (!token) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        req.user = verifyToken(token);
        return next();
    } catch (error) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

function extractSocketToken(socket) {
    const authToken = socket.handshake.auth?.token;
    if (typeof authToken === 'string' && authToken.trim()) {
        return authToken.trim();
    }

    const queryToken = socket.handshake.query?.token;
    if (typeof queryToken === 'string' && queryToken.trim()) {
        return queryToken.trim();
    }

    const headerValue = socket.handshake.headers?.authorization || '';
    if (headerValue.startsWith('Bearer ')) {
        const headerToken = headerValue.slice(7).trim();
        return headerToken || null;
    }

    return null;
}

function authenticateSocket(socket, next) {
    try {
        const token = extractSocketToken(socket);
        socket.user = verifyToken(token);
        return next();
    } catch {
        return next(new Error('Unauthorized'));
    }
}

module.exports = {
    authenticateRequest,
    authenticateSocket,
    verifyToken,
};
