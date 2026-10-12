import { databaseSetup } from "@/backend/index.server";

export const extensions = [databaseSetup];
export { auth, bootstrap, database, readAccount, settings } from "@/backend/index.server";
