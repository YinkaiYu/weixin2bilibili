import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSourceLink} from '../extension/lib/source-links.js';

test('source URLs preserve the original protocol, path, query and fragment',()=>{
  assert.equal(normalizeSourceLink(' HTTP://Example.org:80/paper?q=one%20two#section '),'http://example.org/paper?q=one%20two#section');
  assert.equal(normalizeSourceLink('https://example.org/论文'),'https://example.org/%E8%AE%BA%E6%96%87');
  assert.equal(normalizeSourceLink('https://example.org:8443/paper'),'https://example.org:8443/paper');
});

test('source URLs reject credentials, non-HTTP protocols, malformed and parser-repaired addresses',()=>{
  for(const value of [null,{},'', '//example.org/a','/paper','javascript:alert(1)','data:text/html,x','file:///paper','ftp://example.org/paper',
    'https:example.org','http:///paper','https://user:secret@example.org/paper','https://user@example.org/paper','https://example.org/a b',
    'https://example.org/\npath','https://example.org/\u0000path','https://example.org/\\paper','https://example.org/%xx','https://example.org:99999/paper']) {
    assert.equal(normalizeSourceLink(value),'',String(value));
  }
});
