// Reading Companion - MV3 service worker
// Responsibilities (V1):
// - Persist scroll progress per page
// - Manage materials (index + chapters)
// - Assisted chapter detection via notifications
// - Store bookmarks/highlights/quotes linked to materials

const STORAGE_KEYS = {
	materials: "materials",
	pages: "pages",
	collections: "collections",
};

function nowUnixSeconds() {
	return Math.floor(Date.now() / 1000);
}

function normalizeUrl(input) {
	try {
	const u = new URL(input);
	// Ignore fragments for progress/bookmarks stability.
	u.hash = "";
	return u.toString();
	} catch {
	return null;
	}
}

async function getAllData() {
	const data = await chrome.storage.local.get([
	STORAGE_KEYS.materials,
	STORAGE_KEYS.pages,
	STORAGE_KEYS.collections,
	]);

	return {
	materials: data[STORAGE_KEYS.materials] || {},
	pages: data[STORAGE_KEYS.pages] || {},
	collections: data[STORAGE_KEYS.collections] || {},
	};
}

async function setAllData(next) {
	await chrome.storage.local.set({
		[STORAGE_KEYS.materials]: next.materials || {},
		[STORAGE_KEYS.pages]: next.pages || {},
		[STORAGE_KEYS.collections]: next.collections || {},
	});
}

function migrateBookmarkIds(data) {
	// Ensure all bookmarks have stable ids so popup delete works reliably.
	let changed = false;

	for (const materialId of Object.keys(data.materials || {})) {
	const m = data.materials[materialId];
	if (!m) continue;
	const bookmarks = Array.isArray(m.bookmarks) ? m.bookmarks : [];
	let materialChanged = false;

	const nextBookmarks = bookmarks.map((b) => {
		if (b && typeof b === "object" && typeof b.id === "string" && b.id) return b;
		materialChanged = true;
		return { ...b, id: makeId("bm") };
	});

	if (materialChanged) {
		data.materials[materialId] = { ...m, bookmarks: nextBookmarks };
		changed = true;
	}
	}

	return changed;
}

function makeId(prefix = "id") {
	return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function getMaterialUrlScopePrefix(indexUrl) {
	// Basic heuristic: treat all URLs under the index URL directory as "under material".
	// Example:
	//  index: https://site.com/handbook
	//  scope: https://site.com/handbook (prefix match)
	// If index ends with /, keep it; otherwise keep as-is.
	try {
	const u = new URL(indexUrl);
	u.hash = "";
	const normalized = u.toString();
	return normalized;
	} catch {
	return null;
	}
}

function isUrlUnderPrefix(url, prefix) {
	if (!url || !prefix) return false;
	return url.startsWith(prefix);
}

function findMatchingMaterial(materials, url) {
	// Returns the first material whose scope prefix matches the url.
	// Simple and deterministic: prefer the longest matching prefix.
	const candidates = Object.entries(materials)
	.map(([materialId, m]) => ({
		materialId,
		prefix: getMaterialUrlScopePrefix(m.indexUrl),
	}))
	.filter((x) => x.prefix && isUrlUnderPrefix(url, x.prefix))
	.sort((a, b) => b.prefix.length - a.prefix.length);

	return candidates[0]?.materialId || null;
}

function chapterExists(material, url) {
	return (material.chapters || []).some((c) => c.url === url);
}

function nextChapterOrder(material) {
	const orders = (material.chapters || []).map((c) => Number(c.order) || 0);
	return (orders.length ? Math.max(...orders) : 0) + 1;
}

function normalizeChapters(chapters) {
	const sorted = [...(chapters || [])].sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
	return sorted.map((c, idx) => ({ ...c, order: idx + 1 }));
}

function updateMaterialChapterProgressFromPages(material, pages) {
	if (!material?.chapters?.length) return material;

	const updatedChapters = material.chapters.map((c) => {
	const p = pages[c.url];
	const progress = typeof p?.progress === "number" ? p.progress : c.progress;
	return { ...c, progress: clampProgress(progress) };
	});

	return { ...material, chapters: updatedChapters };
}

function clampProgress(p) {
	if (typeof p !== "number" || Number.isNaN(p)) return 0;
	return Math.max(0, Math.min(100, Math.round(p)));
}

// --- Assisted chapter detection via notifications ---

// notificationId -> { materialId, url }
const pendingChapterPrompts = new Map();

async function maybePromptAddChapter(tab) {
	const url = normalizeUrl(tab?.url);
	if (!url) return;

	const data = await getAllData();
	const materialId = findMatchingMaterial(data.materials, url);
	if (!materialId) return;

	const material = data.materials[materialId];
	if (!material) return;

	// Don't prompt for the index page itself.
	const indexUrl = normalizeUrl(material.indexUrl);
	if (indexUrl && url === indexUrl) return;

	// Already a chapter? No prompt.
	if (chapterExists(material, url)) return;

	// Only prompt once per SW lifetime per URL+material.
	const alreadyPending = [...pendingChapterPrompts.values()].some(
	(p) => p.materialId === materialId && p.url === url
	);
	if (alreadyPending) return;

	const notificationId = makeId("chapter_prompt");
	pendingChapterPrompts.set(notificationId, { materialId, url });

	// Notifications are used as a lightweight "prompt" in MV3.
	chrome.notifications.create(notificationId, {
	type: "basic",
	iconUrl: "icons/icon128.png",
	title: "Reading Companion",
	message: `Add this page as the next chapter for “${material.title || "Untitled"}”?`,
	buttons: [{ title: "Add as chapter" }, { title: "Ignore" }],
	priority: 1,
	});
}

chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
	const pending = pendingChapterPrompts.get(notificationId);
	if (!pending) return;

	try {
	if (buttonIndex === 0) {
		const data = await getAllData();
		const material = data.materials[pending.materialId];
		if (material && !chapterExists(material, pending.url)) {
		const order = nextChapterOrder(material);
		const pageProgress = data.pages[pending.url]?.progress;
			const pageTitle = typeof data.pages[pending.url]?.title === "string" ? data.pages[pending.url].title : "";

		const nextMaterial = {
			...material,
			chapters: [
			...(material.chapters || []),
					{ url: pending.url, order, progress: clampProgress(pageProgress ?? 0), ...(pageTitle ? { title: pageTitle } : {}) },
			],
		};

		data.materials[pending.materialId] = nextMaterial;
		await setAllData(data);
		}
	}
	} finally {
	pendingChapterPrompts.delete(notificationId);
	chrome.notifications.clear(notificationId);
	}
});

chrome.notifications.onClosed.addListener((notificationId) => {
	pendingChapterPrompts.delete(notificationId);
});

// Watch for navigation changes to trigger assisted detection.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	if (changeInfo.status === "complete" && tab?.active) {
	maybePromptAddChapter(tab);
	}
	if (changeInfo.url && tab?.active) {
	maybePromptAddChapter({ ...tab, url: changeInfo.url });
	}
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
	const tab = await chrome.tabs.get(tabId);
	maybePromptAddChapter(tab);
});

// --- Messaging API for content/popup ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	(async () => {
	const type = message?.type;

	if (type === "pageProgress") {
		const url = normalizeUrl(message.url);
		if (!url) return sendResponse({ ok: false, error: "invalid_url" });

		const progress = clampProgress(message.progress);
		const title = typeof message.title === "string" ? message.title : "";

		const data = await getAllData();
		const existing = data.pages[url] || {};
		const ignoreScrollProgress = existing.ignoreScrollProgress === true;

		data.pages[url] = {
		...existing,
		// If the user chose to ignore scroll progress, keep the stored percentage
		// unchanged (but still track title/updatedAt).
		...(ignoreScrollProgress ? {} : { progress }),
		title: title || existing.title || "",
		updatedAt: nowUnixSeconds(),
		};

		// If this URL is a chapter, keep the chapter's progress in sync.
		for (const materialId of Object.keys(data.materials)) {
		const m = data.materials[materialId];
		if (!m?.chapters?.length) continue;
		if (m.chapters.some((c) => c.url === url)) {
			data.materials[materialId] = updateMaterialChapterProgressFromPages(m, data.pages);
		}
		}

		await setAllData(data);
		return sendResponse({ ok: true });
	}

	if (type === "getData") {
		const data = await getAllData();
		const changed = migrateBookmarkIds(data);
		if (changed) await setAllData(data);
		return sendResponse({ ok: true, data });
	}

	if (type === "setPageStatus") {
		const url = normalizeUrl(message.url);
		const status = message.status;
		if (!url) return sendResponse({ ok: false, error: "invalid_url" });
		if (!["to_read", "reading", "finished"].includes(status)) {
		return sendResponse({ ok: false, error: "invalid_status" });
		}

		const data = await getAllData();
		const existing = data.pages[url] || {};
		data.pages[url] = {
		...existing,
		status,
		updatedAt: nowUnixSeconds(),
		};
		await setAllData(data);
		return sendResponse({ ok: true });
	}

	if (type === "setIgnoreScrollProgress") {
		const url = normalizeUrl(message.url);
		const ignoreScrollProgress = message.ignoreScrollProgress === true;
		if (!url) return sendResponse({ ok: false, error: "invalid_url" });

		const data = await getAllData();
		const existing = data.pages[url] || {};
		data.pages[url] = {
		...existing,
		ignoreScrollProgress,
		updatedAt: nowUnixSeconds(),
		};
		await setAllData(data);
		return sendResponse({ ok: true });
	}

	if (type === "setPageFinished") {
		const url = normalizeUrl(message.url);
		const finished = message.finished === true;
		if (!url) return sendResponse({ ok: false, error: "invalid_url" });

		const data = await getAllData();
		const existing = data.pages[url] || {};

		if (finished) {
			data.pages[url] = {
				...existing,
				status: "finished",
				progress: 100,
				ignoreScrollProgress: true,
				updatedAt: nowUnixSeconds(),
			};
		} else {
			// Unmark finished: allow scroll to update progress again.
			const next = { ...existing };
			delete next.status;
			next.ignoreScrollProgress = false;
			next.updatedAt = nowUnixSeconds();
			data.pages[url] = next;
		}

		await setAllData(data);
		return sendResponse({ ok: true });
	}

	if (type === "createMaterial") {
		const indexUrl = normalizeUrl(message.indexUrl);
		const title = typeof message.title === "string" ? message.title.trim() : "";
		const kind = message.kind;
		if (!indexUrl) return sendResponse({ ok: false, error: "invalid_index_url" });
		if (kind && !["multi", "single"].includes(kind)) {
		return sendResponse({ ok: false, error: "invalid_kind" });
		}

		const data = await getAllData();
		const materialId = makeId("material");

		data.materials[materialId] = {
		title: title || "Untitled material",
		indexUrl,
		kind: kind || "multi",
		chapters: [],
		bookmarks: [],
		};

		await setAllData(data);
		return sendResponse({ ok: true, materialId });
	}

	if (type === "deleteMaterial") {
		const materialId = message.materialId;
		if (!materialId) return sendResponse({ ok: false, error: "invalid_args" });

		const data = await getAllData();
		if (!data.materials[materialId]) return sendResponse({ ok: false, error: "material_not_found" });

		delete data.materials[materialId];

		// Leave pages as-is (they may be referenced elsewhere / standalone pages).
		await setAllData(data);
		return sendResponse({ ok: true });
	}

	if (type === "resetAllData") {
		// Fully clears chrome.storage.local for this extension.
		await chrome.storage.local.clear();
		return sendResponse({ ok: true });
	}

	if (type === "addChapter") {
		const materialId = message.materialId;
		const url = normalizeUrl(message.url);
		if (!materialId || !url) return sendResponse({ ok: false, error: "invalid_args" });

		const data = await getAllData();
		const material = data.materials[materialId];
		if (!material) return sendResponse({ ok: false, error: "material_not_found" });

		if (chapterExists(material, url)) return sendResponse({ ok: true, already: true });

		const order = nextChapterOrder(material);
		const pageProgress = data.pages[url]?.progress;
		const pageTitle = typeof data.pages[url]?.title === "string" ? data.pages[url].title : "";
		data.materials[materialId] = {
		...material,
		chapters: [
			...(material.chapters || []),
			{ url, order, progress: clampProgress(pageProgress ?? 0), ...(pageTitle ? { title: pageTitle } : {}) },
		],
		};

		await setAllData(data);
		return sendResponse({ ok: true });
	}

	if (type === "deleteChapter") {
		const materialId = message.materialId;
		const url = normalizeUrl(message.url);
		if (!materialId || !url) return sendResponse({ ok: false, error: "invalid_args" });

		const data = await getAllData();
		const material = data.materials[materialId];
		if (!material) return sendResponse({ ok: false, error: "material_not_found" });

		const existing = Array.isArray(material.chapters) ? material.chapters : [];
		const filtered = existing.filter((c) => c?.url !== url);
		if (filtered.length === existing.length) return sendResponse({ ok: false, error: "chapter_not_found" });

		// Also delete any quotes that were saved on this chapter URL.
		const existingBookmarks = Array.isArray(material.bookmarks) ? material.bookmarks : [];
		let removedQuotesCount = 0;
		const nextBookmarks = existingBookmarks.filter((b) => {
			const bUrl = normalizeUrl(b?.url);
			const remove = bUrl === url;
			if (remove) removedQuotesCount += 1;
			return !remove;
		});

		data.materials[materialId] = { ...material, chapters: normalizeChapters(filtered), bookmarks: nextBookmarks };
		await setAllData(data);
		return sendResponse({ ok: true, removedQuotesCount });
	}

	if (type === "renameChapter") {
		const materialId = message.materialId;
		const url = normalizeUrl(message.url);
		const title = typeof message.title === "string" ? message.title.trim() : "";
		if (!materialId || !url) return sendResponse({ ok: false, error: "invalid_args" });

		const data = await getAllData();
		const material = data.materials[materialId];
		if (!material) return sendResponse({ ok: false, error: "material_not_found" });

		const existing = Array.isArray(material.chapters) ? material.chapters : [];
		let found = false;
		const next = existing.map((c) => {
			if (c?.url !== url) return c;
			found = true;
			const base = { ...c };
			if (title) {
				base.title = title;
			} else {
				delete base.title;
			}
			return base;
		});
		if (!found) return sendResponse({ ok: false, error: "chapter_not_found" });

		data.materials[materialId] = { ...material, chapters: normalizeChapters(next) };
		await setAllData(data);
		return sendResponse({ ok: true });
	}

	if (type === "moveChapter") {
		const materialId = message.materialId;
		const url = normalizeUrl(message.url);
		const direction = message.direction;
		if (!materialId || !url) return sendResponse({ ok: false, error: "invalid_args" });
		if (!['up', 'down'].includes(direction)) return sendResponse({ ok: false, error: "invalid_direction" });

		const data = await getAllData();
		const material = data.materials[materialId];
		if (!material) return sendResponse({ ok: false, error: "material_not_found" });

		const sorted = normalizeChapters(material.chapters || []);
		const idx = sorted.findIndex((c) => c?.url === url);
		if (idx < 0) return sendResponse({ ok: false, error: "chapter_not_found" });

		const swapWith = direction === 'up' ? idx - 1 : idx + 1;
		if (swapWith < 0 || swapWith >= sorted.length) return sendResponse({ ok: true });

		const next = [...sorted];
		const tmp = next[idx];
		next[idx] = next[swapWith];
		next[swapWith] = tmp;

		data.materials[materialId] = { ...material, chapters: normalizeChapters(next) };
		await setAllData(data);
		return sendResponse({ ok: true });
	}

	if (type === "addBookmark") {
		const materialId = message.materialId;
		const url = normalizeUrl(message.url);
		const text = typeof message.text === "string" ? message.text.trim() : "";
		const bookmarkType = message.bookmarkType; // "highlight" | "quote"

		if (!materialId || !url || !text) return sendResponse({ ok: false, error: "invalid_args" });
		if (bookmarkType && !["highlight", "quote"].includes(bookmarkType)) {
		return sendResponse({ ok: false, error: "invalid_bookmark_type" });
		}

		const data = await getAllData();
		migrateBookmarkIds(data);
		const material = data.materials[materialId];
		if (!material) return sendResponse({ ok: false, error: "material_not_found" });

		const entry = {
		id: makeId("bm"),
		text,
		url,
		timestamp: nowUnixSeconds(),
		...(bookmarkType ? { type: bookmarkType } : {}),
		};

		data.materials[materialId] = {
		...material,
		bookmarks: [entry, ...(material.bookmarks || [])],
		};

		await setAllData(data);
		return sendResponse({ ok: true });
	}

	if (type === "deleteBookmark") {
		const materialId = message.materialId;
		const bookmarkId = typeof message.bookmarkId === "string" ? message.bookmarkId : "";
		const url = normalizeUrl(message.url);
		const timestamp = typeof message.timestamp === "number" ? message.timestamp : null;
		const text = typeof message.text === "string" ? message.text.trim() : "";

		if (!materialId) return sendResponse({ ok: false, error: "invalid_args" });

		const data = await getAllData();
		const changed = migrateBookmarkIds(data);
		if (changed) await setAllData(data);
		const material = data.materials[materialId];
		if (!material) return sendResponse({ ok: false, error: "material_not_found" });

		const existing = Array.isArray(material.bookmarks) ? material.bookmarks : [];
		let nextBookmarks = existing;
		let removedCount = 0;

		if (bookmarkId) {
			nextBookmarks = existing.filter((b) => {
				const keep = b?.id !== bookmarkId;
				if (!keep) removedCount += 1;
				return keep;
			});
		} else {
		// Back-compat deletion for older entries without ids: match by url+timestamp+text.
			nextBookmarks = existing.filter((b) => {
			const bUrl = normalizeUrl(b?.url);
			const sameUrl = url ? bUrl === url : true;
			const sameTimestamp = timestamp != null ? b?.timestamp === timestamp : true;
			const sameText = text ? (String(b?.text || "").trim() === text) : true;
				const shouldRemove = sameUrl && sameTimestamp && sameText;
				if (shouldRemove) removedCount += 1;
				return !shouldRemove;
		});
		}

		data.materials[materialId] = {
		...material,
		bookmarks: nextBookmarks,
		};

		await setAllData(data);
		return sendResponse({ ok: true, removedCount });
	}

	if (type === "addMaterialToCollection") {
		const materialId = message.materialId;
		const collectionName = typeof message.collectionName === "string" ? message.collectionName.trim() : "";
		if (!materialId || !collectionName) return sendResponse({ ok: false, error: "invalid_args" });

		const data = await getAllData();
		if (!data.materials[materialId]) return sendResponse({ ok: false, error: "material_not_found" });

		const existing = Array.isArray(data.collections[collectionName]) ? data.collections[collectionName] : [];
		const next = existing.includes(materialId) ? existing : [materialId, ...existing];
		data.collections[collectionName] = next;

		await setAllData(data);
		return sendResponse({ ok: true });
	}

	if (type === "removeMaterialFromCollection") {
		const materialId = message.materialId;
		const collectionName = typeof message.collectionName === "string" ? message.collectionName.trim() : "";
		if (!materialId || !collectionName) return sendResponse({ ok: false, error: "invalid_args" });

		const data = await getAllData();
		const existing = Array.isArray(data.collections[collectionName]) ? data.collections[collectionName] : [];
		data.collections[collectionName] = existing.filter((id) => id !== materialId);

		await setAllData(data);
		return sendResponse({ ok: true });
	}

	return sendResponse({ ok: false, error: "unknown_message" });
	})().catch((err) => {
	console.error("background message handler error", err);
	sendResponse({ ok: false, error: "exception" });
	});

	// Keep the message channel open for async responses.
	return true;
});
