import { TabState, applyAuth } from "@/stores/api-tester.store";

export const CODE_LANGUAGES = [
  { id: "curl", name: "cURL", language: "bash" },
  { id: "fetch", name: "JavaScript (Fetch)", language: "javascript" },
  { id: "axios", name: "JavaScript (Axios)", language: "javascript" },
  { id: "python", name: "Python (Requests)", language: "python" },
  { id: "go", name: "Go (net/http)", language: "go" },
];

export function generateCodeSnippet(tab: TabState, curlString: string, languageId: string): string {
  if (languageId === "curl") {
    return curlString;
  }

  const { method, url, headers, bodyType, bodyValue, formParams, rawType, authType, authConfig } = tab;

  // 1. Gather enabled headers
  let computedHeaders: Record<string, string> = {};
  headers.forEach((h) => {
    if (h.enabled && h.key.trim() !== "") {
      computedHeaders[h.key.trim()] = h.value.trim();
    }
  });

  // 2. Apply auth (mutates url & headers if api-key in query or auth headers needed)
  const authed = applyAuth(authType, authConfig, computedHeaders, url);
  computedHeaders = authed.headers;
  const finalUrl = authed.url;

  // 3. Setup Content-Type for Body
  if (method !== "GET" && method !== "HEAD") {
    const hasContentType = Object.keys(computedHeaders).some((k) => k.toLowerCase() === "content-type");
    if (bodyType === "json" && !hasContentType) {
      computedHeaders["Content-Type"] = "application/json";
    } else if (bodyType === "raw" && !hasContentType) {
      computedHeaders["Content-Type"] = rawType;
    }
  }

  // 4. Generate Body string based on type
  let bodyStr = "";
  if (method !== "GET" && method !== "HEAD") {
    if (bodyType === "json" || bodyType === "raw") {
      bodyStr = bodyValue;
    } else if (bodyType === "form-data") {
      // Simplistic representation of FormData
      const formDataParts = formParams
        .filter((f) => f.enabled && f.key.trim())
        .map((f) => `${encodeURIComponent(f.key.trim())}=${encodeURIComponent(f.value)}`)
        .join("&");
      bodyStr = formDataParts;
      if (bodyStr) {
        // usually form-data should be URL encoded if we represent it as a string here
        // or actually multipart/form-data. We will mock it as x-www-form-urlencoded for snippets 
        // to keep it simple, or explicitly build FormData in JS.
      }
    }
  }

  // Generate per language
  switch (languageId) {
    case "fetch":
      return generateFetch(method, finalUrl, computedHeaders, bodyType, bodyStr, formParams);
    case "axios":
      return generateAxios(method, finalUrl, computedHeaders, bodyType, bodyStr, formParams);
    case "python":
      return generatePython(method, finalUrl, computedHeaders, bodyType, bodyStr, formParams);
    case "go":
      return generateGo(method, finalUrl, computedHeaders, bodyType, bodyStr, formParams);
    default:
      return "";
  }
}

function generateFetch(method: string, url: string, headers: Record<string, string>, bodyType: string, bodyStr: string, formParams: any[]): string {
  let snippet = `const url = "${url}";\n`;
  snippet += `const options = {\n`;
  snippet += `  method: "${method}",\n`;

  if (Object.keys(headers).length > 0) {
    snippet += `  headers: {\n`;
    for (const [key, value] of Object.entries(headers)) {
      snippet += `    "${key}": "${value}",\n`;
    }
    snippet += `  },\n`;
  }

  if (method !== "GET" && method !== "HEAD") {
    if (bodyType === "json" || bodyType === "raw") {
      if (bodyStr.trim()) {
        if (bodyType === "json") {
            try {
                // Ensure valid json
                const parsed = JSON.parse(bodyStr);
                snippet += `  body: JSON.stringify(${JSON.stringify(parsed, null, 2).replace(/\n/g, '\n  ')}),\n`;
            } catch {
                snippet += `  body: ${JSON.stringify(bodyStr)},\n`;
            }
        } else {
            snippet += `  body: ${JSON.stringify(bodyStr)},\n`;
        }
      }
    } else if (bodyType === "form-data") {
      snippet += `  body: new URLSearchParams({\n`;
      formParams.filter(f => f.enabled && f.key.trim()).forEach(f => {
        snippet += `    "${f.key.trim()}": "${f.value}",\n`;
      });
      snippet += `  }),\n`;
    }
  }
  
  snippet += `};\n\n`;
  snippet += `fetch(url, options)\n`;
  snippet += `  .then(response => response.json())\n`;
  snippet += `  .then(data => console.log(data))\n`;
  snippet += `  .catch(error => console.error(error));`;

  return snippet;
}

function generateAxios(method: string, url: string, headers: Record<string, string>, bodyType: string, bodyStr: string, formParams: any[]): string {
  let snippet = `import axios from "axios";\n\n`;
  snippet += `const options = {\n`;
  snippet += `  method: "${method}",\n`;
  snippet += `  url: "${url}",\n`;

  if (Object.keys(headers).length > 0) {
    snippet += `  headers: {\n`;
    for (const [key, value] of Object.entries(headers)) {
      snippet += `    "${key}": "${value}",\n`;
    }
    snippet += `  },\n`;
  }

  if (method !== "GET" && method !== "HEAD") {
    if (bodyType === "json") {
      try {
        const parsed = JSON.parse(bodyStr);
        snippet += `  data: ${JSON.stringify(parsed, null, 2).replace(/\n/g, '\n  ')},\n`;
      } catch {
        snippet += `  data: ${JSON.stringify(bodyStr)},\n`;
      }
    } else if (bodyType === "raw") {
        snippet += `  data: ${JSON.stringify(bodyStr)},\n`;
    } else if (bodyType === "form-data") {
      snippet += `  data: {\n`;
      formParams.filter(f => f.enabled && f.key.trim()).forEach(f => {
        snippet += `    "${f.key.trim()}": "${f.value}",\n`;
      });
      snippet += `  },\n`;
    }
  }
  
  snippet += `};\n\n`;
  snippet += `axios.request(options)\n`;
  snippet += `  .then(response => console.log(response.data))\n`;
  snippet += `  .catch(error => console.error(error));`;

  return snippet;
}

function generatePython(method: string, url: string, headers: Record<string, string>, bodyType: string, bodyStr: string, formParams: any[]): string {
  let snippet = `import requests\n`;
  if (bodyType === "json" && method !== "GET" && method !== "HEAD") {
    snippet += `import json\n`;
  }
  snippet += `\n`;
  snippet += `url = "${url}"\n`;

  if (Object.keys(headers).length > 0) {
    snippet += `headers = {\n`;
    for (const [key, value] of Object.entries(headers)) {
      snippet += `    "${key}": "${value}",\n`;
    }
    snippet += `}\n`;
  } else {
    snippet += `headers = {}\n`;
  }

  if (method !== "GET" && method !== "HEAD") {
    if (bodyType === "json") {
      try {
        const parsed = JSON.parse(bodyStr);
        snippet += `payload = ${JSON.stringify(parsed, null, 4).replace(/\n/g, '\n')}\n\n`;
        snippet += `response = requests.${method.toLowerCase()}(url, headers=headers, json=payload)\n`;
      } catch {
        snippet += `payload = ${JSON.stringify(bodyStr)}\n\n`;
        snippet += `response = requests.${method.toLowerCase()}(url, headers=headers, data=payload)\n`;
      }
    } else if (bodyType === "raw") {
      snippet += `payload = ${JSON.stringify(bodyStr)}\n\n`;
      snippet += `response = requests.${method.toLowerCase()}(url, headers=headers, data=payload)\n`;
    } else if (bodyType === "form-data") {
      snippet += `payload = {\n`;
      formParams.filter(f => f.enabled && f.key.trim()).forEach(f => {
        snippet += `    "${f.key.trim()}": "${f.value}",\n`;
      });
      snippet += `}\n\n`;
      snippet += `response = requests.${method.toLowerCase()}(url, headers=headers, data=payload)\n`;
    } else {
        snippet += `response = requests.${method.toLowerCase()}(url, headers=headers)\n`;
    }
  } else {
    snippet += `\nresponse = requests.${method.toLowerCase()}(url, headers=headers)\n`;
  }

  snippet += `\nprint(response.text)`;
  return snippet;
}

function generateGo(method: string, url: string, headers: Record<string, string>, bodyType: string, bodyStr: string, formParams: any[]): string {
  let snippet = `package main\n\nimport (\n\t"fmt"\n\t"net/http"\n\t"io"\n`;
  if (method !== "GET" && method !== "HEAD" && bodyStr.trim()) {
      snippet += `\t"strings"\n`;
  }
  snippet += `)\n\nfunc main() {\n`;
  snippet += `\turl := "${url}"\n`;

  let bodyVar = "nil";
  if (method !== "GET" && method !== "HEAD") {
    if (bodyType === "json" || bodyType === "raw") {
      if (bodyStr.trim()) {
        snippet += `\tpayload := strings.NewReader(${JSON.stringify(bodyStr)})\n`;
        bodyVar = "payload";
      }
    } else if (bodyType === "form-data") {
      const parts = formParams.filter(f => f.enabled && f.key.trim()).map(f => `${encodeURIComponent(f.key)}=${encodeURIComponent(f.value)}`).join("&");
      snippet += `\tpayload := strings.NewReader("${parts}")\n`;
      bodyVar = "payload";
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
  }

  snippet += `\n\treq, err := http.NewRequest("${method}", url, ${bodyVar})\n`;
  snippet += `\tif err != nil {\n\t\tfmt.Println(err)\n\t\treturn\n\t}\n`;

  for (const [key, value] of Object.entries(headers)) {
    snippet += `\treq.Header.Add("${key}", "${value}")\n`;
  }

  snippet += `\n\tres, err := http.DefaultClient.Do(req)\n`;
  snippet += `\tif err != nil {\n\t\tfmt.Println(err)\n\t\treturn\n\t}\n`;
  snippet += `\tdefer res.Body.Close()\n\n`;
  snippet += `\tbody, err := io.ReadAll(res.Body)\n`;
  snippet += `\tif err != nil {\n\t\tfmt.Println(err)\n\t\treturn\n\t}\n`;
  snippet += `\tfmt.Println(string(body))\n}`;

  return snippet;
}
