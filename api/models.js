const { OpenAIModels } = require('../lib/models');
const ClaudeCLI = require('../lib/claude-cli');

class ModelsHandler {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
    }

    async handle(req, res) {
        try {
            this.logger.debug('Models endpoint requested');
            
            const response = await this.getAvailableModels();
            
            this.sendJSON(res, 200, response);
            
        } catch (error) {
            this.logger.error('Models endpoint error:', error);
            this.sendError(res, 500, 'Internal server error', 'internal_error');
        }
    }

    async getAvailableModels() {
        // Get models from Claude CLI
        const discoveredModels = await this.discoverActualModels();
        
        this.logger.info(`Discovered ${discoveredModels.length} models`);
        return {
            object: 'list',
            data: discoveredModels.map(model => ({
                id: model,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: 'claude'
            }))
        };
    }

    async discoverActualModels() {
        // Claude CLI doesn't provide a models list command, so return a mock model
        this.logger.info('Claude CLI does not provide model enumeration, returning mock model');
        return ['any'];
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

module.exports = ModelsHandler;