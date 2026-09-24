const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const SteamCommunity = require('steamcommunity');
const SteamID = require('steamid');
const Cheerio = require('cheerio');

const root = __dirname;
let worker = null;
let output = [];
let clients = [];
const names = new Map();
const steamIDs = new Map();
const pendingNames = new Set();
const nameCommunity = new SteamCommunity();
const nameQueue = [];
let activeNameLookups = 0;
const profileNameCachePath = path.join(root, 'profile_name_cache.json');
let profileNameCache = {};

try {
	const savedCache = JSON.parse(fs.readFileSync(profileNameCachePath, 'utf8'));
	profileNameCache = savedCache && typeof savedCache === 'object' ? savedCache : {};
} catch (err) {}

function saveProfileNameCache() {
	try { fs.writeFileSync(profileNameCachePath, JSON.stringify(profileNameCache, null, 2) + '\n'); } catch (err) {}
}

function rememberProfileName(key, profile) {
	if (!profile || !profile.name || !String(profile.name).trim()) return;
	const entry = { name: String(profile.name).trim(), steamID: profile.steamID ? String(profile.steamID) : '', cachedAt: Date.now() };
	profileNameCache[key] = entry;
	if (entry.steamID) profileNameCache[entry.steamID] = entry;
	names.set(key, entry.name);
	if (entry.steamID) steamIDs.set(key, entry.steamID);
	saveProfileNameCache();
}

function rememberArtworkOwner(artworkKey, ownerProfile) {
	if (!ownerProfile || !ownerProfile.name || !String(ownerProfile.name).trim()) return;
	const entry = {
		name: String(ownerProfile.name).trim(),
		steamID: ownerProfile.steamID ? String(ownerProfile.steamID) : '',
		cachedAt: Date.now(),
		kind: 'artworkOwner'
	};
	profileNameCache[artworkKey] = entry;
	names.set(artworkKey, entry.name);
	if (entry.steamID) steamIDs.set(artworkKey, entry.steamID);
	saveProfileNameCache();
}

function profileKey(url) {
	const artworkMatch = String(url).match(/steamcommunity\.com\/sharedfiles\/filedetails\/\?(?:.*&)?id=(\d+)/i);
	if (artworkMatch) return 'artwork_' + artworkMatch[1];
	const match = String(url).match(/steamcommunity\.com\/(id\/([^/?#]+)|profiles\/(\d+))/i);
	return match ? (match[3] || match[2]) : url;
}

function queueName(url) {
	const key = profileKey(url);
	const cached = profileNameCache[key];
	if (cached && cached.name) {
		names.set(key, cached.name);
		if (cached.steamID) steamIDs.set(key, cached.steamID);
		return;
	}
	if (names.has(key) || pendingNames.has(key)) return;
	pendingNames.add(key);
	nameQueue.push({ key, url });
	pumpNameQueue();
}

function pumpNameQueue() {
	while (activeNameLookups < 2 && nameQueue.length) {
		const item = nameQueue.shift();
		activeNameLookups++;
		if (item.key.startsWith('artwork_')) {
			const sharedFileId = item.key.replace('artwork_', '');
			nameCommunity.httpRequestGet('https://steamcommunity.com/sharedfiles/filedetails/?id=' + sharedFileId, (err, response, body) => {
				activeNameLookups--;
				pendingNames.delete(item.key);
				if (!err && body) {
					try {
						const $ = Cheerio.load(body);
						let ownerHref = $('.creatorsBlock .friendBlockLinkOverlay, .creatorsBlock a, .friendBlockLinkOverlay, .friendBlockLink').first().attr('href') ||
							$('.breadcrumbs a[href*="steamcommunity.com/id/"], .breadcrumbs a[href*="steamcommunity.com/profiles/"]').last().attr('href');

						let rawOwner = null;
						if (ownerHref) {
							const matchProfile = ownerHref.match(/steamcommunity\.com\/profiles\/(\d+)/i);
							if (matchProfile) rawOwner = matchProfile[1];
							else {
								const matchCustom = ownerHref.match(/steamcommunity\.com\/id\/([^/?#]+)/i);
								if (matchCustom) rawOwner = matchCustom[1];
							}
						}

						if (rawOwner) {
							nameCommunity.getSteamUser(rawOwner, (userErr, profile) => {
								if (!userErr && profile) rememberArtworkOwner(item.key, profile);
								setTimeout(pumpNameQueue, 250);
							});
							return;
						}
					} catch (parseErr) {}
				}
				setTimeout(pumpNameQueue, 250);
			});
		} else {
			const identifier = /^\d+$/.test(item.key) ? new SteamID(item.key) : item.key;
			nameCommunity.getSteamUser(identifier, (err, profile) => {
				activeNameLookups--;
				pendingNames.delete(item.key);
				if (!err && profile) rememberProfileName(item.key, profile);
				setTimeout(pumpNameQueue, 250);
			});
		}
	}
}

function push(line) {
	if (!line) return;
	console.log(line);
	output.push(line);
	if (output.length > 800) output.shift();
	clients.forEach(res => res.write('data: ' + JSON.stringify(line) + '\n\n'));
}

function read(name) {
	try { return fs.readFileSync(path.join(root, name), 'utf8'); }
	catch (err) { return ''; }
}

function parseFriends() {
	const lines = read('friends.txt').split(/\r?\n/);
	const items = [];
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i].trim();
		if (!raw || raw.startsWith('[EXCLUDED]')) continue;
		const disabled = raw.startsWith('---');
		const url = raw.replace(/^---\s*/, '');
		if (!/^https?:\/\/(?:www\.)?steamcommunity\.com\/(?:id\/[^/?#]+|profiles\/\d+)/i.test(url)) continue;
		queueName(url);
		const k = profileKey(url);
		const rawName = names.get(k);
		const stID = steamIDs.get(k) || '';
		const safeName = (rawName && String(rawName).trim().length > 0) ? String(rawName).trim() : (k || stID || url);
		items.push({
			line: i,
			url,
			type: 'PROFILE',
			name: safeName,
			steamID: stID,
			disabled,
			reason: disabled && lines[i + 1] && lines[i + 1].trim().startsWith('[EXCLUDED]') ? lines[i + 1].trim() : ''
		});
	}
	return items;
}

function parseArtworks() {
	const lines = read('artworks.txt').split(/\r?\n/);
	const items = [];
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i].trim();
		if (!raw || raw.startsWith('[EXCLUDED]')) continue;
		const disabled = raw.startsWith('---');
		const url = raw.replace(/^---\s*/, '');
		if (!/^https?:\/\/(?:www\.)?steamcommunity\.com\/sharedfiles\/filedetails\/\?(?:.*&)?id=\d+/i.test(url)) continue;
		queueName(url);
		const k = profileKey(url);
		const rawName = names.get(k);
		const stID = steamIDs.get(k) || '';
		const safeName = (rawName && String(rawName).trim().length > 0) ? String(rawName).trim() : (k || stID || url);
		items.push({
			line: i,
			url,
			type: 'ARTWORK',
			name: safeName,
			steamID: stID,
			disabled,
			reason: disabled && lines[i + 1] && lines[i + 1].trim().startsWith('[EXCLUDED]') ? lines[i + 1].trim() : ''
		});
	}
	return items;
}

function writeFriends(items) {
	fs.writeFileSync(path.join(root, 'friends.txt'), items.filter(Boolean).join('\n').replace(/\n*$/, '\n'));
}

function writeArtworks(items) {
	fs.writeFileSync(path.join(root, 'artworks.txt'), items.filter(Boolean).join('\n').replace(/\n*$/, '\n'));
}

function sendJson(res, data, code) {
	res.writeHead(code || 200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(data));
}

function body(req) {
	return new Promise(resolve => {
		let text = '';
		req.on('data', part => text += part);
		req.on('end', () => { try { resolve(JSON.parse(text || '{}')); } catch (err) { resolve({}); } });
	});
}

function start(data) {
	if (worker) throw new Error('The script is already running.');
	const startup = JSON.stringify({ discovery: !!data.discovery, importHistory: !!data.importHistory, delay: data.delay || 'NOW', username: data.username || '', password: data.password || '', guard: data.guard || '' });
	worker = spawn(process.execPath, ['index.js'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: Object.assign({}, process.env, { DASHBOARD_MODE: '1', DASHBOARD_STARTUP: startup }) });
	// Keep Steam Guard interactive when the dashboard was started from a terminal.
	// The child script owns the prompt, so forward terminal input to its stdin.
	if (process.stdin.isTTY) {
		process.stdin.resume();
		process.stdin.pipe(worker.stdin, { end: false });
	}
	worker.stdout.on('data', chunk => chunk.toString().split(/\r?\n/).forEach(push));
	worker.stderr.on('data', chunk => chunk.toString().split(/\r?\n/).forEach(push));
	worker.on('exit', code => { push('[DASHBOARD] Script stopped (exit code ' + code + ').'); worker = null; });
	push('[DASHBOARD] Script started.');
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, 'http://127.0.0.1');
	if (req.method === 'GET' && url.pathname === '/') {
		res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
		return res.end(read('dashboard.html'));
	}
	if (req.method === 'GET' && (url.pathname === '/audit' || url.pathname === '/friends_audit.html')) {
		res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
		return res.end(read('friends_audit.html'));
	}
	if (req.method === 'GET' && url.pathname === '/events') {
		res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
		output.forEach(line => res.write('data: ' + JSON.stringify(line) + '\n\n'));
		clients.push(res);
		req.on('close', () => clients = clients.filter(client => client !== res));
		return;
	}
	if (req.method === 'GET' && url.pathname === '/api/state') {
		const candidates = read('candidates.txt');
		candidates.split(/\r?\n/).forEach(line => { if (line.startsWith('https')) queueName(line.split(' ')[0]); });
		const commentsRaw = read('comments.txt');
		const commentBlocks = commentsRaw.split(/(?:\r?\n){2,}/).map(b => b.trim()).filter(Boolean);
		return sendJson(res, { running: !!worker, friends: parseFriends(), artworks: parseArtworks(), names: Object.fromEntries(names), candidates, tracking: read('reciprocal_tracking.json'), cycleState: read('cycle_state.json'), config: read('config.json'), comments: commentBlocks });
	}
	if (req.method === 'POST' && url.pathname === '/api/comments/select') {
		const data = await body(req);
		let cfg = {};
		try { cfg = JSON.parse(read('config.json') || '{}'); } catch (err) {}
		const indices = Array.isArray(data.indices) ? data.indices.map(Number).filter(n => isFinite(n) && n >= 1) : [];
		cfg.selectedCommentIndices = indices;
		fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
		return sendJson(res, { ok: true, selectedCommentIndices: indices });
	}
	if (req.method === 'POST' && url.pathname === '/api/config') {
		const data = await body(req);
		let cfg = {};
		try { cfg = JSON.parse(read('config.json') || '{}'); } catch (err) {}
		if (data.targetMode !== undefined) cfg.targetMode = String(data.targetMode);
		if (data.language !== undefined) cfg.language = String(data.language).toLowerCase() === 'zh-cn' ? 'zh-CN' : 'en';
		if (data.prioritizeReciprocal !== undefined) cfg.prioritizeReciprocal = Boolean(data.prioritizeReciprocal);
		if (data.enableGreedySkip !== undefined) cfg.enableGreedySkip = Boolean(data.enableGreedySkip);
		fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
		return sendJson(res, { ok: true, config: cfg });
	}
	if (req.method === 'POST' && url.pathname === '/api/target/comments') {
		const data = await body(req);
		let cfg = {};
		try { cfg = JSON.parse(read('config.json') || '{}'); } catch (err) {}
		cfg.targetComments = cfg.targetComments || {};
		if (data.target) {
			const val = Number(data.comments);
			if (isFinite(val) && val > 0 && val !== 6) {
				cfg.targetComments[data.target] = val;
			} else {
				delete cfg.targetComments[data.target];
			}
			fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
		}
		return sendJson(res, { ok: true, targetComments: cfg.targetComments });
	}
	if (req.method === 'POST' && url.pathname === '/api/start') {
		try { start(await body(req)); return sendJson(res, { ok: true }); }
		catch (err) { return sendJson(res, { ok: false, error: err.message }, 400); }
	}
	if (req.method === 'POST' && url.pathname === '/api/command') {
		const data = await body(req);
		if (!worker) return sendJson(res, { ok: false, error: 'Script is not running.' }, 400);
		worker.stdin.write(String(data.command || '') + '\n');
		return sendJson(res, { ok: true });
	}
	if (req.method === 'POST' && url.pathname === '/api/stop') {
		if (worker) worker.kill();
		return sendJson(res, { ok: true });
	}
	if (req.method === 'POST' && url.pathname === '/api/friends') {
		const data = await body(req);
		const lines = read('friends.txt').split(/\r?\n/).filter(Boolean);
		if (data.action === 'add') {
			const profile = String(data.url || '').trim();
			if (!/^https?:\/\/(?:www\.)?steamcommunity\.com\/(?:id\/[^/?#]+|profiles\/\d+)/i.test(profile)) return sendJson(res, { ok: false, error: 'Enter a valid Steam profile URL.' }, 400);
			if (lines.some(line => line.replace(/^---\s*/, '').trim() === profile)) return sendJson(res, { ok: false, error: 'This profile URL is already listed.' }, 400);
			lines.push(profile);
		}
		else if (data.action === 'remove' || data.action === 'disable' || data.action === 'enable') {
			const target = String(data.url || '').trim();
			const index = lines.findIndex(line => line.replace(/^---\s*/, '').trim() === target);
			if (index === -1) return sendJson(res, { ok: false, error: 'Friend was not found.' }, 404);
			if (data.action === 'remove') { lines.splice(index, 1); if (lines[index] && lines[index].trim().startsWith('[EXCLUDED]')) lines.splice(index, 1); }
			if (data.action === 'disable' && !lines[index].trim().startsWith('---')) lines.splice(index, 1, '--- ' + target, '    [EXCLUDED] Disabled from dashboard');
			if (data.action === 'enable' && lines[index].trim().startsWith('---')) { lines[index] = target; if (lines[index + 1] && lines[index + 1].trim().startsWith('[EXCLUDED]')) lines.splice(index + 1, 1); }
		}
		else return sendJson(res, { ok: false, error: 'Unknown friends action.' }, 400);
		writeFriends(lines);
		return sendJson(res, { ok: true });
	}
	if (req.method === 'POST' && url.pathname === '/api/artworks') {
		const data = await body(req);
		const lines = read('artworks.txt').split(/\r?\n/).filter(Boolean);
		if (data.action === 'add') {
			const artwork = String(data.url || '').trim();
			if (!/^https?:\/\/(?:www\.)?steamcommunity\.com\/sharedfiles\/filedetails\/\?(?:.*&)?id=\d+/i.test(artwork)) return sendJson(res, { ok: false, error: 'Enter a valid Steam artwork URL.' }, 400);
			if (lines.some(line => line.replace(/^---\s*/, '').trim() === artwork)) return sendJson(res, { ok: false, error: 'This artwork URL is already listed.' }, 400);
			lines.push(artwork);
		}
		else if (data.action === 'remove' || data.action === 'disable' || data.action === 'enable') {
			const target = String(data.url || '').trim();
			const index = lines.findIndex(line => line.replace(/^---\s*/, '').trim() === target);
			if (index === -1) return sendJson(res, { ok: false, error: 'Artwork was not found.' }, 404);
			if (data.action === 'remove') { lines.splice(index, 1); if (lines[index] && lines[index].trim().startsWith('[EXCLUDED]')) lines.splice(index, 1); }
			if (data.action === 'disable' && !lines[index].trim().startsWith('---')) lines.splice(index, 1, '--- ' + target, '    [EXCLUDED] Disabled from dashboard');
			if (data.action === 'enable' && lines[index].trim().startsWith('---')) { lines[index] = target; if (lines[index + 1] && lines[index + 1].trim().startsWith('[EXCLUDED]')) lines.splice(index + 1, 1); }
		}
		else return sendJson(res, { ok: false, error: 'Unknown artworks action.' }, 400);
		writeArtworks(lines);
		return sendJson(res, { ok: true });
	}
	sendJson(res, { error: 'Not found' }, 404);
});

server.listen(3000, '127.0.0.1', () => console.log('Dashboard: http://127.0.0.1:3000'));
