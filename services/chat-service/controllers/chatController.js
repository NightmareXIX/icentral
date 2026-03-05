const { z } = require('zod');
const { query, withTransaction } = require('../db');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const startDmSchema = z.object({
    otherUserId: z.string().uuid(),
});

const messageBodySchema = z.object({
    body: z
        .string()
        .transform((value) => value.trim())
        .pipe(z.string().min(1).max(2000)),
});

const messageQuerySchema = z.object({
    cursor: z.string().trim().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
});

const conversationParamSchema = z.object({
    id: z.string().uuid(),
});

function mapMessage(row) {
    return {
        id: row.id,
        conversationId: row.conversation_id,
        senderId: row.sender_id,
        body: row.body,
        createdAt: row.created_at,
    };
}

function mapConversationRow(row) {
    return {
        conversationId: row.conversation_id,
        otherUserId: row.other_user_id,
        lastMessage: row.last_message || null,
        lastMessageAt: row.last_message_at || null,
        unreadCount: Number(row.unread_count || 0),
    };
}

function formatValidationError(error) {
    return error.issues.map((issue) => ({
        path: issue.path.join('.') || 'request',
        message: issue.message,
    }));
}

function parseConversationId(value) {
    const result = conversationParamSchema.safeParse({ id: value });
    if (!result.success) {
        const error = new Error('Invalid conversation id');
        error.status = 400;
        error.details = formatValidationError(result.error);
        throw error;
    }

    return result.data.id;
}

function buildPairLockKey(userA, userB) {
    return [String(userA), String(userB)].sort().join(':');
}

function encodeCursor(row) {
    const payload = JSON.stringify({
        createdAt: row.created_at,
        id: row.id,
    });

    return Buffer.from(payload, 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
    try {
        const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
        if (!parsed?.createdAt || !parsed?.id) {
            throw new Error('Malformed cursor');
        }

        if (!UUID_REGEX.test(String(parsed.id))) {
            throw new Error('Malformed cursor id');
        }

        const parsedDate = new Date(parsed.createdAt);
        if (Number.isNaN(parsedDate.getTime())) {
            throw new Error('Malformed cursor date');
        }

        return {
            createdAt: parsedDate.toISOString(),
            id: String(parsed.id),
        };
    } catch {
        const error = new Error('Invalid cursor');
        error.status = 400;
        throw error;
    }
}

async function requireConversationMembership(conversationId, userId, executor = { query }) {
    const membershipResult = await executor.query(
        `
            SELECT user_id
            FROM conversation_members
            WHERE conversation_id = $1
        `,
        [conversationId]
    );

    if (membershipResult.rowCount === 0) {
        const notFound = new Error('Conversation not found');
        notFound.status = 404;
        throw notFound;
    }

    const isMember = membershipResult.rows.some((row) => String(row.user_id) === String(userId));
    if (!isMember) {
        const forbidden = new Error('You are not a member of this conversation');
        forbidden.status = 403;
        throw forbidden;
    }

    return membershipResult.rows.map((row) => String(row.user_id));
}

async function fetchConversationSummariesForUser(userId, conversationId = null, executor = { query }) {
    const values = [userId];
    const conversationFilter = conversationId ? 'AND c.id = $2' : '';

    if (conversationId) {
        values.push(conversationId);
    }

    const result = await executor.query(
        `
            SELECT
                c.id AS conversation_id,
                other_member.user_id AS other_user_id,
                last_message.body AS last_message,
                last_message.created_at AS last_message_at,
                COALESCE(unread.unread_count, 0)::int AS unread_count
            FROM conversations c
            JOIN conversation_members self_member
                ON self_member.conversation_id = c.id
               AND self_member.user_id = $1
            JOIN LATERAL (
                SELECT COUNT(*)::int AS member_count
                FROM conversation_members members
                WHERE members.conversation_id = c.id
            ) member_counter ON true
            LEFT JOIN LATERAL (
                SELECT other.user_id
                FROM conversation_members other
                WHERE other.conversation_id = c.id
                  AND other.user_id <> $1
                ORDER BY other.joined_at ASC
                LIMIT 1
            ) other_member ON true
            LEFT JOIN LATERAL (
                SELECT m.body, m.created_at
                FROM messages m
                WHERE m.conversation_id = c.id
                ORDER BY m.created_at DESC, m.id DESC
                LIMIT 1
            ) last_message ON true
            LEFT JOIN LATERAL (
                SELECT COUNT(*)::int AS unread_count
                FROM messages m
                WHERE m.conversation_id = c.id
                  AND m.sender_id <> $1
                  AND (self_member.last_read_at IS NULL OR m.created_at > self_member.last_read_at)
            ) unread ON true
            WHERE c.type = 'dm'
              AND member_counter.member_count = 2
              ${conversationFilter}
            ORDER BY COALESCE(last_message.created_at, c.last_message_at, c.created_at) DESC, c.id DESC
        `,
        values
    );

    return result.rows.map(mapConversationRow);
}

async function startDmConversation(req, res, next) {
    try {
        const parsed = startDmSchema.safeParse(req.body || {});
        if (!parsed.success) {
            return res.status(400).json({
                error: 'Validation failed',
                details: formatValidationError(parsed.error),
            });
        }

        const { otherUserId } = parsed.data;
        const requesterId = String(req.user.id);

        if (String(otherUserId) === requesterId) {
            return res.status(400).json({ error: 'Cannot start a DM with yourself' });
        }

        const conversationId = await withTransaction(async (client) => {
            const pairLockKey = buildPairLockKey(requesterId, otherUserId);
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [pairLockKey]);

            const existingConversation = await client.query(
                `
                    SELECT c.id
                    FROM conversations c
                    JOIN conversation_members cm ON cm.conversation_id = c.id
                    WHERE c.type = 'dm'
                    GROUP BY c.id
                    HAVING COUNT(*) = 2
                       AND BOOL_OR(cm.user_id = $1::uuid)
                       AND BOOL_OR(cm.user_id = $2::uuid)
                    LIMIT 1
                `,
                [requesterId, otherUserId]
            );

            if (existingConversation.rowCount > 0) {
                return existingConversation.rows[0].id;
            }

            const userExistsResult = await client.query('SELECT id FROM users WHERE id = $1 LIMIT 1', [otherUserId]);
            if (userExistsResult.rowCount === 0) {
                const notFound = new Error('User not found');
                notFound.status = 404;
                throw notFound;
            }

            const createdConversation = await client.query(
                `
                    INSERT INTO conversations (type)
                    VALUES ('dm')
                    RETURNING id
                `
            );
            const createdConversationId = createdConversation.rows[0].id;

            await client.query(
                `
                    INSERT INTO conversation_members (conversation_id, user_id)
                    VALUES ($1, $2), ($1, $3)
                `,
                [createdConversationId, requesterId, otherUserId]
            );

            return createdConversationId;
        });

        return res.status(200).json({ conversationId });
    } catch (error) {
        return next(error);
    }
}

async function listConversations(req, res, next) {
    try {
        const items = await fetchConversationSummariesForUser(req.user.id);
        return res.json(items);
    } catch (error) {
        return next(error);
    }
}

async function getConversationMessages(req, res, next) {
    try {
        const conversationId = parseConversationId(req.params.id);
        await requireConversationMembership(conversationId, req.user.id);

        const parsedQuery = messageQuerySchema.safeParse(req.query || {});
        if (!parsedQuery.success) {
            return res.status(400).json({
                error: 'Validation failed',
                details: formatValidationError(parsedQuery.error),
            });
        }

        const { limit, cursor } = parsedQuery.data;
        const decodedCursor = cursor ? decodeCursor(cursor) : null;

        const values = [conversationId, limit];
        let cursorClause = '';

        if (decodedCursor) {
            values.push(decodedCursor.createdAt, decodedCursor.id);
            cursorClause = 'AND (m.created_at, m.id) < ($3::timestamptz, $4::uuid)';
        }

        const messagesResult = await query(
            `
                SELECT m.id, m.conversation_id, m.sender_id, m.body, m.created_at
                FROM messages m
                WHERE m.conversation_id = $1
                ${cursorClause}
                ORDER BY m.created_at DESC, m.id DESC
                LIMIT $2
            `,
            values
        );

        const rowsDesc = messagesResult.rows;
        const nextCursor = rowsDesc.length === limit
            ? encodeCursor(rowsDesc[rowsDesc.length - 1])
            : null;

        const items = rowsDesc
            .slice()
            .reverse()
            .map(mapMessage);

        return res.json({ items, nextCursor });
    } catch (error) {
        return next(error);
    }
}

async function sendMessage(req, res, next) {
    try {
        const conversationId = parseConversationId(req.params.id);

        const parsedBody = messageBodySchema.safeParse(req.body || {});
        if (!parsedBody.success) {
            return res.status(400).json({
                error: 'Validation failed',
                details: formatValidationError(parsedBody.error),
            });
        }

        const senderId = String(req.user.id);
        const { body } = parsedBody.data;

        const transactionResult = await withTransaction(async (client) => {
            const memberIds = await requireConversationMembership(conversationId, senderId, client);

            const createdMessageResult = await client.query(
                `
                    INSERT INTO messages (conversation_id, sender_id, body)
                    VALUES ($1, $2, $3)
                    RETURNING id, conversation_id, sender_id, body, created_at
                `,
                [conversationId, senderId, body]
            );

            const createdMessage = createdMessageResult.rows[0];

            await client.query(
                `
                    UPDATE conversations
                    SET last_message_at = $2
                    WHERE id = $1
                `,
                [conversationId, createdMessage.created_at]
            );

            return {
                createdMessage,
                memberIds,
            };
        });

        const responseMessage = mapMessage(transactionResult.createdMessage);
        const io = req.app.locals.io;

        if (io) {
            io.to(`conversation:${conversationId}`).emit('message:new', responseMessage);

            const memberUpdates = await Promise.all(
                transactionResult.memberIds.map(async (memberId) => {
                    const [summary] = await fetchConversationSummariesForUser(memberId, conversationId);
                    return { memberId, summary: summary || null };
                })
            );

            for (const update of memberUpdates) {
                if (update.summary) {
                    io.to(`user:${update.memberId}`).emit('conversation:updated', update.summary);
                }
            }
        }

        return res.status(201).json(responseMessage);
    } catch (error) {
        return next(error);
    }
}

async function markConversationRead(req, res, next) {
    try {
        const conversationId = parseConversationId(req.params.id);
        const requesterId = String(req.user.id);

        await requireConversationMembership(conversationId, requesterId);

        const updatedResult = await query(
            `
                UPDATE conversation_members
                SET last_read_at = NOW()
                WHERE conversation_id = $1
                  AND user_id = $2
                RETURNING last_read_at
            `,
            [conversationId, requesterId]
        );

        const lastReadAt = updatedResult.rows[0]?.last_read_at || new Date().toISOString();
        const io = req.app.locals.io;

        if (io) {
            const [summary] = await fetchConversationSummariesForUser(requesterId, conversationId);
            if (summary) {
                io.to(`user:${requesterId}`).emit('conversation:updated', summary);
            }
        }

        return res.status(200).json({
            conversationId,
            lastReadAt,
        });
    } catch (error) {
        return next(error);
    }
}

module.exports = {
    startDmConversation,
    listConversations,
    getConversationMessages,
    sendMessage,
    markConversationRead,
    requireConversationMembership,
};
