# WorkStacean

## Pi SDK CLI 

createAgentSession() embedded in a TS script. Stdin in, stdout out CLI. Tools: just bash + read + write to start. Consume OpenAI-compat endpoint (llama cpp expected by default btw). Thinking mode off by default, togglable per-call.

## Signal bridge

bbernhard container up, linked to your number. Tiny TS process: WebSocket listener → calls session.prompt() → onBlockReply → POSTs text back via signal-cli REST. 

## Voice

Voice notes get routed through the whisper skill before hitting Pi. Kokoro reply is optional here — text first, voice later.