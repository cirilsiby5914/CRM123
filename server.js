// EngageFlow-style CRM backend. Zero dependencies: node:http + a JSON file.
// ponytail: one process, whole-file rewrite per write. Ceiling: a few thousand
// contacts and a single writer. Upgrade path: node:sqlite when that stops being true.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STAGES = ['lead', 'contacted', 'qualified', 'customer', 'lost'];
const CHANNELS = ['WhatsApp', 'Instagram', 'Messenger', 'Telegram', 'Email', 'Website', 'YouTube', 'LinkedIn', 'Phone', 'Other'];
const INDEX_HTML = path.join(__dirname, 'index.html');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function loadStore(file) {
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { contacts: [] };
  return {
    contacts: data.contacts,
    save() {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, file); // atomic swap: a crash mid-write can't corrupt the file
    },
  };
}

function validate(input, partial = false) {
  const errors = [];
  const out = {};
  for (const key of ['name', 'email', 'phone', 'company']) {
    if (input[key] !== undefined) out[key] = String(input[key]).trim();
  }
  if ((!partial || 'name' in input) && !out.name) errors.push('name is required');
  if (out.name && out.name.length > 120) errors.push('name must be 120 characters or fewer');
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) errors.push('email is invalid');
  if (input.stage !== undefined) {
    if (STAGES.includes(input.stage)) out.stage = input.stage;
    else errors.push('stage is invalid');
  }
  if (input.channel !== undefined) {
    if (CHANNELS.includes(input.channel)) out.channel = input.channel;
    else errors.push('channel is invalid');
  }
  if (input.tags !== undefined) {
    if (Array.isArray(input.tags) && input.tags.every(t => typeof t === 'string')) {
      out.tags = input.tags.map(t => t.trim()).filter(Boolean);
    } else errors.push('tags must be an array of strings');
  }
  return { errors, value: out };
}

function stats(contacts) {
  const byStage = Object.fromEntries(STAGES.map(s => [s, 0]));
  const byChannel = {};
  for (const c of contacts) {
    byStage[c.stage]++;
    byChannel[c.channel] = (byChannel[c.channel] || 0) + 1;
  }
  const total = contacts.length;
  return {
    total,
    byStage,
    byChannel,
    customers: byStage.customer,
    conversionRate: total ? Math.round((byStage.customer / total) * 100) : 0,
  };
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        req.destroy();
        reject(new HttpError(413, 'body too large'));
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        resolve(parsed);
      } catch {
        reject(new HttpError(400, 'invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

async function api(req, url, store) {
  const [resource, id, action] = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const { contacts } = store;

  if (resource === 'stats' && req.method === 'GET') return [200, stats(contacts)];
  if (resource !== 'contacts') throw new HttpError(404, 'not found');

  if (!id) {
    if (req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const stage = url.searchParams.get('stage');
      return [200, contacts.filter(c =>
        (!stage || c.stage === stage) &&
        (!q || [c.name, c.email, c.company].some(v => (v || '').toLowerCase().includes(q))))];
    }
    if (req.method === 'POST') {
      const { errors, value } = validate(await readBody(req));
      if (errors.length) throw new HttpError(400, errors.join('; '));
      const now = new Date().toISOString();
      const contact = {
        id: crypto.randomUUID(), stage: 'lead', channel: 'Other', tags: [], notes: [],
        ...value, createdAt: now, updatedAt: now,
      };
      contacts.push(contact);
      store.save();
      return [201, contact];
    }
    throw new HttpError(405, 'method not allowed');
  }

  const contact = contacts.find(c => c.id === id);
  if (!contact) throw new HttpError(404, 'contact not found');

  if (!action) {
    if (req.method === 'PATCH') {
      const { errors, value } = validate(await readBody(req), true);
      if (errors.length) throw new HttpError(400, errors.join('; '));
      Object.assign(contact, value, { updatedAt: new Date().toISOString() });
      store.save();
      return [200, contact];
    }
    if (req.method === 'DELETE') {
      contacts.splice(contacts.indexOf(contact), 1);
      store.save();
      return [200, { ok: true }];
    }
  }

  if (action === 'notes' && req.method === 'POST') {
    const text = String((await readBody(req)).text ?? '').trim();
    if (!text) throw new HttpError(400, 'text is required');
    if (text.length > 2000) throw new HttpError(400, 'note must be 2000 characters or fewer');
    const note = { id: crypto.randomUUID(), text, at: new Date().toISOString() };
    contact.notes.push(note);
    contact.updatedAt = note.at;
    store.save();
    return [201, note];
  }

  throw new HttpError(405, 'method not allowed');
}

function createServer(file = path.join(__dirname, 'data.json')) {
  const store = loadStore(file);
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        const [status, body] = await api(req, url, store);
        return send(res, status, body);
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return fs.createReadStream(INDEX_HTML).pipe(res);
      }
      throw new HttpError(404, 'not found');
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      send(res, err.status || 500, { error: err.status ? err.message : 'internal error' });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  // Bound to localhost on purpose: there is no login. Add auth before exposing this publicly.
  createServer().listen(port, '127.0.0.1', () => console.log(`CRM running at http://localhost:${port}`));
}

module.exports = { createServer };
