// ============================================================
// API Tester — Enterprise & Popular Platform Preset Library
// ============================================================

import type { HttpMethod, BodyType, AuthType, AuthConfig } from "@/stores/api-tester.store";

export type PlatformId =
  | "all"
  | "entra"
  | "azure"
  | "google"
  | "aws"
  | "ai"
  | "developer"
  | "mock"
  | "custom";

export interface EnvVariableTemplate {
  key: string;
  defaultValue: string;
  description: string;
}

export interface LibraryPreset {
  id: string;
  name: string;
  platform: PlatformId;
  platformName: string;
  category: string;
  method: HttpMethod;
  url: string;
  description: string;
  docsUrl?: string;
  params?: Array<{ key: string; value: string; description?: string }>;
  headers?: Array<{ key: string; value: string; description?: string }>;
  bodyType?: BodyType;
  bodyValue?: string;
  rawType?: string;
  authType?: AuthType;
  authConfig?: Partial<AuthConfig>;
  envVariables?: EnvVariableTemplate[];
  tags: string[];
}

export interface PlatformMetadata {
  id: PlatformId;
  name: string;
  shortName: string;
  description: string;
  docsUrl: string;
  brandColor: string;
  badgeBg: string;
  envVariables: EnvVariableTemplate[];
}

// ── Platform Metadata ─────────────────────────────────────────

export const PLATFORMS: PlatformMetadata[] = [
  {
    id: "entra",
    name: "Microsoft Entra ID",
    shortName: "Entra ID",
    description: "Cloud identity, access management, and Microsoft Graph APIs (formerly Azure AD).",
    docsUrl: "https://learn.microsoft.com/en-us/graph/api/overview",
    brandColor: "#0078d4",
    badgeBg: "rgba(0, 120, 212, 0.15)",
    envVariables: [
      { key: "tenant_id", defaultValue: "common", description: "Azure AD Tenant ID or 'common' / 'organizations'" },
      { key: "client_id", defaultValue: "", description: "Application (client) ID registered in Entra portal" },
      { key: "client_secret", defaultValue: "", description: "Client Secret generated for the application" },
      { key: "access_token", defaultValue: "", description: "OAuth 2.0 Bearer access token for Microsoft Graph" },
      { key: "redirect_uri", defaultValue: "https://localhost", description: "Configured Redirect URI in Entra ID app" },
    ],
  },
  {
    id: "azure",
    name: "Microsoft Azure",
    shortName: "Azure Cloud",
    description: "Azure Resource Manager (ARM), OpenAI service, Key Vault, and Blob Storage.",
    docsUrl: "https://learn.microsoft.com/en-us/rest/api/azure/",
    brandColor: "#0089d6",
    badgeBg: "rgba(0, 137, 214, 0.15)",
    envVariables: [
      { key: "subscription_id", defaultValue: "", description: "Azure Subscription GUID" },
      { key: "resource_group", defaultValue: "my-resource-group", description: "Azure Resource Group name" },
      { key: "azure_arm_token", defaultValue: "", description: "Bearer token with Azure Management scope" },
      { key: "azure_openai_resource", defaultValue: "my-openai-resource", description: "Azure OpenAI resource name" },
      { key: "azure_openai_deployment", defaultValue: "gpt-4o", description: "Model deployment name in Azure OpenAI" },
      { key: "azure_openai_key", defaultValue: "", description: "Azure OpenAI API Key" },
      { key: "keyvault_name", defaultValue: "my-keyvault", description: "Azure Key Vault name" },
      { key: "storage_account", defaultValue: "mystorageaccount", description: "Azure Storage account name" },
    ],
  },
  {
    id: "google",
    name: "Google Cloud & APIs",
    shortName: "Google Cloud",
    description: "Google Cloud Platform, Gemini 1.5 Flash AI, Drive, Sheets, and Cloud Logging.",
    docsUrl: "https://cloud.google.com/apis/docs/overview",
    brandColor: "#ea4335",
    badgeBg: "rgba(234, 67, 53, 0.15)",
    envVariables: [
      { key: "project_id", defaultValue: "my-gcp-project", description: "Google Cloud Project ID" },
      { key: "gemini_api_key", defaultValue: "", description: "Google AI Studio / Gemini API Key" },
      { key: "google_access_token", defaultValue: "", description: "OAuth 2.0 Bearer access token for Google APIs" },
      { key: "spreadsheet_id", defaultValue: "", description: "Google Sheets document ID" },
    ],
  },
  {
    id: "aws",
    name: "Amazon Web Services",
    shortName: "AWS",
    description: "AWS cloud services including STS Caller Identity, S3 Storage, and DynamoDB.",
    docsUrl: "https://docs.aws.amazon.com/",
    brandColor: "#ff9900",
    badgeBg: "rgba(255, 153, 0, 0.15)",
    envVariables: [
      { key: "aws_region", defaultValue: "us-east-1", description: "AWS Region (e.g. us-east-1, eu-west-1)" },
      { key: "aws_access_key_id", defaultValue: "", description: "AWS IAM Access Key ID" },
      { key: "aws_secret_access_key", defaultValue: "", description: "AWS IAM Secret Access Key" },
    ],
  },
  {
    id: "ai",
    name: "AI & LLM Services",
    shortName: "AI / LLM",
    description: "Leading language models including OpenAI GPT-4o, Anthropic Claude 3.5, and Gemini.",
    docsUrl: "https://platform.openai.com/docs/api-reference",
    brandColor: "#10a37f",
    badgeBg: "rgba(16, 163, 127, 0.15)",
    envVariables: [
      { key: "OPENAI_API_KEY", defaultValue: "", description: "OpenAI Secret API Key (sk-...)" },
      { key: "ANTHROPIC_API_KEY", defaultValue: "", description: "Anthropic Claude API Key (sk-ant-...)" },
      { key: "gemini_api_key", defaultValue: "", description: "Google Gemini API Key" },
    ],
  },
  {
    id: "developer",
    name: "Developer & SaaS Tools",
    shortName: "Developer",
    description: "GitHub REST API, Stripe Payments, Supabase Database, and webhooks.",
    docsUrl: "https://docs.github.com/en/rest",
    brandColor: "#a855f7",
    badgeBg: "rgba(168, 85, 247, 0.15)",
    envVariables: [
      { key: "GITHUB_TOKEN", defaultValue: "", description: "GitHub Personal Access Token (ghp_...)" },
      { key: "STRIPE_SECRET_KEY", defaultValue: "", description: "Stripe Secret Key (sk_test_...)" },
      { key: "SUPABASE_URL", defaultValue: "https://xyzcompany.supabase.co", description: "Supabase project URL" },
      { key: "SUPABASE_ANON_KEY", defaultValue: "", description: "Supabase Anon / Public API Key" },
    ],
  },
  {
    id: "mock",
    name: "Mock & Test Utilities",
    shortName: "Mock / Sandbox",
    description: "Public sandbox endpoints for testing payload echos, status codes, and mock data.",
    docsUrl: "https://postman-echo.com",
    brandColor: "#06b6d4",
    badgeBg: "rgba(6, 182, 212, 0.15)",
    envVariables: [],
  },
];

// ── Complete Curated Presets ──────────────────────────────────

export const LIBRARY_PRESETS: LibraryPreset[] = [
  // ─────────────────────────────────────────────────────────────
  // 1. MICROSOFT ENTRA ID (Azure AD & Microsoft Graph)
  // ─────────────────────────────────────────────────────────────
  {
    id: "entra-token-client-credentials",
    name: "Entra ID: OAuth 2.0 Client Credentials Token",
    platform: "entra",
    platformName: "Microsoft Entra ID",
    category: "Authentication",
    method: "POST",
    url: "https://login.microsoftonline.com/{{tenant_id}}/oauth2/v2.0/token",
    description: "Obtain an app-only access token using Client ID & Secret for daemon/service workloads.",
    docsUrl: "https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow",
    headers: [
      { key: "Content-Type", value: "application/x-www-form-urlencoded" },
    ],
    bodyType: "raw",
    rawType: "text/plain",
    bodyValue: "client_id={{client_id}}&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default&client_secret={{client_secret}}&grant_type=client_credentials",
    authType: "none",
    tags: ["entra", "oauth2", "token", "azure-ad", "auth"],
    envVariables: [
      { key: "tenant_id", defaultValue: "common", description: "Azure AD Tenant ID or GUID" },
      { key: "client_id", defaultValue: "", description: "Application Client ID" },
      { key: "client_secret", defaultValue: "", description: "Application Client Secret" },
    ],
  },
  {
    id: "entra-token-auth-code",
    name: "Entra ID: OAuth 2.0 Auth Code Exchange",
    platform: "entra",
    platformName: "Microsoft Entra ID",
    category: "Authentication",
    method: "POST",
    url: "https://login.microsoftonline.com/{{tenant_id}}/oauth2/v2.0/token",
    description: "Exchange an authorization code for user delegated access and refresh tokens.",
    docsUrl: "https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow",
    headers: [
      { key: "Content-Type", value: "application/x-www-form-urlencoded" },
    ],
    bodyType: "raw",
    rawType: "text/plain",
    bodyValue: "client_id={{client_id}}&scope=User.Read%20offline_access&code={{auth_code}}&redirect_uri={{redirect_uri}}&grant_type=authorization_code&client_secret={{client_secret}}",
    authType: "none",
    tags: ["entra", "oauth2", "auth-code", "delegated"],
  },
  {
    id: "entra-token-refresh",
    name: "Entra ID: Refresh Access Token",
    platform: "entra",
    platformName: "Microsoft Entra ID",
    category: "Authentication",
    method: "POST",
    url: "https://login.microsoftonline.com/{{tenant_id}}/oauth2/v2.0/token",
    description: "Refresh an expired access token using a valid refresh token without user interaction.",
    docsUrl: "https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow#refresh-the-access-token",
    headers: [
      { key: "Content-Type", value: "application/x-www-form-urlencoded" },
    ],
    bodyType: "raw",
    rawType: "text/plain",
    bodyValue: "client_id={{client_id}}&grant_type=refresh_token&refresh_token={{refresh_token}}&client_secret={{client_secret}}&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default",
    authType: "none",
    tags: ["entra", "oauth2", "refresh-token"],
  },
  {
    id: "graph-get-me",
    name: "Microsoft Graph: Get Current User Profile (/me)",
    platform: "entra",
    platformName: "Microsoft Entra ID",
    category: "Microsoft Graph",
    method: "GET",
    url: "https://graph.microsoft.com/v1.0/me",
    description: "Retrieve account profile data for the currently authenticated signed-in user.",
    docsUrl: "https://learn.microsoft.com/en-us/graph/api/user-get",
    headers: [
      { key: "Authorization", value: "Bearer {{access_token}}" },
      { key: "Accept", value: "application/json" },
    ],
    authType: "bearer",
    authConfig: { bearerToken: "{{access_token}}" },
    tags: ["graph", "entra", "user", "profile", "me"],
  },
  {
    id: "graph-list-users",
    name: "Microsoft Graph: List Organization Users",
    platform: "entra",
    platformName: "Microsoft Entra ID",
    category: "Microsoft Graph",
    method: "GET",
    url: "https://graph.microsoft.com/v1.0/users",
    description: "List directory users with OData query parameters ($top, $select, $filter).",
    docsUrl: "https://learn.microsoft.com/en-us/graph/api/user-list",
    params: [
      { key: "$top", value: "10", description: "Max number of items to return" },
      { key: "$select", value: "id,displayName,userPrincipalName,mail,jobTitle", description: "Subset of properties to fetch" },
      { key: "$filter", value: "accountEnabled eq true", description: "OData filter criteria" },
    ],
    headers: [
      { key: "Authorization", value: "Bearer {{access_token}}" },
      { key: "ConsistencyLevel", value: "eventual" },
    ],
    authType: "bearer",
    authConfig: { bearerToken: "{{access_token}}" },
    tags: ["graph", "entra", "users", "directory", "odata"],
  },
  {
    id: "graph-get-user-by-id",
    name: "Microsoft Graph: Get User by ID or UPN",
    platform: "entra",
    platformName: "Microsoft Entra ID",
    category: "Microsoft Graph",
    method: "GET",
    url: "https://graph.microsoft.com/v1.0/users/{{user_id_or_upn}}",
    description: "Retrieve specific user profile by user GUID or User Principal Name (email).",
    docsUrl: "https://learn.microsoft.com/en-us/graph/api/user-get",
    headers: [
      { key: "Authorization", value: "Bearer {{access_token}}" },
    ],
    authType: "bearer",
    authConfig: { bearerToken: "{{access_token}}" },
    tags: ["graph", "entra", "users", "upn"],
  },
  {
    id: "graph-list-groups",
    name: "Microsoft Graph: List Security & M365 Groups",
    platform: "entra",
    platformName: "Microsoft Entra ID",
    category: "Microsoft Graph",
    method: "GET",
    url: "https://graph.microsoft.com/v1.0/groups",
    description: "Query Entra directory security groups and Microsoft 365 collaborative groups.",
    docsUrl: "https://learn.microsoft.com/en-us/graph/api/group-list",
    params: [
      { key: "$top", value: "10" },
      { key: "$select", value: "id,displayName,description,groupTypes,securityEnabled" },
    ],
    headers: [
      { key: "Authorization", value: "Bearer {{access_token}}" },
    ],
    authType: "bearer",
    authConfig: { bearerToken: "{{access_token}}" },
    tags: ["graph", "entra", "groups", "security"],
  },
  {
    id: "graph-send-mail",
    name: "Microsoft Graph: Send Email via Outlook",
    platform: "entra",
    platformName: "Microsoft Entra ID",
    category: "Microsoft Graph",
    method: "POST",
    url: "https://graph.microsoft.com/v1.0/me/sendMail",
    description: "Send an email on behalf of signed-in user with HTML body and recipient lists.",
    docsUrl: "https://learn.microsoft.com/en-us/graph/api/user-sendmail",
    headers: [
      { key: "Authorization", value: "Bearer {{access_token}}" },
      { key: "Content-Type", value: "application/json" },
    ],
    bodyType: "json",
    bodyValue: JSON.stringify(
      {
        message: {
          subject: "Test Message from DevUtils API Tester",
          body: {
            contentType: "HTML",
            content: "<h3>Hello from DevUtils!</h3><p>This message was sent using Microsoft Graph API.</p>",
          },
          toRecipients: [
            {
              emailAddress: {
                address: "recipient@example.com",
              },
            },
          ],
        },
        saveToSentItems: true,
      },
      null,
      2
    ),
    authType: "bearer",
    authConfig: { bearerToken: "{{access_token}}" },
    tags: ["graph", "mail", "outlook", "entra"],
  },
  {
    id: "graph-audit-logs",
    name: "Microsoft Entra: List Directory Audit Logs",
    platform: "entra",
    platformName: "Microsoft Entra ID",
    category: "Security & Governance",
    method: "GET",
    url: "https://graph.microsoft.com/v1.0/auditLogs/directoryAudits",
    description: "Fetch tenant audit logs for directory activities such as user creation and role changes.",
    docsUrl: "https://learn.microsoft.com/en-us/graph/api/directoryaudit-list",
    params: [
      { key: "$top", value: "10" },
    ],
    headers: [
      { key: "Authorization", value: "Bearer {{access_token}}" },
    ],
    authType: "bearer",
    authConfig: { bearerToken: "{{access_token}}" },
    tags: ["entra", "audit", "security", "logs"],
  },
  {
    id: "graph-signin-logs",
    name: "Microsoft Entra: List User Sign-in Activity",
    platform: "entra",
    platformName: "Microsoft Entra ID",
    category: "Security & Governance",
    method: "GET",
    url: "https://graph.microsoft.com/v1.0/auditLogs/signIns",
    description: "Monitor user sign-in events including location, device, conditional access, and failure reasons.",
    docsUrl: "https://learn.microsoft.com/en-us/graph/api/signin-list",
    params: [
      { key: "$top", value: "10" },
    ],
    headers: [
      { key: "Authorization", value: "Bearer {{access_token}}" },
    ],
    authType: "bearer",
    authConfig: { bearerToken: "{{access_token}}" },
    tags: ["entra", "signins", "security", "compliance"],
  },
  {
    id: "graph-list-applications",
    name: "Microsoft Entra: List App Registrations",
    platform: "entra",
    platformName: "Microsoft Entra ID",
    category: "App Management",
    method: "GET",
    url: "https://graph.microsoft.com/v1.0/applications",
    description: "Query enterprise application registrations within the current Entra ID tenant.",
    docsUrl: "https://learn.microsoft.com/en-us/graph/api/application-list",
    params: [
      { key: "$top", value: "10" },
      { key: "$select", value: "id,appId,displayName,signInAudience,createdDateTime" },
    ],
    headers: [
      { key: "Authorization", value: "Bearer {{access_token}}" },
    ],
    authType: "bearer",
    authConfig: { bearerToken: "{{access_token}}" },
    tags: ["entra", "apps", "app-registrations"],
  },

  // ─────────────────────────────────────────────────────────────
  // 2. MICROSOFT AZURE CLOUD SERVICES
  // ─────────────────────────────────────────────────────────────
  {
    id: "azure-arm-subscriptions",
    name: "Azure ARM: List Subscriptions",
    platform: "azure",
    platformName: "Microsoft Azure",
    category: "Resource Management",
    method: "GET",
    url: "https://management.azure.com/subscriptions",
    description: "List all Azure subscriptions accessible to the authenticated principal.",
    docsUrl: "https://learn.microsoft.com/en-us/rest/api/resources/subscriptions/list",
    params: [
      { key: "api-version", value: "2020-01-01" },
    ],
    headers: [
      { key: "Authorization", value: "Bearer {{azure_arm_token}}" },
      { key: "Content-Type", value: "application/json" },
    ],
    authType: "bearer",
    authConfig: { bearerToken: "{{azure_arm_token}}" },
    tags: ["azure", "arm", "subscriptions", "cloud"],
  },
  {
    id: "azure-arm-resource-groups",
    name: "Azure ARM: List Resource Groups",
    platform: "azure",
    platformName: "Microsoft Azure",
    category: "Resource Management",
    method: "GET",
    url: "https://management.azure.com/subscriptions/{{subscription_id}}/resourcegroups",
    description: "List resource groups in an Azure subscription.",
    docsUrl: "https://learn.microsoft.com/en-us/rest/api/resources/resource-groups/list",
    params: [
      { key: "api-version", value: "2021-04-01" },
    ],
    headers: [
      { key: "Authorization", value: "Bearer {{azure_arm_token}}" },
    ],
    authType: "bearer",
    authConfig: { bearerToken: "{{azure_arm_token}}" },
    tags: ["azure", "arm", "resource-groups"],
  },
  {
    id: "azure-arm-list-resources",
    name: "Azure ARM: List Resources in Group",
    platform: "azure",
    platformName: "Microsoft Azure",
    category: "Resource Management",
    method: "GET",
    url: "https://management.azure.com/subscriptions/{{subscription_id}}/resourceGroups/{{resource_group}}/resources",
    description: "List all cloud resources (VMs, storage, databases) contained within a resource group.",
    docsUrl: "https://learn.microsoft.com/en-us/rest/api/resources/resources/list-by-resource-group",
    params: [
      { key: "api-version", value: "2021-04-01" },
    ],
    headers: [
      { key: "Authorization", value: "Bearer {{azure_arm_token}}" },
    ],
    authType: "bearer",
    authConfig: { bearerToken: "{{azure_arm_token}}" },
    tags: ["azure", "arm", "resources"],
  },
  {
    id: "azure-openai-chat-completions",
    name: "Azure OpenAI: Chat Completions",
    platform: "azure",
    platformName: "Microsoft Azure",
    category: "Azure AI",
    method: "POST",
    url: "https://{{azure_openai_resource}}.openai.azure.com/openai/deployments/{{azure_openai_deployment}}/chat/completions",
    description: "Execute a chat completions query on an Azure OpenAI model deployment (e.g. GPT-4o).",
    docsUrl: "https://learn.microsoft.com/en-us/azure/ai-services/openai/reference",
    params: [
      { key: "api-version", value: "2024-02-15-preview" },
    ],
    headers: [
      { key: "Content-Type", value: "application/json" },
      { key: "api-key", value: "{{azure_openai_key}}" },
    ],
    bodyType: "json",
    bodyValue: JSON.stringify(
      {
        messages: [
          { role: "system", content: "You are a helpful assistant deployed in Microsoft Azure OpenAI." },
          { role: "user", content: "Provide a quick architecture summary of cloud microservices." },
        ],
        max_tokens: 500,
        temperature: 0.7,
      },
      null,
      2
    ),
    authType: "api-key",
    authConfig: {
      apiKeyName: "api-key",
      apiKeyValue: "{{azure_openai_key}}",
      apiKeyPlacement: "header",
    },
    tags: ["azure", "openai", "ai", "llm", "gpt-4"],
  },
  {
    id: "azure-keyvault-get-secret",
    name: "Azure Key Vault: Get Secret",
    platform: "azure",
    platformName: "Microsoft Azure",
    category: "Security & Secrets",
    method: "GET",
    url: "https://{{keyvault_name}}.vault.azure.net/secrets/{{secret_name}}",
    description: "Retrieve sensitive configuration or password secret value from Azure Key Vault.",
    docsUrl: "https://learn.microsoft.com/en-us/rest/api/keyvault/secrets/get-secret/get-secret",
    params: [
      { key: "api-version", value: "7.4" },
    ],
    headers: [
      { key: "Authorization", value: "Bearer {{azure_arm_token}}" },
      { key: "Content-Type", value: "application/json" },
    ],
    authType: "bearer",
    authConfig: { bearerToken: "{{azure_arm_token}}" },
    tags: ["azure", "keyvault", "secrets", "security"],
  },
  {
    id: "azure-keyvault-set-secret",
    name: "Azure Key Vault: Set/Update Secret",
    platform: "azure",
    platformName: "Microsoft Azure",
    category: "Security & Secrets",
    method: "PUT",
    url: "https://{{keyvault_name}}.vault.azure.net/secrets/{{secret_name}}",
    description: "Store or rotate a secret value inside an Azure Key Vault.",
    docsUrl: "https://learn.microsoft.com/en-us/rest/api/keyvault/secrets/set-secret/set-secret",
    params: [
      { key: "api-version", value: "7.4" },
    ],
    headers: [
      { key: "Authorization", value: "Bearer {{azure_arm_token}}" },
      { key: "Content-Type", value: "application/json" },
    ],
    bodyType: "json",
    bodyValue: JSON.stringify(
      {
        value: "MySuperSecretValue_2026",
        attributes: {
          enabled: true,
        },
      },
      null,
      2
    ),
    authType: "bearer",
    authConfig: { bearerToken: "{{azure_arm_token}}" },
    tags: ["azure", "keyvault", "secrets"],
  },
  {
    id: "azure-blob-list-containers",
    name: "Azure Blob Storage: List Containers",
    platform: "azure",
    platformName: "Microsoft Azure",
    category: "Storage",
    method: "GET",
    url: "https://{{storage_account}}.blob.core.windows.net/",
    description: "List all blob containers within an Azure Storage account.",
    docsUrl: "https://learn.microsoft.com/en-us/rest/api/storageservices/list-containers2",
    params: [
      { key: "comp", value: "list" },
    ],
    headers: [
      { key: "x-ms-version", value: "2023-08-03" },
      { key: "Authorization", value: "Bearer {{azure_arm_token}}" },
    ],
    authType: "bearer",
    authConfig: { bearerToken: "{{azure_arm_token}}" },
    tags: ["azure", "storage", "blob", "containers"],
  },
  {
    id: "azure-cosmosdb-list-databases",
    name: "Azure Cosmos DB: List Databases",
    platform: "azure",
    platformName: "Microsoft Azure",
    category: "Databases",
    method: "GET",
    url: "https://{{cosmos_account}}.documents.azure.com/dbs",
    description: "Query databases inside an Azure Cosmos DB NoSQL account.",
    docsUrl: "https://learn.microsoft.com/en-us/rest/api/cosmos-db/list-databases",
    headers: [
      { key: "x-ms-version", value: "2018-12-31" },
      { key: "Authorization", value: "{{cosmos_auth_token}}" },
    ],
    tags: ["azure", "cosmosdb", "nosql", "database"],
  },

  // ─────────────────────────────────────────────────────────────
  // 3. GOOGLE CLOUD & GOOGLE WORKSPACE
  // ─────────────────────────────────────────────────────────────
  {
    id: "google-oauth-token-exchange",
    name: "Google OAuth 2.0: Token Exchange",
    platform: "google",
    platformName: "Google Cloud & APIs",
    category: "Authentication",
    method: "POST",
    url: "https://oauth2.googleapis.com/token",
    description: "Exchange authorization code or refresh token for a Google access token.",
    docsUrl: "https://developers.google.com/identity/protocols/oauth2/web-server",
    headers: [
      { key: "Content-Type", value: "application/x-www-form-urlencoded" },
    ],
    bodyType: "raw",
    rawType: "text/plain",
    bodyValue: "client_id={{google_client_id}}&client_secret={{google_client_secret}}&code={{google_auth_code}}&grant_type=authorization_code&redirect_uri={{redirect_uri}}",
    authType: "none",
    tags: ["google", "oauth2", "token", "auth"],
  },
  {
    id: "google-oauth-tokeninfo",
    name: "Google OAuth 2.0: Validate Token (TokenInfo)",
    platform: "google",
    platformName: "Google Cloud & APIs",
    category: "Authentication",
    method: "GET",
    url: "https://oauth2.googleapis.com/tokeninfo",
    description: "Inspect claims, expiration, scopes, and audience of a Google access token.",
    docsUrl: "https://developers.google.com/identity/protocols/oauth2/openid-connect#validatinganidtoken",
    params: [
      { key: "access_token", value: "{{google_access_token}}" },
    ],
    tags: ["google", "oauth2", "tokeninfo", "validation"],
  },
  {
    id: "google-gemini-generate-content",
    name: "Google Gemini: Generate Content (Gemini 1.5 Flash)",
    platform: "google",
    platformName: "Google Cloud & APIs",
    category: "AI & Machine Learning",
    method: "POST",
    url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent",
    description: "Generate multimodal text or code completions using Google's Gemini 1.5 Flash model.",
    docsUrl: "https://ai.google.dev/api/rest/v1beta/models/generateContent",
    params: [
      { key: "key", value: "{{gemini_api_key}}" },
    ],
    headers: [
      { key: "Content-Type", value: "application/json" },
    ],
    bodyType: "json",
    bodyValue: JSON.stringify(
      {
        contents: [
          {
            parts: [
              {
                text: "Explain how OAuth 2.0 client credentials grant works in 2 bullet points.",
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 300,
        },
      },
      null,
      2
    ),
    tags: ["google", "gemini", "ai", "llm", "genai"],
  },
  {
    id: "google-gemini-list-models",
    name: "Google Gemini: List Available Models",
    platform: "google",
    platformName: "Google Cloud & APIs",
    category: "AI & Machine Learning",
    method: "GET",
    url: "https://generativelanguage.googleapis.com/v1beta/models",
    description: "Query all Gemini, embedding, and multimodal models supported by the API key.",
    docsUrl: "https://ai.google.dev/api/rest/v1beta/models/list",
    params: [
      { key: "key", value: "{{gemini_api_key}}" },
    ],
    tags: ["google", "gemini", "models", "ai"],
  },
  {
    id: "google-cloud-get-project",
    name: "Google Cloud: Get Project Details",
    platform: "google",
    platformName: "Google Cloud & APIs",
    category: "Cloud Resource Manager",
    method: "GET",
    url: "https://cloudresourcemanager.googleapis.com/v1/projects/{{project_id}}",
    description: "Retrieve Google Cloud project status, labels, and project number.",
    docsUrl: "https://cloud.google.com/resource-manager/reference/rest/v1/projects/get",
    headers: [
      { key: "Authorization", value: "Bearer {{google_access_token}}" },
    ],
    authType: "bearer",
    authConfig: { bearerToken: "{{google_access_token}}" },
    tags: ["google", "gcp", "projects", "resource-manager"],
  },
  {
    id: "google-drive-list-files",
    name: "Google Drive API: List Files & Folders",
    platform: "google",
    platformName: "Google Cloud & APIs",
    category: "Google Workspace",
    method: "GET",
    url: "https://www.googleapis.com/drive/v3/files",
    description: "List files, spreadsheets, documents, and folders with metadata fields.",
    docsUrl: "https://developers.google.com/drive/api/v3/reference/files/list",
    params: [
      { key: "pageSize", value: "10" },
      { key: "fields", value: "nextPageToken,files(id,name,mimeType,modifiedTime,size)" },
    ],
    headers: [
      { key: "Authorization", value: "Bearer {{google_access_token}}" },
    ],
    authType: "bearer",
    authConfig: { bearerToken: "{{google_access_token}}" },
    tags: ["google", "drive", "workspace", "files"],
  },
  {
    id: "google-sheets-get-values",
    name: "Google Sheets API: Read Range Values",
    platform: "google",
    platformName: "Google Cloud & APIs",
    category: "Google Workspace",
    method: "GET",
    url: "https://sheets.googleapis.com/v4/spreadsheets/{{spreadsheet_id}}/values/{{range}}",
    description: "Read row and column cell values from a Google Sheets spreadsheet.",
    docsUrl: "https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets.values/get",
    params: [
      { key: "majorDimension", value: "ROWS" },
    ],
    headers: [
      { key: "Authorization", value: "Bearer {{google_access_token}}" },
    ],
    authType: "bearer",
    authConfig: { bearerToken: "{{google_access_token}}" },
    tags: ["google", "sheets", "workspace", "data"],
  },
  {
    id: "google-storage-list-buckets",
    name: "Google Cloud Storage: List Buckets",
    platform: "google",
    platformName: "Google Cloud & APIs",
    category: "Storage",
    method: "GET",
    url: "https://storage.googleapis.com/storage/v1/b",
    description: "List Cloud Storage buckets owned by the specified GCP project.",
    docsUrl: "https://cloud.google.com/storage/docs/json_api/v1/buckets/list",
    params: [
      { key: "project", value: "{{project_id}}" },
    ],
    headers: [
      { key: "Authorization", value: "Bearer {{google_access_token}}" },
    ],
    authType: "bearer",
    authConfig: { bearerToken: "{{google_access_token}}" },
    tags: ["google", "gcs", "storage", "buckets"],
  },
  {
    id: "google-logging-list-entries",
    name: "Google Cloud Logging: Query Log Entries",
    platform: "google",
    platformName: "Google Cloud & APIs",
    category: "Operations & Monitoring",
    method: "POST",
    url: "https://logging.googleapis.com/v2/entries:list",
    description: "Query runtime logs and error events across GCP resources.",
    docsUrl: "https://cloud.google.com/logging/docs/reference/v2/rest/v2/entries/list",
    headers: [
      { key: "Authorization", value: "Bearer {{google_access_token}}" },
      { key: "Content-Type", value: "application/json" },
    ],
    bodyType: "json",
    bodyValue: JSON.stringify(
      {
        projectIds: ["{{project_id}}"],
        pageSize: 10,
        orderBy: "timestamp desc",
      },
      null,
      2
    ),
    authType: "bearer",
    authConfig: { bearerToken: "{{google_access_token}}" },
    tags: ["google", "logging", "monitoring", "devops"],
  },

  // ─────────────────────────────────────────────────────────────
  // 4. AMAZON WEB SERVICES (AWS)
  // ─────────────────────────────────────────────────────────────
  {
    id: "aws-sts-get-caller-identity",
    name: "AWS STS: Get Caller Identity",
    platform: "aws",
    platformName: "Amazon Web Services",
    category: "Identity & Access",
    method: "POST",
    url: "https://sts.amazonaws.com/",
    description: "Verify AWS IAM caller identity, account ID, and active assumed role ARN.",
    docsUrl: "https://docs.aws.amazon.com/STS/latest/APIReference/API_GetCallerIdentity.html",
    headers: [
      { key: "Content-Type", value: "application/x-www-form-urlencoded" },
    ],
    bodyType: "raw",
    rawType: "text/plain",
    bodyValue: "Action=GetCallerIdentity&Version=2011-06-15",
    tags: ["aws", "sts", "iam", "identity"],
  },
  {
    id: "aws-s3-list-buckets",
    name: "AWS S3: List Buckets",
    platform: "aws",
    platformName: "Amazon Web Services",
    category: "Storage",
    method: "GET",
    url: "https://s3.amazonaws.com/",
    description: "List all Amazon S3 buckets belonging to the AWS account.",
    docsUrl: "https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListBuckets.html",
    tags: ["aws", "s3", "storage", "buckets"],
  },
  {
    id: "aws-dynamodb-list-tables",
    name: "AWS DynamoDB: List Tables",
    platform: "aws",
    platformName: "Amazon Web Services",
    category: "Databases",
    method: "POST",
    url: "https://dynamodb.{{aws_region}}.amazonaws.com/",
    description: "List all Amazon DynamoDB tables in the specified region.",
    docsUrl: "https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_ListTables.html",
    headers: [
      { key: "X-Amz-Target", value: "DynamoDB_20120810.ListTables" },
      { key: "Content-Type", value: "application/x-amz-json-1.0" },
    ],
    bodyType: "json",
    bodyValue: JSON.stringify({ Limit: 10 }, null, 2),
    tags: ["aws", "dynamodb", "nosql", "database"],
  },

  // ─────────────────────────────────────────────────────────────
  // 5. AI & LLM PLATFORMS (OpenAI, Claude, Gemini)
  // ─────────────────────────────────────────────────────────────
  {
    id: "openai-chat-completions",
    name: "OpenAI: Chat Completions (GPT-4o)",
    platform: "ai",
    platformName: "AI & LLM Services",
    category: "OpenAI",
    method: "POST",
    url: "https://api.openai.com/v1/chat/completions",
    description: "Generate structured response or conversational text using OpenAI GPT-4o.",
    docsUrl: "https://platform.openai.com/docs/api-reference/chat/create",
    headers: [
      { key: "Authorization", value: "Bearer {{OPENAI_API_KEY}}" },
      { key: "Content-Type", value: "application/json" },
    ],
    bodyType: "json",
    bodyValue: JSON.stringify(
      {
        model: "gpt-4o",
        messages: [
          { role: "system", content: "You are an expert developer assistant." },
          { role: "user", content: "Write an exemplary REST endpoint design guideline in 3 bullet points." },
        ],
        temperature: 0.7,
        max_tokens: 300,
      },
      null,
      2
    ),
    authType: "bearer",
    authConfig: { bearerToken: "{{OPENAI_API_KEY}}" },
    tags: ["openai", "gpt-4o", "ai", "llm", "chat"],
  },
  {
    id: "anthropic-claude-messages",
    name: "Anthropic Claude: Messages API (Claude 3.5 Sonnet)",
    platform: "ai",
    platformName: "AI & LLM Services",
    category: "Anthropic",
    method: "POST",
    url: "https://api.anthropic.com/v1/messages",
    description: "Send prompt messages to Anthropic's flagship Claude 3.5 Sonnet model.",
    docsUrl: "https://docs.anthropic.com/en/api/messages",
    headers: [
      { key: "x-api-key", value: "{{ANTHROPIC_API_KEY}}" },
      { key: "anthropic-version", value: "2023-06-01" },
      { key: "Content-Type", value: "application/json" },
    ],
    bodyType: "json",
    bodyValue: JSON.stringify(
      {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 512,
        messages: [
          { role: "user", content: "Give 2 key best practices when designing web API error responses." },
        ],
      },
      null,
      2
    ),
    authType: "api-key",
    authConfig: {
      apiKeyName: "x-api-key",
      apiKeyValue: "{{ANTHROPIC_API_KEY}}",
      apiKeyPlacement: "header",
    },
    tags: ["anthropic", "claude", "ai", "llm"],
  },
  {
    id: "openai-embeddings",
    name: "OpenAI: Create Embeddings",
    platform: "ai",
    platformName: "AI & LLM Services",
    category: "OpenAI",
    method: "POST",
    url: "https://api.openai.com/v1/embeddings",
    description: "Convert text strings into dense vector representations for search and RAG.",
    docsUrl: "https://platform.openai.com/docs/api-reference/embeddings/create",
    headers: [
      { key: "Authorization", value: "Bearer {{OPENAI_API_KEY}}" },
      { key: "Content-Type", value: "application/json" },
    ],
    bodyType: "json",
    bodyValue: JSON.stringify(
      {
        model: "text-embedding-3-small",
        input: "The quick brown fox jumps over the lazy dog",
      },
      null,
      2
    ),
    authType: "bearer",
    authConfig: { bearerToken: "{{OPENAI_API_KEY}}" },
    tags: ["openai", "embeddings", "vectors", "rag"],
  },

  // ─────────────────────────────────────────────────────────────
  // 6. DEVELOPER & SAAS PLATFORMS (GitHub, Stripe, Supabase)
  // ─────────────────────────────────────────────────────────────
  {
    id: "github-get-user",
    name: "GitHub API: Get Current Authenticated User",
    platform: "developer",
    platformName: "Developer & SaaS Tools",
    category: "GitHub",
    method: "GET",
    url: "https://api.github.com/user",
    description: "Retrieve profile, email, and subscription tier for the authenticated GitHub user.",
    docsUrl: "https://docs.github.com/en/rest/users/users#get-the-authenticated-user",
    headers: [
      { key: "Authorization", value: "Bearer {{GITHUB_TOKEN}}" },
      { key: "Accept", value: "application/vnd.github+json" },
      { key: "X-GitHub-Api-Version", value: "2022-11-28" },
    ],
    authType: "bearer",
    authConfig: { bearerToken: "{{GITHUB_TOKEN}}" },
    tags: ["github", "developer", "git", "user"],
  },
  {
    id: "github-list-repos",
    name: "GitHub API: List Repositories",
    platform: "developer",
    platformName: "Developer & SaaS Tools",
    category: "GitHub",
    method: "GET",
    url: "https://api.github.com/user/repos",
    description: "List public and private repositories accessible by the token.",
    docsUrl: "https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user",
    params: [
      { key: "sort", value: "updated" },
      { key: "per_page", value: "10" },
    ],
    headers: [
      { key: "Authorization", value: "Bearer {{GITHUB_TOKEN}}" },
      { key: "Accept", value: "application/vnd.github+json" },
    ],
    authType: "bearer",
    authConfig: { bearerToken: "{{GITHUB_TOKEN}}" },
    tags: ["github", "repos", "developer"],
  },
  {
    id: "github-create-issue",
    name: "GitHub API: Create an Issue",
    platform: "developer",
    platformName: "Developer & SaaS Tools",
    category: "GitHub",
    method: "POST",
    url: "https://api.github.com/repos/{{owner}}/{{repo}}/issues",
    description: "Create an issue in a repository with labels and assignees.",
    docsUrl: "https://docs.github.com/en/rest/issues/issues#create-an-issue",
    headers: [
      { key: "Authorization", value: "Bearer {{GITHUB_TOKEN}}" },
      { key: "Content-Type", value: "application/json" },
      { key: "Accept", value: "application/vnd.github+json" },
    ],
    bodyType: "json",
    bodyValue: JSON.stringify(
      {
        title: "Bug: Issue created via DevUtils API Tester",
        body: "Automated test issue created from DevUtils API Tester preset library.",
        labels: ["bug", "test"],
      },
      null,
      2
    ),
    authType: "bearer",
    authConfig: { bearerToken: "{{GITHUB_TOKEN}}" },
    tags: ["github", "issues", "developer"],
  },
  {
    id: "stripe-create-customer",
    name: "Stripe API: Create Customer",
    platform: "developer",
    platformName: "Developer & SaaS Tools",
    category: "Stripe",
    method: "POST",
    url: "https://api.stripe.com/v1/customers",
    description: "Create a customer profile in Stripe for billing and subscriptions.",
    docsUrl: "https://docs.stripe.com/api/customers/create",
    headers: [
      { key: "Authorization", value: "Bearer {{STRIPE_SECRET_KEY}}" },
      { key: "Content-Type", value: "application/x-www-form-urlencoded" },
    ],
    bodyType: "raw",
    rawType: "text/plain",
    bodyValue: "name=Jane+Doe&email=jane.doe%40example.com&description=Customer+created+from+DevUtils",
    authType: "bearer",
    authConfig: { bearerToken: "{{STRIPE_SECRET_KEY}}" },
    tags: ["stripe", "billing", "payments", "customers"],
  },
  {
    id: "supabase-query-table",
    name: "Supabase: Query Table REST API (PostgREST)",
    platform: "developer",
    platformName: "Developer & SaaS Tools",
    category: "Supabase",
    method: "GET",
    url: "{{SUPABASE_URL}}/rest/v1/{{table_name}}",
    description: "Query rows from a Supabase PostgreSQL table using PostgREST syntax.",
    docsUrl: "https://supabase.com/docs/guides/api",
    params: [
      { key: "select", value: "*" },
      { key: "limit", value: "10" },
    ],
    headers: [
      { key: "apikey", value: "{{SUPABASE_ANON_KEY}}" },
      { key: "Authorization", value: "Bearer {{SUPABASE_ANON_KEY}}" },
    ],
    authType: "bearer",
    authConfig: { bearerToken: "{{SUPABASE_ANON_KEY}}" },
    tags: ["supabase", "postgres", "database", "rest"],
  },

  // ─────────────────────────────────────────────────────────────
  // 7. MOCK & TESTING UTILITIES
  // ─────────────────────────────────────────────────────────────
  {
    id: "mock-postman-echo",
    name: "Postman Echo: Inspect Full Payload",
    platform: "mock",
    platformName: "Mock & Test Utilities",
    category: "Testing",
    method: "POST",
    url: "https://postman-echo.com/post",
    description: "Echo server returning sent headers, parameters, and request body.",
    docsUrl: "https://postman-echo.com",
    params: [
      { key: "environment", value: "production" },
      { key: "version", value: "2.0" },
    ],
    headers: [
      { key: "Content-Type", value: "application/json" },
      { key: "X-Client-Name", value: "DevUtils-API-Tester" },
    ],
    bodyType: "json",
    bodyValue: JSON.stringify(
      {
        test: true,
        message: "Hello Postman Echo!",
        timestamp: new Date().toISOString(),
      },
      null,
      2
    ),
    tags: ["mock", "echo", "testing"],
  },
  {
    id: "mock-jsonplaceholder-posts",
    name: "JSONPlaceholder: Filter Blog Posts",
    platform: "mock",
    platformName: "Mock & Test Utilities",
    category: "Testing",
    method: "GET",
    url: "https://jsonplaceholder.typicode.com/posts",
    description: "Public mock REST service providing sample posts, comments, and albums.",
    docsUrl: "https://jsonplaceholder.typicode.com",
    params: [
      { key: "userId", value: "1" },
    ],
    headers: [
      { key: "Accept", value: "application/json" },
    ],
    tags: ["mock", "jsonplaceholder", "posts", "testing"],
  },
  {
    id: "mock-reqres-auth",
    name: "ReqRes: Mock User Authentication",
    platform: "mock",
    platformName: "Mock & Test Utilities",
    category: "Testing",
    method: "POST",
    url: "https://reqres.in/api/login",
    description: "Simulate successful or failed login attempts and token responses.",
    docsUrl: "https://reqres.in",
    headers: [
      { key: "Content-Type", value: "application/json" },
    ],
    bodyType: "json",
    bodyValue: JSON.stringify(
      {
        email: "eve.holt@reqres.in",
        password: "cityslicka",
      },
      null,
      2
    ),
    tags: ["mock", "reqres", "login", "auth"],
  },
  {
    id: "mock-coingecko-prices",
    name: "CoinGecko: Crypto Currency Prices",
    platform: "mock",
    platformName: "Mock & Test Utilities",
    category: "Public APIs",
    method: "GET",
    url: "https://api.coingecko.com/api/v3/simple/price",
    description: "Real-time cryptocurrency price indices in USD, EUR, and GBP.",
    docsUrl: "https://www.coingecko.com/en/api",
    params: [
      { key: "ids", value: "bitcoin,ethereum,solana" },
      { key: "vs_currencies", value: "usd" },
    ],
    headers: [
      { key: "Accept", value: "application/json" },
    ],
    tags: ["crypto", "coingecko", "prices", "finance"],
  },
];
