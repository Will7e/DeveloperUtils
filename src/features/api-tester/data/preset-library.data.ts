// ============================================================
// API Tester — Enterprise & Popular Platform Preset Library
// ============================================================

import type { HttpMethod, BodyType, AuthType, AuthConfig } from "@/stores/api-tester.store";

export type PlatformId =
  | "all"
  | "servicenow"
  | "entra"
  | "azure"
  | "google"
  | "aws"
  | "ai"
  | "developer"
  | "mock"
  | "custom";

export interface PresetSampleResponse {
  status: number;
  statusText: string;
  headers?: Record<string, string>;
  body: string;
}

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
  sampleResponse?: PresetSampleResponse;
  requiredScopes?: string[];
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
    id: "servicenow",
    name: "ServiceNow REST APIs",
    shortName: "ServiceNow",
    description: "Now Platform Table API, Attachment API, Import Set API, Service Catalog, and OAuth 2.0.",
    docsUrl: "https://developer.servicenow.com/dev.do#!/reference/api/latest/rest",
    brandColor: "#81b5a1",
    badgeBg: "rgba(129, 181, 161, 0.15)",
    envVariables: [
      { key: "sn_instance", defaultValue: "dev12345.service-now.com", description: "ServiceNow instance hostname (e.g. dev12345.service-now.com)" },
      { key: "sn_username", defaultValue: "admin", description: "ServiceNow basic auth username or integration service account" },
      { key: "sn_password", defaultValue: "", description: "ServiceNow user password" },
      { key: "sn_token", defaultValue: "", description: "ServiceNow OAuth 2.0 Bearer access token" },
    ],
  },
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
  // 0. SERVICENOW REST APIS (Table API, Attachments, Import Sets, OAuth)
  // ─────────────────────────────────────────────────────────────
  {
    id: "sn-table-query-incidents",
    name: "ServiceNow: Table API — Query Incidents",
    platform: "servicenow",
    platformName: "ServiceNow REST APIs",
    category: "Table API",
    method: "GET",
    url: "https://{{sn_instance}}/api/now/table/incident",
    description: "Retrieve incident records with query filters, encoded conditions, field selection, and pagination limits.",
    docsUrl: "https://developer.servicenow.com/dev.do#!/reference/api/latest/rest/c_TableAPI#table-GET",
    params: [
      { key: "sysparm_limit", value: "10", description: "Maximum number of records to return" },
      { key: "sysparm_query", value: "active=true^priority<=2", description: "Encoded query string" },
      { key: "sysparm_fields", value: "number,short_description,priority,state,caller_id,sys_created_on", description: "Comma-separated field list" },
      { key: "sysparm_display_value", value: "false", description: "Return display values or raw database values" },
    ],
    headers: [
      { key: "Accept", value: "application/json" },
    ],
    authType: "basic",
    authConfig: {
      basicUsername: "{{sn_username}}",
      basicPassword: "{{sn_password}}",
    },
    envVariables: [
      { key: "sn_instance", defaultValue: "dev12345.service-now.com", description: "ServiceNow instance hostname" },
      { key: "sn_username", defaultValue: "admin", description: "ServiceNow admin or integration username" },
      { key: "sn_password", defaultValue: "", description: "ServiceNow user password" },
    ],
    tags: ["servicenow", "table-api", "incident", "query", "itsm"],
    requiredScopes: ["itil", "rest_service", "snc_read_only"],
    sampleResponse: {
      status: 200,
      statusText: "OK",
      headers: {
        "content-type": "application/json;charset=UTF-8",
        "x-total-count": "14",
      },
      body: JSON.stringify(
        {
          result: [
            {
              number: "INC0010001",
              short_description: "Network connectivity degraded in datacenter rack 4",
              priority: "1",
              state: "2",
              caller_id: {
                link: "https://dev12345.service-now.com/api/now/table/sys_user/6816f79cc0a8016401c5a33be04be441",
                value: "6816f79cc0a8016401c5a33be04be441",
              },
              sys_created_on: "2026-04-10 08:30:14",
            },
            {
              number: "INC0010002",
              short_description: "Core database latency spike during batch ETL job",
              priority: "2",
              state: "1",
              caller_id: {
                link: "https://dev12345.service-now.com/api/now/table/sys_user/5137153cc611227c000bbd1bd8cd2005",
                value: "5137153cc611227c000bbd1bd8cd2005",
              },
              sys_created_on: "2026-04-10 09:12:45",
            },
          ],
        },
        null,
        2
      ),
    },
  },
  {
    id: "sn-table-get-incident",
    name: "ServiceNow: Table API — Retrieve Single Record",
    platform: "servicenow",
    platformName: "ServiceNow REST APIs",
    category: "Table API",
    method: "GET",
    url: "https://{{sn_instance}}/api/now/table/incident/{{sys_id}}",
    description: "Fetch all field values for a specific record by its unique sys_id.",
    docsUrl: "https://developer.servicenow.com/dev.do#!/reference/api/latest/rest/c_TableAPI#table-GET-id",
    params: [
      { key: "sysparm_display_value", value: "true", description: "Return human-readable display values" },
      { key: "sysparm_exclude_reference_link", value: "false", description: "Include hyperlinks to referenced records" },
    ],
    headers: [
      { key: "Accept", value: "application/json" },
    ],
    authType: "basic",
    authConfig: {
      basicUsername: "{{sn_username}}",
      basicPassword: "{{sn_password}}",
    },
    envVariables: [
      { key: "sn_instance", defaultValue: "dev12345.service-now.com", description: "ServiceNow instance hostname" },
      { key: "sys_id", defaultValue: "9d385017c611228701d22104cc95c371", description: "Record sys_id (32-character GUID)" },
      { key: "sn_username", defaultValue: "admin", description: "ServiceNow username" },
      { key: "sn_password", defaultValue: "", description: "ServiceNow password" },
    ],
    tags: ["servicenow", "table-api", "sys_id", "get-record"],
    requiredScopes: ["itil", "rest_service"],
    sampleResponse: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json;charset=UTF-8" },
      body: JSON.stringify(
        {
          result: {
            sys_id: "9d385017c611228701d22104cc95c371",
            number: "INC0010001",
            short_description: "Network connectivity degraded in datacenter rack 4",
            description: "Interface bond0 flapping on router core-sw01.",
            priority: "1 - Critical",
            urgency: "1 - High",
            impact: "1 - High",
            state: "In Progress",
            assignment_group: {
              display_value: "Network Engineering",
              link: "https://dev12345.service-now.com/api/now/table/sys_user_group/287ebd7da9fe199200f92c33a34d6041",
            },
            assigned_to: {
              display_value: "Beth Anglin",
              link: "https://dev12345.service-now.com/api/now/table/sys_user/46d44a23a9fe1992015f2661e4ced929",
            },
          },
        },
        null,
        2
      ),
    },
  },
  {
    id: "sn-table-create-incident",
    name: "ServiceNow: Table API — Create Incident",
    platform: "servicenow",
    platformName: "ServiceNow REST APIs",
    category: "Table API",
    method: "POST",
    url: "https://{{sn_instance}}/api/now/table/incident",
    description: "Create a new record in the incident table with field values provided in JSON body.",
    docsUrl: "https://developer.servicenow.com/dev.do#!/reference/api/latest/rest/c_TableAPI#table-POST",
    headers: [
      { key: "Content-Type", value: "application/json" },
      { key: "Accept", value: "application/json" },
    ],
    bodyType: "json",
    bodyValue: JSON.stringify(
      {
        short_description: "Email routing delay to external domains",
        description: "Outgoing messages to third-party domains experiencing up to 15m delay.",
        urgency: "2",
        impact: "2",
        category: "Software",
        contact_type: "API",
        comments: "Created automatically via InTab API Tester integration.",
      },
      null,
      2
    ),
    authType: "basic",
    authConfig: {
      basicUsername: "{{sn_username}}",
      basicPassword: "{{sn_password}}",
    },
    envVariables: [
      { key: "sn_instance", defaultValue: "dev12345.service-now.com", description: "ServiceNow instance hostname" },
      { key: "sn_username", defaultValue: "admin", description: "ServiceNow username" },
      { key: "sn_password", defaultValue: "", description: "ServiceNow password" },
    ],
    tags: ["servicenow", "table-api", "incident", "create", "post"],
    requiredScopes: ["itil", "rest_service"],
    sampleResponse: {
      status: 201,
      statusText: "Created",
      headers: {
        "content-type": "application/json;charset=UTF-8",
        "location": "https://dev12345.service-now.com/api/now/table/incident/a9385017c611228701d22104cc95c998",
      },
      body: JSON.stringify(
        {
          result: {
            sys_id: "a9385017c611228701d22104cc95c998",
            number: "INC0010045",
            short_description: "Email routing delay to external domains",
            state: "1",
            urgency: "2",
            impact: "2",
            priority: "3",
            sys_created_on: "2026-09-18 13:40:02",
          },
        },
        null,
        2
      ),
    },
  },
  {
    id: "sn-table-update-incident",
    name: "ServiceNow: Table API — Update Record (PATCH)",
    platform: "servicenow",
    platformName: "ServiceNow REST APIs",
    category: "Table API",
    method: "PATCH",
    url: "https://{{sn_instance}}/api/now/table/incident/{{sys_id}}",
    description: "Partially update specific fields on an existing record without overwriting other attributes.",
    docsUrl: "https://developer.servicenow.com/dev.do#!/reference/api/latest/rest/c_TableAPI#table-PATCH",
    headers: [
      { key: "Content-Type", value: "application/json" },
      { key: "Accept", value: "application/json" },
    ],
    bodyType: "json",
    bodyValue: JSON.stringify(
      {
        state: "2",
        work_notes: "Root cause identified: queue backpressure on MX relay. Restarting postfix worker.",
        assigned_to: "{{user_sys_id}}",
      },
      null,
      2
    ),
    authType: "basic",
    authConfig: {
      basicUsername: "{{sn_username}}",
      basicPassword: "{{sn_password}}",
    },
    envVariables: [
      { key: "sn_instance", defaultValue: "dev12345.service-now.com", description: "ServiceNow instance hostname" },
      { key: "sys_id", defaultValue: "a9385017c611228701d22104cc95c998", description: "Target Incident sys_id" },
      { key: "sn_username", defaultValue: "admin", description: "ServiceNow username" },
      { key: "sn_password", defaultValue: "", description: "ServiceNow password" },
    ],
    tags: ["servicenow", "table-api", "patch", "update", "incident"],
    requiredScopes: ["itil", "rest_service"],
    sampleResponse: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json;charset=UTF-8" },
      body: JSON.stringify(
        {
          result: {
            sys_id: "a9385017c611228701d22104cc95c998",
            number: "INC0010045",
            state: "2",
            sys_updated_on: "2026-09-18 13:45:10",
          },
        },
        null,
        2
      ),
    },
  },
  {
    id: "sn-table-delete-incident",
    name: "ServiceNow: Table API — Delete Record",
    platform: "servicenow",
    platformName: "ServiceNow REST APIs",
    category: "Table API",
    method: "DELETE",
    url: "https://{{sn_instance}}/api/now/table/incident/{{sys_id}}",
    description: "Delete an existing record permanently by its table name and sys_id.",
    docsUrl: "https://developer.servicenow.com/dev.do#!/reference/api/latest/rest/c_TableAPI#table-DELETE",
    headers: [
      { key: "Accept", value: "application/json" },
    ],
    authType: "basic",
    authConfig: {
      basicUsername: "{{sn_username}}",
      basicPassword: "{{sn_password}}",
    },
    envVariables: [
      { key: "sn_instance", defaultValue: "dev12345.service-now.com", description: "ServiceNow instance hostname" },
      { key: "sys_id", defaultValue: "a9385017c611228701d22104cc95c998", description: "Target Record sys_id to delete" },
      { key: "sn_username", defaultValue: "admin", description: "ServiceNow username" },
      { key: "sn_password", defaultValue: "", description: "ServiceNow password" },
    ],
    tags: ["servicenow", "table-api", "delete"],
    requiredScopes: ["admin", "itil_admin"],
    sampleResponse: {
      status: 204,
      statusText: "No Content",
      headers: {},
      body: "",
    },
  },
  {
    id: "sn-attachment-list",
    name: "ServiceNow: Attachment API — List Attachments",
    platform: "servicenow",
    platformName: "ServiceNow REST APIs",
    category: "Attachment API",
    method: "GET",
    url: "https://{{sn_instance}}/api/now/attachment",
    description: "Query metadata of attachments associated with records, filtered by table name or table sys_id.",
    docsUrl: "https://developer.servicenow.com/dev.do#!/reference/api/latest/rest/c_AttachmentAPI#attachment-GET",
    params: [
      { key: "sysparm_query", value: "table_name=incident^table_sys_id={{sys_id}}", description: "Filter attachments by parent table and record" },
      { key: "sysparm_limit", value: "10", description: "Limit number of results" },
    ],
    headers: [
      { key: "Accept", value: "application/json" },
    ],
    authType: "basic",
    authConfig: {
      basicUsername: "{{sn_username}}",
      basicPassword: "{{sn_password}}",
    },
    envVariables: [
      { key: "sn_instance", defaultValue: "dev12345.service-now.com", description: "ServiceNow instance hostname" },
      { key: "sys_id", defaultValue: "9d385017c611228701d22104cc95c371", description: "Parent record sys_id" },
      { key: "sn_username", defaultValue: "admin", description: "ServiceNow username" },
      { key: "sn_password", defaultValue: "", description: "ServiceNow password" },
    ],
    tags: ["servicenow", "attachment", "files", "sys_attachment"],
    requiredScopes: ["rest_service"],
    sampleResponse: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json;charset=UTF-8" },
      body: JSON.stringify(
        {
          result: [
            {
              sys_id: "3487c600c0a80164010874c76b50e32f",
              file_name: "network_trace.pcap",
              content_type: "application/vnd.tcpdump.pcap",
              size_bytes: "1048576",
              table_name: "incident",
              table_sys_id: "9d385017c611228701d22104cc95c371",
              download_link: "https://dev12345.service-now.com/api/now/attachment/3487c600c0a80164010874c76b50e32f/file",
            },
          ],
        },
        null,
        2
      ),
    },
  },
  {
    id: "sn-attachment-upload",
    name: "ServiceNow: Attachment API — Upload File",
    platform: "servicenow",
    platformName: "ServiceNow REST APIs",
    category: "Attachment API",
    method: "POST",
    url: "https://{{sn_instance}}/api/now/attachment/file",
    description: "Upload a binary or text file directly to attach it to a specific record.",
    docsUrl: "https://developer.servicenow.com/dev.do#!/reference/api/latest/rest/c_AttachmentAPI#attachment-POST-file",
    params: [
      { key: "table_name", value: "incident", description: "Target ServiceNow table" },
      { key: "table_sys_id", value: "{{sys_id}}", description: "Target record sys_id" },
      { key: "file_name", value: "investigation_notes.txt", description: "Name of the file to store" },
    ],
    headers: [
      { key: "Content-Type", value: "text/plain" },
      { key: "Accept", value: "application/json" },
    ],
    bodyType: "raw",
    rawType: "text/plain",
    bodyValue: "System diagnostics logged on 2026-09-18T15:30:00Z\nStatus: OK\nCPU: 18%\nMemory: 41%",
    authType: "basic",
    authConfig: {
      basicUsername: "{{sn_username}}",
      basicPassword: "{{sn_password}}",
    },
    envVariables: [
      { key: "sn_instance", defaultValue: "dev12345.service-now.com", description: "ServiceNow instance hostname" },
      { key: "sys_id", defaultValue: "9d385017c611228701d22104cc95c371", description: "Target record sys_id" },
      { key: "sn_username", defaultValue: "admin", description: "ServiceNow username" },
      { key: "sn_password", defaultValue: "", description: "ServiceNow password" },
    ],
    tags: ["servicenow", "attachment", "upload", "binary"],
    requiredScopes: ["itil", "rest_service"],
    sampleResponse: {
      status: 201,
      statusText: "Created",
      headers: { "content-type": "application/json;charset=UTF-8" },
      body: JSON.stringify(
        {
          result: {
            sys_id: "84729104c611228701d22104cc95c102",
            file_name: "investigation_notes.txt",
            content_type: "text/plain",
            size_bytes: "92",
            table_name: "incident",
            table_sys_id: "9d385017c611228701d22104cc95c371",
          },
        },
        null,
        2
      ),
    },
  },
  {
    id: "sn-import-set-insert",
    name: "ServiceNow: Import Set API — Insert Staging Record",
    platform: "servicenow",
    platformName: "ServiceNow REST APIs",
    category: "Import Set API",
    method: "POST",
    url: "https://{{sn_instance}}/api/now/import/{{staging_table}}",
    description: "Post inbound data into an Import Set staging table to trigger synchronous Transform Map execution.",
    docsUrl: "https://developer.servicenow.com/dev.do#!/reference/api/latest/rest/c_ImportSetAPI#import-POST",
    headers: [
      { key: "Content-Type", value: "application/json" },
      { key: "Accept", value: "application/json" },
    ],
    bodyType: "json",
    bodyValue: JSON.stringify(
      {
        u_asset_tag: "P100-9842",
        u_serial_number: "SN-9842-X7",
        u_model_name: "MacBook Pro 16",
        u_assigned_email: "jane.doe@company.com",
        u_location: "Building 4, Floor 2",
      },
      null,
      2
    ),
    authType: "basic",
    authConfig: {
      basicUsername: "{{sn_username}}",
      basicPassword: "{{sn_password}}",
    },
    envVariables: [
      { key: "sn_instance", defaultValue: "dev12345.service-now.com", description: "ServiceNow instance hostname" },
      { key: "staging_table", defaultValue: "u_asset_inbound_staging", description: "Custom Import Set staging table name" },
      { key: "sn_username", defaultValue: "admin", description: "ServiceNow username" },
      { key: "sn_password", defaultValue: "", description: "ServiceNow password" },
    ],
    tags: ["servicenow", "import-set", "integration", "transform-map", "etl"],
    requiredScopes: ["import_set_loader", "rest_service"],
    sampleResponse: {
      status: 201,
      statusText: "Created",
      headers: { "content-type": "application/json;charset=UTF-8" },
      body: JSON.stringify(
        {
          result: [
            {
              import_set: "ISET0010042",
              staging_table: "u_asset_inbound_staging",
              result: "inserted",
              target_table: "alm_hardware",
              target_sys_id: "c9482017c611228701d22104cc95c553",
            },
          ],
        },
        null,
        2
      ),
    },
  },
  {
    id: "sn-catalog-list-items",
    name: "ServiceNow: Service Catalog API — List Items",
    platform: "servicenow",
    platformName: "ServiceNow REST APIs",
    category: "Service Catalog",
    method: "GET",
    url: "https://{{sn_instance}}/api/sn_sc/v1/servicecatalog/items",
    description: "Browse orderable catalog items with categories, pricing, and availability.",
    docsUrl: "https://developer.servicenow.com/dev.do#!/reference/api/latest/rest/c_ServiceCatalogAPI#sc-GET-items",
    params: [
      { key: "sysparm_limit", value: "10", description: "Max items to return" },
      { key: "sysparm_view", value: "desktop", description: "Catalog presentation view" },
    ],
    headers: [
      { key: "Accept", value: "application/json" },
    ],
    authType: "basic",
    authConfig: {
      basicUsername: "{{sn_username}}",
      basicPassword: "{{sn_password}}",
    },
    envVariables: [
      { key: "sn_instance", defaultValue: "dev12345.service-now.com", description: "ServiceNow instance hostname" },
      { key: "sn_username", defaultValue: "admin", description: "ServiceNow username" },
      { key: "sn_password", defaultValue: "", description: "ServiceNow password" },
    ],
    tags: ["servicenow", "service-catalog", "request", "ritm"],
    requiredScopes: ["snc_read_only", "rest_service"],
    sampleResponse: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json;charset=UTF-8" },
      body: JSON.stringify(
        {
          result: [
            {
              sys_id: "04b7e94b4f014200086eeed18110c7fd",
              name: "Standard Laptop",
              short_description: "14-inch developer ultrabook with 32GB RAM",
              price: "$1,450.00",
              category: "Hardware",
            },
            {
              sys_id: "e46305bdc0a8010a00645e60c6e127cc",
              name: "VPN Access Request",
              short_description: "Remote corporate network access request",
              price: "$0.00",
              category: "Security",
            },
          ],
        },
        null,
        2
      ),
    },
  },
  {
    id: "sn-oauth-token-password",
    name: "ServiceNow: OAuth 2.0 — Resource Owner Password Token",
    platform: "servicenow",
    platformName: "ServiceNow REST APIs",
    category: "Authentication",
    method: "POST",
    url: "https://{{sn_instance}}/oauth_token.do",
    description: "Request an OAuth 2.0 Bearer access token using username and password credentials.",
    docsUrl: "https://docs.servicenow.com/bundle/washingtondc-platform-security/page/administer/security/concept/c_OAuthApplications.html",
    headers: [
      { key: "Content-Type", value: "application/x-www-form-urlencoded" },
      { key: "Accept", value: "application/json" },
    ],
    bodyType: "raw",
    rawType: "text/plain",
    bodyValue: "grant_type=password&client_id={{client_id}}&client_secret={{client_secret}}&username={{sn_username}}&password={{sn_password}}",
    authType: "none",
    envVariables: [
      { key: "sn_instance", defaultValue: "dev12345.service-now.com", description: "ServiceNow instance hostname" },
      { key: "client_id", defaultValue: "", description: "OAuth Client ID from Application Registries" },
      { key: "client_secret", defaultValue: "", description: "OAuth Client Secret" },
      { key: "sn_username", defaultValue: "admin", description: "ServiceNow user account" },
      { key: "sn_password", defaultValue: "", description: "ServiceNow user password" },
    ],
    tags: ["servicenow", "oauth2", "auth", "token"],
    sampleResponse: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json;charset=UTF-8" },
      body: JSON.stringify(
        {
          access_token: "sn_token_718293a9d82138947b91c890123ef8",
          token_type: "Bearer",
          expires_in: 1800,
          refresh_token: "sn_refresh_a91283c748291038472910",
          scope: "useraccount",
        },
        null,
        2
      ),
    },
  },

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
          subject: "Test Message from InTab API Tester",
          body: {
            contentType: "HTML",
            content: "<h3>Hello from InTab!</h3><p>This message was sent using Microsoft Graph API.</p>",
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
  // 5. AI & LLM PLATFORMS (OpenAI, Claude, Gemini, DeepSeek, Groq, Ollama)
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
    requiredScopes: ["api.openai.com/v1"],
    sampleResponse: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        {
          id: "chatcmpl-9pQ2A910",
          object: "chat.completion",
          created: 1718290000,
          model: "gpt-4o-2024-05-13",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "1. Use nouns and plural resources (e.g. /api/v1/incidents).\n2. Adhere strictly to HTTP status semantics (200, 201, 400, 401, 404, 500).\n3. Standardize structured error payloads with descriptive machine-readable error codes.",
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 28, completion_tokens: 58, total_tokens: 86 },
        },
        null,
        2
      ),
    },
  },
  {
    id: "deepseek-chat-completions",
    name: "DeepSeek: Chat & Reasoning (DeepSeek-V3 / R1)",
    platform: "ai",
    platformName: "AI & LLM Services",
    category: "DeepSeek",
    method: "POST",
    url: "https://api.deepseek.com/chat/completions",
    description: "High-performance inference and reasoning using DeepSeek-V3 or DeepSeek-R1 models via OpenAI-compatible REST API.",
    docsUrl: "https://api-docs.deepseek.com/",
    headers: [
      { key: "Authorization", value: "Bearer {{DEEPSEEK_API_KEY}}" },
      { key: "Content-Type", value: "application/json" },
    ],
    bodyType: "json",
    bodyValue: JSON.stringify(
      {
        model: "deepseek-chat",
        messages: [
          { role: "system", content: "You are a senior software architect." },
          { role: "user", content: "Explain idempotency in REST API design with 2 practical rules." },
        ],
        temperature: 0.6,
        stream: false,
      },
      null,
      2
    ),
    authType: "bearer",
    authConfig: { bearerToken: "{{DEEPSEEK_API_KEY}}" },
    envVariables: [
      { key: "DEEPSEEK_API_KEY", defaultValue: "", description: "DeepSeek API key (sk-...)" },
    ],
    tags: ["deepseek", "deepseek-v3", "deepseek-r1", "ai", "reasoning"],
    requiredScopes: ["api.deepseek.com"],
    sampleResponse: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        {
          id: "dsk-99218204",
          object: "chat.completion",
          created: 1718291000,
          model: "deepseek-chat",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "1. GET, PUT, and DELETE operations must result in the same server state regardless of multiple executions.\n2. Non-idempotent POST requests should accept an 'Idempotency-Key' header to safely deduplicate retries on network failures.",
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 31, completion_tokens: 52, total_tokens: 83 },
        },
        null,
        2
      ),
    },
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
    requiredScopes: ["anthropic.messages"],
    sampleResponse: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        {
          id: "msg_013Zva2nf3gH77Dja39",
          type: "message",
          role: "assistant",
          model: "claude-3-5-sonnet-20241022",
          content: [
            {
              type: "text",
              text: "1. Return uniform RFC 7807 (Problem Details for HTTP APIs) JSON bodies with 'type', 'title', 'status', and 'detail'.\n2. Include unique request trace identifiers (e.g. 'correlation_id') to speed up debugging in production logs.",
            },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 22, output_tokens: 61 },
        },
        null,
        2
      ),
    },
  },
  {
    id: "anthropic-tool-use",
    name: "Anthropic Claude: Tool Use / Function Calling",
    platform: "ai",
    platformName: "AI & LLM Services",
    category: "Anthropic",
    method: "POST",
    url: "https://api.anthropic.com/v1/messages",
    description: "Provide JSON Schema tools to Claude 3.5 Sonnet so it can decide which function to call and return structured parameters.",
    docsUrl: "https://docs.anthropic.com/en/docs/build-with-claude/tool-use",
    headers: [
      { key: "x-api-key", value: "{{ANTHROPIC_API_KEY}}" },
      { key: "anthropic-version", value: "2023-06-01" },
      { key: "Content-Type", value: "application/json" },
    ],
    bodyType: "json",
    bodyValue: JSON.stringify(
      {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        tools: [
          {
            name: "get_weather",
            description: "Get the current weather for a given city and units.",
            input_schema: {
              type: "object",
              properties: {
                location: { type: "string", description: "The city and state, e.g. San Francisco, CA" },
                unit: { type: "string", enum: ["celsius", "fahrenheit"] },
              },
              required: ["location"],
            },
          },
        ],
        messages: [
          { role: "user", content: "What is the current weather in Zurich, Switzerland in Celsius?" },
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
    tags: ["anthropic", "claude", "tool-use", "function-calling"],
    sampleResponse: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        {
          id: "msg_017bKa4df1gL99Eja12",
          type: "message",
          role: "assistant",
          model: "claude-3-5-sonnet-20241022",
          content: [
            {
              type: "tool_use",
              id: "toolu_01A09q90tc1jq8djw0jk",
              name: "get_weather",
              input: { location: "Zurich, Switzerland", unit: "celsius" },
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 382, output_tokens: 41 },
        },
        null,
        2
      ),
    },
  },
  {
    id: "google-gemini-3-6-flash",
    name: "Google Gemini: Generate Content (Gemini 3.6 Flash)",
    platform: "ai",
    platformName: "AI & LLM Services",
    category: "Google Gemini",
    method: "POST",
    url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key={{gemini_api_key}}",
    description: "Generate multimodal content using Google's recommended high-speed Gemini 3.6 Flash model.",
    docsUrl: "https://ai.google.dev/gemini-api/docs/quickstart",
    headers: [
      { key: "Content-Type", value: "application/json" },
    ],
    bodyType: "json",
    bodyValue: JSON.stringify(
      {
        contents: [
          {
            parts: [
              { text: "Provide a JSON schema for an enterprise User profile record." },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 500,
        },
      },
      null,
      2
    ),
    authType: "none",
    envVariables: [
      { key: "gemini_api_key", defaultValue: "", description: "Google AI Studio API Key" },
    ],
    tags: ["gemini", "gemini-3.6", "google", "ai", "llm"],
    sampleResponse: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        {
          candidates: [
            {
              content: {
                parts: [
                  { text: "{\n  \"$schema\": \"http://json-schema.org/draft-07/schema#\",\n  \"type\": \"object\",\n  \"properties\": {\n    \"userId\": { \"type\": \"string\" },\n    \"email\": { \"type\": \"string\", \"format\": \"email\" },\n    \"role\": { \"type\": \"string\", \"enum\": [\"admin\", \"developer\", \"viewer\"] }\n  },\n  \"required\": [\"userId\", \"email\"]\n}" },
                ],
                role: "model",
              },
              finishReason: "STOP",
            },
          ],
        },
        null,
        2
      ),
    },
  },
  {
    id: "groq-chat-completions",
    name: "Groq: Ultra-Fast Inference (Llama 3.3 70B)",
    platform: "ai",
    platformName: "AI & LLM Services",
    category: "Groq",
    method: "POST",
    url: "https://api.groq.com/openai/v1/chat/completions",
    description: "Sub-second, ultra-fast language model inference powered by Groq LPU technology.",
    docsUrl: "https://console.groq.com/docs/quickstart",
    headers: [
      { key: "Authorization", value: "Bearer {{GROQ_API_KEY}}" },
      { key: "Content-Type", value: "application/json" },
    ],
    bodyType: "json",
    bodyValue: JSON.stringify(
      {
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "user", content: "Give 3 advantages of HTTP/2 over HTTP/1.1." },
        ],
        temperature: 0.5,
      },
      null,
      2
    ),
    authType: "bearer",
    authConfig: { bearerToken: "{{GROQ_API_KEY}}" },
    envVariables: [
      { key: "GROQ_API_KEY", defaultValue: "", description: "Groq Cloud API Key (gsk_...)" },
    ],
    tags: ["groq", "llama-3.3", "fast-inference", "ai"],
    sampleResponse: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        {
          id: "chatcmpl-grq88210",
          object: "chat.completion",
          created: 1718292000,
          model: "llama-3.3-70b-versatile",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "1. Request/Response Multiplexing over a single TCP connection.\n2. Header Compression using HPACK.\n3. Binary framing protocol instead of textual parsing.",
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 24, completion_tokens: 46, total_tokens: 70 },
        },
        null,
        2
      ),
    },
  },
  {
    id: "ollama-local-chat",
    name: "Ollama: Local LLM Chat (Localhost)",
    platform: "ai",
    platformName: "AI & LLM Services",
    category: "Ollama (Local)",
    method: "POST",
    url: "http://localhost:11434/api/chat",
    description: "Query models running completely locally and offline on your machine via Ollama.",
    docsUrl: "https://github.com/ollama/ollama/blob/main/docs/api.md#generate-a-chat-completion",
    headers: [
      { key: "Content-Type", value: "application/json" },
    ],
    bodyType: "json",
    bodyValue: JSON.stringify(
      {
        model: "llama3.2",
        messages: [
          { role: "user", content: "Say hello from offline local machine!" },
        ],
        stream: false,
      },
      null,
      2
    ),
    authType: "none",
    tags: ["ollama", "local", "offline", "llama3", "privacy"],
    sampleResponse: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(
        {
          model: "llama3.2",
          created_at: "2026-09-18T13:40:00.123Z",
          message: {
            role: "assistant",
            content: "Hello from your local Ollama instance! Your data stayed completely on-device.",
          },
          done: true,
          total_duration: 382000000,
        },
        null,
        2
      ),
    },
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
    sampleResponse: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        {
          object: "list",
          data: [
            {
              object: "embedding",
              index: 0,
              embedding: [-0.0069, -0.0053, 0.0102, -0.024],
            },
          ],
          model: "text-embedding-3-small",
          usage: { prompt_tokens: 9, total_tokens: 9 },
        },
        null,
        2
      ),
    },
  },

  // ─────────────────────────────────────────────────────────────
  // 6. DEVELOPER & SAAS PLATFORMS (GitHub, Stripe, Supabase, Slack, Jira)
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
    requiredScopes: ["read:user", "user:email"],
    sampleResponse: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(
        {
          login: "octocat",
          id: 583231,
          avatar_url: "https://avatars.githubusercontent.com/u/583231?v=4",
          html_url: "https://github.com/octocat",
          name: "The Octocat",
          company: "@github",
          public_repos: 8,
          total_private_repos: 12,
        },
        null,
        2
      ),
    },
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
    requiredScopes: ["repo"],
    sampleResponse: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(
        [
          {
            id: 1296269,
            name: "InTab",
            full_name: "octocat/InTab",
            private: false,
            html_url: "https://github.com/octocat/InTab",
            stargazers_count: 328,
            language: "TypeScript",
          },
        ],
        null,
        2
      ),
    },
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
        title: "Bug: Issue created via InTab API Tester",
        body: "Automated test issue created from InTab API Tester preset library.",
        labels: ["bug", "test"],
      },
      null,
      2
    ),
    authType: "bearer",
    authConfig: { bearerToken: "{{GITHUB_TOKEN}}" },
    tags: ["github", "issues", "developer"],
    requiredScopes: ["repo"],
    sampleResponse: {
      status: 201,
      statusText: "Created",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(
        {
          id: 2019482910,
          number: 142,
          title: "Bug: Issue created via InTab API Tester",
          state: "open",
          created_at: "2026-09-18T13:42:00Z",
          html_url: "https://github.com/octocat/InTab/issues/142",
        },
        null,
        2
      ),
    },
  },
  {
    id: "github-workflow-dispatch",
    name: "GitHub API: Trigger Workflow Dispatch",
    platform: "developer",
    platformName: "Developer & SaaS Tools",
    category: "GitHub",
    method: "POST",
    url: "https://api.github.com/repos/{{owner}}/{{repo}}/actions/workflows/{{workflow_id}}/dispatches",
    description: "Manually trigger a GitHub Actions workflow run with input parameters.",
    docsUrl: "https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event",
    headers: [
      { key: "Authorization", value: "Bearer {{GITHUB_TOKEN}}" },
      { key: "Accept", value: "application/vnd.github+json" },
      { key: "Content-Type", value: "application/json" },
    ],
    bodyType: "json",
    bodyValue: JSON.stringify(
      {
        ref: "main",
        inputs: {
          environment: "staging",
          run_tests: "true",
        },
      },
      null,
      2
    ),
    authType: "bearer",
    authConfig: { bearerToken: "{{GITHUB_TOKEN}}" },
    tags: ["github", "actions", "ci-cd", "workflow"],
    requiredScopes: ["workflow", "repo"],
    sampleResponse: {
      status: 204,
      statusText: "No Content",
      headers: {},
      body: "",
    },
  },
  {
    id: "slack-incoming-webhook",
    name: "Slack: Send Incoming Webhook (Block Kit)",
    platform: "developer",
    platformName: "Developer & SaaS Tools",
    category: "Slack",
    method: "POST",
    url: "https://hooks.slack.com/services/{{webhook_token}}",
    description: "Publish formatted messages and interactive card alerts into a Slack channel using Incoming Webhooks.",
    docsUrl: "https://api.slack.com/messaging/webhooks",
    headers: [
      { key: "Content-Type", value: "application/json" },
    ],
    bodyType: "json",
    bodyValue: JSON.stringify(
      {
        text: "🚨 Deployment Notification from InTab",
        blocks: [
          {
            type: "header",
            text: { type: "plain_text", text: "Production Release Complete", emoji: true },
          },
          {
            type: "section",
            fields: [
              { type: "mrkdwn", text: "*Service:*\nCore API Gateway" },
              { type: "mrkdwn", text: "*Status:*\n:white_check_mark: Healthy" },
            ],
          },
        ],
      },
      null,
      2
    ),
    authType: "none",
    tags: ["slack", "webhook", "chat", "notifications"],
    sampleResponse: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/html" },
      body: "ok",
    },
  },
  {
    id: "slack-post-message",
    name: "Slack: Web API — chat.postMessage",
    platform: "developer",
    platformName: "Developer & SaaS Tools",
    category: "Slack",
    method: "POST",
    url: "https://slack.com/api/chat.postMessage",
    description: "Send message payloads to public or private Slack channels using bot user tokens.",
    docsUrl: "https://api.slack.com/methods/chat.postMessage",
    headers: [
      { key: "Authorization", value: "Bearer {{SLACK_BOT_TOKEN}}" },
      { key: "Content-Type", value: "application/json" },
    ],
    bodyType: "json",
    bodyValue: JSON.stringify(
      {
        channel: "#alerts",
        text: "Test message sent via InTab API Tester",
      },
      null,
      2
    ),
    authType: "bearer",
    authConfig: { bearerToken: "{{SLACK_BOT_TOKEN}}" },
    envVariables: [
      { key: "SLACK_BOT_TOKEN", defaultValue: "", description: "Slack Bot OAuth Token (xoxb-...)" },
    ],
    tags: ["slack", "bot", "chat", "postMessage"],
    requiredScopes: ["chat:write"],
    sampleResponse: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(
        {
          ok: true,
          channel: "C012AB3CD",
          ts: "1718294400.000100",
          message: { text: "Test message sent via InTab API Tester", type: "message", bot_id: "B012AB3CD" },
        },
        null,
        2
      ),
    },
  },
  {
    id: "jira-search-jql",
    name: "Jira Cloud: Search Issues (JQL)",
    platform: "developer",
    platformName: "Developer & SaaS Tools",
    category: "Atlassian Jira",
    method: "POST",
    url: "https://{{jira_domain}}.atlassian.net/rest/api/3/search",
    description: "Query Jira issues matching a JQL expression with custom field projections.",
    docsUrl: "https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/#api-rest-api-3-search-post",
    headers: [
      { key: "Accept", value: "application/json" },
      { key: "Content-Type", value: "application/json" },
    ],
    bodyType: "json",
    bodyValue: JSON.stringify(
      {
        jql: "project = PROJ AND status = 'In Progress' ORDER BY created DESC",
        maxResults: 10,
        fields: ["summary", "status", "assignee", "priority"],
      },
      null,
      2
    ),
    authType: "basic",
    authConfig: {
      basicUsername: "{{jira_email}}",
      basicPassword: "{{jira_api_token}}",
    },
    envVariables: [
      { key: "jira_domain", defaultValue: "mycompany", description: "Atlassian subdomain (e.g., mycompany)" },
      { key: "jira_email", defaultValue: "", description: "Atlassian account email address" },
      { key: "jira_api_token", defaultValue: "", description: "Atlassian API token created in Security settings" },
    ],
    tags: ["jira", "atlassian", "jql", "agile", "issues"],
    requiredScopes: ["read:jira-work"],
    sampleResponse: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json;charset=UTF-8" },
      body: JSON.stringify(
        {
          startAt: 0,
          maxResults: 10,
          total: 1,
          issues: [
            {
              id: "10042",
              key: "PROJ-104",
              fields: {
                summary: "Integrate OAuth 2.0 PKCE authentication flow",
                status: { name: "In Progress" },
                priority: { name: "High" },
                assignee: { displayName: "Alex Rivera" },
              },
            },
          ],
        },
        null,
        2
      ),
    },
  },
  {
    id: "jira-create-issue",
    name: "Jira Cloud: Create Issue",
    platform: "developer",
    platformName: "Developer & SaaS Tools",
    category: "Atlassian Jira",
    method: "POST",
    url: "https://{{jira_domain}}.atlassian.net/rest/api/3/issue",
    description: "Create an issue or sub-task in a Jira Cloud project.",
    docsUrl: "https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-post",
    headers: [
      { key: "Accept", value: "application/json" },
      { key: "Content-Type", value: "application/json" },
    ],
    bodyType: "json",
    bodyValue: JSON.stringify(
      {
        fields: {
          project: { key: "PROJ" },
          summary: "Feature: Support ServiceNow REST presets in InTab",
          description: {
            type: "doc",
            version: 1,
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Task created from InTab API Tester." }],
              },
            ],
          },
          issuetype: { name: "Task" },
        },
      },
      null,
      2
    ),
    authType: "basic",
    authConfig: {
      basicUsername: "{{jira_email}}",
      basicPassword: "{{jira_api_token}}",
    },
    envVariables: [
      { key: "jira_domain", defaultValue: "mycompany", description: "Atlassian subdomain" },
      { key: "jira_email", defaultValue: "", description: "Atlassian account email" },
      { key: "jira_api_token", defaultValue: "", description: "Atlassian API token" },
    ],
    tags: ["jira", "atlassian", "create-issue", "agile"],
    requiredScopes: ["write:jira-work"],
    sampleResponse: {
      status: 201,
      statusText: "Created",
      headers: { "content-type": "application/json;charset=UTF-8" },
      body: JSON.stringify(
        {
          id: "10043",
          key: "PROJ-105",
          self: "https://mycompany.atlassian.net/rest/api/3/issue/10043",
        },
        null,
        2
      ),
    },
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
    bodyValue: "name=Jane+Doe&email=jane.doe%40example.com&description=Customer+created+from+InTab",
    authType: "bearer",
    authConfig: { bearerToken: "{{STRIPE_SECRET_KEY}}" },
    tags: ["stripe", "billing", "payments", "customers"],
    sampleResponse: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        {
          id: "cus_Q10948ab12",
          object: "customer",
          name: "Jane Doe",
          email: "jane.doe@example.com",
          currency: "usd",
          created: 1718294400,
        },
        null,
        2
      ),
    },
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
    sampleResponse: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(
        [
          { id: 1, title: "Initial Setup", created_at: "2026-09-18T10:00:00Z" },
          { id: 2, title: "API Integration", created_at: "2026-09-18T11:30:00Z" },
        ],
        null,
        2
      ),
    },
  },

  // ─────────────────────────────────────────────────────────────
  // 7. MOCK & TESTING UTILITIES
  // ─────────────────────────────────────────────────────────────
  {
    id: "mock-httpbin-status",
    name: "HTTPBin: Dynamic Status Code Tester",
    platform: "mock",
    platformName: "Mock & Test Utilities",
    category: "Diagnostics",
    method: "GET",
    url: "https://httpbin.org/status/{{status_code}}",
    description: "Test client-side handling of specific HTTP status codes (e.g. 200, 400, 401, 403, 404, 500).",
    docsUrl: "https://httpbin.org/",
    envVariables: [
      { key: "status_code", defaultValue: "200", description: "Target HTTP response code (200, 201, 400, 401, 500, etc.)" },
    ],
    tags: ["mock", "status", "httpbin", "diagnostics"],
    sampleResponse: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/html; charset=utf-8" },
      body: "",
    },
  },
  {
    id: "mock-httpbin-delay",
    name: "HTTPBin: Latency Simulation (Delay)",
    platform: "mock",
    platformName: "Mock & Test Utilities",
    category: "Diagnostics",
    method: "GET",
    url: "https://httpbin.org/delay/{{delay_seconds}}",
    description: "Simulate server network latency and evaluate UI loading spinners or client timeout thresholds.",
    docsUrl: "https://httpbin.org/",
    envVariables: [
      { key: "delay_seconds", defaultValue: "2", description: "Simulated delay in seconds (1 to 10)" },
    ],
    tags: ["mock", "latency", "timeout", "httpbin", "delay"],
    sampleResponse: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        {
          args: {},
          data: "",
          origin: "203.0.113.195",
          url: "https://httpbin.org/delay/2",
        },
        null,
        2
      ),
    },
  },
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
      { key: "X-Client-Name", value: "InTab-API-Tester" },
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
    sampleResponse: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(
        {
          args: { environment: "production", version: "2.0" },
          data: { test: true, message: "Hello Postman Echo!" },
          headers: { "x-client-name": "InTab-API-Tester", "content-type": "application/json" },
          json: { test: true, message: "Hello Postman Echo!" },
          url: "https://postman-echo.com/post?environment=production&version=2.0",
        },
        null,
        2
      ),
    },
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
    sampleResponse: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(
        [
          {
            userId: 1,
            id: 1,
            title: "sunt aut facere repellat provident occaecati excepturi optio reprehenderit",
            body: "quia et suscipit suscipit recusandae consequuntur expedita et cum reprehenderit molestiae ut ut quas totam nostrum rerum est autem sunt rem eveniet architecto",
          },
        ],
        null,
        2
      ),
    },
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
    sampleResponse: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(
        {
          token: "QpwL5tke4Pnpja7X4",
        },
        null,
        2
      ),
    },
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
    sampleResponse: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(
        {
          bitcoin: { usd: 68420 },
          ethereum: { usd: 3510 },
          solana: { usd: 178.5 },
        },
        null,
        2
      ),
    },
  },
];
