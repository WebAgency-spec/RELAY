
const express = require('express');

module.exports = function createMessagingRouter(db) {
    const router = express.Router();

    function getSessionId(req) {
        const cookies = (req.headers.cookie || '').split(';');

        for (const cookie of cookies) {
            const separator = cookie.indexOf('=');
            if (separator === -1) continue;

            const name = cookie.slice(0, separator).trim();

            if (name === 'relay_session') {
                try {
                    return decodeURIComponent(
                        cookie.slice(separator + 1).trim()
                    );
                } catch {
                    return null;
                }
            }
        }

        return null;
    }

    async function getUser(req) {
        const sessionId = getSessionId(req);

        if (!sessionId || !/^[a-f0-9]{64}$/i.test(sessionId)) {
            return null;
        }

        const result = await db.query(
            `SELECT users.id, users.username, users.display_name, users.email
             FROM sessions
             JOIN users ON users.id = sessions.user_id
             WHERE sessions.id = $1
               AND sessions.expires_at > NOW()`,
            [sessionId]
        );

        return result.rows[0] || null;
    }

    async function requireUser(req, res) {
        const user = await getUser(req);

        if (!user) {
            res.status(401).json({
                error: 'Please sign in to continue.'
            });
            return null;
        }

        return user;
    }

    function handleError(res, error) {
        console.error('Messaging error:', error.message);

        if (!res.headersSent) {
            res.status(500).json({
                error: 'A messaging error occurred.'
            });
        }
    }

    // SEARCH USERS
    router.get('/users', async (req, res) => {
        try {
            const user = await requireUser(req, res);
            if (!user) return;

            const search = String(req.query.search || '').trim();

            if (!search) {
                return res.json([]);
            }

            const result = await db.query(
                `SELECT id, username, display_name, email
                 FROM users
                 WHERE id <> $1
                   AND (
                       display_name ILIKE $2 ESCAPE '\\'
                       OR username ILIKE $2 ESCAPE '\\'
                       OR email ILIKE $2 ESCAPE '\\'
                   )
                 ORDER BY
                   CASE
                       WHEN LOWER(username) = LOWER($3) THEN 0
                       WHEN LOWER(email) = LOWER($3) THEN 1
                       ELSE 2
                   END,
                   display_name ASC
                 LIMIT 20`,
                [
                    user.id,
                    `%${search.replace(/[\\%_]/g, '\\$&')}%`,
                    search
                ]
            );

            return res.json(
                result.rows.map((row) => ({
                    id: row.id,
                    username: row.username,
                    displayName: row.display_name,
                    email: row.email
                }))
            );
        } catch (error) {
            handleError(res, error);
        }
    });

    // GET CONVERSATIONS
    router.get('/conversations', async (req, res) => {
        try {
            const user = await requireUser(req, res);
            if (!user) return;

            const result = await db.query(
                `SELECT
                    c.id,
                    c.title,
                    c.is_group,
                    c.created_at,
                    other_user.display_name AS other_name,
                    other_user.email AS other_email,
                    latest.body AS last_message,
                    latest.created_at AS last_message_at
                 FROM conversations c

                 JOIN conversation_members own_member
                   ON own_member.conversation_id = c.id
                  AND own_member.user_id = $1

                 LEFT JOIN LATERAL (
                     SELECT u.display_name, u.email
                     FROM conversation_members cm
                     JOIN users u ON u.id = cm.user_id
                     WHERE cm.conversation_id = c.id
                       AND cm.user_id <> $1
                     ORDER BY cm.joined_at ASC
                     LIMIT 1
                 ) other_user ON TRUE

                 LEFT JOIN LATERAL (
                     SELECT m.body, m.created_at
                     FROM messages m
                     WHERE m.conversation_id = c.id
                     ORDER BY m.id DESC
                     LIMIT 1
                 ) latest ON TRUE

                 ORDER BY
                    latest.created_at DESC NULLS LAST,
                    c.id DESC`,
                [user.id]
            );

            return res.json(
                result.rows.map((row) => ({
                    id: row.id,
                    title: row.title,
                    isGroup: row.is_group,
                    createdAt: row.created_at,
                    otherName: row.other_name,
                    otherEmail: row.other_email,
                    lastMessage: row.last_message,
                    lastMessageAt: row.last_message_at
                }))
            );
        } catch (error) {
            handleError(res, error);
        }
    });

    // CREATE PRIVATE CONVERSATION
    router.post('/conversations', async (req, res) => {
        const client = await db.connect();

        try {
            const user = await requireUser(req, res);
            if (!user) return;

            const recipientUserId = Number(req.body.recipientUserId);

            if (
                !Number.isSafeInteger(recipientUserId) ||
                recipientUserId <= 0
            ) {
                return res.status(400).json({
                    error: 'Invalid recipient.'
                });
            }

            if (recipientUserId === Number(user.id)) {
                return res.status(400).json({
                    error: 'You cannot start a conversation with yourself.'
                });
            }

            await client.query('BEGIN');

            const recipient = await client.query(
                'SELECT id FROM users WHERE id = $1',
                [recipientUserId]
            );

            if (!recipient.rows.length) {
                await client.query('ROLLBACK');

                return res.status(404).json({
                    error: 'User not found.'
                });
            }

            const existing = await client.query(
                `SELECT c.id
                 FROM conversations c
                 JOIN conversation_members cm1
                   ON cm1.conversation_id = c.id
                  AND cm1.user_id = $1
                 JOIN conversation_members cm2
                   ON cm2.conversation_id = c.id
                  AND cm2.user_id = $2
                 WHERE c.is_group = FALSE
                   AND (
                       SELECT COUNT(*)
                       FROM conversation_members all_members
                       WHERE all_members.conversation_id = c.id
                   ) = 2
                 LIMIT 1`,
                [user.id, recipientUserId]
            );

            if (existing.rows.length) {
                await client.query('COMMIT');

                return res.json({
                    success: true,
                    conversationId: existing.rows[0].id,
                    existing: true
                });
            }

            const conversation = await client.query(
                `INSERT INTO conversations (title, is_group)
                 VALUES (NULL, FALSE)
                 RETURNING id`,
                []
            );

            const conversationId = conversation.rows[0].id;

            await client.query(
                `INSERT INTO conversation_members (conversation_id, user_id)
                 VALUES ($1, $2), ($1, $3)`,
                [conversationId, user.id, recipientUserId]
            );

            await client.query('COMMIT');

            return res.status(201).json({
                success: true,
                conversationId,
                existing: false
            });
        } catch (error) {
            try {
                await client.query('ROLLBACK');
            } catch {}

            handleError(res, error);
        } finally {
            client.release();
        }
    });

    // GET CONVERSATION MESSAGES
    router.get('/conversations/:id/messages', async (req, res) => {
        try {
            const user = await requireUser(req, res);
            if (!user) return;

            const conversationId = Number(req.params.id);

            if (
                !Number.isSafeInteger(conversationId) ||
                conversationId <= 0
            ) {
                return res.status(400).json({
                    error: 'Invalid conversation.'
                });
            }

            const membership = await db.query(
                `SELECT 1
                 FROM conversation_members
                 WHERE conversation_id = $1
                   AND user_id = $2`,
                [conversationId, user.id]
            );

            if (!membership.rows.length) {
                return res.status(403).json({
                    error: 'You do not have access to this conversation.'
                });
            }

            const result = await db.query(
                `SELECT
                    m.id,
                    m.conversation_id,
                    m.sender_id,
                    m.body,
                    m.created_at,
                    m.edited_at,
                    u.display_name AS sender_name
                 FROM (
                     SELECT *
                     FROM messages
                     WHERE conversation_id = $1
                     ORDER BY id DESC
                     LIMIT 100
                 ) m
                 JOIN users u ON u.id = m.sender_id
                 ORDER BY m.id ASC`,
                [conversationId]
            );

            return res.json(
                result.rows.map((row) => ({
                    id: row.id,
                    conversationId: row.conversation_id,
                    senderId: row.sender_id,
                    senderName: row.sender_name,
                    body: row.body,
                    createdAt: row.created_at,
                    editedAt: row.edited_at
                }))
            );
        } catch (error) {
            handleError(res, error);
        }
    });

    return router;
};
