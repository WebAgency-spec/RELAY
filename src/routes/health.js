
const express = require('express');

module.exports = function createHealthRouter(db) {
    const router = express.Router();

    router.get('/health', async (req, res) => {
        try {
            const result = await db.query('SELECT 1 AS ok');

            res.json({
                status: 'ONLINE',
                database: result.rows[0].ok === 1 ? 'CONNECTED' : 'ERROR',
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error('Health check failed:', error.message);

            res.status(500).json({
                status: 'ERROR',
                database: 'DISCONNECTED'
            });
        }
    });

    return router;
};
