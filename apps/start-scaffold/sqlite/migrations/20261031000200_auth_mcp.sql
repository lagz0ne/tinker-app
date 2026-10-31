-- Better Auth 1.7.7's own SQLite shape (its getMigrations) for OAuth for MCP and sign-in with a
-- code, with the Postgres set's index names.
-- New tables: jwks, oauthClient, oauthResource, oauthClientResource,
-- oauthRefreshToken, oauthAccessToken, oauthConsent, oauthClientAssertion, deviceCode.
-- New columns: session.signinCode, session.signinBrowser, and session.signinApprovedBy, set only
-- by a code sign-in; deviceCode.signin* hold that sign-in's browser, next page, OAuth client,
-- and approver. DPoP proof replay and the OAuth login state use the "verification" table.
alter table "session" add column "signinCode" text;
alter table "session" add column "signinBrowser" text;
alter table "session" add column "signinApprovedBy" text;

create table "jwks" (
  "id" text not null primary key,
  "publicKey" text not null,
  "privateKey" text not null,
  "createdAt" date not null,
  "expiresAt" date,
  "alg" text,
  "crv" text
);

create table "oauthClient" (
  "id" text not null primary key,
  "clientId" text not null unique,
  "clientSecret" text,
  "clientDiscoveryId" text,
  "disabled" integer,
  "skipConsent" integer,
  "enableEndSession" integer,
  "subjectType" text,
  "scopes" text,
  "clientCredentialsScopes" text,
  "userId" text references "user" ("id") on delete cascade,
  "createdAt" date,
  "updatedAt" date,
  "name" text,
  "uri" text,
  "icon" text,
  "contacts" text,
  "tos" text,
  "policy" text,
  "softwareId" text,
  "softwareVersion" text,
  "softwareStatement" text,
  "redirectUris" text not null,
  "postLogoutRedirectUris" text,
  "backchannelLogoutUri" text,
  "backchannelLogoutSessionRequired" integer,
  "tokenEndpointAuthMethod" text,
  "applicationType" text,
  "jwks" text,
  "jwksUri" text,
  "grantTypes" text,
  "responseTypes" text,
  "requirePKCE" integer,
  "dpopBoundAccessTokens" integer,
  "referenceId" text,
  "metadata" text
);

create table "oauthResource" (
  "id" text not null primary key,
  "identifier" text not null unique,
  "name" text not null,
  "accessTokenTtl" integer,
  "refreshTokenTtl" integer,
  "signingAlgorithm" text,
  "signingKeyId" text,
  "allowedScopes" text,
  "customClaims" text,
  "dpopBoundAccessTokensRequired" integer,
  "disabled" integer,
  "createdAt" date,
  "updatedAt" date,
  "policyVersion" integer,
  "metadata" text
);

create table "oauthClientResource" (
  "id" text not null primary key,
  "clientId" text not null references "oauthClient" ("clientId") on delete cascade,
  "resourceId" text not null references "oauthResource" ("identifier") on delete cascade,
  "metadata" text,
  "createdAt" date
);

create table "oauthRefreshToken" (
  "id" text not null primary key,
  "token" text not null unique,
  "clientId" text not null references "oauthClient" ("clientId") on delete cascade,
  "sessionId" text references "session" ("id") on delete set null,
  "userId" text not null references "user" ("id") on delete cascade,
  "referenceId" text,
  "authorizationCodeId" text,
  "resources" text,
  "requestedUserInfoClaims" text,
  "expiresAt" date not null,
  "createdAt" date not null,
  "revoked" date,
  "rotatedAt" date,
  "rotationReplayResponse" text,
  "rotationReplayExpiresAt" date,
  "authTime" date,
  "confirmation" text,
  "scopes" text not null
);

create table "oauthAccessToken" (
  "id" text not null primary key,
  "token" text not null unique,
  "clientId" text not null references "oauthClient" ("clientId") on delete cascade,
  "sessionId" text references "session" ("id") on delete set null,
  "userId" text references "user" ("id") on delete cascade,
  "referenceId" text,
  "authorizationCodeId" text,
  "resources" text,
  "requestedUserInfoClaims" text,
  "refreshId" text references "oauthRefreshToken" ("id") on delete cascade,
  "expiresAt" date not null,
  "createdAt" date not null,
  "revoked" date,
  "confirmation" text,
  "scopes" text not null
);

create table "oauthConsent" (
  "id" text not null primary key,
  "clientId" text not null references "oauthClient" ("clientId") on delete cascade,
  "userId" text references "user" ("id") on delete cascade,
  "referenceId" text,
  "resources" text,
  "requestedUserInfoClaims" text,
  "scopes" text not null,
  "createdAt" date not null,
  "updatedAt" date not null
);

create table "oauthClientAssertion" (
  "id" text not null primary key,
  "expiresAt" date not null
);

create table "deviceCode" (
  "id" text not null primary key,
  "deviceCode" text not null,
  "userCode" text not null,
  "userId" text,
  "expiresAt" date not null,
  "status" text not null,
  "lastPolledAt" date,
  "pollingInterval" integer,
  "clientId" text,
  "scope" text,
  "signinBrowser" text,
  "signinNext" text,
  "signinClient" text,
  "signinApprovedBy" text
);

create index oauth_client_user_id on "oauthClient" ("userId");
create index oauth_client_resource_client_id on "oauthClientResource" ("clientId");
create index oauth_client_resource_resource_id on "oauthClientResource" ("resourceId");
create index oauth_refresh_token_client_id on "oauthRefreshToken" ("clientId");
create index oauth_refresh_token_session_id on "oauthRefreshToken" ("sessionId");
create index oauth_refresh_token_user_id on "oauthRefreshToken" ("userId");
create index oauth_refresh_token_authorization_code_id on "oauthRefreshToken" ("authorizationCodeId");
create index oauth_access_token_client_id on "oauthAccessToken" ("clientId");
create index oauth_access_token_session_id on "oauthAccessToken" ("sessionId");
create index oauth_access_token_user_id on "oauthAccessToken" ("userId");
create index oauth_access_token_authorization_code_id on "oauthAccessToken" ("authorizationCodeId");
create index oauth_access_token_refresh_id on "oauthAccessToken" ("refreshId");
create index oauth_consent_client_id on "oauthConsent" ("clientId");
create index oauth_consent_user_id on "oauthConsent" ("userId");
create unique index oauth_client_resource_client_id_resource_id on "oauthClientResource" ("clientId", "resourceId");
create unique index device_code_device_code on "deviceCode" ("deviceCode");
create unique index device_code_user_code on "deviceCode" ("userCode");
