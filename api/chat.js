const { OpenAIModels, ValidationError } = require('../lib/models');
const ClaudeCLI = require('../lib/claude-cli');
const MessageAdapter = require('../lib/message-adapter');
const { StreamingManager } = require('../lib/streaming');

class ChatHandler {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        this.claudeCLI = new ClaudeCLI(config, logger);
        this.messageAdapter = new MessageAdapter(config, logger);
        this.streamingManager = new StreamingManager(config, logger);
    }

    async handle(req, res) {
        const startTime = Date.now();

        try {
            // Validate request body
            const validatedRequest = OpenAIModels.validateChatCompletionRequest(req.body);
            
            this.logger.info(`Chat completion request: model=${validatedRequest.model}, streaming=${validatedRequest.stream}`);
            
            if (validatedRequest.stream) {
                await this.handleStreamingRequest(validatedRequest, req, res);
            } else {
                await this.handleNonStreamingRequest(validatedRequest, req, res);
            }

        } catch (error) {
            this.logger.logError(error, 'chat_completion');
            
            if (error instanceof ValidationError) {
                this.sendError(res, error.statusCode, error.message, error.code);
            } else if (error.statusCode) {
                this.sendError(res, error.statusCode, error.message, error.type || 'api_error');
            } else {
                this.sendError(res, 500, 'Internal server error', 'internal_error');
            }
        } finally {
            const duration = Date.now() - startTime;
            this.logger.logPerformance('chat_completion', duration);
        }
    }

    async handleStreamingRequest(request, req, res) {
        // Check if tools/functions are provided - not supported
        if ((request.tools && request.tools.length > 0) || (request.functions && request.functions.length > 0)) {
            this.sendError(res, 400, 'Tool/function calling is not supported', 'invalid_request_error');
            return;
        }
        
        // Create streaming response
        const stream = this.streamingManager.createStream(res, request);
        
        
        // For logging streaming response
        let streamedContent = '';
        
        try {
            // Convert messages to Claude prompt format - no session management
            const hasTools = false;
            const { systemPrompt, prompt } = this.messageAdapter.messagesToClaudePrompt(request.messages, hasTools, request.tools || []);
            
            this.messageAdapter.logMessageProcessing(request.messages, prompt, systemPrompt);

            // Prepare Claude options
            const claudeOptions = this.messageAdapter.openAIStreamToClaudeOptions(request);
            claudeOptions.systemPrompt = systemPrompt;
            claudeOptions.stream = true;

            // Log tool configuration
            if (request.enable_tools) {
                this.logger.info('Tools enabled for streaming request');
            } else {
                this.logger.info('Tools disabled for OpenAI compatibility (streaming)');
            }

            // Start Claude CLI streaming
            const claudeStream = this.claudeCLI.streamingCompletion(prompt, claudeOptions);
            
            // Process stream and send chunks to client
            await this.streamingManager.processClaudeStream(
                claudeStream, 
                stream,
                (content) => {
                    // Callback to accumulate streamed content for logging
                    streamedContent += content;
                }
            );
            
            // Log Claude interaction for streaming if requestId is available
            if (req.requestId) {
                this.logger.logClaudeInteraction(prompt, streamedContent, req.requestId, true);
            }

        } catch (error) {
            this.logger.error('Streaming request error:', error);
            
            if (!stream.isClosed()) {
                stream.writeError(error);
            }
        } finally {
            
            if (!stream.isClosed()) {
                stream.end();
            }
        }
    }

    async handleNonStreamingRequest(request, req, res) {
        // Check if tools/functions are provided - not supported
        if ((request.tools && request.tools.length > 0) || (request.functions && request.functions.length > 0)) {
            this.logger.warn('Tool/function calling attempted but not supported');
            this.logger.debug('Request had tools:', request.tools);
            this.sendError(res, 400, 'Tool/function calling is not supported', 'invalid_request_error');
            return;
        }
        
        try {
            // Convert messages to Claude prompt format - no session management
            const hasTools = false;
            const { systemPrompt, prompt } = this.messageAdapter.messagesToClaudePrompt(request.messages, hasTools, request.tools || []);
            
            this.messageAdapter.logMessageProcessing(request.messages, prompt, systemPrompt);

            // Prepare Claude options
            const claudeOptions = this.messageAdapter.openAIStreamToClaudeOptions(request);
            claudeOptions.systemPrompt = systemPrompt;
            claudeOptions.stream = false;

            // Log tool configuration
            if (request.enable_tools) {
                this.logger.info('Tools enabled for non-streaming request');
            } else {
                this.logger.info('Tools disabled for OpenAI compatibility (non-streaming)');
            }

            // Execute Claude CLI
            const result = await this.claudeCLI.completion(prompt, claudeOptions);
            
            // Log Claude interaction if requestId is available
            if (req.requestId) {
                this.logger.logClaudeInteraction(prompt, result.output, req.requestId, false);
            }
            
            // Parse and clean the response
            const assistantMessage = this.messageAdapter.claudeResponseToOpenAI(
                result.output, 
                request.model,
                hasTools
            );

            // No session management - stateless proxy

            // Create usage statistics
            const usage = this.messageAdapter.createUsageStats(prompt, assistantMessage.content || '');

            // Create and send response
            const response = OpenAIModels.createChatCompletionResponse(
                request, 
                assistantMessage.content, 
                usage,
                assistantMessage.tool_calls
            );
            
            this.sendJSON(res, 200, response);

        } catch (error) {
            throw error; // Re-throw to be handled by main error handler
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

module.exports = ChatHandler;