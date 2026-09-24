const SteamCommunity = require('steamcommunity');
const SteamUser = require('steam-user');
const SteamID = require('steamid');
const Request = require('request');
const Cheerio = require('cheerio');
const Colors = require('colors');
const path = require('path');
const fs = require('fs');
const ReadLine = require('readline');

const originalConsoleLog = console.log.bind(console);
function logTime() {
	var now = new Date();
	function pad(value) { return String(value).padStart(2, '0'); }
	return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
}
console.log = function () {
	var args = Array.prototype.slice.call(arguments);
	if (typeof args[0] === 'string') args[0] = translateTerminalMessage(args[0]);
	if (typeof args[0] === 'string') args[0] = '[' + logTime() + '] ' + args[0];
	else args.unshift('[' + logTime() + ']');
	originalConsoleLog.apply(console, args);
};

config = require(path.resolve('config.json'));
const proxyUrl = String(config.proxyUrl || '').trim();
var community = new SteamCommunity(proxyUrl ? { request: Request.defaults({ proxy: proxyUrl }) } : {});
var user = new SteamUser(proxyUrl ? { httpProxy: proxyUrl } : {});
var comments = [];
var friends = [];
var allFriendEntries = [];
var cycle = 1;
var currentFriendName = null;
var currentFriendNumber = null;
var skipCurrentFriend = false;
var skipDelay = null;
const COMMENTS_PER_FRIEND = 6;
const DISCOVERY_WINDOW_MS = 48 * 60 * 60 * 1000;
const DISCOVERY_MIN_COMMENTS = 6;
const DISCOVERY_MAX_TOTAL_COMMENTS = 48000;
const RECIPROCAL_GRACE_PERIOD_MS = 48 * 60 * 60 * 1000;
var language = String(config.language || 'en').toLowerCase();
var translations = {
	'en': {
		startup: 'The logged-in main account will post comments to profiles in friends.txt.',
		commands: 'Commands: SKIP, PAUSECYCLE, STARTCYCLE, DISCOVER, STATUS, DRYRUN (toggle), RESETTRACKING, IMPORTHISTORY, RESETDELAY, NORMALIZEURLS.',
		discoveryPrompt: 'Run one candidate discovery scan after login? (ON/OFF): ',
		startPrompt: 'Start commenting NOW, or enter a delay in minutes: ',
		username: 'Username: ', password: 'Password: ', guard: 'GuardCode: ',
		loginSuccess: 'Main account:\n%s - successfully logged in\n----------------------',
		loginFailed: 'Main account login failed: %s',
		startupFailed: 'Startup failed: %s',
		cycleLoaded: 'Cycle %s: loaded %s friend(s).',
		cycleFinished: 'Cycle %s finished. Reloading friends.txt and restarting in %s seconds.'
	},
	'zh-cn': {
		startup: '登录的主账号将向 friends.txt 中的个人资料发布评论。',
		commands: '命令：SKIP（跳过）、PAUSECYCLE（暂停循环）、STARTCYCLE（开始循环）、DISCOVER（发现）、STATUS（状态）、DRYRUN（试运行）、RESETTRACKING（重置记录）、IMPORTHISTORY（导入历史）、RESETDELAY（重置延迟）、NORMALIZEURLS（转换链接）。',
		discoveryPrompt: '登录后运行一次候选人扫描？(ON/OFF)：',
		startPrompt: '立即开始评论请输入 NOW，或输入延迟分钟数：',
		username: '用户名：', password: '密码：', guard: 'Steam Guard 验证码：',
		loginSuccess: '主账号：\n%s - 登录成功\n----------------------',
		loginFailed: '主账号登录失败：%s',
		startupFailed: '启动失败：%s',
		cycleLoaded: '循环 %s：已加载 %s 个目标。',
		cycleFinished: '循环 %s 已完成。将在 %s 秒后重新加载 friends.txt 并开始下一轮。'
	}
};
function t(key) { return (translations[language] || translations.en)[key] || translations.en[key] || key; }

// Translate existing terminal log templates centrally. This keeps technical
// identifiers, URLs, Steam errors, account names and comments unchanged.
function translateTerminalMessage(message) {
	if (language !== 'zh-cn' || typeof message !== 'string') return message;
	var replacements = [
		[/\[RECIPROCAL\]/g, '[互惠]'], [/\[DISCOVERY\]/g, '[发现]'], [/\[STEAM\]/g, '[Steam]'],
		[/\[CYCLE\]/g, '[循环]'], [/\[FRIEND (\d+)\]/g, '[目标 $1]'], [/\[TARGET (\d+)\]/g, '[目标 $1]'],
		[/\[STATUS\]/g, '[状态]'], [/\[LIMIT\]/g, '[限制]'], [/\[CACHE\]/g, '[缓存]'],
		[/Profile lookup rate limited \(429\)\. Pausing all profile lookups for/g, '个人资料查询触发限制（429）。暂停所有资料查询，等待'],
		[/minute\(s\), then retrying/g, '分钟后重试'], [/Could not open artwork/g, '无法打开作品'], [/Could not open/g, '无法打开'],
		[/Waiting (\d+) minutes before retry/g, '等待 $1 分钟后重试'], [/Waiting (\d+) seconds, then retrying/g, '等待 $1 秒后重试'],
		[/Comment returned 403\. Verifying whether Steam accepted it before taking any further action\.\.\./g, '评论返回 403。正在验证 Steam 是否已接受评论，再决定后续操作……'],
		[/Verified that the comment was posted despite the 403; not retrying\./g, '已确认评论虽返回 403 但已发布；不会重试。'],
		[/403 success assumed for this configured target; not retrying\./g, '此目标已配置为 403 视为成功；不会重试。'],
		[/403 success assumed for this configured target after verification failed; not retrying\./g, '验证失败后，此目标仍按配置将 403 视为成功；不会重试。'],
		[/Rate limited by Steam\./g, 'Steam 触发速率限制。'], [/New between-comments delay:/g, '新的评论间隔：'],
		[/Steam rejected the comment/g, 'Steam 拒绝了评论'], [/New delay:/g, '新延迟：'],
		[/Checking return comments from/g, '正在检查来自'], [/No new return comments from/g, '没有发现来自'],
		[/since last check/g, '自上次检查后'], [/total returned:/g, '累计收到：'],
		[/First batch for owner/g, '该用户首次批次'], [/first batch allowed/g, '允许发送首批评论'],
		[/lifetime returned:/g, '累计收到：'], [/Last comment from/g, '最后一条评论来自'],
		[/No comment found/g, '未找到评论'], [/Posting comment/g, '正在发布评论'], [/Preview:/g, '预览：'],
		[/Successfully commented on/g, '已成功评论'], [/Comment:/g, '评论：'], [/Finished/g, '已完成'],
		[/Waiting (\d+)s delay for/g, '等待 $1 秒后继续：'], [/before comment/g, '下一条评论'],
		[/Skipped by user\./g, '已由用户跳过。'], [/Skip requested for/g, '已请求跳过：'],
		[/Stopped (.+) after an unverified 403 to prevent duplicate comments\./g, '因 403 无法验证，已停止 $1 以避免重复评论。'],
		[/Error posting comment/g, '发布评论时出错'], [/Duplicate target in friends\.txt — skipped\./g, 'friends.txt 中存在重复目标，已跳过。'],
		[/is no longer on your Steam friend list — auto-disabling target\./g, '已不在你的 Steam 好友列表中，正在自动禁用目标。'],
		[/New returned:/g, '新收到：'], [/Sent:/g, '已发送：'], [/Returned:/g, '已收到：'], [/Available:/g, '可用：'],
		[/Eligible — sending/g, '符合条件——发送'], [/comments\./g, '条评论。'],
		[/SKIPPED — No return comments since last batch/g, '已跳过——自上批发送后没有回评'],
		[/CONTINUING by user choice — sending/g, '按用户选择继续——发送'],
		[/Could not reliably check return comments:/g, '无法可靠检查回评：'],
		[/Daily comment cap/g, '每日评论上限'], [/reached\. Waiting for the next cycle\./g, '已达到。等待下一轮循环。'],
		[/DRYRUN — would post to/g, '试运行——将发布到'], [/Cycle failed:/g, '循环失败：'],
		[/Commenting will start in/g, '将在'], [/minute\(s\)\./g, '分钟后开始评论。'],
		[/Invalid delay\. Starting now\./g, '延迟无效，立即开始。'],
		[/Dashboard login requires a Steam username and password\./g, '仪表板登录需要 Steam 用户名和密码。'],
		[/Cycle paused by user\. Script remains logged in\./g, '循环已由用户暂停。脚本保持登录。'],
		[/Cycle resumed \/ started by user\./g, '循环已由用户恢复／开始。'],
		[/Cycle is PAUSED\. Waiting for Resume \/ Start Cycle command\.\.\./g, '循环已暂停。等待恢复／开始循环命令……'],
		[/Resuming cycle execution\.\.\./g, '正在恢复循环执行……'],
		[/Historical import is already running\./g, '历史导入已在运行。'], [/Historical import failed:/g, '历史导入失败：'],
		[/A discovery scan is already running\./g, '发现扫描已在运行。'], [/Scan failed:/g, '扫描失败：'],
		[/Historical check complete\./g, '历史检查完成。'], [/Running historical comment check for/g, '正在为'],
		[/target\(s\) \(including disabled\)\./g, '个目标运行历史评论检查（包括已禁用目标）。'],
		[/First historical check for/g, '首次历史检查：'], [/Historical re-check for/g, '重新历史检查：'],
		[/Could not check history for/g, '无法检查历史记录：'], [/Historical check for/g, '历史检查：'],
		[/Scanning/g, '正在扫描'], [/comments \(found/g, '条评论（找到'], [/found/g, '找到'],
		[/Candidate accepted/g, '候选人已接受'], [/Candidate rejected:/g, '候选人被拒绝：'],
		[/Candidate:/g, '候选人：'], [/Total comments:/g, '评论总数：'], [/Scan complete\./g, '扫描完成。'],
		[/Main account skipped\. Exiting\./g, '主账号已跳过，正在退出。'], [/Last main account Steam Guard code was wrong\./g, '上一次主账号 Steam Guard 验证码错误。'],
		[/Check the username, password, Steam Guard code, and whether Steam is asking for mobile confirmation\./g, '请检查用户名、密码、Steam Guard 验证码，以及 Steam 是否要求移动端确认。']
	];
	return replacements.reduce(function (result, item) { return result.replace(item[0], item[1]); }, message);
}
const configuredBetweenComments = Number(config.betweenComments) || 30000;
var betweenComments = configuredBetweenComments;
const waitAfterFinalComment = config.waitAfterFinalComment === true;
const rateLimitWait = Number(config.rateLimitWait) || 120000;
const comment403VerificationWait = Number(config.comment403VerificationWait) || 15000;
const steamLookupRateLimitWait = Number(config.steamLookupRateLimitWait) || (15 * 60 * 1000);
const maxSteamLookupRateLimitWait = Number(config.maxSteamLookupRateLimitWait) || (60 * 60 * 1000);
const steamUserCacheMaxAgeMs = (Number(config.steamUserCacheDays) || 30) * 24 * 60 * 60 * 1000;
const restartDelay = Number(config.restartDelay) || 60000;
const maxCommentRetries = Number(config.maxCommentRetries) || 5;
const delayJitterPercent = Number(config.delayJitterPercent) || 0.2;
const dailyCommentCap = Number(config.dailyCommentCap) || 0;
const betweenFriends = Number(config.betweenFriends) || 0;
const maxCommentsPerBatch = Number(config.maxCommentsPerBatch) || 6;
const reciprocalCutoffDateStr = config.reciprocalCutoffDate || '2026-08-29';
const reciprocalCutoffMs = !isNaN(new Date(reciprocalCutoffDateStr).getTime()) ? new Date(reciprocalCutoffDateStr).getTime() : new Date('2026-08-29').getTime();
var friendSteamIDs = new Set();
var candidateSteamIDs = new Set();
var candidateSources = new Map();
var candidateStats = new Map();
var friendsListReady = false;
var discoveryRunning = false;
var reciprocalTracking = {};
var runDiscoveryOnStartup = false;
var runImportHistoryOnStartup = false;
var startupDelay = 0;
var dashboardMode = process.env.DASHBOARD_MODE === '1';
var dashboardStartup = {};
try { dashboardStartup = dashboardMode ? JSON.parse(process.env.DASHBOARD_STARTUP || '{}') : {}; } catch (err) { dashboardStartup = {}; }
var dryRun = false;
var processedFriendSteamIDs = new Set();
var cycleAttemptedSources = new Set();
var todayCommentCount = 0;
var commentCountDate = new Date().toISOString().slice(0, 10);
var reciprocalDecisionResolver = null;
var historyImportRunning = false;
var currentCycleState = { cycle: 1, finished: [], skipped: [], failed: [] };
var steamLookupCooldownUntil = 0;
var steamUserCache = {};
var profileNameCache = {};

function loadSteamUserCache() {
	try {
		var data = JSON.parse(fs.readFileSync('./steam_user_cache.json', 'utf-8'));
		steamUserCache = data && typeof data === 'object' ? data : {};
	} catch (err) { steamUserCache = {}; }
}

function saveSteamUserCache() {
	try { fs.writeFileSync('./steam_user_cache.json', JSON.stringify(steamUserCache, null, 2) + '\n'); } catch (err) { }
}

function loadProfileNameCache() {
	try {
		var data = JSON.parse(fs.readFileSync('./profile_name_cache.json', 'utf-8'));
		profileNameCache = data && typeof data === 'object' ? data : {};
	} catch (err) { profileNameCache = {}; }
}

function cachedProfileName(steamID) {
	var entry = profileNameCache[String(steamID)];
	return entry && entry.name ? String(entry.name).trim() : null;
}

function steamUserCacheKey(friend) {
	if (!friend || friend.identifier == null) return null;
	return String(friend.identifier).trim().toLowerCase();
}

function cachedSteamUser(friend) {
	var key = steamUserCacheKey(friend);
	var entry = key && steamUserCache[key];
	if (!entry || !entry.steamID || !entry.cachedAt || Date.now() - Number(entry.cachedAt) > steamUserCacheMaxAgeMs) return null;
	return { steamID: entry.steamID, name: entry.name || null };
}

function cacheSteamUser(friend, steamUser) {
	var key = steamUserCacheKey(friend);
	if (!key || !steamUser || !steamUser.steamID) return;
	steamUserCache[key] = { steamID: String(steamUser.steamID), name: steamUser.name || null, cachedAt: Date.now() };
	saveSteamUserCache();
}

loadSteamUserCache();
loadProfileNameCache();

function normalizeCachedFriendURLs() {
	var filePath = './friends.txt';
	if (!fs.existsSync(filePath)) return console.log('[CACHE] friends.txt was not found.'.yellow);
	var lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
	var changed = 0;
	var updatedLines = lines.map(function (line) {
		var match = line.match(/^(\s*(?:---\s*)?)(https?:\/\/(?:www\.)?steamcommunity\.com\/id\/([^/?#]+)\/?)(.*)$/i);
		if (!match) return line;
		var entry = steamUserCache[String(match[3]).trim().toLowerCase()];
		if (!entry || !entry.steamID) return line;
		changed++;
		return match[1] + 'https://steamcommunity.com/profiles/' + entry.steamID + '/' + match[4];
	});
	if (!changed) return console.log('[CACHE] No cached custom URLs are ready to convert yet.'.yellow);
	var backupPath = './friends.backup.' + Date.now() + '.txt';
	fs.copyFileSync(filePath, backupPath);
	fs.writeFileSync(filePath, updatedLines.join('\n'));
	console.log('[CACHE] Converted %s cached custom URL(s) to permanent SteamID URLs. Backup: %s'.green, changed, backupPath);
	activity('friends_urls_normalized', { converted: changed, backup: backupPath });
}

function saveCycleState() {
	try { fs.writeFileSync('./cycle_state.json', JSON.stringify(currentCycleState, null, 2) + '\n'); } catch (e) {}
}
function loadCycleState() {
	if (fs.existsSync('./cycle_state.json')) {
		try {
			var data = JSON.parse(fs.readFileSync('./cycle_state.json', 'utf-8'));
			if (data && typeof data === 'object') currentCycleState = data;
		} catch (e) {}
	}
}
loadCycleState();

function markCycleTarget(urlOrSource, status) {
	if (!urlOrSource) return;
	var targetUrl = String(urlOrSource).trim();
	['finished', 'skipped', 'failed'].forEach(function(s) {
		currentCycleState[s] = (currentCycleState[s] || []).filter(function(u) { return u !== targetUrl; });
	});
	if (status && currentCycleState[status]) {
		currentCycleState[status].push(targetUrl);
	}
	saveCycleState();
}

var cyclePaused = false;

function checkCyclePause() {
	return new Promise(function (resolve) {
		if (!cyclePaused) return resolve();
		console.log('[CYCLE] Cycle is PAUSED. Waiting for Resume / Start Cycle command...'.yellow);
		var interval = setInterval(function () {
			if (!cyclePaused) {
				clearInterval(interval);
				console.log('[CYCLE] Resuming cycle execution...'.green);
				resolve();
			}
		}, 1000);
	});
}

function clean(value) { return (value || '').trim(); }
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function friendLogPrefix(number) { return '[FRIEND ' + (number || '-') + ']'; }
function jitterDelay(ms) { return Math.max(0, Math.round(ms * (1 + ((Math.random() * 2 - 1) * delayJitterPercent)))); }
function activity(event, details) { fs.appendFileSync('./activity.log', JSON.stringify({ time: new Date().toISOString(), event: event, details: details }) + '\n'); }
function refreshDailyCount() { var day = new Date().toISOString().slice(0, 10); if (day !== commentCountDate) { commentCountDate = day; todayCommentCount = 0; } }

function ask(question, callback) {
	var prompt = ReadLine.createInterface({ input: process.stdin, output: process.stdout });
	prompt.question(question, function (answer) { prompt.close(); callback(clean(answer)); });
}

function configureStartup(callback) {
	if (dashboardMode) {
		runDiscoveryOnStartup = Boolean(dashboardStartup.discovery);
		runImportHistoryOnStartup = Boolean(dashboardStartup.importHistory);
		var dashboardMinutes = Number(dashboardStartup.delay);
		startupDelay = dashboardStartup.delay && String(dashboardStartup.delay).toUpperCase() !== 'NOW' && isFinite(dashboardMinutes) && dashboardMinutes >= 0 ? Math.round(dashboardMinutes * 60000) : 0;
		return callback();
	}
	ask(t('discoveryPrompt'), function (discoveryChoice) {
		runDiscoveryOnStartup = discoveryChoice.toUpperCase() === 'ON';
		ask(t('startPrompt'), function (startChoice) {
			if (startChoice.toUpperCase() === 'NOW' || startChoice === '') {
				startupDelay = 0;
			}
			else {
				var minutes = Number(startChoice);
				if (isFinite(minutes) && minutes >= 0) startupDelay = Math.round(minutes * 60 * 1000);
				else {
					console.log('Invalid delay. Starting now.'.yellow);
					startupDelay = 0;
				}
			}
			callback();
		});
	});
}

function beginLogin(accountName, password, guard) {
	if (!accountName || !password) {
		console.log('Dashboard login requires a Steam username and password.'.red);
		return;
	}
	user.logOn({ accountName: accountName, password: password, twoFactorCode: guard });
}

function waitForDelayOrSkip(ms) {
	return new Promise(function (resolve) {
		var timer = setTimeout(function () {
			skipDelay = null;
			resolve();
		}, ms);
		skipDelay = function () {
			clearTimeout(timer);
			skipDelay = null;
			resolve();
		};
	});
}

function startCommandListener() {
	var commandLine = ReadLine.createInterface({ input: process.stdin, output: process.stdout });
	console.log(t('commands').gray);
	commandLine.on('line', function (command) {
		command = clean(command).toUpperCase();
		if (command === 'PAUSECYCLE' || command === 'PAUSE' || command === 'STOPCYCLE') {
			cyclePaused = true;
			console.log('[CYCLE] Cycle paused by user. Script remains logged in.'.yellow);
			if (skipDelay) skipDelay();
			return;
		}
		if (command === 'STARTCYCLE' || command === 'RESUMECYCLE' || command === 'RESUME' || command === 'START') {
			cyclePaused = false;
			console.log('[CYCLE] Cycle resumed / started by user.'.green);
			if (skipDelay) skipDelay();
			return;
		}
		if (reciprocalDecisionResolver) {
			var resolveDecision = reciprocalDecisionResolver;
			reciprocalDecisionResolver = null;
			if (reciprocalDecisionTimer) clearTimeout(reciprocalDecisionTimer);
			reciprocalDecisionTimer = null;
			resolveDecision(command === '' || command === 'CONTINUE' ? 'CONTINUE' : 'SKIP');
			return;
		}
		if (command === 'STATUS') {
			refreshDailyCount();
			console.log('[STATUS] Cycle: %s | Current friend: %s | Delay: %ss | Today: %s%s | Dry run: %s'.gray, cycle, currentFriendName || 'none', Math.round(betweenComments / 1000), todayCommentCount, dailyCommentCap ? '/' + dailyCommentCap : '', dryRun ? 'ON' : 'OFF');
			return;
		}
		if (command === 'DRYRUN') { dryRun = !dryRun; console.log('[DRYRUN] %s'.yellow, dryRun ? 'ON — no comments will be posted.' : 'OFF — posting enabled.'); return; }
		if (command === 'RESETTRACKING') {
			var backupPath = './reciprocal_tracking.backup.' + Date.now() + '.json';
			if (fs.existsSync('./reciprocal_tracking.json')) fs.copyFileSync('./reciprocal_tracking.json', backupPath);
			reciprocalTracking = {};
			saveReciprocalTracking();
			console.log('[RECIPROCAL] Tracking reset. Backup saved to %s. New totals begin with future batches and returns.'.yellow, backupPath);
			activity('reciprocal_tracking_reset', { backup: backupPath });
			return;
		}
		if (command === 'IMPORTHISTORY') {
			if (historyImportRunning) console.log('[RECIPROCAL] Historical import is already running.'.yellow);
			else importReciprocalHistory().catch(function (err) { console.log('[RECIPROCAL] Historical import failed: %s'.red, err.message || err); });
			return;
		}
		if (command === 'DISCOVER') {
			if (discoveryRunning) console.log('[DISCOVERY] A discovery scan is already running.'.yellow);
			else runDiscovery().catch(function (err) { console.log('[DISCOVERY] Scan failed: %s'.red, err.message || err); });
			return;
		}
		if (command === 'RESETDELAY') {
			try {
				var freshConfig = JSON.parse(fs.readFileSync(path.resolve('config.json'), 'utf-8'));
				if (freshConfig.betweenComments !== undefined) config.betweenComments = freshConfig.betweenComments;
			} catch (err) {}
			betweenComments = Number(config.betweenComments) || 30000;
			console.log(('[DELAY] Comment delay reset to ' + Math.round(betweenComments / 1000) + ' seconds.').yellow);
			if (skipDelay) skipDelay();
			return;
		}
		if (command === 'NORMALIZEURLS' || command === 'NORMALIZEURL' || command === 'CONVERTURLS') {
			normalizeCachedFriendURLs();
			return;
		}
		if (command.indexOf('SETCOMMENTS') === 0) {
			var arg = command.replace(/^SETCOMMENTS\s*/, '').trim();
			var indices = [];
			if (arg !== 'ALL' && arg !== 'RANDOM' && arg !== 'CLEAR' && arg !== '') {
				indices = arg.split(/[\s,]+/).map(Number).filter(function (n) { return isFinite(n) && n >= 1; });
			}
			config.selectedCommentIndices = indices;
			fs.writeFileSync(path.resolve('config.json'), JSON.stringify(config, null, 2) + '\n');
			if (indices.length === 0) console.log('[COMMENTS] Selected comments reset to ALL (random per target).'.yellow);
			else console.log('[COMMENTS] Selected comment index(es): %s'.green, indices.join(', '));
			return;
		}
		if (command !== 'SKIP') return;
		skipCurrentFriend = true;
		if (historyImportRunning || currentFriendName) {
			console.log((friendLogPrefix(currentFriendNumber) + ' Skip requested for %s.').yellow, currentFriendName || 'current historical target');
			if (skipDelay) skipDelay();
		} else {
			console.log((friendLogPrefix() + ' There is no friend currently being processed.').yellow);
		}
	});
}

function selectCommentForProfile() {
	loadComments();
	if (!comments.length) return ':HealthSD:';
	try { config = JSON.parse(fs.readFileSync(path.resolve('config.json'), 'utf-8')); } catch (err) { }

	var selected = config.selectedCommentIndices;
	if (Array.isArray(selected) && selected.length > 0) {
		var valid = selected.map(Number).filter(function (n) {
			return isFinite(n) && n >= 1 && n <= comments.length;
		}).map(function (n) {
			return comments[n - 1];
		});

		if (valid.length > 0) {
			return valid[Math.floor(Math.random() * valid.length)];
		}
	}

	return comments[Math.floor(Math.random() * comments.length)];
}

function askReciprocalDecision() {
	return new Promise(function (resolve) {
		reciprocalDecisionResolver = function (decision) {
			if (reciprocalDecisionTimer) clearTimeout(reciprocalDecisionTimer);
			reciprocalDecisionTimer = null;
			resolve(decision);
		};
		reciprocalDecisionTimer = setTimeout(function () {
			if (!reciprocalDecisionResolver) return;
			var resolveDecision = reciprocalDecisionResolver;
			reciprocalDecisionResolver = null;
			console.log('[RECIPROCAL] No response after 10 seconds — continuing automatically.'.yellow);
			resolveDecision('CONTINUE');
		}, 1 * 1000);
		console.log('[RECIPROCAL] Press Enter or type CONTINUE to send. Type anything else (including SKIP) to skip. Auto-continues in 10 seconds.'.yellow);
	});
}

function loadComments() {
	var raw = fs.readFileSync('./comments.txt', 'utf-8');
	var blocks = raw.split(/(?:\r?\n){2,}/);
	comments = blocks.map(function (block) {
		return block.split(/\r?\n/).map(function (line) { return line.replace(/[\r\n]+$/, ''); }).join('\n').trim();
	}).filter(Boolean);
	if (!comments.length) throw new Error('comments.txt has no usable comments.');
}

function getTargetCommentLimit(target) {
	try { config = JSON.parse(fs.readFileSync(path.resolve('config.json'), 'utf-8')); } catch (err) {}
	var targetComments = config.targetComments || {};
	var defaultLimit = Number(config.defaultCommentsPerFriend) || Number(config.maxCommentsPerBatch) || 6;
	if (target && target.customComments && isFinite(target.customComments) && Number(target.customComments) > 0) {
		return Number(target.customComments);
	}
	if (!target) return defaultLimit;
	var keys = [target.source, target.targetURL, target.artworkID, target.identifier, target.ownerSteamID, target.label];
	for (var i = 0; i < keys.length; i++) {
		var k = keys[i];
		if (k && targetComments[k] != null && isFinite(targetComments[k]) && Number(targetComments[k]) > 0) {
			return Number(targetComments[k]);
		}
	}
	if (target.source || target.targetURL) {
		var src = target.source || target.targetURL;
		for (var entryKey in targetComments) {
			if (entryKey && (src === entryKey || src.includes(entryKey) || entryKey.includes(src))) {
				return Number(targetComments[entryKey]);
			}
		}
	}
	return defaultLimit;
}

function targetFromLine(line) {
	var source = clean(line);
	var customComments = null;
	var parts = source.split(/\s*\|\s*comments=\s*|\s*\|\s*|\s+#comments=\s*/i);
	if (parts.length > 1 && isFinite(parts[1]) && Number(parts[1]) > 0) {
		source = parts[0].trim();
		customComments = Number(parts[1]);
	}
	var artworkMatch = source.match(/^https?:\/\/(?:www\.)?steamcommunity\.com\/sharedfiles\/filedetails\/\?(?:.*&)?id=(\d+)/i);
	if (artworkMatch) {
		return { type: 'ARTWORK', source: source, artworkID: artworkMatch[1], label: 'Artwork ' + artworkMatch[1], customComments: customComments };
	}
	var profileMatch = source.match(/^https?:\/\/(?:www\.)?steamcommunity\.com\/(id\/([^/?#]+)|profiles\/(\d+))\/?(?:[?#].*)?$/i);
	if (profileMatch) {
		return { type: 'PROFILE', source: source, identifier: profileMatch[3] ? new SteamID(profileMatch[3]) : profileMatch[2], label: profileMatch[3] || profileMatch[2], customComments: customComments };
	}
	throw new Error('Invalid Steam profile or artwork URL: ' + source);
}
var friendFromLine = targetFromLine;

function loadFriends(includeDisabled) {
	try { config = JSON.parse(fs.readFileSync(path.resolve('config.json'), 'utf-8')); } catch (err) { }
	var targetMode = config.targetMode || 'BOTH';

	var friendLines = fs.existsSync('./friends.txt') ? fs.readFileSync('./friends.txt', 'utf-8').split(/\r?\n/).map(clean).filter(Boolean) : [];
	var artworkLines = fs.existsSync('./artworks.txt') ? fs.readFileSync('./artworks.txt', 'utf-8').split(/\r?\n/).map(clean).filter(Boolean) : [];

	var lines = [];
	if (targetMode === 'ARTWORKS_ONLY') {
		lines = artworkLines;
	} else if (targetMode === 'PROFILES_ONLY') {
		lines = friendLines;
	} else {
		lines = friendLines.concat(artworkLines);
	}

	friends = [];
	allFriendEntries = [];
	lines.forEach(function (line) {
		if (/^\[EXCLUDED\]/i.test(line)) return;
		var disabled = /^---\s*/.test(line);
		try {
			var target = targetFromLine(line.replace(/^---\s*/, ''));
			target.disabled = disabled;
			allFriendEntries.push(target);
			if (!disabled || includeDisabled) friends.push(target);
		}
		catch (err) { console.log('[TARGET] Skipping invalid entry: %s'.yellow, err.message); }
	});

	if (config.prioritizeReciprocal !== false) {
		// This is the actual posting order. It deliberately matches the dashboard
		// priority: a return within the recent window is required, and a high
		// lifetime return count boosts someone who is also recent.
		friends.sort(function (a, b) {
			return getTargetReciprocalScore(b) - getTargetReciprocalScore(a);
		});
	}
}

function getTargetReciprocalScore(target) {
	try {
		var state = null;
		var sourceURL = target.source || '';
		var entries = Object.entries(reciprocalTracking);
		for (var i = 0; i < entries.length; i++) {
			var k = entries[i][0];
			var v = entries[i][1];
			if (v.profileURL === sourceURL || (v.artworkURLs && v.artworkURLs.includes(sourceURL)) || sourceURL.includes(k)) {
				state = v;
				break;
			}
		}
		if (!state) return 0;
		var sent = Number(state.totalSent || state.commentsSent || 0);
		var returned = Number(state.totalReturned || state.commentsReceived || 0);
		var ratio = sent > 0 ? (returned / sent) : 1;
		var recentDays = Math.max(1, Number(config.activeReturnerRecentDays) || 7);
		var highReturnCount = Math.max(1, Number(config.activeReturnerHighReturnCount) || 6);
		var lastIncoming = Number(state.lastProcessedIncomingAt || 0);
		var ageDays = lastIncoming ? Math.max(0, (Date.now() - lastIncoming) / (24 * 60 * 60 * 1000)) : Infinity;
		var isRecent = ageDays <= recentDays;
		if (!isRecent) return 0;
		var isHighVolume = returned >= highReturnCount;
		var group = isHighVolume ? 3 : 2;
		var recencyScore = Math.round((recentDays - ageDays + 1) * 100);
		return (group * 100000) + recencyScore + (returned * 20) + Math.round(ratio * 100);
	} catch (e) {
		return 0;
	}
}

function getMainWebSession() {
	return new Promise(function (resolve) {
		user.once('webSession', function (sessionID, cookies) { community.setCookies(cookies); resolve(); });
		user.webLogOn();
	});
}

function isSteamRateLimitError(err) {
	var message = (err && (err.message || String(err))) || '';
	return (err && err.code == 429) || /\b429\b|too many requests|rate limit/i.test(message);
}

function waitForSteamLookupCooldown() {
	var remaining = steamLookupCooldownUntil - Date.now();
	return remaining > 0 ? wait(remaining) : Promise.resolve();
}

function getSteamUser(friend, attempt) {
	attempt = attempt || 1;
	if (attempt === 1) {
		var cachedUser = cachedSteamUser(friend);
		if (cachedUser) return Promise.resolve(cachedUser);
	}
	return waitForSteamLookupCooldown().then(function () { return new Promise(function (resolve, reject) {
		community.getSteamUser(friend.identifier, function (err, steamUser) {
			if (err) {
				if (isSteamRateLimitError(err)) {
					if (attempt >= 3) return reject(new Error('Steam profile lookup remained rate limited after 3 attempts: ' + (err.message || err)));
					var cooldownMs = Math.min(maxSteamLookupRateLimitWait, steamLookupRateLimitWait * Math.pow(2, attempt - 1));
					steamLookupCooldownUntil = Math.max(steamLookupCooldownUntil, Date.now() + cooldownMs);
					console.log('[STEAM] Profile lookup rate limited (429). Pausing all profile lookups for %s minute(s), then retrying %s (%s/3).'.yellow, Math.round(cooldownMs / 60000), friend.source || friend.identifier, attempt + 1);
					return waitForSteamLookupCooldown().then(function () {
						return getSteamUser(friend, attempt + 1).then(resolve, reject);
					});
				}
				if (attempt < 3) {
					var retryWaitMs = (attempt === 2) ? (5 * 60 * 1000) : (2 * 60 * 1000);
					var retryWaitMin = (attempt === 2) ? 5 : 2;
					console.log('[STEAM] Could not open %s: %s. Waiting %s minutes before retry %s/3.'.yellow, friend.source || friend.identifier, err.message || err, retryWaitMin, attempt + 1);
					return wait(retryWaitMs).then(function () {
						return getSteamUser(friend, attempt + 1).then(resolve, reject);
					});
				}
				return reject(new Error('Failed after 3 attempts: ' + (err.message || err)));
			}
			cacheSteamUser(friend, steamUser);
			resolve(steamUser);
		});
	}); });
}

function getNonEmptyName(primary, fallbackLabel, fallbackIdentifier, fallbackSteamID, fallbackSource) {
	var candidates = [primary, fallbackLabel, fallbackIdentifier, fallbackSteamID, fallbackSource];
	for (var i = 0; i < candidates.length; i++) {
		var candidate = candidates[i];
		if (candidate != null) {
			var str = String(candidate).trim();
			if (str.length > 0) return str;
		}
	}
	return 'Steam Target';
}

function getSteamArtwork(target, attempt) {
	attempt = attempt || 1;
	return new Promise(function (resolve, reject) {
		var reqOpts = {
			uri: 'https://steamcommunity.com/sharedfiles/filedetails/?id=' + target.artworkID,
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
				'Accept-Language': 'en-US,en;q=0.9'
			}
		};
		community.httpRequestGet(reqOpts, function (err, response, body) {
			if (err || !body) {
				if (attempt < 3) {
					var retryWaitMs = (attempt === 2) ? (5 * 60 * 1000) : (2 * 60 * 1000);
					var retryWaitMin = (attempt === 2) ? 5 : 2;
					console.log('[STEAM] Could not open artwork %s: %s. Waiting %s minutes before retry %s/3.'.yellow, target.artworkID, (err && err.message) || 'Empty response', retryWaitMin, attempt + 1);
					return wait(retryWaitMs).then(function () {
						return getSteamArtwork(target, attempt + 1).then(resolve, reject);
					});
				}
				return reject(new Error('Failed to load artwork after 3 attempts: ' + ((err && err.message) || 'Empty response')));
			}
			try {
				var $ = Cheerio.load(body);
				var title = $('.workshopItemTitle').text().trim() ||
					$('.workshop_title').text().trim() ||
					$('title').text().replace(/^Steam Community :: (?:Artwork :: )?/i, '').replace(/\s*-\s*Steam Workshop\s*$/i, '').trim() ||
					('Artwork ' + target.artworkID);

				var ownerHref = $('.creatorsBlock .friendBlockLinkOverlay, .creatorsBlock a, .friendBlockLinkOverlay, .friendBlockLink').first().attr('href') ||
					$('.breadcrumbs a[href*="steamcommunity.com/id/"], .breadcrumbs a[href*="steamcommunity.com/profiles/"]').last().attr('href');

				if (!ownerHref) {
					$('a[href*="steamcommunity.com/id/"], a[href*="steamcommunity.com/profiles/"]').each(function () {
						var h = $(this).attr('href');
						if (h && (h.includes('/images') || h.includes('/videos') || h.includes('/id/') || h.includes('/profiles/'))) {
							ownerHref = h;
							return false;
						}
					});
				}

				var rawOwner = null;
				var ownerSteamIDFromPage = null;
				var ownerAccountID = $('.creatorsBlock [data-miniprofile], .friendBlock[data-miniprofile], .friendBlockLinkOverlay[data-miniprofile]').first().attr('data-miniprofile');
				if (ownerAccountID) {
					try { ownerSteamIDFromPage = String(new SteamID('[U:1:' + ownerAccountID + ']')); } catch (ownerIDErr) { }
				}
				if (ownerHref) {
					var matchProfile = ownerHref.match(/steamcommunity\.com\/profiles\/(\d+)/i);
					if (matchProfile) rawOwner = matchProfile[1];
					else {
						var matchCustom = ownerHref.match(/steamcommunity\.com\/id\/([^/?#]+)/i);
						if (matchCustom) rawOwner = matchCustom[1];
					}
				}

				if (!rawOwner && !ownerSteamIDFromPage) {
					return reject(new Error('Could not parse artwork owner: Could not resolve owner link from HTML page'));
				}

				var parsedOwnerName = $('.creatorsBlock .friendBlockContent').text().split('\n')[0].trim() ||
					$('.breadcrumbs a[href*="steamcommunity.com/id/"], .breadcrumbs a[href*="steamcommunity.com/profiles/"]').last().text().replace(/['’]s\s*(?:Artwork|Videos|Screenshots)?$/i, '').trim();

				// Steam embeds the creator's account ID in normal artwork pages. Prefer
				// it over a vanity-name lookup, which can fail even for a valid artwork.
				if (ownerSteamIDFromPage) {
					var pageOwnerName = getNonEmptyName(parsedOwnerName, ownerSteamIDFromPage, target.artworkID, target.source);
					return resolve({
						type: 'ARTWORK', artworkID: target.artworkID, title: title,
						ownerSteamID: ownerSteamIDFromPage, ownerName: pageOwnerName,
						displayName: 'Artwork "' + title + '" (Owner: ' + pageOwnerName + ')', targetURL: target.source
					});
				}

				console.log('[ARTWORK] Resolving owner %s for artwork %s.'.gray, rawOwner, target.artworkID);
				// Fallback for unusual pages without a miniprofile account ID.
				getSteamUser({ identifier: rawOwner, source: target.source }).then(function (ownerUser) {
					var ownerSteamID = (ownerUser && ownerUser.steamID) ? String(ownerUser.steamID) : (rawOwner.match(/^\d+$/) ? rawOwner : null);
					if (!ownerSteamID) {
						return reject(new Error('Could not parse artwork owner: Failed to resolve owner SteamID for ' + rawOwner));
					}

					var ownerName = getNonEmptyName(ownerUser && ownerUser.name, parsedOwnerName, ownerSteamID, target.artworkID, target.source);
					resolve({
						type: 'ARTWORK',
						artworkID: target.artworkID,
						title: title,
						ownerSteamID: ownerSteamID,
						ownerName: ownerName,
						displayName: 'Artwork "' + title + '" (Owner: ' + ownerName + ')',
						targetURL: target.source
					});
				}).catch(function (ownerErr) {
					reject(new Error('Could not resolve artwork owner ' + rawOwner + ': ' + (ownerErr.message || ownerErr)));
				});
			} catch (parseErr) {
				reject(parseErr);
			}
		});
	});
}

async function resolveTarget(target) {
	if (target.type === 'ARTWORK') {
		return await getSteamArtwork(target);
	} else {
		// Numeric profile URLs already contain the SteamID needed for posting and
		// reciprocal tracking. Avoid an unnecessary getSteamUser request, which
		// is the endpoint currently returning 429 for this account.
		if (target.identifier instanceof SteamID) {
			var knownSteamID = String(target.identifier);
			var knownState = reciprocalTracking[knownSteamID] || {};
			var knownName = getNonEmptyName(cachedProfileName(knownSteamID), knownState.profileName, target.label, knownSteamID, target.source);
			return {
				type: 'PROFILE',
				ownerSteamID: knownSteamID,
				ownerName: knownName,
				displayName: knownName,
				targetURL: target.source,
				steamUser: { steamID: target.identifier }
			};
		}
		var steamUser = await getSteamUser(target);
		var ownerSteamID = String(steamUser.steamID);
		var safeName = getNonEmptyName(
			steamUser.name,
			target.label,
			target.identifier,
			ownerSteamID,
			target.source
		);
		return {
			type: 'PROFILE',
			ownerSteamID: ownerSteamID,
			ownerName: safeName,
			displayName: safeName,
			targetURL: target.source,
			steamUser: steamUser
		};
	}
}

function waitForFriendsList() {
	return new Promise(function (resolve) {
		if (friendsListReady) return resolve();
		user.once('friendsList', resolve);
	});
}

function getProfileCommentPage(profileID, start, count) {
	return new Promise(function (resolve, reject) {
		community.httpRequestGet({
			uri: 'https://steamcommunity.com/comment/Profile/render/' + profileID + '/-1?start=' + start + '&count=' + count + '&feature2=-1',
			json: true
		}, function (err, response, body) {
			if (err) return reject(err);
			if (!body || !body.success) return reject(new Error((body && body.error) || 'Could not load profile comments'));
			resolve(body);
		});
	});
}

function getArtworkCommentPage(ownerSteamID, artworkID, start, count) {
	return new Promise(function (resolve, reject) {
		community.httpRequestGet({
			uri: 'https://steamcommunity.com/comment/PublishedFile_Public/render/' + ownerSteamID + '/' + artworkID + '/?start=' + start + '&count=' + count + '&feature2=-1',
			json: true
		}, function (err, response, body) {
			if (err) return reject(err);
			if (!body || !body.success) return reject(new Error((body && body.error) || 'Could not load artwork comments'));
			resolve(body);
		});
	});
}

function commentAuthorID(entry) {
	var accountID = entry.find('[data-miniprofile]').first().attr('data-miniprofile');
	if (!accountID) return null;
	try { return String(new SteamID('[U:1:' + accountID + ']')); }
	catch (err) { return null; }
}

async function getRecentCommenterCounts(profileID) {
	var counts = new Map();
	var start = 0;
	var pageSize = 100;
	var cutoff = Date.now() - DISCOVERY_WINDOW_MS;
	while (true) {
		var body = await getProfileCommentPage(profileID, start, pageSize);
		var $ = Cheerio.load(body.comments_html || '');
		var entries = $('.commentthread_comment.responsive_body_text[id]').toArray();
		var reachedOlderComment = false;
		for (var index = 0; index < entries.length; index++) {
			var entry = $(entries[index]);
			var timestamp = parseSteamCommentDate(entry, $);
			// Unreliable/missing dates are deliberately not counted.
			if (!timestamp.date) continue;
			if (timestamp.date.getTime() < cutoff) { reachedOlderComment = true; break; }
			var authorID = commentAuthorID(entry);
			if (authorID) counts.set(authorID, (counts.get(authorID) || 0) + 1);
		}
		start += entries.length;
		if (reachedOlderComment || !entries.length || start >= body.total_count) return counts;
	}
}

async function getTotalProfileComments(profileID) {
	var body = await getProfileCommentPage(profileID, 0, 1);
	var total = Number(body.total_count);
	if (!isFinite(total) || total < 0) throw new Error('Steam did not return a reliable total comment count');
	return total;
}

function relationshipFor(steamID) {
	return user.myFriends && user.myFriends[String(steamID)];
}

function candidateTier(commentCount) {
	if (commentCount >= 20) return { code: 'TIER A', description: 'very active' };
	if (commentCount >= 12) return { code: 'TIER B', description: 'active' };
	return { code: 'TIER C', description: 'qualified' };
}

function addCandidateToFile(steamID, tier, stats) {
	var filePath = './candidates.txt';
	var profileURL = 'https://steamcommunity.com/profiles/' + steamID;
	var heading = '[ ' + tier.code + ' ]';
	var lines = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8').split(/\r?\n/) : [];
	var existingIndex = lines.findIndex(function (line) { return line.indexOf(profileURL) === 0; });
	if (existingIndex !== -1) lines.splice(existingIndex, 1);
	var headingIndex = lines.indexOf(heading);
	var sources = Object.keys(stats.profileCounts).map(function (name) { return name + ' (' + stats.profileCounts[name] + ')'; }).join(', ');
	var candidateLine = profileURL + ' - ' + stats.totalComments + ' comments in 48h / suggested on ' + stats.profiles.size + ' friend profile' + (stats.profiles.size === 1 ? '' : 's') + ' / ' + sources;
	if (headingIndex === -1) {
		if (lines.length && lines[lines.length - 1] !== '') lines.push('');
		lines.push(heading, candidateLine);
	}
	else {
		lines.splice(headingIndex + 1, 0, candidateLine);
	}
	fs.writeFileSync(filePath, lines.join('\n').replace(/\n*$/, '\n'));
}

async function considerCandidate(steamID, qualifyingFriendName, count) {
	var sources = candidateSources.get(steamID) || [];
	var stats = candidateStats.get(steamID) || { totalComments: 0, maxComments: 0, profiles: new Set(), profileCounts: {} };
	if (sources.indexOf(qualifyingFriendName) === -1) {
		sources.push(qualifyingFriendName);
		stats.totalComments += count;
		stats.maxComments = Math.max(stats.maxComments, count);
		stats.profiles.add(qualifyingFriendName);
		stats.profileCounts[qualifyingFriendName] = count;
	}
	candidateSources.set(steamID, sources);
	candidateStats.set(steamID, stats);
	var tier = candidateTier(stats.maxComments);
	console.log('[DISCOVERY] SteamID: %s'.gray, steamID);
	console.log('[DISCOVERY] %s comments found on %s within 48 hours'.gray, count, qualifyingFriendName);
	console.log('[DISCOVERY] Grade: %s - %s'.cyan, tier.code, tier.description);

	if (friendSteamIDs.has(steamID)) return console.log('[DISCOVERY] Candidate rejected: already in friends.txt'.yellow);
	var relationship = relationshipFor(steamID);
	if (relationship === SteamUser.EFriendRelationship.Friend) return console.log('[DISCOVERY] Candidate rejected: already friends'.yellow);
	if (relationship === SteamUser.EFriendRelationship.RequestInitiator) return console.log('[DISCOVERY] Candidate rejected: Friend request already pending'.yellow);
	if (relationship === SteamUser.EFriendRelationship.RequestRecipient) return console.log('[DISCOVERY] Candidate rejected: candidate has sent you a pending friend request'.yellow);
	if (candidateSteamIDs.has(steamID)) {
		addCandidateToFile(steamID, tier, stats);
		return console.log('[DISCOVERY] Candidate already recorded — suggested on %s friend profile%s'.yellow, stats.profiles.size, stats.profiles.size === 1 ? '' : 's');
	}

	var candidate;
	try { candidate = await getSteamUser({ identifier: new SteamID(steamID) }); }
	catch (err) { return console.log('[DISCOVERY] Candidate rejected: profile information could not be determined'.yellow); }
	console.log('[DISCOVERY] Candidate: %s'.cyan, candidate.name || steamID);
	var total;
	try { total = await getTotalProfileComments(steamID); }
	catch (err) { return console.log('[DISCOVERY] Candidate rejected: total comments could not be determined'.yellow); }
	console.log('[DISCOVERY] Total comments: %s'.gray, total);
	if (total >= DISCOVERY_MAX_TOTAL_COMMENTS) return console.log('[DISCOVERY] Candidate rejected: %s or more comments'.yellow, DISCOVERY_MAX_TOTAL_COMMENTS);

	addCandidateToFile(steamID, tier, stats);
	candidateSteamIDs.add(steamID);
	console.log('[DISCOVERY] Candidate accepted'.green);
}

async function discoverCandidatesForProfile(profile, friendName) {
	var counts;
	try { counts = await getRecentCommenterCounts(profile.steamID); }
	catch (err) { console.log('[DISCOVERY] Could not inspect %s: %s'.yellow, friendName, err.message || err); return; }
	for (var entry of counts.entries()) {
		if (entry[1] >= DISCOVERY_MIN_COMMENTS) await considerCandidate(entry[0], friendName, entry[1]);
	}
}

async function runDiscovery() {
	discoveryRunning = true;
	try {
		loadFriends();
		loadCandidateSteamIDs();
		candidateSources = new Map();
		candidateStats = new Map();
		await resolveFriendSteamIDs();
		console.log('[DISCOVERY] Scanning %s target(s) from friends.txt.'.cyan, friends.length);
		for (var index = 0; index < friends.length; index++) {
			var resolved;
			console.log('[DISCOVERY] Discovering people from %s (%s/%s).'.gray, friends[index].label, index + 1, friends.length);
			try { resolved = await resolveTarget(friends[index]); }
			catch (err) { console.log('[DISCOVERY] Could not open %s: %s'.yellow, friends[index].source, err.message || err); continue; }
			await discoverCandidatesForProfile({ steamID: resolved.ownerSteamID }, resolved.ownerName || friends[index].label);
		}
		console.log('[DISCOVERY] Scan complete.'.green);
	}
	finally {
		discoveryRunning = false;
	}
}

function loadCandidateSteamIDs() {
	candidateSteamIDs = new Set();
	if (!fs.existsSync('./candidates.txt')) return;
	fs.readFileSync('./candidates.txt', 'utf-8').split(/\r?\n/).map(clean).forEach(function (line) {
		var match = line.match(/^https?:\/\/(?:www\.)?steamcommunity\.com\/profiles\/(\d+)\/?(?:\s+.*)?$/i);
		if (match) candidateSteamIDs.add(match[1]);
	});
}

async function resolveFriendSteamIDs() {
	friendSteamIDs = new Set();
	for (var index = 0; index < allFriendEntries.length; index++) {
		try {
			var resolved = await resolveTarget(allFriendEntries[index]);
			friendSteamIDs.add(String(resolved.ownerSteamID));
		}
		catch (err) {
			console.log('[DISCOVERY] Could not resolve friends.txt entry %s; it cannot be used for duplicate filtering.'.yellow, allFriendEntries[index].source);
		}
	}
}

function normalizeCommentForVerification(value) {
	return String(value || '').replace(/\r\n/g, '\n').trim();
}

function shouldAssumeSuccessOn403(targetInfo) {
	var configuredOwners = Array.isArray(config.assumeSuccessOn403Owners) ? config.assumeSuccessOn403Owners : [];
	return configuredOwners.map(String).includes(String(targetInfo && targetInfo.ownerSteamID));
}

async function verifyCommentAfter403(targetInfo, comment, attemptedAt) {
	await wait(comment403VerificationWait);
	var body = targetInfo.type === 'ARTWORK'
		? await getArtworkCommentPage(targetInfo.ownerSteamID, targetInfo.artworkID, 0, 100)
		: await getProfileCommentPage(targetInfo.ownerSteamID, 0, 100);
	var $ = Cheerio.load(body.comments_html || '');
	var expected = normalizeCommentForVerification(comment);
	var entries = $('.commentthread_comment.responsive_body_text[id]').toArray();
	for (var index = 0; index < entries.length; index++) {
		var entry = $(entries[index]);
		if (commentAuthorID(entry) !== String(user.steamID)) continue;
		var timestamp = parseSteamCommentDate(entry, $);
		if (!timestamp.date || timestamp.date.getTime() < attemptedAt - 60000) continue;
		var postedText = normalizeCommentForVerification(entry.find('.commentthread_comment_text').text());
		if (postedText === expected) return true;
	}
	return false;
}

function postComment(targetInfo, comment, attempt) {
	attempt = attempt || 1;
	var targetType = (typeof targetInfo === 'object' && targetInfo.type) ? targetInfo.type : 'PROFILE';
	var ownerSteamID = (typeof targetInfo === 'object') ? targetInfo.ownerSteamID : targetInfo;
	var artworkID = (typeof targetInfo === 'object') ? targetInfo.artworkID : null;
	var attemptedAt = Date.now();

	return new Promise(function (resolve, reject) {
		function handleResult(error) {
			if (!error) return resolve();
			var errMsg = error.message || String(error);
			var is403 = error.code == 403 || /\b403\b|forbidden/i.test(errMsg);
			if (is403) {
				console.log('[STEAM] Comment returned 403. Verifying whether Steam accepted it before taking any further action...'.yellow);
				return verifyCommentAfter403(targetInfo, comment, attemptedAt).then(function (wasPosted) {
					if (wasPosted) {
						console.log('[STEAM] Verified that the comment was posted despite the 403; not retrying.'.green);
						return resolve();
					}
					if (shouldAssumeSuccessOn403(targetInfo)) {
						console.log('[STEAM] 403 success assumed for this configured target; not retrying.'.yellow);
						return resolve();
					}
					var unknownOutcome = new Error('HTTP 403; comment was not visible after verification. Target stopped to prevent duplicate comments.');
					unknownOutcome.outcomeUnknown = true;
					reject(unknownOutcome);
				}).catch(function (verifyErr) {
					if (shouldAssumeSuccessOn403(targetInfo)) {
						console.log('[STEAM] 403 success assumed for this configured target after verification failed; not retrying.'.yellow);
						return resolve();
					}
					var unknownOutcome = new Error('HTTP 403; verification failed (' + (verifyErr.message || verifyErr) + '). Target stopped to prevent duplicate comments.');
					unknownOutcome.outcomeUnknown = true;
					reject(unknownOutcome);
				});
			}
			if (attempt >= maxCommentRetries) return reject(new Error('Maximum retry limit (' + maxCommentRetries + ') reached: ' + errMsg));
			if (error.code == 429 || errMsg.includes('429') || errMsg.includes('Rate')) {
				betweenComments = Math.min(30000, betweenComments + 10000);
				console.log('Rate limited by Steam. Waiting %s seconds, then retrying. New between-comments delay: %s seconds.'.yellow, Math.round(rateLimitWait / 1000), Math.round(betweenComments / 1000));
				return waitForDelayOrSkip(rateLimitWait).then(function () { return postComment(targetInfo, comment, attempt + 1); }).then(resolve, reject);
			}

			if (skipCurrentFriend) return reject(new Error('Skipped by user.'));

			// If error suggests expired web session, refresh web session before retry
			var isSessionErr = /session|log|auth|cookie|401/i.test(errMsg);
			var refreshPromise = isSessionErr ? getMainWebSession().catch(function () { }) : Promise.resolve();

			// Progressive backoff schedule: 30s, 2m (120s), 3m (180s), 5m (300s), 10m (600s)
			var retryDelays = [30000, 120000, 180000, 300000, 600000];
			var retryDelay = retryDelays[Math.min(attempt - 1, retryDelays.length - 1)];

			betweenComments = Math.min(30000, betweenComments * 2);
			console.log(('Steam rejected the comment (' + errMsg + '). Waiting ' + Math.round(retryDelay / 1000) + ' seconds, then retrying (attempt ' + (attempt + 1) + '). New delay: ' + Math.round(betweenComments / 1000) + 's.').yellow);

			refreshPromise.then(function () {
				return waitForDelayOrSkip(jitterDelay(retryDelay));
			}).then(function () {
				if (skipCurrentFriend) return reject(new Error('Skipped by user.'));
				return postComment(targetInfo, comment, attempt + 1).then(resolve, reject);
			});
		}

		if (targetType === 'ARTWORK' && artworkID) {
			community.postSharedFileComment(targetInfo.ownerSteamID || ownerSteamID, artworkID, comment, handleResult);
		} else {
			var profileID = (typeof targetInfo === 'object' && targetInfo.steamUser) ? targetInfo.steamUser.steamID : (targetInfo.steamID || ownerSteamID);
			community.postUserComment(profileID, comment, handleResult);
		}
	});
}

function formatElapsed(date) {
	if (!(date instanceof Date) || isNaN(date.getTime())) return 'date unavailable';
	var seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
	if (seconds < 60) return seconds + ' seconds ago';
	if (seconds < 3600) return Math.floor(seconds / 60) + ' minutes ago';
	if (seconds < 86400) return Math.floor(seconds / 3600) + ' hours ago';
	return Math.floor(seconds / 86400) + ' days ago';
}

function formatActualDate(date) {
	if (!(date instanceof Date) || isNaN(date.getTime())) return null;
	return date.toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}

function readableTimestamp(timestamp) {
	if (!Number(timestamp)) return null;
	return formatActualDate(new Date(Number(timestamp)));
}

function loadReciprocalTracking() {
	if (!fs.existsSync('./reciprocal_tracking.json')) {
		reciprocalTracking = {};
		return;
	}
	try {
		var data = JSON.parse(fs.readFileSync('./reciprocal_tracking.json', 'utf-8'));
		reciprocalTracking = data && typeof data === 'object' ? data : {};
		Object.keys(reciprocalTracking).forEach(function (steamID) {
			var entry = reciprocalTracking[steamID];
			if (!entry || typeof entry !== 'object') entry = reciprocalTracking[steamID] = {};
			entry.profileURL = entry.profileURL || 'https://steamcommunity.com/profiles/' + steamID;
			entry.lastOutgoingBatchAtReadable = readableTimestamp(entry.lastOutgoingBatchAt);
			if (!Number.isFinite(entry.commentsSent)) entry.commentsSent = entry.lastOutgoingBatchAt ? COMMENTS_PER_FRIEND : 0;
			if (!Number.isFinite(entry.commentsReceived)) entry.commentsReceived = 0;
		});
		saveReciprocalTracking();
	}
	catch (err) {
		console.log('[RECIPROCAL] Could not read reciprocal_tracking.json; no batches will be treated as previous until it is fixed.'.yellow);
		reciprocalTracking = {};
	}
}

function saveReciprocalTracking() {
	fs.writeFileSync('./reciprocal_tracking.json', JSON.stringify(reciprocalTracking, null, 2) + '\n');
}

function reciprocalState(steamID) {
	if (!reciprocalTracking[steamID]) reciprocalTracking[steamID] = {};
	var state = reciprocalTracking[steamID];
	state.profileURL = state.profileURL || 'https://steamcommunity.com/profiles/' + steamID;
	state.totalSent = Number(state.totalSent || state.commentsSent || (state.lastOutgoingBatchAt ? COMMENTS_PER_FRIEND : 0));
	state.totalReturned = Number(state.totalReturned || state.commentsReceived || 0);
	state.accountedReturned = Number(state.accountedReturned || 0);
	state.lastOutgoingBatchAt = Number(state.lastOutgoingBatchAt || 0);
	state.lastProcessedIncomingAt = Number(state.lastProcessedIncomingAt || state.lastOutgoingBatchAt || 0);
	state.availableReciprocal = Math.max(0, state.totalReturned - state.accountedReturned);
	state.waitingSince = Number(state.waitingSince || state.lastOutgoingBatchAt || 0);
	state.excluded = Boolean(state.excluded);
	return reciprocalTracking[steamID];
}

function excludeFriend(source, state) {
	var backupPath = './friends.backup.' + Date.now() + '.txt';
	fs.copyFileSync('./friends.txt', backupPath);
	var lines = fs.readFileSync('./friends.txt', 'utf-8').split(/\r?\n/);
	var index = lines.findIndex(function (line) { return clean(line).replace(/^---\s*/, '') === source; });
	if (index === -1 || /^---\s*/.test(clean(lines[index]))) return;
	lines.splice(index, 1, '--- ' + source, '    [EXCLUDED] No reciprocation for 48 hours — Sent: ' + state.totalSent + ', Returned: ' + state.totalReturned);
	fs.writeFileSync('./friends.txt', lines.join('\n').replace(/\n*$/, '\n'));
	activity('friend_excluded', { profile: source, backup: backupPath, sent: state.totalSent, returned: state.totalReturned });
	state.excluded = true;
	saveReciprocalTracking();
}

function disableTargetWithReason(source, reason) {
	var filePath = String(source).includes('sharedfiles/filedetails') ? './artworks.txt' : './friends.txt';
	var backupPath = filePath.replace('.txt', '.backup.' + Date.now() + '.txt');
	if (fs.existsSync(filePath)) fs.copyFileSync(filePath, backupPath);
	var lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
	var index = lines.findIndex(function (line) { return clean(line).replace(/^---\s*/, '') === clean(source); });
	if (index === -1) return;
	if (/^---\s*/.test(clean(lines[index]))) return;
	lines.splice(index, 1, '--- ' + source, '    [EXCLUDED] ' + reason);
	fs.writeFileSync(filePath, lines.join('\n').replace(/\n*$/, '\n'));
	activity('target_disabled', { target: source, reason: reason, backup: backupPath });
}

async function getNewReturnedComments(friendSteamID, afterTimestamp) {
	var effectiveAfterTimestamp = Math.max(Number(afterTimestamp || 0), reciprocalCutoffMs);
	var found = [];
	var start = 0;
	while (true) {
		var body = await getProfileCommentPage(user.steamID, start, 100);
		var $ = Cheerio.load(body.comments_html || '');
		var entries = $('.commentthread_comment.responsive_body_text[id]').toArray();
		var older = false;
		for (var index = 0; index < entries.length; index++) {
			var entry = $(entries[index]);
			var timestamp = parseSteamCommentDate(entry, $);
			if (!timestamp.date) continue;
			if (timestamp.date.getTime() <= effectiveAfterTimestamp) { older = true; break; }
			if (commentAuthorID(entry) === String(friendSteamID)) found.push({ id: entry.attr('id'), timestamp: timestamp.date.getTime() });
		}
		start += entries.length;
		if (older || !entries.length || start >= body.total_count) return found;
	}
}

async function getAllCommentsByAuthor(profileID, authorSteamID, label, maxDaysOld, afterTimestamp, artworkID) {
	var dynamicCutoff = maxDaysOld ? (Date.now() - (maxDaysOld * 24 * 60 * 60 * 1000)) : 0;
	var cutoffMs = Math.max(dynamicCutoff, reciprocalCutoffMs, Number(afterTimestamp || 0));
	var found = [];
	var start = 0;
	var hitCutoff = false;
	while (true) {
		if (skipCurrentFriend) throw new Error('Skipped by user.');
		var body = artworkID ? await getArtworkCommentPage(profileID, artworkID, start, 100) : await getProfileCommentPage(profileID, start, 100);
		var $ = Cheerio.load(body.comments_html || '');
		var entries = $('.commentthread_comment.responsive_body_text[id]').toArray();
		for (var index = 0; index < entries.length; index++) {
			var entry = $(entries[index]);
			var timestamp = parseSteamCommentDate(entry, $);
			if (timestamp.date && timestamp.date.getTime() <= cutoffMs) {
				hitCutoff = true;
				break;
			}
			if (commentAuthorID(entry) === String(authorSteamID)) found.push({ id: entry.attr('id'), timestamp: timestamp.date ? timestamp.date.getTime() : null });
		}
		start += entries.length;
		var total = body.total_count || start;
		if (label) console.log(('[RECIPROCAL] ' + label + ': scanned ' + start + '/' + total + ' comments (found ' + found.length + ').').gray);
		if (hitCutoff || !entries.length || start >= total) return found;
	}
}

async function importReciprocalHistory() {
	historyImportRunning = true;
	try {
		loadFriends(true);
		console.log('[RECIPROCAL] Running historical comment check for %s target(s) (including disabled).'.cyan, friends.length);
		for (var index = 0; index < friends.length; index++) {
			var resolved;
			try { resolved = await resolveTarget(friends[index]); }
			catch (err) { console.log('[RECIPROCAL] Could not open %s: %s'.yellow, friends[index].source, err.message || err); continue; }
			var ownerSteamID = resolved.ownerSteamID;
			var state = reciprocalState(String(ownerSteamID));
			
			var previousCheckAt = state.lastHistoricalCheckAt || 0;
			if (previousCheckAt > 0) {
				console.log('[RECIPROCAL] Historical re-check for %s (%s/%s) — checking comments since %s...'.gray, resolved.ownerName || friends[index].label, index + 1, friends.length, state.lastHistoricalCheckAtReadable || readableTimestamp(previousCheckAt));
			} else {
				console.log('[RECIPROCAL] First historical check for %s (%s/%s)...'.gray, resolved.ownerName || friends[index].label, index + 1, friends.length);
			}

			currentFriendIndex = index;
			currentFriendNumber = index + 1;
			currentFriendName = resolved.ownerName || friends[index].label;
			if (skipCurrentFriend) { skipCurrentFriend = false; console.log('[RECIPROCAL] Skipped by user.'.yellow); continue; }
			var history, sentHistory;
			try {
				history = await getAllCommentsByAuthor(user.steamID, ownerSteamID, (resolved.ownerName || friends[index].label) + ' (received)', null, previousCheckAt);
				sentHistory = await getAllCommentsByAuthor(ownerSteamID, user.steamID, (resolved.ownerName || friends[index].label) + ' (sent)', null, previousCheckAt, resolved.type === 'ARTWORK' ? resolved.artworkID : null);
			}
			catch (err) { console.log('[RECIPROCAL] Could not check history for %s: %s'.yellow, resolved.ownerName || friends[index].label, err.message || err); continue; }

			state.profileURL = 'https://steamcommunity.com/profiles/' + ownerSteamID;
			state.profileName = resolved.ownerName || friends[index].label;
			if (!state.artworkURLs) state.artworkURLs = [];
			if (resolved.targetURL && resolved.type === 'ARTWORK' && !state.artworkURLs.includes(resolved.targetURL)) {
				state.artworkURLs.push(resolved.targetURL);
			}
			state.totalReturned = (state.totalReturned || 0) + history.length;
			state.totalSent = (state.totalSent || 0) + sentHistory.length;
			state.accountedReturned = (state.accountedReturned || 0) + history.length;
			
			var checkTimestamp = Date.now();
			state.lastHistoricalCheckAt = checkTimestamp;
			state.lastHistoricalCheckAtReadable = readableTimestamp(checkTimestamp);

			var datedHistory = history.filter(function (item) { return item.timestamp; });
			var datedSent = sentHistory.filter(function (item) { return item.timestamp; });
			if (datedHistory.length) {
				var maxIncoming = Math.max.apply(null, datedHistory.map(function (item) { return item.timestamp; }));
				state.lastProcessedIncomingAt = Math.max(state.lastProcessedIncomingAt || 0, maxIncoming);
				state.lastProcessedIncomingAtReadable = readableTimestamp(state.lastProcessedIncomingAt);
			}
			if (datedSent.length) {
				var maxOutgoing = Math.max.apply(null, datedSent.map(function (item) { return item.timestamp; }));
				state.lastOutgoingBatchAt = Math.max(state.lastOutgoingBatchAt || 0, maxOutgoing);
				state.lastOutgoingBatchAtReadable = readableTimestamp(state.lastOutgoingBatchAt);
				state.lastProcessedOutgoingAtReadable = state.lastOutgoingBatchAtReadable;
			}
			state.commentsReceived = state.totalReturned;
			state.commentsSent = state.totalSent;
			reciprocalTracking[String(ownerSteamID)] = state;
			saveReciprocalTracking();
			console.log(('[RECIPROCAL] Historical check for ' + state.profileName + ' complete on ' + state.lastHistoricalCheckAtReadable + '. Found ' + history.length + ' new received / ' + sentHistory.length + ' new sent (Total sent: ' + state.totalSent + ', received: ' + state.totalReturned + ').').green);
		}
		console.log('[RECIPROCAL] Historical check complete.'.green);
	}
	finally { historyImportRunning = false; }
}

function parseSteamCommentDate(entry, $) {
	// Steam renders an empty timestamp div before the real timestamp div. Select
	// only elements which actually hold date data instead of using .first().
	var candidates = entry.find('[data-timestamp], [data-time], time[datetime], .commentthread_comment_timestamp[title]').toArray();
	var visibleText = null;

	for (var index = 0; index < candidates.length; index++) {
		var timestampElement = $(candidates[index]);
		var raw = timestampElement.attr('data-timestamp') || timestampElement.attr('data-time') || timestampElement.attr('datetime');
		var displayed = clean(timestampElement.attr('title') || timestampElement.text());
		if (!visibleText && displayed) visibleText = displayed;
		if (!raw) continue;

		var numericTimestamp = Number(raw);
		var date = isFinite(numericTimestamp) && numericTimestamp > 0
			? new Date(numericTimestamp < 100000000000 ? numericTimestamp * 1000 : numericTimestamp)
			: new Date(raw);
		if (!isNaN(date.getTime())) return { date: date, visibleText: displayed || visibleText };
	}

	return { date: null, visibleText: visibleText };
}

// The installed steamcommunity helper sometimes selects Steam's empty timestamp
// div. Read the render HTML directly, page through it, and compare SteamIDs.
async function getLastCommentFrom(friendSteamID) {
	var start = 0;
	var pageSize = 100;
	while (true) {
		var body = await getProfileCommentPage(user.steamID, start, pageSize);
		var $ = Cheerio.load(body.comments_html || '');
		var entries = $('.commentthread_comment.responsive_body_text[id]').toArray();
		for (var entryIndex = 0; entryIndex < entries.length; entryIndex++) {
			var entry = $(entries[entryIndex]);
			var authorID = commentAuthorID(entry);
			var timestamp = parseSteamCommentDate(entry, $);
			if (authorID === String(friendSteamID)) {
				return { found: true, date: timestamp.date, visibleDateText: timestamp.visibleText };
			}
		}
		start += entries.length;
		if (!entries.length || start >= body.total_count) return { found: false, date: null, visibleDateText: null };
	}
}

async function getReturnedCommentCount(friendSteamID, lastOutgoingBatchAt) {
	var returnedComments = 0;
	var start = 0;
	var pageSize = 100;
	while (true) {
		var body = await getProfileCommentPage(user.steamID, start, pageSize);
		var $ = Cheerio.load(body.comments_html || '');
		var entries = $('.commentthread_comment.responsive_body_text[id]').toArray();
		var reachedPreviousBatch = false;
		for (var index = 0; index < entries.length; index++) {
			var entry = $(entries[index]);
			var timestamp = parseSteamCommentDate(entry, $);
			// Missing/invalid Steam timestamps are never accepted as reciprocation.
			if (!timestamp.date) continue;
			if (timestamp.date.getTime() <= lastOutgoingBatchAt) { reachedPreviousBatch = true; break; }
			if (commentAuthorID(entry) === String(friendSteamID)) returnedComments++;
		}
		start += entries.length;
		if (reachedPreviousBatch || !entries.length || start >= body.total_count) return returnedComments;
	}
}

async function processFriend(friend, friendNumber) {
	var resolved;
	currentFriendName = friend.label;
	currentFriendNumber = friendNumber;
	skipCurrentFriend = false;
	try { resolved = await resolveTarget(friend); }
	catch (err) { console.log((friendLogPrefix(friendNumber) + ' Could not open %s: %s').red, friend.source, err.message || err); currentFriendName = null; currentFriendNumber = null; return; }

	var name = resolved.displayName;
	if (processedFriendSteamIDs.has(resolved.targetURL)) {
		console.log((friendLogPrefix(friendNumber) + ' Duplicate target in friends.txt — skipped.').yellow);
		currentFriendName = null; currentFriendNumber = null; return;
	}
	processedFriendSteamIDs.add(resolved.targetURL);
	currentFriendName = name;
	console.log((friendLogPrefix(friendNumber) + ' Processing %s (%s)').cyan, name, friend.source);
	if (skipCurrentFriend) {
		console.log((friendLogPrefix(friendNumber) + ' Skipped %s by user.').yellow, name);
		currentFriendName = null;
		currentFriendNumber = null;
		return;
	}
	var trackingKey = resolved.ownerSteamID;
	if (resolved.type === 'PROFILE' && user.myFriends && Object.keys(user.myFriends).length > 0) {
		var rel = relationshipFor(trackingKey);
		if (rel !== SteamUser.EFriendRelationship.Friend) {
			console.log((friendLogPrefix(friendNumber) + ' %s is no longer on your Steam friend list — auto-disabling target.').yellow, name);
			disableTargetWithReason(friend.source, 'Unfriended on Steam — No longer on friend list');
			currentFriendName = null;
			currentFriendNumber = null;
			return;
		}
	}
	var previousBatch = reciprocalState(trackingKey);
	var targetLimit = getTargetCommentLimit(resolved) || getTargetCommentLimit(friend);
	var amountToSend = targetLimit;

	console.log('[RECIPROCAL] Checking return comments from %s (Owner: %s)...'.gray, name, resolved.ownerName);
	var returnedCount = 0;
	try {
		var afterTimestamp = Math.max(Number(previousBatch.lastProcessedIncomingAt || 0), Number(previousBatch.lastOutgoingBatchAt || 0));
		var incoming = await getNewReturnedComments(resolved.ownerSteamID, afterTimestamp);
		returnedCount = incoming.length;
		if (incoming.length > 0) {
			previousBatch.totalReturned += incoming.length;
			previousBatch.lastProcessedIncomingAt = Math.max.apply(null, incoming.map(function (item) { return item.timestamp; }));
			console.log(('[RECIPROCAL] ' + incoming.length + ' new return comment(s) found from ' + resolved.ownerName + '. Lifetime returned total is now ' + previousBatch.totalReturned + '.').green);
		} else {
			console.log('[RECIPROCAL] No new return comments from %s since last check (total returned: %s).'.gray, resolved.ownerName, previousBatch.totalReturned);
		}
		previousBatch.availableReciprocal = Math.max(0, previousBatch.totalReturned - previousBatch.accountedReturned);
		previousBatch.commentsSent = previousBatch.totalSent;
		previousBatch.commentsReceived = previousBatch.totalReturned;
		previousBatch.lastCheckedAt = Date.now();
		previousBatch.lastCheckedAtReadable = readableTimestamp(previousBatch.lastCheckedAt);
		if (resolved.targetURL && resolved.type === 'ARTWORK') {
			if (!previousBatch.artworkURLs) previousBatch.artworkURLs = [];
			if (!previousBatch.artworkURLs.includes(resolved.targetURL)) previousBatch.artworkURLs.push(resolved.targetURL);
		}
		saveReciprocalTracking();

		if (previousBatch && Number(previousBatch.lastOutgoingBatchAt) > 0) {
			console.log('[RECIPROCAL] New returned: %s | Sent: %s | Returned: %s | Available: %s'.gray, returnedCount, previousBatch.totalSent, previousBatch.totalReturned, previousBatch.availableReciprocal);
			var rawCredit = previousBatch.availableReciprocal || targetLimit;
			amountToSend = Math.min(rawCredit, Math.min(targetLimit, maxCommentsPerBatch));
			if (returnedCount < 1) {
				try { config = JSON.parse(fs.readFileSync(path.resolve('config.json'), 'utf-8')); } catch (err) {}
				var enableGreedy = config.enableGreedySkip !== false;
				var greedySkipChance = config.greedySkipChance != null ? Number(config.greedySkipChance) : 0.5;
				var returnRatio = previousBatch.totalSent > 0 ? (previousBatch.totalReturned / previousBatch.totalSent) : 1;
				var isGreedy = enableGreedy && ((previousBatch.totalSent >= targetLimit && previousBatch.totalReturned === 0) || (previousBatch.totalSent >= 12 && returnRatio < 0.20));
				if (isGreedy) {
					if (Math.random() < greedySkipChance) {
						console.log('[RECIPROCAL] Randomly skipped low-reciprocating target %s for this cycle (Sent: %s, Received: %s, Ratio: %s%). Priority given to active returners.'.yellow, name, previousBatch.totalSent, previousBatch.totalReturned, Math.round(returnRatio * 100));
						activity('reciprocal_greedy_random_skip', { friend: resolved.ownerName, target: name, steamID: trackingKey, sent: previousBatch.totalSent, received: previousBatch.totalReturned });
						markCycleTarget(resolved.targetURL || friend.source, 'skipped');
						currentFriendName = null;
						currentFriendNumber = null;
						return;
					}
				}
				var latestComment = await getLastCommentFrom(resolved.ownerSteamID);
				var latestCommentText = latestComment.found && latestComment.date
					? formatActualDate(latestComment.date) + ' (' + formatElapsed(latestComment.date) + ')'
					: 'No visible comment found';
				if (latestComment.found && !latestComment.date && latestComment.visibleDateText) latestCommentText = latestComment.visibleDateText;
				console.log('[RECIPROCAL] Last comment from %s: %s'.gray, resolved.ownerName, latestCommentText);
				console.log('[RECIPROCAL] Comments I sent: %s | Comments I received: %s | Batch ratio: %s:%s'.gray, targetLimit, returnedCount, returnedCount, targetLimit);
				var decision = await askReciprocalDecision();
				if (decision === 'SKIP') {
					console.log('[RECIPROCAL] SKIPPED — No return comments since last batch'.yellow);
					activity('reciprocal_skipped', { friend: resolved.ownerName, target: name, steamID: trackingKey, sent: targetLimit, received: returnedCount });
					markCycleTarget(resolved.targetURL || friend.source, 'skipped');
					currentFriendName = null;
					currentFriendNumber = null;
					return;
				}
				console.log('[RECIPROCAL] CONTINUING by user choice — sending %s comments.'.yellow, amountToSend);
			}
			console.log('[RECIPROCAL] Eligible — sending %s comments'.green, amountToSend);
		} else {
			console.log('[RECIPROCAL] First batch for owner %s — first batch allowed (lifetime returned: %s).'.gray, resolved.ownerName, previousBatch.totalReturned);
		}
	}
	catch (err) {
		console.log('[RECIPROCAL] SKIPPED — Could not reliably check return comments: %s'.yellow, err.message || err);
		markCycleTarget(resolved.targetURL || friend.source, 'skipped');
		currentFriendName = null;
		currentFriendNumber = null;
		return;
	}
	try {
		var lastComment = await getLastCommentFrom(resolved.ownerSteamID);
		var commentDate = lastComment.found && lastComment.date
			? formatActualDate(lastComment.date) + ' (' + formatElapsed(lastComment.date) + ')'
			: 'No comment found';
		if (lastComment.found && !commentDate) commentDate = lastComment.visibleDateText || 'date unavailable';
		console.log('[TARGET %s] Last comment from %s: %s'.gray, friendNumber, resolved.ownerName, commentDate);
	}
	catch (err) { console.log((friendLogPrefix(friendNumber) + ' Could not check comments from %s: %s').yellow, resolved.ownerName, err.message || err); }
	if (skipCurrentFriend) {
		console.log((friendLogPrefix(friendNumber) + ' Skipped %s by user.').yellow, name);
		currentFriendName = null;
		currentFriendNumber = null;
		return;
	}

	var completedBatch = !dryRun;
	var commentForThisProfile = selectCommentForProfile();
	for (var commentNumber = 1; commentNumber <= amountToSend; commentNumber++) {
		refreshDailyCount();
		if (dailyCommentCap && todayCommentCount >= dailyCommentCap) {
			console.log('[LIMIT] Daily comment cap (%s) reached. Waiting for the next cycle.'.yellow, dailyCommentCap);
			activity('daily_cap_reached', { cap: dailyCommentCap });
			currentFriendName = null; currentFriendNumber = null; return;
		}
		if (skipCurrentFriend) {
			console.log((friendLogPrefix(friendNumber) + ' Skipped %s by user.').yellow, name);
			currentFriendName = null;
			currentFriendNumber = null;
			return;
		}
		var comment = commentForThisProfile;
		console.log((friendLogPrefix(friendNumber) + ' Posting comment %s/%s to %s. Preview: %s').gray, commentNumber, amountToSend, name, comment.replace(/[\r\n]+/g, ' '));
		if (dryRun) {
			console.log((friendLogPrefix(friendNumber) + ' DRYRUN — would post to %s (%s): %s').yellow, name, resolved.type, comment);
			continue;
		}
		try {
			await postComment(resolved, comment);
			todayCommentCount++;
			activity('comment_posted', { target: name, type: resolved.type, ownerSteamID: trackingKey, commentNumber: commentNumber });
			console.log('[%s] Successfully commented on %s. Comment: %s'.green, user.steamID, name, comment);
		}
		catch (err) {
			if (skipCurrentFriend) {
				console.log((friendLogPrefix(friendNumber) + ' Skipped %s by user.').yellow, name);
				currentFriendName = null;
				currentFriendNumber = null;
				return;
			}
			if (err.outcomeUnknown) {
				completedBatch = false;
				console.log((friendLogPrefix(friendNumber) + ' Stopped %s after an unverified 403 to prevent duplicate comments.').yellow, name);
				activity('comment_outcome_unknown', { target: name, type: resolved.type, ownerSteamID: trackingKey, commentNumber: commentNumber, error: err.message || String(err) });
				markCycleTarget(resolved.targetURL || friend.source, 'skipped');
				currentFriendName = null;
				currentFriendNumber = null;
				return;
			}
			completedBatch = false;
			console.log((friendLogPrefix(friendNumber) + ' Error posting comment %s/%s to %s: %s').red, commentNumber, amountToSend, name, err.message || err);
		}
		if (commentNumber < amountToSend) {
			console.log((friendLogPrefix(friendNumber) + ' Waiting %ss delay for %s before comment %s/%s.').gray, Math.round(betweenComments / 1000), name, commentNumber + 1, amountToSend);
		}
		// A delay is only needed before another comment. Keeping this optional
		// preserves the old behaviour when a cooldown after each target is wanted.
		if (commentNumber < amountToSend || waitAfterFinalComment) {
			await waitForDelayOrSkip(jitterDelay(betweenComments));
		}
	}
	console.log((friendLogPrefix(friendNumber) + ' Finished %s (%s) [%s]').green, name, resolved.source || resolved.ownerSteamID, resolved.type);
	if (completedBatch) {
		previousBatch.totalSent += amountToSend;
		previousBatch.accountedReturned += Math.min(amountToSend, previousBatch.availableReciprocal);
		previousBatch.availableReciprocal = Math.max(0, previousBatch.totalReturned - previousBatch.accountedReturned);
		previousBatch.profileURL = previousBatch.profileURL || ('https://steamcommunity.com/profiles/' + trackingKey);
		previousBatch.profileName = resolved.ownerName || previousBatch.profileName || name;
		previousBatch.lastOutgoingBatchAt = Date.now();
		previousBatch.lastOutgoingBatchAtReadable = readableTimestamp(previousBatch.lastOutgoingBatchAt);
		previousBatch.waitingSince = previousBatch.lastOutgoingBatchAt;
		previousBatch.commentsSent = previousBatch.totalSent;
		previousBatch.commentsReceived = previousBatch.totalReturned;
		reciprocalTracking[trackingKey] = previousBatch;
		saveReciprocalTracking();
		markCycleTarget(resolved.targetURL || friend.source, 'finished');
		console.log('[RECIPROCAL] Saved completed outgoing batch for owner %s.'.gray, resolved.ownerName);
	} else {
		markCycleTarget(resolved.targetURL || friend.source, 'failed');
	}
	currentFriendName = null;
	currentFriendNumber = null;
}

async function runCycle() {
	await checkCyclePause();
	loadFriends();
	processedFriendSteamIDs = new Set();
	cycleAttemptedSources = new Set();
	currentCycleState = { cycle: cycle, finished: [], skipped: [], failed: [] };
	saveCycleState();
	console.log(t('cycleLoaded').cyan, cycle, friends.length);
	var targetNumber = 0;
	while (true) {
		await checkCyclePause();
		// Reload on every target boundary. Dashboard edits therefore join this
		// cycle without a process restart, while attempted sources stay skipped.
		loadFriends();
		var nextFriend = friends.find(function (friend) { return !cycleAttemptedSources.has(friend.source); });
		if (!nextFriend) break;
		cycleAttemptedSources.add(nextFriend.source);
		targetNumber++;
		await processFriend(nextFriend, targetNumber);
		if (betweenFriends) {
			loadFriends();
			var moreTargets = friends.some(function (friend) { return !cycleAttemptedSources.has(friend.source); });
			if (moreTargets) await waitForDelayOrSkip(jitterDelay(betweenFriends));
		}
	}
	console.log(t('cycleFinished').green, cycle, Math.round(restartDelay / 1000));
	cycle++;
	await waitForDelayOrSkip(restartDelay);
	runCycle().catch(scheduleCycleAfterError);
}

function scheduleCycleAfterError(err) {
	console.log('Cycle failed: %s'.red, err.message || err);
	setTimeout(function () { runCycle().catch(scheduleCycleAfterError); }, restartDelay);
}


console.log(t('startup').gray);
if (proxyUrl) console.log('[PROXY] Using configured HTTP proxy: %s'.gray, proxyUrl);
configureStartup(function () {
	if (dashboardMode) return beginLogin(dashboardStartup.username, dashboardStartup.password, dashboardStartup.guard);
	ask(t('username'), function (accountName) {
		ask(t('password'), function (password) {
			ask(t('guard'), function (guard) {
				if (guard.toUpperCase() == 'SKIP') { console.log('Main account login skipped. Exiting.'.yellow); process.exit(0); }
				beginLogin(accountName, password, guard);
			});
		});
	});
});

user.on('error', function (err) {
	console.log(t('loginFailed').red, err.message || err);
	console.log('Check the username, password, Steam Guard code, and whether Steam is asking for mobile confirmation.'.yellow);
});

user.on('steamGuard', function (domain, callback, lastCodeWrong) {
	var label = domain ? ('Steam Guard Email Code for main account at ' + domain) : 'Steam Guard Code for main account';
	if (lastCodeWrong) console.log('Last main account Steam Guard code was wrong.'.yellow);
	ask(label + ' (or SKIP): ', function (code) {
		if (code.toUpperCase() == 'SKIP') { console.log('Main account skipped. Exiting.'.yellow); process.exit(0); }
		callback(code);
	});
});

user.on('friendsList', function () {
	friendsListReady = true;
});

user.on('loggedOn', async function () {
	try {
		loadComments();
		loadReciprocalTracking();
		console.log(t('loginSuccess').cyan, user.steamID);
		await wait(2000);
		await getMainWebSession();
		await waitForFriendsList();
		startCommandListener();
		if (runImportHistoryOnStartup) await importReciprocalHistory();
		if (runDiscoveryOnStartup) await runDiscovery();
		if (startupDelay > 0) {
			console.log('Commenting will start in %s minute(s).'.cyan, Math.round(startupDelay / 60000));
			await wait(startupDelay);
		}
		runCycle().catch(scheduleCycleAfterError);
	}
	catch (err) { console.log(t('startupFailed').red, err.message || err); }
});
