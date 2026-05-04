import { User, Shield, Key, Bell } from "lucide-react";

export function AccountPage() {
  return (
    <div className="flex-1 p-12 bg-background animate-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-4xl mx-auto space-y-8">
        <div>
          <h1 className="text-3xl font-bold">Account Settings</h1>
          <p className="text-muted-foreground">Manage your profile and workspace preferences.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="md:col-span-1 space-y-1">
            <div className="p-4 bg-accent/5 border-l-2 border-accent text-accent font-medium rounded-r-md">Profile</div>
            <div className="p-4 hover:bg-muted/50 transition-colors rounded-md text-muted-foreground">Security</div>
            <div className="p-4 hover:bg-muted/50 transition-colors rounded-md text-muted-foreground">Notifications</div>
            <div className="p-4 hover:bg-muted/50 transition-colors rounded-md text-muted-foreground">Billing</div>
          </div>

          <div className="md:col-span-2 space-y-6">
            <div className="p-6 bg-card border border-border rounded-xl space-y-6">
              <div className="flex items-center gap-4">
                <div className="w-20 h-20 rounded-full bg-accent/20 flex items-center justify-center border-2 border-accent/20">
                  <User className="w-10 h-10 text-accent" />
                </div>
                <div>
                  <h3 className="text-xl font-semibold">William Le</h3>
                  <p className="text-sm text-muted-foreground">Professional Developer Plan</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Email Address</label>
                  <div className="p-2.5 bg-muted/30 border border-border rounded-md text-sm">william@example.com</div>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Full Name</label>
                  <div className="p-2.5 bg-muted/30 border border-border rounded-md text-sm">William Le</div>
                </div>
              </div>

              <button className="px-4 py-2 bg-accent hover:bg-accent-dim text-white rounded-md text-sm font-medium transition-colors">
                Update Profile
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
