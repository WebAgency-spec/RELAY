
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const databasePath = path.join(__dirname, '../../relay.db');
const db = new DatabaseSync(databasePath);

db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        )
    );

    CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        ),
        FOREIGN KEY (user_id) REFERENCES users(id)
            ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        is_group INTEGER NOT NULL DEFAULT 0
            CHECK (is_group IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT (
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        )
    );

    CREATE TABLE IF NOT EXISTS conversation_members (
        conversation_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        joined_at TEXT NOT NULL DEFAULT (
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        ),
        PRIMARY KEY (conversation_id, user_id),
        FOREIGN KEY (conversation_id)
            REFERENCES conversations(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id)
            REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL,
        sender_id INTEGER NOT NULL,
        body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
        created_at TEXT NOT NULL DEFAULT (
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        ),
        edited_at TEXT,
        FOREIGN KEY (conversation_id)
            REFERENCES conversations(id) ON DELETE CASCADE,
        FOREIGN KEY (sender_id)
            REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS read_receipts (
        message_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        read_at TEXT NOT NULL DEFAULT (
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        ),
        PRIMARY KEY (message_id, user_id),
        FOREIGN KEY (message_id)
            REFERENCES messages(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id)
            REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user
        ON sessions(user_id);

    CREATE INDEX IF NOT EXISTS idx_members_user
        ON conversation_members(user_id);

    CREATE INDEX IF NOT EXISTS idx_messages_conversation
        ON messages(conversation_id, id);

    CREATE INDEX IF NOT EXISTS idx_receipts_user
        ON read_receipts(user_id);
`);

console.log('RELAY DATABASE ONLINE');
console.log(`Database: ${databasePath}`);

module.exports = db;
