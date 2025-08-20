const { OpenAIModels } = require('../lib/models');

class HealthHandler {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
    }

    async handle(req, res) {
        try {
            const response = OpenAIModels.createHealthResponse();
            
            this.sendJSON(res, 200, response);
            
        } catch (error) {
            this.logger.error('Health endpoint error:', error);
            this.sendError(res, 500, 'Health check failed', 'health_error');
        }
    }

    sendJSON(res, statusCode, data) {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data, null, 2));
    }

    sendError(res, statusCode, message, type) {
        const errorResponse = OpenAIModels.createErrorResponse(message, type);
        this.sendJSON(res, statusCode, errorResponse);
    }
}

module.exports = HealthHandler;