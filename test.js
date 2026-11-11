// Runnable check for the CRM API. Run: node test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('./server');

(async () => {
  const dataFile = path.join(os.tmpdir(), `crm-test-${Date.now()}.json`);
  const server = createServer(dataFile);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  let r = await call('POST', '/api/contacts', { name: 'Ava Chen', email: 'ava@example.com', channel: 'WhatsApp' });
  assert.equal(r.status, 201);
  assert.equal(r.body.stage, 'lead');
  const id = r.body.id;

  assert.equal((await call('POST', '/api/contacts', { email: 'x@y.co' })).status, 400, 'name required');
  assert.equal((await call('POST', '/api/contacts', { name: 'B', email: 'bad' })).status, 400, 'email validated');
  assert.equal((await call('PATCH', `/api/contacts/${id}`, { stage: 'nope' })).status, 400, 'stage validated');
  assert.equal((await call('PATCH', `/api/contacts/${id}`, { stage: 'customer' })).body.stage, 'customer');

  assert.equal((await call('POST', `/api/contacts/${id}/notes`, { text: 'Called back' })).status, 201);
  assert.equal((await call('GET', '/api/contacts?q=ava')).body.length, 1, 'search matches');
  assert.equal((await call('GET', '/api/contacts?stage=lead')).body.length, 0, 'stage filter');

  const s = (await call('GET', '/api/stats')).body;
  assert.equal(s.total, 1);
  assert.equal(s.customers, 1);
  assert.equal(s.conversionRate, 100);

  assert.equal((await call('DELETE', `/api/contacts/${id}`)).status, 200);
  assert.equal((await call('DELETE', `/api/contacts/${id}`)).status, 404, 'deleted contact is gone');

  server.closeAllConnections();
  server.close();
  fs.rmSync(dataFile, { force: true });
  console.log('ok: all CRM checks passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
