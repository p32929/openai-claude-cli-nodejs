#!/usr/bin/env node

const http = require('http');
const url = require('url');
const { promisify } = require('util');

// Import our modules
const Router = require('./lib/router');
const Logger = require('./lib/logger');
const Config = require('./lib/config');
// Removed SessionManager - using stateless proxy approach

// Import API handlers
const ChatHandler = require('./api/chat');
const ModelsHandler = require('./api/models');
const HealthHandler = require('./api/health');

// Import utility classes
const { ValidationError } = require('./lib/models');

class OpenAIClaudeServer {
    constructor() {
        this.config = new Config();
        this.logger = new Logger(this.config);
        this.router = new Router();
        
        this.setupRoutes();
        this.server = null;
    }

    setupRoutes() {
        // Chat completions endpoint - stateless proxy
        this.router.post('/v1/chat/completions', async (req, res) => {
            const handler = new ChatHandler(this.config, this.logger);
            return handler.handle(req, res);
        });

        // Models endpoint
        this.router.get('/v1/models', async (req, res) => {
            const handler = new ModelsHandler(this.config, this.logger);
            return handler.handle(req, res);
        });

        // Health check
        this.router.get('/health', async (req, res) => {
            const handler = new HealthHandler(this.config, this.logger);
            return handler.handle(req, res);
        });
    }

    async start() {
        // Create HTTP server
        this.server = http.createServer(async (req, res) => {
            await this.handleRequest(req, res);
        });

        const port = this.config.port;
        const host = this.config.host;

        return new Promise((resolve, reject) => {
            this.server.listen(port, host, (err) => {
                if (err) {
                    reject(err);
                } else {
                    this.logger.info(`🚀 Claude OpenAI API Server running on http://${host}:${port}`);
                    this.logger.info(`🐛 Debug mode: ${this.config.debugMode ? 'ON' : 'OFF'}`);
                    this.logger.info(`📁 File logging: ${this.config.fileLogging ? 'ON' : 'OFF'}`);
                    this.logger.info(`📋 Available endpoints:`);
                    this.logger.info(`   POST /v1/chat/completions - Main chat endpoint`);
                    this.logger.info(`   GET  /v1/models - List available models`);
                    this.logger.info(`   GET  /health - Health check`);
                    resolve();
                }
            });
        });
    }

    async handleRequest(req, res) {
        const startTime = Date.now();
        let requestId;
        
        try {
            // Add CORS headers
            this.addCorsHeaders(res);
            
            // Handle OPTIONS request for CORS preflight
            if (req.method === 'OPTIONS') {
                res.writeHead(200);
                res.end();
                return;
            }

            // Parse URL and query
            const parsedUrl = url.parse(req.url, true);
            req.pathname = parsedUrl.pathname;
            req.query = parsedUrl.query;

            // Parse request body for POST/PUT requests
            if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
                req.body = await this.parseRequestBody(req);
            }

            // Log request data to file
            requestId = this.logger.logRequestData(req);
            
            // Add requestId to request for handlers to use
            req.requestId = requestId;

            // Intercept response to capture data
            const originalEnd = res.end;
            const originalWrite = res.write;
            let responseData = '';

            res.write = function(chunk) {
                if (chunk) {
                    responseData += chunk;
                }
                return originalWrite.call(this, chunk);
            };

            res.end = function(chunk) {
                if (chunk) {
                    responseData += chunk;
                }
                // Log response data to file
                try {
                    const parsedResponse = responseData ? JSON.parse(responseData) : null;
                    res.logger.logResponseData(res, parsedResponse, requestId);
                } catch (e) {
                    // If response is not JSON, log as string
                    res.logger.logResponseData(res, responseData, requestId);
                }
                return originalEnd.call(this, chunk);
            };

            // Add logger reference to response object
            res.logger = this.logger;

            // Route the request
            const result = await this.router.route(req, res);
            
            if (!result.handled) {
                this.sendError(res, 404, 'Not Found', 'not_found');
            }

        } catch (error) {
            this.logger.logError(error, 'request_handling');
            
            if (error instanceof ValidationError) {
                this.sendValidationError(res, error);
            } else if (error.statusCode) {
                this.sendError(res, error.statusCode, error.message, error.type || 'api_error');
            } else {
                this.sendError(res, 500, 'Internal Server Error', 'internal_error');
            }
        } finally {
            // Log request completion
            this.logger.logRequest(req, res, startTime);
        }
    }

    async parseRequestBody(req) {
        return new Promise((resolve, reject) => {
            let body = '';
            req.on('data', chunk => {
                body += chunk.toString();
            });
            req.on('end', () => {
                try {
                    const parsed = body ? JSON.parse(body) : {};
                    resolve(parsed);
                } catch (error) {
                    reject(new Error('Invalid JSON in request body'));
                }
            });
            req.on('error', reject);
        });
    }

    addCorsHeaders(res) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Claude-*');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    sendError(res, statusCode, message, type) {
        const errorResponse = {
            error: {
                message,
                type,
                code: statusCode.toString()
            }
        };

        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errorResponse, null, 2));
    }

    sendValidationError(res, error) {
        const errorResponse = {
            error: {
                message: error.message,
                type: 'validation_error',
                code: 'invalid_request_error',
                field: error.field || null
            }
        };

        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errorResponse, null, 2));
    }

    async stop() {
        if (this.server) {
            await promisify(this.server.close.bind(this.server))();
            this.logger.info('Server stopped');
        }
    }
}

// CLI entry point
if (require.main === module) {
    async function main() {
        try {
            // Create and start server
            const server = new OpenAIClaudeServer();
            
            // Handle graceful shutdown
            process.on('SIGINT', async () => {
                console.log('\n🛑 Shutting down gracefully...');
                await server.stop();
                process.exit(0);
            });

            process.on('SIGTERM', async () => {
                console.log('\n🛑 Shutting down gracefully...');
                await server.stop();
                process.exit(0);
            });

            // Start server
            await server.start();
            
        } catch (error) {
            console.error('❌ Failed to start server:', error);
            process.exit(1);
        }
    }

    main();
}

module.exports = OpenAIClaudeServer;