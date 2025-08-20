const crypto = require('crypto');

class ValidationError extends Error {
    constructor(message, field = null, code = 'validation_error') {
        super(message);
        this.name = 'ValidationError';
        this.field = field;
        this.code = code;
        this.statusCode = 422;
    }
}

class OpenAIModels {
    static validateMessage(message) {
        if (!message || typeof message !== 'object') {
            throw new ValidationError('Message must be an object', 'message');
        }

        if (!message.role || typeof message.role !== 'string') {
            throw new ValidationError('Message role is required and must be a string', 'message.role');
        }

        const validRoles = ['system', 'user', 'assistant'];
        if (!validRoles.includes(message.role)) {
            throw new ValidationError(`Message role must be one of: ${validRoles.join(', ')}`, 'message.role');
        }

        if (!message.content) {
            throw new ValidationError('Message content is required', 'message.content');
        }

        // Handle both string and array content
        if (typeof message.content === 'string') {
            // Simple text content
            return {
                role: message.role,
                content: message.content
            };
        } else if (Array.isArray(message.content)) {
            // Multimodal content - for now, convert to text
            const textContent = message.content
                .filter(item => item.type === 'text')
                .map(item => item.text)
                .join('\n');
            
            if (!textContent) {
                throw new ValidationError('Message must contain at least one text content block', 'message.content');
            }

            return {
                role: message.role,
                content: textContent
            };
        } else {
            throw new ValidationError('Message content must be a string or array', 'message.content');
        }
    }

    static validateChatCompletionRequest(body) {
        if (!body || typeof body !== 'object') {
            throw new ValidationError('Request body must be an object');
        }

        // Validate model
        if (!body.model || typeof body.model !== 'string') {
            throw new ValidationError('Model is required and must be a string', 'model');
        }

        // Validate messages
        if (!body.messages || !Array.isArray(body.messages)) {
            throw new ValidationError('Messages is required and must be an array', 'messages');
        }

        if (body.messages.length === 0) {
            throw new ValidationError('Messages array cannot be empty', 'messages');
        }

        // Validate each message
        const validatedMessages = body.messages.map((message, index) => {
            try {
                return this.validateMessage(message);
            } catch (error) {
                throw new ValidationError(`Invalid message at index ${index}: ${error.message}`, `messages[${index}]`);
            }
        });

        // Validate optional parameters
        const validated = {
            model: body.model,
            messages: validatedMessages,
            stream: Boolean(body.stream),
            enable_tools: Boolean(body.enable_tools)
        };

        // Pass through tools and functions (to be checked later)
        if (body.tools) {
            validated.tools = body.tools;
        }
        if (body.functions) {
            validated.functions = body.functions;
        }

        // Validate temperature if provided
        if (body.temperature !== undefined) {
            if (typeof body.temperature !== 'number' || body.temperature < 0 || body.temperature > 2) {
                throw new ValidationError('Temperature must be a number between 0 and 2', 'temperature');
            }
            validated.temperature = body.temperature;
        }

        // Validate max_tokens if provided
        if (body.max_tokens !== undefined) {
            if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) {
                throw new ValidationError('max_tokens must be a positive integer', 'max_tokens');
            }
            validated.max_tokens = body.max_tokens;
        }

        // Validate top_p if provided
        if (body.top_p !== undefined) {
            if (typeof body.top_p !== 'number' || body.top_p < 0 || body.top_p > 1) {
                throw new ValidationError('top_p must be a number between 0 and 1', 'top_p');
            }
            validated.top_p = body.top_p;
        }

        // Validate n if provided
        if (body.n !== undefined) {
            if (!Number.isInteger(body.n) || body.n < 1 || body.n > 1) {
                throw new ValidationError('n must be 1 (multiple responses not supported)', 'n');
            }
            validated.n = body.n;
        }

        // Validate stop if provided
        if (body.stop !== undefined) {
            if (typeof body.stop === 'string') {
                validated.stop = [body.stop];
            } else if (Array.isArray(body.stop)) {
                if (body.stop.length > 4) {
                    throw new ValidationError('stop array cannot contain more than 4 elements', 'stop');
                }
                validated.stop = body.stop;
            } else {
                throw new ValidationError('stop must be a string or array of strings', 'stop');
            }
        }

        return validated;
    }

    static createChatCompletionResponse(request, content, usage = {}, toolCalls = null) {
        const id = `chatcmpl-${crypto.randomBytes(16).toString('hex')}`;
        const timestamp = Math.floor(Date.now() / 1000);

        const message = {
            role: 'assistant',
            content: content
        };

        // Add tool_calls if present
        if (toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0) {
            message.tool_calls = toolCalls;
        }

        return {
            id,
            object: 'chat.completion',
            created: timestamp,
            model: request.model,
            choices: [{
                index: 0,
                message,
                finish_reason: toolCalls ? 'tool_calls' : 'stop'
            }],
            usage: {
                prompt_tokens: usage.prompt_tokens || 0,
                completion_tokens: usage.completion_tokens || 0,
                total_tokens: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0)
            }
        };
    }

    static createStreamingChunk(request, delta, finishReason = null) {
        const id = `chatcmpl-${crypto.randomBytes(16).toString('hex')}`;
        const timestamp = Math.floor(Date.now() / 1000);

        return {
            id,
            object: 'chat.completion.chunk',
            created: timestamp,
            model: request.model,
            choices: [{
                index: 0,
                delta,
                finish_reason: finishReason
            }]
        };
    }

    static createErrorResponse(message, type = 'api_error', code = null) {
        return {
            error: {
                message,
                type,
                code: code || type
            }
        };
    }

    static createModelsResponse() {
        // This should never be called - models endpoint should be dynamic
        throw new Error('Dynamic models endpoint should be used instead');
    }


    static createHealthResponse() {
        return {
            status: 'healthy',
            service: 'claude-openai-wrapper',
            timestamp: new Date().toISOString()
        };
    }


    // Helper method to estimate token count (rough approximation)
    static estimateTokens(text) {
        if (!text) return 0;
        
        // Rough approximation: 1 token per 4 characters for English text
        // This is a simplified version - actual tokenization is more complex
        return Math.ceil(text.length / 4);
    }

    // Helper method to validate model name - allow any model, let Claude CLI handle validation
    static validateModel(model) {
        // Just return the model - let Claude CLI validate it
        // This allows for future models without needing to update the hardcoded list
        return model;
    }

    // Helper method to filter content (remove tool usage, thinking blocks)
    static filterContent(content) {
        if (!content || typeof content !== 'string') {
            return content;
        }

        // Remove tool usage blocks
        content = content.replace(/<function_calls>[\s\S]*?<\/antml:function_calls>/g, '');
        
        // Remove thinking blocks
        content = content.replace(/<thinking>[\s\S]*?<\/antml:thinking>/g, '');
        
        // Remove Claude Code specific markers
        content = content.replace(/\[Tool Use:.*?\]/g, '');
        content = content.replace(/\[File: .*?\]/g, '');
        
        // Clean up extra whitespace
        content = content.replace(/\n\s*\n\s*\n/g, '\n\n').trim();
        
        return content;
    }
}

module.exports = { OpenAIModels, ValidationError };