import React from "react";
import { JsonFormatter } from "@/features/json-formatter/JsonFormatter";

export function JsonFormatterPage() {
  return (
    <div className="page-container bg-bg-0">
      <JsonFormatter />
    </div>
  );
}

// Default export if needed, but the project seems to use named exports
export default JsonFormatterPage;
