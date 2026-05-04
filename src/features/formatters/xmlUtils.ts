/**
 * Simple XML formatter utility
 */
export function formatXml(xml: string, indent: string = "  "): string {
  let formatted = "";
  let pad = 0;
  
  // Split by tags
  const tokens = xml
    .replace(/>\s+</g, "><")
    .replace(/</g, "~#~<")
    .split("~#~");

  for (const token of tokens) {
    if (!token) continue;

    if (token.match(/^<\/\w/)) {
      // Closing tag
      pad--;
    }

    formatted += indent.repeat(Math.max(0, pad)) + token + "\n";

    if (token.match(/^<\w[^>]*[^\/]>$/) && !token.match(/^<\/\w/)) {
      // Opening tag (not self-closing)
      pad++;
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
