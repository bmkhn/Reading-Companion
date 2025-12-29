// Reading Companion - popup script
// Responsibilities (V1):
// - Show current page progress + status
// - Create/select materials and manually add chapters
// - Capture selected text and store as highlight/quote linked to a material
// - Assign materials to single-level collections

// Page status was simplified to "Mark finished" only.

// The popup rerenders frequently; keep the user's selected material in memory
// so selecting an existing material works even when the current URL isn't
// already part of that material.
let lastSelectedMaterialId = "";
let lastSelectedChapterUrl = "";
const lastSelectedChapterByMaterial = Object.create(null);
let chaptersPage = 1;
const CHAPTERS_PER_PAGE = 5;

let pendingDeclareIndexUrl = "";

function normalizeUrl(input) {
	try {
		const u = new URL(input);
		u.hash = "";
		return u.toString();
	} catch {
		return null;
	}
}

function clampProgress(p) {
	if (typeof p !== "number" || Number.isNaN(p)) return 0;
	return Math.max(0, Math.min(100, Math.round(p)));
}

function formatTimestamp(unixSeconds) {
	if (!unixSeconds) return "";
	try {
		return new Date(unixSeconds * 1000).toLocaleString();
	} catch {
		return "";
	}
}

async function getActiveTab() {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	return tab;
}

async function bg(message) {
	try {
		return await chrome.runtime.sendMessage(message);
	} catch (err) {
		console.error("popup sendMessage failed", err);
		return { ok: false, error: "send_failed" };
	}
}

async function getSelectionFromTab(tabId) {
	try {
		const response = await chrome.tabs.sendMessage(tabId, { type: "getSelection" });
		if (!response?.ok) return "";
		return (response.text || "").trim();
	} catch {
		// If the content script wasn't injected (rare) or tab doesn't allow it.
		return "";
	}
}

function el(id) {
	return document.getElementById(id);
}

function setStatusLine(text) {
	el("statusLine").textContent = text || "";
}

function setDeclareMode(enabled) {
	document.body.classList.toggle("declare-mode", Boolean(enabled));
}

function safeOn(id, eventName, handler) {
	const node = el(id);
	if (!node) return;
	node.addEventListener(eventName, handler);
}

function setRequiresMaterialVisible(hasMaterial) {
	const gated = document.querySelectorAll(".requires-material");
	for (const node of gated) {
		node.classList.toggle("hidden", !hasMaterial);
	}
}

function setRequiresChapterVisible(hasChapter) {
	const gated = document.querySelectorAll(".requires-chapter");
	for (const node of gated) {
		node.classList.toggle("hidden", !hasChapter);
	}
}

function setMultiPageVisible(isMulti) {
	const multi = el("multiPageSection");
	const singleNote = el("singlePageNote");

	if (!multi || !singleNote) return;

	multi.classList.toggle("hidden", !isMulti);
	singleNote.classList.toggle("hidden", isMulti);
}

function getMaterialKind(material) {
	const kind = material?.kind;
	return kind === "single" ? "single" : "multi";
}

function materialById(materials, materialId) {
	return materials?.[materialId] || null;
}

function findMaterialForUrl(materials, url) {
	// If URL matches a chapter or is indexUrl.
	const entries = Object.entries(materials || {});
	for (const [id, m] of entries) {
		const indexUrl = normalizeUrl(m.indexUrl);
		if (indexUrl && indexUrl === url) return id;
		const chapters = Array.isArray(m.chapters) ? m.chapters : [];
		if (chapters.some((c) => c.url === url)) return id;
	}
	return null;
}

function sortChapters(chapters) {
	return [...(chapters || [])].sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
}

function chapterTitle(chapter, pages) {
	const explicit = typeof chapter?.title === "string" ? chapter.title.trim() : "";
	if (explicit) return explicit;
	const p = pages?.[chapter?.url];
	const fromPage = typeof p?.title === "string" ? p.title.trim() : "";
	return fromPage;
}

function chapterByUrl(chapters, url) {
	return (chapters || []).find((c) => c?.url === url) || null;
}

function commonPrefixLength(a, b) {
	const max = Math.min(a.length, b.length);
	let i = 0;
	for (; i < max; i++) {
		if (a[i] !== b[i]) break;
	}
	return i;
}

function pickBestMaterialId(materials, currentUrl) {
	if (!currentUrl) return "";
	let bestId = "";
	let bestScore = -1;

	let current;
	try {
		current = new URL(currentUrl);
	} catch {
		return "";
	}

	for (const [id, m] of Object.entries(materials || {})) {
		let score = 0;
		const indexUrl = normalizeUrl(m?.indexUrl);
		if (!indexUrl) continue;

		if (indexUrl === currentUrl) {
			score = 10000;
		} else if (Array.isArray(m?.chapters) && m.chapters.some((c) => c?.url === currentUrl)) {
			score = 9000;
		} else if (currentUrl.startsWith(indexUrl)) {
			score = 8000 + indexUrl.length;
		} else {
			try {
				const idx = new URL(indexUrl);
				if (idx.host === current.host) {
					score = 7000 + commonPrefixLength(idx.pathname, current.pathname);
				}
			} catch {
				// ignore
			}
		}

		if (score > bestScore) {
			bestScore = score;
			bestId = id;
		}
	}

	return bestId;
}

// Collections removed in this iteration.

async function refreshUI() {
	const tab = await getActiveTab();
	const url = normalizeUrl(tab?.url);

	el("currentUrl").textContent = url || "(unsupported page)";

	const { ok, data } = await bg({ type: "getData" });
	if (!ok) {
		setStatusLine("Failed to load data.");
		return;
	}

	const pages = data.pages || {};
	const materials = data.materials || {};
	// Collections removed in this iteration.

	// Page progress section now follows the selected chapter (default: latest chapter).
	// We still show the current URL at the top, but progress/finished/ignore-scroll are for the selected chapter.
	const markBtn = el("markFinished");
	const goBtn = el("goToProgress");

	// Material selection dropdown
	const materialSelect = el("materialSelect");
	materialSelect.innerHTML = "";

	const materialIds = Object.keys(materials);
	const optNone = document.createElement("option");
	optNone.value = "";
	optNone.textContent = materialIds.length ? "(Select a material)" : "(No materials yet)";
	materialSelect.appendChild(optNone);

	for (const id of materialIds) {
		const m = materials[id];
		const option = document.createElement("option");
		option.value = id;
		option.textContent = m.title || "Untitled";
		materialSelect.appendChild(option);
	}

	const inferredMaterialId = url ? findMaterialForUrl(materials, url) : null;
	const bestMatchId = url ? pickBestMaterialId(materials, url) : "";
	const preferred = lastSelectedMaterialId && materials[lastSelectedMaterialId]
		? lastSelectedMaterialId
		: (inferredMaterialId || bestMatchId || "");
	if (preferred) materialSelect.value = preferred;
	const selectedMaterialId = materialSelect.value || "";
	lastSelectedMaterialId = selectedMaterialId;

	setRequiresMaterialVisible(Boolean(selectedMaterialId));

	// Material header
	const selectedMaterial = selectedMaterialId ? materialById(materials, selectedMaterialId) : null;
	el("materialTitle").textContent = selectedMaterial ? (selectedMaterial.title || "Untitled") : "None";

	const isMulti = Boolean(selectedMaterialId) && getMaterialKind(selectedMaterial) === "multi";
	setMultiPageVisible(isMulti);

	// Keep chapters pager in range
	if (!isMulti) {
		chaptersPage = 1;
	}

	// Chapters list (multi-page materials only)
	const chaptersEl = el("chapters");
	chaptersEl.innerHTML = "";
	const chaptersAll = isMulti ? sortChapters(selectedMaterial?.chapters || []) : [];

	// Pick the selected chapter:
	// - If user previously selected one for this material in this popup session, keep it.
	// - Else if the current active tab URL is a chapter, use it.
	// - Else default to the latest chapter.
	let selectedChapterUrl = "";
	if (isMulti && selectedMaterialId && chaptersAll.length) {
		const remembered = typeof lastSelectedChapterByMaterial[selectedMaterialId] === "string"
			? lastSelectedChapterByMaterial[selectedMaterialId]
			: "";
		const rememberedExists = remembered && chaptersAll.some((c) => c.url === remembered);
		const tabIsChapter = url && chaptersAll.some((c) => c.url === url);

		if (rememberedExists) {
			selectedChapterUrl = remembered;
		} else if (tabIsChapter) {
			selectedChapterUrl = url;
		} else {
			selectedChapterUrl = chaptersAll[chaptersAll.length - 1]?.url || "";
		}
		lastSelectedChapterByMaterial[selectedMaterialId] = selectedChapterUrl;
	}

	lastSelectedChapterUrl = selectedChapterUrl;
	setRequiresChapterVisible(Boolean(selectedChapterUrl));

	// Ensure the selected (latest) chapter is visible by default.
	if (selectedChapterUrl && isMulti) {
		const idx = chaptersAll.findIndex((c) => c.url === selectedChapterUrl);
		if (idx >= 0) {
			const preferredPage = Math.floor(idx / CHAPTERS_PER_PAGE) + 1;
			// If we're on a page that doesn't include the selected chapter, jump to it.
			const start = (chaptersPage - 1) * CHAPTERS_PER_PAGE;
			const end = start + CHAPTERS_PER_PAGE;
			if (!(idx >= start && idx < end)) {
				chaptersPage = preferredPage;
			}
		}
	}

	const selectedChapter = selectedChapterUrl ? chapterByUrl(chaptersAll, selectedChapterUrl) : null;
	const selectedPage = selectedChapterUrl ? (pages[selectedChapterUrl] || null) : null;
	const selectedProgress = selectedChapterUrl
		? clampProgress(selectedPage?.progress ?? selectedChapter?.progress ?? 0)
		: null;

	if (selectedChapterUrl) {
		el("pageProgress").textContent = String(selectedProgress ?? 0);
	} else {
		el("pageProgress").textContent = "—";
	}

	const isFinished = selectedChapterUrl && selectedPage?.status === "finished";
	if (markBtn) markBtn.textContent = isFinished ? "Unmark finished" : "Mark finished";
	if (markBtn) markBtn.disabled = !selectedChapterUrl;
	if (goBtn) goBtn.disabled = !selectedChapterUrl;

	// Ignore scroll checkbox follows selected chapter.
	const ignoreScroll = el("ignoreScroll");
	if (ignoreScroll) {
		ignoreScroll.checked = Boolean(selectedPage?.ignoreScrollProgress);
		ignoreScroll.disabled = !selectedChapterUrl;
	}
	const totalChapterPages = Math.max(1, Math.ceil(chaptersAll.length / CHAPTERS_PER_PAGE));
	chaptersPage = Math.max(1, Math.min(totalChapterPages, chaptersPage));

	const showPagination = chaptersAll.length > CHAPTERS_PER_PAGE;
	const showChapterControls = chaptersAll.length > 0;

	const chaptersPager = el("chaptersPager");
	if (chaptersPager) chaptersPager.classList.toggle("hidden", !showPagination);
	const chaptersGoRow = el("chaptersGoRow");
	if (chaptersGoRow) chaptersGoRow.classList.toggle("hidden", !showPagination);
	const chaptersPageHint = el("chaptersPageHint");
	if (chaptersPageHint) {
		chaptersPageHint.textContent = showPagination ? `Page ${chaptersPage} / ${totalChapterPages}` : "";
	}

	if (showPagination) {
		renderChapterPager(totalChapterPages, chaptersPage);
	} else {
		const container = el("chaptersPages");
		if (container) container.innerHTML = "";
	}

	const startIndex = (chaptersPage - 1) * CHAPTERS_PER_PAGE;
	const pageItems = chaptersAll.slice(startIndex, startIndex + CHAPTERS_PER_PAGE);

	if (pageItems.length) {
		for (let i = 0; i < pageItems.length; i++) {
			const c = pageItems[i];
			const li = document.createElement("li");
			const shortUrl = c.url.length > 64 ? c.url.slice(0, 64) + "…" : c.url;
			const isSelected = Boolean(selectedChapterUrl) && c.url === selectedChapterUrl;
			const title = chapterTitle(c, pages);
			const displayTitle = title ? ` — ${escapeHtml(title)}` : "";

			li.innerHTML = `
				<div class="row between" style="margin-bottom: 0;">
					<div>
						<strong>Chapter ${escapeHtml(String(Number(c.order) || "?"))}</strong>${isSelected ? ` <span class="small">(selected)</span>` : ""}
						<div class="small">${selectedChapterUrl && c.url === selectedChapterUrl ? escapeHtml(String(selectedProgress ?? clampProgress(c.progress ?? 0))) : escapeHtml(String(clampProgress(c.progress ?? 0)))}%</div>
						<a class="small link ellipsis-link">${escapeHtml(shortUrl)}</a>
					</div>
					<div class="controls" style="flex-direction: column; align-items: flex-end; gap: 6px;">
						<button class="btn small" data-action="select-chapter" data-url="${escapeHtml(c.url)}">Select</button>
						<button class="btn small" data-action="open-chapter" data-url="${escapeHtml(c.url)}">Open</button>
						<button class="btn small" data-action="delete-chapter" data-url="${escapeHtml(c.url)}">Delete</button>
					</div>
				</div>

			`;
			chaptersEl.appendChild(li);
		}
	} else {
		const li = document.createElement("li");
		li.innerHTML = `<div class="small">No chapters yet.</div>`;
		chaptersEl.appendChild(li);
	}

	// Quotes list (stored in material.bookmarks for now)
	const bookmarksEl = el("bookmarks");
	bookmarksEl.innerHTML = "";
	if (selectedMaterial?.bookmarks?.length) {
		for (const b of selectedMaterial.bookmarks.slice(0, 25)) {
			const li = document.createElement("li");
			const type = "quote";
			const when = formatTimestamp(b.timestamp);
			const excerpt = (b.text || "").length > 180 ? b.text.slice(0, 180) + "…" : (b.text || "");
			const shortUrl = (b.url || "").length > 64 ? b.url.slice(0, 64) + "…" : (b.url || "");
			const bookmarkId = typeof b.id === "string" ? b.id : "";
			const deleteAttrs = `data-action="delete-bookmark" data-bookmark-id="${escapeHtml(bookmarkId)}" data-bookmark-url="${escapeHtml(b.url || "")}" data-bookmark-ts="${escapeHtml(String(b.timestamp || 0))}" data-bookmark-text="${escapeHtml(String(b.text || ""))}"`;

			li.innerHTML = `
				<div class="row between" style="margin-bottom: 0;">
					<div><strong>${escapeHtml(type)}</strong>${when ? ` <span class="small">(${escapeHtml(when)})</span>` : ""}</div>
					<button class="btn small" ${deleteAttrs}>Delete</button>
				</div>
				<div>${escapeHtml(excerpt)}</div>
				<div class="small">${escapeHtml(shortUrl)}</div>
			`;
			bookmarksEl.appendChild(li);
		}
	} else {
		const li = document.createElement("li");
		li.innerHTML = `<div class="small">No quotes yet.</div>`;
		bookmarksEl.appendChild(li);
	}

	// Don't auto-write status text on refresh; reserve status line for user actions/errors.

	// Enable/disable buttons depending on context.
	el("addChapter").disabled = !selectedMaterialId || !url || !isMulti;
	el("addQuote").disabled = !selectedMaterialId || !url || !isMulti;
	// ignoreScroll/markFinished/goToProgress are handled above (selectedChapterUrl)
}

async function toggleFinished() {
	const url = lastSelectedChapterUrl;
	if (!url) {
		setStatusLine("No chapter selected.");
		return;
	}

	const { ok, data } = await bg({ type: "getData" });
	if (!ok) {
		setStatusLine("Failed to load data.");
		return;
	}

	const page = data.pages?.[url] || {};
	const isFinished = page?.status === "finished";
	const res = await bg({ type: "setPageFinished", url, finished: !isFinished });
	if (!res?.ok) {
		setStatusLine(`Failed to update finished (${res?.error || "unknown"}).`);
		return;
	}
	await refreshUI();
}

async function goToSelectedProgress() {
	const url = lastSelectedChapterUrl;
	if (!url) {
		setStatusLine("No chapter selected.");
		return;
	}

	const { ok, data } = await bg({ type: "getData" });
	if (!ok) {
		setStatusLine("Failed to load data.");
		return;
	}

	const page = data.pages?.[url] || {};
	let progress = clampProgress(page?.progress ?? 0);
	// If we have no page record, try to get progress from chapter record.
	const materialId = el("materialSelect")?.value || "";
	const chapters = sortChapters(data.materials?.[materialId]?.chapters || []);
	const c = chapterByUrl(chapters, url);
	if (!data.pages?.[url] && c) progress = clampProgress(c.progress ?? 0);

	const tab = await getActiveTab();
	if (!tab?.id) {
		await chrome.tabs.create({ url });
		return;
	}

	setStatusLine("Opening chapter...");
	await chrome.tabs.update(tab.id, { url });

	// Wait for the tab to finish loading, then scroll.
	const tabId = tab.id;
	const targetUrl = url;
	const timeoutMs = 10000;
	const start = Date.now();
	await new Promise((resolve) => {
		let done = false;
		function cleanup() {
			if (done) return;
			done = true;
			chrome.tabs.onUpdated.removeListener(listener);
			resolve();
		}
		function listener(updatedTabId, changeInfo, updatedTab) {
			if (updatedTabId !== tabId) return;
			if (changeInfo.status !== "complete") return;
			const current = normalizeUrl(updatedTab?.url);
			if (current && current === targetUrl) cleanup();
		}
		chrome.tabs.onUpdated.addListener(listener);
		const timer = setInterval(() => {
			if (Date.now() - start > timeoutMs) {
				clearInterval(timer);
				cleanup();
			}
		}, 250);
	});

	try {
		await chrome.tabs.sendMessage(tabId, { type: "scrollToProgress", progress });
		setStatusLine(`Scrolled to ${progress}%.`);
	} catch {
		setStatusLine("Opened, but couldn't scroll (content script not ready). Try again.");
	}
}

function renderChapterPager(totalPages, currentPage) {
	const container = el("chaptersPages");
	container.innerHTML = "";

	const firstBtn = el("chaptersFirst");
	const prevBtn = el("chaptersPrev");
	const nextBtn = el("chaptersNext");
	const lastBtn = el("chaptersLast");

	const canGoBack = currentPage > 1;
	const canGoForward = currentPage < totalPages;

	firstBtn.disabled = !canGoBack;
	prevBtn.disabled = !canGoBack;
	nextBtn.disabled = !canGoForward;
	lastBtn.disabled = !canGoForward;

	// Show up to 5 numbered pages.
	let start = Math.max(1, currentPage - 2);
	let end = Math.min(totalPages, start + 4);
	start = Math.max(1, end - 4);

	for (let p = start; p <= end; p++) {
		const b = document.createElement("button");
		b.className = "btn small";
		b.textContent = String(p);
		b.dataset.action = "chapters-page";
		b.dataset.page = String(p);
		if (p === currentPage) {
			b.classList.add("primary");
		}
		container.appendChild(b);
	}
}

function escapeHtml(str) {
	return String(str)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

async function declareMaterial() {
	const tab = await getActiveTab();
	const indexUrl = normalizeUrl(tab?.url);
	if (!indexUrl) {
		setStatusLine("Unsupported page.");
		return;
	}

	pendingDeclareIndexUrl = indexUrl;
	const form = el("declareForm");
	if (!form) return;

	// Prefill title from tab title.
	const titleInput = el("declareTitle");
	if (titleInput) titleInput.value = tab?.title || "";
	const kindSelect = el("declareKind");
	if (kindSelect && !kindSelect.value) kindSelect.value = "multi";

	form.classList.remove("hidden");
	setDeclareMode(true);
}

async function cancelDeclare() {
	const form = el("declareForm");
	if (form) form.classList.add("hidden");
	pendingDeclareIndexUrl = "";
	setDeclareMode(false);
}

async function createDeclaredMaterial() {
	const indexUrl = pendingDeclareIndexUrl;
	if (!indexUrl) {
		setStatusLine("No index URL found.");
		return;
	}

	const title = (el("declareTitle")?.value || "").trim();
	const kind = (el("declareKind")?.value || "multi").trim();
	if (!title) {
		setStatusLine("Enter a material title.");
		return;
	}
	if (!["multi", "single"].includes(kind)) {
		setStatusLine("Select a valid material type.");
		return;
	}

	const res = await bg({ type: "createMaterial", indexUrl, title, kind });
	if (!res?.ok) {
		setStatusLine(`Failed to create material (${res?.error || "unknown"}).`);
		return;
	}

	setStatusLine("Material created.");
	lastSelectedMaterialId = res.materialId;
	await cancelDeclare();
	await refreshUI();
}

async function resetLocalData() {
	const typed = prompt("Type RESET to clear all saved extension data:", "");
	if (typed === null) return;
	if (typed !== "RESET") {
		setStatusLine("Not reset.");
		return;
	}

	setStatusLine("Resetting data...");
	const res = await bg({ type: "resetAllData" });
	if (!res?.ok) {
		setStatusLine(`Reset failed (${res?.error || "unknown"}).`);
		return;
	}

	lastSelectedMaterialId = "";
	chaptersPage = 1;
	setStatusLine("All local data cleared.");
	await refreshUI();
}

async function openSelectedMaterialIndex() {
	const { ok, data } = await bg({ type: "getData" });
	if (!ok) return;
	const materialId = el("materialSelect").value;
	const m = data.materials?.[materialId];
	const indexUrl = normalizeUrl(m?.indexUrl);
	if (!indexUrl) return;
	await chrome.tabs.create({ url: indexUrl });
}

async function deleteSelectedMaterial() {
	const { ok, data } = await bg({ type: "getData" });
	if (!ok) return;
	const materialId = el("materialSelect").value;
	const m = data.materials?.[materialId];
	if (!m) return;

	const title = String(m.title || "Untitled");
	const typed = prompt(`Type the material title to delete:\n\n${title}`, "");
	if (typed === null) return;
	if (typed !== title) {
		setStatusLine("Title did not match. Not deleted.");
		return;
	}

	setStatusLine("Deleting material...");
	const res = await bg({ type: "deleteMaterial", materialId });
	if (!res?.ok) {
		setStatusLine(`Failed to delete material (${res?.error || "unknown"}).`);
		return;
	}

	lastSelectedMaterialId = "";
	chaptersPage = 1;
	setStatusLine("Material deleted.");
	await refreshUI();
}

async function addCurrentAsChapter() {
	const tab = await getActiveTab();
	const url = normalizeUrl(tab?.url);
	const materialId = el("materialSelect").value;

	if (!url || !materialId) return;

	const res = await bg({ type: "addChapter", materialId, url });
	if (!res?.ok) {
		setStatusLine("Failed to add chapter.");
		return;
	}

	setStatusLine(res.already ? "Already a chapter." : "Added chapter.");
	await refreshUI();
}

async function addBookmark(bookmarkType) {
	const tab = await getActiveTab();
	const url = normalizeUrl(tab?.url);
	const materialId = el("materialSelect").value;

	if (!url || !materialId) return;

	const selected = await getSelectionFromTab(tab.id);
	if (!selected) {
		setStatusLine("Select text on the page first.");
		return;
	}

	const res = await bg({
		type: "addBookmark",
		materialId,
		url,
		text: selected,
		bookmarkType,
	});

	if (!res?.ok) {
		setStatusLine(`Failed to save quote (${res?.error || "unknown"}).`);
		return;
	}

	setStatusLine("Saved.");
	await refreshUI();
}

async function deleteBookmarkFromSelectedMaterial(payload) {
	const materialId = el("materialSelect").value;
	if (!materialId) return;

	setStatusLine("Deleting quote...");
	const res = await bg({ type: "deleteBookmark", materialId, ...payload });
	if (!res?.ok) {
		setStatusLine(`Failed to delete (${res?.error || "unknown"}).`);
		return;
	}
	setStatusLine("Deleted.");
	await refreshUI();
}

async function setIgnoreScrollProgress(enabled) {
	const url = lastSelectedChapterUrl;
	if (!url) {
		setStatusLine("No chapter selected.");
		return;
	}

	const res = await bg({ type: "setIgnoreScrollProgress", url, ignoreScrollProgress: Boolean(enabled) });
	if (!res?.ok) {
		setStatusLine("Failed to update ignore-scroll.");
		return;
	}
	await refreshUI();
}

async function selectChapter(url) {
	const materialId = el("materialSelect")?.value || "";
	const chapterUrl = normalizeUrl(url);
	if (!materialId || !chapterUrl) return;
	lastSelectedChapterByMaterial[materialId] = chapterUrl;
	await refreshUI();
}

async function deleteChapter(url) {
	const materialId = el("materialSelect")?.value || "";
	const chapterUrl = normalizeUrl(url);
	if (!materialId || !chapterUrl) return;

	// Warn if this chapter has quotes; deleting the chapter will also delete those quotes.
	const { ok, data } = await bg({ type: "getData" });
	if (!ok) {
		setStatusLine("Failed to load data.");
		return;
	}
	const material = data.materials?.[materialId];
	const bookmarks = Array.isArray(material?.bookmarks) ? material.bookmarks : [];
	const quoteCount = bookmarks.filter((b) => normalizeUrl(b?.url) === chapterUrl).length;
	const promptText = quoteCount
		? `Type DELETE to remove this chapter.\n\nWARNING: This will also delete ${quoteCount} quote(s) saved on this chapter.`
		: "Type DELETE to remove this chapter:";
	const typed = prompt(promptText, "");
	if (typed === null) return;
	if (typed !== "DELETE") {
		setStatusLine("Not deleted.");
		return;
	}

	setStatusLine("Deleting chapter...");
	const res = await bg({ type: "deleteChapter", materialId, url: chapterUrl });
	if (!res?.ok) {
		setStatusLine(`Failed to delete chapter (${res?.error || "unknown"}).`);
		return;
	}

	if (Number(res.removedQuotesCount) > 0) {
		setStatusLine(`Chapter deleted. Removed ${res.removedQuotesCount} quote(s).`);
	}

	// If we deleted the selected chapter, clear selection so refreshUI picks latest.
	if (lastSelectedChapterByMaterial[materialId] === chapterUrl) {
		delete lastSelectedChapterByMaterial[materialId];
	}
	await refreshUI();
}

async function goToLatestChapter() {
	const materialId = el("materialSelect")?.value || "";
	if (!materialId) return;

	const { ok, data } = await bg({ type: "getData" });
	if (!ok) {
		setStatusLine("Failed to load data.");
		return;
	}

	const material = data.materials?.[materialId];
	const chapters = sortChapters(material?.chapters || []);
	const latest = chapters.length ? chapters[chapters.length - 1] : null;
	const latestUrl = normalizeUrl(latest?.url);
	if (!latestUrl) {
		setStatusLine("No chapters yet.");
		return;
	}

	await selectChapter(latestUrl);
	const tab = await getActiveTab();
	if (tab?.id) {
		await chrome.tabs.update(tab.id, { url: latestUrl });
	} else {
		await chrome.tabs.create({ url: latestUrl });
	}
}



function bind() {
	safeOn("markFinished", "click", toggleFinished);
	safeOn("goToProgress", "click", goToSelectedProgress);
	safeOn("goToLatestChapter", "click", goToLatestChapter);

	safeOn("declareMaterial", "click", declareMaterial);
	safeOn("declareCancel", "click", cancelDeclare);
	safeOn("declareCreate", "click", createDeclaredMaterial);
	safeOn("resetData", "click", resetLocalData);

	safeOn("materialSelect", "change", () => {
		lastSelectedMaterialId = el("materialSelect")?.value || "";
		chaptersPage = 1;
		refreshUI();
	});

	safeOn("openMaterial", "click", openSelectedMaterialIndex);
	safeOn("deleteMaterial", "click", deleteSelectedMaterial);

	safeOn("addChapter", "click", addCurrentAsChapter);

	safeOn("addQuote", "click", () => addBookmark("quote"));

	safeOn("ignoreScroll", "change", (e) => {
		const target = e.target;
		if (!(target instanceof HTMLInputElement)) return;
		setIgnoreScrollProgress(target.checked);
	});

	// Chapters paging
	safeOn("chaptersFirst", "click", () => {
		chaptersPage = 1;
		refreshUI();
	});
	safeOn("chaptersLast", "click", () => {
		chaptersPage = Number.MAX_SAFE_INTEGER;
		refreshUI();
	});
	safeOn("chaptersPrev", "click", () => {
		chaptersPage = Math.max(1, chaptersPage - 1);
		refreshUI();
	});
	safeOn("chaptersNext", "click", () => {
		chaptersPage = chaptersPage + 1;
		refreshUI();
	});
	safeOn("chaptersPages", "click", (e) => {
		const target = e.target;
		if (!(target instanceof HTMLElement)) return;
		if (target.dataset.action !== "chapters-page") return;
		const p = Number(target.dataset.page);
		if (!Number.isFinite(p) || p < 1) return;
		chaptersPage = p;
		refreshUI();
	});
	safeOn("chaptersGo", "click", () => {
		const raw = (el("chaptersPageInput").value || "").trim();
		const p = Number(raw);
		if (!Number.isFinite(p) || p < 1) {
			setStatusLine("Enter a valid page number.");
			return;
		}
		chaptersPage = Math.floor(p);
		refreshUI();
	});

	// Event delegation for per-item delete buttons.
	safeOn("bookmarks", "click", (e) => {
		const target = e.target;
		if (!(target instanceof HTMLElement)) return;
		if (target.dataset.action !== "delete-bookmark") return;

		const bookmarkId = target.dataset.bookmarkId;
		if (bookmarkId) {
			deleteBookmarkFromSelectedMaterial({ bookmarkId });
			return;
		}

		// Fallback deletion for older items without ids.
		const url = target.dataset.bookmarkUrl;
		const ts = Number(target.dataset.bookmarkTs);
		const text = target.dataset.bookmarkText;
		deleteBookmarkFromSelectedMaterial({
			url,
			timestamp: Number.isFinite(ts) ? ts : undefined,
			text,
		});
	});

	// Chapters click-to-open
	safeOn("chapters", "click", async (e) => {
		const target = e.target;
		if (!(target instanceof HTMLElement)) return;
		const action = target.dataset.action;
		const url = normalizeUrl(target.dataset.url);
		if (!action || !url) return;

		if (action === "select-chapter") {
			await selectChapter(url);
			return;
		}
		if (action === "open-chapter") {
			e.preventDefault();
			const tab = await getActiveTab();
			if (tab?.id) {
				await chrome.tabs.update(tab.id, { url });
			} else {
				await chrome.tabs.create({ url });
			}
			return;
		}
		if (action === "delete-chapter") {
			await deleteChapter(url);
			return;
		}
	});
}

document.addEventListener("DOMContentLoaded", async () => {
	// Default state: only Material section is visible.
	setRequiresMaterialVisible(false);
	setMultiPageVisible(false);

	bind();
	await refreshUI();
});
