import { Component, type ReactNode, type ErrorInfo } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";

interface Props {
  children: ReactNode;
  fallbackMessage?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class EditorErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Editor error boundary caught error:", error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            padding: "24px",
            color: "var(--text-2)",
            gap: "12px",
            background: "var(--bg-1)",
          }}
        >
          <AlertCircle className="h-6 w-6 text-red" />
          <span style={{ fontSize: "13px", fontWeight: 500 }}>
            {this.props.fallbackMessage || "Failed to render editor content."}
          </span>
          <button
            type="button"
            className="api-send-btn"
            onClick={this.handleReset}
            style={{
              height: "30px",
              padding: "0 12px",
              fontSize: "12px",
              gap: "6px",
            }}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>Reload Editor</span>
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
