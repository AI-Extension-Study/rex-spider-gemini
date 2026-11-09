import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bardErrorCodes, batchBody, batchUrl, pageToken, rpcFrames } from '../../src/wire.mts';
import { batchResponse, wrb, wrbError } from './batch.mts';

test('batchUrl builds the query the spider sends', () => {
  assert.equal(
    batchUrl('MaZiqc', 123456),
    'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=MaZiqc&hl=en&rt=c&_reqid=123456',
  );
});

test('batchBody encodes the request the spider sends, f.req before at', () => {
  const body = batchBody('MaZiqc', [10, null, [0, null, 1]], 'TOKEN');
  assert.equal(body.toString(), 'f.req=%5B%5B%5B%22MaZiqc%22%2C%22%5B10%2Cnull%2C%5B0%2Cnull%2C1%5D%5D%22%2Cnull%2C%22generic%22%5D%5D%5D&at=TOKEN');
  assert.equal(body.get('f.req'), '[[["MaZiqc","[10,null,[0,null,1]]",null,"generic"]]]');
});

test('rpcFrames gives the payload of each frame for the rpcid, skipping other rpcids and lines that are not JSON', () => {
  const body = `${batchResponse(wrb('ESY5D', [1]), wrb('MaZiqc', [null, null, []]))}[[not json\n`;
  assert.deepEqual(rpcFrames(body, 'MaZiqc'), [{ kind: 'payload', value: [null, null, []] }]);
});

test('rpcFrames reports a frame with no payload string as an error carrying its status code', () => {
  assert.deepEqual(rpcFrames(batchResponse(wrbError('MaZiqc', 3)), 'MaZiqc'), [{ kind: 'error', code: 3 }]);
});

test('rpcFrames reports a payload string that is not JSON as an error without a code', () => {
  const body = batchResponse(['wrb.fr', 'MaZiqc', '[null,', null, null, null, 'generic']);
  assert.deepEqual(rpcFrames(body, 'MaZiqc'), [{ kind: 'error', code: null }]);
});

test('rpcFrames answers null for a body without the batchexecute guard, such as an HTML page', () => {
  assert.equal(rpcFrames('<!doctype html><title>Sign in</title>', 'MaZiqc'), null);
});

test('rpcFrames answers no frames for a response that carries none for the rpcid', () => {
  assert.deepEqual(rpcFrames(batchResponse(wrb('ESY5D', [1])), 'MaZiqc'), []);
});

test('bardErrorCodes reads every BardErrorInfo code in order, and none without one', () => {
  const info = (code: number) => `[["type.googleapis.com/assistant.boq.bard.application.BardErrorInfo",[${code}]]]`;
  const body = `)]}'\n\n120\n[["wrb.fr","MaZiqc",null,null,null,[16],"generic",${info(7)}],["wrb.fr","MaZiqc",null,null,null,[16],"generic",${info(1096)}]]\n`;
  assert.deepEqual(bardErrorCodes(body), [7, 1096]);
  assert.deepEqual(bardErrorCodes(batchResponse(wrb('MaZiqc', [null, null, []]))), []);
});

test('pageToken reads the SNlM0e value from the homepage, and is null without one', () => {
  assert.equal(pageToken('<script>WIZ_global_data = {"FdrFJe":"1","SNlM0e":"AbCd-123:1700000000000","x":2};</script>'), 'AbCd-123:1700000000000');
  for (const html of ['<html>Sign in</html>', '{"SNlM0e":""}', '{"SNlM0e":', '{"SNlM0e":"no-closing-quote', '']) {
    assert.equal(pageToken(html), null, JSON.stringify(html));
  }
});
