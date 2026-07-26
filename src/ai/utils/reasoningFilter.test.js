const test = require('node:test');
const assert = require('node:assert/strict');
const { stripInlineReasoning, extractPublicContent } = require('./reasoningFilter');

test('stripInlineReasoning removes think blocks', () => {
  const open = '<' + 'think' + '>';
  const close = '<' + '/think' + '>';
  const input = 'Hello ' + open + 'planning' + close + ' world';
  assert.equal(stripInlineReasoning(input), 'Hello  world');
});

test('stripInlineReasoning removes redacted_thinking blocks', () => {
  const input =
    '<think>Need to check inventory</think>\n\n**Inventory Summary**';
  assert.equal(stripInlineReasoning(input).trim(), '**Inventory Summary**');
});

test('extractPublicContent ignores thinking field', () => {
  const message = {
    thinking: 'Internal chain of thought',
    content: 'Your inventory has 417 units.'
  };
  assert.equal(extractPublicContent(message), 'Your inventory has 417 units.');
});
