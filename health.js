
const express = require('express');

module.exports = function createHealthRouter(db) {
    const router = express.Router();

    router.get('/health', (req, res) => {
        try {
            const result = db.prepare('SELECT 1 AS ok').get();

            res.json({
                status: 'ONLINE',
                database: result.ok === 1 ? 'CONNECTED' : 'ERROR',
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            res.status(500).json({
                status: 'ERROR',
                database: 'DISCONNECTED'
            });
        }
    });

    return router;
};
