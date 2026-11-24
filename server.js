
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { Server } = require('socket.io');
const createMessagingRouter = require('./src/routes/messaging');
const createProfileRouter = require('./src/routes/profile');
const db = require('./src/db/database');
const createHealthRouter = require('./src/routes/health');
const createAuthRouter = require('./src/routes/auth');
const registerChatHandlers = require('./src/socket/chat');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', createHealthRouter(db));
app.use('/api/auth', createAuthRouter(db));
app.use('/api', createMessagingRouter(db));

io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id);

    registerChatHandlers(io, db, socket);

    socket.on('disconnect', () => {
        console.log('Socket disconnected:', socket.id);
    });
});

const PORT = 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log('RELAY ONLINE');
    console.log(`Local: http://127.0.0.1:${PORT}`);
    console.log(`Network: http://192.168.29.73:${PORT}`);
});
