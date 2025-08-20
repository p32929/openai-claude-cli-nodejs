# OpenAI-Compatible Claude API Proxy

A lightweight Node.js server that provides an OpenAI-compatible API interface for Claude CLI, allowing you to use Claude with any OpenAI-compatible client.

## Features

- **OpenAI API Compatibility**: Drop-in replacement for OpenAI's chat completions API
- **Streaming Support**: Real-time streaming responses for interactive applications
- **No Timeouts**: Requests run without artificial time limits
- **Simple Setup**: No dependencies, pure Node.js implementation
- **Stateless Design**: Each request is independent, no session management

## Prerequisites

- Node.js (v14 or higher)
- Claude CLI installed and configured ([Install Claude CLI](https://claude.ai/cli))

## Installation

1. Clone the repository:
```bash
git clone https://github.com/p32929/openai-claude-cli-nodejs.git
cd openai-claude-cli-nodejs
```

2. No npm install needed - this project has zero dependencies!

## Configuration

### Environment Variables

Create a `.env` file in the project root (optional):

```env
# Server port (default: 8000)
PORT=8000

# Enable debug logging
DEBUG=true

# Enable file logging
FILE_LOGGING=true
```

## Usage

### Start the Server

```bash
# Using default port 8000
npm start

# Or specify a custom port
PORT=3000 npm start

# With debug logging
DEBUG=true npm start
```

The server will start on `http://localhost:8000` (or your specified port).

### With Cloudflare Tunnel (for public access)

```bash
npm run tunnel
```

This will start the server and create a public URL using Cloudflare Tunnel.

## API Endpoints

### Chat Completions

**Endpoint:** `POST /v1/chat/completions`

Send messages to Claude and receive responses in OpenAI format.

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "any",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Hello, how are you?"}
    ],
    "stream": false
  }'
```

#### Streaming Example

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -N \
  -d '{
    "model": "any",
    "messages": [
      {"role": "user", "content": "Tell me a story"}
    ],
    "stream": true
  }'
```

### Tool/Function Calling

Tool and function calling is not supported. If you include `tools` or `functions` in your request, you'll receive an error:

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "any",
    "messages": [
      {"role": "user", "content": "What is the weather in Paris?"}
    ],
    "tools": [...]
  }'
```

Error response:
```json
{
  "error": {
    "message": "Tool/function calling is not supported",
    "type": "invalid_request_error"
  }
}
```

### Models List

**Endpoint:** `GET /v1/models`

Returns available models (mock response since Claude CLI doesn't enumerate models):

```bash
curl http://localhost:8000/v1/models
```

### Health Check

**Endpoint:** `GET /health`

Check if the server is running:

```bash
curl http://localhost:8000/health
```

## Supported Parameters

### Chat Completion Parameters

- `messages` (required): Array of message objects with `role` and `content`
- `model`: Model name (ignored, Claude CLI uses its default)
- `stream`: Boolean for streaming responses
- `max_tokens`: Maximum tokens in response
- `temperature`: Sampling temperature (0-1)
- `top_p`: Nucleus sampling parameter
- `stop`: Stop sequences (string or array)

## Compatible with OpenAI Clients

This API works with any OpenAI-compatible client library:
- OpenAI Python SDK
- OpenAI Node.js SDK  
- LangChain
- LlamaIndex
- And many more...

Simply point the base URL to `http://localhost:8000/v1` and use any model name (e.g., "any").

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌────────────┐
│   Client    │────▶│   API Proxy  │────▶│ Claude CLI │
│  (OpenAI    │     │   (Node.js)  │     │            │
│  Compatible)│◀────│              │◀────│            │
└─────────────┘     └──────────────┘     └────────────┘
```

The proxy:
1. Receives OpenAI-formatted requests
2. Converts them to Claude CLI format
3. Executes Claude CLI
4. Transforms responses back to OpenAI format
5. Handles streaming, tool calls, and errors

## Disclaimer

This is an unofficial proxy and is not affiliated with Anthropic or OpenAI. Use responsibly and in accordance with Claude's terms of service.