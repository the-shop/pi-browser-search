import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pbkdf2Sync, createDecipheriv } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const dir = mkdtempSync(join(tmpdir(), "ck-"));
const db = join(dir, "Cookies");
copyFileSync(process.env.HOME + "/Library/Application Support/Google/Chrome/Default/Cookies", db);

let pw = "";
try { pw = execFileSync("security", ["find-generic-password", "-wa", "Chrome", "-s", "Chrome Safe Storage"], {encoding:"utf8"}).trim(); }
catch (e) { console.log("keychain FAILED:", e.message); }
console.log("password length:", pw.length);

const key = pbkdf2Sync(pw, "saltysalt", 1003, 16, "sha1");
const d = new DatabaseSync(db);
const rows = d.prepare("SELECT host_key,name,encrypted_value,path FROM cookies WHERE host_key LIKE '%google.com%'").all();
console.log("google cookie rows:", rows.length);
const out = [];
for (const r of rows) {
  try {
    const buf = r.encrypted_value;
    const enc = Buffer.from(buf);
    if (!enc.length) continue;
    const prefix = enc.subarray(0,3).toString();
    let dec;
    if (prefix === "v10" || prefix === "v11") {
      const iv = Buffer.alloc(16, " ");
      const dc = createDecipheriv("aes-128-cbc", key, iv);
      dec = Buffer.concat([dc.update(enc.subarray(3)), dc.final()]).toString("utf8");
      const h = dec.charCodeAt(0);
      if (h >= 1 && h <= 32) dec = dec.slice(1);
    } else dec = enc.toString("utf8");
    out.push({ name: r.name, value: dec.slice(0,12) + "…", len: dec.length, path: r.path });
  } catch (e) { out.push({ name: r.name, error: e.message.slice(0,40) }); }
}
console.table(out.filter(o => /^(NID|AEC|SOCS|SID|HSID|SSID|APISID|SAPISID|__Secure-1PSID|__Secure-ENID|SIDCC)$/.test(o.name)));
console.log("total usable:", out.filter(o=>o.value).length);
