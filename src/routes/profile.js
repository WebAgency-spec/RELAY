
const express = require('express');
const routerFactory = express.Router;

module.exports = function createProfileRouter(db) {
    const router = routerFactory();

    // Safe migrations: add profile fields without deleting existing data.
    const columns = new Set(
        db.prepare('PRAGMA table_info(users)').all().map(column => column.name)
    );

    if (!columns.has('profile_bio')) {
        db.exec('ALTER TABLE users ADD COLUMN profile_bio TEXT NOT NULL DEFAULT \'\'');
    }

    if (!columns.has('profile_image')) {
        db.exec('ALTER TABLE users ADD COLUMN profile_image TEXT');
    }

    function getSessionId(req) {
        for (const cookie of (req.headers.cookie || '').split(';')) {
            const separator = cookie.indexOf('=');
            if (separator < 0) continue;

            if (cookie.slice(0, separator).trim() === 'relay_session') {
                return cookie.slice(separator + 1).trim();
            }
        }

        return null;
    }

    function getUser(req) {
        const sessionId = getSessionId(req);
        if (!sessionId) return null;

        const session = db.prepare(`
            SELECT user_id
            FROM sessions
            WHERE id = ? AND expires_at > ?
        `).get(sessionId, new Date().toISOString());

        if (!session) return null;

        return db.prepare(`
            SELECT id, username, display_name, email,
                   profile_bio, profile_image
            FROM users
            WHERE id = ?
        `).get(session.user_id);
    }

    function publicProfile(user) {
        return {
            id: user.id,
            username: user.username,
            displayName: user.display_name,
            email: user.email || '',
            bio: user.profile_bio || '',
            avatar: user.profile_image || null
        };
    }

    router.get('/', (req, res) => {
        const user = getUser(req);

        if (!user) {
            return res.status(401).json({ error: 'Please sign in again.' });
        }

        return res.json({ user: publicProfile(user) });
    });

    router.put('/', (req, res) => {
        const user = getUser(req);

        if (!user) {
            return res.status(401).json({ error: 'Please sign in again.' });
        }

        const username = typeof req.body?.username === 'string'
            ? req.body.username.trim()
            : '';

        const displayName = typeof req.body?.displayName === 'string'
            ? req.body.displayName.trim()
            : '';

        const bio = typeof req.body?.bio === 'string'
            ? req.body.bio.trim()
            : '';

        const avatar = req.body?.avatar;

        if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
            return res.status(400).json({
                error: 'Username must be 3–20 letters, numbers, or underscores.'
            });
        }

        if (displayName.length < 1 || displayName.length > 60) {
            return res.status(400).json({
                error: 'Display name must be 1–60 characters.'
            });
        }

        if (bio.length > 160) {
            return res.status(400).json({
                error: 'Bio cannot exceed 160 characters.'
            });
        }

        if (avatar !== undefined && avatar !== null) {
            if (
                typeof avatar !== 'string' ||
                avatar.length > 850000 ||
                !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(avatar)
            ) {
                return res.status(400).json({
                    error: 'Upload a valid JPEG image under the size limit.'
                });
            }
        }

        try {
            const duplicate = db.prepare(`
                SELECT id FROM users
                WHERE username = ? COLLATE NOCASE AND id != ?
            `).get(username, user.id);

            if (duplicate) {
                return res.status(409).json({
                    error: 'That username is already taken.'
                });
            }

            if (avatar === undefined) {
                db.prepare(`
                    UPDATE users
                    SET username = ?, display_name = ?, profile_bio = ?
                    WHERE id = ?
                `).run(username, displayName, bio, user.id);
            } else {
                db.prepare(`
                    UPDATE users
                    SET username = ?, display_name = ?,
                        profile_bio = ?, profile_image = ?
                    WHERE id = ?
                `).run(username, displayName, bio, avatar, user.id);
            }

            const updated = db.prepare(`
                SELECT id, username, display_name, email,
                       profile_bio, profile_image
                FROM users WHERE id = ?
            `).get(user.id);

            return res.json({
                ok: true,
                user: publicProfile(updated)
            });
        } catch (error) {
            console.error('Profile update failed:', error.message);

            return res.status(500).json({
                error: 'Could not save your profile. Please try again.'
            });
        }
    });

    return router;
};
