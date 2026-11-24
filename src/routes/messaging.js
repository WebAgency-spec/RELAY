
const express = require('express');

module.exports = function createMessagingRouter(db) {
    const router = express.Router();

    function getUser(req) {
        const cookieHeader = req.headers.cookie || '';
        const cookie = cookieHeader
            .split(';')
            .map((part) => part.trim())
            .find((part) => part.startsWith('relay_session='));

        if (!cookie) return null;

        const sessionId = cookie.slice('relay_session='.length);

        if (!/^[a-f0-9]{64}$/.test(sessionId)) return null;

        const session = db.prepare(`
            SELECT user_id
            FROM sessions
            WHERE id = ? AND expires_at > ?
        `).get(sessionId, new Date().toISOString());

        if (!session) return null;

        return db.prepare(`
            SELECT id, username, display_name, email
            FROM users
            WHERE id = ?
        `).get(session.user_id) || null;
    }

    function requireUser(req, res) {
        const user = getUser(req);

        if (!user) {
            res.status(401).json({
                error: 'Please sign in to Relay again.'
            });
            return null;
        }

        return user;
    }

    // Find other Relay users by name, username, or email.
    router.get('/users', (req, res) => {
        const me = requireUser(req, res);
        if (!me) return;

        const search = String(req.query.search || '').trim();

        if (search.length < 2) {
            return res.json({ users: [] });
        }

        const term = `%${search.replace(/[\\%_]/g, '\\$&')}%`;

        const users = db.prepare(`
            SELECT id, display_name AS displayName, email
            FROM users
            WHERE id != ?
              AND (
                  display_name LIKE ? ESCAPE '\\'
                  OR username LIKE ? ESCAPE '\\'
                  OR email LIKE ? ESCAPE '\\'
              )
            ORDER BY display_name COLLATE NOCASE
            LIMIT 20
        `).all(me.id, term, term, term);

        return res.json({ users });
    });

    // List the signed-in user's conversations.
    router.get('/conversations', (req, res) => {
        const me = requireUser(req, res);
        if (!me) return;

        const conversations = db.prepare(`
            SELECT
                c.id,
                c.title,
                c.is_group AS isGroup,
                c.created_at AS createdAt,
                (
                    SELECT u.display_name
                    FROM conversation_members cm
                    JOIN users u ON u.id = cm.user_id
                    WHERE cm.conversation_id = c.id
                      AND cm.user_id != ?
                    LIMIT 1
                ) AS otherName,
                (
                    SELECT u.email
                    FROM conversation_members cm
                    JOIN users u ON u.id = cm.user_id
                    WHERE cm.conversation_id = c.id
                      AND cm.user_id != ?
                    LIMIT 1
                ) AS otherEmail,
                (
                    SELECT m.body
                    FROM messages m
                    WHERE m.conversation_id = c.id
                    ORDER BY m.id DESC
                    LIMIT 1
                ) AS lastMessage,
                (
                    SELECT m.created_at
                    FROM messages m
                    WHERE m.conversation_id = c.id
                    ORDER BY m.id DESC
                    LIMIT 1
                ) AS lastMessageAt
            FROM conversations c
            JOIN conversation_members mine
              ON mine.conversation_id = c.id
            WHERE mine.user_id = ?
            ORDER BY COALESCE(
                (
                    SELECT MAX(m.id)
                    FROM messages m
                    WHERE m.conversation_id = c.id
                ),
                0
            ) DESC, c.id DESC
        `).all(me.id, me.id, me.id);

        return res.json({ conversations });
    });

    // Create or reuse a private conversation with another user.
    router.post('/conversations', (req, res) => {
        const me = requireUser(req, res);
        if (!me) return;

        const recipientId = req.body?.recipientUserId;

        if (
            !Number.isSafeInteger(recipientId) ||
            recipientId < 1 ||
            recipientId === me.id
        ) {
            return res.status(400).json({
                error: 'Choose a valid user to message.'
            });
        }

        const recipient = db.prepare(`
            SELECT id
            FROM users
            WHERE id = ?
        `).get(recipientId);

        if (!recipient) {
            return res.status(404).json({
                error: 'That Relay user does not exist.'
            });
        }

        const existing = db.prepare(`
            SELECT c.id
            FROM conversations c
            WHERE c.is_group = 0
              AND EXISTS (
                  SELECT 1 FROM conversation_members
                  WHERE conversation_id = c.id AND user_id = ?
              )
              AND EXISTS (
                  SELECT 1 FROM conversation_members
                  WHERE conversation_id = c.id AND user_id = ?
              )
              AND (
                  SELECT COUNT(*)
                  FROM conversation_members
                  WHERE conversation_id = c.id
              ) = 2
            LIMIT 1
        `).get(me.id, recipientId);

        if (existing) {
            return res.json({
                conversationId: existing.id,
                existing: true
            });
        }

        try {
            db.exec('BEGIN');

            const result = db.prepare(`
                INSERT INTO conversations (title, is_group)
                VALUES (NULL, 0)
            `).run();

            const conversationId = Number(result.lastInsertRowid);

            const addMember = db.prepare(`
                INSERT INTO conversation_members
                    (conversation_id, user_id)
                VALUES (?, ?)
            `);

            addMember.run(conversationId, me.id);
            addMember.run(conversationId, recipientId);

            db.exec('COMMIT');

            return res.status(201).json({
                conversationId,
                existing: false
            });
        } catch (error) {
            try {
                db.exec('ROLLBACK');
            } catch {}

            console.error('Create conversation failed:', error.message);

            return res.status(500).json({
                error: 'Could not create the conversation.'
            });
        }
    });

    // Load recent messages, only if the user belongs to this conversation.
    router.get('/conversations/:id/messages', (req, res) => {
        const me = requireUser(req, res);
        if (!me) return;

        const conversationId = Number(req.params.id);

        if (!Number.isSafeInteger(conversationId) || conversationId < 1) {
            return res.status(400).json({
                error: 'Invalid conversation.'
            });
        }

        const membership = db.prepare(`
            SELECT 1
            FROM conversation_members
            WHERE conversation_id = ? AND user_id = ?
        `).get(conversationId, me.id);

        if (!membership) {
            return res.status(404).json({
                error: 'Conversation not found.'
            });
        }

        const messages = db.prepare(`
            SELECT *
            FROM (
                SELECT
                    m.id,
                    m.conversation_id AS conversationId,
                    m.sender_id AS senderId,
                    u.display_name AS senderName,
                    m.body,
                    m.created_at AS createdAt,
                    m.edited_at AS editedAt
                FROM messages m
                JOIN users u ON u.id = m.sender_id
                WHERE m.conversation_id = ?
                ORDER BY m.id DESC
                LIMIT 100
            )
            ORDER BY id ASC
        `).all(conversationId);

        return res.json({ messages });
    });

    return router;
};
