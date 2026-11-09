/**
 * Domain Engine -> untracked replies sheet.
 *
 * Lists every reply to a campaign email waiting in Smartlead's untracked list
 * (master inbox replies Smartlead couldn't tie to a lead), newest first, for
 * the account managers. Campaign subjects start with "For …", so only replies
 * whose subject has "Re: For …" (any case, any prefix) come through; bounces
 * and warm-up mail stay out. The Domain Engine reads Smartlead every 15
 * minutes, every page of the list; this script copies what it has into the sheet.
 *
 * Columns are matched by their header in row 1, in any order (date, client,
 * domain, sender_name, sender_email, recipient_email, recipient name, subject,
 * body, received, id, account_id); client, domain and received are added at
 * the end if missing, and an empty sheet gets them all, client near the front. Any
 * other column is yours: notes or a status typed there stay with their reply
 * (matched by id) when the sheet updates. A reply someone has dealt with in
 * Smartlead leaves the sheet, notes and all.
 *
 * Setup (once): Extensions -> Apps Script, paste this file, save, reload the
 * sheet, then use the new "Domain Engine" menu: Set access key, Update replies
 * now, Update every 15 minutes.
 */

const APP_URL = "https://domains.srv1033325.hstgr.cloud";
const SHEET_NAME = "Sheet1";
const FEED_KEYS = ["date", "client", "domain", "sender_name", "sender_email", "recipient_email", "recipient name", "subject", "body", "received", "id", "account_id"];
const ADD_IF_MISSING = ["client", "domain", "received"];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Domain Engine")
    .addItem("Update replies now", "syncUntracked")
    .addItem("Update every 15 minutes", "installTrigger")
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
  ui.alert("Saved. Use Update replies now to test it.");
}

function installTrigger() {
  for (const t of ScriptApp.getProjectTriggers()) if (t.getHandlerFunction() === "syncUntracked") ScriptApp.deleteTrigger(t);
  ScriptApp.newTrigger("syncUntracked").timeBased().everyMinutes(15).create();
  SpreadsheetApp.getActive().toast("The replies will update every 15 minutes.", "Domain Engine", 5);
}

/** Header text compared loosely: case, spaces and underscores don't matter. */
const norm = (v) => String(v == null ? "" : v).trim().toLowerCase().replace(/[\s_]+/g, " ");

function syncUntracked() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty("SYNC_TOKEN");
  if (!token) throw new Error("No access key yet. Use Domain Engine -> Set access key.");
  const base = (props.getProperty("APP_URL") || APP_URL).replace(/\/+$/, "");
  const res = UrlFetchApp.fetch(base + "/api/sheet/" + encodeURIComponent(token) + "/untracked", { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error("The Domain Engine answered " + res.getResponseCode() + ". Check the access key.");
  const feed = JSON.parse(res.getContentText());
  if (!feed.ok) throw new Error("The Domain Engine could not build the list.");

  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME) || SpreadsheetApp.getActive().getSheets()[0];

  // Row 1 is the header: written if the sheet is empty, extended with client, domain and received.
  let lastCol = sheet.getLastColumn();
  let headers = lastCol ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  if (!headers.some((h) => norm(h))) headers = FEED_KEYS.slice();
  for (const k of ADD_IF_MISSING) if (!headers.some((h) => norm(h) === norm(k))) headers.push(k);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
  sheet.setFrozenRows(1);

  // Which feed field fills each column; null for columns that are the sheet's own.
  const feedKeyOf = headers.map((h) => FEED_KEYS.find((k) => norm(k) === norm(h)) || null);
  const idCol = feedKeyOf.indexOf("id");
  if (idCol < 0) throw new Error("The header row needs an id column.");

  // Keep what people typed in their own columns, by reply id.
  const lastRow = sheet.getLastRow();
  const own = {};
  if (lastRow > 1) {
    const old = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
    for (const row of old) {
      const id = String(row[idCol] || "");
      if (id) own[id] = row;
    }
  }

  const rows = feed.rows.map((r) => headers.map((_, c) => {
    const k = feedKeyOf[c];
    if (k) return r[k] == null ? "" : r[k];
    const prev = own[String(r.id)];
    return prev ? prev[c] : "";
  }));

  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, Math.max(headers.length, sheet.getLastColumn())).clearContent();
  if (rows.length) {
    // Text as typed: an id or a date shouldn't be turned into a number or a date by the sheet.
    sheet.getRange(2, 1, rows.length, headers.length).setNumberFormat("@").setValues(rows);
  }
  const when = feed.lastSyncAt ? new Date(feed.lastSyncAt) : null;
  sheet.getRange(1, 1).setNote("Domain Engine: " + rows.length + " untracked replies. Smartlead last read " + (when ? when.toLocaleString() : "not yet") + ".");
  SpreadsheetApp.flush();
  SpreadsheetApp.getActive().toast(rows.length + " untracked replies.", "Domain Engine", 5);
}
