// 存东西：全在这台电脑的浏览器里（IndexedDB），不往别处传。
// 浏览器不让存（无痕窗口、关了网站数据）就退回到内存里：这次能用，关掉页面就没了。

const NAME = 'luruseng-web';
const VER = 1;
export const STORES = ['kv', 'cats', 'ledger', 'runs', 'photos'];
// kv：设置、名单、刀单数据库 · cats：自建类别（名字 → {columns, records}）
// ledger：干过的照片（指纹 → {file, no, run, at}）· runs：每一批的结果 · photos：印了编号的照片（批次/编号 → 图）

function req(r) {
  return new Promise((ok, bad) => { r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });
}

class Memory {
  constructor() { this.kind = 'memory'; this.m = Object.fromEntries(STORES.map((s) => [s, new Map()])); }
  async get(s, k) { return this.m[s].get(k); }
  async put(s, k, v) { this.m[s].set(k, v); }
  async del(s, k) { this.m[s].delete(k); }
  async keys(s) { return [...this.m[s].keys()]; }
  async all(s) { return [...this.m[s].entries()]; }
  async many(s, pairs) { for (const [k, v] of pairs) this.m[s].set(k, v); }
}

class Idb {
  constructor(db) { this.kind = 'idb'; this.db = db; }
  tx(s, mode = 'readonly') { return this.db.transaction(s, mode).objectStore(s); }
  get(s, k) { return req(this.tx(s).get(k)); }
  put(s, k, v) { return req(this.tx(s, 'readwrite').put(v, k)); }
  del(s, k) { return req(this.tx(s, 'readwrite').delete(k)); }
  keys(s) { return req(this.tx(s).getAllKeys()); }
  async all(s) {
    const st = this.tx(s);
    const [ks, vs] = await Promise.all([req(st.getAllKeys()), req(st.getAll())]);
    return ks.map((k, i) => [k, vs[i]]);
  }
  many(s, pairs) {                           // 一次写好几条：要么全写进去，要么一条不写
    return new Promise((ok, bad) => {
      const t = this.db.transaction(s, 'readwrite');
      const st = t.objectStore(s);
      for (const [k, v] of pairs) st.put(v, k);
      t.oncomplete = () => ok();
      t.onerror = () => bad(t.error);
      t.onabort = () => bad(t.error);
    });
  }
}

export async function openStore() {
  try {
    if (!globalThis.indexedDB) throw new Error('no indexedDB');
    const db = await new Promise((ok, bad) => {
      const r = indexedDB.open(NAME, VER);
      r.onupgradeneeded = () => { for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => bad(r.error);
      r.onblocked = () => bad(new Error('blocked'));
    });
    const st = new Idb(db);
    await st.get('kv', 'probe');             // 有的浏览器能打开却不让读写：试一下
    return st;
  } catch (e) {
    return new Memory();
  }
}

// 不让浏览器空间紧张时自己清掉（数据库、结果都在这里面）
export async function persist() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch (e) { /* 不支持就算了 */ }
  return false;
}

export async function usage() {              // [用了多少, 能用多少]（字节）；不知道就 null
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage: u, quota: q } = await navigator.storage.estimate();
      return [u || 0, q || 0];
    }
  } catch (e) { /* 不支持 */ }
  return null;
}

// ---------------------------------------------------------------- 备份：换电脑、换浏览器、清浏览器之前存一份
// 钥匙不进备份（备份文件可能发给别人）；照片也不进（太大，Excel 和编号照片另外下载）。
export async function exportBackup(st, extra = {}) {
  const kb = (await st.get('kv', 'kb')) || { records: [], people: [] };
  const cats = Object.fromEntries(await st.all('cats'));
  const ledger = Object.fromEntries(await st.all('ledger'));
  const names = (await st.get('kv', 'names')) || '';
  return { app: 'luruseng-web', v: 1, at: new Date().toISOString().slice(0, 19), kb, cats, names, ledger, ...extra };
}

// 导入：合并进现有的，不覆盖、不删（同一条记录只留一份）
export async function importBackup(st, data) {
  if (!data || data.app !== 'luruseng-web' || !data.kb) throw new Error('这不是录入僧网页版的备份文件');
  const out = { records: 0, people: 0, cats: 0, catRecords: 0, ledger: 0, names: 0 };
  const kb = (await st.get('kv', 'kb')) || { records: [], people: [] };
  const have = new Set(kb.records.map((r) => r.key));
  for (const r of data.kb.records || []) if (r && r.key && !have.has(r.key)) { have.add(r.key); kb.records.push(r); out.records++; }
  const known = new Set(kb.people.map(([n]) => n));
  for (const p of data.kb.people || []) if (Array.isArray(p) && p[0] && !known.has(p[0])) { known.add(p[0]); kb.people.push(p); out.people++; }
  await st.put('kv', 'kb', kb);
  for (const [name, db] of Object.entries(data.cats || {})) {
    if (!db || !Array.isArray(db.columns)) continue;
    const cur = (await st.get('cats', name)) || (out.cats++, { columns: [], records: [] });
    const cols = new Set(cur.columns);
    for (const c of db.columns) if (!cols.has(c)) { cols.add(c); cur.columns.push(c); }
    const keys = new Set(cur.records.map((r) => r.key));
    for (const r of db.records || []) if (r && r.key && !keys.has(r.key)) { keys.add(r.key); cur.records.push(r); out.catRecords++; }
    await st.put('cats', name, cur);
  }
  const ledger = Object.entries(data.ledger || {});
  const old = new Set(await st.keys('ledger'));
  const fresh = ledger.filter(([h]) => !old.has(h));
  if (fresh.length) await st.many('ledger', fresh);
  out.ledger = fresh.length;
  if (data.names) {
    const cur = (await st.get('kv', 'names')) || '';
    const lines = new Set(cur.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    const add = String(data.names).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !lines.has(l));
    if (add.length) { await st.put('kv', 'names', (cur.trim() ? cur.trim() + '\n' : '') + add.join('\n')); out.names = add.length; }
  }
  return out;
}
