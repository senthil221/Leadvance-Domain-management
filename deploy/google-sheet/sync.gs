/**
 * Domain Engine -> campaign volume sheet.
 *
 * Fills "No. of Email Accounts" and "Sending limit per email" for every client
 * and tag from the Domain Engine: connected inboxes on active domains only,
 * never warmup. Limits are whole numbers; a client and tag whose inboxes have
 * different limits gets one row per limit, so accounts x limit is exact.
 * Daily volume, weekly volume and prospects stay your own formulas.
 *
 * Setup (once): Extensions -> Apps Script, paste this file, save, reload the
 * sheet, then use the new "Domain Engine" menu: Set access key, Update volume
 * now, Update every hour.
 */

const FEED_URL = "https://domains.srv1826728.hstgr.cloud/api/sheet/";
const SHEET_NAME = "Sheet1";
// Header texts, compared in lower case with spaces collapsed.
const HEAD = { client: "client", tag: "tag name", accounts: "no. of email accounts", limit: "sending limit per email" };

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Domain Engine")
    .addItem("Update volume now", "syncCapacity")
    .addItem("Update every hour", "installHourlyTrigger")
    .addItem("Set access key", "setAccessKey")
    .addToUi();
}

function setAccessKey() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt("Domain Engine access key", "Paste the key (SHEET_SYNC_TOKEN from the server):", ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const key = r.getResponseText().trim();
  if (key.length < 16) { ui.alert("That key is too short. Nothing was saved."); return; }
  PropertiesService.getScriptProperties().setProperty("SYNC_TOKEN", key);
  ui.alert("Saved. Use Update volume now to test it.");
}

function installHourlyTrigger() {
  for (const t of ScriptApp.getProjectTriggers()) if (t.getHandlerFunction() === "syncCapacity") ScriptApp.deleteTrigger(t);
  ScriptApp.newTrigger("syncCapacity").timeBased().everyHours(1).create();
  SpreadsheetApp.getActive().toast("The volume will update every hour.", "Domain Engine", 5);
}

const norm = (v) => String(v == null ? "" : v).trim().toLowerCase().replace(/\s+/g, " ");

function syncCapacity() {
  const token = PropertiesService.getScriptProperties().getProperty("SYNC_TOKEN");
  if (!token) throw new Error("No access key yet. Use Domain Engine -> Set access key.");
  const res = UrlFetchApp.fetch(FEED_URL + encodeURIComponent(token), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error("The Domain Engine answered " + res.getResponseCode() + ". Check the access key.");
  const feed = JSON.parse(res.getContentText());
  if (!feed.ok) throw new Error("The Domain Engine could not build the numbers.");

  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME) || SpreadsheetApp.getActive().getSheets()[0];
  const values = sheet.getDataRange().getValues();

  // Find the header row and the four columns by their names.
  let head = -1, col = null;
  for (let r = 0; r < Math.min(values.length, 40) && head < 0; r++) {
    const cols = {};
    values[r].forEach((v, c) => { for (const k in HEAD) if (norm(v) === HEAD[k]) cols[k] = c + 1; });
    if (Object.keys(cols).length === 4) { head = r + 1; col = cols; }
  }
  if (head < 0) throw new Error("Could not find the header row (Client, Tag Name, No. of Email Accounts, Sending limit per email).");

  // Existing rows by client and tag, in sheet order (a pair can have several rows, one per limit).
  const rowsOf = {};
  let lastUsed = head;
  for (let r = head; r < values.length; r++) {
    const client = norm(values[r][col.client - 1]), tag = norm(values[r][col.tag - 1]);
    if (client || tag) { (rowsOf[client + "|" + tag] = rowsOf[client + "|" + tag] || []).push(r + 1); lastUsed = r + 1; }
  }
  // Formula cells to the right of the limit column (daily volume and so on), copied onto added rows.
  let formulaCols = 0;
  while (norm(values[head - 1][col.limit + formulaCols]) !== "") formulaCols++;
  const formulaRow = formulaCols ? findFormulaRow(sheet, head, lastUsed, col.limit + 1, formulaCols) : 0;

  const known = new Set(feed.clients.map(norm));
  const used = {}; // how many rows of each client and tag the feed has filled so far
  let updated = 0, added = 0, zeroed = 0;

  for (const f of feed.rows) {
    const key = norm(f.client) + "|" + norm(f.tag);
    const n = used[key] || 0;
    used[key] = n + 1;
    let row = (rowsOf[key] || [])[n];
    if (!row) {
      row = nextFreeRow(sheet, head, lastUsed, col);
      sheet.getRange(row, col.client).setValue(f.client);
      sheet.getRange(row, col.tag).setValue(f.tag);
      if (formulaRow) copyFormulas(sheet, formulaRow, row, col.limit + 1, formulaCols);
      (rowsOf[key] = rowsOf[key] || []).push(row);
      lastUsed = Math.max(lastUsed, row);
      added++;
    } else updated++;
    sheet.getRange(row, col.accounts).setValue(f.accounts);
    sheet.getRange(row, col.limit).setValue(f.limit);
  }

  // A client the app knows, with nothing active left in this row: zero, so the volume isn't overstated.
  for (const key in rowsOf) {
    if (!known.has(key.split("|")[0])) continue; // rows for clients the app doesn't know are yours to keep
    rowsOf[key].slice(used[key] || 0).forEach((row) => {
      sheet.getRange(row, col.accounts).setValue(0);
      sheet.getRange(row, col.limit).setValue(0);
      zeroed++;
    });
  }
  SpreadsheetApp.flush();
  SpreadsheetApp.getActive().toast(updated + " updated, " + added + " added, " + zeroed + " set to 0.", "Domain Engine", 6);
}

/** First row under the header with no client, tag, accounts or limit. */
function nextFreeRow(sheet, head, lastUsed, col) {
  for (let r = head + 1; r <= lastUsed + 1; r++) {
    const empty = [col.client, col.tag, col.accounts, col.limit].every((c) => sheet.getRange(r, c).isBlank());
    if (empty) return r;
  }
  return lastUsed + 1;
}

/** A row that already has the formulas, to copy from. */
function findFormulaRow(sheet, head, lastUsed, firstCol, n) {
  for (let r = head + 1; r <= Math.max(lastUsed, head + 1); r++) {
    if (sheet.getRange(r, firstCol, 1, n).getFormulas()[0].some((f) => f)) return r;
  }
  return 0;
}

function copyFormulas(sheet, from, to, firstCol, n) {
  const target = sheet.getRange(to, firstCol, 1, n);
  if (target.getFormulas()[0].some((f) => f)) return;
  sheet.getRange(from, firstCol, 1, n).copyTo(target, SpreadsheetApp.CopyPasteType.PASTE_FORMULA, false);
}
