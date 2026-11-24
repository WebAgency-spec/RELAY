
const express = require('express');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { OAuth2Client } = require('google-auth-library');

const scrypt = promisify(crypto.scrypt);

const GOOGLE_CLIENT_ID =
    '564611382464-4lkm5khes538eb5cademoscnauu82gmo.apps.googleusercontent.com';

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const SESSION_DURATION = 7 * 24 * 60 * 60 * 1000;

module.exports = function createAuthRouter(db) {
    const router = express.Router();

    function parseCookies(req) {
        const cookies = {};

        (req.headers.cookie || '').split(';').forEach((cookie) => {
            const separator = cookie.indexOf('=');
            if (separator === -1) return;

            const name = cookie.slice(0, separator).trim();
            const value = cookie.slice(separator + 1).trim();

            try {
                cookies[name] = decodeURIComponent(value);
            } catch {
                cookies[name] = value;
            }
        });

        return cookies;
    }

    function setSessionCookie(res, sessionId) {
        const secure = process.env.NODE_ENV === 'production'
            ? '; Secure'
            : '';

        res.setHeader(
            'Set-Cookie',
            `relay_session=${sessionId}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DURATION / 1000}${secure}`
        );
    }

    function clearSessionCookie(res) {
        const secure = process.env.NODE_ENV === 'production'
            ? '; Secure'
            : '';

        res.setHeader(
            'Set-Cookie',
            `relay_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`
        );
    }

    async function createSession(userId, res) {
        const sessionId = crypto.randomBytes(32).toString('hex');

        const expiresAt = new Date(Date.now() + SESSION_DURATION);

        await db.query(
            `INSERT INTO sessions (id, user_id, expires_at)
             VALUES ($1, $2, $3)`,
            [sessionId, userId, expiresAt]
        );

        setSessionCookie(res, sessionId);
    }

    async function getAuthenticatedUser(req) {
        const sessionId = parseCookies(req).relay_session;

        if (!sessionId || !/^[a-f0-9]{64}$/i.test(sessionId)) {
            return null;
        }

        const result = await db.query(
            `SELECT users.id, users.username, users.display_name,
                    users.email, users.profile_bio, users.profile_image
             FROM sessions
             JOIN users ON users.id = sessions.user_id
             WHERE sessions.id = $1
               AND sessions.expires_at > NOW()`,
            [sessionId]
        );

        return result.rows[0] || null;
    }

    function publicUser(user) {
        return {
            id: user.id,
            username: user.username,
            displayName: user.display_name,
            email: user.email,
            bio: user.profile_bio || '',
            avatar: user.profile_image || null
        };
    }

    async function hashPassword(password) {
        const salt = crypto.randomBytes(16).toString('hex');

        const derivedKey = await scrypt(password, salt, 64);

        return `scrypt$${salt}$${derivedKey.toString('hex')}`;
    }

    async function verifyPassword(password, storedHash) {
        if (!storedHash || typeof storedHash !== 'string') {
            return false;
        }

        const parts = storedHash.split('$');

        if (parts.length !== 3 || parts[0] !== 'scrypt') {
            return false;
        }

        const [, salt, storedKey] = parts;

        if (!/^[a-f0-9]{32}$/i.test(salt) ||
            !/^[a-f0-9]{128}$/i.test(storedKey)) {
            return false;
        }

        const derivedKey = await scrypt(password, salt, 64);
        const expectedKey = Buffer.from(storedKey, 'hex');

        return crypto.timingSafeEqual(derivedKey, expectedKey);
    }

    function handleError(res, error) {
        console.error('Authentication error:', error.message);

        if (!res.headersSent) {
            res.status(500).json({
                error: 'An authentication error occurred.'
            });
        }
    }

    // REGISTER
    router.post('/register', async (req, res) => {
        try {
            const { email, password, username } = req.body;

            if (
                typeof email !== 'string' ||
                typeof password !== 'string' ||
                typeof username !== 'string'
            ) {
                return res.status(400).json({
                    error: 'Please provide all required fields.'
                });
            }

            const cleanEmail = email.trim().toLowerCase();
            const cleanUsername = username.trim();

            if (
                !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) ||
                cleanEmail.length > 254
            ) {
                return res.status(400).json({
                    error: 'Enter a valid email address.'
                });
            }

            if (password.length < 8 || password.length > 128) {
                return res.status(400).json({
                    error: 'Password must be between 8 and 128 characters.'
                });
            }

            if (!/^[a-zA-Z0-9_]{3,20}$/.test(cleanUsername)) {
                return res.status(400).json({
                    error: 'Username must be 3-20 characters and contain only letters, numbers, and underscores.'
                });
            }

            const existing = await db.query(
                `SELECT id FROM users
                 WHERE LOWER(email) = LOWER($1)
                    OR LOWER(username) = LOWER($2)
                 LIMIT 1`,
                [cleanEmail, cleanUsername]
            );

            if (existing.rows.length) {
                return res.status(409).json({
                    error: 'Email or username is already registered.'
                });
            }

            const passwordHash = await hashPassword(password);

            const result = await db.query(
                `INSERT INTO users (username, display_name, email, password_hash)
                 VALUES ($1, $2, $3, $4)
                 RETURNING id, username, display_name, email,
                           profile_bio, profile_image`,
                [cleanUsername, cleanUsername, cleanEmail, passwordHash]
            );

            const user = result.rows[0];

            await createSession(user.id, res);

            return res.status(201).json({
                success: true,
                user: publicUser(user)
            });
        } catch (error) {
            if (error.code === '23505') {
                return res.status(409).json({
                    error: 'Email or username is already registered.'
                });
            }

            handleError(res, error);
        }
    });

    // LOGIN
    router.post('/login', async (req, res) => {
        try {
            const { email, password } = req.body;

            if (
                typeof email !== 'string' ||
                typeof password !== 'string'
            ) {
                return res.status(400).json({
                    error: 'Enter your email and password.'
                });
            }

            const result = await db.query(
                `SELECT id, username, display_name, email,
                        password_hash, profile_bio, profile_image
                 FROM users
                 WHERE LOWER(email) = LOWER($1)
                 LIMIT 1`,
                [email.trim()]
            );

            const user = result.rows[0];

            if (!user || !(await verifyPassword(password, user.password_hash))) {
                return res.status(401).json({
                    error: 'Incorrect email or password.'
                });
            }

            await createSession(user.id, res);

            return res.json({
                success: true,
                user: publicUser(user)
            });
        } catch (error) {
            handleError(res, error);
        }
    });

    // GOOGLE LOGIN
    router.post('/google', async (req, res) => {
        try {
            const { credential } = req.body;

            if (
                typeof credential !== 'string' ||
                credential.length > 10000
            ) {
                return res.status(400).json({
                    error: 'Google credential is missing or invalid.'
                });
            }

            const ticket = await googleClient.verifyIdToken({
                idToken: credential,
                audience: GOOGLE_CLIENT_ID
            });

            const payload = ticket.getPayload();

            if (!payload || !payload.email || !payload.email_verified || !payload.sub) {
                return res.status(401).json({
                    error: 'Google account verification failed.'
                });
            }

            const googleSub = payload.sub;
            const email = payload.email.toLowerCase();
            const displayName = payload.name || email.split('@')[0];

            let result = await db.query(
                `SELECT id, username, display_name, email,
                        profile_bio, profile_image
                 FROM users
                 WHERE google_sub = $1
                 LIMIT 1`,
                [googleSub]
            );

            let user = result.rows[0];

            if (user) {
                result = await db.query(
                    `UPDATE users
                     SET email = $1, display_name = $2
                     WHERE id = $3
                     RETURNING id, username, display_name, email,
                               profile_bio, profile_image`,
                    [email, displayName, user.id]
                );

                user = result.rows[0];
            } else {
                const username = `google_${googleSub}`;
                const randomPassword = await hashPassword(
                    crypto.randomBytes(48).toString('hex')
                );

                result = await db.query(
                    `INSERT INTO users
                        (username, display_name, email, google_sub, password_hash)
                     VALUES ($1, $2, $3, $4, $5)
                     RETURNING id, username, display_name, email,
                               profile_bio, profile_image`,
                    [username, displayName, email, googleSub, randomPassword]
                );

                user = result.rows[0];
            }

            await createSession(user.id, res);

            return res.json({
                success: true,
                user: publicUser(user)
            });
        } catch (error) {
            if (error.code === '23505') {
                return res.status(409).json({
                    error: 'This Google account conflicts with an existing account.'
                });
            }

            console.error('Google authentication error:', error.message);

            return res.status(401).json({
                error: 'Google authentication failed.'
            });
        }
    });

    // RESTORE SESSION
    router.get('/me', async (req, res) => {
        try {
            const user = await getAuthenticatedUser(req);

            if (!user) {
                return res.status(401).json({
                    authenticated: false
                });
            }

            return res.json({
                authenticated: true,
                user: publicUser(user)
            });
        } catch (error) {
            handleError(res, error);
        }
    });

    // LOGOUT
    router.post('/logout', async (req, res) => {
        try {
            const sessionId = parseCookies(req).relay_session;

            if (sessionId && /^[a-f0-9]{64}$/i.test(sessionId)) {
                await db.query(
                    'DELETE FROM sessions WHERE id = $1',
                    [sessionId]
                );
            }

            clearSessionCookie(res);

            return res.json({
                success: true
            });
        } catch (error) {
            handleError(res, error);
        }
    });

    return router;
};
