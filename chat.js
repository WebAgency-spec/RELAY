
module.exports = function registerChatHandlers(io, db, socket) {
    function getUserId() {
        const cookieHeader = socket.handshake.headers.cookie || '';

        const sessionCookie = cookieHeader
            .split(';')
            .map((part) => part.trim())
            .find((part) => part.startsWith('relay_session='));

        if (!sessionCookie) return null;

        const sessionId = sessionCookie.slice('relay_session='.length);

        if (!/^[a-f0-9]{64}$/.test(sessionId)) return null;

        const session = db.prepare(`
            SELECT user_id
            FROM sessions
            WHERE id = ? AND expires_at > ?
        `).get(sessionId, new Date().toISOString());

        return session?.user_id ?? null;
    }

    const userId = getUserId();

    if (!userId) {
        socket.disconnect(true);
        return;
    }

    socket.data.userId = userId;

    // Every signed-in user's tabs join their own private room.
    socket.join(`user:${userId}`);

    // Also join all existing conversation rooms for this user.
    const existingConversations = db.prepare(`
        SELECT conversation_id
        FROM conversation_members
        WHERE user_id = ?
    `).all(userId);

    for (const conversation of existingConversations) {
        socket.join(`conversation:${conversation.conversation_id}`);
    }

    console.log('Authenticated Relay socket:', socket.id, 'User:', userId);

    socket.on('chat:join', (payload, acknowledge) => {
        const reply = typeof acknowledge === 'function'
            ? acknowledge
            : () => {};

        const conversationId = payload?.conversationId;

        if (!Number.isSafeInteger(conversationId) || conversationId < 1) {
            return reply({ ok: false, error: 'Invalid conversation.' });
        }

        const membership = db.prepare(`
            SELECT 1
            FROM conversation_members
            WHERE conversation_id = ? AND user_id = ?
        `).get(conversationId, userId);

        if (!membership) {
            return reply({ ok: false, error: 'Conversation not found.' });
        }

        socket.join(`conversation:${conversationId}`);
        return reply({ ok: true });
    });

    socket.on('chat:send', (payload, acknowledge) => {
        const reply = typeof acknowledge === 'function'
            ? acknowledge
            : () => {};

        const conversationId = payload?.conversationId;
        const body = typeof payload?.body === 'string'
            ? payload.body.trim()
            : '';

        if (!Number.isSafeInteger(conversationId) || conversationId < 1) {
            return reply({ ok: false, error: 'Invalid conversation.' });
        }

        if (!body || body.length > 4000) {
            return reply({
                ok: false,
                error: 'Messages must contain 1–4000 characters.'
            });
        }

        const membership = db.prepare(`
            SELECT 1
            FROM conversation_members
            WHERE conversation_id = ? AND user_id = ?
        `).get(conversationId, userId);

        if (!membership) {
            return reply({ ok: false, error: 'Conversation not found.' });
        }

        try {
            const result = db.prepare(`
                INSERT INTO messages (conversation_id, sender_id, body)
                VALUES (?, ?, ?)
            `).run(conversationId, userId, body);

            const message = db.prepare(`
                SELECT
                    m.id,
                    m.conversation_id AS conversationId,
                    m.sender_id AS senderId,
                    u.display_name AS senderName,
                    m.body,
                    m.created_at AS createdAt
                FROM messages m
                JOIN users u ON u.id = m.sender_id
                WHERE m.id = ?
            `).get(Number(result.lastInsertRowid));

            // Deliver to every conversation member, even if their chat
            // isn't currently open. All their signed-in tabs receive it.
            const members = db.prepare(`
                SELECT user_id
                FROM conversation_members
                WHERE conversation_id = ?
            `).all(conversationId);

            for (const member of members) {
                io.to(`user:${member.user_id}`).emit('chat:message', message);
            }

            return reply({ ok: true, message });
        } catch (error) {
            console.error('Message save failed:', error.message);
            return reply({
                ok: false,
                error: 'Could not save your message.'
            });
        }
    });

    socket.on('disconnect', () => {
        console.log('Relay socket disconnected:', socket.id);
    });
};
