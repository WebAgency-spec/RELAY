
const GOOGLE_CLIENT_ID =
    '562380402936-m266d1cfohine2ncra34oo8kjaqn7mvq.apps.googleusercontent.com';

const $ = (selector) => document.querySelector(selector);

const loginScreen = $('#login-screen');
const appScreen = $('#app-screen');
const loginStatus = $('#login-status');
const googleButton = $('#google-signin');
const signOutButton = $('#sign-out');
const searchInput = $('#search');
const conversationList = $('#conversation-list');
const newChatButton = $('#new-chat');
const chatPanel = $('.chat-panel');

let currentUser = null;
let conversations = [];
let activeConversationId = null;
let socket = null;
let signingIn = false;
let chatRequest = 0;

// Voice-call state
let currentCall = null;
let localStream = null;
let peerConnection = null;
let remoteAudio = null;
let callOverlay = null;
let pendingIceCandidates = [];
let callActionInProgress = false;

const originalWelcome = chatPanel.innerHTML;

const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

function setLoginStatus(message, type = '') {
    if (!loginStatus) return;
    loginStatus.textContent = message;
    loginStatus.className = `login-status ${type}`.trim();
}

function showLogin() {
    appScreen.hidden = true;
    loginScreen.hidden = false;
    initializeGoogleSignIn();
}

function api(url, options = {}) {
    return fetch(url, {
        credentials: 'same-origin',
        ...options,
        headers: {
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...options.headers
        }
    }).then(async (response) => {
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || `Request failed (${response.status}).`);
        }

        return data;
    });
}

function initializeGoogleSignIn() {
    if (!googleButton || !window.google?.accounts?.id) {
        setLoginStatus('Google sign-in is loading. Refresh in a moment.', 'error');
        return;
    }

    google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: handleGoogleCredential
    });

    googleButton.replaceChildren();

    google.accounts.id.renderButton(googleButton, {
        type: 'standard',
        theme: 'filled_black',
        size: 'large',
        shape: 'pill',
        text: 'signin_with',
        width: 300
    });
}

async function handleGoogleCredential(response) {
    if (signingIn || !response?.credential) return;

    signingIn = true;
    setLoginStatus('Connecting securely to Relay...');

    try {
        const data = await api('/api/auth/google', {
            method: 'POST',
            body: JSON.stringify({ credential: response.credential })
        });

        if (!data.user) throw new Error('Sign-in response was invalid.');

        await showApp(data.user);
    } catch (error) {
        setLoginStatus(error.message, 'error');
    } finally {
        signingIn = false;
    }
}

function addChatStyles() {
    if ($('#relay-chat-styles')) return;

    const style = document.createElement('style');
    style.id = 'relay-chat-styles';
    style.textContent = `
        .relay-chat {
            display:flex; flex-direction:column; height:100%;
            min-height:0; width:100%;
        }
        .relay-chat-header {
            display:flex; align-items:center; gap:12px;
            padding:18px 22px; border-bottom:1px solid var(--border);
            background:var(--panel);
        }
        .relay-chat-avatar {
            display:grid; place-items:center; flex-shrink:0;
            width:42px; height:42px; border-radius:14px;
            background:#ff71381c; color:var(--accent); font-weight:700;
        }
        .relay-chat-heading { min-width:0; flex:1; }
        .relay-chat-heading h2 { margin:0; font-size:16px; }
        .relay-chat-heading p {
            margin:5px 0 0; color:var(--muted); font-size:12px;
        }
        .relay-messages {
            flex:1; min-height:0; overflow-y:auto; padding:22px;
            display:flex; flex-direction:column; gap:12px;
        }
        .relay-message {
            max-width:min(76%,520px); align-self:flex-start;
            padding:11px 14px; border:1px solid var(--border);
            border-radius:14px 14px 14px 4px;
            background:var(--panel-soft);
            overflow-wrap:anywhere; white-space:pre-wrap;
        }
        .relay-message.mine {
            align-self:flex-end; background:#ff71381c;
            border-color:#ff71384d;
            border-radius:14px 14px 4px 14px;
        }
        .relay-message-meta {
            display:flex; gap:10px; margin-top:6px;
            color:var(--muted); font-size:10px;
        }
        .relay-composer {
            display:flex; gap:10px; padding:16px;
            border-top:1px solid var(--border);
        }
        .relay-composer textarea {
            flex:1; min-width:0; resize:none; min-height:44px;
            max-height:120px; padding:12px;
            border:1px solid var(--border); border-radius:12px;
            background:var(--panel-soft); color:var(--text);
            font:inherit; outline:none;
        }
        .relay-composer textarea:focus { border-color:var(--accent); }
        .relay-send {
            border:0; border-radius:12px; padding:0 20px;
            background:var(--accent); color:#17100c;
            font-weight:700; cursor:pointer;
        }
        .relay-send:disabled { opacity:.5; cursor:default; }
        .relay-notice {
            margin:auto; padding:24px; text-align:center;
            color:var(--muted);
        }
        .relay-conversation-copy {
            display:flex; flex-direction:column; gap:5px;
            min-width:0; text-align:left;
        }
        .relay-conversation-copy strong,
        .relay-conversation-copy span {
            overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
        }
        .relay-conversation-copy span {
            font-size:12px; color:var(--muted);
        }
        .conversation-item.active { border-color:var(--accent); }

        .relay-call-button {
            display:grid; place-items:center; flex-shrink:0;
            width:42px; height:42px; border:1px solid var(--border);
            border-radius:13px; background:var(--panel-soft);
            color:var(--accent); font-size:21px; cursor:pointer;
            transition:background .2s, transform .2s;
        }
        .relay-call-button:hover {
            background:#ff71381c; transform:translateY(-1px);
        }
        .relay-call-button:disabled { opacity:.45; cursor:not-allowed; }

        .relay-call-overlay {
            position:fixed; inset:0; z-index:99999;
            display:grid; place-items:center; padding:20px;
            background:rgba(8,9,13,.82);
            backdrop-filter:blur(16px);
        }
        .relay-call-card {
            width:min(100%,360px); padding:32px 24px;
            text-align:center; color:var(--text);
            background:var(--panel);
            border:1px solid var(--border); border-radius:26px;
            box-shadow:0 24px 90px rgba(0,0,0,.5);
        }
        .relay-call-orb {
            display:grid; place-items:center;
            width:94px; height:94px; margin:0 auto 22px;
            border-radius:30px; background:#ff71381c;
            border:1px solid #ff71384d;
            color:var(--accent); font-size:36px; font-weight:700;
            box-shadow:0 0 45px #ff713814;
        }
        .relay-call-title {
            margin:0; font-size:22px; overflow-wrap:anywhere;
        }
        .relay-call-status {
            margin:10px 0 25px; color:var(--muted);
            font-size:13px; line-height:1.6; overflow-wrap:anywhere;
        }
        .relay-call-actions {
            display:flex; align-items:center;
            justify-content:center; gap:14px; flex-wrap:wrap;
        }
        .relay-call-action {
            min-width:76px; min-height:48px; padding:12px 17px;
            border:1px solid var(--border); border-radius:15px;
            background:var(--panel-soft); color:var(--text);
            font:inherit; font-size:13px; font-weight:700;
            cursor:pointer;
        }
        .relay-call-action.accept {
            background:#238b58; color:white; border-color:#238b58;
        }
        .relay-call-action.end {
            background:#dc424b; color:white; border-color:#dc424b;
        }
        .relay-call-action:disabled { opacity:.5; cursor:wait; }
        .relay-call-error {
            margin:0 0 18px; color:#ff8b8b;
            font-size:12px; line-height:1.5;
        }
        .relay-call-overlay[hidden] { display:none; }

        @media(max-width:600px) {
            .relay-chat-header { padding:14px; }
            .relay-messages { padding:14px; }
            .relay-message { max-width:90%; }
            .relay-composer { padding:10px; }
            .relay-call-card { padding:28px 20px; }
        }
    `;
    document.head.appendChild(style);
}

async function showApp(user) {
    currentUser = user;
    loginScreen.hidden = true;
    appScreen.hidden = false;

    addChatStyles();
    connectSocket();
    await loadConversations();
}

function connectSocket() {
    if (socket) socket.disconnect();

    if (typeof io !== 'function') {
        console.error('Socket.IO client failed to load.');
        return;
    }

    socket = io();

    socket.on('connect', () => {
        if (activeConversationId !== null) {
            joinConversation(activeConversationId);
        }
    });

    socket.on('connect_error', (error) => {
        console.error('Relay connection error:', error.message);
    });

    socket.on('chat:message', (message) => {
        if (Number(message.conversationId) === Number(activeConversationId)) {
            appendMessage(message);
        }
        loadConversations().catch(console.error);
    });

    // Incoming voice-call invitation
    socket.on('call:incoming', (payload) => {
        if (!payload?.callId || currentCall) {
            if (payload?.callId) {
                socket.emit('call:reject', {
                    callId: payload.callId
                });
            }
            return;
        }

        currentCall = {
            callId: payload.callId,
            conversationId: Number(payload.conversationId),
            role: 'recipient',
            peerName: payload.callerName || payload.fromName || 'Relay contact',
            status: 'ringing'
        };

        showCallScreen('incoming');
    });

    socket.on('call:accepted', async (payload) => {
        if (!currentCall ||
            currentCall.callId !== payload?.callId ||
            currentCall.role !== 'caller') return;

        currentCall.status = 'connecting';
        updateCallScreen('Connecting securely…');

        try {
            await createPeerConnection();
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);

            socket.emit('call:offer', {
                callId: currentCall.callId,
                description: peerConnection.localDescription.toJSON()
            });
        } catch (error) {
            console.error('Could not create call offer:', error);
            showCallError(error.message || 'Could not start the voice connection.');
            await endVoiceCall();
        }
    });

    socket.on('call:offer', async (payload) => {
        if (!currentCall ||
            currentCall.callId !== payload?.callId ||
            currentCall.role !== 'recipient') return;

        try {
            await ensurePeerConnection();
            await peerConnection.setRemoteDescription(
                new RTCSessionDescription(payload.description)
            );
            await flushIceCandidates();

            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);

            socket.emit('call:answer', {
                callId: currentCall.callId,
                description: peerConnection.localDescription.toJSON()
            });

            currentCall.status = 'connecting';
            updateCallScreen('Connecting audio…');
        } catch (error) {
            console.error('Could not answer call:', error);
            showCallError(error.message || 'Could not answer the voice call.');
            await endVoiceCall();
        }
    });

    socket.on('call:answer', async (payload) => {
        if (!currentCall ||
            currentCall.callId !== payload?.callId ||
            currentCall.role !== 'caller') return;

        try {
            await peerConnection.setRemoteDescription(
                new RTCSessionDescription(payload.description)
            );
            await flushIceCandidates();
        } catch (error) {
            console.error('Could not apply call answer:', error);
            showCallError('Could not establish the audio connection.');
        }
    });

    socket.on('call:ice', async (payload) => {
        if (!currentCall ||
            currentCall.callId !== payload?.callId ||
            !payload.candidate) return;

        try {
            const candidate = new RTCIceCandidate(payload.candidate);

            if (peerConnection?.remoteDescription) {
                await peerConnection.addIceCandidate(candidate);
            } else {
                pendingIceCandidates.push(candidate);
            }
        } catch (error) {
            console.warn('Could not apply ICE candidate:', error);
        }
    });

    socket.on('call:rejected', (payload) => {
        if (!currentCall ||
            currentCall.callId !== payload?.callId) return;

        const message = payload.message || 'The call was declined.';
        cleanupCall();
        alert(message);
    });

    socket.on('call:ended', (payload) => {
        if (!currentCall ||
            currentCall.callId !== payload?.callId) return;

        const reason = payload.reason;
        cleanupCall();

        if (reason === 'disconnected') {
            alert('The other person disconnected. The call has ended.');
        }
    });
}

async function loadConversations() {
    try {
        const data = await api('/api/conversations');
        conversations = data.conversations || [];
        renderConversations(searchInput?.value || '');

        if (activeConversationId !== null) {
            const exists = conversations.some(
                (item) => Number(item.id) === Number(activeConversationId)
            );
            if (!exists) showWelcome();
        }
    } catch (error) {
        console.error('Could not load conversations:', error);
        if (conversationList) {
            conversationList.textContent =
                'Could not load conversations. Refresh to retry.';
        }
    }
}

function renderConversations(filter = '') {
    if (!conversationList) return;

    const query = filter.trim().toLowerCase();
    const filtered = conversations.filter((item) =>
        `${item.title || ''} ${item.otherName || ''} ${item.lastMessage || ''}`
            .toLowerCase().includes(query)
    );

    conversationList.replaceChildren();

    if (!filtered.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';

        const icon = document.createElement('div');
        icon.className = 'empty-icon';
        icon.textContent = query ? '⌕' : '✳';

        const heading = document.createElement('h3');
        heading.textContent = query
            ? 'No matching conversations.'
            : 'Your space, your people.';

        const description = document.createElement('p');
        description.textContent = query
            ? 'Try another search.'
            : 'Start a conversation with someone on Relay.';

        empty.append(icon, heading, description);
        conversationList.append(empty);
        return;
    }

    filtered.forEach((conversation) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'conversation-item';

        if (Number(conversation.id) === Number(activeConversationId)) {
            item.classList.add('active');
        }

        const copy = document.createElement('span');
        copy.className = 'relay-conversation-copy';

        const name = document.createElement('strong');
        name.textContent =
            conversation.title || conversation.otherName || 'Conversation';

        const preview = document.createElement('span');
        preview.textContent =
            conversation.lastMessage ||
            conversation.otherEmail ||
            'Start chatting';

        copy.append(name, preview);
        item.append(copy);
        item.addEventListener('click', () => openConversation(conversation));
        conversationList.append(item);
    });
}

function showWelcome() {
    activeConversationId = null;
    chatPanel.innerHTML = originalWelcome;
    renderConversations(searchInput?.value || '');

    $('#start-chat')?.addEventListener('click', createConversation);
}

function joinConversation(id) {
    if (!socket?.connected) return;

    socket.emit('chat:join', { conversationId: Number(id) }, (result) => {
        if (!result?.ok) {
            console.error('Could not join conversation:', result?.error);
        }
    });
}

function formatTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';

    return date.toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit'
    });
}

function appendMessage(message) {
    const list = $('#relay-messages');
    if (!list) return;

    list.querySelector('.relay-notice')?.remove();

    if (list.querySelector(`[data-message-id="${Number(message.id)}"]`)) {
        return;
    }

    const bubble = document.createElement('div');
    bubble.className = 'relay-message';
    bubble.dataset.messageId = String(message.id);

    if (Number(message.senderId) === Number(currentUser?.id)) {
        bubble.classList.add('mine');
    }

    const body = document.createElement('div');
    body.textContent = message.body;

    const meta = document.createElement('div');
    meta.className = 'relay-message-meta';

    if (!bubble.classList.contains('mine')) {
        const sender = document.createElement('span');
        sender.textContent = message.senderName || 'Relay user';
        meta.append(sender);
    }

    const time = document.createElement('span');
    time.textContent = formatTime(message.createdAt);
    meta.append(time);

    bubble.append(body, meta);
    list.append(bubble);
    list.scrollTop = list.scrollHeight;
}

async function openConversation(conversation) {
    const id = Number(conversation.id);
    if (!Number.isSafeInteger(id) || id < 1) return;

    activeConversationId = id;
    const requestId = ++chatRequest;
    renderConversations(searchInput?.value || '');

    chatPanel.replaceChildren();

    const layout = document.createElement('section');
    layout.className = 'relay-chat';

    const header = document.createElement('header');
    header.className = 'relay-chat-header';

    const avatar = document.createElement('div');
    avatar.className = 'relay-chat-avatar';
    avatar.textContent = (
        conversation.title || conversation.otherName || 'R'
    ).trim().charAt(0).toUpperCase();

    const heading = document.createElement('div');
    heading.className = 'relay-chat-heading';

    const title = document.createElement('h2');
    title.textContent =
        conversation.title || conversation.otherName || 'Conversation';

    const subtitle = document.createElement('p');
    subtitle.textContent = 'Private conversation';

    heading.append(title, subtitle);

    const callButton = document.createElement('button');
    callButton.type = 'button';
    callButton.className = 'relay-call-button';
    callButton.textContent = '☎';
    callButton.title = 'Start voice call';
    callButton.setAttribute('aria-label', 'Start voice call');
    callButton.addEventListener('click', () => startVoiceCall(conversation));

    header.append(avatar, heading, callButton);

    const messages = document.createElement('div');
    messages.className = 'relay-messages';
    messages.id = 'relay-messages';

    const loading = document.createElement('div');
    loading.className = 'relay-notice';
    loading.textContent = 'Loading messages...';
    messages.append(loading);

    const composer = document.createElement('form');
    composer.className = 'relay-composer';

    const input = document.createElement('textarea');
    input.placeholder = 'Write a message...';
    input.maxLength = 4000;
    input.rows = 1;
    input.setAttribute('aria-label', 'Message');

    const send = document.createElement('button');
    send.className = 'relay-send';
    send.type = 'submit';
    send.textContent = 'Send';

    composer.append(input, send);
    layout.append(header, messages, composer);
    chatPanel.append(layout);

    joinConversation(id);

    try {
        const data = await api(`/api/conversations/${id}/messages`);
        if (requestId !== chatRequest || id !== activeConversationId) return;

        messages.replaceChildren();

        if (!data.messages?.length) {
            const notice = document.createElement('div');
            notice.className = 'relay-notice';
            notice.textContent =
                'This is the beginning of your conversation. Say hello!';
            messages.append(notice);
        } else {
            data.messages.forEach(appendMessage);
        }
    } catch (error) {
        if (requestId === chatRequest) {
            messages.replaceChildren();
            const notice = document.createElement('div');
            notice.className = 'relay-notice';
            notice.textContent = error.message;
            messages.append(notice);
        }
    }

    composer.addEventListener('submit', (event) => {
        event.preventDefault();

        const body = input.value.trim();
        if (!body || !socket) return;

        send.disabled = true;

        socket.emit('chat:send', { conversationId: id, body }, (result) => {
            send.disabled = false;

            if (!result?.ok) {
                alert(result?.error || 'Message could not be sent.');
                return;
            }

            input.value = '';
            input.focus();
        });
    });

    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            composer.requestSubmit();
        }
    });

    input.focus();
}

// ---------------- VOICE CALLING ----------------

function socketRequest(eventName, payload) {
    return new Promise((resolve, reject) => {
        if (!socket?.connected) {
            reject(new Error('Relay is disconnected. Refresh and try again.'));
            return;
        }

        socket.emit(eventName, payload, (result) => {
            if (result?.ok) {
                resolve(result);
            } else {
                reject(new Error(result?.error || 'The call request failed.'));
            }
        });
    });
}

async function getMicrophone() {
    if (!window.isSecureContext) {
        throw new Error(
            'Voice calls need HTTPS. Open Relay using your current HTTPS tunnel URL.'
        );
    }

    if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
            'Microphone access is unavailable in this browser. Use a current browser over HTTPS.'
        );
    }

    return navigator.mediaDevices.getUserMedia({
        audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
        },
        video: false
    });
}

async function startVoiceCall(conversation) {
    if (currentCall || callActionInProgress) {
        alert('A voice call is already in progress.');
        return;
    }

    if (!socket?.connected) {
        alert('Relay is reconnecting. Please try again in a moment.');
        return;
    }

    callActionInProgress = true;

    try {
        // Request microphone permission directly from the user's click.
        localStream = await getMicrophone();

        const result = await socketRequest('call:start', {
            conversationId: Number(conversation.id)
        });

        currentCall = {
            callId: result.callId,
            conversationId: Number(conversation.id),
            role: 'caller',
            peerName:
                result.recipientName ||
                conversation.otherName ||
                conversation.title ||
                'Relay contact',
            status: 'ringing'
        };

        showCallScreen('outgoing');
    } catch (error) {
        console.error('Could not start voice call:', error);
        cleanupCall();
        alert(error.message || 'Could not start the voice call.');
    } finally {
        callActionInProgress = false;
    }
}

async function acceptIncomingCall() {
    if (!currentCall ||
        currentCall.role !== 'recipient' ||
        callActionInProgress) return;

    callActionInProgress = true;

    const acceptButton = callOverlay?.querySelector('[data-call-accept]');
    if (acceptButton) acceptButton.disabled = true;

    try {
        localStream = await getMicrophone();

        // Prepare the audio connection before telling the caller we accepted.
        await createPeerConnection();

        const result = await socketRequest('call:accept', {
            callId: currentCall.callId
        });

        currentCall.status = 'connecting';
        updateCallScreen('Connecting audio…');
    } catch (error) {
        console.error('Could not accept call:', error);
        showCallError(error.message || 'Could not accept this call.');

        if (currentCall && socket?.connected) {
            socket.emit('call:reject', { callId: currentCall.callId });
        }

        cleanupCall();
        alert(error.message || 'Could not accept the voice call.');
    } finally {
        callActionInProgress = false;
    }
}

async function createPeerConnection() {
    if (!currentCall) throw new Error('No active call.');

    if (peerConnection) return peerConnection;

    if (!localStream) {
        throw new Error('Microphone access has not been granted.');
    }

    const pc = new RTCPeerConnection(rtcConfig);
    peerConnection = pc;

    localStream.getTracks().forEach((track) => {
        pc.addTrack(track, localStream);
    });

    pc.onicecandidate = (event) => {
        if (!event.candidate || !currentCall || !socket?.connected) return;

        socket.emit('call:ice', {
            callId: currentCall.callId,
            candidate: event.candidate.toJSON()
        });
    };

    pc.ontrack = (event) => {
        if (!remoteAudio) return;

        if (event.streams?.[0]) {
            remoteAudio.srcObject = event.streams[0];
        } else {
            let stream = remoteAudio.srcObject;

            if (!(stream instanceof MediaStream)) {
                stream = new MediaStream();
                remoteAudio.srcObject = stream;
            }

            stream.addTrack(event.track);
        }

        remoteAudio.play().catch((error) => {
            console.warn('Remote audio playback needs user interaction:', error);
            updateCallScreen('Connected. Tap the page if audio does not play.');
        });
    };

    pc.onconnectionstatechange = () => {
        if (peerConnection !== pc || !currentCall) return;

        if (pc.connectionState === 'connected') {
            currentCall.status = 'connected';
            updateCallScreen('Connected • Voice call');
        } else if (pc.connectionState === 'connecting') {
            updateCallScreen('Connecting audio…');
        } else if (pc.connectionState === 'failed') {
            updateCallScreen('Connection failed. Hang up and try again.');
        } else if (pc.connectionState === 'disconnected') {
            updateCallScreen('Connection interrupted. Trying to reconnect…');
        }
    };

    return pc;
}

async function ensurePeerConnection() {
    if (peerConnection) return peerConnection;
    return createPeerConnection();
}

async function flushIceCandidates() {
    if (!peerConnection?.remoteDescription) return;

    const candidates = pendingIceCandidates.splice(0);

    for (const candidate of candidates) {
        try {
            await peerConnection.addIceCandidate(candidate);
        } catch (error) {
            console.warn('Could not apply queued ICE candidate:', error);
        }
    }
}

function showCallScreen(mode) {
    removeCallScreen();

    if (!currentCall) return;

    callOverlay = document.createElement('div');
    callOverlay.className = 'relay-call-overlay';
    callOverlay.setAttribute('role', 'dialog');
    callOverlay.setAttribute('aria-modal', 'true');
    callOverlay.setAttribute('aria-label', 'Relay voice call');

    const card = document.createElement('section');
    card.className = 'relay-call-card';

    const orb = document.createElement('div');
    orb.className = 'relay-call-orb';
    orb.textContent = (currentCall.peerName || 'R').trim().charAt(0).toUpperCase();

    const title = document.createElement('h2');
    title.className = 'relay-call-title';
    title.textContent = currentCall.peerName || 'Relay contact';

    const status = document.createElement('p');
    status.className = 'relay-call-status';
    status.dataset.callStatus = '';
    status.textContent = mode === 'incoming'
        ? 'Incoming voice call…'
        : 'Calling…';

    const error = document.createElement('p');
    error.className = 'relay-call-error';
    error.dataset.callError = '';
    error.hidden = true;

    const actions = document.createElement('div');
    actions.className = 'relay-call-actions';

    if (mode === 'incoming') {
        const reject = makeCallButton('Reject', 'end', () => rejectIncomingCall());
        const accept = makeCallButton('Accept', 'accept', () => acceptIncomingCall());
        accept.dataset.callAccept = '';
        actions.append(reject, accept);
    } else {
        const end = makeCallButton('End call', 'end', () => endVoiceCall());
        actions.append(end);
    }

    card.append(orb, title, status, error, actions);
    callOverlay.append(card);

    remoteAudio = document.createElement('audio');
    remoteAudio.autoplay = true;
    remoteAudio.playsInline = true;
    remoteAudio.setAttribute('aria-label', 'Remote call audio');
    remoteAudio.style.display = 'none';
    card.append(remoteAudio);

    document.body.append(callOverlay);
}

function makeCallButton(label, type, callback) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `relay-call-action ${type}`.trim();
    button.textContent = label;
    button.addEventListener('click', callback);
    return button;
}

function updateCallScreen(message) {
    if (!callOverlay) return;

    const status = callOverlay.querySelector('[data-call-status]');
    if (status) status.textContent = message;

    const actions = callOverlay.querySelector('.relay-call-actions');
    if (!actions || !currentCall) return;

    if (currentCall.status === 'connected' ||
        currentCall.status === 'connecting') {
        if (!actions.querySelector('[data-call-mute]')) {
            actions.replaceChildren();

            const mute = makeCallButton('Mute', '', toggleMute);
            mute.dataset.callMute = '';

            const end = makeCallButton('End call', 'end', () => endVoiceCall());

            actions.append(mute, end);
        }
    }
}

function showCallError(message) {
    if (!callOverlay) return;

    const error = callOverlay.querySelector('[data-call-error]');
    if (!error) return;

    error.textContent = message;
    error.hidden = false;
}

function toggleMute() {
    if (!localStream) return;

    const tracks = localStream.getAudioTracks();
    if (!tracks.length) return;

    const shouldEnable = tracks.some((track) => !track.enabled);
    tracks.forEach((track) => {
        track.enabled = shouldEnable;
    });

    const button = callOverlay?.querySelector('[data-call-mute]');
    if (button) button.textContent = shouldEnable ? 'Mute' : 'Unmute';
}

async function rejectIncomingCall() {
    if (!currentCall || currentCall.role !== 'recipient') return;

    const callId = currentCall.callId;

    try {
        await socketRequest('call:reject', { callId });
    } catch (error) {
        console.warn('Could not reject call on server:', error.message);
    }

    cleanupCall();
}

async function endVoiceCall() {
    if (!currentCall) {
        cleanupCall();
        return;
    }

    const callId = currentCall.callId;

    // Clean up locally immediately so the controls respond without waiting.
    cleanupCall();

    if (socket?.connected) {
        try {
            await socketRequest('call:end', { callId });
        } catch (error) {
            console.warn('Could not notify the other participant:', error.message);
        }
    }
}

function removeCallScreen() {
    callOverlay?.remove();
    callOverlay = null;
    remoteAudio = null;
}

function cleanupCall() {
    if (peerConnection) {
        peerConnection.onicecandidate = null;
        peerConnection.ontrack = null;
        peerConnection.onconnectionstatechange = null;
        peerConnection.close();
        peerConnection = null;
    }

    if (localStream) {
        localStream.getTracks().forEach((track) => track.stop());
        localStream = null;
    }

    if (remoteAudio) {
        remoteAudio.pause();
        remoteAudio.srcObject = null;
    }

    removeCallScreen();
    pendingIceCandidates = [];
    currentCall = null;
    callActionInProgress = false;
}

// ---------------- END VOICE CALLING ----------------

async function createConversation() {
    const search = prompt(
        'Enter the Relay username, name, or email of the person you want to message:'
    );
    if (search === null) return;

    const query = search.trim();
    if (query.length < 2) {
        alert('Enter at least 2 characters to search.');
        return;
    }

    try {
        const data = await api(`/api/users?search=${encodeURIComponent(query)}`);
        const users = data.users || [];

        if (!users.length) {
            alert('No Relay users found. The other person must sign in to Relay first.');
            return;
        }

        let recipient = users[0];

        if (users.length > 1) {
            const choices = users.map((user, index) =>
                `${index + 1}. ${user.displayName} (${user.email || 'No email shown'})`
            ).join('\n');

            const choice = prompt(`Choose the person by number:\n\n${choices}`);
            if (choice === null) return;

            const index = Number(choice) - 1;
            if (!Number.isInteger(index) || index < 0 || index >= users.length) {
                alert('That selection is not valid.');
                return;
            }

            recipient = users[index];
        }

        const result = await api('/api/conversations', {
            method: 'POST',
            body: JSON.stringify({ recipientUserId: recipient.id })
        });

        await loadConversations();

        const conversation = result.conversation ||
            conversations.find((item) => Number(item.id) === Number(result.id));

        if (conversation) {
            await openConversation(conversation);
        } else {
            await loadConversations();

            const match = conversations.find((item) =>
                Number(item.id) === Number(result.conversationId || result.id)
            );

            if (match) await openConversation(match);
            else alert('Conversation created. Select it from the sidebar to open it.');
        }
    } catch (error) {
        alert(error.message);
    }
}

searchInput?.addEventListener('input', () => {
    renderConversations(searchInput.value);
});

newChatButton?.addEventListener('click', createConversation);
$('#start-chat')?.addEventListener('click', createConversation);

signOutButton?.addEventListener('click', async () => {
    if (currentCall) {
        await endVoiceCall();
    }

    try {
        await api('/api/auth/logout', { method: 'POST' });
    } catch (error) {
        console.error('Sign-out request failed:', error);
    }

    if (socket) {
        socket.disconnect();
        socket = null;
    }

    currentUser = null;
    conversations = [];
    activeConversationId = null;
    chatPanel.innerHTML = originalWelcome;

    if (window.google?.accounts?.id) {
        google.accounts.id.disableAutoSelect();
    }

    showLogin();
    setLoginStatus('Sign in with your Google account.');
});

async function boot() {
    try {
        const data = await api('/api/auth/me');

        if (data.user) {
            await showApp(data.user);
            return;
        }
    } catch {
        // No active session: show the sign-in screen.
    }

    loginScreen.hidden = false;
    appScreen.hidden = true;

    if (window.google?.accounts?.id) {
        initializeGoogleSignIn();
    } else {
        setLoginStatus('Loading Google sign-in...');
        window.addEventListener('load', initializeGoogleSignIn, { once: true });
    }
}

boot();
