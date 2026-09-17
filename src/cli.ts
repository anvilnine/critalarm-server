import { join } from "node:path";
import { loadConfig } from "./config.js";
import { openDatabase } from "./store/database.js";
import { migrate } from "./store/migrations.js";
import { rotateAdminToken, showAdminToken } from "./admin/credentials.js";
import { relayKeyHash } from "./relay/client.js";
import { Counters } from "./stats/counters.js";
import { deleteAccount, findAccount } from "./v1/accounts.js";

const usage = "usage: critalarm token show|rotate\n       critalarm stats zero-key <relay_key>\n       critalarm account delete <acc_id>|--email <address>";
const config = loadConfig(process.env);
const db = openDatabase(join(config.dataDir, "critalarm.sqlite"));
migrate(db);

// `stats zero-key` takes the plain key a server was issued (rk_...) or the key
// hash the stats endpoint prints. Either way it drops that key out of every
// total and leaves its counter rows in place.
// api.md §4.4, a deletion request that arrives by email. Same erase as
// DELETE /v1/account, minus the live-incident check: the operator is acting on
// a written request, not on a handset with an alarm in front of it.
if (process.argv[2] === "account" && process.argv[3] === "delete") {
  const given = process.argv[4] ?? "";
  const email = given === "--email" ? process.argv[5] ?? "" : undefined;
  if (given === "" || email === "") {
    console.error(usage);
    process.exitCode = 2;
  } else {
    const target = findAccount(db, email === undefined ? { id: given } : { email });
    if (target === undefined) {
      console.error(`no account for ${email ?? given}`);
      process.exitCode = 2;
    } else {
      const counts = deleteAccount(db, target);
      console.log(`deleted ${target}: ${counts.accounts} accounts, ${counts.devices} devices, ${counts.topics} topics, ${counts.incidents} incidents, ${counts.messages} messages, ${counts.identities} identities, ${counts.billingEventsCleared} billing events cleared`);
    }
  }
} else if (process.argv[2] === "stats" && process.argv[3] === "zero-key") {
  const given = process.argv[4];
  if (given === undefined || given === "") {
    console.error(usage);
    process.exitCode = 2;
  } else {
    const key = given.startsWith("rk_") ? relayKeyHash(given) : given;
    const rows = new Counters(db, { now: () => Math.floor(Date.now() / 1000) }).zeroKey(key);
    console.log(`zeroed ${key} (${rows} counter rows kept, excluded from totals)`);
  }
} else {
  const command = process.argv[2] === "token" ? process.argv[3] : process.argv[2];
  const token = command === "rotate" ? rotateAdminToken(db) : command === "show" ? showAdminToken(db) : undefined;
  if (token === undefined) {
    console.error(usage);
    process.exitCode = 2;
  } else {
    console.log(token);
  }
}
db.close();
