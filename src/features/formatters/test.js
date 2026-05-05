const input = `{
  "id": "dev-utils-001",
  "name": "Developer Utilities",
  "version": 1.0.0,
  "features": [
    {
      "name": "Formatter",
      "types": [
        "JSON",
        "XML"
      ]
    },
    {
      "name": "Compiler",
      "status": "stable"
    }
  ],
  "config": {
    "theme": "obsidian",
    "active": true
  }
}`;

let repaired = input
  .replace(/\/\/.*$/gm, '') // Remove single-line comments
  .replace(/\/\*[\s\S]*?\*\//g, '') // Remove multi-line comments
  .replace(/,\s*([\]}])/g, '$1') // Remove trailing commas
  .replace(/:\s*(\d+\.\d+\.\d+[a-zA-Z0-9-]*)/g, ': "$1"'); // Fix semver like 1.0.0

console.log(JSON.parse(repaired));
