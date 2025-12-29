// Reading Companion - content script
// Responsibilities (V1):
// - Track scroll-based reading progress per page
// - Provide selected text to popup for saving as highlight/quote

let lastSentProgress = -1;
let sendTimer = null;

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

function getSelectedText() {
	const selection = window.getSelection();
	if (!selection) return "";
	const text = selection.toString();
	return (text || "").trim();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (message?.type === "getSelection") {
		const selected = getSelectedText();
		return sendResponse({ ok: true, text: selected });
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

	return false;
});
