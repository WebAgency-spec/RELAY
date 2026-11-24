
const express = require('express');
const crypto = require('node:crypto');
const { OAuth2Client } = require('google-auth-library');

const GOOGLE_CLIENT_ID =
    '564611382464-4lkm5khes538eb5cademoscnauu82gmo.apps.googleusercontent.com';

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
const SESSION_DURATION = 7 * 24 * 60 * 60 * 1000;

module.exports = function createAuthRouter(db) {
    const router = express.Router();

    // Add Google account fields without deleting existing user data.
    const columns = db.prepare('PRAGMA table_info(users)').all();
    const columnNames = new Set(columns.map((column) => column.name));

    if (!columnNames.has('email')) {
        db.exec('ALTER TABLE users ADD COLUMN email TEXT');
    }

    if (!columnNames.has('google_sub')) {
        db.exec('ALTER TABLE users ADD COLUMN google_sub TEXT');
    }

    db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub
        ON users(google_sub)
        WHERE google_sub IS NOT NULL
    `);

    function readSessionId(req) {
        const cookies = (req.headers.cookie || '').split(';');

        for (const cookie of cookies) {
            const separator = cookie.indexOf('=');
            if (separator < 0) continue;

            const name = cookie.slice(0, separator).trim();
            const value = cookie.slice(separator + 1).trim();

            if (name === 'relay_session') {
                return value;
            }
        }

        return null;
    }

    function setSessionCookie(res, sessionId) {
        res.setHeader(
            'Set-Cookie',
            `relay_session=${sessionId}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DURATION / 1000}`
        );
    }

    function clearSessionCookie(res) {
        res.setHeader(
            'Set-Cookie',
            'relay_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0'
        );
    }

    function getAuthenticatedUser(req) {
        const sessionId = readSessionId(req);
        if (!sessionId) return null;

        const session = db.prepare(`
            SELECT user_id
            FROM sessions
            WHERE id = ? AND expires_at > ?
        `).get(sessionId, new Date().toISOString());

        if (!session) return null;

        return db.prepare(`
            SELECT id, display_name, email
            FROM users
            WHERE id = ?
        `).get(session.user_id);
    }

    router.post('/google', async (req, res) => {
        try {
            const credential = req.body?.credential;

            if (
                typeof credential !== 'string' ||
                credential.length > 10000
            ) {
                return res.status(400).json({
                    error: 'Missing or invalid Google credential.'
                });
            }

            // Verify the token with Google, on the server.
            const ticket = await googleClient.verifyIdToken({
                idToken: credential,
                audience: GOOGLE_CLIENT_ID
            });

            const payload = ticket.getPayload();

            if (
                !payload?.sub ||
                !payload.email ||
                payload.email_verified !== true
            ) {
                return res.status(401).json({
                    error: 'Google account email could not be verified.'
                });
            }

            const googleSub = payload.sub;
            const email = payload.email.toLowerCase();
            const displayName = (payload.name || email).slice(0, 100);

            let user = db.prepare(`
                SELECT id
                FROM users
                WHERE google_sub = ?
            `).get(googleSub);

            if (user) {
                db.prepare(`
                    UPDATE users
                    SET email = ?, display_name = ?
                    WHERE id = ?
                `).run(email, displayName, user.id);
            } else {
                // Do not reuse an existing account just because its email matches.
                // The random value is not a usable password.
                const internalUsername = `google_${googleSub}`;
                const unusablePassword = crypto.randomBytes(32).toString('hex');

                const result = db.prepare(`
                    INSERT INTO users
                        (username, display_name, password_hash, email, google_sub)
                    VALUES (?, ?, ?, ?, ?)
                `).run(
                    internalUsername,
                    displayName,
                    unusablePassword,
                    email,
                    googleSub
                );

                user = { id: Number(result.lastInsertRowid) };
            }

            const sessionId = crypto.randomBytes(32).toString('hex');
            const expiresAt = new Date(
                Date.now() + SESSION_DURATION
            ).toISOString();

            db.prepare(`
                INSERT INTO sessions (id, user_id, expires_at)
                VALUES (?, ?, ?)
            `).run(sessionId, user.id, expiresAt);

            setSessionCookie(res, sessionId);

            return res.json({
                ok: true,
                user: {
                    id: user.id,
                    displayName,
                    email,
                    picture: payload.picture || null
                }
            });
        } catch (error) {
            console.error('Google sign-in failed:', error.message);

            return res.status(401).json({
                error: 'Google sign-in failed. Check your Google client ID and server logs.'
            });
        }
    });

    router.get('/me', (req, res) => {
        const user = getAuthenticatedUser(req);

        if (!user) {
            return res.status(401).json({
                error: 'You are not signed in.'
            });
        }

        return res.json({
            user: {
                id: user.id,
                displayName: user.display_name,
                email: user.email
            }
        });
    });

    router.post('/logout', (req, res) => {
        const sessionId = readSessionId(req);

        if (sessionId) {
            db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
        }

        clearSessionCookie(res);
        return res.json({ ok: true });
    });

    return router;
};
