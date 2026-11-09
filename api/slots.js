// Vercel serverless function. Storage: Upstash Redis (REST), added from the Vercel Marketplace.
const BASE = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const SLOT_RE = /^(sat|sun)-(17|18|19|20|21)(00|30)$/;

async function redis(cmd) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

async function allClaims() {
  const flat = (await redis(['HGETALL', 'slots'])) || [];
  const out = {};
  for (let i = 0; i < flat.length; i += 2) {
    try { out[flat[i]] = JSON.parse(flat[i + 1]); } catch (e) {}
  }
  return out;
}

const isAdmin = (key) => !!ADMIN_KEY && typeof key === 'string' && key === ADMIN_KEY;
const PROPS = ['Crate', 'Stool', 'Chair', 'Ladder', 'Whatever'];
function details(b) {
  const props = Array.isArray(b.props) ? PROPS.filter((p) => b.props.includes(p)) : [];
  return {
    pose: String(b.pose || '').trim().slice(0, 600),
    props,
    dress: String(b.dress || '').trim().slice(0, 400),
  };
}
const MAX_PH = 3;
const MAX_LEN = 230000;
const JPEG_RE = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/;
async function getPhotos(cid) {
  try {
    const raw = await redis(['HGET', 'photos', cid]);
    if (!raw) return { v: '', imgs: [] };
    const j = JSON.parse(raw);
    return { v: j.v || '', imgs: Array.isArray(j.imgs) ? j.imgs : [] };
  } catch (e) { return { v: '', imgs: [] }; }
}
const goodCid = (c) => typeof c === 'string' && c.length >= 8 && c.length <= 64;

async function log(entry) {
  try {
    await redis(['RPUSH', 'log', JSON.stringify(entry)]);
    await redis(['LTRIM', 'log', -2000, -1]);
  } catch (e) {}
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!BASE || !TOKEN) return res.status(500).json({ error: 'not_configured' });
  try {
    if (req.method === 'GET') {
      const cid = req.query && req.query.cid;
      if (req.query && req.query.img) {
        const slotId = String(req.query.img);
        if (!SLOT_RE.test(slotId)) return res.status(400).json({ error: 'bad_slot' });
        const raw = await redis(['HGET', 'slots', slotId]);
        if (!raw) return res.status(404).json({ error: 'none' });
        const rec = JSON.parse(raw);
        if (!(isAdmin(req.query.admin) || (goodCid(cid) && rec.cid === cid))) return res.status(403).json({ error: 'not_yours' });
        const ph = await getPhotos(rec.cid);
        const data = ph.imgs[parseInt(req.query.i, 10)];
        if (!data) return res.status(404).json({ error: 'none' });
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'private, max-age=3600');
        return res.status(200).send(Buffer.from(data, 'base64'));
      }
      const claims = await allClaims();
      const slots = {};
      for (const k of Object.keys(claims)) {
        const mine = goodCid(cid) && claims[k].cid === cid;
        slots[k] = { name: claims[k].name, at: claims[k].at, mine };
        if (mine || isAdmin(req.query && req.query.admin)) {
          slots[k].pose = claims[k].pose || '';
          slots[k].props = claims[k].props || [];
          slots[k].dress = claims[k].dress || '';
          slots[k].np = claims[k].np || 0;
          slots[k].pv = claims[k].pv || '';
        }
      }
      const body = { slots };
      if (isAdmin(req.query && req.query.admin)) {
        const raw = (await redis(['LRANGE', 'log', 0, -1])) || [];
        body.log = raw.map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean).reverse();
      }
      return res.status(200).json(body);
    }

    if (req.method === 'POST') {
      let b = req.body;
      if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
      b = b || {};
      if (b.action === 'recall') {
        const norm = (x) => String(x || '').trim().replace(/\s+/g, ' ').toLowerCase();
        const want = norm(b.name);
        if (!want) return res.status(400).json({ error: 'name_required' });
        const claims = await allClaims();
        const id = Object.keys(claims).find((k) => norm(claims[k].name) === want);
        if (!id) return res.status(404).json({ error: 'none' });
        await log({ t: new Date().toISOString(), action: 'recall', slot: id, label: String(b.label || '').slice(0, 40), name: claims[id].name });
        return res.status(200).json({ ok: true, cid: claims[id].cid, slot: id });
      }
      const slot = b.slot;
      if (!SLOT_RE.test(slot || '')) return res.status(400).json({ error: 'bad_slot' });
      const label = String(b.label || '').slice(0, 40);
      const now = new Date().toISOString();

      if (b.action === 'claim') {
        if (/^sat-(18(30)|19|20|21)/.test(slot)) return res.status(403).json({ error: 'closed' });
        const name = String(b.name || '').trim().slice(0, 60);
        if (!name) return res.status(400).json({ error: 'name_required' });
        if (!goodCid(b.cid)) return res.status(400).json({ error: 'bad_client' });
        const claims = await allClaims();
        const prevId = Object.keys(claims).find((k) => claims[k].cid === b.cid);
        const d = details(b);
        const ph = await getPhotos(b.cid);
        const won = await redis(['HSETNX', 'slots', slot, JSON.stringify({ name, cid: b.cid, at: now, ...d, np: ph.imgs.length, pv: ph.v })]);
        if (won !== 1) {
          const cur = (await allClaims())[slot];
          return res.status(409).json({ error: 'taken', by: cur ? cur.name : '' });
        }
        if (prevId && prevId !== slot) await redis(['HDEL', 'slots', prevId]);
        await log({ t: now, action: prevId ? 'move' : 'claim', slot, label, name, fromSlot: prevId || '', ...d });
        return res.status(200).json({ ok: true, moved: !!prevId });
      }

      if (b.action === 'details') {
        const raw = await redis(['HGET', 'slots', slot]);
        if (!raw) return res.status(404).json({ error: 'no_slot' });
        const cur = JSON.parse(raw);
        if (!(goodCid(b.cid) && cur.cid === b.cid)) return res.status(403).json({ error: 'not_yours' });
        const d = details(b);
        await redis(['HSET', 'slots', slot, JSON.stringify({ ...cur, ...d })]);
        await log({ t: now, action: 'update', slot, label, name: cur.name, ...d });
        return res.status(200).json({ ok: true });
      }

      if (b.action === 'photos') {
        const raw = await redis(['HGET', 'slots', slot]);
        if (!raw) return res.status(404).json({ error: 'no_slot' });
        const cur = JSON.parse(raw);
        if (!(goodCid(b.cid) && cur.cid === b.cid)) return res.status(403).json({ error: 'not_yours' });
        const items = Array.isArray(b.items) ? b.items.slice(0, 8) : [];
        const old = (await getPhotos(b.cid)).imgs;
        const imgs = [];
        for (const it of items) {
          if (imgs.length >= MAX_PH) break;
          if (it && Number.isInteger(it.keep) && old[it.keep]) imgs.push(old[it.keep]);
          else if (it && typeof it.data === 'string' && it.data.length <= MAX_LEN) {
            const m = JPEG_RE.exec(it.data);
            if (m) imgs.push(m[1]);
          }
        }
        let v = '';
        if (imgs.length) { v = now; await redis(['HSET', 'photos', b.cid, JSON.stringify({ v, imgs })]); }
        else await redis(['HDEL', 'photos', b.cid]);
        await redis(['HSET', 'slots', slot, JSON.stringify({ ...cur, np: imgs.length, pv: v })]);
        await log({ t: now, action: 'photos', slot, label, name: cur.name, photos: imgs.length });
        return res.status(200).json({ ok: true, np: imgs.length });
      }

      if (b.action === 'release') {
        const raw = await redis(['HGET', 'slots', slot]);
        if (!raw) return res.status(200).json({ ok: true });
        const cur = JSON.parse(raw);
        const admin = isAdmin(b.admin);
        if (!admin && !(goodCid(b.cid) && cur.cid === b.cid)) return res.status(403).json({ error: 'not_yours' });
        await redis(['HDEL', 'slots', slot]);
        await log({ t: now, action: admin && cur.cid !== b.cid ? 'release-by-editor' : 'release', slot, label, name: cur.name });
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ error: 'bad_action' });
    }
    return res.status(405).json({ error: 'method' });
  } catch (e) {
    return res.status(500).json({ error: 'server' });
  }
};
