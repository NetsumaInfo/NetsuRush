'use strict';

// The token is read when the module loads, so it is set before the require below.
process.env.NR_CORE_TOKEN = 'test-token';

const assert = require('node:assert/strict');
const test = require('node:test');
const { controlRequestAllowed, rendererOriginAllowed } = require('../core/httpSecurity');

const url = (query) => new URL(`http://127.0.0.1:8730/events${query}`);

test('the loopback control plane accepts only native or loopback renderer origins', () => {
  assert.equal(controlRequestAllowed({ host: '127.0.0.1:8730', origin: 'http://localhost:1420' }), true);
  assert.equal(controlRequestAllowed({ host: 'localhost:8730', origin: 'tauri://localhost' }), true);
  assert.equal(controlRequestAllowed({ host: '127.0.0.1:8730' }), true);
  assert.equal(controlRequestAllowed({ host: 'evil.example:8730', origin: 'https://evil.example' }), false);
  assert.equal(controlRequestAllowed({ host: '127.0.0.1:8730', origin: 'https://evil.example' }), false);
  // A sandboxed frame on a hostile page sends exactly this.
  assert.equal(rendererOriginAllowed('null'), false);
  assert.equal(controlRequestAllowed({ host: '127.0.0.1:8730', origin: 'null' }), false);
});

test('the shared token admits a caller whose origin alone would be refused', () => {
  // The Adobe CEP panel: loaded from disk by the host application, so it has no usable origin.
  assert.equal(controlRequestAllowed({ host: '127.0.0.1:8730', origin: 'null', 'x-nr-token': 'test-token' }), true);
  // EventSource sets no header; the panel passes the token in the query string instead.
  assert.equal(controlRequestAllowed({ host: '127.0.0.1:8730', origin: 'null' }, url('?tk=test-token')), true);
  assert.equal(controlRequestAllowed({ host: '127.0.0.1:8730', origin: 'null' }, url('?tk=wrong')), false);
  assert.equal(controlRequestAllowed({ host: '127.0.0.1:8730', origin: 'null', 'x-nr-token': 'wrong' }), false);
});
