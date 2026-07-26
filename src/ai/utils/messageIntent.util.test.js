const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyUserIntent } = require('./messageIntent.util');

test('classifyUserIntent detects social messages', () => {
  assert.equal(classifyUserIntent('Hi'), 'social');
  assert.equal(classifyUserIntent('Hello!'), 'social');
  assert.equal(classifyUserIntent('Good morning'), 'social');
  assert.equal(classifyUserIntent('How are you?'), 'social');
  assert.equal(classifyUserIntent('Thanks'), 'social');
  assert.equal(classifyUserIntent('Bye'), 'social');
});

test('classifyUserIntent detects business messages', () => {
  assert.equal(classifyUserIntent('How many doctors do I have?'), 'business');
  assert.equal(classifyUserIntent('Show inventory.'), 'business');
  assert.equal(classifyUserIntent('Inventory overview.'), 'business');
  assert.equal(classifyUserIntent('Team performance this month'), 'business');
});

test('classifyUserIntent prefers business when ERP keywords present', () => {
  assert.equal(classifyUserIntent('Good morning, show inventory'), 'business');
  assert.equal(classifyUserIntent('Hi, how many doctors do we have'), 'business');
});
