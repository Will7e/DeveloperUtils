const input = `{
  "id": "dev-utils-001",
  "name": "Developer Utilities",
  "version": 1.0.0,
  "status": stable,
  "active": true,
  "empty": null,
  "features": [
    {
      "name": "Formatter",
      "types": [
        "JSON",
        "XML"
      ]
    }
  ]
}`;

let repaired = input
  .replace(/\/\/.*$/gm, '') // Remove single-line comments
  .replace(/\/\*[\s\S]*?\*\//g, '') // Remove multi-line comments
  .replace(/,\s*([\]}])/g, '$1') // Remove trailing commas
  .replace(/:\s*(\d+\.\d+\.\d+[a-zA-Z0-9-]*)/g, ': "$1"') // Fix unquoted semver numbers
  .replace(/:\s*([a-zA-Z_$][a-zA-Z0-9_$]*)(?=\s*[,}])/g, (match, p1) => {
    // don't wrap true, false, null
    if (p1 === 'true' || p1 === 'false' || p1 === 'null') return match;
    return `: "${p1}"`;
  });

console.log(JSON.parse(repaired));
