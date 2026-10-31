-- The OAuth client id a code sign-in started for, so the finish goes on only for that client.
alter table "deviceCode" add column "signinClientId" text;
