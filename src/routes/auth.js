const express = require('express');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { OAuth2Client } = require('google-auth-library');

const GOOGLE_CLIENT_ID =
    '564611382464-4lkm5khes538eb5cademoscnauu82gmo.apps.googleusercontent.com';

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
const scryptAsync = promisify(crypto.scrypt);
const SESSION_DURATION = 7 * 24 * 60 * 60 * 1000;

module.exports = function createAuthRouter(db) {
    const router = express.Router();

    // Safely add Google account fields to existing databases.
    const columns = db.prepare('PRAGMA table_info(users)').all();
    const columnNames = new Set(columns.map(column => column.name));

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

            if (name === 'relay_session') return value;
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

    function createSession(userId, res) {
        const sessionId = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(
            Date.now() + SESSION_DURATION
        ).toISOString();

        db.prepare(`
            INSERT INTO sessions (id, user_id, expires_at)
            VALUES (?, ?, ?)
        `).run(sessionId, userId, expiresAt);

        setSessionCookie(res, sessionId);
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
            SELECT id, username, display_name, email
            FROM users
            WHERE id = ?
        `).get(session.user_id);
    }

    async function hashPassword(password) {
        const salt = crypto.randomBytes(16).toString('hex');
        const derivedKey = await scryptAsync(password, salt, 64);

        return `scrypt$${salt}$${derivedKey.toString('hex')}`;
    }

    async function verifyPassword(password, storedHash) {
        try {
            const parts = storedHash.split('$');
            if (parts.length !== 3 || parts[0] !== 'scrypt') {
                return false;
            }

            const [, salt, storedKey] = parts;

            if (!/^[a-f0-9]{32}$/.test(salt)) return false;
            if (!/^[a-f0-9]{128}$/.test(storedKey)) return false;

            const derivedKey = await scryptAsync(password, salt, 64);
            const expectedKey = Buffer.from(storedKey, 'hex');

            return crypto.timingSafeEqual(derivedKey, expectedKey);
        } catch {
            return false;
        }
    }

    function validateEmail(email) {
        return typeof email === 'string' &&
            email.length <= 254 &&
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }

    function validateUsername(username) {
        return typeof username === 'string' &&
            /^[a-zA-Z0-9_]{3,20}$/.test(username);
    }

    // STEP 1: Finish registration after the user chooses a username.
    // The frontend collects email/password on the first screen and
    // submits all three values when the username screen is completed.
    router.post('/register', async (req, res) => {
        try {
            const email = typeof req.body?.email === 'string'
                ? req.body.email.trim().toLowerCase()
                : '';

            const password = req.body?.password;
            const username = typeof req.body?.username === 'string'
                ? req.body.username.trim()
                : '';

            if (!validateEmail(email)) {
                return res.status(400).json({
                    error: 'Enter a valid email address.'
                });
            }

            if (
                typeof password !== 'string' ||
                password.length < 8 ||
                password.length > 128
            ) {
                return res.status(400).json({
                    error: 'Password must be between 8 and 128 characters.'
                });
            }

            if (!validateUsername(username)) {
                return res.status(400).json({
                    error: 'Username must be 3–20 characters using letters, numbers, or underscores.'
                });
            }

            const existingEmail = db.prepare(`
                SELECT id FROM users WHERE email = ? COLLATE NOCASE
            `).get(email);

            if (existingEmail) {
                return res.status(409).json({
                    error: 'An account with this email already exists. Please sign in.'
                });
            }

            const existingUsername = db.prepare(`
                SELECT id FROM users WHERE username = ? COLLATE NOCASE
            `).get(username);

            if (existingUsername) {
                return res.status(409).json({
                    error: 'That username is already taken. Try another.'
                });
            }

            const passwordHash = await hashPassword(password);

            let result;

            try {
                result = db.prepare(`
                    INSERT INTO users
                        (username, display_name, password_hash, email)
                    VALUES (?, ?, ?, ?)
                `).run(username, username, passwordHash, email);
            } catch (error) {
                if (error.code === 'ERR_SQLITE_ERROR') {
                    const message = error.message || '';

                    if (message.includes('UNIQUE constraint failed')) {
                        return res.status(409).json({
                            error: 'That username or email is already registered.'
                        });
                    }
                }

                throw error;
            }

            const userId = Number(result.lastInsertRowid);
            createSession(userId, res);

            return res.status(201).json({
                ok: true,
                user: {
                    id: userId,
                    username,
                    displayName: username,
                    email
                }
            });
        } catch (error) {
            console.error('Registration failed:', error.message);

            return res.status(500).json({
                error: 'Could not create your account. Please try again.'
            });
        }
    });

    // Sign in using email and password.
    router.post('/login', async (req, res) => {
        try {
            const email = typeof req.body?.email === 'string'
                ? req.body.email.trim().toLowerCase()
                : '';

            const password = req.body?.password;

            if (
                !validateEmail(email) ||
                typeof password !== 'string' ||
                password.length > 128
            ) {
                return res.status(400).json({
                    error: 'Enter a valid email and password.'
                });
            }

            const user = db.prepare(`
                SELECT id, username, display_name, email, password_hash
                FROM users
                WHERE email = ? COLLATE NOCASE
            `).get(email);

            if (
                !user ||
                !(await verifyPassword(password, user.password_hash))
            ) {
                return res.status(401).json({
                    error: 'Incorrect email or password.'
                });
            }

            createSession(user.id, res);

            return res.json({
                ok: true,
                user: {
                    id: user.id,
                    username: user.username,
                    displayName: user.display_name,
                    email: user.email
                }
            });
        } catch (error) {
            console.error('Login failed:', error.message);

            return res.status(500).json({
                error: 'Could not sign in. Please try again.'
            });
        }
    });

    // Existing Google sign-in — preserved.
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

            createSession(user.id, res);

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

    // Restore the existing session after a refresh or browser restart.
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
                username: user.username,
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