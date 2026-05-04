import { Zap, Code2, Terminal, Cpu } from "lucide-react";

export function DashboardPage() {
  return (
    <div className="flex-1 p-8 bg-background flex flex-col items-center justify-center text-center space-y-8 animate-in fade-in duration-700">
      <div className="space-y-2">
        <h1 className="text-4xl font-bold tracking-tight bg-gradient-to-r from-accent to-purple-400 bg-clip-text text-transparent">
          Welcome to DevUtils
        </h1>
        <p className="text-muted-foreground text-lg max-w-md mx-auto">
          Your premium cloud-based development workspace. Choose a tool to get started.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl w-full">
        <a href="/compiler" className="group p-6 bg-card border border-border hover:border-accent/50 rounded-xl transition-all hover:shadow-2xl hover:shadow-accent/10 text-left space-y-3">
          <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center text-accent group-hover:scale-110 transition-transform">
            <Code2 className="h-5 w-5" />
          </div>
          <h3 className="font-semibold text-lg">Cloud Compiler</h3>
          <p className="text-sm text-muted-foreground">Multi-language execution engine with live preview and deep Monaco integration.</p>
        </a>

        <div className="group p-6 bg-card border border-border opacity-50 cursor-not-allowed rounded-xl text-left space-y-3">
          <div className="w-10 h-10 rounded-lg bg-purple-500/10 flex items-center justify-center text-purple-400">
            <Terminal className="h-5 w-5" />
          </div>
          <h3 className="font-semibold text-lg">Terminal Shell</h3>
          <p className="text-sm text-muted-foreground">Direct access to a sandboxed environment for rapid CLI prototyping.</p>
        </div>

        <div className="group p-6 bg-card border border-border opacity-50 cursor-not-allowed rounded-xl text-left space-y-3">
          <div className="w-10 h-10 rounded-lg bg-green-500/10 flex items-center justify-center text-green-400">
            <Zap className="h-5 w-5" />
          </div>
          <h3 className="font-semibold text-lg">API Tester</h3>
          <p className="text-sm text-muted-foreground">A premium alternative to Postman for rapid API exploration and debugging.</p>
        </div>

        <div className="group p-6 bg-card border border-border opacity-50 cursor-not-allowed rounded-xl text-left space-y-3">
          <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center text-blue-400">
            <Cpu className="h-5 w-5" />
          </div>
          <h3 className="font-semibold text-lg">System Monitor</h3>
          <p className="text-sm text-muted-foreground">Real-time visualization of resource allocation and performance metrics.</p>
        </div>
      </div>
    </div>
  );
}
