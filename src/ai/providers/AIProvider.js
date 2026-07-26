/**
 * @typedef {Object} AiChatMessage
 * @property {'system'|'user'|'assistant'|'tool'} role
 * @property {string} [content]
 * @property {string} [tool_call_id]
 * @property {string} [name]
 * @property {Array<{id?: string, type?: string, function?: {name: string, arguments: string|object}}>} [tool_calls]
 */

/**
 * @typedef {Object} AiToolSchema
 * @property {string} name
 * @property {string} description
 * @property {object} parameters JSON Schema object
 */

/**
 * @typedef {Object} AiChatResult
 * @property {string} content
 * @property {Array<{id: string, name: string, arguments: object}>} toolCalls
 * @property {boolean} done
 */

/**
 * @interface AIProvider
 * @property {() => string} getName
 * @property {() => string} getModel
 * @property {() => boolean} supportsTools
 * @property {() => boolean} supportsVision
 * @property {() => boolean} supportsReasoning
 * @property {(messages: AiChatMessage[], tools?: AiToolSchema[]) => Promise<AiChatResult>} chat
 * @property {(messages: AiChatMessage[], tools: AiToolSchema[]|undefined, onEvent: (event: object) => void) => Promise<AiChatResult>} stream
 */

module.exports = {};
