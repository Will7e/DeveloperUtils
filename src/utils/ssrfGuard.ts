// ============================================================
// SSRF Guard — Server-Side Request Forgery Prevention
// ============================================================
// Comprehensive URL & IP validation protecting against:
// - Cloud metadata services (AWS, GCP, Azure, Alibaba, OpenStack)
// - Localhost and loopback interfaces (IPv4, IPv6, hex, octal, int)
// - Private and link-local networks (RFC 1918, RFC 3927, RFC 6598)
// - Protocol smuggling and DNS rebinding vectors
// ============================================================

export interface SSRFValidationResult {
  allowed: boolean;
  reason?: string;
  normalizedUrl?: string;
}

export interface SSRFGuardOptions {
  /** Allow local loopback addresses (useful for strictly local development) */
  allowLocalhost?: boolean;
  /** Allow private IP subnets (10.0.0.0/8, 192.168.0.0/16, etc.) */
  allowPrivateSubnets?: boolean;
}

/** Known cloud metadata hostnames and IPs that must NEVER be accessed */
const CLOUD_METADATA_HOSTS = new Set([
  "169.254.169.254", // AWS, GCP, Azure, OpenStack IMDS
  "169.254.170.2",   // AWS ECS task metadata
  "metadata.google.internal", // GCP
  "metadata.internal",
  "metadata",
  "instance-data",   // AWS legacy
  "100.100.100.200", // Alibaba Cloud
  "fd00:ec2::254",   // AWS IPv6 IMDS
]);

/**
 * Checks if a numeric string is an integer representation of an IPv4 address
 * e.g., 2130706433 = 127.0.0.1
 */
function parseNumericIpv4(host: string): [number, number, number, number] | null {
  // Hex format (0x7f000001)
  if (/^0x[0-9a-f]+$/i.test(host)) {
    const num = parseInt(host, 16);
    if (!isNaN(num) && num >= 0 && num <= 0xffffffff) {
      return [
        (num >>> 24) & 255,
        (num >>> 16) & 255,
        (num >>> 8) & 255,
        num & 255,
      ];
    }
  }

  // Pure integer format (e.g. 2130706433)
  if (/^\d+$/.test(host)) {
    const num = parseInt(host, 10);
    if (!isNaN(num) && num >= 0 && num <= 0xffffffff) {
      return [
        (num >>> 24) & 255,
        (num >>> 16) & 255,
        (num >>> 8) & 255,
        num & 255,
      ];
    }
  }

  // Dotted decimal or octal format (e.g. 127.0.0.1 or 0177.0.0.1)
  const parts = host.split(".");
  if (parts.length === 4) {
    const octets: number[] = [];
    for (const part of parts) {
      let val: number;
      if (part.startsWith("0x") || part.startsWith("0X")) {
        val = parseInt(part, 16);
      } else if (part.length > 1 && part.startsWith("0")) {
        val = parseInt(part, 8); // octal
      } else {
        val = parseInt(part, 10);
      }
      if (isNaN(val) || val < 0 || val > 255) {
        return null;
      }
      octets.push(val);
    }
    return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
  }

  return null;
}

/**
 * Determines if an IPv4 octet quadruple belongs to private/restricted subnets
 */
function isRestrictedIpv4(octets: [number, number, number, number], options?: SSRFGuardOptions): boolean {
  const [a, b] = octets;

  // 1. Link-local / Cloud Metadata (169.254.0.0/16) — ALWAYS BLOCKED
  if (a === 169 && b === 254) {
    return true;
  }

  // 2. Current network (0.0.0.0/8) & Broadcast (255.255.255.255) — ALWAYS BLOCKED
  if (a === 0 || (a === 255 && octets[1] === 255 && octets[2] === 255 && octets[3] === 255)) {
    return true;
  }

  // 3. Loopback (127.0.0.0/8)
  if (a === 127) {
    return !options?.allowLocalhost;
  }

  // 4. Private subnets (RFC 1918 & Carrier-grade NAT RFC 6598)
  if (!options?.allowPrivateSubnets) {
    // 10.0.0.0/8
    if (a === 10) return true;
    // 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 100.64.0.0/10 (Shared address space)
    if (a === 100 && b >= 64 && b <= 127) return true;
    // 198.18.0.0/15 (Benchmarking)
    if (a === 198 && (b === 18 || b === 19)) return true;
  }

  return false;
}

/**
 * Normalizes IPv6 address and checks if it's restricted
 */
function isRestrictedIpv6(host: string, options?: SSRFGuardOptions): boolean {
  // Strip brackets if present
  const cleanHost = host.replace(/^\[|\]$/g, "").toLowerCase();

  // Cloud metadata IPv6
  if (cleanHost === "fd00:ec2::254") return true;

  // Loopback (::1)
  if (cleanHost === "::1" || cleanHost === "0:0:0:0:0:0:0:1") {
    return !options?.allowLocalhost;
  }

  // Unspecified (::)
  if (cleanHost === "::" || cleanHost === "0:0:0:0:0:0:0:0") {
    return true;
  }

  // IPv4-mapped IPv6 (::ffff:x.x.x.x or ::ffff:x:x)
  const mappedMatch = cleanHost.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mappedMatch && mappedMatch[1]) {
    const octets = parseNumericIpv4(mappedMatch[1]);
    if (octets && isRestrictedIpv4(octets, options)) return true;
  }

  // IPv6 Link-local (fe80::/10)
  if (cleanHost.startsWith("fe8") || cleanHost.startsWith("fe9") || cleanHost.startsWith("fea") || cleanHost.startsWith("feb")) {
    return true;
  }

  // IPv6 Unique Local (fc00::/7 -> fc00:: or fd00::)
  if (!options?.allowPrivateSubnets) {
    if (cleanHost.startsWith("fc") || cleanHost.startsWith("fd")) {
      return true;
    }
  }

  return false;
}

/**
 * Validates a target URL against SSRF vulnerabilities.
 * Call this before making any server-side or edge proxy request.
 */
export function validateUrlForSSRF(
  urlInput: string,
  options?: SSRFGuardOptions
): SSRFValidationResult {
  if (!urlInput || typeof urlInput !== "string") {
    return { allowed: false, reason: "Target URL must be a non-empty string" };
  }

  let parsed: URL;
  try {
    parsed = new URL(urlInput.trim());
  } catch {
    return { allowed: false, reason: `Malformed or invalid URL: '${urlInput}'` };
  }

  // 1. Strict Protocol Validation: Only allow http and https
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      allowed: false,
      reason: `Blocked protocol '${parsed.protocol}'. Only 'http:' and 'https:' are allowed.`,
    };
  }

  // 2. Reject credentials in URL authority (e.g. http://user:pass@example.com)
  if (parsed.username || parsed.password) {
    return {
      allowed: false,
      reason: "URLs with embedded authentication credentials in authority are forbidden",
    };
  }

  // Extract hostname (lowercase, stripped of brackets for IPv6)
  const rawHostname = parsed.hostname.toLowerCase();

  // 3. Reject empty hostname
  if (!rawHostname) {
    return { allowed: false, reason: "URL hostname cannot be empty" };
  }

  // 4. Check against known Cloud Metadata endpoints
  if (CLOUD_METADATA_HOSTS.has(rawHostname)) {
    return {
      allowed: false,
      reason: "Access to cloud instance metadata services is strictly prohibited",
    };
  }

  // Also check subdomains of metadata endpoints
  if (
    rawHostname.endsWith(".metadata.google.internal") ||
    rawHostname.endsWith(".instance-data")
  ) {
    return {
      allowed: false,
      reason: "Access to cloud metadata endpoints is strictly prohibited",
    };
  }

  // 5. Check localhost hostnames
  if (
    rawHostname === "localhost" ||
    rawHostname.endsWith(".localhost") ||
    rawHostname === "ip6-localhost" ||
    rawHostname === "ip6-loopback"
  ) {
    if (!options?.allowLocalhost) {
      return {
        allowed: false,
        reason: "Access to loopback/localhost addresses is prohibited in this environment",
      };
    }
  }

  // 5b. Detect embedded IPs in DNS rebinding / wildcard domains (e.g., 127.0.0.1.nip.io, 169.254.169.254.sslip.io)
  const embeddedIpMatch = rawHostname.match(/(?:^|\.)(\d{1,3}(?:[.-]\d{1,3}){3})(?:\.|$)/);
  if (embeddedIpMatch && embeddedIpMatch[1]) {
    const dottedIp = embeddedIpMatch[1].replace(/-/g, ".");
    const embeddedOctets = parseNumericIpv4(dottedIp);
    if (embeddedOctets && isRestrictedIpv4(embeddedOctets, options)) {
      return {
        allowed: false,
        reason: `Target hostname contains restricted IP address '${dottedIp}' via DNS wildcard/rebinding service`,
      };
    }
  }

  // 6. Check numeric / decimal / octal IPv4
  const ipv4Octets = parseNumericIpv4(rawHostname);
  if (ipv4Octets) {
    if (isRestrictedIpv4(ipv4Octets, options)) {
      return {
        allowed: false,
        reason: `Target IP address '${ipv4Octets.join(".")}' is in a restricted or private range`,
      };
    }
  }

  // 7. Check IPv6
  if (rawHostname.includes(":") || rawHostname.startsWith("[")) {
    if (isRestrictedIpv6(rawHostname, options)) {
      return {
        allowed: false,
        reason: `Target IPv6 address '${rawHostname}' is in a restricted or private range`,
      };
    }
  }

  return {
    allowed: true,
    normalizedUrl: parsed.toString(),
  };
}
