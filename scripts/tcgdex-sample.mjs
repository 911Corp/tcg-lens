// Dependency-free smoke utility using the documented TCGdex REST v2 endpoints.
const lang = process.argv[2] ?? 'fr';
const limit = Number(process.argv[3] ?? 5);
const base = `https://api.tcgdex.net/v2/${lang}`;
const list = await fetch(`${base}/cards`, { headers: { 'user-agent': 'TCGLens/0.1 (+data-ingestion)' } }).then(r => {
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
});
for (const card of list.slice(0, limit)) {
  const detail = await fetch(`${base}/cards/${encodeURIComponent(card.id)}`, { headers: { 'user-agent': 'TCGLens/0.1 (+data-ingestion)' } }).then(r => r.json());
  console.log(JSON.stringify({ id: detail.id, localId: detail.localId, name: detail.name, set: detail.set?.id, image: detail.image }));
}
