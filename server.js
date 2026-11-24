
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { Server } = require('socket.io');

const db = require('./src/db/database');

const createHealthRouter = require('./src/routes/health');
const createAuthRouter = require('./src/routes/auth');
const createMessagingRouter = require('./src/routes/messaging');
const createProfileRouter = require('./src/routes/profile');

const registerChatHandlers = require('./src/socket/chat');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: true,
        credentials: true
    }
});

app.set('trust proxy', 1);

app.use(express.json({ limit: '1mb' }));

app.use(express.static(path.join(__dirname, 'public')));

// API ROUTES
app.use('/api', createHealthRouter(db));
app.use('/api/auth', createAuthRouter(db));
app.use('/api', createMessagingRouter(db));
app.use('/api/profile', createProfileRouter(db));

// SOCKET.IO
io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id);

    registerChatHandlers(io, db, socket);
});

// ERROR HANDLING
app.use((error, req, res, next) => {
    console.error('Server error:', error.message);

    if (!res.headersSent) {
        res.status(500).json({
            error: 'Internal server error.'
        });
    }
});

// START SERVER AFTER DATABASE INITIALIZATION
const PORT = process.env.PORT || 3000;

async function startServer() {
    try {
        await db.initializeDatabase();

        server.listen(PORT, '0.0.0.0', () => {
            console.log('================================');
            console.log('       RELAY IS ONLINE');
            console.log('================================');
            console.log(`Port: ${PORT}`);
            console.log('Database: PostgreSQL');
            console.log('Realtime: Socket.IO');
        });
    } catch (error) {
        console.error('RELAY startup failed:', error);
        process.exit(1);
    }
}

startServer();
