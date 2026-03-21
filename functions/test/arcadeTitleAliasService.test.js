const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveArcadeTitleFamily,
  expandArcadeTitleAliases
} = require('../src/services/arcadeTitleAliasService');

test('resolveArcadeTitleFamily canonicalizes expert-known shorthand titles and infers manufacturers deterministically', () => {
  const cases = [
    ['Quick Drop', 'Quik Drop', 'Bay Tek'],
    ['Virtual Rabbids', 'Virtual Rabbids: The Big Ride', 'LAI Games'],
    ['King Kong VR', 'King Kong of Skull Island VR', 'Raw Thrills'],
    ['Fast and Furious', 'Fast & Furious Arcade', 'Raw Thrills'],
    ['Sink-It', 'Sink It', 'Bay Tek'],
    ['Hypershoot', 'HYPERshoot', 'LAI Games']
  ];

  cases.forEach(([inputTitle, canonicalTitle, manufacturer]) => {
    const resolved = resolveArcadeTitleFamily({ title: inputTitle });
    assert.equal(resolved.canonicalTitle, canonicalTitle);
    assert.equal(resolved.manufacturer, manufacturer);
    assert.ok(resolved.alternateTitles.length >= 1);
  });
});

test('expandArcadeTitleAliases keeps deterministic family aliases for manual lookups', () => {
  const sinkIt = expandArcadeTitleAliases(['Sink-It']);
  const kingKong = expandArcadeTitleAliases(['King Kong VR']);

  assert.equal(sinkIt.includes('Sink It Shootout'), true);
  assert.equal(kingKong.includes('King Kong of Skull Island VR'), true);
});
