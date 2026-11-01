'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../src/helpers');
test('changed line in middle', () => assert.deepEqual(h.lineDifference('a\nb\nc', 'a\nB\nc'), {start:1,end:1}));
test('insert new line', () => assert.deepEqual(h.lineDifference('a\nc','a\nb\nc'), {start:1,end:1}));
test('delete line', () => assert.deepEqual(h.lineDifference('a\nb\nc','a\nc'), {start:1,end:1}));
test('no change', () => assert.equal(h.lineDifference('a','a'),null));
test('file path workspace containment', () => {
  assert.equal(h.isInsideWorkspace('/tmp/code/a.js','/tmp/code'),true);
  assert.equal(h.isInsideWorkspace('/tmp/codex/a.js','/tmp/code'),false);
});

test('exclude version.json in any folder including project root', () => {
  assert.equal(h.matchesExcludedFile('version.json', ['**/version.json']), true);
  assert.equal(h.matchesExcludedFile('public/version.json', ['**/version.json']), true);
  assert.equal(h.matchesExcludedFile('src/product.js', ['**/version.json']), false);
});
test('exclude supports filename-only and nested glob patterns', () => {
  assert.equal(h.matchesExcludedFile('version.json', ['version.json']), true);
  assert.equal(h.matchesExcludedFile('src/generated/a/b.ts', ['src/generated/**']), true);
  assert.equal(h.matchesExcludedFile('src/main.ts', ['src/generated/**']), false);
  assert.equal(h.matchesExcludedFile('foo\\bar\\composer.lock', ['**/*.lock']), true);
});

test('default noisy-file patterns cover trace, cache, temporary and scratch output', () => {
  const { contributes } = require('../package.json');
  const defaults = contributes.configuration.properties['agentLiveView.excludeFiles'].default;
  const names = [
    'version.json', 'src/version.json', 'logs/runtime.log', 'debug.log.1',
    'run.trace', 'artifacts/operation.trace.json', 'traces/agent-1/events.json',
    'tmp/throwaway-test.py', 'temp/experiment.ts', 'scratchpad.py',
    'scratch-code/repro.ts', 'nested/another.swp', 'cache-output.db.cache',
    'tsconfig.tsbuildinfo'
  ];
  for (const name of names) assert.equal(h.matchesExcludedFile(name, defaults), true, `expected excluded: ${name}`);
});

test('default patterns preserve real source files and test source', () => {
  const { contributes } = require('../package.json');
  const defaults = contributes.configuration.properties['agentLiveView.excludeFiles'].default;
  const names = [
    'src/cache.ts', 'src/trace.ts', 'test/product.test.ts',
    'tests/reproduction.spec.ts', 'src/logging/logger.ts', 'src/index.js',
    'src/Product.php'
  ];
  for (const name of names) assert.equal(h.matchesExcludedFile(name, defaults), false, `should remain visible: ${name}`);
});

test('custom patterns support folder globs, filename-only matches and question marks', () => {
  assert.equal(h.matchesExcludedFile('build/generated/deep/file.ts', ['**/generated/**']), true);
  assert.equal(h.matchesExcludedFile('scratch-1/repro.py', ['**/scratch-?/**']), true);
  assert.equal(h.matchesExcludedFile('tmp123.ts', ['tmp???.ts']), true);
  assert.equal(h.matchesExcludedFile('src/source.ts', ['tmp???.ts', '**/generated/**']), false);
});


test('allowlist defaults show source file types but hide most JSON', () => {
  const props = require('../package.json').contributes.configuration.properties;
  const includes = props['agentLiveView.includeFiles'].default;
  const excludes = props['agentLiveView.excludeFiles'].default;
  const matches = name => h.isAllowedByFilePatterns(name, 'includeOnly', includes, excludes);
  for (const f of ['src/App.tsx','src/main.ts','src/Form.jsx','src/app.js','src/Product.php',
                   'templates/index.twig','src/main.css','src/style.scss','templates/home.html',
                   'tests/ItemTest.php','src/store.sql','src/backend.py']) {
    assert.equal(matches(f),true, `should show ${f}`);
  }
  for (const f of ['version.json','config/settings.json','package.json','composer.json',
                   'logs/verbose.log','dist/generated.bin','notes.md']) {
    assert.equal(matches(f),false, `should hide ${f}`);
  }
});

test('allowlist permits only selected JSON files, plus source types', () => {
  const includes=['**/*.tsx','**/*.php','**/*.twig','**/package.json','config/important.json'];
  const excludes=['**/version.json','**/scratch*','**/scratch*/**'];
  const matches = name => h.isAllowedByFilePatterns(name,'includeOnly',includes,excludes);
  assert.equal(matches('package.json'),true);
  assert.equal(matches('frontend/package.json'),true);
  assert.equal(matches('config/important.json'),true);
  assert.equal(matches('src/other.json'),false);
  assert.equal(matches('config/irrelevant.json'),false);
  assert.equal(matches('src/App.tsx'),true);
  assert.equal(matches('scratchpad.tsx'),false);
  assert.equal(matches('tmp/scratch-1/debug.php'),false);
});

test('exclusions override includes, including exact JSON allowlist entries', () => {
  const inc=['**/*.php','**/composer.json','**/*.json'];
  const exc=['**/generated/**','**/version.json','**/private.json'];
  assert.equal(h.isAllowedByFilePatterns('version.json','includeOnly',inc,exc),false);
  assert.equal(h.isAllowedByFilePatterns('generated/hello.php','includeOnly',inc,exc),false);
  assert.equal(h.isAllowedByFilePatterns('composer.json','includeOnly',inc,exc),true);
  assert.equal(h.isAllowedByFilePatterns('private.json','includeOnly',inc,exc),false);
});

test('legacy exclude-only mode ignores allowlist but respects exclusions', () => {
  assert.equal(h.isAllowedByFilePatterns('data/random.csv','excludeOnly',[],['**/version.json']),true);
  assert.equal(h.isAllowedByFilePatterns('version.json','excludeOnly',[],['**/version.json']),false);
});

test('empty allowlist in include-only mode opens no files', () => {
  assert.equal(h.isAllowedByFilePatterns('src/App.tsx','includeOnly',[],[]),false);
});

test('brace patterns match any listed alternative', () => {
  assert.equal(h.matchesExcludedFile('src/App.tsx', ['**/*.{ts,tsx}']), true);
  assert.equal(h.matchesExcludedFile('src/app.ts', ['**/*.{ts,tsx}']), true);
  assert.equal(h.matchesExcludedFile('src/app.js', ['**/*.{ts,tsx}']), false);
  assert.equal(h.matchesExcludedFile('a{b.txt', ['a{b.txt']), true, 'unclosed brace is literal');
});

test('hook entries are added once and replace older copies', () => {
  const settings = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo other' }] }] } };
  h.addHookEntries(settings, 'node "/old/agent-live-view-0.4.0/src/hook.js" "/tmp/x.jsonl"');
  h.addHookEntries(settings, 'node "/home/u/.agent-live-view/hook.js" "/home/u/.agent-live-view/events/x.jsonl"');
  for (const event of h.HOOK_EVENTS) {
    const own = settings.hooks[event].filter(g => g.hooks.some(x => h.isOwnHookCommand(x.command)));
    assert.equal(own.length, 1, event);
    assert.match(own[0].hooks[0].command, /\.agent-live-view\/hook\.js/);
  }
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'echo other', 'other hooks are kept');
  assert.equal(settings.hooks.PreToolUse[0].matcher, '.*');
});

test('removing hook entries keeps other hooks and drops empty sections', () => {
  const settings = { permissions: {}, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo other' }] }] } };
  h.addHookEntries(settings, 'node "/home/u/.agent-live-view/hook.js" "e.jsonl"');
  assert.equal(h.removeHookEntries(settings), true);
  assert.deepEqual(settings, { permissions: {}, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo other' }] }] } });
  const onlyOwn = {};
  h.addHookEntries(onlyOwn, 'node "/home/u/.agent-live-view/hook.js" "e.jsonl"');
  h.removeHookEntries(onlyOwn);
  assert.deepEqual(onlyOwn, {});
  assert.equal(h.removeHookEntries({}), false);
});

test('ownHookCommands lists only this extension\'s hooks', () => {
  const settings = { hooks: { Stop: [{ hooks: [{ command: 'echo other' }, { command: 'node "/x/agent-live-view/hook.js"' }] }] } };
  assert.deepEqual(h.ownHookCommands(settings), ['node "/x/agent-live-view/hook.js"']);
});

test('findExecutable searches PATH', () => {
  const found = h.findExecutable('node', process.env);
  assert.ok(found && require('path').isAbsolute(found));
  assert.equal(h.findExecutable('definitely-not-a-real-binary-xyz', { PATH: '/usr/bin' }, 'linux'), null);
});
