import { databaseSetup } from "../backend/database.ts";
export const extensions = [databaseSetup];
export { database } from "../backend/database.ts";
export { auth, readAccount } from "../backend/auth.ts";
export { bootstrap } from "../backend/sync.ts";
