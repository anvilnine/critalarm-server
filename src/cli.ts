import { join } from "node:path";
import { loadConfig } from "./config.js";
import { openDatabase } from "./store/database.js";
import { migrate } from "./store/migrations.js";
import { rotateAdminToken, showAdminToken } from "./admin/credentials.js";

const command = process.argv[2] === "token" ? process.argv[3] : process.argv[2];
const config = loadConfig(process.env);
const db = openDatabase(join(config.dataDir, "critalarm.sqlite"));
migrate(db);
const token = command === "rotate" ? rotateAdminToken(db) : command === "show" ? showAdminToken(db) : undefined;
if (token === undefined) {
  console.error("usage: critalarm token show|rotate");
  process.exitCode = 2;
} else {
  console.log(token);
}
db.close();
