/**
 * Simple XML formatter utility
 */
export function formatXml(xml: string, indent: string = "  "): string {
  let formatted = "";
  let pad = 0;
  
  // Clean up whitespace between tags
  const cleanXml = xml.replace(/>\s+</g, "><").trim();
  
  // Use regex to find tags vs text
  // This matches <tag...>, </tag>, or text content
  const tokens = cleanXml.split(/(<[^>]+>)/g).filter(t => t.trim() !== "");

  for (let token of tokens) {
    token = token.trim();
    if (!token) continue;

    if (token.startsWith("</")) {
      // Closing tag
      pad--;
      formatted += indent.repeat(Math.max(0, pad)) + token + "\n";
    } else if (token.startsWith("<") && !token.endsWith("/>") && !token.startsWith("<?") && !token.startsWith("<!")) {
      // Opening tag (not self-closing, not PI, not comment/doctype)
      formatted += indent.repeat(Math.max(0, pad)) + token + "\n";
      pad++;
    } else {
      // Text content, self-closing tag, or comment
      formatted += indent.repeat(Math.max(0, pad)) + token + "\n";
    }
  }

  return formatted.trim();
}

/**
 * Minify XML
 */
export function minifyXml(xml: string): string {
  return xml.replace(/>\s+</g, "><").trim();
}

/**
 * Simple XML to Object converter for Tree View (Very basic)
 */
export function xmlToTreeData(xml: string): any {
  try {
    if (!xml || !xml.trim()) return null;

    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, "application/xml");
    
    // Check for parse errors
    const errorNode = doc.querySelector("parsererror");
    if (errorNode) {
      throw new Error("Invalid XML: " + (errorNode.textContent || "Parse Error"));
    }

    if (!doc.documentElement) return null;

    const nodeToJson = (node: Node): any => {
      if (node.nodeType === 3) { // Node.TEXT_NODE
        const text = node.textContent?.trim();
        return text || null;
      }

      if (node.nodeType === 1) { // Node.ELEMENT_NODE
        const element = node as Element;
        const obj: any = {
          _tag: element.tagName,
        };

        // Attributes
        if (element.attributes && element.attributes.length > 0) {
          obj._attributes = {};
          for (let i = 0; i < element.attributes.length; i++) {
            const attr = element.attributes.item(i);
            if (attr) {
              obj._attributes[attr.name] = attr.value;
            }
          }
        }

        // Children
        const children = Array.from(element.childNodes)
          .map(nodeToJson)
          .filter(child => child !== null);

        if (children.length > 0) {
          if (children.length === 1 && typeof children[0] === "string") {
            obj._value = children[0];
          } else {
            obj._children = children;
          }
        }

        return obj;
      }
      return null;
    };

    return nodeToJson(doc.documentElement);
  } catch (e) {
    throw e;
  }
}
