# Mnemosyne (Chrome Extension)

Mnemosyne helps you keep track of what you read by:
- creating **reading materials**
- adding **chapters** (for multi-page materials)
- saving selected text as **quotes** (highlights) tied to a material
- tracking **scroll progress** per page URL
- **exporting/importing** everything as JSON

---

## Quick “how it works” (user view)

### 1) Create a material
Open the popup on a webpage and click **Add material**.
- **Multi-page** materials use **chapters**
- **Single-page** materials consist of a single page only

### 2) Add chapters (multi-page only)
On a multi-page material:
- The popup selects a material based on the current page URL.
- **Add chapter / chapter actions are tied to the selected material** (and will only make sense when the current URL matches that material’s URL scope).
- Click **Add chapter** while you’re on a chapter page
- Give it a number/label (or leave blank to auto-assign)

### 3) Save quotes
On the page you’re reading:
- Highlight text in the page
- Open the popup and click **Add quote**
- The quote is stored under the selected material

### 4) Track progress
The content script watches scrolling and records a progress percentage for the current page URL (stored in the background).

---

## Load unpacked (Chrome)

1. Go to: **chrome://extensions**
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select the folder that contains:
   - `manifest.json`
   - `background.js`
   - `content.js`
   - `popup.html`
   - `popup.js`
   - `popup.css`
   - (optional) `icons/`

---

## Import / Export (JSON)

### Export
1. Open the popup
2. Go to **Data**
3. Click **Export data**
4. A JSON file will be downloaded containing:
   - `materials`
   - `pages`
   - `collections`

### Import
1. Open the popup
2. Go to **Data**
3. Click **Import data**
4. Select a JSON file you exported earlier

> Note: The popup shows **Import data** even when you have no saved materials yet.

---

## Delete confirmations (safety UX)

To prevent accidental deletes:
- **Delete Material** requires typing **exactly `DELETE`**
- **Delete Chapter** requires typing **exactly `DELETE`**
  (and warns if quotes exist for that chapter URL)

---

## Code layout (where everything lives)

- **`manifest.json`**: extension configuration (MV3, permissions, script wiring)
- **`background.js`**: service worker
  - reads/writes `chrome.storage.local`
  - handles requests like create/delete/import/export
- **`content.js`**: runs inside web pages
  - tracks scroll progress
  - sends selection to the popup
  - best-effort applies saved highlights when visiting URLs
- **`popup.html`**: the popup UI layout
- **`popup.js`**: popup logic (rendering, hiding/showing sections, handling buttons)
- **`popup.css`**: styling

---

## Troubleshooting (most common)

- **Popup looks empty**
  - check that you actually created a material (data lives in `chrome.storage.local`)

- **Highlights/quotes don’t render (usually URL mismatch)**
  - the content script must be able to run on that site
  - URL matching uses normalized URLs (fragments removed), so ensure the saved **material URL / chapter URL** match the current page URLs after navigation

