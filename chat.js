
const { randomUUID } = require('node:crypto');

const activeCalls = new Map();
const activeCallByUser = new Map();

module.exports = function registerChatHandlers(io, db, socket) {
    async function initializeSocket() {
        try {
            const cookieHeader = socket.handshake.headers.cookie || '';

            const sessionCookie = cookieHeader
                .split(';')
                .map((part) => part.trim())
                .find((part) => part.startsWith('relay_session='));

            if (!sessionCookie) {
                socket.disconnect(true);
                return;
            }

            const sessionId = sessionCookie.slice('relay_session='.length);

            if (!/^[a-f0-9]{64}$/i.test(sessionId)) {
                socket.disconnect(true);
                return;
            }

            const sessionResult = await db.query(`
                SELECT user_id
                FROM sessions
                WHERE id = $1 AND expires_at > NOW()
            `, [sessionId]);

            if (!sessionResult.rows.length) {
                socket.disconnect(true);
                return;
            }

            const userId = Number(sessionResult.rows[0].user_id);

            socket.data.userId = userId;
            socket.join(`user:${userId}`);

            const existingConversations = await db.query(`
                SELECT conversation_id
                FROM conversation_members
                WHERE user_id = $1
            `, [userId]);

            for (const conversation of existingConversations.rows) {
                socket.join(`conversation:${conversation.conversation_id}`);
            }

            console.log(
                'Authenticated Relay socket:',
                socket.id,
                'User:',
                userId
            );

            function acknowledge(callback, result) {
                if (typeof callback === 'function') {
                    callback(result);
                }
            }

            function getCallForParticipant(callId) {
                if (typeof callId !== 'string') return null;

                const call = activeCalls.get(callId);

                if (!call) return null;

                if (
                    call.callerId !== userId &&
                    call.recipientId !== userId
                ) {
                    return null;
                }

                return call;
            }

            function endCall(call, event, reason) {
                if (!call || !activeCalls.has(call.callId)) return;

                activeCalls.delete(call.callId);
                activeCallByUser.delete(call.callerId);
                activeCallByUser.delete(call.recipientId);

                io.to(`user:${call.callerId}`)
                    .to(`user:${call.recipientId}`)
                    .emit(event, {
                        callId: call.callId,
                        conversationId: call.conversationId,
                        reason
                    });
            }

            // JOIN CONVERSATION
            socket.on('chat:join', async (payload, callback) => {
                try {
                    const conversationId = Number(payload?.conversationId);

                    if (
                        !Number.isSafeInteger(conversationId) ||
                        conversationId < 1
                    ) {
                        return acknowledge(callback, {
                            ok: false,
                            error: 'Invalid conversation.'
                        });
                    }

                    const membership = await db.query(`
                        SELECT 1
                        FROM conversation_members
                        WHERE conversation_id = $1
                          AND user_id = $2
                    `, [conversationId, userId]);

                    if (!membership.rows.length) {
                        return acknowledge(callback, {
                            ok: false,
                            error: 'Conversation not found.'
                        });
                    }

                    socket.join(`conversation:${conversationId}`);

                    return acknowledge(callback, { ok: true });
                } catch (error) {
                    console.error('Chat join failed:', error.message);

                    return acknowledge(callback, {
                        ok: false,
                        error: 'Could not join conversation.'
                    });
                }
            });

            // SEND MESSAGE
            socket.on('chat:send', async (payload, callback) => {
                try {
                    const conversationId = Number(payload?.conversationId);

                    const body = typeof payload?.body === 'string'
                        ? payload.body.trim()
                        : '';

                    if (
                        !Number.isSafeInteger(conversationId) ||
                        conversationId < 1
                    ) {
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

                    const membership = await db.query(`
                        SELECT 1
                        FROM conversation_members
                        WHERE conversation_id = $1
                          AND user_id = $2
                    `, [conversationId, userId]);

                    if (!membership.rows.length) {
                        return acknowledge(callback, {
                            ok: false,
                            error: 'Conversation not found.'
                        });
                    }

                    const result = await db.query(`
                        INSERT INTO messages (
                            conversation_id,
                            sender_id,
                            body
                        )
                        VALUES ($1, $2, $3)
                        RETURNING id, conversation_id, sender_id, body, created_at
                    `, [conversationId, userId, body]);

                    const savedMessage = result.rows[0];

                    const userResult = await db.query(`
                        SELECT display_name
                        FROM users
                        WHERE id = $1
                    `, [userId]);

                    const message = {
                        id: savedMessage.id,
                        conversationId: savedMessage.conversation_id,
                        senderId: savedMessage.sender_id,
                        senderName: userResult.rows[0]?.display_name || 'Relay user',
                        body: savedMessage.body,
                        createdAt: savedMessage.created_at
                    };

                    const members = await db.query(`
                        SELECT user_id
                        FROM conversation_members
                        WHERE conversation_id = $1
                    `, [conversationId]);

                    for (const member of members.rows) {
                        io.to(`user:${member.user_id}`)
                            .emit('chat:message', message);
                    }

                    return acknowledge(callback, {
                        ok: true,
                        message
                    });
                } catch (error) {
                    console.error('Message save failed:', error.message);

                    return acknowledge(callback, {
                        ok: false,
                        error: 'Could not save your message.'
                    });
                }
            });

            // START CALL
            socket.on('call:start', async (payload, callback) => {
                try {
                    const conversationId = Number(payload?.conversationId);

                    if (
                        !Number.isSafeInteger(conversationId) ||
                        conversationId < 1
                    ) {
                        return acknowledge(callback, {
                            ok: false,
                            error: 'Invalid conversation.'
                        });
                    }

                    const conversationResult = await db.query(`
                        SELECT id, is_group
                        FROM conversations
                        WHERE id = $1
                    `, [conversationId]);

                    const membersResult = await db.query(`
                        SELECT
                            cm.user_id AS user_id,
                            u.display_name AS display_name
                        FROM conversation_members cm
                        JOIN users u ON u.id = cm.user_id
                        WHERE cm.conversation_id = $1
                    `, [conversationId]);

                    const conversation = conversationResult.rows[0];
                    const members = membersResult.rows;

                    if (
                        !conversation ||
                        conversation.is_group ||
                        members.length !== 2 ||
                        !members.some((member) => Number(member.user_id) === userId)
                    ) {
                        return acknowledge(callback, {
                            ok: false,
                            error: 'Calls are available in authorized private conversations only.'
                        });
                    }

                    const recipient = members.find(
                        (member) => Number(member.user_id) !== userId
                    );

                    if (!recipient) {
                        return acknowledge(callback, {
                            ok: false,
                            error: 'Could not find the other participant.'
                        });
                    }

                    const recipientId = Number(recipient.user_id);

                    if (
                        activeCallByUser.has(userId) ||
                        activeCallByUser.has(recipientId)
                    ) {
                        return acknowledge(callback, {
                            ok: false,
                            error: 'One of the participants is already in a call.'
                        });
                    }

                    const callerResult = await db.query(`
                        SELECT display_name
                        FROM users
                        WHERE id = $1
                    `, [userId]);

                    const call = {
                        callId: randomUUID(),
                        conversationId,
                        callerId: userId,
                        recipientId,
                        status: 'ringing'
                    };

                    activeCalls.set(call.callId, call);
                    activeCallByUser.set(userId, call.callId);
                    activeCallByUser.set(recipientId, call.callId);

                    io.to(`user:${recipientId}`).emit('call:incoming', {
                        callId: call.callId,
                        conversationId,
                        callerId: userId,
                        callerName: callerResult.rows[0]?.display_name || 'Relay user'
                    });

                    return acknowledge(callback, {
                        ok: true,
                        callId: call.callId,
                        recipientName: recipient.display_name || 'Relay user'
                    });
                } catch (error) {
                    console.error('Call start failed:', error.message);

                    return acknowledge(callback, {
                        ok: false,
                        error: 'Could not start the call.'
                    });
                }
            });

            // ACCEPT CALL
            socket.on('call:accept', (payload, callback) => {
                const call = getCallForParticipant(payload?.callId);

                if (
                    !call ||
                    call.recipientId !== userId ||
                    call.status !== 'ringing'
                ) {
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

            // REJECT CALL
            socket.on('call:reject', (payload, callback) => {
                const call = getCallForParticipant(payload?.callId);

                if (
                    !call ||
                    call.recipientId !== userId ||
                    call.status !== 'ringing'
                ) {
                    return acknowledge(callback, {
                        ok: false,
                        error: 'This call is no longer available.'
                    });
                }

                endCall(call, 'call:rejected', 'rejected');

                return acknowledge(callback, { ok: true });
            });

            // WEBRTC SIGNALING
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

                    const field = event === 'call:ice'
                        ? 'candidate'
                        : 'description';

                    const value = payload?.[field];

                    if (
                        !value ||
                        typeof value !== 'object' ||
                        Array.isArray(value)
                    ) {
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

            // END CALL
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

            // DISCONNECT
            socket.on('disconnect', () => {
                console.log('Relay socket disconnected:', socket.id);

                const room = io.sockets.adapter.rooms.get(`user:${userId}`);

                if (room?.size) return;

                const callId = activeCallByUser.get(userId);
                const call = callId ? activeCalls.get(callId) : null;

                if (call) {
                    endCall(call, 'call:ended', 'disconnected');
                }
            });

        } catch (error) {
            console.error('Socket initialization failed:', error.message);
            socket.disconnect(true);
        }
    }

    initializeSocket();
};
