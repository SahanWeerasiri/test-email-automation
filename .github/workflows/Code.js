/**
 * Stale Email Checker — Google Apps Script
 *
 * Receives a list of issues (id, subject, date) from the GitHub workflow.
 * For each issue, it pinpoints the exact Gmail thread using a narrow
 * epoch-window search (subject + date), then checks whether the last
 * reply in that thread is older than the stale threshold.
 *
 * Deduplication strategy:
 *   Two issues can share the same subject (e.g. "Bug: login fails") but
 *   their email threads started on different dates. We use the `date`
 *   field — the first message's sent date — as the dedup key by building
 *   a Gmail search with a ±30-minute epoch window around that date:
 *
 *     subject:"Bug: login fails" after:1741939320 before:1741943520
 *
 *   This is precise enough to isolate a single thread even when subjects
 *   are identical across multiple issue chains.
 *
 * Expected POST body:
 * {
 *   "secret": "<WEBHOOK_SECRET>",
 *   "threshold_days": 14,            // optional — overrides STALE_THRESHOLD_DAYS
 *   "issues": [
 *     {
 *       "id": 42,
 *       "subject": "Bug: login fails",
 *       "date": "Mon, Mar 16, 2026 at 8:32 AM"   // first email date string
 *     },
 *     ...
 *   ]
 * }
 *
 * Response:
 * {
 *   "stale_ids": [42, 57],
 *   "checked": 10,
 *   "errors": []          // per-issue failures (thread not found, bad date, etc.)
 * }
 */


// ── Config ────────────────────────────────────────────────────────────────────

/** Default stale threshold. Overridable per-request via `threshold_days`. */
const STALE_THRESHOLD_DAYS = 14;

/**
 * Half-width of the epoch search window centred on the first-message date.
 * 30 minutes on each side → 1-hour total window.
 * Wide enough to absorb timezone rounding; narrow enough to never span
 * two threads that started hours apart.
 */
const EPOCH_WINDOW_SECONDS = 30 * 60;   // 30 minutes

/**
 * Set this in Apps Script → Project Settings → Script Properties:
 *   Key   : WEBHOOK_SECRET
 *   Value : <a long random string — also stored in GitHub Actions secrets>
 */
const SECRET_PROPERTY_KEY = "WEBHOOK_SECRET";


// ── Entry point ───────────────────────────────────────────────────────────────

function doPost(e) {
    try {
        const data = JSON.parse(e.postData.contents);
        const issues = data.issues;
        const threshold = typeof data.threshold_days === "number"
            ? data.threshold_days
            : STALE_THRESHOLD_DAYS;

        // ── Auth ────────────────────────────────────────────────────────────────
        const storedSecret = PropertiesService
            .getScriptProperties()
            .getProperty(SECRET_PROPERTY_KEY);

        if (!storedSecret || data.secret !== storedSecret) {
            return jsonResponse({ error: "Unauthorized" }, 403);
        }

        // ── Validation ──────────────────────────────────────────────────────────
        if (!Array.isArray(issues) || issues.length === 0) {
            return jsonResponse({ error: "No issues provided" }, 400);
        }

        // ── Process ─────────────────────────────────────────────────────────────
        const result = checkEmailStaleness(issues, threshold);

        return jsonResponse({
            stale_ids: result.stale_ids,
            checked: result.checked,
            errors: result.errors,
        });

    } catch (err) {
        return jsonResponse({ error: "Internal error: " + err.message }, 500);
    }
}


// ── Core logic ────────────────────────────────────────────────────────────────

/**
 * For each issue, constructs a precise Gmail search query using the subject
 * and a narrow epoch window around the first-message date, then checks
 * whether the last reply in the matched thread is stale.
 *
 * @param {Array<{id: number, subject: string, date: string}>} issues
 * @param {number} thresholdDays
 * @returns {{ stale_ids: number[], checked: number, errors: string[] }}
 */
function checkEmailStaleness(issues, thresholdDays) {
    const now = new Date();
    const thresholdMs = thresholdDays * 24 * 60 * 60 * 1000;

    const stale_ids = [];
    const errors = [];

    issues.forEach(function (issue) {
        try {
            const { id, subject, date } = issue;

            // ── Input guards ──────────────────────────────────────────────────────
            if (!subject) {
                errors.push("Issue " + id + ": missing subject");
                return;
            }
            if (!date) {
                errors.push("Issue " + id + ": missing date");
                return;
            }

            // ── Parse the first-message date string ───────────────────────────────
            // Accepts the human-readable format from Gmail headers:
            //   "Mon, Mar 16, 2026 at 8:32 AM"
            // as well as ISO 8601 strings (fallback).
            const firstMessageDate = parseEmailDate(date);
            if (!firstMessageDate) {
                errors.push("Issue " + id + ": could not parse date — \"" + date + "\"");
                return;
            }

            // ── Build epoch-window search query ───────────────────────────────────
            // Convert the date to Unix epoch seconds, then build a ±window query.
            // This is the most precise way to search Gmail for a specific timestamp.
            //
            //   subject:"<subject>" after:<epochStart> before:<epochEnd>
            //
            const epochSeconds = Math.floor(firstMessageDate.getTime() / 1000);
            const epochStart = epochSeconds - EPOCH_WINDOW_SECONDS;
            const epochEnd = epochSeconds + EPOCH_WINDOW_SECONDS;

            const query = 'subject:"' + subject + '" after:' + epochStart + ' before:' + epochEnd;

            const threads = GmailApp.search(query, 0, 5);

            if (!threads || threads.length === 0) {
                // No thread found in this window — not stale by email criteria
                return;
            }

            // With a ±30-min epoch window on a specific subject, we expect exactly
            // one thread. Take the first result.
            const thread = threads[0];
            const messages = thread.getMessages();
            const lastMessage = messages[messages.length - 1];
            const lastEmailTs = lastMessage.getDate();
            const ageMs = now - lastEmailTs;

            if (ageMs > thresholdMs) {
                stale_ids.push(id);
            }

        } catch (err) {
            errors.push("Issue " + issue.id + ": " + err.message);
        }
    });

    return {
        stale_ids: stale_ids,
        checked: issues.length,
        errors: errors,
    };
}


// ── Date parsing ──────────────────────────────────────────────────────────────

/**
 * Parses a date string into a JS Date.
 *
 * Handles:
 *   - Gmail header format : "Mon, Mar 16, 2026 at 8:32 AM"
 *   - ISO 8601            : "2026-03-16T08:32:00Z"
 *   - Any format that JS Date() can natively parse
 *
 * @param {string} dateStr
 * @returns {Date|null}
 */
function parseEmailDate(dateStr) {
    if (!dateStr) return null;

    // Normalise the Gmail "at" format → standard parseable string
    // "Mon, Mar 16, 2026 at 8:32 AM"  →  "Mon, Mar 16, 2026 8:32 AM"
    const normalised = dateStr.replace(/\s+at\s+/i, " ");

    const parsed = new Date(normalised);

    if (!isNaN(parsed.getTime())) {
        return parsed;
    }

    return null;   // unparseable
}


// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * @param {Object} payload
 * @param {number} [status]
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function jsonResponse(payload, status) {
    if (status && status !== 200) {
        payload._status = status;
    }
    return ContentService
        .createTextOutput(JSON.stringify(payload))
        .setMimeType(ContentService.MimeType.JSON);
}


// ── Local test ────────────────────────────────────────────────────────────────

/**
 * Run from the Apps Script editor to test without deploying.
 * Replace the date strings with real first-message dates from your inbox.
 */
function _testLocally() {
    const fakePayload = {
        secret: PropertiesService.getScriptProperties().getProperty(SECRET_PROPERTY_KEY),
        threshold_days: 14,
        issues: [
            // Same subject, different first-message dates — each resolves to a different thread
            { id: 1, subject: "Welcome to WSO2 Developer Platform's US Deployment!", date: "Wed, Mar 25, 2026 at 7:37 AM" },//Wed, Mar 25, 7:37 AM
            { id: 2, subject: "Bug: login fails on Safari", date: "Mon, Jan 10, 2026 at 2:15 PM" },
            { id: 3, subject: "Feature: dark mode support", date: "Fri, Mar 20, 2026 at 9:00 AM" },
        ],
    };

    const fakeEvent = { postData: { contents: JSON.stringify(fakePayload) } };
    const response = doPost(fakeEvent);
    Logger.log(response.getContent());
}