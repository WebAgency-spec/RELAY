
const express = require('express');

module.exports = function createProfileRouter(db) {
    const router = express.Router();

    function getSessionId(req) {
        const cookies = (req.headers.cookie || '').split(';');

        for (const cookie of cookies) {
            const separator = cookie.indexOf('=');
            if (separator === -1) continue;

            if (cookie.slice(0, separator).trim() === 'relay_session') {
                try {
                    return decodeURIComponent(
                        cookie.slice(separator + 1).trim()
                    );
                } catch {
                    return null;
                }
            }
        }

        return null;
    }

    async function getUser(req) {
        const sessionId = getSessionId(req);

        if (!sessionId || !/^[a-f0-9]{64}$/i.test(sessionId)) {
            return null;
        }

        const result = await db.query(
            `SELECT u.id, u.username, u.display_name, u.email,
                    u.profile_bio, u.profile_image
             FROM sessions s
             JOIN users u ON u.id = s.user_id
             WHERE s.id = $1
               AND s.expires_at > NOW()`,
            [sessionId]
        );

        return result.rows[0] || null;
    }

    function publicProfile(user) {
        return {
            id: user.id,
            username: user.username,
            displayName: user.display_name,
            email: user.email,
            bio: user.profile_bio || '',
            avatar: user.profile_image || null
        };
    }

    function handleError(res, error) {
        console.error('Profile error:', error.message);

        if (!res.headersSent) {
            res.status(500).json({
                error: 'A profile error occurred.'
            });
        }
    }

    // GET CURRENT PROFILE
    router.get('/', async (req, res) => {
        try {
            const user = await getUser(req);

            if (!user) {
                return res.status(401).json({
                    error: 'Please sign in.'
                });
            }

            return res.json({
                success: true,
                user: publicProfile(user)
            });
        } catch (error) {
            handleError(res, error);
        }
    });

    // UPDATE PROFILE
    router.put('/', async (req, res) => {
        try {
            const user = await getUser(req);

            if (!user) {
                return res.status(401).json({
                    error: 'Please sign in.'
                });
            }

            const {
                username,
                displayName,
                bio,
                avatar
            } = req.body;

            if (
                typeof username !== 'string' ||
                typeof displayName !== 'string' ||
                typeof bio !== 'string'
            ) {
                return res.status(400).json({
                    error: 'Username, display name and bio are required.'
                });
            }

            const cleanUsername = username.trim();
            const cleanDisplayName = displayName.trim();
            const cleanBio = bio.trim();

            if (!/^[a-zA-Z0-9_]{3,20}$/.test(cleanUsername)) {
                return res.status(400).json({
                    error: 'Username must be 3-20 characters and contain only letters, numbers and underscores.'
                });
            }

            if (
                cleanDisplayName.length < 1 ||
                cleanDisplayName.length > 60
            ) {
                return res.status(400).json({
                    error: 'Display name must be between 1 and 60 characters.'
                });
            }

            if (cleanBio.length > 160) {
                return res.status(400).json({
                    error: 'Bio must not exceed 160 characters.'
                });
            }

            let cleanAvatar = user.profile_image || null;

            if (avatar !== undefined) {
                if (avatar === null || avatar === '') {
                    cleanAvatar = null;
                } else if (
                    typeof avatar !== 'string' ||
                    avatar.length > 850000 ||
                    !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(avatar)
                ) {
                    return res.status(400).json({
                        error: 'Avatar must be a valid JPEG image under the size limit.'
                    });
                } else {
                    cleanAvatar = avatar;
                }
            }

            const duplicate = await db.query(
                `SELECT id
                 FROM users
                 WHERE LOWER(username) = LOWER($1)
                   AND id <> $2
                 LIMIT 1`,
                [cleanUsername, user.id]
            );

            if (duplicate.rows.length) {
                return res.status(409).json({
                    error: 'Username is already taken.'
                });
            }

            const result = await db.query(
                `UPDATE users
                 SET username = $1,
                     display_name = $2,
                     profile_bio = $3,
                     profile_image = $4
                 WHERE id = $5
                 RETURNING id, username, display_name, email,
                           profile_bio, profile_image`,
                [
                    cleanUsername,
                    cleanDisplayName,
                    cleanBio,
                    cleanAvatar,
                    user.id
                ]
            );

            return res.json({
                success: true,
                user: publicProfile(result.rows[0])
            });
        } catch (error) {
            if (error.code === '23505') {
                return res.status(409).json({
                    error: 'Username is already taken.'
                });
            }

            handleError(res, error);
        }
    });

    return router;
};
