class MessageAdapter {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
    }

    // Convert OpenAI messages to Claude prompt format
    messagesToClaudePrompt(messages, hasTools = false, tools = []) {
        let systemPrompt = '';
        let conversationPrompt = '';
        
        // Process messages in order
        for (const message of messages) {
            switch (message.role) {
                case 'system':
                    // Collect all system messages
                    systemPrompt += message.content + '\n';
                    break;
                    
                case 'user':
                    conversationPrompt += `Human: ${message.content}\n\n`;
                    break;
                    
                case 'assistant':
                    conversationPrompt += `Assistant: ${message.content}\n\n`;
                    break;
                    
                default:
                    this.logger.warn(`Unknown message role: ${message.role}`);
                    break;
            }
        }

        // Add tool handling instruction to system prompt if tools are present
        if (hasTools && tools.length > 0) {
            let toolInstruction = `\n\nYou have access to the following tools/functions:\n\n`;
            
            // List available tools
            for (const tool of tools) {
                if (tool.function) {
                    toolInstruction += `- ${tool.function.name}: ${tool.function.description || 'No description'}\n`;
                    if (tool.function.parameters) {
                        toolInstruction += `  Parameters: ${JSON.stringify(tool.function.parameters)}\n`;
                    }
                }
            }
            
            toolInstruction += `\nWhen you determine a tool should be used, respond with ONLY this JSON format (no other text):
{
  "tool_calls": [
    {
      "id": "call_${Date.now()}_${Math.random().toString(36).substring(2, 11)}",
      "type": "function",
      "function": {
        "name": "exact_tool_name",
        "arguments": "{\\"param\\": \\"value\\"}"
      }
    }
  ],
  "content": null
}

IMPORTANT: If the user's request requires using one of these tools (like asking about weather when you have get_weather), you MUST return the JSON above. Do not say you cannot access it.`;
            
            systemPrompt = (systemPrompt + toolInstruction).trim();
        }

        // Ensure conversation ends with Human prompt
        const lastMessage = messages[messages.length - 1];
        if (lastMessage && lastMessage.role !== 'user') {
            conversationPrompt += 'Human: Please continue.\n\n';
        }

        return {
            systemPrompt: systemPrompt.trim() || null,
            prompt: conversationPrompt.trim()
        };
    }

    // Convert Claude response back to OpenAI format
    claudeResponseToOpenAI(claudeOutput, requestModel, hasTools = false) {
        // Parse and clean Claude output
        const cleanedContent = this.parseClaudeOutput(claudeOutput);
        
        // If tools were provided, check if response contains tool calls
        if (hasTools) {
            try {
                // Try to parse as JSON first
                const parsed = JSON.parse(cleanedContent);
                if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
                    // Return in OpenAI tool call format
                    return {
                        role: 'assistant',
                        content: parsed.content || null,
                        tool_calls: parsed.tool_calls
                    };
                }
            } catch (e) {
                // Not JSON or doesn't have tool_calls, treat as regular text
                this.logger.debug('Response is not tool call JSON, treating as regular text');
            }
        }
        
        return {
            role: 'assistant',
            content: cleanedContent
        };
    }

    // Parse Claude CLI output and extract assistant content
    parseClaudeOutput(output) {
        if (!output) {
            return '';
        }

        let content = '';
        
        if (typeof output === 'string') {
            content = output;
        } else if (typeof output === 'object') {
            content = this.extractContentFromObject(output);
        } else {
            this.logger.warn('Unexpected Claude output type:', typeof output);
            content = String(output);
        }

        // Clean and filter the content
        return this.filterAndCleanContent(content);
    }

    extractContentFromObject(obj) {
        // Handle different Claude CLI output formats
        
        if (obj.type === 'assistant' && obj.message) {
            // Format: { type: 'assistant', message: { content: [...] } }
            return this.extractContent(obj.message.content);
        }
        
        if (obj.content) {
            // Format: { content: [...] } or { content: "text" }
            return this.extractContent(obj.content);
        }
        
        if (obj.text) {
            // Format: { text: "content" }
            return obj.text;
        }
        
        if (obj.message && obj.message.content) {
            // Nested message format
            return this.extractContent(obj.message.content);
        }
        
        // Fallback to JSON string
        return JSON.stringify(obj);
    }

    extractContent(content) {
        if (typeof content === 'string') {
            return content;
        }
        
        if (Array.isArray(content)) {
            let extractedText = '';
            
            for (const block of content) {
                if (typeof block === 'string') {
                    extractedText += block;
                } else if (block && typeof block === 'object') {
                    // Handle TextBlock objects and similar structures
                    if (block.text) {
                        extractedText += block.text;
                    } else if (block.type === 'text' && block.text) {
                        extractedText += block.text;
                    } else if (block.content) {
                        extractedText += this.extractContent(block.content);
                    }
                }
            }
            
            return extractedText;
        }
        
        if (content && typeof content === 'object') {
            return this.extractContentFromObject(content);
        }
        
        return String(content);
    }

    filterAndCleanContent(content) {
        if (!content || typeof content !== 'string') {
            return content || '';
        }

        // Remove Claude Code tool usage blocks
        let filtered = content.replace(/<function_calls>[\s\S]*?<\/antml:function_calls>/g, '');
        
        // Remove thinking blocks
        filtered = filtered.replace(/<thinking>[\s\S]*?<\/antml:thinking>/g, '');
        
        // Remove Claude Code specific markers and headers
        filtered = filtered.replace(/\[Tool Use:.*?\]/g, '');
        filtered = filtered.replace(/\[File: .*?\]/g, '');
        filtered = filtered.replace(/\[Command: .*?\]/g, '');
        
        // Remove common Claude CLI prefixes
        filtered = filtered.replace(/^Assistant:\s*/gm, '');
        filtered = filtered.replace(/^Human:\s*/gm, '');
        
        // Remove multiple consecutive newlines but preserve intentional formatting
        filtered = filtered.replace(/\n\s*\n\s*\n/g, '\n\n');
        
        // Trim whitespace
        filtered = filtered.trim();
        
        return filtered;
    }

    // Convert OpenAI streaming format to Claude format
    openAIStreamToClaudeOptions(request) {
        const mappedModel = this.mapModelName(request.model);
        const options = {
            stream: Boolean(request.stream)
        };
        
        // Only add model if mapping returned a value
        if (mappedModel) {
            options.model = mappedModel;
        }

        // Map OpenAI parameters to Claude options where possible
        if (request.max_tokens) {
            // Claude uses different parameter names
            options.maxTokens = request.max_tokens;
        }

        if (request.temperature !== undefined) {
            // Note: Claude may not support all OpenAI temperature ranges
            options.temperature = Math.max(0, Math.min(1, request.temperature));
        }

        if (request.top_p !== undefined) {
            options.topP = request.top_p;
        }

        if (request.stop) {
            options.stopSequences = Array.isArray(request.stop) ? request.stop : [request.stop];
        }

        // Handle tools setting - but don't pass them to Claude CLI
        // We want Claude to return JSON for tool calls, not execute them
        if (request.tools && request.tools.length > 0) {
            this.logger.info(`Request includes ${request.tools.length} tools, but will instruct Claude to return JSON instead of executing`);
            
            // Extract tool names for logging
            const toolNames = request.tools.map(tool => tool.name);
            this.logger.info('Tools requested (will be returned as JSON):', toolNames);
            
            // Don't pass allowedTools to Claude CLI - we want JSON responses instead
            // The system prompt will instruct Claude to return tool calls as JSON
        } else {
            this.logger.info('No tools in request, basic chat mode');
            // Don't limit turns for basic chat - let Claude respond fully
        }

        return options;
    }

    // Validate OpenAI message format and convert problematic content
    normalizeOpenAIMessage(message) {
        const normalized = {
            role: message.role,
            content: this.normalizeMessageContent(message.content)
        };

        // Handle message metadata if present
        if (message.name) {
            normalized.name = message.name;
        }

        return normalized;
    }

    normalizeMessageContent(content) {
        if (typeof content === 'string') {
            return content;
        }

        if (Array.isArray(content)) {
            // Handle multimodal content - extract text parts only
            let textContent = '';
            
            for (const part of content) {
                if (part.type === 'text' && part.text) {
                    textContent += part.text + '\n';
                } else if (part.type === 'image_url') {
                    // Convert image references to text placeholders
                    textContent += '[Image provided but not displayed in text mode]\n';
                }
            }
            
            return textContent.trim();
        }

        // Convert other types to string
        return String(content);
    }

    // Estimate token count (rough approximation)
    estimateTokens(text) {
        if (!text || typeof text !== 'string') {
            return 0;
        }
        
        // Rough approximation: 1 token per 4 characters for English text
        // This is simplified - actual tokenization is more complex
        const charCount = text.length;
        const tokenEstimate = Math.ceil(charCount / 4);
        
        // Add some overhead for special tokens and formatting
        return Math.max(1, tokenEstimate);
    }

    // Create usage statistics for response
    createUsageStats(prompt, completion) {
        const promptTokens = this.estimateTokens(prompt);
        const completionTokens = this.estimateTokens(completion);
        
        return {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens
        };
    }

    // Helper method to validate message conversation flow
    validateMessageFlow(messages) {
        const issues = [];
        
        if (messages.length === 0) {
            issues.push('Messages array is empty');
            return issues;
        }

        // Check for alternating pattern
        let expectingUser = true;
        let systemMessagesSeen = 0;
        
        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            
            if (message.role === 'system') {
                systemMessagesSeen++;
                if (i !== 0 && systemMessagesSeen === 1) {
                    issues.push('System message should be first message');
                }
                continue;
            }
            
            if (message.role === 'user') {
                if (!expectingUser && i > 0) {
                    issues.push(`Unexpected user message at position ${i} (expected assistant)`);
                }
                expectingUser = false;
            } else if (message.role === 'assistant') {
                if (expectingUser) {
                    issues.push(`Unexpected assistant message at position ${i} (expected user)`);
                }
                expectingUser = true;
            }
        }

        // Last message should typically be from user
        const lastMessage = messages[messages.length - 1];
        if (lastMessage.role !== 'user') {
            issues.push('Conversation should typically end with user message');
        }

        return issues;
    }

    // Map OpenAI model names to Claude CLI model names
    mapModelName(modelName) {
        this.logger.info(`Using model: ${modelName} (not passed to Claude CLI)`);
        
        // Never pass model parameter to Claude CLI, let it use default
        return null;
    }

    // Log message processing for debugging
    logMessageProcessing(messages, prompt, systemPrompt) {
        if (this.config.isDebugEnabled()) {
            this.logger.debug('Message processing details:', {
                input_messages: messages.length,
                system_prompt_length: systemPrompt ? systemPrompt.length : 0,
                conversation_prompt_length: prompt.length,
                estimated_tokens: this.estimateTokens(prompt + (systemPrompt || ''))
            });
        }
    }
}

module.exports = MessageAdapter;