// Reading Companion - content script
// Responsibilities (V1):
// - Track scroll-based reading progress per page
// - Provide selected text to popup for saving as highlight/quote

let lastSentProgress = -1;
let sendTimer = null;

let lastHighlightUrl = "";
let lastHighlightSignature = "";

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

function computeScrollProgressPercent() {
	const doc = document.documentElement;
	const scrollTop = window.scrollY || doc.scrollTop || 0;
	const scrollHeight = doc.scrollHeight || 0;
	const clientHeight = window.innerHeight || doc.clientHeight || 0;
	const denom = Math.max(1, scrollHeight - clientHeight);
	const raw = (scrollTop / denom) * 100;
	return clampProgress(raw);
}

function scheduleSendProgress() {
	if (sendTimer) return;

	// Throttle updates; avoid hammering storage.
	sendTimer = setTimeout(() => {
		sendTimer = null;

		const url = normalizeUrl(location.href);
		if (!url) return;

		const progress = computeScrollProgressPercent();

		// Only send if progress meaningfully changed.
		if (Math.abs(progress - lastSentProgress) < 2) return;
		lastSentProgress = progress;

		chrome.runtime.sendMessage({
			type: "pageProgress",
			url,
			progress,
			title: document.title || "",
		});
	}, 750);
}

window.addEventListener("scroll", scheduleSendProgress, { passive: true });
window.addEventListener("resize", scheduleSendProgress, { passive: true });

// Send an initial progress snapshot after load.
setTimeout(scheduleSendProgress, 1000);

function getSelectedPayload() {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0) {
		return { text: "", contextBefore: "", contextAfter: "" };
	}

	const text = (selection.toString() || "").trim();
	if (!text) return { text: "", contextBefore: "", contextAfter: "" };

	let contextBefore = "";
	let contextAfter = "";
	try {
		const range = selection.getRangeAt(0);
		const max = 120;

		if (range.startContainer?.nodeType === Node.TEXT_NODE) {
			const v = String(range.startContainer.nodeValue || "");
			contextBefore = v.slice(Math.max(0, range.startOffset - max), range.startOffset);
		}
		if (range.endContainer?.nodeType === Node.TEXT_NODE) {
			const v = String(range.endContainer.nodeValue || "");
			contextAfter = v.slice(range.endOffset, Math.min(v.length, range.endOffset + max));
		}
	} catch {
		// ignore
	}

	return { text, contextBefore, contextAfter };
}

function ensureHighlightStyle() {
	if (document.getElementById("rc-highlight-style")) return;
	const style = document.createElement("style");
	style.id = "rc-highlight-style";
	style.textContent = `
		.rc-highlight {
			background: rgba(255, 235, 59, 0.45);
			border-radius: 3px;
			padding: 0 1px;
		}
	`;
	document.documentElement.appendChild(style);
}

function isSkippableNode(node) {
	if (!node) return true;
	const parent = node.parentElement;
	if (!parent) return true;
	if (parent.closest("script, style, textarea, input, select, option, noscript")) return true;
	if (parent.closest(".rc-highlight")) return true;
	return false;
}

function wrapTextMatch(textNode, start, end, quoteId) {
	const text = textNode.nodeValue || "";
	const before = text.slice(0, start);
	const match = text.slice(start, end);
	const after = text.slice(end);

	const span = document.createElement("span");
	span.className = "rc-highlight";
	if (quoteId) span.dataset.rcQuoteId = String(quoteId);
	span.textContent = match;

	const parent = textNode.parentNode;
	if (!parent) return;

	const frag = document.createDocumentFragment();
	if (before) frag.appendChild(document.createTextNode(before));
	frag.appendChild(span);
	if (after) frag.appendChild(document.createTextNode(after));
	parent.replaceChild(frag, textNode);
}

function clearHighlights() {
	const spans = Array.from(document.querySelectorAll("span.rc-highlight"));
	if (!spans.length) return;
	for (const span of spans) {
		const parent = span.parentNode;
		if (!parent) continue;
		parent.replaceChild(document.createTextNode(span.textContent || ""), span);
		parent.normalize?.();
	}
}

function findHighlightSpanById(id) {
	const quoteId = String(id || "").trim();
	if (!quoteId) return null;
	const escaped = (typeof CSS !== "undefined" && typeof CSS.escape === "function")
		? CSS.escape(quoteId)
		: quoteId.replaceAll('"', "\\\"");
	return document.querySelector(`.rc-highlight[data-rc-quote-id="${escaped}"]`);
}

function findHighlightSpanForText(text) {
	const needle = String(text || "").trim().toLowerCase();
	if (!needle) return null;
	const spans = document.querySelectorAll(".rc-highlight");
	for (const s of spans) {
		const t = (s.textContent || "").trim().toLowerCase();
		if (t === needle) return s;
	}
	return null;
}

function commonSuffixLength(a, b) {
	const max = Math.min(a.length, b.length);
	let i = 0;
	for (; i < max; i++) {
		if (a[a.length - 1 - i] !== b[b.length - 1 - i]) break;
	}
	return i;
}

function commonPrefixLength(a, b) {
	const max = Math.min(a.length, b.length);
	let i = 0;
	for (; i < max; i++) {
		if (a[i] !== b[i]) break;
	}
	return i;
}

function findBestMatchInDocument(entry) {
	const needle = String(entry?.text || "").trim();
	if (!needle || needle.length < 3) return null;
	const needleLower = needle.toLowerCase();
	const before = String(entry?.contextBefore || "").toLowerCase();
	const after = String(entry?.contextAfter || "").toLowerCase();

	const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
	let node;
	let safetyCounter = 0;
	let best = null;
	let bestScore = -1;

	while ((node = walker.nextNode())) {
		safetyCounter += 1;
		if (safetyCounter > 25000) break;
		if (isSkippableNode(node)) continue;

		const value = node.nodeValue;
		if (!value || value.length < 3) continue;
		const lower = value.toLowerCase();

		let fromIndex = 0;
		let matchCounter = 0;
		while (true) {
			const idx = lower.indexOf(needleLower, fromIndex);
			if (idx < 0) break;
			matchCounter += 1;
			if (matchCounter > 250) break;

			const end = idx + needle.length;
			const pre = lower.slice(0, idx);
			const post = lower.slice(end);

			let score = 0;
			if (before) {
				const suffix = commonSuffixLength(pre, before);
				score += suffix;
				if (pre.endsWith(before)) score += 50;
			}
			if (after) {
				const prefix = commonPrefixLength(post, after);
				score += prefix;
				if (post.startsWith(after)) score += 50;
			}

			if (score > bestScore) {
				bestScore = score;
				best = { node, start: idx, end };
				// Perfect context hit: bail early.
				if ((before && pre.endsWith(before)) && (after && post.startsWith(after))) {
					return best;
				}
			}

			fromIndex = idx + Math.max(1, needleLower.length);
			if (fromIndex >= lower.length) break;
		}
	}

	return best;
}

function highlightEntry(entry) {
	const quoteId = typeof entry?.id === "string" ? entry.id : "";
	const match = findBestMatchInDocument(entry);
	if (!match) return null;
	wrapTextMatch(match.node, match.start, match.end, quoteId);
	return quoteId ? findHighlightSpanById(quoteId) : findHighlightSpanForText(entry?.text);
}

async function scrollToQuote(payload) {
	const quoteId = typeof payload?.id === "string" ? payload.id : "";
	const needle = String(payload?.text || "").trim();
	if (!needle) return;

	let el = quoteId ? findHighlightSpanById(quoteId) : null;
	if (!el) {
		await refreshHighlights();
		el = quoteId ? findHighlightSpanById(quoteId) : null;
	}

	if (!el) {
		// Fallback: find by exact text match among existing highlights.
		el = findHighlightSpanForText(needle);
	}

	if (!el) {
		// Last resort: highlight this one entry on-demand.
		ensureHighlightStyle();
		el = highlightEntry(payload);
	}
	if (!el) return;

	try {
		el.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
	} catch {
		// ignore
	}
}

function applyHighlights(quotes) {
	ensureHighlightStyle();
	clearHighlights();

	const entries = Array.isArray(quotes) ? quotes : [];
	const normalized = entries
		.map((q) => ({
			id: typeof q?.id === "string" ? q.id : "",
			text: String(q?.text || "").trim(),
			contextBefore: typeof q?.contextBefore === "string" ? q.contextBefore : "",
			contextAfter: typeof q?.contextAfter === "string" ? q.contextAfter : "",
		}))
		.filter((q) => q.text.length >= 3)
		// Prefer longer first to avoid highlighting substrings first.
		.sort((a, b) => b.text.length - a.text.length)
		.slice(0, 50);

	for (const entry of normalized) {
		highlightEntry(entry);
	}
}

async function refreshHighlights() {
	const url = normalizeUrl(location.href);
	if (!url) return;

	try {
		const res = await chrome.runtime.sendMessage({ type: "getQuotesForUrl", url });
		if (!res?.ok) return;
		const quotes = Array.isArray(res.quotes) ? res.quotes : [];
		const sig = quotes
			.map((q) => `${String(q?.id || "")}:${String(q?.text || "").length}`)
			.join("|");

		// Basic guard against repeated work on the same page/quotes.
		if (lastHighlightUrl === url && lastHighlightSignature === sig) return;
		lastHighlightUrl = url;
		lastHighlightSignature = sig;
		applyHighlights(quotes);
	} catch {
		// ignore
	}
}

// Try to apply highlights after initial content load.
setTimeout(refreshHighlights, 1500);
setTimeout(refreshHighlights, 3500);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (message?.type === "getSelection") {
		const selected = getSelectedPayload();
		return sendResponse({ ok: true, ...selected });
	}

	if (message?.type === "scrollToProgress") {
		const progress = clampProgress(message.progress);
		const doc = document.documentElement;
		const scrollHeight = doc.scrollHeight || 0;
		const clientHeight = window.innerHeight || doc.clientHeight || 0;
		const denom = Math.max(1, scrollHeight - clientHeight);
		const top = Math.round((progress / 100) * denom);
		window.scrollTo({ top, left: 0, behavior: "auto" });
		// After scrolling, send an updated progress snapshot.
		setTimeout(scheduleSendProgress, 250);
		return sendResponse({ ok: true });
	}

	if (message?.type === "refreshHighlights") {
		refreshHighlights();
		return sendResponse({ ok: true });
	}

	if (message?.type === "scrollToQuote") {
		scrollToQuote(message);
		return sendResponse({ ok: true });
	}

	return false;
});
