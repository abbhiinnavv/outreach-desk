// Paste this whole file into Extensions > Apps Script in your Google Sheet.
// Change SECRET to any private word, and use the same word as SHEET_SECRET in .env.local.
// After every step the app sends four tabs (Pipeline, Emails, Replies, Funnel) and this script rewrites them.
const SECRET = "change-me";

function doPost(e) {
  const data = JSON.parse(e.postData.contents);
  if (data.secret !== SECRET) return ContentService.createTextOutput("wrong secret");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(data.sheets).forEach(function (name) {
    const rows = data.sheets[name];
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.clear();
    if (rows.length && rows[0].length) {
      sh.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
      sh.getRange(1, 1, 1, rows[0].length).setFontWeight("bold").setBackground("#E8F0FF");
      sh.setFrozenRows(1);
    }
  });
  return ContentService.createTextOutput("ok");
}
