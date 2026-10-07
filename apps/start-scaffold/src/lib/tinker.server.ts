import { databaseSetup } from "../backend/database";
export const extensions = [databaseSetup];
export { database } from "../backend/database";
export { auth, readAccount } from "../backend/auth";
export { bootstrap } from "../backend/sync";
