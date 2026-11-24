
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is missing. Configure your PostgreSQL connection string.');
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : undefined,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

pool.on('error', (error) => {
    console.error('Unexpected PostgreSQL pool error:', error.message);
});

async function initializeDatabase() {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id BIGSERIAL PRIMARY KEY,
                username TEXT NOT NULL,
                display_name TEXT,
                password_hash TEXT,
                email TEXT,
                google_sub TEXT,
                profile_bio TEXT,
                profile_image TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);

        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower
            ON users (LOWER(username));
        `);

        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower
            ON users (LOWER(email))
            WHERE email IS NOT NULL;
        `);

        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub
            ON users (google_sub)
            WHERE google_sub IS NOT NULL;
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS conversations (
                id BIGSERIAL PRIMARY KEY,
                title TEXT,
                is_group BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS conversation_members (
                conversation_id BIGINT NOT NULL
                    REFERENCES conversations(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL
                    REFERENCES users(id) ON DELETE CASCADE,
                joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (conversation_id, user_id)
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id BIGSERIAL PRIMARY KEY,
                conversation_id BIGINT NOT NULL
                    REFERENCES conversations(id) ON DELETE CASCADE,
                sender_id BIGINT NOT NULL
                    REFERENCES users(id) ON DELETE CASCADE,
                body TEXT NOT NULL
                    CHECK (char_length(body) BETWEEN 1 AND 4000),
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                edited_at TIMESTAMPTZ
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS read_receipts (
                message_id BIGINT NOT NULL
                    REFERENCES messages(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL
                    REFERENCES users(id) ON DELETE CASCADE,
                read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (message_id, user_id)
            );
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_sessions_user
            ON sessions(user_id);
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_members_user
            ON conversation_members(user_id);
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_messages_conversation
            ON messages(conversation_id);
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_receipts_user
            ON read_receipts(user_id);
        `);

        await client.query('COMMIT');
        console.log('RELAY PostgreSQL database initialized.');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Database initialization failed:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

module.exports = {
    query: (text, params) => pool.query(text, params),
    connect: () => pool.connect(),
    initializeDatabase,
    pool
};
