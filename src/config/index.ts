import type { Language, LanguageConfig } from "@/types";

/** Default editor settings */
export const DEFAULT_EDITOR_SETTINGS = {
  theme: "dark" as const,
  fontSize: 14,
  tabSize: 2,
  wordWrap: "on" as const,
  minimap: true,
  lineNumbers: "on" as const,
  fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
  cursorStyle: "line" as const,
  bracketPairColorization: true,
  formatOnPaste: true,
  formatOnType: false,
};

/** Language configurations */
export const LANGUAGE_CONFIGS: Record<Language, LanguageConfig> = {
  javascript: {
    id: "javascript",
    label: "JavaScript",
    icon: "JS",
    monacoLanguage: "javascript",
    extension: ".js",
    defaultCode: `// 🚀 JavaScript — CodeForge
// Write your code below and hit Run (Ctrl+Enter)

function fibonacci(n) {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

console.log("Fibonacci sequence (first 12):");
for (let i = 0; i < 12; i++) {
  console.log(\`  fib(\${i}) = \${fibonacci(i)}\`);
}

// Array operations
const numbers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const evens = numbers.filter(n => n % 2 === 0);
const sum = numbers.reduce((acc, n) => acc + n, 0);

console.log("\\nArray operations:");
console.log("  Numbers:", numbers.join(", "));
console.log("  Evens:", evens.join(", "));
console.log("  Sum:", sum);
`,
  },
  typescript: {
    id: "typescript",
    label: "TypeScript",
    icon: "TS",
    monacoLanguage: "typescript",
    extension: ".ts",
    defaultCode: `// 🚀 TypeScript — CodeForge
// Full type checking powered by the TypeScript compiler

interface User {
  name: string;
  age: number;
  email: string;
}

function greet(user: User): string {
  return \`Hello, \${user.name}! You are \${user.age} years old.\`;
}

const users: User[] = [
  { name: "Alice", age: 30, email: "alice@example.com" },
  { name: "Bob", age: 25, email: "bob@example.com" },
  { name: "Charlie", age: 35, email: "charlie@example.com" },
];

users.forEach(user => {
  console.log(greet(user));
});

// Generic function
function identity<T>(arg: T): T {
  return arg;
}

console.log("\\nGeneric identity:");
console.log("  String:", identity("Hello TypeScript"));
console.log("  Number:", identity(42));
console.log("  Array:", identity([1, 2, 3]));
`,
  },
  python: {
    id: "python",
    label: "Python",
    icon: "PY",
    monacoLanguage: "python",
    extension: ".py",
    defaultCode: `# 🚀 Python — CodeForge
# Powered by Pyodide (CPython compiled to WebAssembly)

def fibonacci(n):
    """Generate fibonacci sequence up to n terms"""
    a, b = 0, 1
    sequence = []
    for _ in range(n):
        sequence.append(a)
        a, b = b, a + b
    return sequence

print("Fibonacci sequence (first 12):")
for i, num in enumerate(fibonacci(12)):
    print(f"  fib({i}) = {num}")

# List comprehensions
numbers = list(range(1, 11))
squares = [n**2 for n in numbers]
evens = [n for n in numbers if n % 2 == 0]

print("\\nList operations:")
print(f"  Numbers: {numbers}")
print(f"  Squares: {squares}")
print(f"  Evens: {evens}")
print(f"  Sum: {sum(numbers)}")

# Dictionary comprehension
word = "CodeForge"
char_count = {c: word.count(c) for c in set(word.lower())}
print(f"\\nCharacter count in '{word}': {char_count}")
`,
  },
  html: {
    id: "html",
    label: "HTML",
    icon: "HTML",
    monacoLanguage: "html",
    extension: ".html",
    defaultCode: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CodeForge Preview</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', system-ui, sans-serif;
      background: linear-gradient(135deg, #0f0f23 0%, #1a1a3e 50%, #0f0f23 100%);
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: rgba(255,255,255,0.05);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 16px;
      padding: 2rem;
      text-align: center;
      max-width: 400px;
      animation: fadeIn 0.6s ease-out;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }
    h1 {
      font-size: 2rem;
      background: linear-gradient(135deg, #6366f1, #8b5cf6, #a78bfa);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 0.5rem;
    }
    p { color: #94a3b8; line-height: 1.6; }
    .badge {
      display: inline-block;
      margin-top: 1rem;
      padding: 0.5rem 1rem;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      border-radius: 9999px;
      font-size: 0.875rem;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>⚡ CodeForge</h1>
    <p>Edit this HTML and see the live preview update in real-time. Style it, script it, make it yours.</p>
    <span class="badge">Live Preview</span>
  </div>
</body>
</html>`,
  },
};

/** Application metadata */
export const APP_CONFIG = {
  name: "CodeForge",
  version: "1.0.0",
  description: "Browser-based code compiler & editor",
  repository: "https://github.com/codeforge",
};
