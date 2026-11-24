
const { randomUUID } = require('node:crypto');

// Active calls are held in memory; messages remain in SQLite.
const activeCalls = new Map();
const activeCallByUser = new Map();

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
    socket.join(`user:${userId}`);

    const existingConversations = db.prepare(`
        SELECT conversation_id
        FROM conversation_members
        WHERE user_id = ?
    `).all(userId);

    for (const conversation of existingConversations) {
        socket.join(`conversation:${conversation.conversation_id}`);
    }

    console.log('Authenticated Relay socket:', socket.id, 'User:', userId);

    function acknowledge(callback, result) {
        if (typeof callback === 'function') callback(result);
    }

    function getCallForParticipant(callId) {
        if (typeof callId !== 'string') return null;

        const call = activeCalls.get(callId);

        if (!call) return null;

        if (call.callerId !== userId && call.recipientId !== userId) {
            return null;
        }

        return call;
    }

    function endCall(call, event, reason) {
        if (!call || !activeCalls.has(call.callId)) return;

        activeCalls.delete(call.callId);
        activeCallByUser.delete(call.callerId);
        activeCallByUser.delete(call.recipientId);

        const otherUserId =
            userId === call.callerId ? call.recipientId : call.callerId;

        io.to(`user:${call.callerId}`)
            .to(`user:${call.recipientId}`)
            .emit(event, {
                callId: call.callId,
                conversationId: call.conversationId,
                reason
            });
    }

    // Existing conversation authorization.
    socket.on('chat:join', (payload, callback) => {
        const conversationId = payload?.conversationId;

        if (!Number.isSafeInteger(conversationId) || conversationId < 1) {
            return acknowledge(callback, {
                ok: false,
                error: 'Invalid conversation.'
            });
        }

        const membership = db.prepare(`
            SELECT 1
            FROM conversation_members
            WHERE conversation_id = ? AND user_id = ?
        `).get(conversationId, userId);

        if (!membership) {
            return acknowledge(callback, {
                ok: false,
                error: 'Conversation not found.'
            });
        }

        socket.join(`conversation:${conversationId}`);

        return acknowledge(callback, { ok: true });
    });

    // Existing persistent messaging.
    socket.on('chat:send', (payload, callback) => {
        const conversationId = payload?.conversationId;
        const body = typeof payload?.body === 'string'
            ? payload.body.trim()
            : '';

        if (!Number.isSafeInteger(conversationId) || conversationId < 1) {
            return acknowledge(callback, {
                ok: false,
                error: 'Invalid conversation.'
            });
        }

        if (!body || body.length > 4000) {
            return acknowledge(callback, {
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
            return acknowledge(callback, {
                ok: false,
                error: 'Conversation not found.'
            });
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

            const members = db.prepare(`
                SELECT user_id
                FROM conversation_members
                WHERE conversation_id = ?
            `).all(conversationId);

            for (const member of members) {
                io.to(`user:${member.user_id}`).emit('chat:message', message);
            }

            return acknowledge(callback, { ok: true, message });
        } catch (error) {
            console.error('Message save failed:', error.message);

            return acknowledge(callback, {
                ok: false,
                error: 'Could not save your message.'
            });
        }
    });

    // Start a call in an authorized private conversation.
    socket.on('call:start', (payload, callback) => {
        const conversationId = payload?.conversationId;

        if (!Number.isSafeInteger(conversationId) || conversationId < 1) {
            return acknowledge(callback, {
                ok: false,
                error: 'Invalid conversation.'
            });
        }

        const conversation = db.prepare(`
            SELECT id, is_group AS isGroup
            FROM conversations
            WHERE id = ?
        `).get(conversationId);

        const members = db.prepare(`
            SELECT cm.user_id AS userId, u.display_name AS displayName
            FROM conversation_members cm
            JOIN users u ON u.id = cm.user_id
            WHERE cm.conversation_id = ?
        `).all(conversationId);

        if (
            !conversation ||
            Number(conversation.isGroup) !== 0 ||
            members.length !== 2 ||
            !members.some((member) => member.userId === userId)
        ) {
            return acknowledge(callback, {
                ok: false,
                error: 'Calls are available in authorized private conversations only.'
            });
        }

        const recipient = members.find((member) => member.userId !== userId);

        if (!recipient) {
            return acknowledge(callback, {
                ok: false,
                error: 'Could not find the other participant.'
            });
        }

        if (
            activeCallByUser.has(userId) ||
            activeCallByUser.has(recipient.userId)
        ) {
            return acknowledge(callback, {
                ok: false,
                error: 'One of the participants is already in a call.'
            });
        }

        const caller = db.prepare(`
            SELECT display_name AS displayName
            FROM users
            WHERE id = ?
        `).get(userId);

        const call = {
            callId: randomUUID(),
            conversationId,
            callerId: userId,
            recipientId: recipient.userId,
            status: 'ringing'
        };

        activeCalls.set(call.callId, call);
        activeCallByUser.set(userId, call.callId);
        activeCallByUser.set(recipient.userId, call.callId);

        io.to(`user:${recipient.userId}`).emit('call:incoming', {
            callId: call.callId,
            conversationId,
            callerId: userId,
            callerName: caller?.displayName || 'Relay user'
        });

        return acknowledge(callback, {
            ok: true,
            callId: call.callId,
            recipientName: recipient.displayName || 'Relay user'
        });
    });

    // Recipient accepts the incoming call.
    socket.on('call:accept', (payload, callback) => {
        const call = getCallForParticipant(payload?.callId);

        if (!call || call.recipientId !== userId || call.status !== 'ringing') {
            return acknowledge(callback, {
                ok: false,
                error: 'This call is no longer available.'
            });
        }

        call.status = 'accepted';

        io.to(`user:${call.callerId}`).emit('call:accepted', {
            callId: call.callId,
            conversationId: call.conversationId,
            peerId: userId
        });

        return acknowledge(callback, { ok: true });
    });

    socket.on('call:reject', (payload, callback) => {
        const call = getCallForParticipant(payload?.callId);

        if (!call || call.recipientId !== userId || call.status !== 'ringing') {
            return acknowledge(callback, {
                ok: false,
                error: 'This call is no longer available.'
            });
        }

        endCall(call, 'call:rejected', 'rejected');

        return acknowledge(callback, { ok: true });
    });

    // Relay WebRTC offer, answer and ICE candidates only between call participants.
    for (const event of ['call:offer', 'call:answer', 'call:ice']) {
        socket.on(event, (payload, callback) => {
            const call = getCallForParticipant(payload?.callId);

            if (!call || call.status !== 'accepted') {
                return acknowledge(callback, {
                    ok: false,
                    error: 'No accepted call exists.'
                });
            }

            const otherUserId = userId === call.callerId
                ? call.recipientId
                : call.callerId;

            const field = event === 'call:ice' ? 'candidate' : 'description';
            const value = payload?.[field];

            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                return acknowledge(callback, {
                    ok: false,
                    error: 'Invalid call signaling data.'
                });
            }

            io.to(`user:${otherUserId}`).emit(event, {
                callId: call.callId,
                [field]: value
            });

            return acknowledge(callback, { ok: true });
        });
    }

    socket.on('call:end', (payload, callback) => {
        const call = getCallForParticipant(payload?.callId);

        if (!call) {
            return acknowledge(callback, {
                ok: false,
                error: 'Call not found.'
            });
        }

        endCall(call, 'call:ended', 'ended');

        return acknowledge(callback, { ok: true });
    });

    socket.on('disconnect', () => {
        console.log('Relay socket disconnected:', socket.id);

        // Preserve a call if this user still has another connected Relay tab.
        const room = io.sockets.adapter.rooms.get(`user:${userId}`);

        if (room?.size) return;

        const callId = activeCallByUser.get(userId);
        const call = callId ? activeCalls.get(callId) : null;

        if (call) {
            endCall(call, 'call:ended', 'disconnected');
        }
    });
};
